import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CostRecord } from "../../generator/src/index";

export type Tier = "free" | "elevated";
export const TIERS: Record<Tier, { maxConcurrent: number; maxShots: number; maxResolution: string }> = {
  free: { maxConcurrent: 1, maxShots: 24, maxResolution: "1280x720" },
  elevated: { maxConcurrent: 3, maxShots: 60, maxResolution: "1920x1080" },
};

export interface RetryPolicy { maxRetries: number; backoffMs: number }
export interface Job {
  id: string;
  idempotencyKey: string;
  projectId: string;
  tier: Tier;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  checkpointFrame: number;
  totalFrames: number;
  retryPolicy: RetryPolicy;
  retriesUsed: number;
  timeoutMs: number;
  costCapUsd: number;
  scriptText: string;
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
}

export class DurableJobStore {
  private jobs = new Map<string, Job>();
  constructor(private path: string) {
    this.reload();
  }
  private reload(): void {
    if (existsSync(this.path)) {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as Job[];
      this.jobs.clear();
      for (const j of data) this.jobs.set(j.id, j);
    }
  }
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.jobs.values()], null, 2));
    renameSync(tmp, this.path);
  }
  enqueue(input: Omit<Job, "status" | "checkpointFrame" | "retriesUsed" | "notifications">): Job {
    this.reload();
    const existing = [...this.jobs.values()].find((j) => j.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const job: Job = { ...input, status: "queued", checkpointFrame: 0, retriesUsed: 0, notifications: [] };
    this.jobs.set(job.id, job);
    this.persist();
    return job;
  }
  checkpoint(id: string, frame: number): void {
    const j = this.must(id);
    j.checkpointFrame = frame;
    this.persist();
  }
  setStatus(id: string, status: Job["status"]): void { this.must(id).status = status; this.persist(); }
  claimNext(): Job | undefined {
    this.reload();
    const job = [...this.jobs.values()]
      .filter((candidate) => candidate.status === "queued")
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!job) return undefined;
    job.status = "running";
    this.persist();
    return job;
  }
  complete(id: string, output: NonNullable<Job["output"]>): Job {
    const job = this.must(id);
    job.status = "done";
    job.output = output;
    job.failureReason = undefined;
    this.persist();
    return job;
  }
  fail(id: string, reason: string): Job {
    const job = this.must(id);
    job.retriesUsed += 1;
    job.failureReason = reason.slice(0, 2000);
    job.status = job.retriesUsed <= job.retryPolicy.maxRetries ? "queued" : "failed";
    this.persist();
    return job;
  }
  recordCost(id: string, cost: CostRecord): Job {
    const j = this.must(id);
    j.cost = cost;
    if (cost.total_cost_usd > j.costCapUsd) {
      j.status = "cancelled";
      j.cancelReason = `cost $${cost.total_cost_usd.toFixed(2)} exceeded per-job cap $${j.costCapUsd.toFixed(2)}`;
      j.notifications.push(`Your shot was cancelled: ${j.cancelReason}. You were not charged — this project is operator-funded.`);
    }
    this.persist();
    return j;
  }
  get(id: string): Job | undefined { this.reload(); return this.jobs.get(id); }
  all(): Job[] { this.reload(); return [...this.jobs.values()]; }
  private must(id: string): Job {
    this.reload();
    const j = this.jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    return j;
  }
}

export interface CapacityDecision { action: "run" | "queue_behind" | "reject"; message?: string }

export class CapacityController {
  constructor(private budgetMonthlyUsd = 5000) {}
  decide(opts: { tier: Tier; runningForProject: number; requestedShots: number; monthSpendUsd: number }): CapacityDecision {
    const t = TIERS[opts.tier];
    if (opts.requestedShots > t.maxShots) {
      return { action: "reject", message: `This tier allows up to ${t.maxShots} shots per project.` };
    }
    const utilization = opts.monthSpendUsd / this.budgetMonthlyUsd;
    if (utilization >= 1) {
      return { action: "reject", message: "We're at capacity right now. Your script is saved — please try again soon." };
    }
    if (opts.runningForProject >= t.maxConcurrent) {
      return { action: "queue_behind", message: "Queued behind your running job." };
    }
    if (utilization >= 0.8) {
      return { action: "queue_behind", message: "High demand — your job is queued and will start shortly." };
    }
    return { action: "run" };
  }
}

export function fairShareOrder(pending: { jobId: string; projectId: string; gpuSecondsUsed: number }[]): string[] {
  return [...pending]
    .sort((a, b) => a.gpuSecondsUsed - b.gpuSecondsUsed || a.jobId.localeCompare(b.jobId))
    .map((p) => p.jobId);
}
