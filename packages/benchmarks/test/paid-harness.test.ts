/**
 * HV-037-02. `bun run benchmark:paid` refuses unless the provider is a paid video model named in
 * full, a spend is declared on the command line **and** in the increment doc that names the
 * provider, and the runtime's ledger and caps admit it.
 *
 * No paid provider is constructed or called here: every refusal is shown to happen before
 * `resolveProvider` runs and with `fetch` replaced by a spy, and the one authorized path runs
 * against a local priced stand-in through an injected resolver, recording to a temporary ledger.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CostLedger } from "../../operator/src/index";
import { FAL_MODELS, FalVideoProvider } from "../../generator/src/index";
import { loadReferences, planMeasuredPass, plannedCostUsd, readMeasuredRecord } from "../src/measured";
import { declaredSpendOf, defaultPaidRunDeps, docNamesProvider, parsePaidArgs, runPaidBenchmark, PaidBenchmarkRefusal, type PaidRunDeps } from "../src/paid";
import { ReferenceLoopProvider, writeReferences } from "./stand-ins";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SPEC = "fal:kling-o3-standard-reference";
const DOC = `# HV-037-99 — paid pass\n\nepic: HV-037\nspend_usd: 20\n\nOne pass of the corpus on \`${SPEC}\`.\n`;

let root = "";
let refsDir = "";
let fetchCalls = 0;
const realFetch = globalThis.fetch;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hv-paid-"));
  refsDir = join(root, "refs");
  writeReferences(refsDir);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
beforeEach(() => {
  fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("no network in this test"); }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

interface Harness { deps: PaidRunDeps; resolved: string[]; provider: ReferenceLoopProvider; ledgerPath: string }
function harness(over: { doc?: string | null; usdPerShot?: number; billedUsd?: number } = {}): Harness {
  const resolved: string[] = [];
  const provider = new ReferenceLoopProvider({ conditioned: true, usdPerShot: over.usdPerShot ?? 0.25, billedUsd: over.billedUsd, name: "priced-stand-in" });
  const ledgerPath = join(mkdtempSync(join(root, "ledger-")), "cost-ledger.json");
  const base = defaultPaidRunDeps(REPO_ROOT);
  const deps: PaidRunDeps = {
    ...base,
    readIncrementDoc: increment => increment === "HV-037-99" ? (over.doc === undefined ? DOC : over.doc) : base.readIncrementDoc(increment),
    resolveProvider: spec => { resolved.push(spec); return provider; },
    outDir: mkdtempSync(join(root, "out-")),
    runId: "test-run",
  };
  return { deps, resolved, provider, ledgerPath };
}
const argv = (over: Record<string, string | undefined> = {}) => {
  const values: Record<string, string | undefined> = { "--provider": SPEC, "--declared-usd": "20", "--increment": "HV-037-99", "--references": refsDir, ...over };
  return Object.entries(values).filter(([, value]) => value !== undefined).flatMap(([key, value]) => [key, value!]);
};
const env = (h: Harness, over: Record<string, string | undefined> = {}) => ({ HV_COST_LEDGER_PATH: h.ledgerPath, ...over });

async function expectRefused(h: Harness, args: string[], environment: Record<string, string | undefined>, reason: RegExp) {
  const attempt = runPaidBenchmark(args, environment, h.deps);
  await expect(attempt).rejects.toBeInstanceOf(PaidBenchmarkRefusal);
  await expect(runPaidBenchmark(args, environment, h.deps)).rejects.toThrow(reason);
  expect(h.resolved).toEqual([]);
  expect(h.provider.calls).toEqual([]);
  expect(fetchCalls).toBe(0);
  expect(existsSync(h.ledgerPath)).toBe(false);
}

describe("a paid provider without a declaration is refused before anything is constructed", () => {
  test("no --declared-usd", async () => {
    const h = harness();
    await expectRefused(h, argv({ "--declared-usd": undefined }), env(h), /needs a declared spend/);
  });

  test("a declared amount that is not plain dollars above zero", async () => {
    for (const bad of ["0", "-5", "1e3", "abc", "20.555", "Infinity"]) {
      const h = harness();
      await expectRefused(h, argv({ "--declared-usd": bad }), env(h), /plain dollars above zero/);
    }
  });

  test("no increment, or an increment doc that does not exist", async () => {
    const h = harness();
    await expectRefused(h, argv({ "--increment": undefined }), env(h), /name the increment/);
    await expectRefused(h, argv({ "--increment": "HV-037-98" }), env(h), /does not exist/);
  });

  test("this increment's own doc declares spend_usd: 0, so the harness will not spend under it", async () => {
    const own = readFileSync(join(REPO_ROOT, "docs/loop/increments/HV-037-02.md"), "utf8");
    expect(declaredSpendOf(own)).toBe(0);
    const h = harness();
    await expectRefused(h, argv({ "--increment": "HV-037-02" }), env(h), /HV-037-02 declares no spend \(spend_usd: 0\)/);
  });

  test("a doc that declares spend but does not name the provider, or names a different model", async () => {
    const h = harness({ doc: "epic: HV-037\nspend_usd: 20\n\nOne pass on `fal:kling-v2.5-turbo-pro`.\n" });
    await expectRefused(h, argv(), env(h), /does not name fal:kling-o3-standard-reference/);
    const prefix = harness({ doc: "spend_usd: 20\nfal:kling-o3-standard-reference-v2 only\n" });
    await expectRefused(prefix, argv(), env(prefix), /does not name/);
    const none = harness({ doc: "epic: HV-037\n\nfal:kling-o3-standard-reference\n" });
    await expectRefused(none, argv(), env(none), /declares no spend \(spend_usd: absent\)/);
  });
});

describe("only a paid video model, named in full, is admitted", () => {
  test("the mock, a bare family, an unknown model and a non-video spec are refused", async () => {
    for (const [spec, reason] of [["mock", /not a paid provider/], ["", /name the provider/], ["anchor-storyboard", /not a paid provider/],
      ["fal", /name the model in full/], ["fal:no-such-model", /not a known fal video model/], ["image:fal", /name the model in full|not a paid provider/]] as const) {
      const h = harness();
      await expectRefused(h, argv({ "--provider": spec }), env(h), reason);
    }
  });
});

describe("the runtime must admit the declared spend", () => {
  test("no ledger path, or a database ledger the harness cannot see", async () => {
    const h = harness();
    await expectRefused(h, argv(), {}, /HV_COST_LEDGER_PATH is not set/);
    await expectRefused(h, argv(), env(h, { HV_WORKER_DATABASE_URL: "postgres://x" }), /HV_WORKER_DATABASE_URL is set/);
  });

  test("above the per-film limit, or a cap the studio cannot read", async () => {
    const h = harness({ doc: DOC.replace("spend_usd: 20", "spend_usd: 60") });
    await expectRefused(h, argv({ "--declared-usd": "41" }), env(h), /above the per-film limit of \$40\.00/);
    await expectRefused(h, argv({ "--declared-usd": "20" }), env(h, { HV_FILM_SPEND_CAP_USD: "15" }), /above the per-film limit of \$15\.00/);
    await expectRefused(h, argv(), env(h, { HV_MONTHLY_BUDGET_USD: "abc" }), /HV_MONTHLY_BUDGET_USD/);
    await expectRefused(h, argv(), env(h, { HV_COST_CAP_PER_SHOT_USD: "lots" }), /HV_COST_CAP_PER_SHOT_USD/);
    // The program's $500 envelope bounds the film limit even when the monthly setting is higher.
    await expectRefused(h, argv({ "--declared-usd": "20" }), env(h, { HV_MONTHLY_BUDGET_USD: "5000", HV_FILM_SPEND_CAP_USD: "600" }), /between 0 and the monthly cap/);
  });

  test("the plan priced above the declaration is refused before the ledger is touched", async () => {
    // Pricing needs the provider's capability, so this is the one refusal that constructs it -- and
    // it still renders nothing, calls nothing and writes no ledger.
    const h = harness({ usdPerShot: 1 });
    await expect(runPaidBenchmark(argv(), env(h), h.deps)).rejects.toThrow(/priced at \$24\.00, above the \$20 declared/);
    expect(h.resolved).toEqual([SPEC]);
    expect(h.provider.calls).toEqual([]);
    expect(fetchCalls).toBe(0);
    expect(existsSync(h.ledgerPath)).toBe(false);
  });

  test("an increment's earlier passes count against its declaration", async () => {
    const h = harness();
    new CostLedger(h.ledgerPath).record({ provider: "fal", model: "m", prompt_tokens: 0, output_frames: 0, gpu_seconds: 0, total_cost_usd: 8,
      at: new Date().toISOString(), projectId: "benchmark:HV-037-99", shotId: "shot-1-1", jobId: "benchmark:HV-037-99:earlier" });
    const before = readFileSync(h.ledgerPath, "utf8");
    await expect(runPaidBenchmark(argv({ "--declared-usd": "15" }), env(h), h.deps)).rejects.toThrow(/\$8 is already spent under it/);
    expect(h.resolved).toEqual([]);
    expect(readFileSync(h.ledgerPath, "utf8")).toBe(before);
  });

  test("references are required and must carry structure", async () => {
    const h = harness();
    await expect(runPaidBenchmark(argv({ "--references": undefined }), env(h), h.deps)).rejects.toThrow(/needs the corpus's locked references/);
    const flatDir = mkdtempSync(join(root, "flat-"));
    Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=256x256", "-frames:v", "1", join(flatDir, "keeper.png")]);
    await expect(runPaidBenchmark(argv({ "--references": flatDir }), env(h), h.deps)).rejects.toThrow(/KEEPER is a flat picture/);
    expect(h.provider.calls).toEqual([]);
  });

  test("the month's cap refuses the reservation before any shot", async () => {
    const h = harness();
    new CostLedger(h.ledgerPath).record({ provider: "fal", model: "m", prompt_tokens: 0, output_frames: 0, gpu_seconds: 0, total_cost_usd: 490,
      at: new Date().toISOString(), projectId: "other-film", shotId: "s", jobId: "other-job" });
    await expect(runPaidBenchmark(argv(), env(h, { HV_MONTHLY_BUDGET_USD: "500" }), h.deps)).rejects.toThrow(/generation capacity is reserved/);
    expect(h.provider.calls).toEqual([]);
    expect(new CostLedger(h.ledgerPath).reservedUsd()).toBe(0);
  });
});

describe("an admitted pass is held by the ledger", () => {
  test("every shot's cost is recorded under the increment, the reservation is released, and the record reads back", async () => {
    const h = harness();
    const { record, out } = await runPaidBenchmark(argv({ "--out": join(root, "admitted.json") }), env(h), h.deps);
    expect(h.resolved).toEqual([SPEC]);
    expect(fetchCalls).toBe(0);
    expect(h.provider.calls).toHaveLength(24);
    const ledger = new CostLedger(h.ledgerPath);
    const events = ledger.all();
    expect(events).toHaveLength(24);
    expect(new Set(events.map(event => event.projectId))).toEqual(new Set(["benchmark:HV-037-99"]));
    expect(events.reduce((sum, event) => sum + event.total_cost_usd, 0)).toBeCloseTo(6, 9);
    expect(ledger.reservedUsd()).toBe(0);
    expect(record).toMatchObject({ providerSpec: SPEC, provider: "priced-stand-in", model: "reference-loop-v1", increment: "HV-037-99", declaredUsd: 20 });
    expect(record.aggregate).toMatchObject({ rendered: 24, scoredShots: 10, totalCostUsd: 6 });
    expect(out).toBe(join(root, "admitted.json"));
    expect(readMeasuredRecord(JSON.parse(readFileSync(out, "utf8")), { allowSynthetic: true }).aggregate.identityMean).toBe(record.aggregate.identityMean);
  }, 120_000);

  test("a provider that bills past its estimate stops when the declaration is spent", async () => {
    const h = harness({ usdPerShot: 0.25, billedUsd: 4 });
    const { record } = await runPaidBenchmark(argv({ "--declared-usd": "10" }), env(h), h.deps);
    // $10 held: shots at $4 each until what remains cannot cover the next $0.25 estimate.
    expect(h.provider.calls).toHaveLength(3);
    expect(record.aggregate).toMatchObject({ rendered: 3, skipped: 21, totalCostUsd: 12 });
    expect(record.shots.slice(3).every(shot => shot.status === "skipped" && /declared spend exhausted/.test(shot.reason ?? ""))).toBe(true);
    expect(new CostLedger(h.ledgerPath).reservedUsd()).toBe(0);
  }, 120_000);
});

describe("what a paid pass of the corpus would cost, priced offline from each model's own capability", () => {
  test("per fal video model: eligible shots, the planned total, and why a model cannot run", () => {
    const references = loadReferences({ KEEPER: join(refsDir, "keeper.png"), SAILOR: join(refsDir, "sailor.png") });
    const never = (() => { fetchCalls += 1; throw new Error("no network in this test"); }) as unknown as typeof fetch;
    const priced = Object.keys(FAL_MODELS).map(model => {
      const plan = planMeasuredPass(new FalVideoProvider({ model, apiKey: "offline-test-key", fetchImpl: never }), references, 5);
      return [model, plan.filter(entry => entry.match.eligible).length, plannedCostUsd(plan), [...new Set(plan.flatMap(entry => entry.match.reasons))].sort()] as const;
    });
    expect(priced).toEqual([
      // The anchored (look-matched) profile needs a first-frame still per shot, which the corpus does not carry.
      ["kling-o3-standard-keyframes", 0, 0, ["frame-anchors"]],
      // Reference-conditioned: only the ten shots with a locked character, at the 3 s minimum.
      ["kling-o3-standard-reference", 10, 2.52, ["references"]],
      ["kling-v2.5-turbo-pro", 24, 8.4, []],
      ["veo3-fast", 0, 0, ["provider-retired"]],
    ]);
    expect(fetchCalls).toBe(0);
  });
});

describe("argument and doc parsing", () => {
  test("arguments are flag/value pairs, each once", () => {
    expect(parsePaidArgs(["--provider", SPEC, "--declared-usd", "20"])).toEqual({ provider: SPEC, declaredUsd: "20" });
    expect(() => parsePaidArgs(["--provider"])).toThrow(/Usage/);
    expect(() => parsePaidArgs(["--provider", "--declared-usd"])).toThrow(/Usage/);
    expect(() => parsePaidArgs(["--spend", "20"])).toThrow(/Usage/);
    expect(() => parsePaidArgs(["--provider", "a", "--provider", "b"])).toThrow(/twice/);
  });

  test("spend_usd and the provider are read as the loop reads them", () => {
    expect(declaredSpendOf("epic: HV-037\nspend_usd: 20\n")).toBe(20);
    expect(declaredSpendOf("spend_usd: 12.50\n")).toBe(12.5);
    expect(declaredSpendOf("spend_usd: lots\n")).toBeNull();
    expect(declaredSpendOf("no declaration")).toBeNull();
    expect(docNamesProvider("on `fal:kling-v2.5-turbo-pro`.", "fal:kling-v2.5-turbo-pro")).toBe(true);
    expect(docNamesProvider("on fal:kling-v2.5-turbo-pro.", "fal:kling-v2.5-turbo-pro")).toBe(true);
    expect(docNamesProvider("on fal:kling-o3-standard-reference", "fal:kling-o3-standard")).toBe(false);
    expect(docNamesProvider("on xfal:kling-v2.5-turbo-pro", "fal:kling-v2.5-turbo-pro")).toBe(false);
  });

  test("the entry point is wired as bun run benchmark:paid", () => {
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
    expect(scripts["benchmark:paid"]).toBe("bun packages/benchmarks/src/paid.ts");
  });

  test("run as a command, it refuses a paid provider with no declaration and exits 2", () => {
    const ledgerDir = mkdtempSync(join(root, "cli-"));
    const result = Bun.spawnSync(["bun", join(REPO_ROOT, "packages/benchmarks/src/paid.ts"), "--provider", "fal:kling-v2.5-turbo-pro", "--increment", "HV-037-02"],
      { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HV_COST_LEDGER_PATH: join(ledgerDir, "ledger.json") } });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toMatch(/needs a declared spend/);
    expect(existsSync(join(ledgerDir, "ledger.json"))).toBe(false);
  });
});
