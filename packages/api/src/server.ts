import { existsSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { parseFountain } from "../../parser/src/index";
import { planShots } from "../../planner/src/index";
import { CapacityController, DurableJobStore, TIERS, type Tier } from "../../queue/src/index";
import { ProjectService, type ReviewDecision } from "./index";
import { tokenSecret, verifyToken } from "./tokens";

export interface ApiServerOptions {
  port?: number;
  hostname?: string;
  queuePath?: string;
  artifactRoot?: string;
  frontendOrigin?: string;
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

export function createApiServer(options: ApiServerOptions = {}): Bun.Server<unknown> {
  tokenSecret();
  const projects = new ProjectService();
  const queuePath = options.queuePath ?? process.env.HV_QUEUE_PATH ?? "/data/queue/jobs.json";
  const artifactRoot = resolve(options.artifactRoot ?? process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts");
  const frontendOrigin = options.frontendOrigin ?? process.env.HV_FRONTEND_ORIGIN ?? "http://localhost:8081";
  const jobs = new DurableJobStore(queuePath);
  const capacity = new CapacityController(Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000));

  const response = (payload: unknown, status = 200, extra: HeadersInit = {}) => Response.json(payload, {
    status,
    headers: { "access-control-allow-origin": frontendOrigin, ...extra },
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
            "access-control-allow-origin": frontendOrigin,
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
          });
        }

        if (request.method === "POST" && url.pathname === "/api/projects") {
          const created = projects.createAnonymousProject();
          return response({ ...created, projectUrl: `${frontendOrigin}/?project=${created.projectId}&token=${encodeURIComponent(created.token)}` }, 201);
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

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "jobs" && request.method === "POST") {
          const token = bearer(request);
          const project = token ? projects.authorize(token) : null;
          if (!token || !project || project.id !== parts[2]) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          const tier: Tier = body.tier === "elevated" ? "elevated" : "free";
          const scriptText = projects.latestScript(token);
          if (!scriptText) return response({ error: "save a screenplay before starting generation" }, 409);
          const shots = planShots(parseFountain(scriptText), 7000);
          const decision = capacity.decide({
            tier,
            runningForProject: jobs.all().filter((job) => job.projectId === project.id && job.status === "running").length,
            requestedShots: shots.length,
            monthSpendUsd: 0,
          });
          if (decision.action === "reject") return response({ error: decision.message }, 429);
          const id = crypto.randomUUID();
          const job = jobs.enqueue({
            id,
            idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${project.id}:${project.versions.latest()?.version}`,
            projectId: project.id,
            tier,
            totalFrames: shots.reduce((total, shot) => total + Math.round(shot.durationSec * 30), 0),
            retryPolicy: { maxRetries: 2, backoffMs: 1000 },
            timeoutMs: 30 * 60 * 1000,
            costCapUsd: Number(process.env.HV_COST_CAP_PER_SHOT_USD ?? 5) * Math.max(shots.length, 1),
            scriptText,
          });
          return response({ jobId: job.id, status: job.status, queueAction: decision.action, tierLimits: TIERS[tier] }, 202);
        }

        if (parts[0] === "api" && parts[1] === "jobs" && parts[2] && request.method === "GET") {
          const token = bearer(request);
          const job = jobs.get(parts[2]);
          const project = token ? projects.authorize(token) : null;
          if (!job || !project || project.id !== job.projectId) return response({ error: "not found" }, 404);
          const artifactUrl = (path: string) => `/artifacts/${path}?token=${encodeURIComponent(token!)}`;
          return response({
            ...job,
            scriptText: undefined,
            output: job.output ? {
              mp4Url: artifactUrl(job.output.mp4Path),
              hlsUrl: artifactUrl(job.output.hlsPlaylistPath),
              captionsUrl: artifactUrl(job.output.captionsPath),
              manifestUrl: artifactUrl(job.output.manifestPath),
            } : undefined,
          });
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

        if (parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts[3] === "decision" && request.method === "POST") {
          const body = await jsonBody(request);
          const decision: ReviewDecision | null = body.decision === "approved" || body.decision === "changes_requested" ? body.decision : null;
          if (!decision) return response({ error: "decision must be approved or changes_requested" }, 400);
          const accepted = projects.submitReviewDecision(parts[2], decision, typeof body.note === "string" ? body.note : "");
          return accepted ? response({ accepted: true, decision }) : response({ error: "review link is invalid, expired, revoked, or read-only" }, 403);
        }

        if (parts[0] === "artifacts" && parts.length > 3 && request.method === "GET") {
          const token = url.searchParams.get("token");
          const payload = token ? verifyToken(token) : null;
          if (!payload || payload.projectId !== parts[1]) return response({ error: "unauthorized" }, 401);
          const requested = resolve(artifactRoot, ...parts.slice(1));
          if (!requested.startsWith(`${artifactRoot}${sep}`) || !existsSync(requested)) return response({ error: "not found" }, 404);
          return new Response(Bun.file(requested), {
            headers: {
              "content-type": CONTENT_TYPES[extname(requested)] ?? "application/octet-stream",
              "cache-control": "private, max-age=300",
              "access-control-allow-origin": frontendOrigin,
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
