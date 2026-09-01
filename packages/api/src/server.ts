import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { parseFountain } from "../../parser/src/index";
import { planShots } from "../../planner/src/index";
import { CapacityController, DOWNLOAD_LINK_TTL_MS, DurableJobStore, TIERS, type Job, type JobStage, type Tier } from "../../queue/src/index";
import { CostLedger } from "../../operator/src/index";
import { ProjectService, type Project, type ReviewDecision } from "./index";
import { RateLimiter, clientAddress, type RateLimitRule } from "./rate-limit";
import { mintArtifactToken, tokenSecret, verifyOperatorGrant, verifyToken } from "./tokens";

export interface MutualTlsOptions {
  /** PEM server certificate chain. */
  cert: string;
  /** PEM server private key. */
  key: string;
  /** PEM CA that issued the client certificates; every connection must present one signed by it. */
  clientCa: string;
}

export interface RateLimitOptions {
  api: RateLimitRule;
  projectCreate: RateLimitRule;
  artifacts: RateLimitRule;
  trustProxy: boolean;
}

export interface ApiServerOptions {
  port?: number;
  hostname?: string;
  queuePath?: string;
  artifactRoot?: string;
  frontendOrigin?: string;
  statePath?: string;
  costLedgerPath?: string;
  rateLimit?: Partial<RateLimitOptions>;
  tls?: MutualTlsOptions | null;
}

export const DEFAULT_RATE_LIMITS: RateLimitOptions = {
  api: { limit: 120, windowMs: 60_000 },
  projectCreate: { limit: 20, windowMs: 3600_000 },
  artifacts: { limit: 600, windowMs: 60_000 },
  trustProxy: false,
};

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function rateLimitsFromEnv(): RateLimitOptions {
  return {
    api: { limit: envInt("HV_RATE_LIMIT_API_PER_MINUTE", DEFAULT_RATE_LIMITS.api.limit), windowMs: 60_000 },
    projectCreate: { limit: envInt("HV_RATE_LIMIT_PROJECTS_PER_HOUR", DEFAULT_RATE_LIMITS.projectCreate.limit), windowMs: 3600_000 },
    artifacts: { limit: envInt("HV_RATE_LIMIT_ARTIFACTS_PER_MINUTE", DEFAULT_RATE_LIMITS.artifacts.limit), windowMs: 60_000 },
    trustProxy: process.env.HV_TRUST_PROXY === "1",
  };
}

/**
 * NFR-004 / C-008: internal service traffic runs over mTLS. When the three
 * paths are configured the API only accepts connections that present a client
 * certificate issued by the internal CA; the frontend proxy is the sole holder
 * of one. Leaving them unset keeps plain HTTP for local development and tests.
 */
