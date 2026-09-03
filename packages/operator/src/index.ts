import type { CostRecord } from "../../generator/src/index";
import { readJsonFile, writeJsonFile } from "../../queue/src/persist";

export interface CostEvent extends CostRecord { at: string; projectId: string; shotId: string; jobId?: string }

export class CostLedger {
  private events: CostEvent[] = [];
  constructor(private path?: string) { this.reload(); }
  private reload(): void {
    if (!this.path) return;
    this.events = readJsonFile<CostEvent[]>(this.path) ?? [];
  }
  private persist(): void {
    if (!this.path) return;
    writeJsonFile(this.path, this.events);
  }
  record(e: CostEvent): void {
    this.reload();
    this.events.push(e);
    this.persist();
  }
  all(): CostEvent[] { this.reload(); return [...this.events]; }
  gpuSecondsByProject(): Record<string, number> {
    this.reload();
    const totals: Record<string, number> = {};
    for (const event of this.events) totals[event.projectId] = (totals[event.projectId] ?? 0) + event.gpu_seconds;
    return totals;
  }
  rollup(period: "day" | "week" | "month", now = new Date()): { totalUsd: number; byProvider: Record<string, number>; jobs: number } {
    this.reload();
    const ms = period === "day" ? 864e5 : period === "week" ? 6048e5 : 2592e6;
    const cut = now.getTime() - ms;
    const inWin = this.events.filter((e) => new Date(e.at).getTime() >= cut);
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
