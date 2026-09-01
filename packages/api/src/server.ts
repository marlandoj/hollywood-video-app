import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { parseFountain } from "../../parser/src/index";
import { planShots } from "../../planner/src/index";
import { CapacityController, DurableJobStore, TIERS, type Job, type JobStage, type Tier } from "../../queue/src/index";
import { CostLedger } from "../../operator/src/index";
import { ProjectService, type Project, type ReviewDecision } from "./index";
import { ARTIFACT_TOKEN_TTL_MS, mintArtifactToken, tokenSecret, verifyOperatorGrant, verifyToken } from "./tokens";

export interface ApiServerOptions {
  port?: number;
  hostname?: string;
  queuePath?: string;
  artifactRoot?: string;
  frontendOrigin?: string;
  statePath?: string;
  costLedgerPath?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > 250_000) throw new Error("request body too large");
  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON object required");
  return body as Record<string, unknown>;
}

/**
 * Artifact access uses signed URLs (FR-053: no cookies). The short-lived,
 * project-bound artifact token is a path segment, so the relative media
 * segment URIs inside an HLS playlist resolve under the same signed prefix and
 * inherit the authorization without a cookie or a query string.
 */
export function signedArtifactUrls(job: Job, artifactToken: string): Record<string, string> | undefined {
  if (!job.output) return undefined;
  const prefix = `/artifacts/${artifactToken}`;
  return {
    mp4Url: `${prefix}/${job.output.mp4Path}`,
    hlsUrl: `${prefix}/${job.output.hlsPlaylistPath}`,
    captionsUrl: `${prefix}/${job.output.captionsPath}`,
    manifestUrl: `${prefix}/${job.output.manifestPath}`,
  };
}

function publicJob(job: Job, artifactToken: string): Record<string, unknown> {
  const { scriptText: _scriptText, ...rest } = job;
  return { ...rest, output: signedArtifactUrls(job, artifactToken), artifactUrlsExpireInSeconds: Math.floor(ARTIFACT_TOKEN_TTL_MS / 1000) };
}

function projectUrl(frontendOrigin: string, token: string): string {
  return `${frontendOrigin}/#/p/${token}`;
}

function reviewUrl(frontendOrigin: string, token: string): string {
  return `${frontendOrigin}/#/review/${encodeURIComponent(token)}`;
}

