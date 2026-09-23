import { existsSync } from "node:fs";
import type { CostRecord } from "../../generator/src/index";
import { readJsonFile, writeJsonFile, withFileLock } from "../../queue/src/persist";
import { withinFairShareWindow } from "../../queue/src/index";

export interface CostEvent extends CostRecord { eventId?: string; attemptId?: string; routeDecisionId?: string; at: string; projectId: string; shotId: string; jobId?: string; stage?: import("../../queue/src/index").JobStage }
export interface BudgetReservation { jobId: string; stage: import("../../queue/src/index").JobStage; amountUsd: number; remainingUsd: number; createdAt: string }
interface LedgerState { events: CostEvent[]; reservations: BudgetReservation[] }

export class BudgetError extends Error {
  override readonly name = "BudgetError";
}

export class CostLedger {
  private state: LedgerState = { events: [], reservations: [] };
  constructor(private path?: string) { this.reload(); }
  private reload(): void {
    if (!this.path || !existsSync(this.path)) return;
    // HV-038-06: the file exists and does not parse. This ledger always refused that; it refuses it
    // by name now, rather than by the `!raw` check below happening to catch it.
    let raw: CostEvent[] | LedgerState | null;
    try { raw = readJsonFile<CostEvent[] | LedgerState>(this.path); }
    catch { throw new BudgetError("cost ledger is unreadable; generation is paused"); }
    if(raw&&!Array.isArray(raw)&&(raw as LedgerState&{lipSyncAttempts?:unknown}).lipSyncAttempts!==undefined)throw new BudgetError("Lip-sync accounting requires PostgreSQL restore; JSON rollback cannot discard its attempt journal.");
    if(raw&&!Array.isArray(raw)&&(raw as LedgerState&{audioAttempts?:unknown[]}).audioAttempts?.length)throw new BudgetError("Audio accounting requires PostgreSQL restore; JSON rollback cannot discard its attempt journal.");
    if (!raw || (!Array.isArray(raw) && (!Array.isArray(raw.events) || !Array.isArray(raw.reservations)))) {
      throw new BudgetError("cost ledger is unreadable; generation is paused");
    }
    this.state = Array.isArray(raw) ? { events: raw, reservations: [] } : raw;
  }
  private transact<T>(fn: () => T): T {
    const apply = () => {
      this.reload();
      const result = fn();
      if (this.path) writeJsonFile(this.path, this.state);
      return result;
    };
    return this.path ? withFileLock(this.path, apply) : apply();
  }
  private spend(now: Date): number {
    const cutoff = now.getTime() - 2592e6;
    return this.state.events.filter(e => new Date(e.at).getTime() >= cutoff).reduce((sum, e) => sum + e.total_cost_usd, 0);
  }
  /** HV-019-04: what one film has spent, and what its listed jobs still hold. */
  filmSpend(projectId: string, jobIds: ReadonlySet<string>): {spentUsd: number; heldUsd: number} {
    this.reload();
    const spentUsd = this.state.events.filter(event => event.projectId === projectId).reduce((sum, event) => sum + event.total_cost_usd, 0);
    const heldUsd = this.state.reservations.filter(reservation => jobIds.has(reservation.jobId)).reduce((sum, reservation) => sum + reservation.remainingUsd, 0);
    return {spentUsd: Number(spentUsd.toFixed(6)), heldUsd: Number(heldUsd.toFixed(6))};
  }
  reserve(jobId: string, stage: import("../../queue/src/index").JobStage, amountUsd: number, monthlyCapUsd: number, now = new Date()): void {
    if (!Number.isFinite(amountUsd) || amountUsd < 0 || !Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) throw new BudgetError("invalid generation budget");
    this.transact(() => {
      const existing = this.state.reservations.find(r => r.jobId === jobId);
      if (existing) {
        if (existing.stage !== stage || existing.amountUsd !== amountUsd) throw new BudgetError("job budget changed while reserved");
        return;
      }
      const alreadySpent = this.state.events.filter(e => e.jobId === jobId).reduce((sum, e) => sum + e.total_cost_usd, 0);
      const remainingUsd = Math.max(0, amountUsd - alreadySpent);
      const held = this.state.reservations.reduce((sum, r) => sum + r.remainingUsd, 0);
      if (this.spend(now) + held + remainingUsd > monthlyCapUsd + 1e-9) throw new BudgetError("generation capacity is reserved; try again when current jobs finish");
      this.state.reservations.push({ jobId, stage, amountUsd, remainingUsd, createdAt: now.toISOString() });
    });
  }
  shotCapacity(jobId: string, shotId: string, shotCapUsd: number): number {
    this.reload();
    return this.shotCapacityOf(jobId, shotId, shotCapUsd);
  }
  /** The shot's remaining budget in the state already loaded. See `assertCanSpend`. */
  private shotCapacityOf(jobId: string, shotId: string, shotCapUsd: number): number {
    if (!Number.isFinite(shotCapUsd) || shotCapUsd < 0) throw new BudgetError("invalid shot budget");
    const spent = this.state.events.filter(event => event.jobId === jobId && event.shotId === shotId).reduce((sum, event) => sum + event.total_cost_usd, 0);
    const remaining = this.state.reservations.find(value => value.jobId === jobId)?.remainingUsd ?? 0;
    return Math.max(0, Math.min(remaining, shotCapUsd - spent));
  }
  /**
   * HV-019-10: this made one decision out of two reads of the ledger.
   *
   * It reloaded, and then called the **public** `shotCapacity`, which reloads again. So the shot's
   * budget was checked against one state of the file and the job's against another, and a spend
   * recorded by another worker between the two was counted by one half of the decision and not the
   * other. The two checks are one answer about whether this attempt may be made, and an answer
   * assembled from two different readings of the same file is not one answer.
   *
   * It is also the whole of the call's cost. Measured on a ledger of 4,000 events: 4.27 ms for
   * `assertCanSpend` against 1.90 ms for `shotCapacity` alone -- about twice, because the parse is
   * what the call is. The worker asks this once per provider attempt per shot.
   */
  assertCanSpend(jobId: string, estimateUsd: number, shot?: {id: string; capUsd: number}): void {
    this.reload();
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) throw new BudgetError("invalid generation estimate");
    if (shot && this.shotCapacityOf(jobId, shot.id, shot.capUsd) + 1e-9 < estimateUsd) throw new BudgetError("this shot reached its generation budget");
    if (estimateUsd === 0) return;
    const r = this.state.reservations.find(r => r.jobId === jobId);
    if (!r || r.remainingUsd + 1e-9 < estimateUsd) throw new BudgetError("this job reached its generation budget");
  }
  release(jobId: string): void {
    this.transact(() => { this.state.reservations = this.state.reservations.filter(r => r.jobId !== jobId); });
  }
  reconcile(activeJobIds: Set<string>, graceMs = 60_000, now = Date.now()): void {
    this.transact(() => {
      this.state.reservations = this.state.reservations.filter(r => activeJobIds.has(r.jobId) || now - new Date(r.createdAt).getTime() < graceMs);
    });
  }
  reservedUsd(): number { this.reload(); return this.state.reservations.reduce((sum, r) => sum + r.remainingUsd, 0); }
  shotSpend(jobId:string,shotId:string):number {this.reload();return this.state.events.filter(e=>e.jobId===jobId&&e.shotId===shotId).reduce((sum,e)=>sum+e.total_cost_usd,0);}
  jobSpend(jobId: string): number { this.reload(); return this.state.events.filter(e => e.jobId === jobId).reduce((sum, e) => sum + e.total_cost_usd, 0); }
  record(e: CostEvent): void {
    if (!Number.isFinite(e.total_cost_usd) || e.total_cost_usd < 0) throw new BudgetError("invalid provider cost");
    this.transact(() => {
      this.state.events.push(e);
      const r = this.state.reservations.find(r => r.jobId === e.jobId);
      if (r) r.remainingUsd = Math.max(0, Number((r.remainingUsd - e.total_cost_usd).toFixed(6)));
    });
  }
  all(): CostEvent[] { this.reload(); return [...this.state.events]; }
  /**
   * Each project's GPU seconds inside the fair-share window, for the claim
   * order. Named for what it is used for rather than for what it sums: the
   * defect this replaced was a method called `gpuSecondsByProject`, which
   * quite reasonably returned a lifetime total, being handed to a scheduler
   * that needed a recent one.
   */
  fairShareWeights(now = Date.now()): Record<string, number> {
    this.reload();
    const totals: Record<string, number> = {};
    for (const event of this.state.events) {
      if (!withinFairShareWindow(event.at, now)) continue;
      totals[event.projectId] = (totals[event.projectId] ?? 0) + event.gpu_seconds;
    }
    return totals;
  }
  rollup(period: "day" | "week" | "month", now = new Date()): { totalUsd: number; byProvider: Record<string, number>; jobs: number } {
    this.reload();
    const ms = period === "day" ? 864e5 : period === "week" ? 6048e5 : 2592e6;
    const cut = now.getTime() - ms;
    const inWin = this.state.events.filter((e) => new Date(e.at).getTime() >= cut);
    const byProvider: Record<string, number> = {};
    for (const e of inWin) byProvider[e.provider] = (byProvider[e.provider] ?? 0) + e.total_cost_usd;
    return { totalUsd: inWin.reduce((s, e) => s + e.total_cost_usd, 0), byProvider, jobs: inWin.length };
  }
  monthSpend(now = new Date()): number { return this.rollup("month", now).totalUsd; }
}

