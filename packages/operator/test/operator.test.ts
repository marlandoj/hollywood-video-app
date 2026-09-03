import { describe, expect, test } from "bun:test";
import { AnonymizedAnalytics, CostLedger, OperatorReviewQueue } from "../src/index";

describe("cost rollups (AC-010)", () => {
  test("daily/weekly/monthly rollups aggregate by provider", () => {
    const l = new CostLedger();
    const now = new Date();
    l.record({ at: now.toISOString(), projectId: "p1", shotId: "s1", provider: "mock", model: "m", prompt_tokens: 5, output_frames: 24, gpu_seconds: 1, total_cost_usd: 1.5 });
    l.record({ at: new Date(now.getTime() - 2 * 864e5).toISOString(), projectId: "p1", shotId: "s2", provider: "mock", model: "m", prompt_tokens: 5, output_frames: 24, gpu_seconds: 1, total_cost_usd: 2 });
    expect(l.rollup("day", now).totalUsd).toBe(1.5);
    expect(l.rollup("month", now).totalUsd).toBe(3.5);
    expect(l.rollup("month", now).byProvider.mock).toBe(3.5);
  });
});

describe("operator review queue (AC-012)", () => {
  test("flagged shots appear pending and can be resolved", () => {
    const q = new OperatorReviewQueue();
    q.flag("shot-3-1", "p1", 0.21);
    expect(q.pending().length).toBe(1);
    q.resolve("shot-3-1");
    expect(q.pending().length).toBe(0);
  });
});

describe("anonymized analytics + IP retention (AC-016)", () => {
  test("raw IPs and emails are rejected; IP hashes delete after 30 days", () => {
    const a = new AnonymizedAnalytics();
    expect(() => a.track("export", "203.0.113.9")).toThrow("PII");
    expect(() => a.track("export", "user@example.com")).toThrow("PII");
    a.track("export", "sha256:abcd");
    const t0 = Date.now();
    a.logIpForRateLimit("h1", t0 - 31 * 24 * 3600 * 1000);
    a.logIpForRateLimit("h2", t0);
    expect(a.sweepIps(t0)).toBe(1);
    expect(a.ipCount()).toBe(1);
  });
});
