import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CostRecord } from "../../generator/src/index";
import { withFileLock } from "./persist";

export type Tier = "free" | "elevated";
export const TIERS: Record<Tier, { maxConcurrent: number; maxShots: number; maxResolution: string }> = {
  free: { maxConcurrent: 1, maxShots: 24, maxResolution: "1280x720" },
  elevated: { maxConcurrent: 3, maxShots: 60, maxResolution: "1920x1080" },
};

export type JobStage = "animatic" | "final";
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
  costUsd: number;
  scriptText: string;
  rightsAttestedAt: string | null;
  animaticJobId: string | null;
  animaticApprovedAt: string | null;
  nextEligibleAt: string | null;
  startedAt: string | null;
  leaseExpiresAt: string | null;
  claimedBy: string | null;
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
  };
  failureReason?: string;
  /** A content-policy refusal is deterministic: the job fails terminally and is never retried. */
  failureKind?: "policy_refusal";
}

type AutoFields =
  | "status" | "queueAction" | "queueReason" | "queuedBehind" | "checkpointFrame" | "checkpointShots" | "retriesUsed"
  | "notifications" | "costUsd" | "nextEligibleAt" | "startedAt" | "leaseExpiresAt" | "claimedBy" | "resumedCount"
  | "completedAt" | "linkExpiresAt";

export type JobInput = Omit<Job, AutoFields> & { queueAction?: QueueAction; queueReason?: QueueReason };

export interface ClaimOptions { workerId?: string; leaseMs?: number }

export type LeaseErrorReason = "not_running" | "wrong_worker" | "lease_expired";

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
  constructor(private path: string) {
    this.reload();
  }
  private reload(): void {
    if (existsSync(this.path)) {
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
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.jobs.values()], null, 2));
    renameSync(tmp, this.path);
  }
  /** Every mutation reloads under the interprocess lock, applies, and persists, so API and worker processes never lose each other's writes. */
  private transact<T>(fn: () => T): T {
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
      if (existing) return existing;
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
      j.checkpointShots = shotsCompleted;
      j.checkpointFrame = frames;
      j.leaseExpiresAt = new Date(now + leaseMs).toISOString();
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
  recordCost(id: string, workerId: string, cost: CostRecord, now = Date.now()): Job {
    return this.transact(() => {
      const j = this.holder(id, workerId, now);
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