export interface ReviewItem { shotId: string; projectId: string; score: number; queuedAt: string; resolved: boolean }

export class OperatorReviewQueue {
  private items: ReviewItem[] = [];
  constructor(private path?: string) { this.reload(); }
  private reload(): void {
    if (!this.path) return;
    // An unreadable queue was an empty queue, and the next `persist()` wrote that emptiness over
    // the operator's flags for good. It refuses now, and the flags stay on disk to be repaired.
    try { this.items = readJsonFile<ReviewItem[]>(this.path) ?? []; }
    catch (error) { throw new Error("The operator review queue at " + this.path + " is unreadable; the flags it holds are not repaired by writing over them.", {cause: error}); }
  }
  private persist(): void {
    if (!this.path) return;
    writeJsonFile(this.path, this.items);
  }
  /**
   * HV-038-08: read, change and write, under the same interprocess lock the other two shared-state
   * classes in this file take.
   *
   * `withFileLock`'s own comment says what it is for: "state shared between the API and worker
   * processes". `CostLedger.transact` takes it and `CrewLedger.locked` takes it; this queue, whose
   * file is fixed at `/data/state/operator-review-queue.json` and written by every worker that
   * flags a shot, reloaded, mutated and persisted outside any lock. Measured with three processes
   * flagging 150 distinct shots each: **311 of 450 on disk, 139 lost** — 31% of the operator's
   * review flags, silently, with every individual call reporting success.
   *
   * `docker-compose.yml` runs one worker today, so this needs the scaled fleet `HV_EXPECTED_WORKERS`
   * and the worker registry exist for. It is the same shape as the defects those were built for.
   */
  private transact<T>(work: () => T): T {
    const apply = () => { this.reload(); const result = work(); this.persist(); return result; };
    return this.path ? withFileLock(this.path, apply) : apply();
  }
  /**
   * One entry per shot of a project, replaced rather than repeated, and reopened when a shot is
   * flagged again after being resolved.
   *
   * HV-019-07: this pushed unconditionally, while `PostgresReviewQueue.flag` keys on
   * `sha256(projectId + "\0" + shotId)` and does `on conflict do update … resolved_at = null`. The
   * two stores of the same queue disagreed about what a second flag for the same shot means, and
   * `resolve(shotId)` — which resolves *one* unresolved item and does not even take a project —
   * agrees with PostgreSQL: a shot is one item. A duplicate here left an entry no `resolve` call
   * would ever clear. The worker now flags before it checkpoints, so a shot rendered twice across
   * an interruption is flagged twice, and this is what makes that the safe order.
   */
  flag(shotId: string, projectId: string, score: number): void {
    this.transact(() => {
      const item: ReviewItem = { shotId, projectId, score, queuedAt: new Date().toISOString(), resolved: false };
      const existing = this.items.findIndex((value) => value.shotId === shotId && value.projectId === projectId);
      if (existing >= 0) this.items[existing] = item; else this.items.push(item);
    });
  }
  pending(): ReviewItem[] { this.reload(); return this.items.filter((i) => !i.resolved); }
  /**
   * HV-038-08: a project's flag, not every project's.
   *
   * `flag` keys on the pair — `PostgresReviewQueue.flag` hashes `projectId + "\0" + shotId` for its
   * primary key, and this one matches on both fields — and `resolve` took a shot id alone. Shot ids
   * are per-project strings like `shot-1-1`, so the first caller of this would have cleared every
   * project's review of the same shot. There is no production caller today: `worker.ts` calls
   * `flag` and nothing calls `resolve`, which is why this was a trap rather than a leak, and why
   * changing the signature costs nothing.
   */
  resolve(shotId: string, projectId: string): void {
    this.transact(() => {
      const item = this.items.find((value) => value.shotId === shotId && value.projectId === projectId && !value.resolved);
      if (item) item.resolved = true;
    });
  }
}

export interface AnalyticsEvent { name: string; at: string; anonymousSessionHash: string }

export class AnonymizedAnalytics {
  readonly events: AnalyticsEvent[] = [];
  private ipLog: { hash: string; at: number }[] = [];
  static readonly IP_RETENTION_MS = 30 * 24 * 3600 * 1000;

  track(name: string, sessionSeed: string): void {
    if (/\b\d{1,3}(\.\d{1,3}){3}\b|@/.test(sessionSeed)) {
      throw new Error("PII must not reach analytics; hash before tracking");
    }
    this.events.push({ name, at: new Date().toISOString(), anonymousSessionHash: sessionSeed });
  }
  logIpForRateLimit(ipHash: string, now = Date.now()): void { this.ipLog.push({ hash: ipHash, at: now }); }
  sweepIps(now = Date.now()): number {
    const before = this.ipLog.length;
    this.ipLog = this.ipLog.filter((e) => now - e.at < AnonymizedAnalytics.IP_RETENTION_MS);
    return before - this.ipLog.length;
  }
  ipCount(): number { return this.ipLog.length; }
}
