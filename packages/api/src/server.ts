import { assertFilmBudget, filmCapFor, filmLimits, renderHold } from "../../operator/src/film-budget";
import { voiceVendorCap } from "../../operator/src/voice-vendor-budget";
import { musicVendorCap } from "../../operator/src/music-vendor-budget";
import { monthlyBudgetCap } from "../../operator/src/dollar-setting";
import { MusicLedger, type MusicLineLedger } from "../../operator/src/music-ledger";
import { PostgresMusicLedger } from "../../storage/src/music-ledger";
import { musicProviderFromEnvironment } from "../../generator/src/elevenlabs-music";
import type { MusicProvider } from "../../generator/src/music-provider";
import { MusicCueError } from "../../generator/src/music-provider";
import { MusicCueConflict, MusicCueFailed, MusicRefused, MusicUnavailable, generateMusicCue, musicStatus } from "./music-cues";
import { crewModelFromEnvironment, type CrewModel, type CrewUnusableReason } from "../../generator/src/crew-model";
import { CrewBudgetStop, CrewLedger } from "../../operator/src/crew-ledger";
import { READ_THROUGH_SHOT_LIMIT, readThroughFacts, readThroughInput, runReadThrough } from "../../planner/src/crew/read-through";
import { billedShotTiming, crewChanges, planInput, runPlan, type ShotTiming } from "../../planner/src/crew/production-plan";
import { castVoices } from "../../planner/src/crew/voice-casting";
import { styleCardFrom } from "../../planner/src/crew/style-card";
import { LineNoteConflict, lineNotesInput, runLineNotes, scriptSha256 } from "../../planner/src/crew/line-notes";
import { scriptIntroductions } from "../../planner/src/crew/introductions";
import { continuityComparisons, continuitySupervisorNotes } from "../../planner/src/crew/continuity-supervisor";
import { runShowrunner, showrunnerNote, type ShowrunnerResult } from "../../planner/src/crew/showrunner";
import { DIRECTION_ENTRY_LIMIT } from "../../planner/src/direction";
import { featureShots, filmPlan, inSequence, oversizedScenes, sameSequence, sceneShotCounts, SequenceSplitError, sequenceRef, stalePlanReason, type SequenceRef } from "../../planner/src/sequences";
import { REVIEW_VIEWER_HEADER, ReviewViewLimitError, reviewViewLimit, reviewViewer } from "./review-views";
import {sourcePlan,staleSceneCuts,SceneCutConflict} from "../../planner/src/scene-cuts";
import {dialogueSource,dialoguePictureTime,createDialogueReplacement,auditionText,dialogueLanguage,dialogueReportAuditions} from "../../planner/src/dialogue-replacement";
import {narrationTrack,narrationSceneWindows,type NarrationTrack} from "../../planner/src/narration-mix";
import {dialogueBaseline,assertDialogueAuditionInputs,assertDialogueAccess,assertDialogueSourceAvailable} from "../../planner/src/dialogue-jobs";
import {retainAudition,assertAuditionMatchesFilm,assertRetainedAuditionPermission} from "../../planner/src/retained-auditions";
import {assertAudioTimelineWindow,timelineSampleCounts} from "../../planner/src/audio-timeline";
import {audioTimelineRuntimeRevision} from "../../generator/src/audio-timeline";
import {verifyAudioMedia} from "../../generator/src/audio-media";
import {audioTakePlan,assertAudioTakePermission,validateAudioPolicy,type AudioPolicy} from "../../planner/src/audio-jobs";
import {narrationRead,narrationLineSource} from "../../planner/src/narration-read";
import {compileAudioLine,audioRecord,audioNumber,audioVoiceProfile,AUDIO_VOICE_SCHEMA,AUDIO_VOICE_CONTROL_DEFAULTS,AUDIO_VOICE_CONTROL_FIELDS} from "../../planner/src/audio-performances";
import {performanceForScene,scenePerformanceSource} from "../../planner/src/performance-memory";
import {pictureBaseRevision,picturePerformance,picturePerformancePrompt} from "../../planner/src/picture-performance";
import {AZURE_AUDIO_CAPABILITY,AZURE_STYLES} from "../../generator/src/azure-capability";
import {CARTESIA_PHRASE_CAPABILITY,CARTESIA_MULTILINGUAL_CAPABILITY} from "../../generator/src/audio-capabilities";
import {audioLanguage} from "../../generator/src/audio-languages";
import {configuredAudioPolicies} from "../../generator/src/audio-config";
import {PostgresAudioLedger} from "../../storage/src/audio-ledger";
import {PostgresLipSyncLedger} from "../../storage/src/lipsync-ledger";
import {LipSyncApi} from "./lipsync-api";
import {SoundApi} from "./sound-api";
import {AmbienceBusy,handleAmbience} from "./sound-ambience";
import {GraphicApi,graphicJobView} from "./graphic-api";
import {DeliveryApi} from "./delivery-api";
import { projectJobs as jobsForProject } from "./project-jobs";
import {assertDeliveryOffered,assertDeliveryPermission,assertDeliverySourcePermission} from "../../planner/src/delivery-jobs";
import {assertGraphicPermission,validateGraphicOutput} from "../../planner/src/graphic-jobs";
import {EditApi} from "./edit-api";
import {previewBrowserModule} from "./preview-modules";
import {soundBaseDialogue,soundBaseFilm,soundCaptionLanguage} from "../../planner/src/sound-jobs";
import {editCaptionLanguage,editPerformanceReceipts} from "../../planner/src/edit-jobs";
import {editAssemblyCaptionLanguage} from "../../planner/src/edit-assembly-job-context";
import {SOUND_STEMS} from "../../planner/src/sound-session";
import {lipSyncCutaways,emptyLipSyncReviews} from "../../planner/src/lipsync";
import {LipSyncError} from "../../planner/src/lipsync-policy";
import {inspectDialogueSource,verifyRetainedOutputFiles} from "../../generator/src/dialogue-replacement";
import {DialogueSelectionConflict,assertSelectedOutput,outputRevision} from "../../planner/src/dialogue-selection";
import {speechRuntimeRevision} from "../../generator/src/speech";
import {contentHash} from "../../generator/src/capabilities";
import {generationStage,isTakeStage,latestFinishedCut} from "../../planner/src/render-stage";
import {reviewPermission,ReviewCapabilityError} from "./review-capability";
import {ReviewCommentError,ReviewCommentRefused,reviewCommentInput} from "./review-comments";
import {createReusePlan} from "../../planner/src/shot-reuse";
import {assertMotionStudyCurrent} from "../../planner/src/motion-studies";
import {compileWanMovePacketAsync} from "../../generator/src/wan-move-packet";
import {createShotTakes,shotTakeShots,assertTakeCatalog} from "../../planner/src/takes";
import {assertShotCastPermission} from "../../planner/src/dialogue-jobs";
import {frameAnchorRequest} from "../../planner/src/frame-anchors";
import {withAnchorStoryboard} from "../../generator/src/catalog";
import { StudioTelemetry, telemetryFromEnv, failureCode, routeTemplate, type FailureCode } from "../../observability/src/index";
import { StudioLogger, loggerFromEnv, requestMethod, type CrewStep } from "../../observability/src/logs";
import { costReadings, OperatorDiagnostics, readBackupStatus } from "../../observability/src/diagnostics";
import { TelemetryExplorer, JOB_ID, TRACE_ID } from "../../observability/src/explorer";
import { providerKind } from "../../observability/src/provider-kinds";
import { storageDiagnostics } from "../../storage/src/diagnostics";
import { diagnosticsSecret, verifyDiagnosticsToken } from "./operator-token";
import { artifactKey, objectClient, PostgresArtifactStore } from "../../storage/src/artifacts";
import { createHash } from "node:crypto";
import { normalizeReference, referenceBody, ReferenceBlobStore } from "../../storage/src/references";
import { MAX_REFERENCE_ASSETS } from "../../planner/src/references";
import {SoundBlobStore,soundUploadBody} from "../../storage/src/sound-assets";
import {normalizeSoundUpload,soundRuntimeRevision} from "../../generator/src/sound-audio";
import {SoundConflict,SoundRefused,MAX_SOUND_ASSETS,MAX_SOUND_LIBRARY_BYTES,admitSoundText,soundAssetAvailable,updateSoundLibrary} from "../../planner/src/sound-assets";
import { assertSheetDispatch, characterSheetShots, createCharacterSheet, SHEET_SIZE } from "../../planner/src/sheets";
import { ActorShareUnavailable, carriedReferenceLock, copiedActorReferences, importedActor } from "../../planner/src/actor-library";
import { mintActorToken } from "./actor-token";
import {sourceDirection,DEFAULT_DIRECTION,DIRECTION_CHOICES,DIRECTION_MAX_DURATION_SEC,currentDirection,directionEntry,directionMatches,directShots,staleDirections,DirectionConflict} from "../../planner/src/direction";
import {COVERAGE_CHOICES,DEFAULT_COVERAGE,coverageReport} from "../../planner/src/coverage";
import {continuityReport} from "../../planner/src/continuity";
import {CAMERA_PRESETS,DEFAULT_FRAMING,DEFAULT_OPTICS,isCropped} from "../../planner/src/framing";
import { StudioDatabase } from "../../storage/src/database";
import { PostgresProjectService } from "../../storage/src/projects";
import { PostgresJobStore } from "../../storage/src/jobs";
import { PostgresCostLedger } from "../../storage/src/ledger";
import { PostgresCrewLedger, type CrewLedgerReader } from "../../storage/src/crew-ledger";
import { configuredPool, createProviderPlan } from "../../generator/src/catalog";
import { matchCapability, videoRequirements } from "../../generator/src/capabilities";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { parseFountain } from "../../parser/src/index";
import { importFinalDraft } from "../../parser/src/final-draft";
import { PDF_LIMITS, importPdfScreenplay } from "../../parser/src/pdf";
import {lineSources} from "../../planner/src/performances";
import { CastingConflict, castingMatches, castingSnapshot, currentCasting, directCast,charactersForScene,assertCharacterPermission } from "../../planner/src/casting";
import { CapacityController, DOWNLOAD_LINK_TTL_MS, DurableJobStore, TIERS, type Job, type JobStage, type Tier } from "../../queue/src/index";
import { BudgetError, CostLedger } from "../../operator/src/index";
import { ProjectService, type Project, type ReviewDecision } from "./index";
import { RateLimiter, clientAddress, type RateLimitRule } from "./rate-limit";
import { mintArtifactToken, reviewDigest, tokenSecret, verifyOperatorGrant, verifyToken } from "./tokens";

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
  compositeFrames: RateLimitRule;
  trustProxy: boolean;
}

export interface ApiServerOptions {
  audioPolicies?:()=>AudioPolicy[];
  port?: number;
  hostname?: string;
  /** Seconds a socket may stay idle, between requests or mid-response, before Bun closes it (0–255). Defaults to HV_HTTP_IDLE_TIMEOUT_SECONDS or Bun's 10. */
  idleTimeout?: number;
  queuePath?: string;
  artifactRoot?: string;
  frontendOrigin?: string;
  statePath?: string;
  costLedgerPath?: string;
  /** HV-030-01: injected in tests; otherwise from HV_CREW_LEDGER_PATH and HV_CREW_PROVIDER with its key (HV-030-24). `null` forces the stand-in crew. */
  crewLedger?: CrewLedger | CrewLedgerReader;
  crewModel?: CrewModel | null;
  /** HV-024-11: injected in tests (the mock); otherwise from HV_MUSIC_PROVIDER. `null` forces the Composer's own score. */
  musicProvider?: MusicProvider | null;
  /** HV-024-11: injected in tests; otherwise PostgreSQL with a database, else HV_MUSIC_LEDGER_PATH. */
  musicLedger?: MusicLineLedger;
  storage?: "json" | "postgres";
  databaseUrl?: string;
  artifactStorage?: "local" | "s3";
  rateLimit?: Partial<RateLimitOptions>;
  tls?: MutualTlsOptions | null;
  telemetry?: StudioTelemetry;
  /** Structured log sink; defaults to `loggerFromEnv("api", telemetry)`. */
  logger?: StudioLogger;
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

/**
 * The bytes of a base64 PDF, or a refusal in the importer's own voice (HV-016-08).
 *
 * `atob` is lenient about what it accepts and silently produces rubbish for some inputs, so the
 * shape is checked first and the decoded bytes are bounded before the importer sees them.
 */
function decodePdfDocument(document: unknown): Uint8Array {
  if (typeof document !== "string" || !document.trim()) throw new Error("Choose a PDF screenplay to import.");
  const encoded = document.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error("This PDF could not be read. Upload the file again.");
  if (encoded.length / 4 * 3 > PDF_LIMITS.documentBytes) throw new Error("A PDF screenplay must be at most 4 MiB.");
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}

export const DEFAULT_RATE_LIMITS: RateLimitOptions = {
  api: { limit: 120, windowMs: 60_000 },
  projectCreate: { limit: 20, windowMs: 3600_000 },
  artifacts: { limit: 600, windowMs: 60_000 },
  compositeFrames: { limit: 8000, windowMs: 60_000 },
  trustProxy: false,
};

/**
 * Which permission rule guards a job's retained media, by stage.
 *
 * This used to be six `if (mediaJob?.<optionalField>)` blocks on the artifact
 * route. A plain `animatic` or `final` cut carries none of those fields unless
 * one of its shots happens to have dialogue, so its media was served with no
 * permission check at all -- the token signature, the project's existence, its
 * deletion date and takedown, and nothing else. Cast permission is not about
 * dialogue: `assertCurrentCastPermission` is reached for every shot's
 * `characterIds`, and a character named only in a scene's action is in frame
 * just as much as one with a line.
 *
 * A total function over the stage replaces the blocks. Two properties matter
 * more than the shape:
 *
 * 1. **It is total at compile time.** The `never` binding below is a type error
 *    the moment `JobStage` gains a member, so a stage cannot be added without
 *    deciding what guards its media -- the omission that caused this.
 * 2. **It fails closed at run time.** `stage` arrives from persisted JSON and
 *    is cast, not validated (`DurableJobStore.reload`), so a body carrying a
 *    stage this build does not know reaches here. Returning `undefined` for it
 *    would be the original defect one level up: "no rule matched" read as "no
 *    check needed". The fall-through denies instead.
 *
 * Every stage returns a rule; none returns "nothing to check". The two stages
 * answered earlier in the route by their own rules -- a graphic by
 * `assertGraphicPermission` plus its retained bundle, an audio take by take
 * permission plus the voice policy's revision -- return a rule that confirms
 * the field those blocks key on is actually present, so "another check ran" is
 * verified here rather than assumed.
 */
export function artifactPermission(stage: JobStage): (job: Job, project: Parameters<typeof assertSelectedOutput>[1]) => void {
  switch (stage) {
    case "animatic": case "final": case "dialogue-replacement": case "lip-sync":
    case "sound-mix": case "picture-edit": case "assembly-edit":
      return (job, project) => assertSelectedOutput(job, project, {jobId: job.id, outputRevision: outputRevision(job)});
    case "take-preview": case "take-final":
      // A take carries the cast's likeness exactly as a cut does. Its shots
      // come from the take plan rather than from `renderShots`, which refuses a
      // non-film stage outright ("Reuse requires a film render with an admitted
      // provider plan"), so the derivation differs and the permission does not.
      return (job, project) => {
        if (!job.shotTakes || !job.casting || !job.direction) throw new Error("This take group has no retained plan to check permission against.");
        assertShotCastPermission(shotTakeShots(job.shotTakes, job.casting, parseFountain(job.scriptText), job.direction, job.scriptVersion), job, project);
      };
    case "character-sheet":
      // A character sheet is the character's likeness and nothing else.
      // `assertSheetDispatch` is the rule the dispatch path already uses.
      return (job, project) => {
        if (!job.characterSheet || !job.casting) throw new Error("This character sheet has no retained plan to check permission against.");
        if (!project) throw new Error("Current project permission is unavailable.");
        const parsed = parseFountain(job.scriptText), current = currentCasting(project.id, project.castingHistory);
        for (const view of job.characterSheet.views) assertSheetDispatch(job.characterSheet, job.casting, current, view.id, parsed);
      };
    case "motion-graphic":
      return job => { if (!job.graphicRender) throw new Error("A motion-graphic job with no graphic render has no guarded media."); };
    case "audio-take":
      return job => { if (!job.audioTake) throw new Error("An audio-take job with no take has no guarded media."); };
    // A deliverable's permission is the source film's, re-read at dispatch: the plan names the
    // sealed output it was made from, and nothing here is guarded by the deliverable itself.
    case "delivery":
      return job => { if (!job.delivery) throw new Error("A delivery job with no delivery plan has no guarded media."); };
  }
  const unknown: never = stage;
  void unknown;
  return () => { throw new Error("This job's stage has no media permission rule."); };
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function rateLimitsFromEnv(): RateLimitOptions {
  return {
    api: { limit: envInt("HV_RATE_LIMIT_API_PER_MINUTE", DEFAULT_RATE_LIMITS.api.limit), windowMs: 60_000 },
    projectCreate: { limit: envInt("HV_RATE_LIMIT_PROJECTS_PER_HOUR", DEFAULT_RATE_LIMITS.projectCreate.limit), windowMs: 3600_000 },
    artifacts: { limit: envInt("HV_RATE_LIMIT_ARTIFACTS_PER_MINUTE", DEFAULT_RATE_LIMITS.artifacts.limit), windowMs: 60_000 },
    compositeFrames: { limit: envInt("HV_RATE_LIMIT_COMPOSITE_FRAMES_PER_MINUTE", DEFAULT_RATE_LIMITS.compositeFrames.limit), windowMs: 60_000 },
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
  /** Set once the client's certificate chain is trusted. */
  authorized: boolean;
}

const HELD_BYTES_LIMIT = 64 * 1024;
// HV-032-07: once the client is trusted, a request that arrives before the loopback connection opens
// is held up to the edge's own body limit. At 64 KiB a large upload racing the connect (every request
// now opens a fresh connection) was dropped mid-body, and the edge reported "upstream unavailable".
const AUTHORIZED_HELD_BYTES_LIMIT = 64 * 1024 * 1024;

function newRelay(): Relay {
  return { partner: null, outbox: [], held: [], heldBytes: 0, endAfterFlush: false, closed: false, authorized: false };
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
        relay.authorized = true;
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
        if (relay.heldBytes > (relay.authorized ? AUTHORIZED_HELD_BYTES_LIMIT : HELD_BYTES_LIMIT)) {
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

/**
 * The prefixes the creator UI imports its modules from. A panel served at
 * `/api/direction/x.js` resolves its own `./y.js` to `/api/direction/y.js`, so
 * a module shared between panels at different prefixes has to answer at each.
 */
export const BROWSER_MODULE_PREFIXES = ["/api/", "/api/cast/", "/api/direction/"] as const;
/** Modules imported by panels served under more than one of those prefixes. */
export const SHARED_BROWSER_MODULES = ["audio-focus.js", "busy.js", "picture-performance.js", "speech-player.js"] as const;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".wav":"audio/wav",
  ".mp4": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  /** HV-031-15: the C2PA manifest store's registered media type. */
  ".c2pa": "application/c2pa",
};

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

async function jsonBody(request: Request,maxBytes=250_000): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new Error("request body too large");
  const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  if(reader)try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new Error("request body too large");}chunks.push(next.value);}}finally{reader.releaseLock();}
  const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  if(job.audioOutput)return {audioUrl:`/artifacts/${artifactToken}/${job.audioOutput.wavPath}`,manifestUrl:`/artifacts/${artifactToken}/${job.audioOutput.manifestPath}`};
  if (!job.output) return undefined;
  const prefix = `/artifacts/${artifactToken}`;
  return {
    mp4Url: `${prefix}/${job.output.mp4Path}`,
    hlsUrl: `${prefix}/${job.output.hlsPlaylistPath}`,
    captionsUrl: `${prefix}/${job.output.captionsPath}`,
    manifestUrl: `${prefix}/${job.output.manifestPath}`,
    ...(job.output.c2paPath?{c2paUrl:`${prefix}/${job.output.c2paPath}`}:{}),
    ...(job.output.editorial?Object.fromEntries([["deliveryMasterUrl","audio/final.wav"],["timelineUrl","timeline.json"],["conformReportUrl","conform.json"]].map(([key,name])=>[key,`${prefix}/${job.output!.mp4Path.slice(0,-"export.mp4".length)}${name}`])):{}),
    ...(job.output.assembly?Object.fromEntries([["deliveryMasterUrl","audio/final.wav"],["timelineUrl","timeline.json"],["assemblyUrl","assembly.json"],["conformReportUrl","conform.json"]].map(([key,name])=>[key,`${prefix}/${job.output!.mp4Path.slice(0,-"export.mp4".length)}${name}`])):{}),
    ...(job.output.dialogue?{audioUrl:`${prefix}/${job.output.dialogue.wavPath}`} : {}),
    ...(job.output.lipSync?{audioUrl:`${prefix}/${job.output.lipSync.wavPath}`} : {}),
    ...(job.output.sound?.report.restoration?{restorationReportUrl:`${prefix}/${job.output.mp4Path.slice(0,-"export.mp4".length)}restoration/report.json`,...Object.fromEntries(job.output.sound.report.restoration.tracks.flatMap(t=>[[t.settings.track+"OriginalUrl",`${prefix}/${job.output!.mp4Path.slice(0,-"export.mp4".length)}restoration/original/${t.settings.track}.wav`],[t.settings.track+"RemovedUrl",`${prefix}/${job.output!.mp4Path.slice(0,-"export.mp4".length)}restoration/removed/${t.settings.track}.wav`],...(t.settings.reference?[[t.settings.track+"ReferenceUrl",`${prefix}/${job.output!.mp4Path.slice(0,-"export.mp4".length)}restoration/reference/${t.settings.track}.wav`]]:[])]))}:{}),
    ...(job.output.sound?.report.finishing?{deliveryMasterUrl:`${prefix}/${job.output.mp4Path.slice(0,-"export.mp4".length)}finishing/master.wav`,loudnessReportUrl:`${prefix}/${job.output.mp4Path.slice(0,-"export.mp4".length)}finishing/report.json`}:{}),
    ...(job.output.sound?{cueSheetUrl:`${prefix}/${job.output!.mp4Path.slice(0,-"export.mp4".length)}cue-sheet.json`}:{}),
    ...(job.output.sound?Object.fromEntries(SOUND_STEMS.map(stem=>[stem+"StemUrl",`${prefix}/${job.output!.mp4Path.slice(0,-"export.mp4".length)}stems/${stem}.wav`])):{}),
    ...(job.output.dialogue?.report.narration||job.lipSync?.source.dialogue.narration?Object.fromEntries([["mixUrl","mix.wav"],["narrationUrl","narration.wav"],["duckedDialogueUrl","ducked-dialogue.wav"]].map(([key,name])=>[key,`${prefix}/${job.output!.mp4Path.slice(0,-"export.mp4".length)}${name}`])):{}),
    ...(job.output.sheetPath ? {sheetUrl:`${prefix}/${job.output.sheetPath}`} : {}),
  };
}

