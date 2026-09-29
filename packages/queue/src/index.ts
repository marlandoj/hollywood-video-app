import {isTakeStage,generationStage,type JobStage} from "../../planner/src/render-stage";
import {validateGraphicJob,validateGraphicOutput,validateGraphicProgress,assertGraphicIdempotency,type GraphicJobPlan,type GraphicOutput,type GraphicProgress} from "../../planner/src/graphic-jobs";
import {validateDeliveryJob,validateDeliveryOutput,assertDeliveryIdempotency,type DeliveryJobPlan,type DeliveryOutput} from "../../planner/src/delivery-jobs";
import {validateSoundJob,validateSoundOutput,assertSoundIdempotency} from "../../planner/src/sound-jobs";
import {validateEditJob,validateEditOutput,assertEditIdempotency} from "../../planner/src/edit-jobs";
import {validateEditAssemblyJob,assertEditAssemblyIdempotency} from "../../planner/src/edit-assembly-job-context";
import {validateLivingScriptJob,validateLivingScriptOutput,assertLivingScriptIdempotency} from "../../planner/src/living-script-job-context";
import {validateEditAssemblyOutput} from "../../planner/src/edit-assembly-jobs";
import {validateDialogueJob,validateDialogueOutput,assertDialogueIdempotency} from "../../planner/src/dialogue-jobs";
import {validateAudioTake,validateAudioTakeOutput,assertAudioTakeIdempotency,type AudioTakeOutput} from "../../planner/src/audio-jobs";
import {validateLipSyncJob,validateLipSyncPrepared,validateLipSyncOutput,assertLipSyncIdempotency,addLipSyncReview,type LipSyncPrepared,type LipSyncReview,type LipSyncReviews} from "../../planner/src/lipsync";
export type {JobStage} from "../../planner/src/render-stage";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CostRecord } from "../../generator/src/index";
import type { ProviderPlan } from "../../generator/src/catalog";
import type { RouteDecision } from "../../generator/src/router";
import { contentHash, matchCapability, validateRequirements } from "../../generator/src/capabilities";
import { withFileLock } from "./persist";
import {advanceShotExecutionInventory,validateJobExecutionCheckpoint,validateShotExecutionOutput,type ShotExecutionInventoryRow} from "../../planner/src/shot-execution-inventory";
import type {ShotRenderRecord} from "../../planner/src/shot-reuse";
import {validateCurrentFilmJob,assertCurrentFilmMode,assertCurrentFilmIdempotency,advanceCurrentFilmCheckpoint,validateCurrentFilmOutput,type CurrentFilmCheckpoint,type CurrentFilmOutput} from "../../planner/src/current-film-job-context";
import type {CurrentFilmJobV2} from "../../planner/src/current-film-jobs";
import type {CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import type {CurrentFilmMixedCheckpoint} from "../../planner/src/current-film-mixed-context";
import type {CurrentFilmOrigins} from "../../planner/src/current-film-origins";
import type {CurrentFilmMixedOutput} from "../../planner/src/current-film-mixed-job-context";
import type {CurrentFilmPreparedProof} from "../../planner/src/current-film-prepared-proof";

export type Tier = "free" | "elevated";
export const TIERS: Record<Tier, { maxConcurrent: number; maxShots: number; maxResolution: string }> = {
  free: { maxConcurrent: 1, maxShots: 24, maxResolution: "1280x720" },
  elevated: { maxConcurrent: 3, maxShots: 60, maxResolution: "1920x1080" },
};

export type QueueAction = "run" | "queue_behind";
export type QueueReason = "capacity_available" | "project_concurrency" | "budget_throttle";

/** FR-040: the export download link stays valid for 30 days after completion. */
export const DOWNLOAD_LINK_TTL_MS = 30 * 24 * 3600 * 1000;
/** A running job whose worker has not heartbeated within the lease is treated as abandoned and resumed. */
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

/**
 * How many times a job may lapse its lease **without making any progress**
 * before it stops at a terminal dead letter.
 *
 * This is deliberately **not** `retryPolicy.maxRetries`, which counts failures
 * a worker lived long enough to report. A job whose worker is OOM-killed, whose
 * host is lost, or which segfaults the process reports nothing at all: it stays
 * `running` with a lapsed lease, and `requeueExpired` used to return it to the
 * queue with no budget consumed and no bound, forever. On the free tier that is
 * one concurrency slot per project, so a single poison job could occupy a
 * project's only slot for the life of the deployment while every honest job
 * behind it waited.
 *
 * **What a lapsed lease does not tell us.** `leaseExpired` reads a status and a
 * timestamp. It cannot distinguish a dead worker from a live one whose
 * heartbeat was late -- a database stall, a blocked event loop or a partition
 * longer than the lease all look identical from here. That is why the counter
 * is "lapses without progress" and not "lapses": a job that checkpoints forward
 * between lapses has its streak reset, so a slow-but-working fleet cannot
 * dead-letter work that is advancing. What remains, and is not claimed away: a
 * job that makes no checkpoint between lapses -- a single long provider call,
 * or a short job with no checkpoint at all by design -- can still reach the
 * terminus on a flaky host without any worker having died.
 */
export const MAX_LEASE_RECOVERIES = 5;

/**
 * The cap on a job's user-facing notification list, which lives inside the
 * stored job body. Before `notify` existed, eight call sites appended to it
 * directly and none bounded it: seven in this file and one in
 * `packages/storage/src/ledger.ts`. Ten call `notify` today -- nine here and
 * that one -- the extras being the dead letter that arrived with the bound and
 * the deliverable that arrived with HV-027-05.
 * Both counts are stated because the first draft of this comment gave one
 * number for both, and a reader counting call sites got a different answer
 * from a reader reading the history. The route-decision history beside it, by
 * contrast, has been bounded at 8192 since it was written.
 *
 * The oldest entries are dropped rather than the write refused,
 * because these are messages to a person, not evidence; `routeDecisions`
 * throws because it *is* evidence.
 */
export const MAX_JOB_NOTIFICATIONS = 256;

/**
 * The message a person sees when a cost cap stops their shot. Declared once
 * because the queue and the PostgreSQL cost ledger both perform this
 * cancellation, each in its own transaction, and each used to spell the
 * sentence out again.
 */
export const costCapCancelNotice = (cancelReason: string): string =>
  `Your shot was cancelled: ${cancelReason}. You were not charged — this project is operator-funded.`;

/**
 * A fingerprint of everything that counts as forward progress on a job, whatever
 * kind of job it is. Computed only when a lease lapses, which is rare, and
 * compared against the fingerprint recorded at the previous lapse: equal means
 * the job advanced nothing between the two, which is what the dead-letter
 * budget is counting.
 */
function progressMark(job: Job): string {
  return contentHash({
    frames: job.checkpointFrame, shots: job.checkpointShots, cost: job.costUsd,
    execution: job.executionCheckpoints ?? null, currentFilm: job.currentFilmCheckpoint ?? null,
    graphic: job.graphicCheckpoint ?? null, graphicProgress: job.graphicProgress ?? null,
    sound: job.soundCheckpoint ?? null, edit: job.editCheckpoint ?? null,
    assembly: job.assemblyCheckpoint ?? null, dialogue: job.dialogueCheckpoint ?? null,
    audio: job.audioCheckpoint ?? null, lipSyncPrepared: job.lipSyncPrepared ?? null,
    lipSync: job.lipSyncCheckpoint ?? null, output: job.output ?? null,
    audioOutput: job.audioOutput ?? null, graphicOutput: job.graphicOutput ?? null,
    delivery: job.deliveryCheckpoint ?? null, deliveryOutput: job.deliveryOutput ?? null,
  });
}

/**
 * The one place a notification is appended, so the bound cannot be forgotten.
 * Exported because `packages/storage/src/ledger.ts` cancels a job for exceeding
 * its cost cap inside its own transaction and appended to the same list with
 * the same message written out a second time.
 */
export function notify(job: Job, message: string): void {
  job.notifications.push(message);
  if (job.notifications.length > MAX_JOB_NOTIFICATIONS) {
    job.notifications.splice(0, job.notifications.length - MAX_JOB_NOTIFICATIONS);
  }
}

export interface RetryPolicy { maxRetries: number; backoffMs: number }
export interface Job {
  id: string;
  idempotencyKey: string;
  projectId: string;
  tier: Tier;
  stage: JobStage;
  scriptVersion: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  queueAction: QueueAction;
  queueReason: QueueReason;
  queuedBehind: string[];
  checkpointFrame: number;
  checkpointShots: number;
  /** Private worker evidence; never serialize into clip manifests or public job views. */
  executionCheckpoints?:ShotExecutionInventoryRow[];
  currentFilm?:CurrentFilmJobV2|CurrentFilmJobV3;
  currentFilmCheckpoint?:CurrentFilmCheckpoint|CurrentFilmMixedCheckpoint;
  /** Private mixed (V3) original custody. Admission still refuses V3 jobs. */
  currentFilmOrigins?:CurrentFilmOrigins;
  /** Private held historical dependency custody, never caller admission metadata. */
  currentFilmProof?:CurrentFilmPreparedProof;
  totalFrames: number;
  retryPolicy: RetryPolicy;
  retriesUsed: number;
  timeoutMs: number;
  costCapUsd: number;
  budgetReservedUsd?: number;
  providerSpec?: string;
  providerPlan?: ProviderPlan;
  casting?: import("../../planner/src/casting").CastingSnapshot;
  direction?: import("../../planner/src/direction").DirectionSnapshot;
  shotTakes?:import("../../planner/src/takes").ShotTakePlan;
  shotReuse?:import("../../planner/src/shot-reuse").ShotReusePlan;
  livingScript?:import("../../planner/src/living-script-jobs").LivingScriptJobPlan;
  characterSheet?: import("../../planner/src/sheets").CharacterSheetPlan;
  dialogueReplacement?:import("../../planner/src/dialogue-jobs").DialogueJobPlan;
  dialogueCheckpoint?:NonNullable<Job["output"]>;
  audioTake?:import("../../planner/src/audio-jobs").AudioTakePlan;
  audioCheckpoint?:AudioTakeOutput;
  audioOutput?:AudioTakeOutput;
  lipSync?:import("../../planner/src/lipsync").LipSyncPlan;
  lipSyncPrepared?:import("../../planner/src/lipsync").LipSyncPrepared;
  lipSyncCheckpoint?:NonNullable<Job["output"]>;
  lipSyncReviews?:import("../../planner/src/lipsync").LipSyncReviews;
  soundMix?:import("../../planner/src/sound-jobs").SoundPlan;
  soundCheckpoint?:NonNullable<Job["output"]>;
  pictureEdit?:import("../../planner/src/edit-jobs").EditPlan;
  editCheckpoint?:NonNullable<Job["output"]>;
  assemblyEdit?:import("../../planner/src/edit-assembly-jobs").EditAssemblyRenderPlan;
  assemblyCheckpoint?:NonNullable<Job["output"]>;
  graphicRender?:GraphicJobPlan;
  graphicCheckpoint?:GraphicOutput;
  graphicOutput?:GraphicOutput;
  graphicProgress?:GraphicProgress;
  delivery?:DeliveryJobPlan;
  deliveryCheckpoint?:DeliveryOutput;
  deliveryOutput?:DeliveryOutput;
  routeDecisions?: RouteDecision[];
  /** Internal W3C trace context created at admission; never used for authorization. */
  traceparent?: string;
  costUsd: number;
  scriptText: string;
  rightsAttestedAt: string | null;
  animaticJobId: string | null;
  animaticApprovedAt: string | null;
  nextEligibleAt: string | null;
  startedAt: string | null;
  leaseExpiresAt: string | null;
  claimedBy: string | null;
  leaseVersion?: number;
  resumedCount: number;
  /**
   * Consecutive lease lapses on which the job's progress fingerprint was
   * unchanged. Reset to 1 by the first lapse after any forward progress, so the
   * dead-letter budget measures being stuck rather than being unlucky.
   *
   * Optional on purpose: every job body written before this field existed
   * lacks it, and a required field would have meant either a migration or a
   * type error on every fixture in the repository. `reload` defaults it and
   * every read goes through `?? 0`.
   */
  lapsesWithoutProgress?: number;
  /** The progress fingerprint recorded at the last lapse; absent before the first. */
  lapseProgressMark?: string;
  completedAt: string | null;
  linkExpiresAt: string | null;
  cost?: CostRecord;
  cancelReason?: string;
  notifications: string[];
  output?: {
    mp4Path: string;
    hlsPlaylistPath: string;
    captionsPath: string;
    manifestPath: string;
    currentFilm?:CurrentFilmOutput|CurrentFilmMixedOutput;
    dialogue?:import("../../planner/src/dialogue-jobs").DialogueOutput;
    lipSync?:import("../../planner/src/lipsync").LipSyncOutput;
    sound?:import("../../planner/src/sound-jobs").SoundOutput;
    editorial?:import("../../planner/src/edit-jobs").EditOutput;
    assembly?:import("../../planner/src/edit-assembly-jobs").EditAssemblyOutput;
    shotRenders?:import("../../planner/src/shot-reuse").ShotRenderRecord[];
    shotExecutions?:ShotExecutionInventoryRow[];
    sheetPath?: string;
    takeClips?:{id:string;label:string;path:string;hlsPath:string;posterPath:string;captionsPath:string;manifestPath:string;durationSec:number;seed:number;sha256:string;costUsd:number;mode:"preview"|"video"|"storyboard"|"synthetic"}[];
    picturePerformances?:{shotId:string;intent:import("../../planner/src/picture-performance").PicturePerformance}[];
    cameraPathRenders?:({shotId:string}&NonNullable<import("../../generator/src/index").VideoClip["cameraPathControl"]>)[];
    frameAnchorRenders?:{shotId:string;mode:"native"|"storyboard";positions:number[]}[];
    storyboard?: { shotId: string; path: string; sourcePath?:string;caption: string; sha256?: string }[];
  };
  failureReason?: string;
  /** A content-policy refusal is deterministic: the job fails terminally and is never retried. */
  failureKind?: "policy_refusal" | "dead_letter";
}

type AutoFields =
  | "status" | "queueAction" | "queueReason" | "queuedBehind" | "checkpointFrame" | "checkpointShots" | "retriesUsed"
  | "notifications" | "costUsd" | "nextEligibleAt" | "startedAt" | "leaseExpiresAt" | "claimedBy" | "resumedCount"
  | "completedAt" | "linkExpiresAt" | "leaseVersion" | "executionCheckpoints" | "currentFilmCheckpoint" | "currentFilmOrigins" | "currentFilmProof"
  | "lapsesWithoutProgress" | "lapseProgressMark";

export type JobInput = Omit<Job, AutoFields> & { queueAction?: QueueAction; queueReason?: QueueReason };

export interface ClaimOptions { workerId?: string; leaseMs?: number }

/**
 * Anything that can stop a project generating. Both job stores implement it,
 * and `ProjectService.takedown` requires one, so a project cannot be taken down
 * without its queue hearing about it.
 */
export interface GenerationRevoker {
  revokeProject(projectId: string, reason: string, now?: number): Job[] | Promise<Job[]>;
}

/**
 * The notice a revoked job carries. Fixed text with nothing interpolated: the
 * operator's stated reason belongs in the takedown log, not on a job record
 * that is rendered to whoever can still read it. FR-054 wording rules apply to
 * refusals; this is a revocation, and it says only what happened.
 */
export const GENERATION_REVOKED_NOTICE = "Generation stopped: this project was taken down. Nothing further will be rendered.";

export type LeaseErrorReason = "not_running" | "wrong_worker" | "lease_expired" | "fence_changed";

/** Thrown when a worker mutates a job it does not currently hold; nothing is persisted. */
export class LeaseError extends Error {
  constructor(readonly jobId: string, readonly reason: LeaseErrorReason, readonly claimedBy: string | null) {
    super(`job ${jobId} is not held by this worker (${reason})`);
    this.name = "LeaseError";
  }
}

const TERMINAL: ReadonlySet<Job["status"]> = new Set(["done", "failed", "cancelled"]);

function isRunningWithLease(job: Job, now: number): boolean {
  return job.status === "running" && !!job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() > now;
}

function leaseExpired(job: Job, now: number): boolean {
  return job.status === "running" && (!job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= now);
}

export class DurableJobStore implements GenerationRevoker {
  private jobs = new Map<string, Job>();
  constructor(private path: string | null) {
    this.reload();
  }
  /** Reuse queue transitions inside a database row transaction. */
  static fromJobs(jobs: Job[]): DurableJobStore {
    const store = new DurableJobStore(null);
    store.jobs = new Map(structuredClone(jobs).map(job => [job.id, job]));
    return store;
  }
  private reload(): void {
    if (this.path && existsSync(this.path)) {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Job>[];
      this.jobs.clear();
      for (const raw of data) {
        const job: Job = {
          queueAction: "run",
          queueReason: "capacity_available",
          queuedBehind: [],
          leaseExpiresAt: null,
          claimedBy: null,
          resumedCount: 0,
          // A body written before these existed has neither, and `notify` would
          // otherwise throw on a missing list rather than defaulting it.
          notifications: [],
          lapsesWithoutProgress: 0,
          completedAt: null,
          linkExpiresAt: null,
          ...raw,
        } as Job;
        this.jobs.set(job.id, job);
      }
    }
  }
  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.jobs.values()], null, 2));
    renameSync(tmp, this.path);
  }
  /** Every mutation reloads under the interprocess lock, applies, and persists, so API and worker processes never lose each other's writes. */
  private transact<T>(fn: () => T): T {
    if (!this.path) return fn();
    return withFileLock(this.path, () => {
      this.reload();
      const result = fn();
      this.persist();
      return result;
    });
  }
  private activeJobs(): Job[] {
    return [...this.jobs.values()].filter((job) => job.status === "queued" || job.status === "running");
  }
  enqueue(input: JobInput): Job {
    return this.transact(() => {
      assertCurrentFilmMode(input);
      if(Object.hasOwn(input,"executionCheckpoints")||Object.hasOwn(input,"currentFilmCheckpoint")||Object.hasOwn(input.output??{},"shotExecutions")||Object.hasOwn(input.output??{},"currentFilm"))throw new Error("New jobs cannot supply private worker execution evidence.");
      if(input.currentFilm){validateCurrentFilmJob(input,Date.now());if(input.output!==undefined)throw new Error("New current-film jobs cannot supply completed output.");}
      const existing = [...this.jobs.values()].find((j) => j.projectId === input.projectId && j.idempotencyKey === input.idempotencyKey);
      assertDialogueIdempotency(existing,input);
      assertAudioTakeIdempotency(existing,input);
      assertLipSyncIdempotency(existing,input);
      assertSoundIdempotency(existing,input);
      assertEditIdempotency(existing,input);
      assertEditAssemblyIdempotency(existing,input);
      assertLivingScriptIdempotency(existing,input);
      assertCurrentFilmIdempotency(existing,input);
      assertGraphicIdempotency(existing,input);
      assertDeliveryIdempotency(existing,input);
      if(existing&&(input.shotTakes||isTakeStage(existing.stage))&&(existing.stage!==input.stage||existing.shotTakes?.revision!==input.shotTakes?.revision))throw new Error("The idempotency key belongs to a different take plan or render stage.");
      if (existing) return existing;
      validateLivingScriptJob(input,Date.now());if(input.livingScript&&input.output)throw new Error("New pending screenplay jobs cannot carry completed media.");
      validateGraphicJob(input);if(input.graphicCheckpoint||input.graphicOutput||input.graphicProgress)throw new Error("New graphic jobs cannot carry completed media or progress.");
      validateDeliveryJob(input);if(input.deliveryCheckpoint||input.deliveryOutput)throw new Error("New delivery jobs cannot carry a finished deliverable.");
      validateDialogueJob(input);
      validateAudioTake(input);
      validateLipSyncJob(input);
      validateSoundJob(input,Date.now());if(input.soundMix&&(input.soundCheckpoint||input.output))throw new Error("New sound jobs cannot carry completed media.");
      validateEditJob(input,Date.now());if(input.pictureEdit&&(input.editCheckpoint||input.output))throw new Error("New editorial jobs cannot carry completed media.");
      validateEditAssemblyJob(input,Date.now());if(input.assemblyEdit&&(input.assemblyCheckpoint||input.output))throw new Error("New assembly jobs cannot carry completed media.");
      if(input.lipSync&&(input.lipSyncPrepared||input.lipSyncCheckpoint||input.lipSyncReviews||input.output))throw new Error("New lip-sync jobs cannot carry completed evidence.");
      if(isTakeStage(input.stage)!==Boolean(input.shotTakes)||(input.shotTakes&&(!input.providerPlan||input.providerPlan.stage!==generationStage(input.stage)||!input.direction||!input.casting||input.characterSheet||input.shotTakes.maxShots!==TIERS[input.tier].maxShots)))throw new Error("A take group requires its own source context and generation plan.");
      const queueAction = input.queueAction ?? "run";
      const queueReason = input.queueReason ?? "capacity_available";
      const active = this.activeJobs().filter((job) => job.id !== input.id);
      const queuedBehind = queueAction !== "queue_behind"
        ? []
        : (queueReason === "project_concurrency" ? active.filter((job) => job.projectId === input.projectId) : active).map((job) => job.id);
      const job: Job = {
        ...input,
        status: "queued",
        queueAction,
        queueReason,
        queuedBehind,
        checkpointFrame: 0,
        checkpointShots: 0,
        retriesUsed: 0,
        costUsd: 0,
        nextEligibleAt: null,
        startedAt: null,
        leaseExpiresAt: null,
        claimedBy: null,
        resumedCount: 0,
        completedAt: null,
        linkExpiresAt: null,
        notifications: [],
      };
      this.jobs.set(job.id, job);
      return job;
    });
  }
  /**
   * Running-job mutations are bound to the claiming worker: a worker whose
   * lease lapsed (and whose job may already be running elsewhere) is refused
   * before any field is written, so it can neither clobber the new holder's
   * progress nor extend a lease it no longer owns.
   */
  private holder(id: string, workerId: string, now: number): Job {
    const job = this.must(id);
    if (job.status !== "running") throw new LeaseError(id, "not_running", job.claimedBy);
    if (job.claimedBy !== workerId) throw new LeaseError(id, "wrong_worker", job.claimedBy);
    if (!isRunningWithLease(job, now)) throw new LeaseError(id, "lease_expired", job.claimedBy);
    return job;
  }
  checkpoint(id: string, workerId: string, shotsCompleted: number, frames: number, now = Date.now(), leaseMs = DEFAULT_LEASE_MS,execution?:{records:ShotRenderRecord[];inventory:ShotExecutionInventoryRow[]}|CurrentFilmCheckpoint): void {
    this.transact(() => {
      const j = this.holder(id, workerId, now);
      validateLivingScriptJob(j);
      if(j.lipSync||j.soundMix||j.pictureEdit||j.assemblyEdit||j.graphicRender||j.delivery)throw new Error("Independent media progress requires an owned media checkpoint.");
      const leaseExpiresAt=new Date(now+leaseMs).toISOString();
      if(j.currentFilm){
        if(!execution||!("schema" in execution))throw new Error("Retain the explicit current-film checkpoint at every update.");
        const checked=advanceCurrentFilmCheckpoint(j,execution,shotsCompleted,frames);j.currentFilmCheckpoint=checked;
      }else if(execution!==undefined){
        if("schema" in execution)throw new Error("An ordinary job cannot accept current-film custody.");
        const checked=validateJobExecutionCheckpoint(j,execution);
        if(!["animatic","final"].includes(j.stage)||j.characterSheet||j.shotTakes||checked.records.length!==shotsCompleted||frames!==checked.records.reduce((total,record)=>total+Math.round(record.clip.durationSec*30),0))throw new Error("Worker execution evidence requires the exact complete film checkpoint.");
        const inventory=advanceShotExecutionInventory(j.executionCheckpoints,checked.inventory,checked.records,j.checkpointShots);
        j.executionCheckpoints=inventory;
      }else if(j.executionCheckpoints!==undefined)throw new Error("Retain the complete worker execution inventory at every subsequent checkpoint.");
      j.checkpointShots = shotsCompleted;
      j.checkpointFrame = frames;
      j.leaseExpiresAt = leaseExpiresAt;
    });
  }
  checkpointDialogue(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void{
    this.transact(()=>{const job=this.holder(id,workerId,now);validateDialogueOutput(job,output,now);if(job.dialogueCheckpoint&&contentHash(job.dialogueCheckpoint)!==contentHash(output))throw new Error("The dialogue checkpoint is immutable.");job.dialogueCheckpoint=structuredClone(output);job.checkpointFrame=job.totalFrames;job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  checkpointSound(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void{
    this.transact(()=>{const job=this.holder(id,workerId,now);validateSoundOutput(job,output);if(job.soundCheckpoint&&contentHash(job.soundCheckpoint)!==contentHash(output))throw new Error("The sound checkpoint is immutable.");job.soundCheckpoint=structuredClone(output);job.checkpointFrame=job.totalFrames;job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  checkpointEdit(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void{
    this.transact(()=>{const job=this.holder(id,workerId,now);validateEditOutput(job,output);if(job.editCheckpoint&&contentHash(job.editCheckpoint)!==contentHash(output))throw new Error("The editorial checkpoint is immutable.");job.editCheckpoint=structuredClone(output);job.checkpointFrame=job.totalFrames;job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  checkpointAssembly(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void{
    this.transact(()=>{const job=this.holder(id,workerId,now);validateEditAssemblyJob(job);if(!job.assemblyEdit)throw new Error("Only an assembly job can checkpoint assembly media.");validateEditAssemblyOutput({...job,assemblyEdit:job.assemblyEdit},output);if(job.assemblyCheckpoint&&contentHash(job.assemblyCheckpoint)!==contentHash(output))throw new Error("The assembly checkpoint is immutable.");job.assemblyCheckpoint=structuredClone(output);job.checkpointFrame=job.totalFrames;job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  checkpointLipSyncPrepared(id:string,workerId:string,prepared:LipSyncPrepared,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void{
    this.transact(()=>{const job=this.holder(id,workerId,now);validateLipSyncPrepared(job,prepared);if(job.lipSyncPrepared&&contentHash(job.lipSyncPrepared)!==contentHash(prepared))throw new Error("Prepared lip-sync inputs are immutable.");job.lipSyncPrepared=structuredClone(prepared);job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  checkpointLipSync(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void{
    this.transact(()=>{const job=this.holder(id,workerId,now);validateLipSyncOutput(job,output);if(!job.lipSyncPrepared||contentHash(job.lipSyncPrepared)!==contentHash(output.lipSync!.report.prepared)||job.lipSyncCheckpoint&&contentHash(job.lipSyncCheckpoint)!==contentHash(output))throw new Error("The lip-sync result differs from its saved inputs or output.");job.lipSyncCheckpoint=structuredClone(output);job.checkpointFrame=job.totalFrames;job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  reviewLipSync(id:string,input:Pick<LipSyncReview,"mouthSync"|"faceStability"|"expression"|"decision"|"notes">,expectedVersion:number,expectedOutputRevision:string,now=Date.now()):LipSyncReviews{
    return this.transact(()=>{const job=this.must(id),review=addLipSyncReview(job,input,expectedVersion,expectedOutputRevision,now);job.lipSyncReviews=review;return structuredClone(review);});
  }
  checkpointAudio(id:string,workerId:string,output:AudioTakeOutput,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void {
    this.transact(()=>{const job=this.holder(id,workerId,now);validateAudioTakeOutput(job,output);
      if(job.audioCheckpoint&&contentHash(job.audioCheckpoint)!==contentHash(output))throw new Error("The audio checkpoint is immutable.");
      job.audioCheckpoint=structuredClone(output);job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  progressGraphic(id:string,workerId:string,progress:GraphicProgress,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void {
    this.transact(()=>{const job=this.holder(id,workerId,now);validateGraphicJob(job);if(!job.graphicRender||job.graphicCheckpoint)throw new Error("Only an unfinished graphic capture can update progress.");validateGraphicProgress(progress,job.totalFrames);job.graphicProgress=structuredClone(progress);job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  checkpointGraphic(id:string,workerId:string,output:GraphicOutput,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void {
    this.transact(()=>{const job=this.holder(id,workerId,now);validateGraphicOutput(job,output);if(job.graphicCheckpoint&&contentHash(job.graphicCheckpoint)!==contentHash(output))throw new Error("The graphic checkpoint is immutable.");job.graphicCheckpoint=structuredClone(output);job.checkpointFrame=job.totalFrames;job.graphicProgress={phase:"retain",capturedFrames:job.totalFrames,at:new Date(now).toISOString()};job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  completeGraphic(id:string,workerId:string,output:GraphicOutput,now=Date.now()):Job {
    return this.transact(()=>{const job=this.holder(id,workerId,now);validateGraphicOutput(job,output);if(!job.graphicCheckpoint||contentHash(job.graphicCheckpoint)!==contentHash(output))throw new Error("Complete the retained graphic checkpoint before publishing.");job.status="done";job.graphicOutput=structuredClone(output);job.failureReason=undefined;job.failureKind=undefined;job.completedAt=new Date(now).toISOString();job.linkExpiresAt=new Date(now+DOWNLOAD_LINK_TTL_MS).toISOString();job.claimedBy=null;job.leaseExpiresAt=null;notify(job,"Your graphic is ready.");return job;});
  }
  /**
   * A deliverable is one file, so there is no partial progress to record: the checkpoint is the
   * whole thing, and it is immutable once taken, as every other media checkpoint is.
   */
  checkpointDelivery(id:string,workerId:string,output:DeliveryOutput,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):void {
    this.transact(()=>{const job=this.holder(id,workerId,now);validateDeliveryOutput(job,output);
      if(job.deliveryCheckpoint&&contentHash(job.deliveryCheckpoint)!==contentHash(output))throw new Error("The delivery checkpoint is immutable.");
      job.deliveryCheckpoint=structuredClone(output);job.checkpointFrame=job.totalFrames;job.leaseExpiresAt=new Date(now+leaseMs).toISOString();});
  }
  completeDelivery(id:string,workerId:string,output:DeliveryOutput,now=Date.now()):Job {
    return this.transact(()=>{const job=this.holder(id,workerId,now);validateDeliveryOutput(job,output);
      if(!job.deliveryCheckpoint||contentHash(job.deliveryCheckpoint)!==contentHash(output))throw new Error("Complete the retained delivery checkpoint before publishing.");
      job.status="done";job.deliveryOutput=structuredClone(output);job.failureReason=undefined;job.failureKind=undefined;
      job.completedAt=new Date(now).toISOString();job.linkExpiresAt=new Date(now+DOWNLOAD_LINK_TTL_MS).toISOString();
      job.claimedBy=null;job.leaseExpiresAt=null;notify(job,"Your deliverable is ready.");return job;});
  }
  completeAudio(id:string,workerId:string,output:AudioTakeOutput,now=Date.now()):Job {
    return this.transact(()=>{const job=this.holder(id,workerId,now);validateAudioTakeOutput(job,output);
      if(!job.audioCheckpoint||contentHash(job.audioCheckpoint)!==contentHash(output))throw new Error("Complete the saved audio checkpoint before publishing.");
      job.status="done";job.audioOutput=structuredClone(output);job.failureReason=undefined;job.failureKind=undefined;job.completedAt=new Date(now).toISOString();job.linkExpiresAt=new Date(now+DOWNLOAD_LINK_TTL_MS).toISOString();
      job.claimedBy=null;job.leaseExpiresAt=null;notify(job,"Your line audition is ready. Provider billing may still be pending reconciliation.");return job;});
  }
  recordRouteDecision(id: string, workerId: string, decision: RouteDecision, now = Date.now()): void {
    this.transact(() => {
      const job = this.holder(id, workerId, now);
      if(job.audioTake||job.lipSync||job.soundMix||job.pictureEdit||job.assemblyEdit||job.graphicRender||job.delivery)throw new Error("Independent media jobs do not use video routes.");
      if (!decision || decision.schema !== "hv-route-decision/1" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decision.id)
        || JSON.stringify(decision).length > 16_000 || !Array.isArray(decision.candidates) || decision.candidates.length < 1 || (decision.candidates.length > 8 && !(decision.candidates.length===9&&job.providerPlan?.pool.length===9&&job.providerPlan.pool.some(entry=>entry.spec==="anchor-storyboard")))
        || decision.planRevision !== (job.providerPlan?.revision ?? null)
        || (decision.selectedId !== null && !decision.candidates.some(candidate => candidate.id === decision.selectedId && candidate.eligible))) throw new Error("Invalid provider route decision.");
      validateRequirements(decision.requirements);
      if (!Number.isSafeInteger(decision.seed) || !/^[A-Za-z0-9_.-]{1,80}$/.test(decision.shotId) || !Number.isFinite(Date.parse(decision.at))) throw new Error("Invalid route context.");
      if (job.providerPlan) {
        const plan = job.providerPlan;
        if (decision.strategy !== plan.strategy || decision.candidates.length !== plan.pool.length
          || new Set(decision.candidates.map(value => value.id)).size !== plan.pool.length
          || Object.entries(plan.requirements).some(([key, value]) => decision.requirements[key as keyof typeof plan.requirements] !== value)) throw new Error("Provider route changed the admitted policy.");
        for (const candidate of decision.candidates) {
          const snapshot = plan.pool.find(value => value.spec === candidate.id)?.snapshot;
          const skippedDrift=candidate.id!==decision.selectedId&&!candidate.eligible&&candidate.reasons.includes("capability-changed");
          if (!snapshot || ((!skippedDrift)&&(candidate.provider !== snapshot.adapter || candidate.model !== snapshot.model)) || candidate.capabilityRevision !== snapshot.revision
            || candidate.priceVersion !== snapshot.priceVersion) throw new Error("Provider route changed the admitted capability.");
          const match = matchCapability(snapshot, decision.requirements, plan.maxShotUsd);
          if (candidate.estimateUsd !== match.estimateUsd || (candidate.eligible && !match.eligible)) throw new Error("Provider route changed the admitted estimate.");
        }
      }
      const decisions = job.routeDecisions ??= [];
      const previous = decisions.find(value => value.id === decision.id);
      if (previous) {if (contentHash(previous) !== contentHash(decision)) throw new Error("Provider route decision changed."); return;}
      if (decisions.length >= 8192) throw new Error("Provider route history reached its safety limit.");
      decisions.push(structuredClone(decision));
    });
  }
  /** Extends the running lease; a worker calls this between provider calls so a live job is never mistaken for an abandoned one. */
  heartbeat(id: string, workerId: string, now = Date.now(), leaseMs = DEFAULT_LEASE_MS): void {
    this.transact(() => {
      const j = this.holder(id, workerId, now);
      j.leaseExpiresAt = new Date(now + leaseMs).toISOString();
    });
  }
  setStatus(id: string, status: Job["status"]): void {
    this.transact(() => {
      const j = this.must(id);
      j.status = status;
      if (status !== "running") { j.leaseExpiresAt = null; j.claimedBy = null; }
    });
  }
  /**
   * Jobs whose worker died mid-run stay `running` with a lapsed lease. Return
   * them to the queue so they resume from their checkpoint (AC-024). Called at
   * worker start and folded into every claim.
   */
  recoverAbandoned(now = Date.now()): Job[] {
    return this.transact(() => this.requeueExpired(now));
  }
  /**
   * Returns every job this pass touched, resumed **and** dead-lettered, so a
   * caller that persists the result (the PostgreSQL store) writes both. The
   * status distinguishes them.
   */
  private requeueExpired(now: number): Job[] {
    const touched: Job[] = [];
    for (const job of this.jobs.values()) {
      if (!leaseExpired(job, now)) continue;
      job.leaseExpiresAt = null;
      job.claimedBy = null;
      const mark = progressMark(job);
      job.lapsesWithoutProgress = job.lapseProgressMark === mark ? (job.lapsesWithoutProgress ?? 0) + 1 : 1;
      job.lapseProgressMark = mark;
      if (job.lapsesWithoutProgress > MAX_LEASE_RECOVERIES) {
        // The terminus. Without it this job returns to the queue for ever,
        // holding a free-tier project's only concurrency slot. `resumedCount`
        // is deliberately not incremented here: nothing is being resumed, and
        // that number is served to the owner.
        job.status = "failed";
        job.failureKind = "dead_letter";
        job.failureReason = `This job was interrupted ${job.lapsesWithoutProgress} times without making progress and has been stopped. Nothing was charged.`;
        job.nextEligibleAt = null;
        job.completedAt = new Date(now).toISOString();
        notify(job, job.failureReason);
      } else {
        job.status = "queued";
        job.nextEligibleAt = null;
        job.resumedCount += 1;
        notify(job, "Your job was interrupted and will resume from its last checkpoint.");
      }
      touched.push(job);
    }
    return touched;
  }
  /**
   * How many jobs each project is running, and how many the studio is, counted once.
   *
   * HV-019-08: `eligibleToStart` used to materialise and filter every job in the store to count
   * one candidate's running siblings, and `claimNext` asks about every candidate, so a claim cost
   * Θ(queued × stored). Nothing in this package ever deletes a job from the JSON store, so both
   * grow forever. Measured in memory, with no file I/O at all:
   *
   * | jobs, all queued | one `claimNext` |
   * |---|---|
   * | 1,000 | 17 ms |
   * | 2,000 | 68 ms |
   * | 4,000 | 233 ms |
   * | 8,000 | 1,241 ms |
   *
   * Clean fourfold-per-doubling, and linear in the store at a fixed queue depth, so the cost is
   * queued × stored. It matters more than it looks: every store call is a full reload and rewrite
   * of `jobs.json` under the interprocess lock, and a single three-shot job issues about thirty
   * store transactions, so at 8,000 retained jobs one film spends seconds holding a lock the API's
   * own `enqueue` needs and `withFileLock` gives up on after ten.
   */
  private runningCounts(now: number): Map<string, number> {
    const byProject = new Map<string, number>();
    for (const job of this.jobs.values()) if (isRunningWithLease(job, now)) byProject.set(job.projectId, (byProject.get(job.projectId) ?? 0) + 1);
    return byProject;
  }
  private eligibleToStart(job: Job, now: number, running: Map<string, number>): boolean {
    if (job.status !== "queued") return false;
    if (job.nextEligibleAt && new Date(job.nextEligibleAt).getTime() > now) return false;
    for (const aheadId of job.queuedBehind) {
      const ahead = this.jobs.get(aheadId);
      if (ahead && !TERMINAL.has(ahead.status)) return false;
    }
    return (running.get(job.projectId) ?? 0) < TIERS[job.tier].maxConcurrent;
  }
  claimNext(now = Date.now(), fairShareWeights: Record<string, number> = {}, options: ClaimOptions = {}): Job | undefined {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    return this.transact(() => {
      this.requeueExpired(now);
      const running = this.runningCounts(now);
      const eligible = [...this.jobs.values()].filter((candidate) => this.eligibleToStart(candidate, now, running));
      if (eligible.length === 0) return undefined;
      const order = fairShareOrder(eligible.map((candidate) => ({
        jobId: candidate.id,
        projectId: candidate.projectId,
        gpuSecondsUsed: fairShareWeights[candidate.projectId] ?? 0,
        priority: candidate.tier === "elevated" ? 0 : 1,
      })));
      const job = eligible.find((candidate) => candidate.id === order[0]);
      if (!job) return undefined;
      assertCurrentFilmMode(job);
      // Private checkpoint inputs are reproduced at their original execution time.
      // Current leases, permissions and worker timeouts are checked independently.
      if((job.executionCheckpoints!==undefined||job.currentFilmCheckpoint!==undefined)&&(!job.startedAt||!Number.isFinite(Date.parse(job.startedAt))))throw new Error("Retain the original execution time with the private checkpoint.");
      if(job.currentFilm)validateCurrentFilmJob(job);
      job.status = "running";
      if(job.executionCheckpoints===undefined&&job.currentFilmCheckpoint===undefined)job.startedAt = new Date(now).toISOString();
      job.nextEligibleAt = null;
      job.leaseExpiresAt = new Date(now + leaseMs).toISOString();
      job.claimedBy = options.workerId ?? crypto.randomUUID();
      return job;
    });
  }
  complete(id: string, workerId: string, output: NonNullable<Job["output"]>, now = Date.now()): Job {
    return this.transact(() => {
      const job = this.holder(id, workerId, now);
      validateLivingScriptJob(job);validateLivingScriptOutput(job,output);
      validateCurrentFilmOutput(job,output);
      if(job.audioTake||job.graphicRender||job.delivery)throw new Error("Independent audio, graphics and deliverables require their own completion transaction.");
      if(job.stage==="dialogue-replacement"){validateDialogueOutput(job,output,now);if(!job.dialogueCheckpoint||contentHash(job.dialogueCheckpoint)!==contentHash(output))throw new Error("Complete the saved dialogue checkpoint before publishing.");}
      if(job.lipSync){validateLipSyncOutput(job,output);if(!job.lipSyncCheckpoint||contentHash(job.lipSyncCheckpoint)!==contentHash(output))throw new Error("Complete the saved lip-sync checkpoint before publishing.");}
      if(job.soundMix){validateSoundOutput(job,output);if(!job.soundCheckpoint||contentHash(job.soundCheckpoint)!==contentHash(output))throw new Error("Complete the saved sound checkpoint before publishing.");}
      if(job.pictureEdit){validateEditOutput(job,output);if(!job.editCheckpoint||contentHash(job.editCheckpoint)!==contentHash(output))throw new Error("Complete the saved editorial checkpoint before publishing.");}
      validateEditAssemblyJob(job);if(job.assemblyEdit){validateEditAssemblyOutput({...job,assemblyEdit:job.assemblyEdit},output);if(!job.assemblyCheckpoint||contentHash(job.assemblyCheckpoint)!==contentHash(output))throw new Error("Complete the saved assembly checkpoint before publishing.");}
      validateShotExecutionOutput(job,output);
      if(job.executionCheckpoints!==undefined||output.shotExecutions!==undefined||job.currentFilm)output=structuredClone(output);
      job.status = "done";
      job.output = output;
      job.failureReason = undefined;
      job.failureKind = undefined;
      job.leaseExpiresAt = null;
      job.claimedBy = null;
      job.completedAt = new Date(now).toISOString();
      job.linkExpiresAt = new Date(now + DOWNLOAD_LINK_TTL_MS).toISOString();
      return job;
    });
  }
  fail(id: string, workerId: string, reason: string, now = Date.now()): Job {
    return this.transact(() => {
      const job = this.holder(id, workerId, now);
      job.retriesUsed += 1;
      job.failureReason = reason.slice(0, 2000);
      job.failureKind = undefined;
      if(job.executionCheckpoints===undefined&&job.currentFilmCheckpoint===undefined)job.startedAt = null;
      job.leaseExpiresAt = null;
      job.claimedBy = null;
      if (job.retriesUsed <= job.retryPolicy.maxRetries) {
        job.status = "queued";
        job.nextEligibleAt = new Date(now + job.retryPolicy.backoffMs * 2 ** (job.retriesUsed - 1)).toISOString();
      } else {
        job.status = "failed";
        job.nextEligibleAt = null;
      }
      return job;
    });
  }
  /** Terminal, non-retried outcome for a content-policy refusal; the reason is the user-facing refusal message. */
  refuse(id: string, workerId: string, reason: string, now = Date.now()): Job {
    return this.transact(() => {
      const job = this.holder(id, workerId, now);
      job.status = "failed";
      job.failureKind = "policy_refusal";
      job.failureReason = reason.slice(0, 2000);
      job.nextEligibleAt = null;
      if(job.executionCheckpoints===undefined&&job.currentFilmCheckpoint===undefined)job.startedAt = null;
      job.leaseExpiresAt = null;
      job.claimedBy = null;
      job.completedAt = new Date(now).toISOString();
      notify(job, job.failureReason);
      return job;
    });
  }
  /**
   * Revocation. Every job of a project that may no longer generate stops here.
   *
   * This is not `cancel`: `cancel` is a *worker* action and requires the lease
   * holder, so nothing outside a running worker could ever stop that worker's
   * job. Revocation comes from outside the queue — a takedown, and later a
   * legal hold or a withdrawn consent — and must not need the lease of the very
   * job it is stopping. Clearing `claimedBy` and `leaseExpiresAt` is what makes
   * a *running* job stop: the worker refreshes its lease on a timer, that
   * refresh goes through `holder()`, and `holder()` now raises `not_running`,
   * which aborts the in-flight provider call through the job's abort signal.
   *
   * Terminal jobs are never touched. A delivered cut is an already-issued
   * record; revoking future generation does not rewrite what was already made,
   * and a takedown that mutated completed job bodies would be falsifying
   * history rather than stopping work.
   */
  revokeProject(projectId: string, reason: string, now = Date.now()): Job[] {
    return this.transact(() => {
      const revoked: Job[] = [];
      for (const job of this.jobs.values()) {
        if (job.projectId !== projectId || TERMINAL.has(job.status)) continue;
        job.status = "cancelled";
        job.cancelReason = reason;
        notify(job, reason);
        job.completedAt = new Date(now).toISOString();
        job.claimedBy = null;
        job.leaseExpiresAt = null;
        job.nextEligibleAt = null;
        revoked.push(job);
      }
      return structuredClone(revoked);
    });
  }
  cancel(id: string, workerId: string, reason: string, now = Date.now()): Job {
    return this.transact(() => {
      const job = this.holder(id, workerId, now);
      job.status = "cancelled";
      job.cancelReason = reason;
      notify(job, reason);
      job.completedAt = new Date(now).toISOString();
      job.claimedBy = null;
      job.leaseExpiresAt = null;
      return job;
    });
  }
  recordCost(id: string, workerId: string, cost: CostRecord, now = Date.now()): Job {
    return this.transact(() => {
      const j = this.holder(id, workerId, now);
      if(j.audioTake||j.lipSync||j.soundMix||j.pictureEdit||j.assemblyEdit||j.graphicRender||j.delivery)throw new Error("Performance costs require invoice allocation evidence.");
      j.cost = cost;
      j.costUsd = Number((j.costUsd + cost.total_cost_usd).toFixed(6));
      if (j.costUsd > j.costCapUsd) {
        j.status = "cancelled";
        j.leaseExpiresAt = null;
        j.claimedBy = null;
        j.cancelReason = `cost $${j.costUsd.toFixed(2)} exceeded per-job cap $${j.costCapUsd.toFixed(2)}`;
        notify(j, costCapCancelNotice(j.cancelReason!));
      }
      return j;
    });
  }
  get(id: string): Job | undefined { this.reload(); return this.jobs.get(id); }
  all(): Job[] { this.reload(); return [...this.jobs.values()]; }
  /** HV-032-08: the ids a reservation may still belong to, without copying every job. */
  activeJobIds(): Set<string> {
    this.reload();
    const active = new Set<string>();
    for (const job of this.jobs.values()) if (job.status === "queued" || job.status === "running") active.add(job.id);
    return active;
  }
  private must(id: string): Job {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    return j;
  }
}

export type CapacityDecision =
  | { action: "run"; reason: "capacity_available"; message?: undefined }
  | { action: "queue_behind"; reason: "project_concurrency" | "budget_throttle"; message: string }
  | { action: "reject"; reason: "shot_limit" | "budget_exhausted"; message: string };

export class CapacityController {
  constructor(private budgetMonthlyUsd = 5000) {}
  /**
   * `requestedUsd`, when given, is what the job will hold against the budget. HV-027-11: a job that
   * holds nothing (a deliverable, a sound mix, an editorial or assembly export, a motion graphic)
   * calls no provider and spends nothing, so the month's spend neither refuses it nor throttles it.
   * One project's paid renders used to stop every other creator from exporting a finished film, with
   * a message about a saved script. Concurrency and the shot limit still apply.
   */
  decide(opts: { tier: Tier; runningForProject: number; requestedShots: number; sceneCount?: number; monthSpendUsd: number; requestedUsd?: number }): CapacityDecision {
    const t = TIERS[opts.tier];
    if (opts.requestedShots > t.maxShots) {
      const message = opts.sceneCount !== undefined && opts.sceneCount > t.maxShots
        ? `This tier supports screenplays with up to ${t.maxShots} scenes; this one has ${opts.sceneCount}. Combine some scenes and try again.`
        : `This tier allows up to ${t.maxShots} shots per project.`;
      return { action: "reject", reason: "shot_limit", message };
    }
    const utilization = opts.requestedUsd === 0 ? 0 : opts.monthSpendUsd / this.budgetMonthlyUsd;
    if (utilization >= 1) {
      return { action: "reject", reason: "budget_exhausted", message: "We're at capacity right now. Your script is saved — please try again soon." };
    }
    if (opts.runningForProject >= t.maxConcurrent) {
      return { action: "queue_behind", reason: "project_concurrency", message: "Queued behind your running job." };
    }
    if (utilization >= 0.8 && opts.tier === "free") {
      return { action: "queue_behind", reason: "budget_throttle", message: "High demand — your job is queued and will start shortly." };
    }
    return { action: "run", reason: "capacity_available" };
  }
}

/**
 * How far back GPU usage counts toward a project's fair-share weight.
 *
 * Declared here, beside the ordering it feeds, because two cost ledgers
 * compute the weight — one over JSON, one in SQL — and a horizon written twice
 * is a horizon that can differ. Before this existed the weight was every event
 * the ledger had ever recorded, which inverts FR-029: a project that rendered
 * on its first day sat behind every newer project for the remaining twenty-nine
 * days of its retention, however idle it had been. That is one project starving
 * another, which is the thing FR-029 forbids.
 *
 * The number is a policy choice, not a derived one. A day matches the `day`
 * rollup the ledgers already compute beside this, is long enough that a heavy
 * project cannot reset its weight between two renders of the kind this service
 * produces, and is short enough to be well inside the thirty-day project
 * retention. It is a hard window rather than a decay curve, so a project's
 * weight does step down as its oldest events age out; a scheduler is allowed
 * that, and the alternative — a half-life — would put a second policy number
 * in the same place without removing the first.
 */
export const FAIR_SHARE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True when an event at `at` still counts toward fair share at `now`.
 *
 * An unparseable timestamp is `NaN`, and every comparison with `NaN` is false,
 * so such an event simply does not count -- no explicit guard. A first draft
 * had `Number.isFinite(recorded) &&` in front of the comparison; perturbation
 * Q6 removed it and nothing failed, because it never decided anything. A
 * redundant check that a test appears to cover is worse than no check, so it
 * is gone and the behaviour is asserted instead.
 */
export function withinFairShareWindow(at: string, now: number): boolean {
  return new Date(at).getTime() >= now - FAIR_SHARE_WINDOW_MS;
}

export function fairShareOrder(
  pending: { jobId: string; projectId: string; gpuSecondsUsed: number; priority?: number }[],
): string[] {
  return [...pending]
    .sort((a, b) =>
      (a.priority ?? 0) - (b.priority ?? 0)
      || a.gpuSecondsUsed - b.gpuSecondsUsed
      || a.jobId.localeCompare(b.jobId))
    .map((p) => p.jobId);
}
