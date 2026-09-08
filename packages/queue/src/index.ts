import {isTakeStage,generationStage,type JobStage} from "../../planner/src/render-stage";
import {validateGraphicJob,validateGraphicOutput,validateGraphicProgress,assertGraphicIdempotency,type GraphicJobPlan,type GraphicOutput,type GraphicProgress} from "../../planner/src/graphic-jobs";
import {validateSoundJob,validateSoundOutput,assertSoundIdempotency} from "../../planner/src/sound-jobs";
import {validateEditJob,validateEditOutput,assertEditIdempotency} from "../../planner/src/edit-jobs";
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
  graphicRender?:GraphicJobPlan;
  graphicCheckpoint?:GraphicOutput;
  graphicOutput?:GraphicOutput;
  graphicProgress?:GraphicProgress;
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
    dialogue?:import("../../planner/src/dialogue-jobs").DialogueOutput;
    lipSync?:import("../../planner/src/lipsync").LipSyncOutput;
    sound?:import("../../planner/src/sound-jobs").SoundOutput;
    editorial?:import("../../planner/src/edit-jobs").EditOutput;
    shotRenders?:import("../../planner/src/shot-reuse").ShotRenderRecord[];
    sheetPath?: string;
    takeClips?:{id:string;label:string;path:string;hlsPath:string;posterPath:string;captionsPath:string;manifestPath:string;durationSec:number;seed:number;sha256:string;costUsd:number;mode:"preview"|"video"|"storyboard"|"synthetic"}[];
    picturePerformances?:{shotId:string;intent:import("../../planner/src/picture-performance").PicturePerformance}[];
    cameraPathRenders?:({shotId:string}&NonNullable<import("../../generator/src/index").VideoClip["cameraPathControl"]>)[];
    frameAnchorRenders?:{shotId:string;mode:"native"|"storyboard";positions:number[]}[];
    storyboard?: { shotId: string; path: string; sourcePath?:string;caption: string; sha256?: string }[];
  };
  failureReason?: string;
  /** A content-policy refusal is deterministic: the job fails terminally and is never retried. */
  failureKind?: "policy_refusal";
}

type AutoFields =
  | "status" | "queueAction" | "queueReason" | "queuedBehind" | "checkpointFrame" | "checkpointShots" | "retriesUsed"
  | "notifications" | "costUsd" | "nextEligibleAt" | "startedAt" | "leaseExpiresAt" | "claimedBy" | "resumedCount"
  | "completedAt" | "linkExpiresAt" | "leaseVersion";

export type JobInput = Omit<Job, AutoFields> & { queueAction?: QueueAction; queueReason?: QueueReason };

export interface ClaimOptions { workerId?: string; leaseMs?: number }

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

