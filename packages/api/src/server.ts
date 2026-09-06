import {sourcePlan,staleSceneCuts,SceneCutConflict} from "../../planner/src/scene-cuts";
import {dialogueSource,dialoguePictureTime,createDialogueReplacement} from "../../planner/src/dialogue-replacement";
import {dialogueBaseline,assertDialogueAccess,assertDialogueSourceAvailable} from "../../planner/src/dialogue-jobs";
import {inspectDialogueSource} from "../../generator/src/dialogue-replacement";
import {speechRuntimeRevision} from "../../generator/src/speech";
import {contentHash} from "../../generator/src/capabilities";
import {generationStage,isFilmStage,isTakeStage} from "../../planner/src/render-stage";
import {createReusePlan} from "../../planner/src/shot-reuse";
import {assertMotionStudyCurrent} from "../../planner/src/motion-studies";
import {compileWanMovePacketAsync} from "../../generator/src/wan-move-packet";
import {createShotTakes,shotTakeShots,assertTakeCatalog} from "../../planner/src/takes";
import {frameAnchorRequest} from "../../planner/src/frame-anchors";
import {withAnchorStoryboard} from "../../generator/src/catalog";
import { StudioTelemetry, telemetryFromEnv } from "../../observability/src/index";
import { OperatorDiagnostics, readBackupStatus } from "../../observability/src/diagnostics";
import { TelemetryExplorer, JOB_ID, TRACE_ID } from "../../observability/src/explorer";
import { storageDiagnostics } from "../../storage/src/diagnostics";
import { diagnosticsSecret, verifyDiagnosticsToken } from "./operator-token";
import { artifactKey, objectClient, PostgresArtifactStore } from "../../storage/src/artifacts";
import { createHash } from "node:crypto";
import { normalizeReference, referenceBody, ReferenceBlobStore } from "../../storage/src/references";
import { MAX_REFERENCE_ASSETS } from "../../planner/src/references";
import { assertSheetDispatch, characterSheetShots, createCharacterSheet, SHEET_SIZE } from "../../planner/src/sheets";
import { ActorShareUnavailable, copiedActorReferences, importedActor } from "../../planner/src/actor-library";
import { mintActorToken } from "./actor-token";
import {sourceDirection,DEFAULT_DIRECTION,DIRECTION_CHOICES,currentDirection,directionEntry,directionMatches,directShots,staleDirections,DirectionConflict} from "../../planner/src/direction";
import {COVERAGE_CHOICES,DEFAULT_COVERAGE,coverageReport} from "../../planner/src/coverage";
import {CAMERA_PRESETS,DEFAULT_FRAMING,DEFAULT_OPTICS,isCropped} from "../../planner/src/framing";
import { StudioDatabase } from "../../storage/src/database";
import { PostgresProjectService } from "../../storage/src/projects";
import { PostgresJobStore } from "../../storage/src/jobs";
import { PostgresCostLedger } from "../../storage/src/ledger";
import { createProviderPlan } from "../../generator/src/catalog";
import { matchCapability, videoRequirements } from "../../generator/src/capabilities";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { parseFountain } from "../../parser/src/index";
import {lineSources} from "../../planner/src/performances";
import { CastingConflict, castingMatches, castingSnapshot, currentCasting, directCast,charactersForScene } from "../../planner/src/casting";
import { CapacityController, DOWNLOAD_LINK_TTL_MS, DurableJobStore, TIERS, type Job, type JobStage, type Tier } from "../../queue/src/index";
import { BudgetError, CostLedger } from "../../operator/src/index";
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
  storage?: "json" | "postgres";
  databaseUrl?: string;
  artifactStorage?: "local" | "s3";
  rateLimit?: Partial<RateLimitOptions>;
  tls?: MutualTlsOptions | null;
  telemetry?: StudioTelemetry;
  diagnostics?: () => OperatorDiagnostics;
  telemetryExplorer?: () => TelemetryExplorer;
  operatorDiagnosticsSecret?: string | null;
}

export interface ApiServer {
  readonly port: number | undefined;
  readonly hostname: string | undefined;
  readonly url: URL;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
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
interface Relay {
  partner: Bun.Socket<Relay> | null;
  outbox: Uint8Array[];
  held: Uint8Array[];
  heldBytes: number;
  endAfterFlush: boolean;
  closed: boolean;
}

const HELD_BYTES_LIMIT = 64 * 1024;

function newRelay(): Relay {
  return { partner: null, outbox: [], held: [], heldBytes: 0, endAfterFlush: false, closed: false };
}

function deliver(to: Bun.Socket<Relay>, chunk: Uint8Array): void {
  const relay = to.data;
  if (relay.closed) return;
  if (relay.outbox.length > 0) {
    relay.outbox.push(new Uint8Array(chunk));
    return;
  }
  const written = Math.max(to.write(chunk), 0);
  if (written < chunk.byteLength) relay.outbox.push(new Uint8Array(chunk.subarray(written)));
}

function flush(to: Bun.Socket<Relay>): void {
  const relay = to.data;
  while (relay.outbox.length > 0 && !relay.closed) {
    const chunk = relay.outbox[0]!;
    const written = Math.max(to.write(chunk), 0);
    if (written < chunk.byteLength) {
      relay.outbox[0] = chunk.subarray(written);
      return;
    }
    relay.outbox.shift();
  }
  if (relay.endAfterFlush && !relay.closed) to.end();
}

function finish(to: Bun.Socket<Relay> | null): void {
  if (!to || to.data.closed) return;
  to.data.endAfterFlush = true;
  if (to.data.outbox.length === 0) to.end();
}

function disconnect(socket: Bun.Socket<Relay>): void {
  const relay = socket.data;
  if (!relay) return;
  relay.closed = true;
  relay.held = [];
  finish(relay.partner);
}

const upstreamHandlers: Bun.SocketHandler<Relay> = {
  data(socket, chunk) {
    const partner = socket.data.partner;
    if (partner) deliver(partner, chunk);
  },
  drain: flush,
  end(socket) {
    finish(socket.data.partner);
  },
  close: disconnect,
  error: disconnect,
};

/**
 * Bun.serve answers an untrusted client certificate by closing the connection
 * after the handshake instead of failing it, so under TLS 1.3, where the
 * request travels in the same flight as the client's Finished, the request
 * races the close and is intermittently served. This front verifies the peer
 * in the handshake callback and relays bytes to the loopback application
 * listener only once the client chain is trusted; anything received before
 * that is held and discarded on rejection. Bun 1.3.x reports success and
 * authorized for a rejected chain and only sets the error, so all three are
 * checked.
 */
function mutualTlsFront(tls: MutualTlsOptions, hostname: string, port: number, loopbackPort: number): Bun.TCPSocketListener<Relay> {
  return Bun.listen<Relay>({
    hostname,
    port,
    tls: { cert: tls.cert, key: tls.key, ca: tls.clientCa, requestCert: true, rejectUnauthorized: true },
    socket: {
      open(socket) {
        socket.data = newRelay();
      },
      handshake(socket, success, authorizationError) {
        const relay = socket.data;
        if (!success || authorizationError !== null || !socket.authorized) {
          relay.closed = true;
          relay.held = [];
          socket.end();
          return;
        }
        Bun.connect<Relay>({ hostname: "127.0.0.1", port: loopbackPort, data: newRelay(), socket: upstreamHandlers })
          .then((upstream) => {
            if (relay.closed) {
              upstream.end();
              return;
            }
            relay.partner = upstream;
            upstream.data.partner = socket;
            for (const chunk of relay.held) deliver(upstream, chunk);
            relay.held = [];
          })
          .catch(() => {
            relay.closed = true;
            socket.end();
          });
      },
      data(socket, chunk) {
        const relay = socket.data;
        if (relay.closed) return;
        if (relay.partner) {
          deliver(relay.partner, chunk);
          return;
        }
        relay.heldBytes += chunk.byteLength;
        if (relay.heldBytes > HELD_BYTES_LIMIT) {
          relay.closed = true;
          relay.held = [];
          socket.end();
          return;
        }
        relay.held.push(new Uint8Array(chunk));
      },
      drain: flush,
      end(socket) {
        finish(socket.data.partner);
      },
      close: disconnect,
      error: disconnect,
    },
  });
}

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

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".wav":"audio/wav",
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
    ...(job.output.dialogue?{audioUrl:`${prefix}/${job.output.dialogue.wavPath}`} : {}),
    ...(job.output.sheetPath ? {sheetUrl:`${prefix}/${job.output.sheetPath}`} : {}),
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
  const { scriptText: _scriptText, casting, direction, dialogueReplacement, dialogueCheckpoint:_dialogueCheckpoint, ...rest } = job;
  const signed = signedOutput(job, project, now);
  const artifactPrefix = signed.output?.mp4Url.slice(0, signed.output.mp4Url.indexOf(job.output!.mp4Path));
  return { ...rest, ...signed, directionVersion:direction?.version??0,directionRevision:direction?.revision??null,castingVersion: casting?.version ?? 0, castingRevision: casting?.revision ?? null,
    ...(dialogueReplacement?{dialogueReplacement:{sourceJobId:dialogueReplacement.source.id,baselineJobId:dialogueReplacement.plan.baseline?.jobId??null,planRevision:dialogueReplacement.plan.revision,edits:dialogueReplacement.plan.edits},dialogue:job.output?.dialogue?{report:job.output.dialogue.report,audioUrl:signed.output?.audioUrl}:null}:{}),
    cameraPathRenders:job.output?.cameraPathRenders??[],frameAnchorRenders:job.output?.frameAnchorRenders??[],
    shotReuse:job.shotReuse?{planned:job.shotReuse.shots.length,forced:job.shotReuse.forceShotIds}:null,
    shotRenders:job.output?.shotRenders?.map(r=>({shotId:r.shotId,inputHash:r.inputHash,sha256:r.files.video.sha256,...(r.clip.speech&&r.files.audio?{speech:r.clip.speech,audioUrl:artifactPrefix+r.files.audio.path}:{}),origin:r.origin,reusedFrom:r.reusedFrom??null}))??[],
    takeClips:job.output?.takeClips?.map(clip=>({id:clip.id,label:clip.label,durationSec:clip.durationSec,seed:clip.seed,sha256:clip.sha256,costUsd:clip.costUsd,mode:clip.mode,
      mp4Url:artifactPrefix+clip.path,hlsUrl:artifactPrefix+clip.hlsPath,posterUrl:artifactPrefix+clip.posterPath,captionsUrl:artifactPrefix+clip.captionsPath,manifestUrl:artifactPrefix+clip.manifestPath}))??[],
    storyboard: job.output?.storyboard?.map(frame => ({ shotId: frame.shotId, caption: frame.caption, url: `${artifactPrefix}${frame.path}` })) ?? [] };
}