/**
 * FR-040: the download link is valid for 30 days from completion, capped at
 * the project's retention date because the artifacts are deleted then.
 *
 * HV-029-08: and capped at `until` when there is one. A review link lives seven days and admits a
 * named number of viewers; the media URLs it handed out were minted against the *job's* thirty, so
 * a viewer admitted on a link's last view kept working URLs for twenty-three days after the link
 * itself was spent, and there was no way to withdraw them. The owner's own URLs are unchanged: this
 * cap only applies where the link is what granted the access.
 */
export function artifactLinkExpiry(job: Job, project: Pick<Project, "deleteAfter">, now = Date.now(), until?: number): number {
  const completedAt = job.completedAt ? new Date(job.completedAt).getTime() : now;
  const linkExpiresAt = job.linkExpiresAt ? new Date(job.linkExpiresAt).getTime() : completedAt + DOWNLOAD_LINK_TTL_MS;
  return Math.min(linkExpiresAt, new Date(project.deleteAfter).getTime(), ...(Number.isFinite(until) ? [until!] : []));
}

function signedOutput(job: Job, project: Pick<Project, "deleteAfter">, now = Date.now(), until?: number, review?: string): { output?: Record<string, string>; artifactUrlsExpireAt: string | null; artifactUrlsExpireInSeconds: number | null } {
  if (!job.output&&!job.audioOutput) return { output: undefined, artifactUrlsExpireAt: null, artifactUrlsExpireInSeconds: null };
  const expiresAt = artifactLinkExpiry(job, project, now, until);
  return {
    output: signedArtifactUrls(job, mintArtifactToken(job.projectId, job.id, expiresAt, now, review)),
    artifactUrlsExpireAt: new Date(expiresAt).toISOString(),
    artifactUrlsExpireInSeconds: Math.max(0, Math.floor((expiresAt - now) / 1000)),
  };
}

/**
 * The owner's display of a job, and the one place that mints its artifact links.
 *
 * `permission` is required, not optional. Every display path answers the same
 * question the media path answers -- `mediaPermission` below, built from
 * `artifactPermission(job.stage)` -- so a stage this view forgot cannot be a
 * stage this view serves. An optional parameter would be the defect this
 * increment exists to remove, one call site lower down.
 */
function publicJob(job: Job, project: Pick<Project, "deleteAfter">, permission: (job: Job) => void, now = Date.now()): Record<string, unknown> {
  const { scriptText: _scriptText, casting, direction, executionCheckpoints:_executionCheckpoints,currentFilm:_currentFilm,currentFilmCheckpoint:_currentFilmCheckpoint,currentFilmOrigins:_currentFilmOrigins,currentFilmProof:_currentFilmProof, dialogueReplacement, dialogueCheckpoint:_dialogueCheckpoint,audioTake,audioCheckpoint:_audioCheckpoint,audioOutput,lipSync,lipSyncPrepared:_lipSyncPrepared,lipSyncCheckpoint:_lipSyncCheckpoint,lipSyncReviews,soundMix,soundCheckpoint:_soundCheckpoint,pictureEdit,editCheckpoint:_editCheckpoint,assemblyEdit,assemblyCheckpoint:_assemblyCheckpoint,livingScript, ...rest } = job;
  // Nothing retained, nothing to decide: a queued or failed job carries no
  // media, and refusing it would report a permission problem where there is
  // only an unfinished job. "There is something to withhold" is read off the
  // mint itself rather than restated as a second condition -- a second copy is
  // how one of these two ends up covering a case the other does not, which is
  // the family of defect this increment is closing. The discarded token never
  // leaves this function.
  const minted = signedOutput(job, project, now);
  let mediaUnavailable: string | null = null;
  if (minted.output) {
    try { permission(job); }
    catch (error) { mediaUnavailable = (error as Error).message || "This job's retained media is unavailable."; }
  }
  // Withheld means withheld: the token is dropped, so every link derived from
  // it -- the output map, the per-shot audio, the take clips, the storyboard --
  // is absent rather than present-and-refused.
  const signed = mediaUnavailable ? { output: undefined, artifactUrlsExpireAt: null, artifactUrlsExpireInSeconds: null } : minted;
  const artifactPrefix = signed.output?.mp4Url?.slice(0, signed.output.mp4Url.indexOf(job.output!.mp4Path));
  return { ...rest, ...signed, mediaUnavailable, outputRevision:job.output?outputRevision(job):null,directionVersion:direction?.version??0,directionRevision:direction?.revision??null,castingVersion: casting?.version ?? 0, castingRevision: casting?.revision ?? null,
    ...(livingScript?{livingScript:{proposalId:livingScript.proposal.request.id,proposalRevision:livingScript.proposal.revision,planRevision:livingScript.revision,role:livingScript.request.role,beforeVersion:livingScript.proposal.request.patch.before.version,proposedVersion:livingScript.inputs.scriptVersion,generatedShotIds:livingScript.shotReuse.forceShotIds,reusedShotIds:livingScript.shotReuse.shots.map(record=>record.shotId)}}:{}),
    captionLanguage:assemblyEdit?editAssemblyCaptionLanguage(assemblyEdit):pictureEdit?editCaptionLanguage(pictureEdit):soundMix?soundCaptionLanguage(soundMix.source.base):dialogueReplacement?.plan.dubLanguage??lipSync?.source.dialogue.plan.dubLanguage??"en",
    ...(pictureEdit?{pictureEdit:{sequenceId:pictureEdit.sequence.id,label:pictureEdit.sequence.label,historyRevision:pictureEdit.sequence.history.revision,planRevision:pictureEdit.revision,sourceCount:pictureEdit.bindings.length,review:pictureEdit.review}}:{}),
    ...(assemblyEdit?{assemblyEdit:{assemblyId:assemblyEdit.assembly.id,label:assemblyEdit.assembly.label,assemblyRevision:assemblyEdit.assembly.revision,planRevision:assemblyEdit.revision,parentSequenceId:assemblyEdit.assembly.plan.parent.sequenceId,sourceCount:assemblyEdit.bindings.length,review:assemblyEdit.review}}:{}),
    ...(soundMix?{soundMix:{sourceJobId:soundMix.source.jobId,originalJobId:soundBaseFilm(soundMix.source.base).id,planRevision:soundMix.revision,session:soundMix.session},sound:job.output?.sound?{report:job.output.sound.report}:null}:{}),
    ...(audioTake?{audioTake:{sceneIndex:audioTake.sceneIndex,characterId:audioTake.characterId,source:audioTake.line.source,controls:audioTake.line.profile.controls,voiceLabel:audioTake.policy.label,planRevision:audioTake.revision},audio:audioOutput?{report:audioOutput.report,audioUrl:signed.output?.audioUrl}:null,audioBilling:{state:job.cost?"invoice-allocated":"pending",actualUsd:job.cost?job.costUsd:null}}:{}),
    ...(dialogueReplacement?{dialogueReplacement:{sourceJobId:dialogueReplacement.source.id,baselineJobId:dialogueReplacement.plan.baseline?.jobId??null,planRevision:dialogueReplacement.plan.revision,edits:dialogueReplacement.plan.edits},dialogue:job.output?.dialogue?{report:job.output.dialogue.report,audioUrl:signed.output?.audioUrl}:null}:{}),
    ...(lipSync?{lipSync:{sourceJobId:lipSync.source.jobId,originalJobId:lipSync.source.film.id,shotId:lipSync.shotId,lineIndex:lipSync.lineIndex,character:lipSync.source.dialogue.lines.find(l=>l.shotId===lipSync.shotId&&l.source.index===lipSync.lineIndex)?.source.character,window:lipSync.window,provider:lipSync.policy.label,planRevision:lipSync.revision,passCount:lipSync.source.history.length+1,cutaways:lipSyncCutaways(lipSync.source,lipSync.shotId)},lipSyncReviews:lipSyncReviews??emptyLipSyncReviews()}:{}),
    picturePerformances:job.output?.picturePerformances??[],cameraPathRenders:job.output?.cameraPathRenders??[],frameAnchorRenders:job.output?.frameAnchorRenders??[],
    shotReuse:job.shotReuse?{planned:job.shotReuse.shots.length,forced:job.shotReuse.forceShotIds}:null,
    shotRenders:job.output?.shotRenders?.map(r=>({shotId:r.shotId,inputHash:r.inputHash,sha256:r.files.video.sha256,...(r.clip.speech&&r.files.audio&&artifactPrefix!==undefined?{speech:r.clip.speech,audioUrl:artifactPrefix+r.files.audio.path}:{}),origin:r.origin,reusedFrom:r.reusedFrom??null}))??[],
    takeClips:job.output?.takeClips?.map(clip=>({id:clip.id,label:clip.label,durationSec:clip.durationSec,seed:clip.seed,sha256:clip.sha256,costUsd:clip.costUsd,mode:clip.mode,
      ...(artifactPrefix===undefined?{}:{mp4Url:artifactPrefix+clip.path,hlsUrl:artifactPrefix+clip.hlsPath,posterUrl:artifactPrefix+clip.posterPath,captionsUrl:artifactPrefix+clip.captionsPath,manifestUrl:artifactPrefix+clip.manifestPath,...(clip.c2paPath?{c2paUrl:artifactPrefix+clip.c2paPath}:{})})}))??[],
    storyboard: job.output?.storyboard?.map(frame => ({ shotId: frame.shotId, caption: frame.caption, ...(artifactPrefix===undefined?{}:{url: `${artifactPrefix}${frame.path}`}) })) ?? [] };
}

function projectUrl(frontendOrigin: string, token: string): string {
  return `${frontendOrigin}/#/p/${token}`;
}

function reviewUrl(frontendOrigin: string, token: string): string {
  return `${frontendOrigin}/#/review/${encodeURIComponent(token)}`;
}