export function mutualTlsFromEnv(): MutualTlsOptions | null {
  const certPath = process.env.HV_TLS_CERT_PATH;
  const keyPath = process.env.HV_TLS_KEY_PATH;
  const caPath = process.env.HV_TLS_CLIENT_CA_PATH;
  if (!certPath && !keyPath && !caPath) return null;
  if (!certPath || !keyPath || !caPath) {
    throw new Error("HV_TLS_CERT_PATH, HV_TLS_KEY_PATH, and HV_TLS_CLIENT_CA_PATH must all be set to enable mTLS");
  }
  return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8"), clientCa: readFileSync(caPath, "utf8") };
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
 * Artifact access uses signed URLs (FR-053: no cookies). The job-bound
 * artifact token is a path segment, so the relative media segment URIs inside
 * an HLS playlist resolve under the same signed prefix and inherit the
 * authorization without a cookie or a query string.
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

/**
 * FR-040: the download link is valid for 30 days from completion, capped at
 * the project's retention date because the artifacts are deleted then.
 */
export function artifactLinkExpiry(job: Job, project: Pick<Project, "deleteAfter">, now = Date.now()): number {
  const completedAt = job.completedAt ? new Date(job.completedAt).getTime() : now;
  const linkExpiresAt = job.linkExpiresAt ? new Date(job.linkExpiresAt).getTime() : completedAt + DOWNLOAD_LINK_TTL_MS;
  return Math.min(linkExpiresAt, new Date(project.deleteAfter).getTime());
}

function signedOutput(job: Job, project: Pick<Project, "deleteAfter">, now = Date.now()): { output?: Record<string, string>; artifactUrlsExpireAt: string | null; artifactUrlsExpireInSeconds: number | null } {
  if (!job.output) return { output: undefined, artifactUrlsExpireAt: null, artifactUrlsExpireInSeconds: null };
  const expiresAt = artifactLinkExpiry(job, project, now);
  return {
    output: signedArtifactUrls(job, mintArtifactToken(job.projectId, job.id, expiresAt)),
    artifactUrlsExpireAt: new Date(expiresAt).toISOString(),
    artifactUrlsExpireInSeconds: Math.max(0, Math.floor((expiresAt - now) / 1000)),
  };
}

function publicJob(job: Job, project: Pick<Project, "deleteAfter">, now = Date.now()): Record<string, unknown> {
  const { scriptText: _scriptText, ...rest } = job;
  return { ...rest, ...signedOutput(job, project, now) };
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
  const limits: RateLimitOptions = { ...rateLimitsFromEnv(), ...options.rateLimit };
  const limiter = new RateLimiter(tokenSecret());
  const tls = options.tls === undefined ? mutualTlsFromEnv() : options.tls;

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
    ...(tls ? { tls: { cert: tls.cert, key: tls.key, ca: tls.clientCa, requestCert: true, rejectUnauthorized: true } } : {}),
    async fetch(request, server) {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      const address = clientAddress(request, server.requestIP(request)?.address ?? null, limits.trustProxy);
      const scope = parts[0] === "artifacts" ? "artifacts" : "api";
      const verdict = limiter.check(scope, address, scope === "artifacts" ? limits.artifacts : limits.api);
      const created = request.method === "POST" && url.pathname === "/api/projects"
        ? limiter.check("project-create", address, limits.projectCreate)
        : null;
      const throttled = !verdict.allowed ? verdict : created && !created.allowed ? created : null;
      if (throttled) {
        return response({ error: "Too many requests. Please wait and try again." }, 429, {
          "retry-after": String(throttled.retryAfterSeconds),
          "cache-control": "no-store",
        });
      }

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
              .map((job) => publicJob(job, project)),
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
          if (decision.action === "reject") return response({ error: decision.message, reason: decision.reason }, 429);
          const id = crypto.randomUUID();
          const job = jobs.enqueue({
            id,
            idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${project.id}:${stage}:${scriptVersion}`,
            projectId: project.id,
            tier,
            stage,
            scriptVersion,
            queueAction: decision.action,
            queueReason: decision.reason,
            totalFrames: shots.reduce((total, shot) => total + Math.round(shot.durationSec * 30), 0),
            retryPolicy: { maxRetries: 2, backoffMs: 1000 },
            timeoutMs: 30 * 60 * 1000,
            costCapUsd: Number(process.env.HV_COST_CAP_PER_SHOT_USD ?? 5) * Math.max(shots.length, 1),
            scriptText,
            rightsAttestedAt: project.rightsAttestedAt,
            animaticJobId,
            animaticApprovedAt,
          });
          return response({
            jobId: job.id,
            stage: job.stage,
            scriptVersion: job.scriptVersion,
            status: job.status,
            queueAction: job.queueAction,
            queueReason: job.queueReason,
            queuedBehind: job.queuedBehind.length,
            message: job.queueAction === "queue_behind" ? decision.message : undefined,
            tierLimits: TIERS[tier],
          }, 202);
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
          return response(publicJob(job, project));
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
          const reviewed = projects.peekProject(use.projectId);
          if (!reviewed) return response({ error: "review link is invalid, expired, revoked, or fully used" }, 403);
          return response({
            projectId: use.projectId,
            permission: use.permission,
            viewsRemaining: use.viewsRemaining,
            jobId: latest.id,
            stage: latest.stage,
            ...signedOutput(latest, reviewed),
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
          const [, artifactToken, projectId, jobId, ...rest] = parts;
          const payload = artifactToken ? verifyToken(artifactToken) : null;
          if (!payload || payload.kind !== "artifact" || !projectId || payload.projectId !== projectId || !jobId || payload.jobId !== jobId || rest.length === 0) {
            return response({ error: "unauthorized" }, 401);
          }
          if (projects.isTakenDown(projectId)) return response({ error: "not found" }, 404);
          const requested = resolve(artifactRoot, projectId, jobId, ...rest);
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
  console.log(`Hollywood Video private staging API listening on ${server.url}`);
}