function projectUrl(frontendOrigin: string, token: string): string {
  return `${frontendOrigin}/#/p/${token}`;
}

function reviewUrl(frontendOrigin: string, token: string): string {
  return `${frontendOrigin}/#/review/${encodeURIComponent(token)}`;
}

export function createApiServer(options: ApiServerOptions = {}): ApiServer {
  tokenSecret();
  const telemetry=options.telemetry ?? telemetryFromEnv("api");
  const queuePath = options.queuePath ?? process.env.HV_QUEUE_PATH ?? "/data/queue/jobs.json";
  const artifactRoot = resolve(options.artifactRoot ?? process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts");
  const frontendOrigin = options.frontendOrigin ?? process.env.HV_FRONTEND_ORIGIN ?? "http://localhost:8081";
  const statePath = options.statePath ?? process.env.HV_PROJECT_STATE_PATH ?? "/data/state/projects.json";
  const costLedgerPath = options.costLedgerPath ?? process.env.HV_COST_LEDGER_PATH ?? "/data/state/cost-ledger.json";

  const database = (options.storage ?? process.env.HV_STORAGE) === "postgres"
    ? new StudioDatabase(options.databaseUrl ?? process.env.HV_API_DATABASE_URL ?? "") : undefined;
  const sharedArtifacts = (options.artifactStorage ?? process.env.HV_ARTIFACT_STORAGE) === "s3";
  if (sharedArtifacts && !database) throw new Error("shared artifacts require PostgreSQL metadata");
  const artifacts = sharedArtifacts ? new PostgresArtifactStore(database!, artifactRoot) : undefined;
  const references = new ReferenceBlobStore(artifactRoot,sharedArtifacts ? objectClient() : undefined);
  let referenceUploads = 0;
  let motionExports=0;
  let dialogueInspections=0;
  const projects = database ? new PostgresProjectService(database) : new ProjectService(statePath);
  const jobs = database ? new PostgresJobStore(database) : new DurableJobStore(queuePath);
  const scopedJobs = (projectId: string) => jobs instanceof PostgresJobStore ? jobs.forProject(projectId) : jobs;
  const ledger = database ? new PostgresCostLedger(database) : new CostLedger(costLedgerPath);
  const monthlyBudgetUsd = Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000);
  const operatorSecret = options.operatorDiagnosticsSecret === undefined ? diagnosticsSecret() : diagnosticsSecret(options.operatorDiagnosticsSecret ?? "");
  let diagnostics: OperatorDiagnostics | undefined;
  let explorer: TelemetryExplorer | undefined;
  const operatorExplorer = () => explorer ??= options.telemetryExplorer?.() ?? new TelemetryExplorer();
  const operatorStatus = () => {
    if (diagnostics) return diagnostics;
    if (options.diagnostics) return diagnostics = options.diagnostics();
    const probes = database ? storageDiagnostics(options.databaseUrl ?? process.env.HV_API_DATABASE_URL ?? "", monthlyBudgetUsd, sharedArtifacts) : {
      database: async () => {
        const all = await jobs.all();
        return {queue: {queued: all.filter(job => job.status === "queued").length, running: all.filter(job => job.status === "running").length},
          workers: null, budget: {recordedMonthUsd: await ledger.monthSpend(), reservedUsd: await ledger.reservedUsd(), monthlyCapUsd: monthlyBudgetUsd}};
      },
    };
    const backupPath = process.env.HV_BACKUP_STATUS_PATH;
    return diagnostics = new OperatorDiagnostics({...probes, telemetry, backend: database ? "postgres" : "json",
      expectedWorkers: Number(process.env.HV_EXPECTED_WORKERS ?? 1), backup: backupPath ? () => readBackupStatus(backupPath) : undefined});
  };
  const capacity = new CapacityController(monthlyBudgetUsd);
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

  const authorizedProject = async (request: Request, projectId: string): Promise<{ token: string; project: Project } | null> => {
    const token = bearer(request);
    const project = token ? await projects.authorize(token) : null;
    if (!token || !project || project.id !== projectId) return null;
    return { token, project };
  };

  const hostname = options.hostname ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.PORT ?? 8080);
  const app = Bun.serve({
    port: tls ? 0 : port,
    hostname: tls ? "127.0.0.1" : hostname,
    async fetch(request, server) {
      return telemetry.http(request,async()=>{
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      const peer = server.requestIP(request)?.address ?? null;
      if (tls && peer !== "127.0.0.1") return response({ error: "forbidden" }, 403);
      const address = clientAddress(request, peer, limits.trustProxy);
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
            "access-control-allow-headers": "authorization, content-type, x-hv-cast-version, x-hv-reference-attested, x-hv-direction-version, x-hv-script-version, x-hv-source-hash",
            "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
          },
        });
      }

      try {
        if (request.method === "GET" && (url.pathname === "/api/operator/traces" || url.pathname.startsWith("/api/operator/traces/") || url.pathname === "/api/operator/metrics")) {
          const headers = {"cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff"};
          if (!verifyDiagnosticsToken(bearer(request), operatorSecret)) return response({error: "unauthorized"}, 401, headers);
          const isList = url.pathname === "/api/operator/traces", isMetrics = url.pathname === "/api/operator/metrics";
          const jobId = url.searchParams.get("jobId"), id = url.pathname.slice("/api/operator/traces/".length);
          if ((isList && (url.searchParams.size > 1 || (url.searchParams.size === 1 && (!jobId || !JOB_ID.test(jobId)))))
            || (!isList && url.searchParams.size > 0) || (!isList && !isMetrics && !TRACE_ID.test(id)))
            return response({error: "Use a valid job ID or trace ID; other query parameters are unsupported."}, 400, headers);
          try {
            const reading = isList ? await operatorExplorer().recentTraces(jobId ?? undefined) : isMetrics ? await operatorExplorer().metrics() : await operatorExplorer().trace(id);
            return response({schema: isList ? "hv-operator-traces/1" : isMetrics ? "hv-operator-metrics/1" : "hv-operator-trace/1", ...reading}, 200, headers);
          } catch {return response({error: "Stored telemetry is unavailable. Try again shortly."}, 503, headers);}
        }
        if (request.method === "GET" && url.pathname === "/api/operator/status") {
          const headers = {"cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff"};
          if (!verifyDiagnosticsToken(bearer(request), operatorSecret)) return response({error: "unauthorized"}, 401, headers);
          try {return response(await operatorStatus().snapshot(), 200, headers);}
          catch {return response({error: "Operator diagnostics are unavailable. Try again shortly."}, 503, headers);}
        }
        if (request.method === "GET" && ["/api/operator/console", "/api/operator/app.js", "/api/operator/app.css"].includes(url.pathname)) {
          const file = url.pathname.endsWith("app.js") ? "operator.js" : url.pathname.endsWith("app.css") ? "operator.css" : "operator.html";
          return new Response(Bun.file(new URL("../../frontend/src/" + file, import.meta.url)), {headers: {
            "content-type": file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8",
            "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          }});
        }
        if(request.method==="GET"&&["/api/cast/performances.js","/api/direction/performances.js","/api/direction/dialogue-replacement.js","/api/direction/app.js","/api/direction/coverage.js","/api/direction/scene-cuts.js","/api/direction/viewfinder.js","/api/direction/camera-path.js","/api/direction/frame-anchors.js","/api/direction/takes.js","/api/direction/take-player.js","/api/direction/subject-motion.js"].includes(url.pathname))return new Response(Bun.file(new URL("../../frontend/src/"+(url.pathname.endsWith("app.js")?"direction.js":url.pathname.split("/").at(-1)),import.meta.url)),{headers:{...corsHeaders,"content-type":"text/javascript; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
        if (request.method === "GET" && ["/api/cast/app.js","/api/cast/sheets.js","/api/cast/library.js"].includes(url.pathname)) {
          return new Response(Bun.file(new URL("../../frontend/src/"+(url.pathname.endsWith("sheets.js")?"character-sheets.js":url.pathname.endsWith("library.js")?"actor-library.js":"casting.js"), import.meta.url)), {headers: {
            ...corsHeaders, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
          }});
        }
        if (request.method === "GET" && url.pathname === "/health") {
          const counts = database ? (await database.sql`select * from public.hv_queue_counts()`)[0] : null;
          const all = database ? [] : await jobs.all();
          return response({
            status: "healthy",
            service: "hollywood-video-private-staging",
            queueDepth: counts?.queued ?? all.filter((job) => job.status === "queued").length,
            runningJobs: counts?.running ?? all.filter((job) => job.status === "running").length,
            monthSpendUsd: Number((await ledger.monthSpend()).toFixed(4)),
          });
        }

        if (request.method === "POST" && url.pathname === "/api/projects") {
          const created = await projects.createAnonymousProject();
          return response({ ...created, projectUrl: projectUrl(frontendOrigin, created.token) }, 201);
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts.length === 3 && request.method === "GET") {
          const authorized = await authorizedProject(request, parts[2]);
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
            castingVersion: currentCasting(project.id, project.castingHistory).version,
            directionVersion:currentDirection(project.id,project.directionHistory).version,
            script: latest?.text ?? "",
            animaticApprovals: project.animaticApprovals,
            jobs: (await scopedJobs(project.id).all())
              .filter((job) => job.projectId === project.id)
              .map((job) => publicJob(job, project)),
          });
        }

        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="takes"&&((request.method==="GET"&&parts.length===4)||(request.method==="POST"&&parts.length===6&&parts[5]==="adopt"))){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const {project,token}=authorized,headers={"cache-control":"private, no-store"};
          if(request.method==="GET"){
            const shotId=url.searchParams.get("shotId"),groups=(await scopedJobs(project.id).all()).filter(job=>job.projectId===project.id&&isTakeStage(job.stage)&&job.shotTakes&&(!shotId||job.shotTakes.source.id===shotId)).slice(-20).reverse();
            return response({groups:groups.map(job=>publicJob(job,project)),scriptVersion:project.versions.latest()?.version??0,castingVersion:currentCasting(project.id,project.castingHistory).version,directionVersion:currentDirection(project.id,project.directionHistory).version},200,headers);
          }
          const body=await jsonBody(request),job=await scopedJobs(project.id).get(parts[4]!);
          if(!job||job.projectId!==project.id||!isTakeStage(job.stage)||job.status!=="done"||!job.shotTakes||!job.output?.takeClips?.some(t=>t.id===body.takeId))return response({error:"Choose a completed take from this project."},404,headers);
          const direction=await projects.adoptShotTake(token,job.shotTakes,body.takeId as string,body.expectedDirectionVersion as number,body.expectedScriptVersion as number);
          return direction?response({direction},200,headers):response({error:"unauthorized"},401,headers);
        }
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="direction") {
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const {project,token}=authorized,headers={"cache-control":"private, no-store"};
          if(parts[4]==="scene-cuts"&&request.method==="POST"){
            const body=await jsonBody(request);
            if(parts.length===5){const result=await projects.reviewSceneCut(token,body);return result?response(result,200,headers):response({error:"unauthorized"},401,headers);}
            if(parts.length===6&&parts[5]==="accept"){const direction=await projects.acceptSceneCut(token,body.proposal as import("../../planner/src/scene-cuts").CutProposal,body.removeDirectionIds);return direction?response({direction},200,headers):response({error:"unauthorized"},401,headers);}
            return response({error:"not found"},404,headers);
          }
          if(parts[5]==="subject-motion"){
            const shotId=parts[4]!;
            if(parts.length===6&&request.method==="GET"){
              const maxShots=Number(url.searchParams.get("maxShots")??24);if(![24,60].includes(maxShots))throw new Error("Choose the 24-shot or 60-shot plan.");
              const script=project.versions.latest(),parsed=parseFountain(script?.text??""),shot=sourcePlan(parsed,currentDirection(project.id,project.directionHistory),7000,maxShots,true).find(s=>s.id===shotId),cast=currentCasting(project.id,project.castingHistory),direction=currentDirection(project.id,project.directionHistory),study=project.motionStudies.studies.find(s=>s.source.id===shotId);
              if(!shot&&!study)return response({error:"This shot is not in the project."},404,headers);
              let staleReason="";if(study)try{assertMotionStudyCurrent(study,{projectId:project.id,scriptText:script?.text??"",scriptVersion:script?.version??0,casting:cast,direction,assets:project.referenceAssets});}catch(error){staleReason=(error as Error).message;}
              return response({version:project.motionStudies.version,scriptVersion:script?.version??0,directionVersion:direction.version,directionRevision:direction.revision,castingRevision:cast.revision,maxShots,source:shot?directionEntry(shot,DEFAULT_DIRECTION):null,study:study??null,staleReason,
                characters:shot?charactersForScene(cast,shot.sceneIndex,parsed).map(c=>({id:c.id,name:c.name})):[],assets:project.referenceAssets.filter(a=>a.source?.kind==="shot-anchor"&&a.source.shotId===shotId&&((a.width===832&&a.height===480)||(a.width===480&&a.height===832)))},200,headers);
            }
            if(parts.length===6&&request.method==="PUT"){
              const body=await jsonBody(request),collection=await projects.saveMotionStudy(token,shotId,body.input,body.expected as {version:number;scriptVersion:number;directionVersion:number;castingRevision:string});
              return collection?response({version:collection.version,study:collection.studies.find(s=>s.source.id===shotId)},200,headers):response({error:"unauthorized"},401,headers);
            }
            if(parts.length===7&&parts[6]==="remove"&&request.method==="POST"){
              const body=await jsonBody(request),collection=await projects.removeMotionStudy(token,shotId,body.expectedVersion as number,body.revision as string);
              return collection?response({version:collection.version},200,headers):response({error:"unauthorized"},401,headers);
            }
            if(parts.length===7&&parts[6]==="export"&&request.method==="GET"){
              if(motionExports>=2)return response({error:"Movement export is busy. Try again shortly."},429,headers);
              const revision=url.searchParams.get("revision")??"",study=await projects.currentMotionStudy(token,shotId,revision);if(!study)return response({error:"unauthorized"},401,headers);
              motionExports++;try{
                const packet=await compileWanMovePacketAsync(study.plan,await references.read(study.asset),request.signal),studyBytes=Buffer.from(JSON.stringify(study,null,2)+"\n"),packetManifest=JSON.parse(packet["manifest.json"].toString());
                const binding={schema:"hv-motion-study-export/1",studyRevision:study.revision,studySha256:createHash("sha256").update(studyBytes).digest("hex"),packetRevision:packetManifest.revision,status:"inputs-only"};
                const bytes=await new Bun.Archive({...Object.fromEntries(Object.entries(packet).map(([name,data])=>["packet/"+name,data])),"study.json":studyBytes,"binding.json":JSON.stringify(binding,null,2)+"\n"},{compress:"gzip"}).bytes();
                if(!await projects.currentMotionStudy(token,shotId,revision))return response({error:"unauthorized"},401,headers);
                return new Response(bytes,{headers:{...corsHeaders,...headers,"content-type":"application/gzip","content-disposition":"attachment; filename=movement-inputs.tar.gz","x-content-type-options":"nosniff","referrer-policy":"no-referrer"}});
              }finally{motionExports--;}
            }
            return response({error:"not found"},404,headers);
          }
          if(parts.length===6&&["anchors","motion-image"].includes(parts[5]!)&&request.method==="POST"){
            if(request.headers.get("x-hv-reference-attested")!=="true")return response({error:"Confirm you may use this image for generation under the private-staging content policy."},400,headers);
            if(!["image/png","image/jpeg"].includes(request.headers.get("content-type")??""))return response({error:"Choose a PNG or JPEG frame image."},415,headers);
            const expectedVersion=Number(request.headers.get("x-hv-direction-version")),expectedScriptVersion=Number(request.headers.get("x-hv-script-version")),sourceHash=request.headers.get("x-hv-source-hash")??"",maxShots=Number(url.searchParams.get("maxShots")??24);
            if(!request.headers.has("x-hv-direction-version")||!request.headers.has("x-hv-script-version")||expectedVersion!==currentDirection(project.id,project.directionHistory).version||expectedScriptVersion!==project.versions.latest()?.version)throw new DirectionConflict("The screenplay or direction changed. Reload before uploading.");
            if(![24,60].includes(maxShots))throw new Error("Choose the 24-shot or 60-shot planning limit.");
            const shot=sourcePlan(parseFountain(project.versions.latest()!.text),currentDirection(project.id,project.directionHistory),7000,maxShots).find(value=>value.id===parts[4]);
            if(!shot||directionEntry(shot,{}).sourceHash!==sourceHash)throw new DirectionConflict("The source shot changed. Reload before uploading.");
            if(project.referenceAssets.length>=MAX_REFERENCE_ASSETS)return response({error:"This project has reached its historical image limit."},409,headers);
            if(referenceUploads>=2)return response({error:"Image processing is busy. Try again shortly."},429,headers);
            const orientation=url.searchParams.get("orientation")??"landscape";if(parts[5]==="motion-image"&&!["landscape","portrait"].includes(orientation))throw new Error("Choose landscape or portrait before preparing the image.");
            referenceUploads++;try{const normalized=await normalizeReference(await referenceBody(request),project.id,Date.now(),request.signal,parts[5]==="motion-image"?(orientation==="landscape"?"motion-landscape":"motion-portrait"):undefined);
              normalized.asset.source={kind:"shot-anchor",shotId:parts[4]!,sourceHash,label:(url.searchParams.get("label")??"Frame anchor").trim()};
              await references.put(normalized.asset,normalized.data);
              const asset=await projects.storeFrameAnchorAsset(token,normalized.asset,expectedVersion,expectedScriptVersion,maxShots);
              return asset?response({asset},201,headers):response({error:"unauthorized"},401,headers);
            }finally{referenceUploads--;}
          }
          if(parts.length===4&&request.method==="GET") {
            const maxShots=Number(url.searchParams.get("maxShots")??24);if(![24,60].includes(maxShots))throw new Error("Choose the 24-shot or 60-shot planning limit.");
            const script=project.versions.latest(),shots=sourcePlan(parseFountain(script?.text??""),currentDirection(project.id,project.directionHistory),7000,maxShots,true),direction=currentDirection(project.id,project.directionHistory);
            const sources=new Map<string,{shotId:string;jobId:string;directionVersion:number;url:string}>(),cast=currentCasting(project.id,project.castingHistory);
            const desired=new Map(shots.map(shot=>[shot.id,directionEntry(shot,DEFAULT_DIRECTION).sourceHash]));
            for(const job of (await scopedJobs(project.id).all()).slice().reverse()){
              if(job.stage!=="animatic"||job.status!=="done"||!job.output||artifactLinkExpiry(job,project)<=Date.now()||!castingMatches(job.casting,cast))continue;
              const planned=new Map(sourcePlan(parseFountain(job.scriptText),job.direction,7000,TIERS[job.tier].maxShots).map(shot=>[shot.id,directionEntry(shot,DEFAULT_DIRECTION).sourceHash]));
              for(const frame of job.output.storyboard??[]){if(sources.has(frame.shotId)||!desired.has(frame.shotId)||desired.get(frame.shotId)!==planned.get(frame.shotId))continue;
                const oldSettings=job.direction?.entries.find(entry=>entry.source.id===frame.shotId)?.settings,path=frame.sourcePath??(!oldSettings?.cameraPath&&!isCropped(oldSettings?.framing)?frame.path:undefined);if(!path)continue;
                const signed=signedOutput(job,project).output!,prefix=signed.mp4Url!.slice(0,signed.mp4Url!.indexOf(job.output.mp4Path));
                sources.set(frame.shotId,{shotId:frame.shotId,jobId:job.id,directionVersion:job.direction?.version??0,url:prefix+path});}
              if(sources.size===shots.length)break;
            }
            return response({direction,scriptVersion:script?.version??0,castingRevision:cast.revision,maxShots,scenes:parseFountain(script?.text??"").scenes.map(s=>({index:s.index,heading:s.heading})),defaults:DEFAULT_DIRECTION,choices:DIRECTION_CHOICES,coverage:coverageReport(shots,direction),staleSceneIndices:staleSceneCuts(parseFountain(script?.text??""),direction).map(c=>c.source.sceneIndex),coverageDefaults:DEFAULT_COVERAGE,coverageChoices:COVERAGE_CHOICES,
              viewfinderSources:[...sources.values()],framingDefaults:DEFAULT_FRAMING,opticsDefaults:DEFAULT_OPTICS,cameraPresets:CAMERA_PRESETS,
              anchorAssets:project.referenceAssets.filter(asset=>asset.source?.kind==="shot-anchor"),
              motionPlans:project.motionStudies.studies.map(s=>({shotId:s.source.id,revision:s.revision,maxShots:s.maxShots})),
              plan:shots.map(shot=>({...directionEntry(shot,sourceDirection(shot)),durationSec:shot.durationSec,performanceLines:lineSources(shot.dialogue)})),staleShotIds:staleDirections(shots,direction).map(entry=>entry.source.id),
              history:project.directionHistory.map(value=>({version:value.version,createdAt:value.createdAt,shots:value.entries.length,sceneCuts:value.sceneCuts?.length??0}))},200,headers);
          }
          const body=await jsonBody(request);let direction;
          if(parts.length===5&&parts[4]==="restore"&&request.method==="POST")direction=await projects.restoreDirection(token,body.version as number,body.expectedVersion as number);
          else if(parts.length===5&&request.method==="PUT")direction=await projects.saveShotDirection(token,parts[4]!,body.settings,body.expectedVersion as number,body.expectedScriptVersion as number,body.sourceHash as string,body.maxShots===undefined?24:body.maxShots as number);
          else if(parts.length===6&&parts[5]==="remove"&&request.method==="POST")direction=await projects.removeShotDirection(token,parts[4]!,body.expectedVersion as number);
          else return response({error:"not found"},404,headers);
          return direction?response({direction},200,headers):response({error:"unauthorized"},401,headers);
        }
        if(parts[0]==="api" && parts[1]==="cast-library" && parts[2]==="actor" && request.method==="GET") {
          const token=bearer(request)??"",share=await projects.sharedActor(token),headers={"cache-control":"private, no-store","referrer-policy":"no-referrer"};
          if(parts.length===3)return response({share},200,headers);
          if(parts.length===5 && parts[3]==="references") {
            const asset=share.character.references?.find(value=>value.id===parts[4]);if(!asset)throw new ActorShareUnavailable();
            const bytes=await references.read(asset);await projects.sharedActor(token);
            return new Response(new Uint8Array(bytes),{headers:{...corsHeaders,...headers,"content-type":"image/png","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; sandbox"}});
          }
          return response({error:"not found"},404,headers);
        }
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "references" && parts.length === 5 && request.method === "GET") {
          const authorized = await authorizedProject(request,parts[2]);
          if (!authorized || Date.parse(authorized.project.deleteAfter) <= Date.now()) return response({error:"unauthorized"},401);
          const asset = authorized.project.referenceAssets.find(asset => asset.id === parts[4]);
          if (!asset) return response({error:"Reference not found."},404);
          return new Response(new Uint8Array(await references.read(asset)),{headers:{...corsHeaders,"content-type":"image/png","cache-control":"private, no-store",
            "x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; sandbox","content-disposition":"inline; filename=reference.png"}});
        }
        const takeQuote=parts.length===5&&parts[0]==="api"&&parts[1]==="projects"&&Boolean(parts[2])&&parts[3]==="takes"&&parts[4]==="quote";
        const takeSubmission=takeQuote||(parts.length===4&&parts[0]==="api"&&parts[1]==="projects"&&Boolean(parts[2])&&parts[3]==="takes");
        const sheetSubmission = parts[0]==="api" && parts[1]==="projects" && parts[3]==="cast" && parts.length===6 && parts[5]==="sheets" && request.method==="POST";
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "cast" && !sheetSubmission) {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized || Date.parse(authorized.project.deleteAfter) <= Date.now()) return response({error: "unauthorized"}, 401);
          const {project, token} = authorized;
          const headers = {"cache-control": "private, no-store"};
          if(parts.length===6 && parts[5]==="shares" && request.method==="GET") {
            return response({shares:project.actorShares.filter(share=>share.character.id===parts[4]).map(share=>({id:share.id,revision:share.revision,createdAt:share.createdAt,expiresAt:share.expiresAt,
              revokedAt:share.revokedAt,name:share.character.name,...(!share.revokedAt && Date.parse(share.expiresAt)>Date.now()?{token:mintActorToken(share)}:{})}))},200,headers);
          }
          if(parts.length===6 && parts[5]==="sheets" && request.method==="GET") {
            const jobs=(await scopedJobs(project.id).all()).filter(job=>job.stage==="character-sheet" && job.characterSheet?.characterId===parts[4]).slice(-10).reverse();
            return response({jobs:jobs.map(job=>publicJob(job,project))},200,headers);
          }
          if (parts.length === 4 && request.method === "GET") {
            const casting = currentCasting(project.id, project.castingHistory);
            const parsed = parseFountain(project.versions.latest()?.text ?? "");
            return response({casting,scriptVersion:project.versions.latest()?.version??0, history: project.castingHistory.map(value => ({version: value.version, createdAt: value.createdAt, characters: value.characters.length})),
              sceneHeadings: parsed.scenes.map(scene => ({number: scene.index + 1, heading: scene.heading})),
              suggestedNames: [...new Set(parsed.scenes.flatMap(scene => scene.dialogue.map(value => value.character)))].slice(0, 24)}, 200, headers);
          }
          if (parts.length === 6 && parts[5] === "references" && request.method === "POST") {
            if (request.headers.get("x-hv-reference-attested") !== "true") return response({error:"Confirm this image is an original fictional character reference you may use for generation."},400);
            if (!["image/png","image/jpeg"].includes(request.headers.get("content-type") ?? "")) return response({error:"Choose a PNG or JPEG reference."},415);
            const expected = Number(request.headers.get("x-hv-cast-version"));
            const current = currentCasting(project.id,project.castingHistory), character = current.characters.find(character => character.id === parts[4]);
            if (!request.headers.has("x-hv-cast-version") || !Number.isSafeInteger(expected) || expected !== current.version)
              throw new CastingConflict("The cast changed. Reload before adding a reference.");
            if (!character) return response({error:"Save the character before adding a reference."},404);
            if ((character.references?.length ?? 0) >= 4 || project.referenceAssets.length >= MAX_REFERENCE_ASSETS)
              return response({error:"The character or project has reached its reference image limit."},409);
            if (referenceUploads >= 2) return response({error:"Reference processing is busy. Try again shortly."},429);
            referenceUploads++;
            try {
              const normalized = await normalizeReference(await referenceBody(request),project.id,Date.now(),request.signal);
              await references.put(normalized.asset,normalized.data);
              const casting = await projects.addCharacterReference(token,character.id,normalized.asset,expected);
              if (!casting) return response({error:"unauthorized"},401);
              return response({casting,asset:normalized.asset},201,headers);
            } finally {referenceUploads--;}
          }
          const body = await jsonBody(request);
          const expectedVersion = body.expectedVersion as number;
          let casting;
          if(parts.length===6 && parts[5]==="shares" && request.method==="POST") {
            const share=await projects.shareCharacter(token,parts[4]!,expectedVersion,body.attested===true);if(!share)return response({error:"unauthorized"},401);
            return response({share,token:mintActorToken(share)},201,headers);
          }
          if(parts.length===8 && parts[5]==="shares" && parts[7]==="revoke" && request.method==="POST") {
            const share=await projects.revokeActorShare(token,parts[4]!,parts[6]!);if(!share)return response({error:"unauthorized"},401);
            return response({share},200,headers);
          }
          if(parts.length===5 && parts[4]==="import" && request.method==="POST") {
            if(typeof body.shareToken!=="string" || body.attested!==true)return response({error:"Review an actor share and confirm copying it into this project."},400);
            if(expectedVersion!==currentCasting(project.id,project.castingHistory).version)throw new CastingConflict("The cast changed. Reload before importing an actor.");
            const share=await projects.sharedActor(body.shareToken),assets=copiedActorReferences(share,project.id),options={name:body.name as string,aliases:body.aliases as string[],attested:true};
            if(project.id===share.projectId)throw new Error("Import this shared actor into a different project.");
            if(project.referenceAssets.length+assets.length>MAX_REFERENCE_ASSETS)throw new Error("This project has reached its historical reference limit.");
            const actor=importedActor(share,crypto.randomUUID(),project.id,options.name,options.aliases,assets);
            // Validate names, aliases and capacity before copying up to four private images.
            const current=currentCasting(project.id,project.castingHistory);castingSnapshot(project.id,current.version+1,[...current.characters,actor]);
            if(referenceUploads>=2)return response({error:"Reference processing is busy. Try again shortly."},429);
            referenceUploads++;
            try {
              for(const [index,asset]of assets.entries())await references.put(asset,await references.read(share.character.references![index]!));
              casting=await projects.importSharedActor(token,body.shareToken,assets,expectedVersion,options);
            } finally {referenceUploads--;}
          }
          else if(parts.length===6 && parts[5]==="costume-presets" && request.method==="POST") {
            if(!["apply","remove"].includes(body.action as string))throw new Error("Choose whether to apply or remove the costume preset.");
            casting=await projects.useCostumePreset(token,parts[4]!,body.index as number,body.sceneNumber as number|null,expectedVersion,body.action==="remove",Date.now(),body.expectedScriptVersion as number);
          }
          else if(parts.length===8 && parts[5]==="sheets" && parts[7]==="adopt" && request.method==="POST") {
            if(body.attested!==true)return response({error:"Review the generated view and confirm its permitted use before adding it as a reference."},400);
            const current=currentCasting(project.id,project.castingHistory),job=await scopedJobs(project.id).get(parts[6]!);
            if(!job || job.projectId!==project.id || job.stage!=="character-sheet" || job.status!=="done" || job.characterSheet?.characterId!==parts[4] || !job.casting)return response({error:"Completed character sheet not found."},404);
            if(expectedVersion!==current.version || !castingMatches(job.casting,current))throw new CastingConflict("The cast changed after this sheet. Generate a new sheet before adopting its view.");
            if(!Array.isArray(body.viewIds) || !body.viewIds.length || body.viewIds.length>4 || body.viewIds.some(id=>typeof id!=="string") || new Set(body.viewIds).size!==body.viewIds.length
              || (body.replaceExisting!==undefined && typeof body.replaceExisting!=="boolean"))return response({error:"Choose one to four distinct generated views."},400);
            const frames=body.viewIds.map(id=>job.output?.storyboard?.find(frame=>frame.shotId===id));
            if(frames.some(frame=>!frame?.sha256))return response({error:"Choose generated views from this sheet."},400);
            for(const frame of frames)assertSheetDispatch(job.characterSheet,job.casting,current,frame!.shotId,parseFountain(job.scriptText));
            if((body.replaceExisting?0:current.characters.find(value=>value.id===parts[4])!.references?.length??0)+frames.length>4)return response({error:"Replace the current references or choose fewer views; a character supports four references."},400);
            if(project.referenceAssets.length+frames.length>MAX_REFERENCE_ASSETS)return response({error:"This project has reached its historical reference limit."},409);
            const latestScript=project.versions.latest();if(latestScript?.version!==job.scriptVersion)throw new CastingConflict("The screenplay changed after this sheet. Generate a new sheet before adopting its view.");
            if(referenceUploads>=2)return response({error:"Reference processing is busy. Try again shortly."},429);
            referenceUploads++;
            try {
              const adopted=[];
              for(const selected of frames) {
              const frame=selected!,key=artifactKey(frame.path,project.id,job.id),fetchRequest=new Request("https://internal.invalid/reference",{signal:request.signal});
              const image=artifacts ? await artifacts.response(project.id,job.id,key,fetchRequest) : new Response(Bun.file(resolve(artifactRoot,key)));
              if(!image?.body || !image.ok)throw new Error("The generated reference image is unavailable.");
              const bytes=await referenceBody(new Request("https://internal.invalid/reference",{method:"POST",body:image.body,signal:request.signal}));
              if(createHash("sha256").update(bytes).digest("hex")!==frame.sha256)throw new Error("The generated view's checksum changed.");
              const normalized=await normalizeReference(bytes,project.id,Date.now(),request.signal);
              normalized.asset.source={kind:"character-sheet",jobId:job.id,viewId:frame.shotId,castingRevision:job.casting.revision};
              await references.put(normalized.asset,normalized.data);
              adopted.push(normalized.asset);
              }
              casting=await projects.addCharacterReferences(token,parts[4]!,adopted,expectedVersion,Date.now(),{expectedScriptVersion:job.scriptVersion,replaceExisting:body.replaceExisting===true,sheet:job.characterSheet});
            } finally {referenceUploads--;}
          }
          else if (parts.length === 5 && parts[4] === "restore" && request.method === "POST") casting = await projects.restoreCasting(token, body.version as number, expectedVersion);
          else if (parts.length === 5 && request.method === "PUT") casting = await projects.saveCharacter(token, parts[4]!, body.character, expectedVersion);
          else if (parts.length === 6 && parts[5] === "remove" && request.method === "POST") casting = await projects.removeCharacter(token, parts[4]!, expectedVersion);
          else if (parts.length === 6 && parts[5] === "revoke" && request.method === "POST") casting = await projects.revokeCharacterPermission(token, parts[4]!, expectedVersion);
          else if (parts.length === 8 && parts[5] === "references" && parts[7] === "remove" && request.method === "POST")
            casting = await projects.removeCharacterReference(token,parts[4]!,parts[6]!,expectedVersion);
          else return response({error: "not found"}, 404);
          if (!casting) return response({error: "unauthorized"}, 401);
          return response({casting}, 200, headers);
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "script" && request.method === "PUT") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          const text = typeof body.text === "string" ? body.text : "";
          if (!text.trim() || text.length > 200_000) return response({ error: "script must contain 1-200000 characters" }, 400);
          const parsed = parseFountain(text);
          if (parsed.rejected || parsed.scenes.length === 0) {
            return response({ error: parsed.rejectionReason ?? "screenplay contains no parseable scenes", warnings: parsed.warnings }, 422);
          }
          return response({ ...await projects.editScript(authorized.token, text), scenes: parsed.scenes.length, warnings: parsed.warnings });
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "rights" && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          if (body.attested !== true) {
            return response({ error: "rights attestation must be explicitly accepted" }, 400);
          }
          const attested = await projects.attestRights(authorized.token);
          return response({ rightsAttestedAt: attested!.rightsAttestedAt });
        }

        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="dialogue"&&parts[4]&&parts.length===5&&["GET","POST"].includes(request.method)){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const {project,token}=authorized,selected=await scopedJobs(project.id).get(parts[4]);
          if(!selected||selected.projectId!==project.id)return response({error:"unknown source cut"},404);
          const body=request.method==="POST"?await jsonBody(request):null;
          const requestHash=body?contentHash({sourceJobId:selected.id,request:Object.fromEntries(Object.entries(body).filter(([key])=>key!=="idempotencyKey"))}):null;
          if(body){
            if(Object.keys(body).some(key=>!["idempotencyKey","generationApproved","sourceRevision","sourceFilesRevision","baselineRevision","engineVersion","edits","operatorGrant"].includes(key)))return response({error:"Use supported dialogue request fields."},400);
            if(typeof body.idempotencyKey!=="string"||!IDEMPOTENCY_KEY_PATTERN.test(body.idempotencyKey))return response({error:"Use a new idempotencyKey of 1–128 printable ASCII characters."},400);
            const existing=(await scopedJobs(project.id).all()).find(j=>j.projectId===project.id&&j.idempotencyKey===`${project.id}:${body.idempotencyKey}`);
            if(existing){if(existing.stage!=="dialogue-replacement"||existing.dialogueReplacement?.requestHash!==requestHash)throw new DirectionConflict("This key belongs to another request. Use a new key for a new dialogue version.");return response({jobId:existing.id,stage:existing.stage,status:existing.status},202);}
            if(body.generationApproved!==true)throw new DirectionConflict("Review the selected lines and approve dialogue replacement before submitting.");
          }
          if(process.env.HV_NARRATION!=="1")throw new Error("Temporary speech is disabled by the operator.");
          const baseline=selected.dialogueReplacement?dialogueBaseline(selected):undefined,source=selected.dialogueReplacement?.source??selected;
          assertDialogueAccess(source,project,Date.now(),baseline);const locked=dialogueSource(source,dialoguePictureTime(source,baseline)),engineVersion=speechRuntimeRevision();
          if(engineVersion==="espeak-unavailable")throw new Error("The worker needs a supported temporary speech runtime.");
          if(dialogueInspections>=2)return response({error:"Two source cuts are being checked. Try again shortly."},429);
          dialogueInspections++;
          let pinned:Awaited<ReturnType<typeof inspectDialogueSource>>;
          try{pinned=artifacts?{revision:locked.revision,files:{video:await artifacts.fileInfo(project.id,selected.id,selected.output!.mp4Path),manifest:await artifacts.fileInfo(project.id,selected.id,selected.output!.manifestPath)}}:await inspectDialogueSource(selected,artifactRoot,request.signal);}finally{dialogueInspections--;}
          const sourceFilesRevision=contentHash(pinned.files);
          if(!body){let offset=0;const lines=locked.shots.flatMap(shot=>{const duration=Math.round(shot.clip.durationSec*30)*735,lines=shot.clip.speech?.lines??[];
            const rows=lines.map((line,index)=>{const inherited=baseline?.lines.find(l=>l.shotId===shot.shotId&&l.source.index===index);return {shotId:shot.shotId,index,sourceHash:line.source.hash,character:line.source.character,text:inherited?.text??line.source.text,voice:inherited?.voice??line.voice,notes:inherited?.notes??line.notes,startSec:(offset+line.startSample)/22050,endSec:(inherited?.endSample??offset+line.endSample)/22050,availableSec:((lines[index+1]?.startSample??duration)-line.startSample)/22050};});offset+=duration;return rows;});
            return response({sourceJobId:selected.id,originalJobId:source.id,baselineRevision:baseline?.revision??null,sourceRevision:pinned.revision,sourceFilesRevision,engineVersion,durationSec:locked.totalFrames/30,timing:"keep-line-starts",costUsd:0,lines},200,{"cache-control":"private, no-store"});
          }
          if(body.sourceRevision!==pinned.revision||body.sourceFilesRevision!==sourceFilesRevision||body.engineVersion!==engineVersion||(body.baselineRevision??null)!==(baseline?.revision??null))throw new DirectionConflict("The source cut, baseline dialogue or speech runtime changed. Review a new dialogue quote.");
          const plan=createDialogueReplacement(source,body.edits,pinned.revision,engineVersion,pinned.files,Date.now(),baseline),grant=typeof body.operatorGrant==="string"?verifyOperatorGrant(body.operatorGrant,project.id):null,tier:Tier=grant?"elevated":"free";
          const decision=capacity.decide({tier,runningForProject:(await scopedJobs(project.id).all()).filter(j=>j.projectId===project.id&&j.status==="running").length,requestedShots:locked.shots.length,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});
          if(decision.action==="reject")return response({error:decision.message,reason:decision.reason},429);
          const id=crypto.randomUUID(),input={id,idempotencyKey:`${project.id}:${body.idempotencyKey}`,projectId:project.id,tier,stage:"dialogue-replacement" as const,scriptVersion:source.scriptVersion,scriptText:source.scriptText,
            rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,queueAction:decision.action,queueReason:decision.reason,totalFrames:locked.totalFrames,costCapUsd:0,budgetReservedUsd:0,
            retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:Number(process.env.HV_JOB_TIMEOUT_MS??30*60*1000),traceparent:telemetry.carrier(),dialogueReplacement:{source:structuredClone(source),plan,requestHash:requestHash!,storage:artifacts?"s3" as const:"local" as const}};
          let job:Job;
          if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,input,monthlyBudgetUsd);
          else {await ledger.reserve(id,input.stage,0,monthlyBudgetUsd);try{
              assertDialogueSourceAvailable(input,await scopedJobs(project.id).get(selected.id));assertDialogueAccess(source,await projects.authorize(token),Date.now(),baseline);job=await scopedJobs(project.id).enqueue(input);
            }catch(error){await ledger.release(id);throw error;}if(job.id!==id)await ledger.release(id);}
          return response({jobId:job.id,stage:job.stage,status:job.status,queueAction:job.queueAction,queueReason:job.queueReason,costUsd:0},202);
        }

        if ((sheetSubmission || takeSubmission || (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "jobs")) && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const { project } = authorized;
          const body = await jsonBody(request);

          if (!project.rightsAttestedAt&&!takeQuote) {
            return response({ error: "complete the rights attestation before starting generation" }, 403);
          }

          const scriptText = project.versions.latest()?.text ?? "";
          if (!scriptText) return response({ error: "save a screenplay before starting generation" }, 409);
          const scriptVersion = project.versions.latest()?.version ?? 0;
          const casting = currentCasting(project.id, project.castingHistory);
          if(sheetSubmission && (body.expectedVersion!==casting.version || body.generationApproved!==true))throw new CastingConflict("Review the current cast and approve sheet generation before submitting.");
          if(!sheetSubmission&&!takeSubmission && body.stage!==undefined && !["animatic","final"].includes(body.stage as string))return response({error:"Unknown film render stage."},400);
          const characterSheet=sheetSubmission ? createCharacterSheet(casting,parseFountain(scriptText),parts[4]!,body.settings) : undefined;
          const direction=currentDirection(project.id,project.directionHistory);

          const grant = typeof body.operatorGrant === "string" ? verifyOperatorGrant(body.operatorGrant, project.id) : null;
          const tier: Tier = grant ? "elevated" : "free",parsedScript=parseFountain(scriptText);
          if(takeSubmission&&(body.expectedScriptVersion!==scriptVersion||body.expectedCastingVersion!==casting.version||body.expectedDirectionVersion!==direction.version||(!takeQuote&&body.generationApproved!==true)))throw new DirectionConflict("Review the current screenplay, cast and directions before generating takes.");
          if(takeSubmission&&body.stage!==undefined&&!["take-preview","take-final"].includes(body.stage as string))throw new Error("Choose preview or final take rendering.");
          const shotTakes=takeSubmission?createShotTakes(project.id,scriptVersion,casting,direction,parsedScript,{...(body.settings as object),maxShots:TIERS[tier].maxShots}):undefined;
          if(shotTakes)assertTakeCatalog(shotTakes,project.referenceAssets);
          const stage: JobStage = shotTakes?(body.stage==="take-final"?"take-final":"take-preview"):characterSheet ? "character-sheet" : body.stage === "final" ? "final" : "animatic";
          const renderStage=generationStage(stage);
          let animaticApprovedAt: string | null = null;
          let animaticJobId: string | null = null;
          if (renderStage === "final"&&!takeQuote) {
            animaticJobId = typeof body.animaticJobId === "string" ? body.animaticJobId : null;
            const animatic = animaticJobId ? await scopedJobs(project.id).get(animaticJobId) : undefined;
            if (!animatic || animatic.projectId !== project.id || animatic.stage !== (shotTakes?"take-preview":"animatic")) {
              return response({ error: "unknown animatic job for this project" }, 404);
            }
            const approval = await projects.animaticApproval(project.id, animatic.id);
            if (!approval || approval.decision !== "approved") {
              return response({ error: "the animatic must be approved before final generation" }, 403);
            }
            if (animatic.scriptVersion !== scriptVersion || approval.scriptVersion !== animatic.scriptVersion) {
              return response({ error: "the screenplay changed after the animatic rendered; render and approve a new animatic first" }, 409);
            }
            if (!castingMatches(animatic.casting, casting) || (approval.castingVersion ?? 0) !== casting.version
              || (casting.version > 0 && approval.castingRevision !== casting.revision)) return response({error: "The cast changed after this preview. Render and approve a new preview first."}, 409);
            if(!directionMatches(animatic.direction,direction)||(approval.directionVersion??0)!==direction.version||(direction.version>0&&approval.directionRevision!==direction.revision))throw new DirectionConflict("The shot directions changed after this preview. Render and approve a new preview first.");
            if(shotTakes&&(animatic.shotTakes?.revision!==shotTakes.revision||approval.takeRevision!==shotTakes.revision))throw new DirectionConflict("Approve this exact take group before final rendering.");
            if(!shotTakes&&approval.takeRevision!==undefined)throw new DirectionConflict("A take comparison cannot approve a full film.");
            animaticApprovedAt = approval.at;
          }

          const clientKey = body.idempotencyKey === undefined ? `${stage}:${scriptVersion}:cast-${casting.version}${shotTakes?":"+shotTakes.revision:characterSheet?":"+characterSheet.revision:direction.version?":direction-"+direction.version:""}` : body.idempotencyKey;
          if (typeof clientKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(clientKey)) {
            return response({ error: "idempotencyKey must be 1-128 printable ASCII characters" }, 400);
          }
          const existing = (await scopedJobs(project.id).all()).find(j => j.projectId === project.id && j.idempotencyKey === `${project.id}:${clientKey}`);
          if(existing?.dialogueReplacement)throw new DirectionConflict("This key belongs to a dialogue replacement. Use a new key for generation.");
          if(existing&&!takeQuote&&(shotTakes||isTakeStage(existing.stage))&&(existing.stage!==stage||existing.shotTakes?.revision!==shotTakes?.revision))throw new DirectionConflict("This idempotency key belongs to a different take plan or render stage. Use a new key.");
          if (existing&&!takeQuote) return response({ jobId: existing.id, stage: existing.stage, status: existing.status, scriptVersion: existing.scriptVersion }, 202);

          const shots = shotTakes ? shotTakeShots(shotTakes,casting,parsedScript,direction,scriptVersion) : characterSheet ? characterSheetShots(characterSheet,casting,parsedScript) : directShots(directCast(sourcePlan(parsedScript,direction,7000,TIERS[tier].maxShots), parsedScript, casting),direction);
          const decision = capacity.decide({
            tier,
            runningForProject: (await scopedJobs(project.id).all()).filter((job) => job.projectId === project.id && job.status === "running").length,
            requestedShots: shots.length,
            sceneCount: characterSheet||shotTakes ? new Set(shots.map(shot=>shot.sceneIndex)).size : parsedScript.scenes.length,
            monthSpendUsd: await ledger.monthSpend() + await ledger.reservedUsd(),
          });
          if (decision.action === "reject") return response({ error: decision.message, reason: decision.reason }, 429);
          const costCapUsd = characterSheet ? Number(process.env.HV_CHARACTER_SHEET_COST_CAP_USD ?? 5) : renderStage === "animatic" ? Number(process.env.HV_ANIMATIC_COST_CAP_USD ?? 5) : Number(process.env.HV_COST_CAP_PER_SHOT_USD ?? 5) * Math.max(shots.length, 1);
          if (!Number.isFinite(costCapUsd) || costCapUsd <= 0) throw new BudgetError("invalid stage budget");
          const providerPlan = withAnchorStoryboard(createProviderPlan(renderStage, renderStage === "animatic"&&!shotTakes ? costCapUsd : costCapUsd / Math.max(shots.length, 1), body.renderRequirements), shots.some(shot=>shot.direction?.frameAnchors&&(renderStage==="animatic"||shot.direction.frameAnchors.fallback==="storyboard")));
          if(takeSubmission&&!takeQuote&&body.providerPlanRevision!==undefined&&body.providerPlanRevision!==providerPlan.revision)throw new DirectionConflict("Provider configuration changed after the quote. Review a new take estimate before rendering.");
          const paid = providerPlan.pool.some(entry => entry.snapshot.price.unit !== "free");
          if(body.reuseUnchanged!==undefined&&typeof body.reuseUnchanged!=="boolean")throw new Error("Choose whether to reuse unchanged film shots.");
          if((body.reuseUnchanged||body.forceShotIds!==undefined)&&(shotTakes||characterSheet))throw new Error("Selective reuse applies to full film previews and finals.");
          if(body.forceShotIds!==undefined&&body.reuseUnchanged!==true)throw new Error("Enable selective reuse before choosing forced shot renders.");
          const shotReuse=body.reuseUnchanged===true?createReusePlan({projectId:project.id,stage,tier,scriptText,casting,direction,providerPlan},(await scopedJobs(project.id).all()).slice().reverse(),body.forceShotIds??[]):undefined;
          const rich = providerPlan.pool.some(entry => entry.snapshot.adapter === "rich-animatic");
          let minimumEstimateUsd = 0,maximumEstimateUsd=0;
          for (const shot of shots) {
            if(shotReuse?.shots.some(record=>record.shotId===shot.id))continue;
            const requirements = videoRequirements({performances:shot.performances,widthxheight: characterSheet ? SHEET_SIZE : renderStage === "animatic" ? "640x360" : TIERS[tier].maxResolution, fps: 30,
              durationSec: renderStage === "animatic" && !rich && !shot.direction?.frameAnchors && shot.direction?.durationFrames==null ? 1 : shot.durationSec,framing:shot.direction?.framing,cameraPath:shot.direction?.cameraPath,frameAnchors:frameAnchorRequest(shot.direction?.frameAnchors,renderStage), ...(characterSheet?{cameraMove:"static"}:renderStage==="animatic"&&shot.direction?.previewMove?{cameraMove:shot.direction.previewMove}:{}), referenceFrames:shot.referenceAssets?.map(asset => asset.id), routingRequirements: providerPlan.requirements});
            const matches = providerPlan.pool.map(entry => matchCapability(entry.snapshot, requirements, providerPlan.maxShotUsd));
            const eligible = matches.filter(match => match.eligible);
            if (!eligible.length) {
              const reasons = [...new Set(matches.flatMap(match => match.reasons))];
              if (reasons.every(reason => reason === "price")) throw new BudgetError("No configured provider fits the per-shot generation budget.");
              throw new Error("No configured provider supports these render requirements: " + reasons.join(", ") + ".");
            }
            minimumEstimateUsd += Math.min(...eligible.map(match => match.estimateUsd!));maximumEstimateUsd+=Math.max(...eligible.map(match=>match.estimateUsd!));
          }
          if (minimumEstimateUsd > costCapUsd + 1e-9) throw new BudgetError("The render exceeds its generation budget; shorten the screenplay.");
          if(takeQuote)return response({plan:shotTakes,stage,minimumEstimateUsd,maximumEstimateUsd,costCapUsd,perTakeCapUsd:providerPlan.maxShotUsd,providerPlanRevision:providerPlan.revision},200,{"cache-control":"private, no-store"});
          const id = crypto.randomUUID();
          const budgetReservedUsd = paid ? (shotReuse?.shots.length===shots.length?0:costCapUsd) : 0;
          const input = {
            id,
            traceparent: telemetry.carrier(),
            idempotencyKey: `${project.id}:${clientKey}`,
            projectId: project.id,
            tier,
            stage,
            scriptVersion,
            queueAction: decision.action,
            queueReason: decision.reason,
            totalFrames: shots.reduce((total, shot) => total + Math.round(shot.durationSec * 30), 0),
            retryPolicy: { maxRetries: 2, backoffMs: 1000 },
            timeoutMs: Number(process.env.HV_JOB_TIMEOUT_MS ?? 30 * 60 * 1000),
            costCapUsd,
            budgetReservedUsd,
            providerSpec: renderStage === "animatic" ? providerPlan.pool[0]!.spec : undefined,
            providerPlan,
            ...(shotReuse?{shotReuse}:{}),
            casting,
            ...(!characterSheet?{direction}:{}),
            ...(characterSheet ? {characterSheet} : {}),...(shotTakes?{shotTakes}:{}),
            scriptText,
            rightsAttestedAt: project.rightsAttestedAt,
            animaticJobId,
            animaticApprovedAt,
          };
          let job: Job;
          if (ledger instanceof PostgresCostLedger) {
            job = await ledger.admit(project.id, input, monthlyBudgetUsd);
          } else {
            await ledger.reserve(id, stage, budgetReservedUsd, monthlyBudgetUsd);
            try {
              if(!(projects instanceof ProjectService))throw new Error("Project storage and admission storage must use the same backend.");
              const latest=projects.authorize(authorized.token);
              if(!latest||latest.versions.latest()?.version!==scriptVersion||!castingMatches(casting,currentCasting(project.id,latest.castingHistory))||(!characterSheet&&!directionMatches(direction,currentDirection(project.id,latest.directionHistory))))throw new DirectionConflict("The screenplay, cast or shot directions changed before admission. Reload and create a new preview.");
              job = await scopedJobs(project.id).enqueue(input);
            }
            catch (error) { await ledger.release(id); throw error; }
            if (job.id !== id) await ledger.release(id);
          }
          return response({
            jobId: job.id,
            stage: job.stage,
            scriptVersion: job.scriptVersion,
            reusedShots:job.shotReuse?.shots.length??0,
            status: job.status,
            queueAction: job.queueAction,
            queueReason: job.queueReason,
            queuedBehind: job.queuedBehind.length,
            message: job.queueAction === "queue_behind" ? decision.message : undefined,
            tierLimits: TIERS[tier],
          }, 202);
        }

        const takeDecision=parts.length===6&&parts[0]==="api"&&parts[1]==="projects"&&Boolean(parts[2])&&parts[3]==="takes"&&parts[5]==="decision";
        if (((parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "animatic" && parts[4] === "decision")||takeDecision) && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const { project } = authorized;
          const body = await jsonBody(request);
          const decision: ReviewDecision | null = body.decision === "approved" || body.decision === "changes_requested" ? body.decision : null;
          const animaticJobId = takeDecision?parts[4]!:typeof body.animaticJobId === "string" ? body.animaticJobId : "";
          if (!decision) return response({ error: "decision must be approved or changes_requested" }, 400);
          const animatic = await scopedJobs(project.id).get(animaticJobId);
          if (!animatic || animatic.projectId !== project.id || animatic.stage !== (takeDecision?"take-preview":"animatic") || Boolean(animatic.shotTakes)!==takeDecision) {
            return response({ error: "unknown animatic job for this project" }, 404);
          }
          if (animatic.status !== "done") return response({ error: "the animatic is not ready for review yet" }, 409);
          const latestVersion = project.versions.latest()?.version ?? 0;
          const casting = currentCasting(project.id, project.castingHistory);
          const direction=currentDirection(project.id,project.directionHistory);
          if (!castingMatches(animatic.casting, casting)) return response({error: "The cast changed after this preview. Render a new preview before deciding."}, 409);
          if(!directionMatches(animatic.direction,direction))throw new DirectionConflict("The shot directions changed after this preview. Render a new preview before deciding.");
          if (animatic.scriptVersion !== latestVersion) {
            return response({
              error: "the screenplay changed after this animatic rendered; render a new animatic before deciding",
              animaticScriptVersion: animatic.scriptVersion,
              currentScriptVersion: latestVersion,
            }, 409);
          }
          const approval = await projects.recordAnimaticDecision(
            project.id,
            animatic.id,
            animatic.scriptVersion,
            decision,
            typeof body.note === "string" ? body.note : "",
            Date.now(), casting,direction,takeDecision?animatic.shotTakes:undefined,
          );
          if (!approval) return response({ error: "The screenplay or cast changed; render a new preview before deciding." }, 409);
          return response({ ...approval }, 201);
        }

        if (parts[0] === "api" && parts[1] === "jobs" && parts[2] && request.method === "GET") {
          const token = bearer(request);
          const project = token ? await projects.authorize(token) : null;
          const job = project ? await scopedJobs(project.id).get(parts[2]) : undefined;
          if (!job || !project || project.id !== job.projectId) return response({ error: "not found" }, 404);
          return response(publicJob(job, project));
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "reviews" && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          const permission = body.permission === "read" ? "read" : "approve";
          const link = await projects.createReviewLink(authorized.token, permission);
          return response({ ...link, reviewUrl: reviewUrl(frontendOrigin, link!.token) }, 201);
        }

        if (parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts.length === 3 && request.method === "GET") {
          const reviewToken = decodeURIComponent(parts[2]);
          const use = await projects.useReviewLink(reviewToken);
          if (!use) return response({ error: "review link is invalid, expired, revoked, or fully used" }, 403);
          const latest = (await scopedJobs(use.projectId).all())
            .filter((job) => job.projectId === use.projectId && isFilmStage(job.stage) && job.status === "done" && job.output)
            .sort((a, b) => a.id.localeCompare(b.id))
            .pop();
          if (!latest) return response({ error: "this project has no finished cut to review yet" }, 404);
          const reviewed = await projects.peekProject(use.projectId);
          if (!reviewed) return response({ error: "review link is invalid, expired, revoked, or fully used" }, 403);
          return response({
            projectId: use.projectId,
            permission: use.permission,
            viewsRemaining: use.viewsRemaining,
            jobId: latest.id,
            stage: latest.stage,
            ...signedOutput(latest, reviewed),cameraPathRenders:latest.output?.cameraPathRenders??[],frameAnchorRenders:latest.output?.frameAnchorRenders??[],castingVersion:latest.casting?.version??0,directionVersion:latest.direction?.version??0,
          });
        }

        if (parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts[3] === "decision" && request.method === "POST") {
          const body = await jsonBody(request);
          const decision: ReviewDecision | null = body.decision === "approved" || body.decision === "changes_requested" ? body.decision : null;
          if (!decision) return response({ error: "decision must be approved or changes_requested" }, 400);
          const reviewToken = decodeURIComponent(parts[2]);
          const accepted = await projects.submitReviewDecision(reviewToken, decision, typeof body.note === "string" ? body.note : "");
          return accepted ? response({ accepted: true, decision }) : response({ error: "review link is invalid, expired, revoked, or read-only" }, 403);
        }

        if (parts[0] === "artifacts" && ["GET", "HEAD"].includes(request.method)) {
          const [, artifactToken, projectId, jobId, ...rest] = parts;
          const payload = artifactToken ? verifyToken(artifactToken) : null;
          if (!payload || payload.kind !== "artifact" || !projectId || payload.projectId !== projectId || !jobId || payload.jobId !== jobId || rest.length === 0) {
            return response({ error: "unauthorized" }, 401);
          }
          const project = await projects.peekProject(projectId);
          if (!project || new Date(project.deleteAfter).getTime() <= Date.now() || await projects.isTakenDown(projectId)) return response({ error: "not found" }, 404);
          if (artifacts) return await artifacts.response(projectId, jobId, [projectId, jobId, ...rest].join("/"), request, corsHeaders)
            ?? response({error: "not found"}, 404);
          const jobRoot = resolve(artifactRoot, projectId, jobId);
          const requested = resolve(jobRoot, ...rest);
          if (!requested.startsWith(`${jobRoot}${sep}`) || !existsSync(requested)) return response({ error: "not found" }, 404);
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
        return response({ error: error instanceof Error ? error.message : "internal error", reason: error instanceof BudgetError ? "budget_exhausted" : undefined }, error instanceof BudgetError ? 429 : error instanceof CastingConflict||error instanceof SceneCutConflict || error instanceof DirectionConflict ? 409 : error instanceof ActorShareUnavailable ? 404 : 400);
      }
      });
    },
  });
  if (!tls) return {port: app.port, hostname: app.hostname, url: app.url, async stop(closeActiveConnections) {
    explorer?.close();
    await app.stop(closeActiveConnections); await database?.close(); await diagnostics?.close();
    if(!options.telemetry)await telemetry.shutdown();
  }};
  const loopbackPort = app.port;
  if (!loopbackPort) {
    app.stop(true);
    throw new Error("the loopback application listener did not bind a port");
  }
  const front = mutualTlsFront(tls, hostname, port, loopbackPort);
  return {
    port: front.port,
    hostname: front.hostname,
    url: new URL(`https://${front.hostname}:${front.port}/`),
    async stop(closeActiveConnections) {
      explorer?.close();
      front.stop(closeActiveConnections);
      await app.stop(closeActiveConnections);
      await database?.close();
      await diagnostics?.close();
      if(!options.telemetry)await telemetry.shutdown();
    },
  };
}

if (import.meta.main) {
  const server = createApiServer();
  console.log(`Hollywood Video private staging API listening on ${server.url}`);
}
