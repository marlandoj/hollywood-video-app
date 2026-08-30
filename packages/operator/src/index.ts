import type { CostRecord } from "../../generator/src/index";

export interface CostEvent extends CostRecord { at: string; projectId: string; shotId: string }

export class CostLedger {
  private events: CostEvent[] = [];
  record(e: CostEvent): void { this.events.push(e); }
  rollup(period: "day" | "week" | "month", now = new Date()): { totalUsd: number; byProvider: Record<string, number>; jobs: number } {
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
  flag(shotId: string, projectId: string, score: number): void {
    this.items.push({ shotId, projectId, score, queuedAt: new Date().toISOString(), resolved: false });
  }
  pending(): ReviewItem[] { return this.items.filter((i) => !i.resolved); }
  resolve(shotId: string): void { const i = this.items.find((x) => x.shotId === shotId && !x.resolved); if (i) i.resolved = true; }
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
