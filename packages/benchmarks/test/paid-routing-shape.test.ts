/**
 * HV-037-03. What `bun run benchmark:paid` writes is what quality routing (HV-019-14) reads.
 *
 * Two passes run through the harness exactly as the runbook's two do -- one per fal model spec, on
 * the committed references, recording to a ledger -- but against local mock (stand-in) providers,
 * so nothing is paid and nothing leaves the machine. `bun run benchmark:results` joins the two
 * records into one file. The router's reader refuses that file for one reason only: the records
 * come from stand-ins. Relabelled as vendor records (a test-only edit of the one field that says
 * so), the same bytes are accepted whole, so the shape, the scores and the comparability checks all
 * hold for a real pass's records.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IDENTITY_METRIC } from "../src/identity";
import { corpusShots, readMeasuredRecord, type MeasuredRecord } from "../src/measured";
import { defaultPaidRunDeps, runPaidBenchmark, type PaidRunDeps } from "../src/paid";
import { CORPUS_REFERENCES_DIR } from "../src/references";
import { readRoutingResults, routingQualityFrom } from "../src/routing-results";
import { routingResultsText, writeRoutingResults } from "../src/results";
import { ReferenceLoopProvider } from "./stand-ins";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const REFERENCE = "fal:kling-o3-standard-reference", TURBO = "fal:kling-v2.5-turbo-pro";
const DOC = `# HV-037-96 — paid pass (test)\n\nepic: HV-037\nspend_usd: 20\n\nOne pass each on \`${TURBO}\` and \`${REFERENCE}\`.\n`;

let root = "", ledgerPath = "";
const records: Record<string, { path: string; record: MeasuredRecord }> = {};
const realFetch = globalThis.fetch;
let fetchCalls = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hv-paid-routing-"));
  ledgerPath = join(root, "cost-ledger.json");
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("no network in this test"); }) as unknown as typeof fetch;
  // The reference model holds the character; the text-only model cannot see the reference at all.
  for (const [spec, conditioned] of [[REFERENCE, true], [TURBO, false]] as const) {
    const provider = new ReferenceLoopProvider({ conditioned, usdPerShot: 0.25, name: "fal" });
    const base = defaultPaidRunDeps(REPO_ROOT);
    const deps: PaidRunDeps = { ...base, readIncrementDoc: increment => increment === "HV-037-96" ? DOC : null, resolveProvider: () => provider,
      outDir: mkdtempSync(join(root, "out-")), runId: "shape" };
    const out = join(root, "runs", spec.replace(":", "_") + ".json");
    const { record } = await runPaidBenchmark(["--provider", spec, "--declared-usd", "6", "--increment", "HV-037-96", "--references", CORPUS_REFERENCES_DIR, "--out", out],
      { HV_COST_LEDGER_PATH: ledgerPath }, deps);
    records[spec] = { path: out, record };
  }
}, 240_000);
afterAll(() => { globalThis.fetch = realFetch; if (root) rmSync(root, { recursive: true, force: true }); });

/** The one field a stand-in's record differs in from a vendor's, flipped for this test only. */
const asVendor = (record: MeasuredRecord): MeasuredRecord => ({ ...record, synthetic: false });

test("each pass's record is the measured record the router reads, on the committed references", () => {
  expect(fetchCalls).toBe(0);
  for (const spec of [REFERENCE, TURBO]) {
    const record = readMeasuredRecord(JSON.parse(readFileSync(records[spec]!.path, "utf8")), { allowSynthetic: true });
    expect(record).toMatchObject({ providerSpec: spec, increment: "HV-037-96", declaredUsd: 6, fixtureSha256: corpusShots().fixtureSha256, metric: IDENTITY_METRIC });
    expect(record.references.map(reference => [reference.character, reference.flat])).toEqual([["KEEPER", false], ["SAILOR", false]]);
    expect(record.aggregate).toMatchObject({ rendered: 24, scoredShots: 10, totalCostUsd: 6 });
  }
  expect(records[REFERENCE]!.record.references).toEqual(records[TURBO]!.record.references);
});

test("the joined results file is refused for one reason only -- these are stand-ins -- and nothing is written", () => {
  const out = join(root, "refused.json");
  expect(() => writeRoutingResults([records[TURBO]!.path, records[REFERENCE]!.path], out)).toThrow(/router would refuse these records: .*synthetic stand-in, and its scores are not routing evidence/);
  expect(existsSync(out)).toBe(false);
  const cli = Bun.spawnSync(["bun", join(REPO_ROOT, "packages/benchmarks/src/results.ts"), "--out", out, records[TURBO]!.path, records[REFERENCE]!.path], { cwd: REPO_ROOT });
  expect(cli.exitCode).toBe(2);
  expect(cli.stderr.toString()).toMatch(/synthetic stand-in/);
  expect(existsSync(out)).toBe(false);
});

test("relabelled as vendor records, the same records are accepted whole and rank the model that holds the reference first", () => {
  const dir = mkdtempSync(join(root, "vendor-")), paths = [TURBO, REFERENCE].map(spec => {
    const path = join(dir, spec.replace(":", "_") + ".json");
    writeFileSync(path, JSON.stringify(asVendor(records[spec]!.record), null, 2) + "\n");
    return path;
  });
  const out = join(dir, "routing-results.json");
  const cli = Bun.spawnSync(["bun", join(REPO_ROOT, "packages/benchmarks/src/results.ts"), "--out", out, ...paths], { cwd: REPO_ROOT });
  expect(cli.exitCode).toBe(0);
  const bytes = readFileSync(out);
  expect(bytes.toString()).toBe(routingResultsText([asVendor(records[TURBO]!.record), asVendor(records[REFERENCE]!.record)]));
  // Exactly what the router pins when HV_ROUTING_QUALITY_RESULTS_PATH names the file.
  const quality = readRoutingResults({ HV_ROUTING_QUALITY_RESULTS_PATH: out });
  expect(quality).toEqual(routingQualityFrom(bytes));
  expect(quality.fallback).toBeNull();
  expect(quality.measured.map(entry => [entry.spec, entry.scoredShots])).toEqual([[REFERENCE, 10], [TURBO, 10]]);
  for (const entry of quality.measured) expect(entry.score).toBe(records[entry.spec]!.record.aggregate.identityMean);
  const [held, blind] = [quality.measured[0]!.score!, quality.measured[1]!.score!];
  expect(held).toBeGreaterThan(0.9);
  expect(blind).toBeLessThan(0.8);
  // A results file is never written over.
  expect(() => writeRoutingResults(paths, out)).toThrow(/already exists/);
});

test("the joiner is wired as bun run benchmark:results", () => {
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
  expect(scripts["benchmark:results"]).toBe("bun packages/benchmarks/src/results.ts");
});