export function createApiServer(options: ApiServerOptions = {}): Bun.Server<unknown> {
  tokenSecret();
  const queuePath = options.queuePath ?? process.env.HV_QUEUE_PATH ?? "/data/queue/jobs.json";
  const artifactRoot = resolve(options.artifactRoot ?? process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts");
  const frontendOrigin = options.frontendOrigin ?? process.env.HV_FRONTEND_ORIGIN ?? "http://localhost:8081";
  const statePath = options.statePath ?? process.env.HV_PROJECT_STATE_PATH ?? "/data/state/projects.json";
  const costLedgerPath = options.costLedgerPath ?? process.env.HV_COST_LEDGER_PATH ?? "/data/state/cost-ledger.json";

  const projects = new ProjectService(statePath);
  const jobs = new DurableJobStore(queuePath);
  const ledger = new CostLedger(costLedgerPath);
  const capacity = new CapacityController(Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000));

  const corsHeaders: Record<string, string> = {
    "access-control-allow-origin": frontendOrigin,
    vary: "Origin",
  };
  const response = (payload: unknown, status = 200, extra: HeadersInit = {}) => Response.json(payload, {
    status,
    headers: { ...corsHeaders, ...extra },
  });

  const authorizedProject = (request: Request, projectId: string): { token: string; project: Project } | null => {
    const token = bearer(request);
    const project = token ? projects.authorize(token) : null;
    if (!token || !project || project.id !== projectId) return null;
    return { token, project };
  };

  return Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 8080),
    hostname: options.hostname ?? "0.0.0.0",
    async fetch(request) {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders,
            "access-control-allow-headers": "authorization, content-type",
            "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
          },
        });
      }

      try {
        if (request.method === "GET" && url.pathname === "/health") {
          const all = jobs.all();
          return response({
            status: "healthy",
            service: "hollywood-video-private-staging",
            queueDepth: all.filter((job) => job.status === "queued").length,
            runningJobs: all.filter((job) => job.status === "running").length,
            monthSpendUsd: Number(ledger.monthSpend().toFixed(4)),
          });
        }

        if (request.method === "POST" && url.pathname === "/api/projects") {
          const created = projects.createAnonymousProject();
          return response({ ...created, projectUrl: projectUrl(frontendOrigin, created.token) }, 201);
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts.length === 3 && request.method === "GET") {
          const authorized = authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const { token, project } = authorized;
          const latest = project.versions.latest();
          const artifactToken = mintArtifactToken(project.id);
          return response({
            projectId: project.id,
            createdAt: project.createdAt,
            expiresAt: new Date(verifyToken(token)!.exp).toISOString(),
            deleteAfter: project.deleteAfter,
            rightsAttestedAt: project.rightsAttestedAt,
            scriptVersion: latest?.version ?? 0,
            script: latest?.text ?? "",
            animaticApprovals: project.animaticApprovals,
            jobs: jobs.all()
              .filter((job) => job.projectId === project.id)
              .map((job) => publicJob(job, artifactToken)),
          });
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "script" && request.method === "PUT") {
          const authorized = authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          const text = typeof body.text === "string" ? body.text : "";
          if (!text.trim() || text.length > 200_000) return response({ error: "script must contain 1-200000 characters" }, 400);
          const parsed = parseFountain(text);
          if (parsed.rejected || parsed.scenes.length === 0) {
            return response({ error: parsed.rejectionReason ?? "screenplay contains no parseable scenes", warnings: parsed.warnings }, 422);
          }
          return response({ ...projects.editScript(authorized.token, text), scenes: parsed.scenes.length, warnings: parsed.warnings });
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "rights" && request.method === "POST") {
          const authorized = authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          if (body.attested !== true) {
            return response({ error: "rights attestation must be explicitly accepted" }, 400);
          }
          const attested = projects.attestRights(authorized.token);
          return response({ rightsAttestedAt: attested!.rightsAttestedAt });
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "jobs" && request.method === "POST") {
          const authorized = authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const { token, project } = authorized;
          const body = await jsonBody(request);

          if (!project.rightsAttestedAt) {
            return response({ error: "complete the rights attestation before starting generation" }, 403);
          }

          const scriptText = projects.latestScript(token);
          if (!scriptText) return response({ error: "save a screenplay before starting generation" }, 409);
          const scriptVersion = project.versions.latest()?.version ?? 0;

          const stage: JobStage = body.stage === "final" ? "final" : "animatic";
          let animaticApprovedAt: string | null = null;
          let animaticJobId: string | null = null;
          if (stage === "final") {
            animaticJobId = typeof body.animaticJobId === "string" ? body.animaticJobId : null;
            const animatic = animaticJobId ? jobs.get(animaticJobId) : undefined;
            if (!animatic || animatic.projectId !== project.id || animatic.stage !== "animatic") {
              return response({ error: "unknown animatic job for this project" }, 404);
            }
            const approval = projects.animaticApproval(project.id, animatic.id);
            if (!approval || approval.decision !== "approved") {
              return response({ error: "the animatic must be approved before final generation" }, 403);
            }
            if (animatic.scriptVersion !== scriptVersion || approval.scriptVersion !== animatic.scriptVersion) {
              return response({ error: "the screenplay changed after the animatic rendered; render and approve a new animatic first" }, 409);
            }
            animaticApprovedAt = approval.at;
          }

          const grant = typeof body.operatorGrant === "string" ? verifyOperatorGrant(body.operatorGrant, project.id) : null;
          const tier: Tier = grant ? "elevated" : "free";

          const shots = planShots(parseFountain(scriptText), 7000);
          const decision = capacity.decide({
            tier,
            runningForProject: jobs.all().filter((job) => job.projectId === project.id && job.status === "running").length,
            requestedShots: shots.length,
            monthSpendUsd: ledger.monthSpend(),
          });
          if (decision.action === "reject") return response({ error: decision.message }, 429);
          const id = crypto.randomUUID();
          const job = jobs.enqueue({
            id,
            idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${project.id}:${stage}:${scriptVersion}`,
            projectId: project.id,
            tier,
            stage,
            scriptVersion,
            totalFrames: shots.reduce((total, shot) => total + Math.round(shot.durationSec * 30), 0),
            retryPolicy: { maxRetries: 2, backoffMs: 1000 },
            timeoutMs: 30 * 60 * 1000,
            costCapUsd: Number(process.env.HV_COST_CAP_PER_SHOT_USD ?? 5) * Math.max(shots.length, 1),
            scriptText,
            rightsAttestedAt: project.rightsAttestedAt,
            animaticJobId,
            animaticApprovedAt,
          });
          return response({ jobId: job.id, stage: job.stage, scriptVersion: job.scriptVersion, status: job.status, queueAction: decision.action, tierLimits: TIERS[tier] }, 202);
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "animatic" && parts[4] === "decision" && request.method === "POST") {
          const authorized = authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const { project } = authorized;
          const body = await jsonBody(request);
          const decision: ReviewDecision | null = body.decision === "approved" || body.decision === "changes_requested" ? body.decision : null;
          const animaticJobId = typeof body.animaticJobId === "string" ? body.animaticJobId : "";
          if (!decision) return response({ error: "decision must be approved or changes_requested" }, 400);
          const animatic = jobs.get(animaticJobId);
          if (!animatic || animatic.projectId !== project.id || animatic.stage !== "animatic") {
            return response({ error: "unknown animatic job for this project" }, 404);
          }
          if (animatic.status !== "done") return response({ error: "the animatic is not ready for review yet" }, 409);
          const latestVersion = project.versions.latest()?.version ?? 0;
          if (animatic.scriptVersion !== latestVersion) {
            return response({
              error: "the screenplay changed after this animatic rendered; render a new animatic before deciding",
              animaticScriptVersion: animatic.scriptVersion,
              currentScriptVersion: latestVersion,
            }, 409);
          }
          const approval = projects.recordAnimaticDecision(
            project.id,
            animatic.id,
            animatic.scriptVersion,
            decision,
            typeof body.note === "string" ? body.note : "",
          );
          return response({ ...approval }, 201);
        }

        if (parts[0] === "api" && parts[1] === "jobs" && parts[2] && request.method === "GET") {
          const token = bearer(request);
          const job = jobs.get(parts[2]);
          const project = token ? projects.authorize(token) : null;
          if (!job || !project || project.id !== job.projectId) return response({ error: "not found" }, 404);
          return response(publicJob(job, mintArtifactToken(project.id)));
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "reviews" && request.method === "POST") {
          const authorized = authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          const permission = body.permission === "read" ? "read" : "approve";
          const link = projects.createReviewLink(authorized.token, permission);
          return response({ ...link, reviewUrl: reviewUrl(frontendOrigin, link!.token) }, 201);
        }

        if (parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts.length === 3 && request.method === "GET") {
          const reviewToken = decodeURIComponent(parts[2]);
          const use = projects.useReviewLink(reviewToken);
          if (!use) return response({ error: "review link is invalid, expired, revoked, or fully used" }, 403);
          const latest = jobs.all()
            .filter((job) => job.projectId === use.projectId && job.status === "done" && job.output)
            .sort((a, b) => a.id.localeCompare(b.id))
            .pop();
          if (!latest) return response({ error: "this project has no finished cut to review yet" }, 404);
          return response({
            projectId: use.projectId,
            permission: use.permission,
            viewsRemaining: use.viewsRemaining,
            jobId: latest.id,
            stage: latest.stage,
            output: signedArtifactUrls(latest, mintArtifactToken(use.projectId)),
            artifactUrlsExpireInSeconds: Math.floor(ARTIFACT_TOKEN_TTL_MS / 1000),
          });
        }

        if (parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts[3] === "decision" && request.method === "POST") {
          const body = await jsonBody(request);
          const decision: ReviewDecision | null = body.decision === "approved" || body.decision === "changes_requested" ? body.decision : null;
          if (!decision) return response({ error: "decision must be approved or changes_requested" }, 400);
          const reviewToken = decodeURIComponent(parts[2]);
          const accepted = projects.submitReviewDecision(reviewToken, decision, typeof body.note === "string" ? body.note : "");
          return accepted ? response({ accepted: true, decision }) : response({ error: "review link is invalid, expired, revoked, or read-only" }, 403);
        }

        if (parts[0] === "artifacts" && request.method === "GET") {
          const [, artifactToken, projectId, ...rest] = parts;
          const payload = artifactToken ? verifyToken(artifactToken) : null;
          if (!payload || payload.kind !== "artifact" || !projectId || payload.projectId !== projectId || rest.length === 0) {
            return response({ error: "unauthorized" }, 401);
          }
          if (projects.isTakenDown(projectId)) return response({ error: "not found" }, 404);
          const requested = resolve(artifactRoot, projectId, ...rest);
          if (!requested.startsWith(`${artifactRoot}${sep}`) || !existsSync(requested)) return response({ error: "not found" }, 404);
          return new Response(Bun.file(requested), {
            headers: {
              ...corsHeaders,
              "content-type": CONTENT_TYPES[extname(requested)] ?? "application/octet-stream",
              "cache-control": "private, no-store",
              "referrer-policy": "no-referrer",
            },
          });
        }

        return response({ error: "not found" }, 404);
      } catch (error) {
        return response({ error: error instanceof Error ? error.message : "internal error" }, 400);
      }
    },
  });
}

if (import.meta.main) {
  const server = createApiServer();
  console.log(`Hollywood Video private staging API listening on http://${server.hostname}:${server.port}`);
}
