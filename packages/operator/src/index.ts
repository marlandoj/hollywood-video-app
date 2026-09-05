import { existsSync } from "node:fs";
import type { CostRecord } from "../../generator/src/index";
import { readJsonFile, writeJsonFile, withFileLock } from "../../queue/src/persist";

export interface CostEvent extends CostRecord { at: string; projectId: string; shotId: string; jobId?: string; stage?: "animatic" | "final" }
export interface BudgetReservation { jobId: string; stage: "animatic" | "final"; amountUsd: number; remainingUsd: number; createdAt: string }
interface LedgerState { events: CostEvent[]; reservations: BudgetReservation[] }

export class BudgetError extends Error {
  override readonly name = "BudgetError";
}

export class CostLedger {
  private state: LedgerState = { events: [], reservations: [] };
  constructor(private path?: string) { this.reload(); }
  private reload(): void {
    if (!this.path || !existsSync(this.path)) return;
    const raw = readJsonFile<CostEvent[] | LedgerState>(this.path);
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
  reserve(jobId: string, stage: "animatic" | "final", amountUsd: number, monthlyCapUsd: number, now = new Date()): void {
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
  assertCanSpend(jobId: string, estimateUsd: number): void {
    this.reload();
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) throw new BudgetError("invalid generation estimate");
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
  gpuSecondsByProject(): Record<string, number> {
    this.reload();
    const totals: Record<string, number> = {};
    for (const event of this.state.events) totals[event.projectId] = (totals[event.projectId] ?? 0) + event.gpu_seconds;
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
    this.items = readJsonFile<ReviewItem[]>(this.path) ?? [];
  }
  private persist(): void {
    if (!this.path) return;
    writeJsonFile(this.path, this.items);
  }
  flag(shotId: string, projectId: string, score: number): void {
    this.reload();
    this.items.push({ shotId, projectId, score, queuedAt: new Date().toISOString(), resolved: false });
    this.persist();
  }
  pending(): ReviewItem[] { this.reload(); return this.items.filter((i) => !i.resolved); }
  resolve(shotId: string): void {
    this.reload();
    const i = this.items.find((x) => x.shotId === shotId && !x.resolved);
    if (i) { i.resolved = true; this.persist(); }
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