export function createApiServer(options: ApiServerOptions = {}): ApiServer {
  tokenSecret();
  // HV-024-13: every budget line is read first, as plain dollars, before anything is opened, so a
  // value the studio cannot compare stops the API here with the setting's name. A monthly cap of
  // "abc" used to read as NaN, which no comparison refuses.
  const monthlyBudgetUsd = monthlyBudgetCap(process.env);
  // HV-030-28: a film is held to the film's limit ($40), or to the feature's own ($150, G20) when it was planned as a feature.
  const filmLimit = filmLimits(process.env, monthlyBudgetUsd), filmCapUsd = filmLimit.filmCapUsd, featureCapUsd = filmLimit.featureCapUsd;
  const filmCap = (project: {format?: string} | null | undefined) => filmCapFor(project, filmLimit);
  // HV-022-08: a voice vendor's own line (G14). It never raises the monthly, per-film or per-shot cap.
  const voiceVendorCapUsd = voiceVendorCap(process.env, monthlyBudgetUsd);
  // HV-024-10: the generated-music line (G15, $10). Read at startup so a nonsense setting stops the
  // API here rather than at the first cue.
  const musicVendorCapUsd = musicVendorCap(process.env, monthlyBudgetUsd);
  const telemetry=options.telemetry ?? telemetryFromEnv("api");
  const logger=options.logger ?? loggerFromEnv("api",telemetry);
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
  const soundBlobs=new SoundBlobStore(artifactRoot,sharedArtifacts?objectClient():undefined);let soundUploads=0;
  let referenceUploads = 0;
  let motionExports=0;
  let dialogueInspections=0;
  const projects = database ? new PostgresProjectService(database) : new ProjectService(statePath);
  const jobs = database ? new PostgresJobStore(database) : new DurableJobStore(queuePath);
  const scopedJobs = (projectId: string) => jobs instanceof PostgresJobStore ? jobs.forProject(projectId) : jobs;
  /**
   * The jobs of one project.
   *
   * `scopedJobs` narrows the *store* on PostgreSQL; on the JSON backend -- the one
   * `docker-compose.yml` runs, and the default for `createApiServer` -- it hands back the shared
   * store, where `all()` is every job in the studio. Thirteen call sites knew that and re-filtered
   * by hand. Two did not. The character-sheet listing served another project's job body to anyone
   * holding the character id, which an actor share hands out on purpose. The audition route counted
   * the whole studio's running jobs as the project's own, so one stranger's film queued every
   * audition in the studio behind it. Both are the same missing line, so the line lives here and
   * `all()` is not called anywhere else in this file (HV-029-06).
   */
  const projectJobs = (projectId: string) => jobsForProject(scopedJobs, projectId);
  const ledger = database ? new PostgresCostLedger(database) : new CostLedger(costLedgerPath);
  // HV-030-01: the crew's own budget line, beside the cost ledger (G13). Live crew only when the operator has entered a key.
  // HV-030-24: whichever vendor HV_CREW_PROVIDER names; a vendor named without its key stops startup here.
  // HV-030-09: the crew's budget line follows the generation ledger into PostgreSQL when there is
  // one. A file lock guards one filesystem; two API processes on two hosts could each miss the same
  // alert, or each raise it. The row lock in `PostgresCrewLedger.record` decides the crossing once.
  const crewLedger = options.crewLedger
    ?? (database ? new PostgresCrewLedger(database) : new CrewLedger(process.env.HV_CREW_LEDGER_PATH ?? join(dirname(costLedgerPath), "crew-ledger.json")));
  const crewModel = options.crewModel === undefined ? crewModelFromEnvironment() : options.crewModel;
  /**
   * HV-030-25: a paid crew answer the studio couldn't use is logged with its step, vendor, metered model,
   * reason code and cost -- never the model's text, the prompt or a key -- so the operator can see why.
   */
  const logUnusableCrewAnswer = (step: CrewStep, result: {unusableReason?: CrewUnusableReason; crewSpend: {usd: number}}, projectId: string) => {
    if (result.unusableReason && crewModel && crewModel.name !== "stand-in")
      logger.warn("crew.answer_unusable", {step, vendor: crewModel.name, model: crewModel.model, reason: result.unusableReason, costUsd: result.crewSpend.usd, projectId});
  };
  const audioPolicies=options.audioPolicies??configuredAudioPolicies,audioLedger=database?new PostgresAudioLedger(database):undefined;
  // HV-022-13: the $5 and $15 warnings on a voice vendor's own line, raised where the crew's are.
  // They were computed by `voiceVendorAlerts` and read by nobody, so the only signal this line ever
  // gave the operator was the hard refusal at $25 -- which is what the warnings exist to precede.
  if(audioLedger)audioLedger.onVendorAlert=alert=>logger.warn("voice.budget_alert",{provider:providerKind(alert.provider),costUsd:alert.committedUsd});
  const lipLedger=database?new PostgresLipSyncLedger(database):undefined;
  const audioPolicyLookup=(id:string)=>audioPolicies().find(p=>p.voiceId===id);
  // A retained audition's voice permission: the cast permission for the line's
  // character, plus the voice policy the take was authorized under still being
  // configured at the revision it named. Defined once, used by the studio view,
  // by every display path through `mediaPermission`, and by the media path.
  const audioTakePermission=(job:Job,project:Project):void=>{
    assertAudioTakePermission(job,{...project,versions:project.versions.history()},Date.now(),false);
    const policy=audioPolicyLookup(job.audioTake!.policy.voiceId);
    if(!policy||validateAudioPolicy(policy,Date.now()).permissionRevision!==job.audioTake!.policy.permissionRevision)throw new Error("This take's voice permission is unavailable. Choose a currently authorized voice for a new audition.");
  };
  // The one question every path asks: what guards this job's retained media?
  // `artifactPermission` answers it from the stage and is total over `JobStage`;
  // an audio take adds its voice policy on top of the cast rule.
  const mediaPermission=(job:Job,project:Project):void=>{
    artifactPermission(job.stage)(job,project);
    if(job.audioTake)audioTakePermission(job,project);
  };
  // A graphic answers its own question, and `graphicJobView` is where that
  // answer and its narrower shape live. It used to be reached only from
  // `audioJobView`, so the project listing serialized a graphic through
  // `publicJob` -- which mints nothing for a `graphicOutput` and therefore
  // never asked -- and handed out its spec and its retained paths for a
  // graphic whose permission had been withdrawn. Delegating here means every
  // display path reaches the same view for it.
  const jobView=(job:Job,project:Project,now=Date.now()):Record<string,unknown>=>
    job.graphicRender?graphicJobView(job,project):publicJob(job,project,seen=>mediaPermission(seen,project),now);
  const audioJobView=async(job:Job,project:Project)=>{
    const view=jobView(job,project);
    const appliedDialogue=job.output?.dialogue?.report??job.lipSync?.source.dialogue??(job.soundMix?soundBaseDialogue(job.soundMix.source.base):undefined);
    const editorialReceipts=job.assemblyEdit?editPerformanceReceipts(job.assemblyEdit):job.pictureEdit?editPerformanceReceipts(job.pictureEdit):undefined;
    if(appliedDialogue||editorialReceipts){
      const sources=new Map([...(appliedDialogue?dialogueReportAuditions(appliedDialogue).flatMap(line=>line.audition?[line.audition.source]:[]):[]),...(editorialReceipts?.auditions??[])].map(source=>[source.jobId,source]));
      view.appliedAuditionBilling=await Promise.all([...sources.values()].map(async source=>{
        const attempt=await audioLedger?.audioAttempt(source.jobId,project.id),matched=attempt?.id===source.output.report.attemptId,invoice=matched?attempt.audio.invoice:undefined;
        return {jobId:source.jobId,voiceLabel:source.take.policy.label,state:invoice?"invoice-allocated":matched?"unreconciled":"unavailable",actualUsd:invoice?.usd??null,heldUsd:invoice?0:matched?source.take.policy.heldUsd:null};
      }));
    }
    if(job.lipSync){const attempt=await lipLedger?.lipSyncAttempt(job.id,project.id),invoice=attempt?.lipSync.invoice,undispatched=attempt?.lipSync.receipt?.dispatched===false||!attempt&&["failed","cancelled"].includes(job.status);
      view.lipSyncBilling={state:invoice?"invoice-allocated":undispatched?"not-incurred":attempt?"unreconciled":"reserved",actualUsd:invoice?.usd??(undispatched?0:null),heldUsd:invoice||undispatched?0:job.lipSync.policy.heldUsd};}
    const retainedPasses=job.soundMix?.source.base.output?.lipSync?.report.history??editorialReceipts?.lipSync;
    if(retainedPasses){
      view.retainedLipSyncBilling=await Promise.all(retainedPasses.map(async pass=>{const attempt=await lipLedger?.lipSyncAttempt(pass.jobId,project.id),matched=attempt?.id===pass.attemptId,invoice=matched?attempt.lipSync.invoice:undefined;
        return {jobId:pass.jobId,state:invoice?"invoice-allocated":matched?"unreconciled":"unavailable",actualUsd:invoice?.usd??null,heldUsd:invoice?0:matched?attempt.estimatedUsd:null};}));}
    if(!job.audioTake)return view;
    const attempt=await audioLedger?.audioAttempt(job.id,project.id),invoice=attempt?.audio.invoice,undispatched=attempt?.audio.outcome?.dispatched===false||!attempt&&["failed","cancelled"].includes(job.status);
    view.audioBilling={state:invoice?"invoice-allocated":undispatched?"not-incurred":attempt?"unreconciled":"reserved",
      actualUsd:invoice?.usd??(undispatched?0:null),heldUsd:invoice||undispatched?0:job.audioTake.policy.heldUsd};
    view.audioTake={...(view.audioTake as object),narration:job.audioTake.narration??null,localization:job.audioTake.line.localization??null,memory:job.audioTake.line.memory??null,settings:{localization:job.audioTake.line.localization??null,voiceId:job.audioTake.policy.voiceId,policyRevision:job.audioTake.policy.revision,controls:job.audioTake.line.profile.controls,
      pronunciations:job.audioTake.line.profile.pronunciations,beforeMs:job.audioTake.line.beforeMs,afterMs:job.audioTake.line.afterMs,notes:job.audioTake.line.notes,alignment:job.audioTake.line.alignment,phrases:job.audioTake.line.phrases??[]}};
    // The studio shows this before a take finishes, so it is computed for a
    // queued audition too -- `publicJob` decides only about retained media.
    let unavailable:string|null=null;
    try{audioTakePermission(job,project);}catch(error){unavailable=(error as Error).message;}
    view.audioUnavailable=unavailable;if(unavailable){delete view.output;if(view.audio)view.audio={...(view.audio as object),audioUrl:undefined};}
    return view;
  };
  // HV-024-11: the music line's ledger and the music provider. Live music only when the operator
  // names the vendor (HV_MUSIC_PROVIDER=elevenlabs) and its key is present; with nothing set there is
  // no provider and the Composer writes its own score. A nonsense setting stops the API here.
  const musicProvider = options.musicProvider === undefined ? musicProviderFromEnvironment(process.env) : options.musicProvider ?? undefined;
  // A cue's hold is also a generation hold: the file store shares this studio's cost ledger, and
  // PostgreSQL admits it into hv_reservations in the same transaction as the line's check.
  const musicLedger = options.musicLedger
    ?? (database ? new PostgresMusicLedger(database) : new MusicLedger(process.env.HV_MUSIC_LEDGER_PATH ?? join(dirname(costLedgerPath), "music-ledger.json"), ledger as CostLedger));
  // The $3 and $7 warnings, raised where the voice line's are, after the cue's hold is committed.
  musicLedger.onAlert ??= alert => logger.warn("music.budget_alert", {provider: providerKind(alert.provider), costUsd: alert.committedUsd});
  const finalStartsFromFrame = () => { try { return configuredPool("final").some(entry => entry.snapshot.frameControls.first && entry.snapshot.frameControlMode === "native"); } catch { return false; } };
  /**
   * HV-030-06: the longest shot the configured final providers can actually render. The shot editor
   * has always offered 1 to 30 s, because the direction contract is provider-agnostic and knows
   * nothing about the pool — but Kling's turbo model renders at most 10, so a duration between them
   * saved cleanly and was refused at admission, by a message naming no number. The editor states
   * this limit and refuses past it; admission still enforces it, and now says what it is.
   */
  const finalDurationLimitSec = () => {
    try {
      const limits = configuredPool("final").map(entry => entry.snapshot.output.durationSec?.[1]).filter((value): value is number => typeof value === "number");
      // The shot contract's own ceiling stands whatever the pool says; a pool that declares nothing
      // (no video adapter configured) leaves the contract's limit rather than inventing a shorter one.
      return limits.length ? Math.min(DIRECTION_MAX_DURATION_SEC, Math.max(...limits)) : DIRECTION_MAX_DURATION_SEC;
    } catch { return DIRECTION_MAX_DURATION_SEC; }
  };
  // A film's holds are its own jobs' reservations only.
  const filmJobIds = async (projectId: string) => new Set((await projectJobs(projectId)).map(job => job.id));
  const lipSyncApi=new LipSyncApi({root:artifactRoot,artifacts,ledger,lipLedger,monthlyBudgetUsd,filmCapUsd,featureCapUsd,store:scopedJobs,view:audioJobView});

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
        // No worker registry on this backend, so circuits stay unreported; cost windows come from the ledger admission uses.
        const [day, week, month] = await Promise.all([ledger.rollup("day"), ledger.rollup("week"), ledger.rollup("month")]);
        const names = [...new Set([...Object.keys(day.byProvider), ...Object.keys(week.byProvider), ...Object.keys(month.byProvider)])];
        const rows = names.map(provider => ({provider, dayUsd: day.byProvider[provider] ?? 0, weekUsd: week.byProvider[provider] ?? 0, monthUsd: month.byProvider[provider] ?? 0, events: null}))
          .sort((a, b) => b.monthUsd - a.monthUsd || a.provider.localeCompare(b.provider));
        return {queue: {queued: all.filter(job => job.status === "queued").length, running: all.filter(job => job.status === "running").length},
          workers: null, providers: null, costs: costReadings(rows),
          budget: {recordedMonthUsd: month.totalUsd, reservedUsd: await ledger.reservedUsd(), monthlyCapUsd: monthlyBudgetUsd}};
      },
    };
    const backupPath = process.env.HV_BACKUP_STATUS_PATH;
    return diagnostics = new OperatorDiagnostics({...probes, telemetry, backend: database ? "postgres" : "json",
      expectedWorkers: Number(process.env.HV_EXPECTED_WORKERS ?? 1), backup: backupPath ? () => readBackupStatus(backupPath) : undefined});
  };
  const capacity = new CapacityController(monthlyBudgetUsd);
  const soundApi=new SoundApi({root:artifactRoot,artifacts,ledger,monthlyBudgetUsd,filmCapUsd,featureCapUsd,capacity,store:scopedJobs,view:audioJobView});
  const graphicApi=new GraphicApi({projects,storage:artifacts?"s3":"local",ledger,monthlyBudgetUsd,filmCapUsd,featureCapUsd,capacity,store:scopedJobs});
  const deliveryApi=new DeliveryApi({projects,storage:artifacts?"s3":"local",ledger,monthlyBudgetUsd,filmCapUsd,featureCapUsd,capacity,store:scopedJobs});
  const editApi=new EditApi({root:artifactRoot,projects,artifacts,ledger,monthlyBudgetUsd,filmCapUsd,featureCapUsd,capacity,store:scopedJobs,view:audioJobView});
  const limits: RateLimitOptions = { ...rateLimitsFromEnv(), ...options.rateLimit };
  const limiter = new RateLimiter(tokenSecret());
  const tls = options.tls === undefined ? mutualTlsFromEnv() : options.tls;

  const corsHeaders: Record<string, string> = {
    "access-control-allow-origin": frontendOrigin,
    "access-control-expose-headers": "content-range, accept-ranges, content-length, x-hv-preview-sha256, x-hv-history-revision, x-hv-source-id, x-hv-source-revision, x-hv-source-frame, x-hv-source-sha256, x-hv-source-width, x-hv-source-height",
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
  // Socket idle bound (seconds). Bun's 10 s default also serves as the transport deadline for
  // slow metadata routes (see the preview media exception below), so it stays the default;
  // operators may tune it (Bun caps at 255 s). Test clients avoid racing this bound by not
  // reusing pooled connections across long pauses rather than by raising it.
  const idleTimeout = Math.min(255, Math.max(0, Math.floor(options.idleTimeout ?? Number(process.env.HV_HTTP_IDLE_TIMEOUT_SECONDS ?? 10))));
  if (!Number.isFinite(idleTimeout)) throw new Error("HV_HTTP_IDLE_TIMEOUT_SECONDS must be a number of seconds between 0 and 255.");
  // One `api.request` line per completed request, inside the http.request span: method, route template,
  // status, duration and a failure code. Never the pathname, headers, bodies or the client address.
  const observed=async(request: Request,handle:()=>Promise<Response>):Promise<Response>=>{
    const started=performance.now();let status=500,code:FailureCode|undefined;
    try {const result=await handle();status=result.status;return result;}
    catch (error) {code=failureCode(error);throw error;}
    finally {logger.info("api.request",{method:requestMethod(request.method),route:routeTemplate(new URL(request.url).pathname),status,durationMs:Math.round(performance.now()-started),outcome:status>=500?"error":"success",code});}
  };
  const app = Bun.serve({
    port: tls ? 0 : port,
    hostname: tls ? "127.0.0.1" : hostname,
    idleTimeout,
    async fetch(request, server) {
      return telemetry.http(request,()=>observed(request,async()=>{
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      const peer = server.requestIP(request)?.address ?? null;
      if (tls && peer !== "127.0.0.1") return response({ error: "forbidden" }, 403);
      const address = clientAddress(request, peer, limits.trustProxy);
      const assemblyPreviewMedia=["GET","OPTIONS"].includes(request.method)&&parts[0]==="api"&&parts[1]==="projects"&&parts[3]==="editorial"&&parts[4]==="assemblies"&&["proposals","accepted"].includes(parts[5]??"")&&parts[7]==="preview"&&(parts.length===12&&parts[9]==="picture"||parts.length===11&&parts[9]==="audio");
      const livingPreviewMedia=["GET","OPTIONS"].includes(request.method)&&parts[0]==="api"&&parts[1]==="projects"&&parts[3]==="editorial"&&parts[4]==="screenplay"&&parts[5]==="proposals"&&parts[7]==="recut-preview"&&parts[9]==="preview"&&(parts.length===14&&parts[11]==="picture"||parts.length===13&&parts[11]==="audio");
      const previewMedia=assemblyPreviewMedia||livingPreviewMedia||["GET","OPTIONS"].includes(request.method)&&parts[0]==="api"&&parts[1]==="projects"&&parts[3]==="editorial"&&["sequences","versions"].includes(parts[4]??"")&&parts[6]==="preview"&&(parts.length===11&&parts[8]==="picture"||parts.length===10&&parts[8]==="audio");
      const compositeFrame=livingPreviewMedia?parts[11]==="picture"&&parts[12]==="timeline-picture":assemblyPreviewMedia?parts[9]==="picture"&&parts[10]==="timeline-picture":previewMedia&&parts[8]==="picture"&&parts[9]==="timeline-picture";
      const originalFrame=["GET","OPTIONS"].includes(request.method)&&parts[0]==="api"&&parts[1]==="projects"&&parts[3]==="editorial"&&parts[4]==="sequences"&&parts[6]==="sources"&&parts[8]==="frames"&&parts.length===10;
      const scope = compositeFrame ? "composite-frames" : parts[0] === "artifacts"||previewMedia||originalFrame ? "artifacts" : "api";
      const verdict = limiter.check(scope, address, scope === "composite-frames" ? limits.compositeFrames : scope === "artifacts" ? limits.artifacts : limits.api);
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
      // Leave time for the preview's own 60-second response lease to finish or abort a
      // delayed packet. Metadata keeps the default socket idle bound and its own deadlines.
      if(request.method==="GET"&&(previewMedia||originalFrame))server.timeout(request,65);

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders,
            "access-control-allow-headers": "authorization, content-type, range, x-hv-cast-version, x-hv-reference-attested, x-hv-review-viewer, x-hv-direction-version, x-hv-script-version, x-hv-source-hash, x-hv-sound-record",
            "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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
        if(request.method==="GET"&&["/api/cast/performances.js","/api/direction/performances.js","/api/direction/dialogue-replacement.js","/api/direction/narration-editor.js","/api/direction/app.js","/api/direction/coverage.js","/api/direction/scene-cuts.js","/api/direction/continuity.js","/api/direction/viewfinder.js","/api/direction/camera-path.js","/api/direction/frame-anchors.js","/api/direction/takes.js","/api/direction/take-player.js","/api/direction/subject-motion.js"].includes(url.pathname))return new Response(Bun.file(new URL("../../frontend/src/"+(url.pathname.endsWith("app.js")?"direction.js":url.pathname.split("/").at(-1)),import.meta.url)),{headers:{...corsHeaders,"content-type":"text/javascript; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
        // Modules imported by panels served under more than one prefix. One list,
        // because three near-identical route lines is three chances to forget the
        // prefix a new shared module needs; packages/api/test/frontend-modules.test.ts
        // walks the served responses and fails on any import that is not served.
        if(request.method==="GET"&&SHARED_BROWSER_MODULES.some(name=>BROWSER_MODULE_PREFIXES.some(prefix=>url.pathname===prefix+name)))
          return new Response(Bun.file(new URL("../../frontend/src/"+url.pathname.split("/").at(-1),import.meta.url)),{headers:{...corsHeaders,"content-type":"text/javascript; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
        if(request.method==="GET"&&["/api/preview-controller.js","/api/preview-worklet.js","/api/mask-editor.js","/api/mask-source.js","/api/mask-draft.js","/api/mask-viewport.js","/api/edit-script.js","/api/edit-assemblies.js","/api/edit-assembly-preview.js","/api/living-script.js"].includes(url.pathname))return new Response(await previewBrowserModule(url.pathname),{headers:{...corsHeaders,"content-type":"text/javascript; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
        if(request.method==="GET"&&["/api/graphic-studio.js","/api/audio-studio.js","/api/sound-studio.js","/api/editorial.js","/api/preview-comparison.js","/api/review-notes.js","/api/color-grade.js","/api/line-notes.js"].includes(url.pathname))return new Response(Bun.file(new URL("../../frontend/src/"+url.pathname.split("/").at(-1),import.meta.url)),{headers:{...corsHeaders,"content-type":"text/javascript; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
        if(request.method==="GET"&&url.pathname==="/api/audio-phrases.js")return new Response(Bun.file(new URL("../../frontend/src/audio-phrases.js",import.meta.url)),{headers:{...corsHeaders,"content-type":"text/javascript; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
        // HV-030-03: the studio front door.
        if (request.method === "GET" && ["/api/studio/app.js", "/api/studio/score.js", "/api/studio/titles.js"].includes(url.pathname))
          return new Response(Bun.file(new URL("../../frontend/src/" + (url.pathname.endsWith("app.js") ? "studio.js" : url.pathname.split("/").at(-1)), import.meta.url)), {headers: {...corsHeaders, "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff"}});
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
          // This response carries the project's own bearer token (HV-029-08).
          return response({ ...created, projectUrl: projectUrl(frontendOrigin, created.token) }, 201, {"cache-control": "private, no-store"});
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts.length === 3 && request.method === "GET") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const { token, project } = authorized;
          const latest = project.versions.latest();
          const selected=project.dialogueSelections.entries.at(-1);let dialogueExport:{job?:ReturnType<typeof publicJob>;error?:string}|null=null;
          if(selected){try{const job=await scopedJobs(project.id).get(selected.jobId);assertSelectedOutput(job,project,{jobId:selected.jobId,outputRevision:selected.outputRevision});dialogueExport={job:jobView(job,project)};}catch(error){dialogueExport={error:error instanceof Error?error.message:"The selected export is unavailable."};}}
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
            dialogueSelections:project.dialogueSelections,
            dialogueExport,
            jobs: (await projectJobs(project.id)).map((job) => jobView(job, project)),
          });
        }

        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="dialogue-selection"&&parts.length===4&&request.method==="PUT"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized)return response({error:"unauthorized"},401);
          const body=await jsonBody(request),{project,token}=authorized;
          if(Object.keys(body).sort().join(",")!=="expectedOutputRevision,expectedVersion,jobId,sourceJobId"||typeof body.jobId!=="string"||typeof body.sourceJobId!=="string"||typeof body.expectedOutputRevision!=="string"||!Number.isSafeInteger(body.expectedVersion))return response({error:"Choose a retained version using its current selection revision."},400);
          let job=await scopedJobs(project.id).get(body.jobId);if(!job||job.projectId!==project.id)return response({error:"not found"},404);
          assertSelectedOutput(job,project,{jobId:job.id,outputRevision:body.expectedOutputRevision});
          if(!artifacts){await verifyRetainedOutputFiles(job,artifactRoot);job=(await scopedJobs(project.id).get(job.id))!;}
          const selection=await projects.selectDialogueVersion(token,job,body.sourceJobId,body.expectedVersion as number,body.expectedOutputRevision);
          if(!selection)return response({error:"unauthorized"},401);
          return response({dialogueSelections:selection,job:jobView(job,project)},200,{"cache-control":"private, no-store"});
        }
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="takes"&&((request.method==="GET"&&parts.length===4)||(request.method==="POST"&&parts.length===6&&parts[5]==="adopt"))){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const {project,token}=authorized,headers={"cache-control":"private, no-store"};
          if(request.method==="GET"){
            const shotId=url.searchParams.get("shotId"),groups=(await projectJobs(project.id)).filter(job=>isTakeStage(job.stage)&&job.shotTakes&&(!shotId||job.shotTakes.source.id===shotId)).slice(-20).reverse();
            return response({groups:groups.map(job=>jobView(job,project)),scriptVersion:project.versions.latest()?.version??0,castingVersion:currentCasting(project.id,project.castingHistory).version,directionVersion:currentDirection(project.id,project.directionHistory).version},200,headers);
          }
          const body=await jsonBody(request),job=await scopedJobs(project.id).get(parts[4]!);
          if(!job||job.projectId!==project.id||!isTakeStage(job.stage)||job.status!=="done"||!job.shotTakes||!job.output?.takeClips?.some(t=>t.id===body.takeId))return response({error:"Choose a completed take from this project."},404,headers);
          const direction=await projects.adoptShotTake(token,job.shotTakes,body.takeId as string,body.expectedDirectionVersion as number,body.expectedScriptVersion as number);
          return direction?response({direction},200,headers):response({error:"unauthorized"},401,headers);
        }
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="direction") {
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const {project,token}=authorized,headers={"cache-control":"private, no-store"};
          // HV-021-02: the Continuity Supervisor's one repair. Reviewing it changes nothing; accepting
          // it applies only the edits the creator was shown, recomputed here rather than trusted.
          if(parts[4]==="continuity"&&parts[5]==="repair"&&request.method==="POST"){
            const body=await jsonBody(request),maxShots=body.maxShots===60?60:24;
            if(parts.length===6){const result=await projects.reviewContinuityRepair(token,maxShots);return result?response(result,200,headers):response({error:"unauthorized"},401,headers);}
            if(parts.length===7&&parts[6]==="accept"){
              const direction=await projects.acceptContinuityRepair(token,body.edits,body.expectedVersion as number,body.expectedScriptVersion as number,maxShots);
              return direction?response({direction},200,headers):response({error:"unauthorized"},401,headers);
            }
            return response({error:"not found"},404,headers);
          }
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
            const pictureParsed=parseFountain(script?.text??"");
            const pictureView=(shot:import("../../planner/src/index").Shot)=>{const scene=pictureParsed.scenes[shot.sceneIndex]!,characters=charactersForScene(cast,shot.sceneIndex,pictureParsed);let picturePrompt="",pictureError="";
              try{const resolved=picturePerformance(characters,scene,direction.entries.find(e=>e.source.id===shot.id)?.settings.picture);picturePrompt=resolved?picturePerformancePrompt(resolved):"";}catch(error){pictureError=(error as Error).message;}
              return {picturePrompt,pictureError,pictureCharacters:characters.map(c=>{const memory=c.scenePerformances?.find(p=>p.sceneNumber===scene.index+1);return {id:c.id,name:c.name,baseRevision:pictureBaseRevision(c,scene),sceneControls:memory?.picture??{},sceneStale:Boolean(memory&&memory.sourceHash!==scenePerformanceSource(scene))};})};};
            const desired=new Map(shots.map(shot=>[shot.id,directionEntry(shot,DEFAULT_DIRECTION).sourceHash]));
            for(const job of (await projectJobs(project.id)).reverse()){
              if(job.stage!=="animatic"||job.status!=="done"||!job.output||artifactLinkExpiry(job,project)<=Date.now()||!castingMatches(job.casting,cast))continue;
              const planned=new Map(filmPlan(parseFountain(job.scriptText),job.direction,TIERS[job.tier].maxShots,job.sequence).map(shot=>[shot.id,directionEntry(shot,DEFAULT_DIRECTION).sourceHash]));
              for(const frame of job.output.storyboard??[]){if(sources.has(frame.shotId)||!desired.has(frame.shotId)||desired.get(frame.shotId)!==planned.get(frame.shotId))continue;
                const oldSettings=job.direction?.entries.find(entry=>entry.source.id===frame.shotId)?.settings,path=frame.sourcePath??(!oldSettings?.cameraPath&&!isCropped(oldSettings?.framing)?frame.path:undefined);if(!path)continue;
                // A mint is a mint: `castingMatches` compares a snapshot's
                // revision, which a grant that lapses by time does not change,
                // so this asked whether the cast was the same rather than
                // whether it is still permitted.
                try{mediaPermission(job,project);}catch{continue;}
                const signed=signedOutput(job,project).output!,prefix=signed.mp4Url!.slice(0,signed.mp4Url!.indexOf(job.output.mp4Path));
                sources.set(frame.shotId,{shotId:frame.shotId,jobId:job.id,directionVersion:job.direction?.version??0,url:prefix+path});}
              if(sources.size===shots.length)break;
            }
            return response({direction,scriptVersion:script?.version??0,castingRevision:cast.revision,maxShots,scenes:parseFountain(script?.text??"").scenes.map(s=>({index:s.index,heading:s.heading})),defaults:DEFAULT_DIRECTION,choices:DIRECTION_CHOICES,durationLimitSec:finalDurationLimitSec(),coverage:coverageReport(shots,direction),continuity:continuityReport(shots,cast,direction,pictureParsed),staleSceneIndices:staleSceneCuts(parseFountain(script?.text??""),direction).map(c=>c.source.sceneIndex),coverageDefaults:DEFAULT_COVERAGE,coverageChoices:COVERAGE_CHOICES,
              viewfinderSources:[...sources.values()],framingDefaults:DEFAULT_FRAMING,opticsDefaults:DEFAULT_OPTICS,cameraPresets:CAMERA_PRESETS,
              anchorAssets:project.referenceAssets.filter(asset=>asset.source?.kind==="shot-anchor"),
              motionPlans:project.motionStudies.studies.map(s=>({shotId:s.source.id,revision:s.revision,maxShots:s.maxShots})),
              plan:shots.map(shot=>({...directionEntry(shot,sourceDirection(shot)),durationSec:shot.durationSec,performanceLines:lineSources(shot.dialogue),...pictureView(shot)})),staleShotIds:staleDirections(shots,direction).map(entry=>entry.source.id),
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
        // HV-024-11: the Composer asks for a generated cue. The prompt meets the safety gate, the hold
        // is reserved against the music line, and the cue lands in the film's sound library -- or the
        // studio says plainly that it has no music vendor and the Composer's own score is used.
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="music-cues"&&parts.length===4&&request.method==="POST"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized)return response({error:"unauthorized"},401);const {project,token}=authorized,headers={"cache-control":"private, no-store"};
          const body=await jsonBody(request) as Record<string,unknown>;if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!["idempotencyKey","prompt","durationSec","seed"].includes(key)))throw new MusicCueError("Ask for a cue with a request key, a prompt, a length in whole seconds and, if you like, a seed.");
          if(!musicProvider)return response({error:musicStatus(undefined).note,music:musicStatus(undefined)},409,headers);
          // Everything that would stop the cue being kept is asked before anything is reserved.
          if(!project.rightsAttestedAt)throw new Error("Confirm project rights before adding music.");
          if(project.soundLibrary.assets.length>=MAX_SOUND_ASSETS)throw new Error("This project has reached its retained sound limit.");
          if(soundUploads>=1)return response({error:"A recording is being processed. Try again shortly."},429,headers);
          soundUploads++;try{
            const result=await generateMusicCue({provider:musicProvider,ledger:musicLedger,capUsd:musicVendorCapUsd,monthlyCapUsd:monthlyBudgetUsd,filmCapUsd:filmCap(project),filmJobIds:()=>filmJobIds(project.id),keep:async(delivery,label,rights)=>{
              const current=await projects.authorize(token);if(!current?.rightsAttestedAt)throw new DirectionConflict("Project permission changed while the cue was made.");
              const version=current.soundLibrary.version,access=async()=>{const now=await projects.authorize(token);if(!now?.rightsAttestedAt||now.soundLibrary.version!==version)throw new DirectionConflict("Project permission or the sound library changed while the cue was kept.");};
              const normalized=await normalizeSoundUpload(delivery.wav,project.id,label,rights,artifactRoot,access,request.signal);
              updateSoundLibrary(current.soundLibrary,project.id,version,normalized.asset);await soundBlobs.put(normalized.asset,"original",delivery.wav);await soundBlobs.put(normalized.asset,"audio",normalized.audio);await access();
              const saved=await projects.saveSoundAsset(token,normalized.asset,version);if(!saved)throw new Error("unauthorized");return normalized.asset.id;
            }},{projectId:project.id,idempotencyKey:body.idempotencyKey,prompt:body.prompt,durationSec:body.durationSec,seed:body.seed},request.signal);
            const library=(await projects.authorize(token))?.soundLibrary,asset=library?.assets.find(value=>value.id===result.assetId);
            if(!asset)return response({error:"This cue's recording is no longer in the sound library."},409,headers);
            return response({asset,library,credit:result.credit,replay:result.replay,cue:{id:result.cue.id,provider:result.cue.provider,model:result.cue.model,status:result.cue.status,heldUsd:result.cue.heldUsd,actualUsd:result.cue.actualUsd}},result.replay?200:201,headers);
          }finally{soundUploads--;}
        }
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="sounds"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized)return response({error:"unauthorized"},401);const {project,token}=authorized,library=project.soundLibrary,headers={"cache-control":"private, no-store"};
          if(parts.length===4&&request.method==="GET")return response({library,maxAssets:MAX_SOUND_ASSETS,maxLibraryBytes:MAX_SOUND_LIBRARY_BYTES,engineVersion:soundRuntimeRevision(),music:musicStatus(musicProvider)},200,headers);
          if(parts.length===4&&request.method==="POST"){
            const encoded=request.headers.get("x-hv-sound-record");if(!encoded||encoded.length>20000)throw new Error("Include the sound label, source, rights and expected library version.");
            const record=audioRecord(JSON.parse(decodeURIComponent(encoded)),["label","rights","expectedVersion"]);admitSoundText(record.label,record.rights);
            if(!project.rightsAttestedAt)throw new Error("Confirm project rights before importing a recording.");if(record.expectedVersion!==library.version)throw new DirectionConflict("The sound library changed. Reload before importing.");
            if(library.assets.length>=MAX_SOUND_ASSETS)throw new Error("This project has reached its retained sound limit.");if(soundUploads>=1)return response({error:"A recording is being processed. Try again shortly."},429,headers);
            soundUploads++;try{
              const access=async()=>{const current=await projects.authorize(token);if(!current?.rightsAttestedAt||current.soundLibrary.version!==record.expectedVersion)throw new DirectionConflict("Project permission or the sound library changed during import.");};
              const original=await soundUploadBody(request),normalized=await normalizeSoundUpload(original,project.id,record.label as string,record.rights,artifactRoot,access,request.signal);
              updateSoundLibrary(library,project.id,record.expectedVersion as number,normalized.asset);await soundBlobs.put(normalized.asset,"original",original);await soundBlobs.put(normalized.asset,"audio",normalized.audio);await access();
              const saved=await projects.saveSoundAsset(token,normalized.asset,record.expectedVersion as number);return saved?response({asset:normalized.asset,library:saved},201,headers):response({error:"unauthorized"},401,headers);
            }finally{soundUploads--;}
          }
          const asset=library.assets.find(a=>a.id===parts[4]);if(!asset)return response({error:"Sound not found."},404,headers);
          if(parts.length===5&&request.method==="PUT"){const body=audioRecord(await jsonBody(request),["available","expectedVersion"]),saved=await projects.saveSoundAsset(token,{assetId:asset.id,available:body.available as boolean},body.expectedVersion as number);return saved?response({library:saved},200,headers):response({error:"unauthorized"},401,headers);}
          if(parts.length===6&&["original","audio"].includes(parts[5]!)&&request.method==="GET"){
            if(!project.rightsAttestedAt||!soundAssetAvailable(library,asset))return response({error:"This sound's use is disabled."},403,headers);
            const bytes=await soundBlobs.read(asset,parts[5] as "original"|"audio"),current=await projects.authorize(token);if(!current?.rightsAttestedAt||!soundAssetAvailable(current.soundLibrary,asset))return response({error:"Sound permission changed."},403,headers);
            return new Response(new Uint8Array(bytes),{headers:{...corsHeaders,...headers,"content-type":"audio/wav","content-length":String(bytes.length),"x-content-type-options":"nosniff","content-disposition":"inline; filename=sound.wav","content-security-policy":"default-src 'none'; sandbox"}});
          }
          return response({error:"Unknown sound library route."},404,headers);
        }
        const takeQuote=parts.length===5&&parts[0]==="api"&&parts[1]==="projects"&&Boolean(parts[2])&&parts[3]==="takes"&&parts[4]==="quote";
        const takeSubmission=takeQuote||(parts.length===4&&parts[0]==="api"&&parts[1]==="projects"&&Boolean(parts[2])&&parts[3]==="takes");
        const sheetSubmission = parts[0]==="api" && parts[1]==="projects" && parts[3]==="cast" && parts.length===6 && parts[5]==="sheets" && request.method==="POST";
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "cast" && !sheetSubmission) {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized || Date.parse(authorized.project.deleteAfter) <= Date.now()) return response({error: "unauthorized"}, 401);
          const {project, token} = authorized;
          const headers = {"cache-control": "private, no-store"};
          if(parts.length===6&&parts[5]==="scene-performance"&&request.method==="PUT"){
            const {expectedVersion,...input}=audioRecord(await jsonBody(request),["expectedVersion","expectedScriptVersion","sceneNumber","sourceHash","notes","controls","picture","nativeVoice","remove"]);
            const casting=await projects.saveScenePerformance(token,parts[4]!,input,expectedVersion as number);
            return casting?response({casting},200,headers):response({error:"unauthorized"},401);
          }
          if(parts.length===6&&parts[5]==="audio-voice"&&request.method==="PUT"){
            const body=audioRecord(await jsonBody(request),["expectedVersion","voiceId","policyRevision","controls","pronunciations","clear"]);
            let profile=null;
            if(body.clear===true){if(Object.keys(body).some(k=>!["expectedVersion","clear"].includes(k)))throw new Error("Clear the voice assignment without replacement settings.");}
            else{
              const policy=typeof body.voiceId==="string"?audioPolicyLookup(body.voiceId):undefined;
              if(!policy||validateAudioPolicy(policy,Date.now()).revision!==body.policyRevision)throw new CastingConflict("The voice catalogue or price changed. Reload before saving its assignment.");
              profile=audioVoiceProfile({schema:AUDIO_VOICE_SCHEMA[policy.provider as keyof typeof AUDIO_VOICE_SCHEMA]??"hv-audio-voice/1",provider:policy.provider,language:"en",voice:{id:policy.voiceId,catalogueRevision:policy.catalogueRevision,permissionRevision:policy.permissionRevision},
                controls:body.controls,pronunciations:body.pronunciations??[]});
            }
            const casting=await projects.saveCharacterAudioVoice(token,parts[4]!,profile,body.expectedVersion as number);
            return casting?response({casting},200,headers):response({error:"unauthorized"},401);
          }
          if(parts.length===6 && parts[5]==="shares" && request.method==="GET") {
            return response({shares:project.actorShares.filter(share=>share.character.id===parts[4]).map(share=>({id:share.id,revision:share.revision,createdAt:share.createdAt,expiresAt:share.expiresAt,
              revokedAt:share.revokedAt,name:share.character.name,...(!share.revokedAt && Date.parse(share.expiresAt)>Date.now()?{token:mintActorToken(share)}:{})}))},200,headers);
          }
          if(parts.length===6 && parts[5]==="sheets" && request.method==="GET") {
            const jobs=(await projectJobs(project.id)).filter(job=>job.stage==="character-sheet" && job.characterSheet?.characterId===parts[4]).slice(-10).reverse();
            return response({jobs:jobs.map(job=>jobView(job,project))},200,headers);
          }
          if (parts.length === 4 && request.method === "GET") {
            const casting = currentCasting(project.id, project.castingHistory);
            const parsed = parseFountain(project.versions.latest()?.text ?? "");
            return response({casting,scriptVersion:project.versions.latest()?.version??0, history: project.castingHistory.map(value => ({version: value.version, createdAt: value.createdAt, characters: value.characters.length})),
              sceneHeadings: parsed.scenes.map(scene => ({number: scene.index + 1, heading: scene.heading})),
              suggestedNames: [...new Set(parsed.scenes.flatMap(scene => scene.dialogue.map(value => value.character)))].slice(0, 24)}, 200, headers);
          }
          if (parts.length === 6 && parts[5] === "references" && request.method === "POST") {
            if (request.headers.get("x-hv-reference-attested") !== "true") return response({error:"Confirm you may use this image of this cast member for generation: your original character, yourself, or a person who gave you permission."},400);
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
          let casting,lookNote:string|undefined;
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
            // HV-017-15: a creator's locked look comes across whole or not at all, and "not at all" is said.
            lookNote=carriedReferenceLock(share.character.referenceLock,assets).note;
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
          // HV-017-09: the look this character renders with, locked to images it already retains.
          else if (parts.length === 6 && parts[5] === "reference-lock" && request.method === "PUT")
            casting = await projects.saveCharacterReferenceLock(token,parts[4]!,body.lock===null?null:body.lock,expectedVersion);
          else return response({error: "not found"}, 404);
          if (!casting) return response({error: "unauthorized"}, 401);
          return response({casting,...(lookNote?{lookNote}:{})}, 200, headers);
        }

        // HV-016-01: a Final Draft script is converted and shown back, never committed on the writer's
        // behalf. What an importer could not carry across is the writer's to see before they save it.
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "script" && parts[4] === "import" && parts.length === 5 && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          // HV-016-03: the neighbouring project routes all refuse a project past its deletion date;
          // this one did not, so an expiring project could still be asked to read a 4 MiB file.
          if (!authorized || Date.parse(authorized.project.deleteAfter) <= Date.now()) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request, 8 * 1024 ** 2);
          if (body.format !== "final-draft" && body.format !== "pdf") return response({ error: "Choose a supported screenplay format to import." }, 400);
          // HV-016-08: a PDF is bytes, so it arrives base64 in the same JSON body under the same
          // limit. Base64 is four characters per three bytes, so the importer's own 4 MiB bound is
          // what refuses an oversized one; this only refuses what is not base64 at all.
          const imported = body.format === "pdf" ? importPdfScreenplay(decodePdfDocument(body.document)) : importFinalDraft(body.document);
          const parsed = parseFountain(imported.text);
          if (parsed.rejected || parsed.scenes.length === 0)
            return response({ error: parsed.rejectionReason ?? "screenplay contains no parseable scenes", notes: imported.notes, warnings: parsed.warnings }, 422);
          return response({ ...imported, scenes: parsed.scenes.length, warnings: parsed.warnings });
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

        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="sound-mixes"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized)return response({error:"unauthorized"},401);
          const result=await soundApi.handle(parts.slice(4),request,authorized.project,async()=>await projects.authorize(authorized.token),request.method==="GET"?undefined:await jsonBody(request));return response(result.body,result.status,{"cache-control":"private, no-store"});
        }
        // HV-024-12: the studio's own ambience beds for a cut's scenes, saved to the sound library at no cost.
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="ambience"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized)return response({error:"unauthorized"},401);
          let result;try{result=await handleAmbience({root:artifactRoot,job:async(projectId,jobId)=>scopedJobs(projectId).get(jobId),authorize:async token=>projects.authorize(token),saveAsset:async(token,asset,version)=>projects.saveSoundAsset(token,asset,version),
            putBlob:async(asset,kind,bytes)=>{await soundBlobs.put(asset,kind,bytes);},acquire:()=>soundUploads>=1?false:(soundUploads++,true),release:()=>{soundUploads--;}},parts.slice(4),request,authorized.project,authorized.token,request.method==="GET"?undefined:await jsonBody(request));}
          catch(error){if(error instanceof AmbienceBusy)return response({error:error.message},429,{"cache-control":"private, no-store"});throw error;}
          return response(result.body,result.status,{"cache-control":"private, no-store"});
        }
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="graphics"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized)return response({error:"unauthorized"},401);
          const result=await graphicApi.handle(parts.slice(4),request,authorized.project,authorized.token,async()=>projects.authorize(authorized.token),request.method==="GET"?undefined:await jsonBody(request));return response(result.body,result.status,{"cache-control":"private, no-store"});
        }
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="deliveries"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const result=await deliveryApi.handle(parts.slice(4),request,authorized.project,authorized.token,async()=>projects.authorize(authorized.token),request.method==="GET"?undefined:await jsonBody(request));
          return response(result.body,result.status,{"cache-control":"private, no-store"});
        }
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="editorial"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const result=await editApi.handle(parts.slice(4),request,authorized.project,authorized.token,async()=>await projects.authorize(authorized.token),["GET","DELETE"].includes(request.method)?undefined:await jsonBody(request,parts[4]==="screenplay"?8*1024**2:250_000));if(result instanceof Response){const headers=new Headers(result.headers);for(const [key,value]of Object.entries(corsHeaders))headers.set(key,value);return new Response(result.body,{status:result.status,headers});}return response(result.body,result.status,{"cache-control":"private, no-store"});
        }
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="lip-sync"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const result=await lipSyncApi.handle(parts.slice(4),request,authorized.project,async()=>await projects.authorize(authorized.token),request.method==="GET"?undefined:await jsonBody(request));
          return response(result.body,result.status,{"cache-control":"private, no-store"});
        }
        if(request.method==="GET"&&url.pathname==="/api/lipsync.js")return new Response(Bun.file(new URL("../../frontend/src/lipsync.js",import.meta.url)),{headers:{...corsHeaders,"content-type":"text/javascript; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="audio-takes"&&parts[4]==="narration-source"&&parts.length===5&&request.method==="POST"){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const {project}=authorized,body=audioRecord(await jsonBody(request),["characterId","sceneIndex","expectedScriptVersion","narration"]),script=project.versions.latest(),cast=currentCasting(project.id,project.castingHistory);
          if(!script||body.expectedScriptVersion!==script.version)throw new DirectionConflict("The screenplay changed. Reload the narration scene before reviewing its text.");
          const sceneIndex=audioNumber(body.sceneIndex,0,999,"Narration scene",true),scene=parseFountain(script.text).scenes[sceneIndex],character=cast.characters.find(c=>c.id===body.characterId);
          if(!scene||!character)throw new DirectionConflict("Choose a current narration scene and saved character.");
          const memory=performanceForScene(character,scene);assertCharacterPermission(character,sceneIndex+1);
          if(character.permission.scope==="scenes"&&character.sceneBindings.find(b=>b.sceneNumber===sceneIndex+1)?.heading!==scene.heading)throw new DirectionConflict("This scene changed. Review and save the narrator permission again.");
          const narration=narrationRead(body.narration);return response({sceneIndex,source:narrationLineSource(narration,character.name),characterId:character.id,memory:memory??null,performanceRevision:memory?.revision??null,narration},200,{"cache-control":"private, no-store"});
        }
        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="audio-takes"&&parts.length===4&&["GET","POST"].includes(request.method)){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const {project}=authorized,script=project.versions.latest(),cast=currentCasting(project.id,project.castingHistory),all=await projectJobs(project.id);
          if(request.method==="GET"){
            const policies=audioPolicies().filter(p=>{try{validateAudioPolicy(p,Date.now());return true;}catch{return false;}});
            const lines=script?parseFountain(script.text).scenes.flatMap((scene,sceneIndex)=>lineSources(scene.dialogue).map(source=>{
              const character=cast.characters.find(c=>[c.name,...c.aliases].some(n=>n.toLocaleUpperCase("en-US")===source.character.toLocaleUpperCase("en-US")));let unavailable:string|null=null;
              try{if(!character)throw new Error("Save this screenplay character in the cast editor.");performanceForScene(character,scene);assertCharacterPermission(character,sceneIndex+1);
                if(character.permission.scope==="scenes"&&character.sceneBindings.find(b=>b.sceneNumber===sceneIndex+1)?.heading!==scene.heading)throw new Error("This scene changed. Review and save the character permission again.");}
              catch(error){unavailable=(error as Error).message;}
              const memory=character?.scenePerformances?.find(p=>p.sceneNumber===sceneIndex+1)??null;
              return {sceneIndex,heading:scene.heading,source,characterId:character?.id??null,unavailable,memory,performanceRevision:memory?.revision??null};
            })):[];
            return response({enabled:Boolean(audioLedger&&policies.length),scriptVersion:script?.version??0,castingVersion:cast.version,lines,sceneNativeStyles:AZURE_STYLES,phraseCapabilityRevision:CARTESIA_PHRASE_CAPABILITY.revision,nativeCapabilityRevision:AZURE_AUDIO_CAPABILITY.revision,multilingualCapabilityRevision:CARTESIA_MULTILINGUAL_CAPABILITY.revision,
              scenes:script?parseFountain(script.text).scenes.map(s=>({sceneNumber:s.index+1,heading:s.heading,sourceHash:scenePerformanceSource(s),text:(s.beats??[]).map(b=>b.kind==="dialogue"?b.character+"\n"+b.lines.join("\n"):b.text).join("\n\n")})):[],
              characters:cast.characters.map(c=>{const policy=c.audioVoice&&policies.find(p=>p.voiceId===c.audioVoice!.voice.id&&p.permissionRevision===c.audioVoice!.voice.permissionRevision&&p.catalogueRevision===c.audioVoice!.voice.catalogueRevision);
                return {id:c.id,name:c.name,scenePerformances:c.scenePerformances??[],profile:c.audioVoice??null,profileRevision:contentHash(c.audioVoice??null),voiceAvailable:Boolean(policy),voiceLabel:policy?.label??null};}),
              voices:policies.map(p=>({id:p.voiceId,label:p.label,provider:p.provider,dubLanguages:p.languages??[],styles:p.provider==="azure"?AZURE_STYLES:undefined,capabilityRevision:p.provider==="azure"?AZURE_AUDIO_CAPABILITY.revision:undefined,policyRevision:p.revision,heldUsd:p.heldUsd,maxCharacters:p.maxCharacters,expiresAt:p.expiresAt})),
              jobs:await Promise.all(all.filter(j=>j.audioTake).map(j=>audioJobView(j,project))),billingBasis:"operator-invoice-allocation"},200,{"cache-control":"private, no-store"});
          }
          if(!audioLedger)return response({error:"Audio auditions require the operator's PostgreSQL audio service."},503);
          const body=audioRecord(await jsonBody(request),["idempotencyKey","generationApproved","sceneIndex","lineIndex","sourceHash","characterId","voiceId","policyRevision","controls","pronunciations","beforeMs","afterMs","notes","alignment","operatorGrant","performanceRevision","phrases","phraseCapabilityRevision","nativeCapabilityRevision","localization","multilingualCapabilityRevision","narration","expectedScriptVersion"]);
          if(typeof body.idempotencyKey!=="string"||!IDEMPOTENCY_KEY_PATTERN.test(body.idempotencyKey))throw new DirectionConflict("Use a new idempotencyKey of 1-128 printable ASCII characters.");
          const requestHash=contentHash(Object.fromEntries(Object.entries(body).filter(([key])=>key!=="idempotencyKey"))),key=`${project.id}:${body.idempotencyKey}`,existing=all.find(j=>j.idempotencyKey===key);
          if(existing){if(existing.stage!=="audio-take"||existing.audioTake?.requestHash!==requestHash)throw new DirectionConflict("This key belongs to another request. Use a new key for a new audition.");return response({jobId:existing.id,stage:existing.stage,status:existing.status},202);}
          if(body.generationApproved!==true)throw new DirectionConflict("Review the voice, line and reserved cost before approving the audition.");
          if(!script)throw new DirectionConflict("Save a screenplay before auditioning a line.");
          const policy=typeof body.voiceId==="string"?audioPolicyLookup(body.voiceId):undefined;
          if(!policy||validateAudioPolicy(policy,Date.now()).revision!==body.policyRevision)throw new DirectionConflict("The authorized voice or price changed. Reload the audition.");
          const character=cast.characters.find(c=>c.id===body.characterId);if(!character)throw new DirectionConflict("Choose a saved character.");
          const narration=body.narration===undefined?undefined:narrationRead(body.narration);
          if(narration&&body.expectedScriptVersion!==script.version||!narration&&body.expectedScriptVersion!==undefined)throw new DirectionConflict("The narration screenplay context changed. Reload and review the read.");
          const sceneIndex=audioNumber(body.sceneIndex,0,999,"Scene index",true),lineIndex=audioNumber(body.lineIndex,0,127,"Line index",true),scene=parseFountain(script.text).scenes[sceneIndex],source=scene&&(narration?narrationLineSource(narration,character.name):lineSources(scene.dialogue)[lineIndex]);
          if(!source||source.hash!==body.sourceHash||source.index!==lineIndex)throw new DirectionConflict("The line source changed. Reload the audition.");
          const memory=performanceForScene(character,scene!);
          const localization=body.localization===undefined?undefined:audioRecord(body.localization,["language","text","sourceHash","reviewed"]),language=localization?audioLanguage(localization.language):"en";
          if(localization?(policy.provider!=="cartesia"||body.multilingualCapabilityRevision!==CARTESIA_MULTILINGUAL_CAPABILITY.revision||!policy.languages?.includes(language)):body.multilingualCapabilityRevision!==undefined)throw new DirectionConflict("The voice's authorized dubbing languages or capability changed. Reload and review the translation.");
          if((body.performanceRevision??null)!==(memory?.revision??null))throw new DirectionConflict("Scene performance changed. Reload and review the audition again.");
          if(policy.provider==="azure"&&body.nativeCapabilityRevision!==AZURE_AUDIO_CAPABILITY.revision||policy.provider!=="azure"&&body.nativeCapabilityRevision!==undefined)throw new DirectionConflict("Native voice support changed. Reload and review the audition again.");
          if((Array.isArray(body.phrases)&&body.phrases.length||body.phraseCapabilityRevision!==undefined)&&body.phraseCapabilityRevision!==(localization?CARTESIA_MULTILINGUAL_CAPABILITY.revision:policy.provider==="azure"?AZURE_AUDIO_CAPABILITY.revision:CARTESIA_PHRASE_CAPABILITY.revision))throw new DirectionConflict("Phrase direction support changed. Reload and review the line again.");
          const saved=character.audioVoice,defaults=saved?.voice.id===policy.voiceId&&saved.voice.permissionRevision===policy.permissionRevision&&saved.voice.catalogueRevision===policy.catalogueRevision?saved:undefined;
          const profile=audioVoiceProfile({schema:localization?"hv-audio-voice/3":AUDIO_VOICE_SCHEMA[policy.provider as keyof typeof AUDIO_VOICE_SCHEMA]??"hv-audio-voice/1",provider:policy.provider,language,voice:{id:policy.voiceId,catalogueRevision:policy.catalogueRevision,permissionRevision:policy.permissionRevision},
            controls:localization?{speed:1,volume:1,emotion:"neutral"}:defaults?.controls??{speed:1,volume:1,emotion:"neutral",...AUDIO_VOICE_CONTROL_DEFAULTS[policy.provider as keyof typeof AUDIO_VOICE_CONTROL_DEFAULTS]},pronunciations:body.pronunciations??(localization?[]:defaults?.pronunciations??[])});
          const line=compileAudioLine(source,profile,{sourceHash:source.hash,...audioRecord(body.controls??{},["speed","volume","emotion",...(AUDIO_VOICE_CONTROL_FIELDS[policy.provider as keyof typeof AUDIO_VOICE_CONTROL_FIELDS]??[])]),...Object.fromEntries(["beforeMs","afterMs","notes","phrases","localization"].filter(k=>body[k]!==undefined).map(k=>[k,body[k]]))},body.alignment as "words"|"words-and-phonemes"|undefined,memory);
          const take=audioTakePlan(sceneIndex,body.characterId as string,line,policy,artifacts?"s3":"local",Date.now(),requestHash,narration),grant=typeof body.operatorGrant==="string"?verifyOperatorGrant(body.operatorGrant,project.id):null,tier:Tier=grant?"elevated":"free";
          const decision=capacity.decide({tier,runningForProject:all.filter(j=>j.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});
          if(decision.action==="reject")return response({error:decision.message,reason:decision.reason},429);
          const job=await audioLedger.admitAudio(project.id,{id:crypto.randomUUID(),idempotencyKey:key,projectId:project.id,tier,stage:"audio-take",scriptVersion:script.version,scriptText:script.text,casting:cast,
            rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,queueAction:decision.action,queueReason:decision.reason,totalFrames:0,costCapUsd:policy.heldUsd,budgetReservedUsd:policy.heldUsd,
            retryPolicy:{maxRetries:0,backoffMs:1000},timeoutMs:180000,traceparent:telemetry.carrier(),audioTake:take},audioPolicyLookup,monthlyBudgetUsd,Date.now(),filmCap(project),voiceVendorCapUsd);
          return response({jobId:job.id,stage:job.stage,status:job.status,heldUsd:policy.heldUsd,actualUsd:null},202);
        }

        if(parts[0]==="api"&&parts[1]==="projects"&&parts[2]&&parts[3]==="dialogue"&&parts[4]&&parts.length===5&&["GET","POST"].includes(request.method)){
          const authorized=await authorizedProject(request,parts[2]);if(!authorized||Date.parse(authorized.project.deleteAfter)<=Date.now())return response({error:"unauthorized"},401);
          const {project,token}=authorized,selected=await scopedJobs(project.id).get(parts[4]);
          if(!selected||selected.projectId!==project.id)return response({error:"unknown source cut"},404);
          const body=request.method==="POST"?await jsonBody(request):null;
          const requestHash=body?contentHash({sourceJobId:selected.id,request:Object.fromEntries(Object.entries(body).filter(([key])=>key!=="idempotencyKey"))}):null;
          if(body){
            if(Object.keys(body).some(key=>!["idempotencyKey","generationApproved","sourceRevision","sourceFilesRevision","baselineRevision","engineVersion","conversionEngineVersion","edits","operatorGrant","dub","narration"].includes(key)))return response({error:"Use supported dialogue request fields."},400);
            if(typeof body.idempotencyKey!=="string"||!IDEMPOTENCY_KEY_PATTERN.test(body.idempotencyKey))return response({error:"Use a new idempotencyKey of 1–128 printable ASCII characters."},400);
            const existing=(await projectJobs(project.id)).find(j=>j.idempotencyKey===`${project.id}:${body.idempotencyKey}`);
            if(existing){if(existing.stage!=="dialogue-replacement"||existing.dialogueReplacement?.requestHash!==requestHash)throw new DirectionConflict("This key belongs to another request. Use a new key for a new dialogue version.");return response({jobId:existing.id,stage:existing.stage,status:existing.status},202);}
            if(body.generationApproved!==true)throw new DirectionConflict("Review the selected lines and approve dialogue replacement before submitting.");
          }
          const baseline=selected.dialogueReplacement?dialogueBaseline(selected):undefined,source=selected.dialogueReplacement?.source??selected;
          assertDialogueAccess(source,project,Date.now(),baseline);const locked=dialogueSource(source,dialoguePictureTime(source,baseline)),engineVersion=speechRuntimeRevision();
          const temporaryEnabled=process.env.HV_NARRATION==="1"&&engineVersion!=="espeak-unavailable",conversionEngineVersion=audioTimelineRuntimeRevision();
          if(dialogueInspections>=2)return response({error:"Two source cuts are being checked. Try again shortly."},429);
          dialogueInspections++;
          let pinned:Awaited<ReturnType<typeof inspectDialogueSource>>;
          try{pinned=artifacts?{revision:locked.revision,files:{video:await artifacts.fileInfo(project.id,selected.id,selected.output!.mp4Path),manifest:await artifacts.fileInfo(project.id,selected.id,selected.output!.manifestPath)}}:await inspectDialogueSource(selected,artifactRoot,request.signal);}finally{dialogueInspections--;}
          const sourceFilesRevision=contentHash(pinned.files);
          if(!body){
            const policies=configuredAudioPolicies(),auditions=(await projectJobs(project.id)).filter(j=>j.audioTake&&j.status==="done").flatMap(j=>{try{return [retainAudition(j)];}catch{return [];}});
            let offset=0;const lines=locked.shots.flatMap(shot=>{const duration=Math.round(shot.clip.durationSec*30)*735,lines=shot.clip.speech?.lines??[];
              const rows=lines.map((line,index)=>{const inherited=baseline?.lines.find(l=>l.shotId===shot.shotId&&l.source.index===index),availableSamples=(lines[index+1]?.startSample??duration)-line.startSample;
                const reads=auditions.flatMap(a=>{try{assertAuditionMatchesFilm(a,source,shot.shotId,index);}catch{return [];}let unavailable:string|null=null;
                  try{assertRetainedAuditionPermission(a,project,policies.find(p=>p.voiceId===a.take.policy.voiceId));assertAudioTimelineWindow(a.output.report,availableSamples);}catch(error){unavailable=(error as Error).message;}
                  return [{jobId:a.jobId,revision:a.revision,text:auditionText(a),language:a.take.line.localization?.language??null,voiceLabel:a.take.policy.label,controls:a.take.line.profile.controls,notes:a.take.line.notes,durationSec:timelineSampleCounts(a.output.report).total/22050,unavailable}];});
                return {shotId:shot.shotId,index,sourceHash:line.source.hash,character:line.source.character,text:inherited?.text??line.source.text,voice:inherited?.voice??line.voice,notes:inherited?.notes??line.notes,
                  audition:inherited?.audition?{jobId:inherited.audition.source.jobId,voiceLabel:inherited.audition.source.take.policy.label,language:inherited.audition.source.take.line.localization?.language??null}:null,auditions:reads,startSec:(offset+line.startSample)/22050,endSec:(inherited?.endSample??offset+line.endSample)/22050,availableSec:availableSamples/22050};});offset+=duration;return rows;});
            const windows=narrationSceneWindows(source),narrationSources=new Map([...auditions,...(baseline?.narration?.track.cues.map(c=>c.audition)??[])].filter(a=>a.take.narration).map(a=>[a.jobId,a]));
            const narrationTakes=[...narrationSources.values()].map(a=>{let unavailable:string|null=null;const language=a.take.line.localization?.language??a.take.line.profile.language,window=windows.find(w=>w.sceneIndex===a.take.sceneIndex);
              try{assertRetainedAuditionPermission(a,project,policies.find(p=>p.voiceId===a.take.policy.voiceId));narrationTrack(source,{language,reviewed:true,cues:[{id:"00000000-0000-4000-8000-000000000001",role:"narration",startSample:window?.startSample??0,gainDb:-6,duckDb:-12,attackMs:100,releaseMs:300,audition:a}]},locked.totalFrames*735,language);}catch(error){unavailable=(error as Error).message;}
              const inherited=baseline?.auditionFiles?.find(f=>f.path.endsWith("/auditions/"+a.jobId+".wav")),mediaOwner=inherited?selected.id:a.jobId,expires=Math.min(Date.parse(project.deleteAfter),Date.parse(inherited?baseline!.linkExpiresAt:a.linkExpiresAt)),audioUrl=unavailable?null:"/artifacts/"+mintArtifactToken(project.id,mediaOwner,expires)+"/"+(inherited?.path??a.output.wavPath);
              return {jobId:a.jobId,revision:a.revision,text:auditionText(a),originalText:a.take.narration!.text,character:a.take.line.source.character,sceneIndex:a.take.sceneIndex,language,voiceLabel:a.take.policy.label,durationSec:timelineSampleCounts(a.output.report).total/22050,audioUrl,unavailable};});
            const currentNarration=baseline?.narration?.track;
            return response({sourceJobId:selected.id,originalJobId:source.id,baselineRevision:baseline?.revision??null,dubLanguage:baseline&&dialogueLanguage(baseline.lines)!=="mul"&&baseline.lines.some(l=>l.audition?.source.take.line.localization)?dialogueLanguage(baseline.lines):currentNarration?.language!=="en"?currentNarration?.language??null:null,sourceRevision:pinned.revision,sourceFilesRevision,engineVersion,conversionEngineVersion,temporaryEnabled,durationSec:locked.totalFrames/30,timing:"keep-line-starts",costUsd:0,lines,
              narration:{takes:narrationTakes,scenes:windows.map(w=>({...w,heading:parseFountain(source.scriptText).scenes[w.sceneIndex]!.heading})),current:currentNarration?{language:currentNarration.language,cues:currentNarration.cues.map(({audition,...cue})=>({...cue,auditionJobId:audition.jobId,auditionRevision:audition.revision}))}:null}},200,{"cache-control":"private, no-store"});
          }
          if(!Array.isArray(body.edits)||!body.edits.length&&body.narration===undefined||body.edits.length>128)throw new Error("Choose up to 128 dialogue edits or a reviewed narration track.");
          const edits=[];for(const edit of body.edits){
            const retained=Boolean(edit&&Object.hasOwn(edit,"auditionJobId"));audioRecord(edit,retained?["shotId","index","sourceHash","auditionJobId","auditionRevision"]:["shotId","index","sourceHash","text","voice","notes"]);
            if(retained){if(typeof edit.auditionJobId!=="string")throw new Error("Choose a retained audition.");const audio=await scopedJobs(project.id).get(edit.auditionJobId);if(!audio||audio.projectId!==project.id)throw new Error("The selected audition is unavailable.");
              const audition=retainAudition(audio);if(audition.revision!==edit.auditionRevision)throw new DirectionConflict("The selected audition changed. Review its current receipt.");
              if(!artifacts)verifyAudioMedia(audio,audio.audioOutput!,artifactRoot);
              edits.push({shotId:edit.shotId,index:edit.index,sourceHash:edit.sourceHash,audition});
            }else edits.push(edit);
          }
          const dub=body.dub===undefined?undefined:audioRecord(body.dub,["language","reviewed"]);if(dub&&dub.reviewed!==true)throw new DirectionConflict("Review every translated line and retained read before rendering this language track.");
          let narration:NarrationTrack|undefined;
          if(baseline?.narration&&body.narration===undefined)throw new DirectionConflict("Review the inherited narration cues and ducking before rendering another version.");
          if(body.narration!==undefined){const v=audioRecord(body.narration,["language","reviewed","cues"]);if(v.reviewed!==true||!Array.isArray(v.cues)||v.cues.length>64)throw new DirectionConflict("Review the narration text, takes, timing and ducking before rendering.");
            const cues=[];for(const raw of v.cues){const c=audioRecord(raw,["id","role","startSample","gainDb","duckDb","attackMs","releaseMs","auditionJobId","auditionRevision"]);
              let audition=baseline?.narration?.track.cues.find(b=>b.audition.jobId===c.auditionJobId&&b.audition.revision===c.auditionRevision)?.audition;
              if(!audition){if(typeof c.auditionJobId!=="string")throw new DirectionConflict("Choose a saved narration audition.");const audio=await scopedJobs(project.id).get(c.auditionJobId);if(!audio||audio.projectId!==project.id)throw new DirectionConflict("The narration audition is unavailable.");audition=retainAudition(audio);if(!artifacts)verifyAudioMedia(audio,audio.audioOutput!,artifactRoot);}
              if(audition.revision!==c.auditionRevision)throw new DirectionConflict("The narration audition changed. Review its current receipt.");
              const {auditionJobId:_job,auditionRevision:_revision,...settings}=c;cues.push({...settings,audition});}
            narration=narrationTrack(source,{language:v.language,reviewed:true,cues},locked.totalFrames*735,dub?audioLanguage(dub.language):"en");}
          const usesAuditions=edits.some(e=>e.audition)||Boolean(narration?.cues.length),usesTemporary=edits.some(e=>!e.audition);
          if(usesTemporary&&!temporaryEnabled)throw new Error("Temporary speech is disabled or unavailable. Choose retained auditions instead.");
          if(body.sourceRevision!==pinned.revision||body.sourceFilesRevision!==sourceFilesRevision||(usesTemporary&&body.engineVersion!==engineVersion)||(usesAuditions&&body.conversionEngineVersion!==conversionEngineVersion)||(!usesAuditions&&body.conversionEngineVersion!==undefined)||(body.baselineRevision??null)!==(baseline?.revision??null))throw new DirectionConflict("The source cut, baseline dialogue or speech runtime changed. Review a new dialogue quote.");
          const plan=createDialogueReplacement(source,edits,pinned.revision,usesTemporary?engineVersion:"retained-audio",pinned.files,Date.now(),baseline,usesAuditions?conversionEngineVersion:undefined,dub?audioLanguage(dub.language):undefined,narration),grant=typeof body.operatorGrant==="string"?verifyOperatorGrant(body.operatorGrant,project.id):null,tier:Tier=grant?"elevated":"free";
          // HV-027-12: a dialogue replacement holds nothing (costCapUsd:0 below), so, like the other zero-cost routes HV-027-11 named, the month's spend does not refuse it.
          const decision=capacity.decide({tier,runningForProject:(await projectJobs(project.id)).filter(j=>j.status==="running").length,requestedShots:locked.shots.length,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd(),requestedUsd:0});
          if(decision.action==="reject")return response({error:decision.message,reason:decision.reason},429);
          const id=crypto.randomUUID(),input={id,idempotencyKey:`${project.id}:${body.idempotencyKey}`,projectId:project.id,tier,stage:"dialogue-replacement" as const,scriptVersion:source.scriptVersion,scriptText:source.scriptText,
            rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,queueAction:decision.action,queueReason:decision.reason,totalFrames:locked.totalFrames,costCapUsd:0,budgetReservedUsd:0,
            retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:Number(process.env.HV_JOB_TIMEOUT_MS??30*60*1000),traceparent:telemetry.carrier(),dialogueReplacement:{source:structuredClone(source),plan,requestHash:requestHash!,storage:artifacts?"s3" as const:"local" as const}};
          let job:Job;
          if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,input,monthlyBudgetUsd,filmCap(project));
          else {await ledger.reserve(id,input.stage,0,monthlyBudgetUsd);try{
              const current=await projects.authorize(token);assertDialogueSourceAvailable(input,await scopedJobs(project.id).get(selected.id));assertDialogueAccess(source,current,Date.now(),baseline);
              await assertDialogueAuditionInputs(input,current??undefined,id=>Promise.resolve(scopedJobs(project.id).get(id)));job=await scopedJobs(project.id).enqueue(input);
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
          // HV-030-29: a feature split into sequences renders one sequence at a time, named by its number;
          // the sequence is the render unit. Any other film renders whole, as before, and names none.
          let sequence: SequenceRef | undefined;
          if (!shotTakes && !characterSheet && project.format === "feature" && project.sequences) {
            const count = project.sequences.sequences.length;
            if (!Number.isSafeInteger(body.sequence) || (body.sequence as number) < 1 || (body.sequence as number) > count)
              return response({error: "This feature is made one sequence at a time. Name the sequence to render, 1 to " + count + "."}, 400);
            const stale = stalePlanReason(project.sequences, scriptVersion, parsedScript, direction);
            if (stale) return response({error: stale}, 409);
            sequence = sequenceRef(project.sequences, body.sequence as number);
            if (body.reuseUnchanged !== undefined || body.forceShotIds !== undefined) return response({error: "Selective reuse applies to a whole film, not to a feature's sequence."}, 400);
          } else if (body.sequence !== undefined) return response({error: "Only a feature the Showrunner split is made in sequences."}, 400);
          let animaticApprovedAt: string | null = null;
          let animaticJobId: string | null = null;
          if (renderStage === "final"&&!takeQuote) {
            animaticJobId = typeof body.animaticJobId === "string" ? body.animaticJobId : null;
            const animatic = animaticJobId ? await scopedJobs(project.id).get(animaticJobId) : undefined;
            if (!animatic || animatic.projectId !== project.id || animatic.stage !== (shotTakes?"take-preview":"animatic")) {
              return response({ error: "unknown animatic job for this project" }, 404);
            }
            const approval = await projects.animaticApproval(project.id, animatic.id);
            if(animatic.livingScript||approval?.livingScriptReview||animatic.currentFilm||approval?.currentFilmReview)throw new DirectionConflict("Use the screenplay-specific generation flow for this preview.");
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
            // HV-030-29: a sequence's final follows that sequence's own approved rough cut.
            if(!sameSequence(animatic.sequence,sequence))return response({error:"That rough cut is of another sequence. Approve this sequence's rough cut first."},409);
            animaticApprovedAt = approval.at;
          }

          const clientKey = body.idempotencyKey === undefined ? `${stage}:${scriptVersion}:cast-${casting.version}${shotTakes?":"+shotTakes.revision:characterSheet?":"+characterSheet.revision:direction.version?":direction-"+direction.version:""}${sequence?`:sequence-${sequence.number}-${sequence.planRevision.slice(0,16)}`:""}` : body.idempotencyKey;
          if (typeof clientKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(clientKey)) {
            return response({ error: "idempotencyKey must be 1-128 printable ASCII characters" }, 400);
          }
          const existing = (await projectJobs(project.id)).find(j => j.idempotencyKey === `${project.id}:${clientKey}`);
          if(existing?.dialogueReplacement)throw new DirectionConflict("This key belongs to a dialogue replacement. Use a new key for generation.");
          if(existing?.livingScript)throw new DirectionConflict("This key belongs to a pending screenplay proposal. Use its original generation flow.");
          if(existing&&!takeQuote&&(shotTakes||isTakeStage(existing.stage))&&(existing.stage!==stage||existing.shotTakes?.revision!==shotTakes?.revision))throw new DirectionConflict("This idempotency key belongs to a different take plan or render stage. Use a new key.");
          // HV-022-19: a key another kind of job holds -- an audition, a sound mix, a graphic, a delivery, or a
          // render of another stage -- is refused, as every sibling route refuses it; it was answered with that job.
          if(existing&&!takeQuote&&existing.stage!==stage)throw new DirectionConflict("This idempotency key belongs to another kind of job. Use a new key.");
          if(existing&&!takeQuote&&!sameSequence(existing.sequence,sequence))throw new DirectionConflict("This idempotency key belongs to another sequence's render. Use a new key.");
          // HV-030-10: the route already knew this render had been asked for before -- that is what
          // this branch is -- and said nothing, so the caller could not tell a repeat from a new
          // film. `admitted` says which, and it is the only honest way for the studio to tell a
          // creator that asking again cost nothing. HV-016-10 and HV-017-12 made that true; this
          // makes it visible.
          if (existing&&!takeQuote) return response({ jobId: existing.id, stage: existing.stage, status: existing.status, scriptVersion: existing.scriptVersion, admitted: false }, 202);

          const shots = shotTakes ? shotTakeShots(shotTakes,casting,parsedScript,direction,scriptVersion) : characterSheet ? characterSheetShots(characterSheet,casting,parsedScript) : inSequence(directShots(directCast(filmPlan(parsedScript,direction,TIERS[tier].maxShots,sequence), parsedScript, casting,Date.now(),direction),direction),sequence);
          const decision = capacity.decide({
            tier,
            runningForProject: (await projectJobs(project.id)).filter((job) => job.status === "running").length,
            requestedShots: shots.length,
            sceneCount: characterSheet||shotTakes ? new Set(shots.map(shot=>shot.sceneIndex)).size : sequence ? sequence.lastScene - sequence.firstScene + 1 : parsedScript.scenes.length,
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
          const shotReuse=body.reuseUnchanged===true?createReusePlan({projectId:project.id,stage,tier,scriptText,casting,direction,providerPlan},(await projectJobs(project.id)).reverse(),body.forceShotIds??[]):undefined;
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
              // HV-030-06: a duration is the one requirement the creator sets by hand, so name the
              // number rather than the word. "render requirements: duration" left them to guess
              // which shot and by how much, on a screen that had offered the length in the first place.
              if (reasons.includes("duration")) {
                // The pool in play, not the final one: this admission also runs for a rough cut.
                const longest = Math.max(0, ...providerPlan.pool.map(entry => entry.snapshot.output.durationSec?.[1] ?? 0));
                throw new Error("No configured provider can render shot " + shot.id + " at " + (requirements.durationSec ?? shot.durationSec).toFixed(1)
                  + " s; the longest they render is " + longest + " s. Shorten it or split it into coverage."
                  + (reasons.length > 1 ? " Also unsupported: " + reasons.filter(reason => reason !== "duration").join(", ") + "." : ""));
              }
              throw new Error("No configured provider supports these render requirements: " + reasons.join(", ") + ".");
            }
            minimumEstimateUsd += Math.min(...eligible.map(match => match.estimateUsd!));maximumEstimateUsd+=Math.max(...eligible.map(match=>match.estimateUsd!));
          }
          if (minimumEstimateUsd > costCapUsd + 1e-9) throw new BudgetError("The render exceeds its generation budget; shorten the screenplay.");
          if(takeQuote)return response({plan:shotTakes,stage,minimumEstimateUsd,maximumEstimateUsd,costCapUsd,perTakeCapUsd:providerPlan.maxShotUsd,providerPlanRevision:providerPlan.revision},200,{"cache-control":"private, no-store"});
          const id = crypto.randomUUID();
          // HV-019-06: hold what this render can actually spend -- the dearest eligible provider for every
          // shot, for every attempt the retry policy allows -- never more than its cap. Holding the flat cap
          // ($5 a shot) made a 10-shot film hold $50 and stopped it at the $40 film limit although it costs
          // about $4. The job still cannot spend past its hold (the ledger refuses and the render stops).
          const budgetReservedUsd = paid ? (shotReuse?.shots.length===shots.length?0:renderHold(maximumEstimateUsd, costCapUsd)) : 0;
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
            ...(sequence?{sequence}:{}),
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
            job = await ledger.admit(project.id, input, monthlyBudgetUsd, filmCap(project));
          } else {
            // HV-019-04: one film may not spend past its limit (in PostgreSQL this is checked inside admit's lock).
            if (budgetReservedUsd > 0) assertFilmBudget({...ledger.filmSpend(project.id, await filmJobIds(project.id)), capUsd: filmCap(project)}, budgetReservedUsd);
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
            // HV-030-10: this one is new. A repeat of a key already admitted answers `false` above.
            admitted: true,
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
          if(animatic?.livingScript)return response({error:"Use the pending screenplay preview decision flow."},409);
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
          return response(await audioJobView(job, project));
        }

        // HV-030-01: the Producer's read-through, the crew's first answer to the script (docs/CREW.md).
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "crew" && parts[4] === "read-through" && parts.length === 5 && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          let input;try{input=readThroughInput(await jsonBody(request));}catch(error){return response({error:(error as Error).message},400);}
          const scriptText = authorized.project.versions.latest()?.text ?? "", parsed = parseFountain(scriptText);
          // HV-030-15: the facts describe the plan the studio will make, as the plan step computes it.
          // HV-030-28: a reel or a short is read as one render's 24 shots, as before; a feature is read whole, up to 240.
          let shots: import("../../planner/src/index").Shot[] | undefined;try{shots=parsed.scenes.length?sourcePlan(parsed,currentDirection(authorized.project.id,authorized.project.directionHistory),7000,READ_THROUGH_SHOT_LIMIT[input.format]):[];}catch{shots=undefined;}
          // HV-030-28: the estimate quotes the active final profile's lead lane, not always Kling 2.5.
          let finalPool: ReturnType<typeof configuredPool> | null = null;try{finalPool=configuredPool("final");}catch{finalPool=null;}
          try {
            const result = await runReadThrough({scriptText, parsed, input, projectId: authorized.project.id, model: crewModel, ledger: crewLedger, shots, finalPool});
            for (const alert of result.crewSpend.alerts) logger.warn("crew.budget_alert", {costUsd: alert.spentUsd, projectId: authorized.project.id});
            logUnusableCrewAnswer("read-through", result, authorized.project.id);
            // HV-030-03: the versions this answer was written against, so the plan step can refuse a stale one.
            const expected = {scriptVersion: authorized.project.versions.latest()?.version ?? 0, castingVersion: currentCasting(authorized.project.id, authorized.project.castingHistory).version,
              directionVersion: currentDirection(authorized.project.id, authorized.project.directionHistory).version};
            return response({...result, expected}, 200, {"cache-control": "private, no-store"});
          } catch (error) {
            if (!(error instanceof CrewBudgetStop)) throw error;
            logger.warn("crew.budget_stopped", {costUsd: error.spentUsd, projectId: authorized.project.id});
            return response({ error: error.message, reason: "crew_budget" }, 429);
          }
        }

        // HV-016-32: the crew's line notes, and the writer taking them one line at a time (docs/CREW.md).
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "crew" && parts[4] === "line-notes" && request.method === "POST" && (parts.length === 5 || (parts.length === 6 && parts[5] === "accept"))) {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized || Date.parse(authorized.project.deleteAfter) <= Date.now()) return response({ error: "unauthorized" }, 401);
          const headers = {"cache-control": "private, no-store"};
          if (parts.length === 6) {
            const body = await jsonBody(request) as Record<string, unknown>;
            if (Object.keys(body).some(key => !["version", "sha256", "notes", "acceptedIds"].includes(key)) || !Number.isSafeInteger(body.version))
              return response({ error: "Send the script version the crew's notes were written against, the notes, and the ids you accept." }, 400);
            // The version names the text: a note is checked against the SHA-256 of that version, whichever the client sends.
            const named = authorized.project.versions.get(body.version as number);
            if (body.sha256 !== undefined && (typeof body.sha256 !== "string" || !named || body.sha256 !== scriptSha256(named.text)))
              return response({ error: "The script changed since the crew wrote these notes. Ask the crew again; nothing was changed." }, 409);
            const sha256 = named ? scriptSha256(named.text) : "";
            try {
              const accepted = await projects.acceptLineNotes(authorized.token, {script: {version: body.version as number, sha256}, notes: body.notes}, body.acceptedIds);
              if (!accepted) return response({ error: "unauthorized" }, 401);
              return response({ version: accepted.version, applied: accepted.applied.map(note => note.id), replayed: accepted.replayed }, 200, headers);
            } catch (error) {
              if (error instanceof LineNoteConflict) return response({ error: error.message }, 409, headers);
              throw error;
            }
          }
          let input;try{input=lineNotesInput(await jsonBody(request));}catch(error){return response({error:(error as Error).message},400);}
          const script = authorized.project.versions.latest();
          if (!script) return response({ error: "Save a screenplay before asking the crew for line notes." }, 409);
          try {
            const result = await runLineNotes({script, input, projectId: authorized.project.id, model: crewModel, ledger: crewLedger});
            for (const alert of result.crewSpend.alerts) logger.warn("crew.budget_alert", {costUsd: alert.spentUsd, projectId: authorized.project.id});
            logUnusableCrewAnswer("line-notes", result, authorized.project.id);
            return response(result, 200, headers);
          } catch (error) {
            if (!(error instanceof CrewBudgetStop)) throw error;
            logger.warn("crew.budget_stopped", {costUsd: error.spentUsd, projectId: authorized.project.id});
            return response({ error: error.message, reason: "crew_budget" }, 429);
          }
        }

        // HV-019-04: what this film has spent, holds, and may spend.
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "spend" && parts.length === 4 && request.method === "GET") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const spend = ledger instanceof PostgresCostLedger ? await ledger.filmSpend(authorized.project.id)
            : ledger.filmSpend(authorized.project.id, await filmJobIds(authorized.project.id));
          // HV-030-29: a feature split into sequences also says what each sequence's renders have cost so far,
          // from the jobs of its current plan. A reel or a short answers exactly as before.
          const plan = authorized.project.format === "feature" ? authorized.project.sequences : undefined;
          if (!plan) return response({ ...spend, capUsd: filmCap(authorized.project) }, 200, {"cache-control": "private, no-store"});
          const jobs = (await projectJobs(authorized.project.id)).filter(job => job.sequence?.planRevision === plan.revision);
          const sequences = plan.sequences.map((sequence, index) => {
            const own = jobs.filter(job => job.sequence!.number === index + 1);
            return {number: index + 1, firstScene: sequence.firstScene, lastScene: sequence.lastScene, shots: sequence.shots,
              spentUsd: Number(own.reduce((sum, job) => sum + job.costUsd, 0).toFixed(6)),
              heldUsd: Number(own.filter(job => job.status === "queued" || job.status === "running").reduce((sum, job) => sum + Math.max(0, (job.budgetReservedUsd ?? 0) - job.costUsd), 0).toFixed(6))};
          });
          return response({ ...spend, capUsd: filmCap(authorized.project), sequences }, 200, {"cache-control": "private, no-store"});
        }

        // HV-030-03: the look approval -- the creator permits the crew's original characters in one step.
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "crew" && parts[4] === "approve-cast" && parts.length === 5 && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request) as {attested?: unknown; expectedVersion?: unknown};
          if (!Number.isSafeInteger(body.expectedVersion)) return response({ error: "Send the cast version you reviewed." }, 400);
          const casting = await projects.permitPendingCast(authorized.token, body.attested === true, body.expectedVersion as number);
          return casting ? response({ casting }, 200, {"cache-control": "private, no-store"}) : response({ error: "unauthorized" }, 401);
        }

        // HV-030-02: the crew turns the creator's answers into cast and shot direction (docs/CREW.md).
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "crew" && parts[4] === "plan" && parts.length === 5 && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request) as Record<string, unknown>;
          const expected = body.expected as {scriptVersion?: unknown; castingVersion?: unknown; directionVersion?: unknown} | undefined;
          if (!expected || ![expected.scriptVersion, expected.castingVersion, expected.directionVersion].every(value => Number.isSafeInteger(value)))
            return response({ error: "Send the script, cast and direction versions the crew answered." }, 400);
          let input;try{input=planInput({format: body.format, tone: body.tone, answers: body.answers});}catch(error){return response({error:(error as Error).message},400);}
          const {project, token} = authorized;
          const script = project.versions.latest(), scriptText = script?.text ?? "", parsed = parseFountain(scriptText);
          const casting = currentCasting(project.id, project.castingHistory), direction = currentDirection(project.id, project.directionHistory);
          if ((script?.version ?? 0) !== expected.scriptVersion || casting.version !== expected.castingVersion || direction.version !== expected.directionVersion)
            return response({ error: "The project changed since the crew's questions. Ask the crew again." }, 409);
          // HV-030-29: a feature is planned as its sequences' shots (each scene on its own, at most 24 shots
          // a sequence), which the Showrunner splits and every sequence render reads. A reel or a short is
          // planned as one render's 24 shots, exactly as before.
          const feature = input.format === "feature";
          let shots;try{shots=parsed.scenes.length?(feature?featureShots(parsed,direction):sourcePlan(parsed,direction,7000,24)):[];}catch(error){return response({error:(error as Error).message},409);}
          if (feature && shots.length > DIRECTION_ENTRY_LIMIT) return response({error: "This feature is " + shots.length + " shots; the studio plans a feature of up to " + DIRECTION_ENTRY_LIMIT + " (about 20 minutes). Shorten the script or combine some beats."}, 409);
          const counts = feature && parsed.scenes.length ? sceneShotCounts(parsed, direction) : [];
          const oversized = oversizedScenes(counts);
          if (oversized.length) return response({error: "Scene " + oversized[0] + "'s accepted coverage needs " + counts[oversized[0]! - 1] + " shots, and a sequence renders at most 24. Edit its coverage before planning the feature."}, 409);
          let finalPool: ReturnType<typeof configuredPool> | null = null;try{finalPool=configuredPool("final");}catch{finalPool=null;}
          const facts = readThroughFacts(scriptText, parsed, {format: input.format, tone: input.tone}, shots, finalPool);
          try {
            // HV-030-29: the Showrunner splits a feature first, so a split that can't be made costs no plan.
            let showrunner: ShowrunnerResult | null = null;
            if (feature && counts.length) {
              try { showrunner = await runShowrunner({parsed, counts, scriptVersion: script?.version ?? 0, projectId: project.id, model: crewModel, ledger: crewLedger}); }
              catch (error) { if (error instanceof SequenceSplitError) return response({error: error.message}, 409); throw error; }
              for (const alert of showrunner.crewSpend.alerts) logger.warn("crew.budget_alert", {costUsd: alert.spentUsd, projectId: project.id});
              logUnusableCrewAnswer("showrunner", showrunner, project.id);
            }
            const planned = await runPlan({scriptText, parsed, facts, input, shots, projectId: project.id, model: crewModel, ledger: crewLedger});
            for (const alert of planned.crewSpend.alerts) logger.warn("crew.budget_alert", {costUsd: alert.spentUsd, projectId: project.id});
            logUnusableCrewAnswer("plan", planned, project.id);
            // HV-017-05: the Editor paces shots to what the configured final provider bills.
            let timing: ShotTiming | null = null;try{timing=finalPool?billedShotTiming(finalPool):null;}catch{timing=null;}
            const changes = crewChanges(planned.plan, casting, direction, () => crypto.randomUUID(), Date.now(), {timing, shots});
            // HV-022-02: the Sound persona casts a production voice for each speaking character from the authorized catalogue.
            let policies: AudioPolicy[] = [];try{policies=audioPolicies();}catch{policies=[];}
            const voiced = castVoices([...casting.characters, ...changes.characters.map(({id, input}) => ({id, name: (input as {name: string}).name, kind: (input as {kind: string}).kind}))],
              scriptIntroductions(parsed, facts.characters), policies);
            changes.notes.push(...voiced.notes);
            const applied = await projects.applyCrewChanges(token, {characters: changes.characters, directions: changes.directions, voices: voiced.assignments.map(({characterId, profile}) => ({characterId, profile})),
              // HV-030-28: the film is planned as this format; a feature is held to the feature's own film limit.
              // HV-030-29: and a feature's sequences are kept beside it; a reel or a short has none.
              format: input.format, sequences: showrunner?.plan ?? null},
              {scriptVersion: expected.scriptVersion as number, castingVersion: casting.version, directionVersion: direction.version});
            if (!applied) return response({ error: "unauthorized" }, 401);
            // HV-021-09: the Continuity Supervisor reads the report the Director's desk serves, over the cast and
            // direction just applied -- the same call as GET /direction at its default 24 shots. No model, $0.
            // HV-030-29: for a feature, over the feature's own shots, which are the ones the crew directed.
            const continuity = continuityReport(feature ? featureShots(parsed, applied.direction, true) : sourcePlan(parsed, applied.direction, 7000, 24, true), applied.casting, applied.direction, parsed);
            changes.notes.push(...continuitySupervisorNotes(continuity));
            if (showrunner) changes.notes.unshift(showrunnerNote(showrunner.plan));
            const crewSpend = showrunner ? {usd: Number((planned.crewSpend.usd + showrunner.crewSpend.usd).toFixed(6)), alerts: [...showrunner.crewSpend.alerts, ...planned.crewSpend.alerts]} : planned.crewSpend;
            return response({schema: "hv-crew-plan-result/1", source: planned.source, ...(planned.fallbackReason ? {fallbackReason: planned.fallbackReason} : {}),
              ...(planned.unusableReason ? {unusableReason: planned.unusableReason} : {}),
              lookNote: planned.plan.lookNote, notes: changes.notes, castingVersion: applied.casting.version, directionVersion: applied.direction.version,
              addedCharacters: changes.characters.length, directedShots: changes.directions.length, crewSpend,
              // HV-030-29: a feature's sequences, each made like a short. Absent for a reel or a short.
              ...(showrunner ? {sequences: {source: showrunner.source, ...(showrunner.fallbackReason ? {fallbackReason: showrunner.fallbackReason} : {}),
                ...(showrunner.unusableReason ? {unusableReason: showrunner.unusableReason} : {}), revision: showrunner.plan.revision,
                sequences: showrunner.plan.sequences.map((sequence, index) => ({number: index + 1, ...sequence}))}} : {}),
              // HV-021-09: how many checks the Supervisor's report could make; the studio credits it only when there were some.
              continuityComparisons: continuityComparisons(continuity),
              // HV-017-06: the final pool can start a clip from a pinned frame, so the studio pins the storyboard stills.
              finalAnchors: finalStartsFromFrame(), voices: voiced.assignments.map(({name, voiceId, policyRevision}) => ({name, voiceId, policyRevision})),
              // HV-030-19: the creator's style card, made from their own answers and handed back, never kept here (ADR-0018).
              ...(() => {try{return {styleCard: styleCardFrom(input, planned.plan.lookNote)};}catch{return {};}})()}, 200, {"cache-control": "private, no-store"});
          } catch (error) {
            if (!(error instanceof CrewBudgetStop)) throw error;
            logger.warn("crew.budget_stopped", {costUsd: error.spentUsd, projectId: project.id});
            return response({ error: error.message, reason: "crew_budget" }, 429);
          }
        }

        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "reviews" && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          if(body.jobId!==undefined&&typeof body.jobId!=="string"||body.expectedOutputRevision!==undefined&&typeof body.expectedOutputRevision!=="string")return response({error:"Use the displayed cut and its output revision to create a review link."},400);
          let permission;try{permission=reviewPermission(body.permission);}catch(error){if(!(error instanceof ReviewCapabilityError))throw error;return response({error:error.message},400);}
          // HV-029-05: the owner may choose how many viewers the link admits; absent keeps FR-047's 3.
          let maxViews:number|undefined;try{maxViews=body.maxViews===undefined?undefined:reviewViewLimit(body.maxViews);}catch(error){if(!(error instanceof ReviewViewLimitError))throw error;return response({error:error.message},400);}
          const available=await projectJobs(authorized.project.id),selection=authorized.project.dialogueSelections.entries.at(-1);
          const job=typeof body.jobId==="string"?available.find(j=>j.id===body.jobId):selection?available.find(j=>j.id===selection.jobId):latestFinishedCut(available,authorized.project.id);
          if(!job){if(body.jobId!==undefined||selection)return response({error:"Choose a completed retained cut to review."},404);
            const link=await projects.createReviewLink(authorized.token,permission,Date.now(),undefined,maxViews);if(!link)return response({error:"unauthorized"},401);return response({...link,reviewUrl:reviewUrl(frontendOrigin,link.token)},201,{"cache-control":"private, no-store"});}
          const binding={jobId:job.id,outputRevision:typeof body.expectedOutputRevision==="string"?body.expectedOutputRevision:selection&&body.jobId===undefined?selection.outputRevision:outputRevision(job)};
          assertSelectedOutput(job,authorized.project,binding);if(!artifacts)await verifyRetainedOutputFiles(job,artifactRoot);
          const link = await projects.createBoundReviewLink(authorized.token,permission,job,binding,Date.now(),maxViews);
          if(!link)return response({error:"unauthorized"},401);
          // A response that carries a freshly minted token is never a cacheable one (HV-029-08).
          return response({ ...link, reviewUrl: reviewUrl(frontendOrigin, link!.token) }, 201, {"cache-control": "private, no-store"});
        }

        /**
         * HV-029-08: withdrawing a link the owner has shared.
         *
         * `ProjectService.revokeReviewLink` and `PostgresProjectService.revokeReviewLink` have both
         * existed, and been unit-tested, since review links did. Neither had a route: there were
         * exactly three -- create, open, decide -- and the frontend only creates. So every refusal
         * in this path says "invalid, expired, revoked, or fully used" about a revocation no caller
         * could reach.
         */
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "reviews" && parts[4] && parts.length === 5 && request.method === "DELETE") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const revoked = await projects.revokeReviewLink(authorized.token, decodeURIComponent(parts[4]));
          if (!revoked) return response({ error: "This project has no such review link." }, 404);
          return response({ revoked: true }, 200, {"cache-control": "private, no-store"});
        }

        if (parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts.length === 3 && request.method === "GET") {
          const reviewToken = decodeURIComponent(parts[2]);
          // HV-029-05: open without counting; the view is recorded below, once there is a
          // cut, the gate has passed and the binding is settled.
          const viewer = reviewViewer(request.headers.get(REVIEW_VIEWER_HEADER));
          const use = await projects.openReviewLink(reviewToken, viewer);
          if (!use) return response({ error: "review link is invalid, expired, revoked, or fully used" }, 403);
          const available = await projectJobs(use.projectId);
          const latest = use.outputBinding?available.find(job=>job.id===use.outputBinding!.jobId):latestFinishedCut(available,use.projectId);
          if (!latest) return response({ error: "this project has no finished cut to review yet" }, 404);
          const reviewed = await projects.peekProject(use.projectId);
          if (!reviewed) return response({ error: "review link is invalid, expired, revoked, or fully used" }, 403);
          // Unconditional. This gate is what enforces the cut's own link
          // expiry, the project's deletion date and — through
          // `assertDialoguePermissions` — current cast permission, so reaching
          // it only when the link happened to carry a binding meant an unbound
          // link served the cut, and signed artifact URLs for it, after the
          // owner's own view of the same job had been refused.
          const binding=use.outputBinding??{jobId:latest.id,outputRevision:outputRevision(latest)};
          assertSelectedOutput(latest,reviewed,binding);
          // And from here the link names the cut it just showed, so a second
          // view cannot silently be a different one and the decision has
          // something to be a decision about.
          //
          // The stored binding is read back rather than assumed. Two first
          // views can race -- both pass the gate, on different cuts if one
          // finishes between them -- and only one binding is kept; serving the
          // loser's cut would hand out media for a film the link does not name
          // and that a later decision would not be about.
          if(!use.outputBinding){
            const stored=await projects.bindReviewLink(reviewToken,binding);
            if(!stored||stored.jobId!==binding.jobId)return response({error:"This review link is being opened elsewhere. Reload to see the cut it is fixed to."},409);
          }
          const viewsRemaining = await projects.recordReviewView(reviewToken, viewer);
          if (viewsRemaining === null) return response({ error: "review link is invalid, expired, revoked, or fully used" }, 403);
          return response({
            projectId: use.projectId,
            permission: use.permission,
            viewsRemaining,
            // HV-029-13: present only on a link that counts viewers by id (an owner-chosen limit).
            ...(use.maxViews !== undefined ? {maxViews: use.maxViews} : {}),
            jobId: latest.id,
            stage: latest.stage,
            captionLanguage:latest.assemblyEdit?editAssemblyCaptionLanguage(latest.assemblyEdit):latest.pictureEdit?editCaptionLanguage(latest.pictureEdit):latest.soundMix?soundCaptionLanguage(latest.soundMix.source.base):latest.dialogueReplacement?.plan.dubLanguage??latest.lipSync?.source.dialogue.plan.dubLanguage??"en",
            // The URLs a viewer is given last as long as the link that gave them, and no longer.
            ...signedOutput(latest, reviewed, Date.now(), use.expiresAt, reviewDigest(reviewToken)),cameraPathRenders:latest.output?.cameraPathRenders??[],frameAnchorRenders:latest.output?.frameAnchorRenders??[],castingVersion:latest.casting?.version??0,directionVersion:latest.direction?.version??0,
            // HV-029-08: the one route reachable without a bearer token was the one route with no
            // cache directive. A shared cache applying heuristic freshness replays the signed media
            // URLs and the project id -- and replays them without reaching the origin, so without
            // counting a view, which is the bound the whole link is built on.
          }, 200, {"cache-control": "private, no-store"});
        }

        /**
         * HV-029-14: a reviewer pins a comment to a frame of the cut the link is bound to. The same
         * gates as a decision: the link must have been opened (so it names its cut), and on a link
         * that counts viewers, by this viewer. The text passes the content-policy gate first.
         */
        if (parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts[3] === "comments" && parts.length === 4 && request.method === "POST") {
          let input;
          try { input = reviewCommentInput(await jsonBody(request)); }
          catch (error) {
            if (error instanceof ReviewCommentRefused) return response({ error: error.message, reason: "content_policy", category: error.safety.category }, 422);
            if (error instanceof ReviewCommentError) return response({ error: error.message }, 400);
            throw error;
          }
          const reviewToken = decodeURIComponent(parts[2]);
          const viewer = reviewViewer(request.headers.get(REVIEW_VIEWER_HEADER));
          const link=await projects.peekReviewLink(reviewToken,Date.now(),viewer),job=link?.outputBinding?await scopedJobs(link.projectId).get(link.outputBinding.jobId):undefined;
          if(link&&!link.outputBinding)return response({error:"Open the cut in this review link before commenting on it."},409);
          if(link&&link.viewers!==undefined&&!(viewer&&link.viewers.includes(viewer.hash)))return response({error:"Open the cut in this review link on this device before commenting on it."},409);
          let comment;
          try { comment = await projects.addReviewComment(reviewToken, input, Date.now(), job, viewer); }
          catch (error) { if (error instanceof ReviewCommentError) return response({ error: error.message }, 409); throw error; }
          return comment ? response({ comment }, 201, {"cache-control": "private, no-store"}) : response({ error: "review link is invalid, expired, revoked, or read-only" }, 403);
        }

        /** HV-029-14: the owner's review links, their timecoded comments, and decisions by stage. */
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "reviews" && parts.length === 4 && request.method === "GET") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const reviews = await projects.ownerReviews(authorized.token);
          if (!reviews) return response({ error: "unauthorized" }, 401);
          return response(reviews, 200, {"cache-control": "private, no-store"});
        }

        /** HV-029-14: the owner resolves a comment, or opens it again. */
        if (parts[0] === "api" && parts[1] === "projects" && parts[2] && parts[3] === "review-comments" && parts[4] && parts.length === 5 && request.method === "POST") {
          const authorized = await authorizedProject(request, parts[2]);
          if (!authorized) return response({ error: "unauthorized" }, 401);
          const body = await jsonBody(request);
          if (typeof body.resolved !== "boolean") return response({ error: "resolved must be true or false" }, 400);
          const comment = await projects.resolveReviewComment(authorized.token, decodeURIComponent(parts[4]), body.resolved);
          if (!comment) return response({ error: "This project has no such review comment." }, 404);
          return response({ comment }, 200, {"cache-control": "private, no-store"});
        }

        if (parts[0] === "api" && parts[1] === "reviews" && parts[2] && parts[3] === "decision" && request.method === "POST") {
          const body = await jsonBody(request);
          const decision: ReviewDecision | null = body.decision === "approved" || body.decision === "changes_requested" ? body.decision : null;
          if (!decision) return response({ error: "decision must be approved or changes_requested" }, 400);
          const reviewToken = decodeURIComponent(parts[2]);
          const viewer = reviewViewer(request.headers.get(REVIEW_VIEWER_HEADER));
          const link=await projects.peekReviewLink(reviewToken,Date.now(),viewer),job=link?.outputBinding?await scopedJobs(link.projectId).get(link.outputBinding.jobId):undefined;
          // A valid, unexpired, unrevoked approve link that was never opened is
          // none of the four things the 403 below names, and the reviewer can
          // fix it by opening the cut. Saying so is not a weaker refusal: the
          // decision is still refused, and `submitReviewDecision` refuses it
          // again on its own if this is ever reached another way.
          if(link&&!link.outputBinding)return response({error:"Open the cut in this review link before deciding on it."},409);
          // A link that counts viewers takes a decision only from one who was shown the cut.
          if(link&&link.viewers!==undefined&&!(viewer&&link.viewers.includes(viewer.hash)))return response({error:"Open the cut in this review link on this device before deciding on it."},409);
          const accepted = await projects.submitReviewDecision(reviewToken, decision, typeof body.note === "string" ? body.note : "",Date.now(),job,viewer);
          return accepted ? response({ accepted: true, decision }) : response({ error: "review link is invalid, expired, revoked, or read-only" }, 403);
        }

        if (parts[0] === "artifacts" && ["GET", "HEAD"].includes(request.method)) {
          const [, artifactToken, projectId, jobId, ...rest] = parts;
          const payload = artifactToken ? verifyToken(artifactToken) : null;
          if (!payload || payload.kind !== "artifact" || !projectId || payload.projectId !== projectId || !jobId || payload.jobId !== jobId || rest.length === 0) {
            return response({ error: "unauthorized" }, 401);
          }
          // The same path rule on both backends, from the raw path (so an empty
          // segment is seen), answered with the generic 404 before any lookup.
          let key: string;
          try { key = artifactKey(url.pathname.split("/").slice(3).join("/"), projectId, jobId); } catch { return response({ error: "not found" }, 404); }
          const project = await projects.peekProject(projectId);
          if (!project || new Date(project.deleteAfter).getTime() <= Date.now() || await projects.isTakenDown(projectId)) return response({ error: "not found" }, 404);
          // HV-029-11: a link a review link handed out is withdrawn with it.
          if (payload.review !== undefined && await projects.reviewLinkWithdrawn(projectId, payload.review)) return response({ error: "not found" }, 404);
          const mediaJob=await scopedJobs(projectId).get(jobId);
          if(mediaJob?.graphicRender){try{assertGraphicPermission(mediaJob.graphicRender,project);if(mediaJob.status!=="done"||!mediaJob.graphicOutput||Date.parse(mediaJob.linkExpiresAt??"")<=Date.now())throw new Error("Graphic output expired.");validateGraphicOutput(mediaJob,mediaJob.graphicOutput);if(!mediaJob.graphicOutput.files.some(f=>f.path===key))throw new Error("Unavailable graphic artifact");}catch{return response({error:"not found"},404);}}
          // One permission gate for every retained media job, rather than one
          // per optional field.
          //
          // This used to be six blocks, each reached only when the job carried
          // a particular optional field -- `lipSync`, `dialogueReplacement`,
          // `soundMix`, `pictureEdit`, `assemblyEdit`, or a shot render with
          // `clip.speech`. A plain `final` or `animatic` cut carries none of
          // them, so **no permission check ran on its media at all**: the token
          // signature, the project's existence, its deletion date and takedown,
          // and nothing else. Cast permission is not about speech --
          // `assertCurrentCastPermission` is reached for every shot's
          // `characterIds`, and a revoked character in a silent shot is still
          // that character's likeness -- so the speech condition was wrong on
          // its own terms as well as incomplete.
          //
          // `assertSelectedOutput` carries the whole rule: done and retained,
          // the cut's own `linkExpiresAt`, the project's `deleteAfter`, the
          // output revision, and current cast permission for every shot. Which
          // file list a job's artifacts must appear in still depends on its
          // shape, and that part stays keyed to the shape.
          // No job, no media: a signed token names a job, and artifacts of a
          // job that is no longer there are not served on the strength of the
          // token alone.
          if(!mediaJob)return response({error:"not found"},404);
          try{
            artifactPermission(mediaJob.stage)(mediaJob,project);
            const section=mediaJob.lipSync?"lipSync":mediaJob.dialogueReplacement?"dialogue":mediaJob.soundMix?"sound":mediaJob.pictureEdit?"editorial":mediaJob.assemblyEdit?"assembly":null;
            if(section){const files=(mediaJob.output as Record<string,{files?:{path:string}[]}|undefined>|undefined)?.[section]?.files;
              if(!files||!files.some(file=>file.path===key))throw new Error("Unavailable "+section+" artifact");}
          }catch{return response({error:"not found"},404);}
          if(mediaJob?.audioTake){try{
            if(mediaJob.status!=="done"||!mediaJob.audioOutput?.files.some(f=>f.path===key))throw new Error("Unavailable audio");
            audioTakePermission(mediaJob,project);
          }catch{return response({error:"not found"},404);}}
          // A delivery job retains exactly one file, so "is this the file" is the whole check, and
          // the deliverable is not served until the job that made it is done.
          if(mediaJob?.delivery){try{
            if(mediaJob.status!=="done"||mediaJob.deliveryOutput?.file.path!==key)throw new Error("Unavailable deliverable");
            if(Date.parse(mediaJob.linkExpiresAt??"")<=Date.now())throw new Error("This deliverable's link has expired.");
            // HV-026-07: validates the output as before, and refuses a grade its own check withheld.
            assertDeliveryOffered(mediaJob);
            assertDeliveryPermission(mediaJob.delivery,project);
            assertDeliverySourcePermission(await scopedJobs(projectId).get(mediaJob.delivery.binding.source.jobId)??undefined,project);
          }catch{return response({error:"not found"},404);}}
          const mediaHeaders={...corsHeaders,...(mediaJob?.graphicRender?{"content-security-policy":"default-src 'none'; sandbox","x-content-type-options":"nosniff",...(!rest.at(-1)?.endsWith(".png")?{"content-disposition":"attachment; filename="+rest.at(-1)}:{})}:{}),...(mediaJob?.delivery?{"content-disposition":"attachment; filename="+rest.at(-1),"x-content-type-options":"nosniff"}:{}),...(mediaJob?.soundMix&&(rest.at(-1)==="cue-sheet.json"||["finishing/report.json","restoration/report.json"].includes(rest.slice(-2).join("/")))?{"content-disposition":"attachment; filename="+(rest.at(-1)==="cue-sheet.json"?"sound-cues-":rest.at(-2)==="restoration"?"sound-restoration-":"sound-loudness-")+jobId+".json"}:{})};
          if (artifacts) return await artifacts.response(projectId, jobId, key, request, mediaHeaders)
            ?? response({error: "not found"}, 404);
          const jobRoot = resolve(artifactRoot, projectId, jobId);
          const requested = resolve(jobRoot, ...rest);
          if (!requested.startsWith(`${jobRoot}${sep}`) || !existsSync(requested)) return response({ error: "not found" }, 404);
          return new Response(Bun.file(requested), {
            headers: {
              ...mediaHeaders,
              "content-type": CONTENT_TYPES[extname(requested)] ?? "application/octet-stream",
              "cache-control": "private, no-store",
              "referrer-policy": "no-referrer",
            },
          });
        }

        return response({ error: "not found" }, 404);
      } catch (error) {
        if (error instanceof SoundRefused) return response({ error: error.message, reason: "content_policy", category: error.safety.category }, 422);
        if (error instanceof MusicRefused) return response({ error: error.message, reason: "content_policy", category: error.safety.category }, 422);
        if (error instanceof MusicUnavailable) return response({ error: error.message }, 409);
        if (error instanceof MusicCueFailed) return response({ error: error.message }, 502);
        if (error instanceof MusicCueConflict) return response({ error: error.message }, 409);
        if (error instanceof MusicCueError) return response({ error: error.message }, 400);
        return response({ error: error instanceof Error ? error.message : "internal error", reason: error instanceof BudgetError ? "budget_exhausted" : undefined }, error instanceof BudgetError ? 429 : error instanceof CastingConflict||error instanceof SceneCutConflict || error instanceof DirectionConflict||error instanceof DialogueSelectionConflict||error instanceof LipSyncError||error instanceof SoundConflict ? 409 : error instanceof ActorShareUnavailable ? 404 : 400);
      }
      }));
    },
  });
  const storage=database?"postgres":"json";
  if (!tls) {logger.info("api.started",{port:app.port,tls:false,storage});return {port: app.port, hostname: app.hostname, url: app.url, async stop(closeActiveConnections) {
    explorer?.close();
    await editApi.close();
    await app.stop(closeActiveConnections); await database?.close(); await diagnostics?.close();
    if(!options.telemetry)await telemetry.shutdown();
  }};}
  const loopbackPort = app.port;
  if (!loopbackPort) {
    app.stop(true);
    throw new Error("the loopback application listener did not bind a port");
  }
  const front = mutualTlsFront(tls, hostname, port, loopbackPort);
  logger.info("api.started",{port:front.port,tls:true,storage});
  return {
    port: front.port,
    hostname: front.hostname,
    url: new URL(`https://${front.hostname}:${front.port}/`),
    async stop(closeActiveConnections) {
      explorer?.close();
      front.stop(closeActiveConnections);
      await editApi.close();
      await app.stop(closeActiveConnections);
      await database?.close();
      await diagnostics?.close();
      if(!options.telemetry)await telemetry.shutdown();
    },
  };
}

if (import.meta.main) createApiServer();