export class DurableJobStore {
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
      const existing = [...this.jobs.values()].find((j) => j.projectId === input.projectId && j.idempotencyKey === input.idempotencyKey);
      assertDialogueIdempotency(existing,input);
      assertAudioTakeIdempotency(existing,input);
      assertLipSyncIdempotency(existing,input);
      assertSoundIdempotency(existing,input);
      assertEditIdempotency(existing,input);
      assertGraphicIdempotency(existing,input);
      if(existing&&(input.shotTakes||isTakeStage(existing.stage))&&(existing.stage!==input.stage||existing.shotTakes?.revision!==input.shotTakes?.revision))throw new Error("The idempotency key belongs to a different take plan or render stage.");
      if (existing) return existing;
      validateGraphicJob(input);if(input.graphicCheckpoint||input.graphicOutput||input.graphicProgress)throw new Error("New graphic jobs cannot carry completed media or progress.");
      validateDialogueJob(input);
      validateAudioTake(input);
      validateLipSyncJob(input);
      validateSoundJob(input,Date.now());if(input.soundMix&&(input.soundCheckpoint||input.output))throw new Error("New sound jobs cannot carry completed media.");
      validateEditJob(input,Date.now());if(input.pictureEdit&&(input.editCheckpoint||input.output))throw new Error("New editorial jobs cannot carry completed media.");
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
  checkpoint(id: string, workerId: string, shotsCompleted: number, frames: number, now = Date.now(), leaseMs = DEFAULT_LEASE_MS): void {
    this.transact(() => {
      const j = this.holder(id, workerId, now);
      if(j.lipSync||j.soundMix||j.pictureEdit||j.graphicRender)throw new Error("Independent media progress requires an owned media checkpoint.");
      j.checkpointShots = shotsCompleted;
      j.checkpointFrame = frames;
      j.leaseExpiresAt = new Date(now + leaseMs).toISOString();
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
    return this.transact(()=>{const job=this.holder(id,workerId,now);validateGraphicOutput(job,output);if(!job.graphicCheckpoint||contentHash(job.graphicCheckpoint)!==contentHash(output))throw new Error("Complete the retained graphic checkpoint before publishing.");job.status="done";job.graphicOutput=structuredClone(output);job.failureReason=undefined;job.failureKind=undefined;job.completedAt=new Date(now).toISOString();job.linkExpiresAt=new Date(now+DOWNLOAD_LINK_TTL_MS).toISOString();job.claimedBy=null;job.leaseExpiresAt=null;job.notifications.push("Your graphic is ready.");return job;});
  }
  completeAudio(id:string,workerId:string,output:AudioTakeOutput,now=Date.now()):Job {
    return this.transact(()=>{const job=this.holder(id,workerId,now);validateAudioTakeOutput(job,output);
      if(!job.audioCheckpoint||contentHash(job.audioCheckpoint)!==contentHash(output))throw new Error("Complete the saved audio checkpoint before publishing.");
      job.status="done";job.audioOutput=structuredClone(output);job.failureReason=undefined;job.failureKind=undefined;job.completedAt=new Date(now).toISOString();job.linkExpiresAt=new Date(now+DOWNLOAD_LINK_TTL_MS).toISOString();
      job.claimedBy=null;job.leaseExpiresAt=null;job.notifications.push("Your line audition is ready. Provider billing may still be pending reconciliation.");return job;});
  }
  recordRouteDecision(id: string, workerId: string, decision: RouteDecision, now = Date.now()): void {
    this.transact(() => {
      const job = this.holder(id, workerId, now);
      if(job.audioTake||job.lipSync||job.soundMix||job.pictureEdit||job.graphicRender)throw new Error("Independent media jobs do not use video routes.");
      if (!decision || decision.schema !== "hv-route-decision/1" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decision.id)
        || JSON.stringify(decision).length > 16_000 || !Array.isArray(decision.candidates) || decision.candidates.length < 1 || decision.candidates.length > 8
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
          if (!snapshot || candidate.provider !== snapshot.adapter || candidate.model !== snapshot.model || candidate.capabilityRevision !== snapshot.revision
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
  private requeueExpired(now: number): Job[] {
    const recovered: Job[] = [];
    for (const job of this.jobs.values()) {
      if (!leaseExpired(job, now)) continue;
      job.status = "queued";
      job.nextEligibleAt = null;
      job.leaseExpiresAt = null;
      job.claimedBy = null;
      job.resumedCount += 1;
      job.notifications.push("Your job was interrupted and will resume from its last checkpoint.");
      recovered.push(job);
    }
    return recovered;
  }
  private eligibleToStart(job: Job, now: number): boolean {
    if (job.status !== "queued") return false;
    if (job.nextEligibleAt && new Date(job.nextEligibleAt).getTime() > now) return false;
    for (const aheadId of job.queuedBehind) {
      const ahead = this.jobs.get(aheadId);
      if (ahead && !TERMINAL.has(ahead.status)) return false;
    }
    const runningForProject = [...this.jobs.values()].filter((other) => other.projectId === job.projectId && isRunningWithLease(other, now)).length;
    return runningForProject < TIERS[job.tier].maxConcurrent;
  }
  claimNext(now = Date.now(), gpuSecondsByProject: Record<string, number> = {}, options: ClaimOptions = {}): Job | undefined {
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    return this.transact(() => {
      this.requeueExpired(now);
      const eligible = [...this.jobs.values()].filter((candidate) => this.eligibleToStart(candidate, now));
      if (eligible.length === 0) return undefined;
      const order = fairShareOrder(eligible.map((candidate) => ({
        jobId: candidate.id,
        projectId: candidate.projectId,
        gpuSecondsUsed: gpuSecondsByProject[candidate.projectId] ?? 0,
        priority: candidate.tier === "elevated" ? 0 : 1,
      })));
      const job = eligible.find((candidate) => candidate.id === order[0]);
      if (!job) return undefined;
      job.status = "running";
      job.startedAt = new Date(now).toISOString();
      job.nextEligibleAt = null;
      job.leaseExpiresAt = new Date(now + leaseMs).toISOString();
      job.claimedBy = options.workerId ?? crypto.randomUUID();
      return job;
    });
  }
  complete(id: string, workerId: string, output: NonNullable<Job["output"]>, now = Date.now()): Job {
    return this.transact(() => {
      const job = this.holder(id, workerId, now);
      if(job.audioTake||job.graphicRender)throw new Error("Independent audio and graphics require their own completion transaction.");
      if(job.stage==="dialogue-replacement"){validateDialogueOutput(job,output,now);if(!job.dialogueCheckpoint||contentHash(job.dialogueCheckpoint)!==contentHash(output))throw new Error("Complete the saved dialogue checkpoint before publishing.");}
      if(job.lipSync){validateLipSyncOutput(job,output);if(!job.lipSyncCheckpoint||contentHash(job.lipSyncCheckpoint)!==contentHash(output))throw new Error("Complete the saved lip-sync checkpoint before publishing.");}
      if(job.soundMix){validateSoundOutput(job,output);if(!job.soundCheckpoint||contentHash(job.soundCheckpoint)!==contentHash(output))throw new Error("Complete the saved sound checkpoint before publishing.");}
      if(job.pictureEdit){validateEditOutput(job,output);if(!job.editCheckpoint||contentHash(job.editCheckpoint)!==contentHash(output))throw new Error("Complete the saved editorial checkpoint before publishing.");}
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
      job.startedAt = null;
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
      job.startedAt = null;
      job.leaseExpiresAt = null;
      job.claimedBy = null;
      job.completedAt = new Date(now).toISOString();
      job.notifications.push(job.failureReason);
      return job;
    });
  }
  cancel(id: string, workerId: string, reason: string, now = Date.now()): Job {
    return this.transact(() => {
      const job = this.holder(id, workerId, now);
      job.status = "cancelled";
      job.cancelReason = reason;
      job.notifications.push(reason);
      job.completedAt = new Date(now).toISOString();
      job.claimedBy = null;
      job.leaseExpiresAt = null;
      return job;
    });
  }
  recordCost(id: string, workerId: string, cost: CostRecord, now = Date.now()): Job {
    return this.transact(() => {
      const j = this.holder(id, workerId, now);
      if(j.audioTake||j.lipSync||j.soundMix||j.pictureEdit||j.graphicRender)throw new Error("Performance costs require invoice allocation evidence.");
      j.cost = cost;
      j.costUsd = Number((j.costUsd + cost.total_cost_usd).toFixed(6));
      if (j.costUsd > j.costCapUsd) {
        j.status = "cancelled";
        j.leaseExpiresAt = null;
        j.claimedBy = null;
        j.cancelReason = `cost $${j.costUsd.toFixed(2)} exceeded per-job cap $${j.costCapUsd.toFixed(2)}`;
        j.notifications.push(`Your shot was cancelled: ${j.cancelReason}. You were not charged — this project is operator-funded.`);
      }
      return j;
    });
  }
  get(id: string): Job | undefined { this.reload(); return this.jobs.get(id); }
  all(): Job[] { this.reload(); return [...this.jobs.values()]; }
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
  decide(opts: { tier: Tier; runningForProject: number; requestedShots: number; sceneCount?: number; monthSpendUsd: number }): CapacityDecision {
    const t = TIERS[opts.tier];
    if (opts.requestedShots > t.maxShots) {
      const message = opts.sceneCount !== undefined && opts.sceneCount > t.maxShots
        ? `This tier supports screenplays with up to ${t.maxShots} scenes; this one has ${opts.sceneCount}. Combine some scenes and try again.`
        : `This tier allows up to ${t.maxShots} shots per project.`;
      return { action: "reject", reason: "shot_limit", message };
    }
    const utilization = opts.monthSpendUsd / this.budgetMonthlyUsd;
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
