/**
 * HV-037-03. On a PostgreSQL runtime -- the staging setup -- `bun run benchmark:paid` holds and
 * records its spend in the studio's own ledger: `PostgresCostLedger`, over the worker role's
 * connection, as the studio's workers record fal spend. The declaration is reserved under the same
 * `hv_budget_accounts` cap the studio's admissions read, each shot's cost is a row in
 * `hv_cost_events`, and so the month's rollup (the operator's $500 cap and $450 alert) sees it.
 *
 * Runs where CI runs the storage suites: `HV_PG_ADMIN_URL` and `HV_WORKER_DATABASE_URL` set
 * (.github/workflows/ci.yml). No paid provider is constructed; a local priced stand-in renders.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StudioDatabase } from "../../storage/src/database";
import { PostgresCostLedger } from "../../storage/src/ledger";
import { readMeasuredRecord } from "../src/measured";
import { defaultPaidRunDeps, runPaidBenchmark, type PaidRunDeps } from "../src/paid";
import { CORPUS_REFERENCES_DIR } from "../src/references";
import { ReferenceLoopProvider } from "./stand-ins";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_WORKER_DATABASE_URL), pgtest = enabled ? test : test.skip;
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SPEC = "fal:kling-o3-standard-reference", INCREMENT = "HV-037-97", PROJECT = "benchmark:" + INCREMENT;
const DOC = `# ${INCREMENT} — paid pass (test)\n\nepic: HV-037\nspend_usd: 5\n\nOne pass of the corpus on \`${SPEC}\`.\n`;

let admin: StudioDatabase, worker: StudioDatabase, root = "", previousCap: number | null = null;
const clean = async () => {
  await admin.sql`delete from hv_reservations where job_id like ${PROJECT + ":%"}`;
  await admin.sql`delete from hv_cost_events where project_id = ${PROJECT}`;
};
const monthRoom = async () => Number((await admin.sql`select
  (select coalesce(sum(total_usd),0) from hv_cost_events where created_at >= now() - interval '30 days') +
  (select coalesce(sum(remaining_usd),0) from hv_reservations) as used`)[0].used);
const setCap = async (usd: number) => { await admin.sql`insert into hv_budget_accounts (id, monthly_cap_usd) values ('operator', ${usd})
  on conflict (id) do update set monthly_cap_usd = ${usd}, updated_at = now()`; };

beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!); await admin.migrate();
  worker = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  previousCap = (await admin.sql`select monthly_cap_usd from hv_budget_accounts where id = 'operator'`)[0]?.monthly_cap_usd ?? null;
  await clean();
  root = mkdtempSync(join(tmpdir(), "hv-paid-pg-"));
});
afterAll(async () => {
  if (!enabled) return;
  await clean();
  if (previousCap === null) await admin.sql`delete from hv_budget_accounts where id = 'operator'`;
  else await admin.sql`update hv_budget_accounts set monthly_cap_usd = ${previousCap} where id = 'operator'`;
  await Promise.all([admin.close(), worker.close()]);
  if (root) rmSync(root, { recursive: true, force: true });
});

function harness(runId: string, onGenerate?: (call: number, jobId: string) => void | Promise<void>) {
  const resolved: string[] = [], jobId = `${PROJECT}:${SPEC}:${runId}`;
  const provider = new ReferenceLoopProvider({ conditioned: true, usdPerShot: 0.05, name: "priced-stand-in", onGenerate: call => onGenerate?.(call, jobId) });
  const base = defaultPaidRunDeps(REPO_ROOT);
  const deps: PaidRunDeps = { ...base, readIncrementDoc: increment => increment === INCREMENT ? DOC : base.readIncrementDoc(increment),
    resolveProvider: spec => { resolved.push(spec); return provider; }, outDir: mkdtempSync(join(root, "out-")), runId };
  const jsonLedger = join(mkdtempSync(join(root, "json-")), "cost-ledger.json");
  // The staging runtime: runtime-config.sh's JSON path and caps, plus the worker role's database from storage-worker.env.
  const env = { HV_STORAGE: "postgres", HV_WORKER_DATABASE_URL: process.env.HV_WORKER_DATABASE_URL, HV_COST_LEDGER_PATH: jsonLedger, HV_MONTHLY_BUDGET_USD: "500", HV_COST_CAP_PER_SHOT_USD: "5" };
  const argv = (declared = "2") => ["--provider", SPEC, "--declared-usd", declared, "--increment", INCREMENT, "--references", CORPUS_REFERENCES_DIR];
  return { deps, env, argv, provider, resolved, jobId, jsonLedger };
}
const events = async (jobId?: string) => (await admin.sql`select job_id, stage, provider, total_usd, body from hv_cost_events where project_id = ${PROJECT} order by created_at, id`)
  .filter((row: { job_id: string }) => jobId === undefined || row.job_id === jobId) as { job_id: string; stage: string; provider: string; total_usd: string; body: { shotId: string } }[];

describe("on a PostgreSQL runtime the pass is held and recorded in the studio's ledger", () => {
  pgtest("the declaration is reserved under the program's cap, every shot's cost is a cost event, and the month's rollup sees it", async () => {
    await setCap(500);
    const before = await new PostgresCostLedger(worker).rollup("month");
    const seen: { call: number; rows: { amount_usd: string; remaining_usd: string; stage: string }[]; reservedUsd: number }[] = [];
    const h = harness("pg-held", async (call, jobId) => {
      const ledger = new PostgresCostLedger(worker);
      if (call === 1 || call === 2 || call === 13) seen.push({ call, rows: await admin.sql`select amount_usd, remaining_usd, stage from hv_reservations where job_id = ${jobId}`, reservedUsd: await ledger.reservedUsd() });
      // What a studio worker's reconcile does to a hold whose job is not in its queue, a minute after it was taken.
      if (call === 12) await ledger.release(jobId);
    });
    const result = await runPaidBenchmark(h.argv(), h.env, h.deps);
    expect(result).toMatchObject({ ledger: "postgres", jobId: h.jobId });
    expect(h.resolved).toEqual([SPEC]);
    expect(h.provider.calls).toHaveLength(24);
    expect(result.record.aggregate).toMatchObject({ rendered: 24, skipped: 0, failed: 0, scoredShots: 10, totalCostUsd: 1.2 });
    // The hold was in hv_reservations, counted by the same sum every admission checks, before shot 1,
    // after shot 1, and again after a worker released it during shot 12.
    expect(seen.map(entry => [entry.call, entry.rows.map(row => [row.stage, Number(row.amount_usd), Number(row.remaining_usd)])])).toEqual([
      [1, [["final", 2, 2]]], [2, [["final", 2, 1.95]]], [13, [["final", 2, 1.4]]],
    ]);
    for (const entry of seen) expect(entry.reservedUsd).toBeGreaterThanOrEqual(Number(entry.rows[0]!.remaining_usd));
    // 24 cost events under the increment and this pass's job, one per shot, and nothing left held.
    const rows = await events(h.jobId);
    expect(rows).toHaveLength(24);
    expect(new Set(rows.map(row => row.body.shotId)).size).toBe(24);
    expect(rows.every(row => row.stage === "final" && row.provider === "priced-stand-in" && Number(row.total_usd) === 0.05)).toBe(true);
    expect((await admin.sql`select job_id from hv_reservations where job_id = ${h.jobId}`)).toHaveLength(0);
    // The month's rollup -- what the operator's health, the $500 cap and the $450 alert read -- includes it.
    const after = await new PostgresCostLedger(worker).rollup("month");
    expect(after.totalUsd - before.totalUsd).toBeCloseTo(1.2, 6);
    expect((after.byProvider["priced-stand-in"] ?? 0) - (before.byProvider["priced-stand-in"] ?? 0)).toBeCloseTo(1.2, 6);
    expect(result.monthSpendUsd).toBeCloseTo(after.totalUsd, 6);
    // The JSON ledger the runtime config also names is not the program's ledger here, and is never written.
    expect(existsSync(h.jsonLedger)).toBe(false);
    expect(readMeasuredRecord(result.record, { allowSynthetic: true }).aggregate.totalCostUsd).toBe(1.2);
  }, 180_000);

  pgtest("earlier passes recorded in PostgreSQL count against the increment's declaration", async () => {
    const spent = (await events()).reduce((sum, row) => sum + Number(row.total_usd), 0);
    expect(spent).toBeCloseTo(1.2, 6);
    const h = harness("pg-over");
    await expect(runPaidBenchmark(h.argv("4"), h.env, h.deps)).rejects.toThrow(/HV-037-97 declares \$5; \$1\.2 is already spent under it, so \$4 more would pass its declaration/);
    expect(h.resolved).toEqual([]);
    expect(h.provider.calls).toEqual([]);
    expect(await events()).toHaveLength(24);
  });

  pgtest("the program's cap in PostgreSQL refuses the hold before any shot", async () => {
    await setCap(Math.max(0.01, Number((await monthRoom() + 1).toFixed(2))));
    try {
      const h = harness("pg-capped");
      await expect(runPaidBenchmark(h.argv("2"), h.env, h.deps)).rejects.toThrow(/generation capacity is reserved/);
      expect(h.provider.calls).toEqual([]);
      expect(await events(h.jobId)).toHaveLength(0);
      expect((await admin.sql`select job_id from hv_reservations where job_id = ${h.jobId}`)).toHaveLength(0);
    } finally { await setCap(500); }
  });

  pgtest("a released hold that the cap no longer admits stops the pass, with every cost so far recorded", async () => {
    await setCap(500);
    try {
      const h = harness("pg-stopped", async (call, jobId) => {
        if (call !== 3) return;
        await new PostgresCostLedger(worker).release(jobId);
        // Meanwhile the studio's other work has taken the rest of the month.
        await setCap(Math.max(0.01, Number((await monthRoom() + 0.05 + 0.5).toFixed(2))));
      });
      const { record } = await runPaidBenchmark(h.argv("2"), h.env, h.deps);
      expect(h.provider.calls).toHaveLength(3);
      expect(record.aggregate).toMatchObject({ rendered: 3, skipped: 21, totalCostUsd: 0.15 });
      expect(record.shots.slice(3).every(shot => shot.status === "skipped" && (shot.reason ?? "").startsWith("the month's cap refused the hold: generation capacity is reserved"))).toBe(true);
      expect(await events(h.jobId)).toHaveLength(3);
      expect((await admin.sql`select job_id from hv_reservations where job_id = ${h.jobId}`)).toHaveLength(0);
    } finally { await setCap(500); }
  }, 120_000);
});
