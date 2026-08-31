import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { parseFountain } from "../../parser/src/index";
import { planShots } from "../../planner/src/index";
import { CapacityController, DurableJobStore, TIERS, type Job, type JobStage, type Tier } from "../../queue/src/index";
import { CostLedger } from "../../operator/src/index";
import { ProjectService, type ReviewDecision } from "./index";
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

const ARTIFACT_COOKIE = "hv_artifact";

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

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function artifactCookie(token: string, secure: boolean): string {
  const attributes = [
    `${ARTIFACT_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/artifacts/",
    "HttpOnly",
    `Max-Age=${Math.floor(ARTIFACT_TOKEN_TTL_MS / 1000)}`,
    secure ? "SameSite=None" : "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > 250_000) throw new Error("request body too large");
  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON object required");
  return body as Record<string, unknown>;
}

function artifactUrls(job: Job): Record<string, string> | undefined {
  if (!job.output) return undefined;
  return {
    mp4Url: `/artifacts/${job.output.mp4Path}`,
    hlsUrl: `/artifacts/${job.output.hlsPlaylistPath}`,
    captionsUrl: `/artifacts/${job.output.captionsPath}`,
    manifestUrl: `/artifacts/${job.output.manifestPath}`,
  };
}

function publicJob(job: Job): Record<string, unknown> {
  const { scriptText: _scriptText, ...rest } = job;
  return { ...rest, output: artifactUrls(job) };
}

export function createApiServer(options: ApiServerOptions = {}): Bun.Server<unknown> {
  tokenSecret();
  const queuePath = options.queuePath ?? process.env.HV_QUEUE_PATH ?? "/data/queue/jobs.json";
  const artifactRoot = resolve(options.artifactRoot ?? process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts");
  const frontendOrigin = options.frontendOrigin ?? process.env.HV_FRONTEND_ORIGIN ?? "http://localhost:8081";
  const statePath = options.statePath ?? process.env.HV_PROJECT_STATE_PATH ?? "/data/state/projects.json";
  const costLedgerPath = options.costLedgerPath ?? process.env.HV_COST_LEDGER_PATH ?? "/data/state/cost-ledger.json";
  const secureCookies = process.env.HV_COOKIE_SECURE === "1" || frontendOrigin.startsWith("https://");

  const projects = new ProjectService(statePath);
  const jobs = new DurableJobStore(queuePath);
  const ledger = new CostLedger(costLedgerPath);
  const capacity = new CapacityController(Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000));

  const corsHeaders: Record<string, string> = {
    "access-control-allow-origin": frontendOrigin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
  const response = (payload: unknown, status = 200, extra: HeadersInit = {}) => Response.json(payload, {
    status,
    headers: { ...corsHeaders, ...extra },
  });

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
          return response({ ...created, projectUrl: `${frontendOrigin}/?project=${created.projectId}` }, 201);
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "script" && request.method === "PUT") {
          const token = bearer(request);
          const project = token ? projects.authorize(token) : null;
          if (!token || !project || project.id !== parts[2]) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          const text = typeof body.text === "string" ? body.text : "";
          if (!text.trim() || text.length > 200_000) return response({ error: "script must contain 1-200000 characters" }, 400);
          const parsed = parseFountain(text);
          if (parsed.rejected || parsed.scenes.length === 0) {
            return response({ error: parsed.rejectionReason ?? "screenplay contains no parseable scenes", warnings: parsed.warnings }, 422);
          }
          return response({ ...projects.editScript(token, text), scenes: parsed.scenes.length, warnings: parsed.warnings });
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "rights" && request.method === "POST") {
          const token = bearer(request);
          const project = token ? projects.authorize(token) : null;
          if (!token || !project || project.id !== parts[2]) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          if (body.attested !== true) {
            return response({ error: "rights attestation must be explicitly accepted" }, 400);
          }
          const attested = projects.attestRights(token);
          return response({ rightsAttestedAt: attested!.rightsAttestedAt });
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "artifact-session" && request.method === "POST") {
          const token = bearer(request);
          const project = token ? projects.authorize(token) : null;
          if (!token || !project || project.id !== parts[2]) return response({ error: "unauthorized" }, 401);
          const artifactToken = mintArtifactToken(project.id);
          return response(
            { expiresInSeconds: Math.floor(ARTIFACT_TOKEN_TTL_MS / 1000) },
            201,
            { "set-cookie": artifactCookie(artifactToken, secureCookies) },
          );
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "jobs" && request.method === "POST") {
          const token = bearer(request);
          const project = token ? projects.authorize(token) : null;
          if (!token || !project || project.id !== parts[2]) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);

          if (!project.rightsAttestedAt) {
            return response({ error: "complete the rights attestation before starting generation" }, 403);
          }

          const stage: JobStage = body.stage === "final" ? "final" : "animatic";
          let animaticApprovedAt: string | null = null;
          let animaticJobId: string | null = null;
          if (stage === "final") {
            animaticJobId = typeof body.animaticJobId === "string" ? body.animaticJobId : null;
            const approval = animaticJobId ? projects.animaticApproval(project.id, animaticJobId) : null;
            if (!approval || approval.decision !== "approved") {
              return response({ error: "the animatic must be approved before final generation" }, 403);
            }
            const latestVersion = project.versions.latest()?.version ?? 0;
            if (approval.scriptVersion !== latestVersion) {
              return response({ error: "the screenplay changed after approval; approve the new animatic first" }, 409);
            }
            animaticApprovedAt = approval.at;
          }

          const grant = typeof body.operatorGrant === "string" ? verifyOperatorGrant(body.operatorGrant, project.id) : null;
          const tier: Tier = grant ? "elevated" : "free";

          const scriptText = projects.latestScript(token);
          if (!scriptText) return response({ error: "save a screenplay before starting generation" }, 409);
          const shots = planShots(parseFountain(scriptText), 7000);
          const decision = capacity.decide({
            tier,
            runningForProject: jobs.all().filter((job) => job.projectId === project.id && job.status === "running").length,
            requestedShots: shots.length,
            monthSpendUsd: ledger.monthSpend(),
          });
          if (decision.action === "reject") return response({ error: decision.message }, 429);
          const id = crypto.randomUUID();
          const scriptVersion = project.versions.latest()?.version ?? 0;
          const job = jobs.enqueue({
            id,
            idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${project.id}:${stage}:${scriptVersion}`,
            projectId: project.id,
            tier,
            stage,
            totalFrames: shots.reduce((total, shot) => total + Math.round(shot.durationSec * 30), 0),
            retryPolicy: { maxRetries: 2, backoffMs: 1000 },
            timeoutMs: 30 * 60 * 1000,
            costCapUsd: Number(process.env.HV_COST_CAP_PER_SHOT_USD ?? 5) * Math.max(shots.length, 1),
            scriptText,
            rightsAttestedAt: project.rightsAttestedAt,
            animaticJobId,
            animaticApprovedAt,
          });
          return response({ jobId: job.id, stage: job.stage, status: job.status, queueAction: decision.action, tierLimits: TIERS[tier] }, 202);
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "animatic" && parts[4] === "decision" && request.method === "POST") {
          const token = bearer(request);
          const project = token ? projects.authorize(token) : null;
          if (!token || !project || project.id !== parts[2]) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          const decision: ReviewDecision | null = body.decision === "approved" || body.decision === "changes_requested" ? body.decision : null;
          const animaticJobId = typeof body.animaticJobId === "string" ? body.animaticJobId : "";
          if (!decision) return response({ error: "decision must be approved or changes_requested" }, 400);
          const animatic = jobs.get(animaticJobId);
          if (!animatic || animatic.projectId !== project.id || animatic.stage !== "animatic") {
            return response({ error: "unknown animatic job for this project" }, 404);
          }
          if (animatic.status !== "done") return response({ error: "the animatic is not ready for review yet" }, 409);
          const approval = projects.recordAnimaticDecision(
            project.id,
            animaticJobId,
            project.versions.latest()?.version ?? 0,
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
          return response(publicJob(job));
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "reviews" && request.method === "POST") {
          const token = bearer(request);
          const project = token ? projects.authorize(token) : null;
          if (!token || !project || project.id !== parts[2]) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          const permission = body.permission === "read" ? "read" : "approve";
          const link = projects.createReviewLink(token, permission);
          return response({ ...link, reviewUrl: `${frontendOrigin}/?review=${encodeURIComponent(link!.token)}` }, 201);
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
          return response(
            {
              projectId: use.projectId,
              permission: use.permission,
              viewsRemaining: use.viewsRemaining,
              jobId: latest.id,
              stage: latest.stage,
              output: artifactUrls(latest),
            },
            200,
            { "set-cookie": artifactCookie(mintArtifactToken(use.projectId), secureCookies) },
          );
        }

        if (parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts[3] === "decision" && request.method === "POST") {
          const body = await jsonBody(request);
          const decision: ReviewDecision | null = body.decision === "approved" || body.decision === "changes_requested" ? body.decision : null;
          if (!decision) return response({ error: "decision must be approved or changes_requested" }, 400);
          const reviewToken = decodeURIComponent(parts[2]);
          const accepted = projects.submitReviewDecision(reviewToken, decision, typeof body.note === "string" ? body.note : "");
          return accepted ? response({ accepted: true, decision }) : response({ error: "review link is invalid, expired, revoked, or read-only" }, 403);
        }

        if (parts[0] === "artifacts" && parts.length > 3 && request.method === "GET") {
          const token = bearer(request) ?? cookie(request, ARTIFACT_COOKIE);
          const payload = token ? verifyToken(token) : null;
          if (!payload || payload.projectId !== parts[1]) return response({ error: "unauthorized" }, 401);
          if (projects.isTakenDown(payload.projectId)) return response({ error: "not found" }, 404);
          const requested = resolve(artifactRoot, ...parts.slice(1));
          if (!requested.startsWith(`${artifactRoot}${sep}`) || !existsSync(requested)) return response({ error: "not found" }, 404);
          return new Response(Bun.file(requested), {
            headers: {
              ...corsHeaders,
              "content-type": CONTENT_TYPES[extname(requested)] ?? "application/octet-stream",
              "cache-control": "private, no-store",
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
