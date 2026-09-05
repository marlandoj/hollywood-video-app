import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostLedger } from "../src/index";
const root = mkdtempSync(join(tmpdir(), "hv-budget-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const event = (jobId: string, usd: number) => ({ jobId, at: new Date().toISOString(), projectId: "p", shotId: "s",
  stage: "animatic" as const, provider: "test", model: "m", prompt_tokens: 1, output_frames: 1, gpu_seconds: 0, total_cost_usd: usd });

describe("durable generation reservations", () => {
  test("multiple ledger instances cannot admit more than the remaining monthly budget", () => {
    const path = join(root, "budget.json"), a = new CostLedger(path), b = new CostLedger(path);
    a.reserve("a", "animatic", 5, 8);
    expect(() => b.reserve("b", "animatic", 5, 8)).toThrow("capacity");
    a.record(event("a", 2));
    expect(b.monthSpend()).toBe(2);
    expect(b.reservedUsd()).toBe(3);
    a.release("a");
    b.reserve("b", "animatic", 5, 8);
    expect(new CostLedger(path).reservedUsd()).toBe(5);
    expect(() => a.assertCanSpend("b", 6)).toThrow("budget");
    b.reserve("b", "animatic", 5, 8);
    expect(a.reservedUsd()).toBe(5);
    b.release("b");
    expect(a.reservedUsd()).toBe(0);
  });
  test("legacy array events migrate without losing spend and corrupt ledgers stop admission", () => {
    const path = join(root, "legacy.json");
    writeFileSync(path, JSON.stringify([event("old", 2)]));
    const l = new CostLedger(path);
    l.reserve("new", "animatic", 3, 5);
    expect(l.monthSpend()).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8")).events).toHaveLength(1);
    writeFileSync(path, "broken");
    expect(() => l.reserve("blocked", "animatic", 1, 10)).toThrow("unreadable");
  });
  test("orphan reservations reconcile after grace, while active jobs stay held", () => {
    const l = new CostLedger();
    l.reserve("active", "animatic", 2, 10, new Date(0));
    l.reserve("orphan", "animatic", 3, 10, new Date(0));
    l.reconcile(new Set(["active"]), 1000, 2000);
    expect(l.reservedUsd()).toBe(2);
    expect(() => l.assertCanSpend("orphan", 0.01)).toThrow("budget");
  });
});
