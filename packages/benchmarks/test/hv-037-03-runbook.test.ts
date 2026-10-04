/**
 * HV-037-03. The increment doc declares the paid pass, and its host runbook is the exact pair of
 * commands the operator runs. This reads those commands out of the doc and puts them through the
 * harness's own argument parser, authorization and declaration check, on the staging host's
 * environment, offline: no database is connected, no provider is constructed for spending, and
 * `fetch` would throw.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FalVideoProvider } from "../../generator/src/index";
import type { CostEvent } from "../../operator/src/index";
import { loadReferences, planMeasuredPass, plannedCostUsd, type BenchmarkLedger } from "../src/measured";
import { assertDeclarationCovers, authorizePaidBenchmark, declaredSpendOf, defaultPaidRunDeps, docNamesProvider, parsePaidArgs, referencePaths, type Authorization } from "../src/paid";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const doc = readFileSync(join(REPO_ROOT, "docs/loop/increments/HV-037-03.md"), "utf8");
const TURBO = "fal:kling-v2.5-turbo-pro", REFERENCE = "fal:kling-o3-standard-reference";
// What runtime-config.sh and storage-worker.env give the runbook's subshell on the host (the URL's password is a placeholder).
const STAGING_ENV = { HV_STORAGE: "postgres", HV_WORKER_DATABASE_URL: "postgres://hv_worker:placeholder@127.0.0.1:5432/hollywood_video_staging_desktop",
  HV_COST_LEDGER_PATH: "/srv/rough-cut/staging/data/state/cost-ledger.json", HV_MONTHLY_BUDGET_USD: "500", HV_COST_CAP_PER_SHOT_USD: "5" };

/** The runbook's `bun run <script> ...` lines, as argument lists, up to the shell redirect. */
function runbook(script: string): string[][] {
  return doc.split("\n").map(line => line.trim()).filter(line => line.startsWith(`bun run ${script} `)).map(line => {
    const words = line.slice(`bun run ${script} `.length).split(/\s+/);
    const end = words.indexOf(">");
    return (end < 0 ? words : words.slice(0, end)).map(word => word.replace(/^"(.*)"$/, "$1"));
  });
}
const ledgerWith = (events: Partial<CostEvent>[]): BenchmarkLedger => ({ all: () => events as CostEvent[], reserve() {}, assertCanSpend() {}, record() {}, release() {} });
const spent = (usd: number): Partial<CostEvent>[] => [{ projectId: "benchmark:HV-037-03", total_cost_usd: usd }];

describe("HV-037-03's declaration and host runbook", () => {
  test("the doc declares $12 under G21 and names both fal models, as the gate approved", () => {
    expect(declaredSpendOf(doc)).toBe(12);
    expect(docNamesProvider(doc, TURBO)).toBe(true);
    expect(docNamesProvider(doc, REFERENCE)).toBe(true);
    expect(doc).toMatch(/^gate: G21-202610041254 /m);
    expect(doc).toMatch(/^epic: HV-037$/m);
    expect(doc).toMatch(/^release: 3 /m);
    const gates = readFileSync(join(REPO_ROOT, "docs/loop/HUMAN-GATES.md"), "utf8");
    const entry = gates.slice(gates.indexOf("## G21-202610041254"));
    expect(entry).toMatch(/resolved: 2026-10-04 Kevin decided/);
    expect(entry).toMatch(/\*\*The paid benchmark pass is approved,\*\* at about \$11/);
  });

  test("each runbook pass is authorized on the staging environment, against the PostgreSQL ledger, and declares at least its plan", () => {
    const passes = runbook("benchmark:paid");
    expect(passes).toHaveLength(2);
    const references = loadReferences(referencePaths(join(REPO_ROOT, "packages/benchmarks/fixtures/references")));
    let fetchCalls = 0;
    const never = (() => { fetchCalls += 1; throw new Error("no network in this test"); }) as unknown as typeof fetch;
    const authorized: Authorization[] = passes.map(argv => {
      const args = parsePaidArgs(argv);
      expect(args).toMatchObject({ increment: "HV-037-03", references: "packages/benchmarks/fixtures/references", out: `$OUT/${args.provider!.slice(4)}.json` });
      const auth = authorizePaidBenchmark(args, STAGING_ENV, defaultPaidRunDeps(REPO_ROOT));
      expect(auth).toMatchObject({ ledger: { kind: "postgres" }, docUsd: 12, monthlyCapUsd: 500, shotCapUsd: 5 });
      const plan = planMeasuredPass(new FalVideoProvider({ model: auth.spec.slice(4), apiKey: "offline-test-key", fetchImpl: never }), references, auth.shotCapUsd);
      expect(plannedCostUsd(plan)).toBeLessThanOrEqual(auth.declaredUsd);
      return auth;
    });
    expect(authorized.map(auth => [auth.spec, auth.declaredUsd])).toEqual([[TURBO, 9], [REFERENCE, 3]]);
    expect(fetchCalls).toBe(0);
  });

  test("in order, the two passes fit spend_usd, and declaring more on either would not", async () => {
    const [turbo, reference] = runbook("benchmark:paid").map(argv => authorizePaidBenchmark(parsePaidArgs(argv), STAGING_ENV, defaultPaidRunDeps(REPO_ROOT)));
    await expect(assertDeclarationCovers(turbo!, ledgerWith([]))).resolves.toBe(0);
    // After the turbo pass spends its plan, or even its whole declaration, the reference pass still fits.
    await expect(assertDeclarationCovers(reference!, ledgerWith(spent(8.4)))).resolves.toBe(8.4);
    await expect(assertDeclarationCovers(reference!, ledgerWith(spent(9)))).resolves.toBe(9);
    // A dollar more on either line passes the declaration by the time the second runs.
    await expect(assertDeclarationCovers(reference!, ledgerWith(spent(10)))).rejects.toThrow(/HV-037-03 declares \$12; \$10 is already spent under it/);
    await expect(assertDeclarationCovers({ ...reference!, declaredUsd: 4 }, ledgerWith(spent(8.4)))).rejects.toThrow(/\$4 more would pass its declaration/);
  });

  test("the results line joins exactly the two records into the file routing reads", () => {
    const [results] = runbook("benchmark:results");
    expect(results).toEqual(["--out", "$OUT/routing-results.json", "$OUT/kling-o3-standard-reference.json", "$OUT/kling-v2.5-turbo-pro.json"]);
    expect(doc).toContain("HV_ROUTING_QUALITY_RESULTS_PATH=docs/evidence/release-3/benchmark/routing-results.json");
  });
});
