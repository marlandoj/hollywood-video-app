import { expect, test } from "bun:test";
import { baseCapability, capability, contentHash } from "../src/capabilities";
import { configuredPool, createProviderPlan, validateProviderPlan, withAnchorStoryboard } from "../src/catalog";
import { qualityFallback, validateRoutingQuality, type RoutingQuality } from "../src/quality-routing";
import { ProviderHealth, RoutedGenerator, type RouteDecision, type RouteRanking, type RouterOptions } from "../src/router";
import type { CostRecord, ProviderAdapter } from "../src/index";
import { readRoutingResults } from "../../benchmarks/src/routing-results";
import { measuredRecord, resultsFile } from "../../benchmarks/test/measured-records";

function fixture(name: string, price = 0, fail = false, synthetic = false): ProviderAdapter {
  const definition = baseCapability(name, name + "-model", "video");
  definition.output.nativeResolution = "requested";
  definition.synthetic = synthetic;
  definition.price = {...definition.price, unit: price ? "request" : "free", usd: price};
  const caps = capability(definition);
  return {name, model: caps.model, capabilities: caps, generate: async (_prompt, seed, _params, path) => {
    if (fail) throw Object.assign(new Error("Controlled provider outage"), {sunkCosts: []});
    return {path, seed, provider: name, model: caps.model, fingerprint: "a".repeat(64), durationSec: 2, cost: {provider: name, model: caps.model, prompt_tokens: 0, output_frames: 60, gpu_seconds: 0, total_cost_usd: price} satisfies CostRecord};
  }};
}
const target = (adapter: ProviderAdapter) => ({spec: adapter.name, provider: adapter.name, model: adapter.model, capabilityRevision: adapter.capabilities!.revision});
const params = {seed: 42, shotId: "shot-1", widthxheight: "640x360", durationSec: 2, fps: 30};
const HIGH = 1 - 8 / 256, LOW = 1 - 64 / 256;

async function route(adapters: ProviderAdapter[], options: Partial<RouterOptions> = {}) {
  const decisions: RouteDecision[] = [];
  let ranking: RouteRanking | undefined;
  const clip = await new RoutedGenerator({candidates: adapters.map(adapter => ({id: adapter.name, adapter})), maxAttemptUsd: 5, ...options,
    onRanking: value => {ranking = value;}, onDecision: async decision => {decisions.push(decision);}}).generate("A quiet garden in the rain.", 42, params, "unused");
  return {clip, decisions, ranking: ranking!};
}

test("quality ranks eligible providers by their measured score, and the decision names the strategy, the score and the file's digest", async () => {
  const unmeasured = fixture("unmeasured"), low = fixture("measured-low"), high = fixture("measured-high");
  const file = resultsFile([measuredRecord(target(low), 64), measuredRecord(target(high), 8)]);
  const quality = readRoutingResults({HV_ROUTING_QUALITY_RESULTS_PATH: file.path});
  const {clip, decisions, ranking} = await route([unmeasured, low, high], {strategy: "quality", quality});
  expect(ranking.strategy).toBe("quality");
  expect(ranking.orderedIds).toEqual(["measured-high", "measured-low", "unmeasured"]);
  expect(clip.provider).toBe("measured-high");
  expect(decisions).toHaveLength(1);
  const decision = decisions[0]!;
  expect(decision.strategy).toBe("quality");
  expect(decision.selectedId).toBe("measured-high");
  expect(decision.quality).toEqual({
    resultsSha256: file.sha256, metric: "identity-dhash256-midframe/1", fallback: null, selectedScore: HIGH,
    candidates: [
      {id: "measured-high", score: HIGH, reason: "measured: identity-dhash256-midframe/1 mean over 6 scored shots"},
      {id: "measured-low", score: LOW, reason: "measured: identity-dhash256-midframe/1 mean over 6 scored shots"},
      {id: "unmeasured", score: null, reason: "not measured: the results file has no record for unmeasured"},
    ],
  });
});

test("unmeasured providers rank after measured ones, keep their configured order, and carry score null with the reason", async () => {
  const first = fixture("unmeasured-first"), second = fixture("unmeasured-second"), low = fixture("measured-low"), drifted = fixture("measured-drifted"), empty = fixture("measured-empty");
  // A record measured under another capability revision is not this provider's score, and a pass that scored nothing is not a score at all.
  const quality = readRoutingResults({HV_ROUTING_QUALITY_RESULTS_PATH: resultsFile([measuredRecord(target(low), 64),
    measuredRecord({...target(drifted), capabilityRevision: "e".repeat(64)}, 1), measuredRecord(target(empty), 8, {scored: false})]).path});
  const {decisions, ranking} = await route([first, drifted, second, empty, low], {strategy: "quality", quality});
  expect(ranking.orderedIds).toEqual(["measured-low", "unmeasured-first", "measured-drifted", "unmeasured-second", "measured-empty"]);
  const scores = Object.fromEntries(decisions[0]!.quality!.candidates.map(value => [value.id, value]));
  expect(scores["measured-low"]!.score).toBe(LOW);
  for (const id of ["unmeasured-first", "unmeasured-second", "measured-drifted", "measured-empty"]) expect(scores[id]!.score).toBeNull();
  expect(scores["unmeasured-first"]!.reason).toBe("not measured: the results file has no record for unmeasured-first");
  expect(scores["measured-drifted"]!.reason).toMatch(/^not measured: the record was measured under capability revision eeeeeeeeeeee, not this provider's [0-9a-f]{12}$/);
  expect(scores["measured-empty"]!.reason).toBe("not measured: the measured pass scored no shot");
  // A synthetic adapter is never ranked on a score, even when a record names its exact revision.
  const standIn = fixture("stand-in", 0, false, true);
  const claimed = readRoutingResults({HV_ROUTING_QUALITY_RESULTS_PATH: resultsFile([measuredRecord(target(standIn), 1), measuredRecord(target(low), 64)]).path});
  const synthetic = await route([standIn, low], {strategy: "quality", quality: claimed});
  expect(synthetic.ranking.orderedIds).toEqual(["measured-low", "stand-in"]);
  expect(synthetic.decisions[0]!.quality!.candidates[1]).toEqual({id: "stand-in", score: null, reason: "not measured: a synthetic stand-in's picture is not routing evidence"});
});

test("eligibility, spend limits and failover are the existing ones: quality only orders what they admit", async () => {
  const pricey = fixture("measured-high", 3), low = fixture("measured-low", .5), free = fixture("unmeasured");
  const quality = readRoutingResults({HV_ROUTING_QUALITY_RESULTS_PATH: resultsFile([measuredRecord(target(pricey), 8), measuredRecord(target(low), 64)]).path});
  const configured = await route([pricey, low, free], {maxAttemptUsd: 1});
  const ranked = await route([pricey, low, free], {maxAttemptUsd: 1, strategy: "quality", quality});
  // The best-measured provider is over the cap: it ranks first and is still skipped for price.
  expect(ranked.ranking.orderedIds).toEqual(["measured-high", "measured-low", "unmeasured"]);
  expect(ranked.decisions[0]!.selectedId).toBe("measured-low");
  expect(ranked.decisions[0]!.quality!.selectedScore).toBe(LOW);
  const eligibility = (decision: RouteDecision) => Object.fromEntries(decision.candidates.map(value => [value.id, [value.eligible, value.reasons, value.estimateUsd]]));
  expect(eligibility(ranked.decisions[0]!)).toEqual(eligibility(configured.decisions[0]!));
  expect(ranked.decisions[0]!.candidates.find(value => value.id === "measured-high")!.reasons).toEqual(["price"]);
  // Failover walks the same ranked order: the best measured fails, the next measured runs before any unmeasured one.
  const failing = fixture("measured-high", 0, true), next = fixture("measured-low"), last = fixture("unmeasured");
  const failover = await route([last, next, failing], {strategy: "quality", quality: readRoutingResults({HV_ROUTING_QUALITY_RESULTS_PATH: resultsFile([measuredRecord(target(failing), 8), measuredRecord(target(next), 64)]).path})});
  expect(failover.decisions.map(value => [value.selectedId, value.quality!.selectedScore])).toEqual([["measured-high", HIGH], ["measured-low", LOW]]);
  expect(failover.clip.failedOver).toBe(true);
});

test("a tampered or stand-in results file is refused: the configured order is kept, the reason recorded, and no score invented", async () => {
  const unmeasured = fixture("unmeasured"), low = fixture("measured-low"), high = fixture("measured-high");
  const edited = measuredRecord(target(high), 8); edited.aggregate.identityMean = 1;
  for (const [records, reason] of [
    [[measuredRecord(target(low), 64), edited], /aggregate identityMean does not follow from the shots/],
    [[measuredRecord(target(low), 64), measuredRecord(target(high), 8, {synthetic: true})], /synthetic stand-in, and its scores are not routing evidence/],
  ] as const) {
    const quality = readRoutingResults({HV_ROUTING_QUALITY_RESULTS_PATH: resultsFile(records).path});
    const {decisions, ranking, clip} = await route([unmeasured, low, high], {strategy: "quality", quality});
    expect(ranking.orderedIds).toEqual(["unmeasured", "measured-low", "measured-high"]);
    expect(clip.provider).toBe("unmeasured");
    const recorded = decisions[0]!.quality!;
    expect(recorded.fallback).toMatch(reason);
    expect(recorded.resultsSha256).toBeNull();
    expect(recorded.selectedScore).toBeNull();
    for (const candidate of recorded.candidates) {
      expect(candidate.score).toBeNull();
      expect(candidate.reason).toStartWith("not measured: the benchmark results were not used (the results file was refused: ");
    }
  }
  const none = await route([unmeasured, low, high], {strategy: "quality", quality: readRoutingResults({})});
  expect(none.ranking.orderedIds).toEqual(["unmeasured", "measured-low", "measured-high"]);
  expect(none.decisions[0]!.quality).toMatchObject({fallback: "no benchmark results file is configured (HV_ROUTING_QUALITY_RESULTS_PATH)", selectedScore: null});
});

test("the router accepts a quality block only with the quality strategy, and only a valid one", () => {
  const candidates = [{id: "a", adapter: fixture("a")}], onDecision = async () => {};
  expect(() => new RoutedGenerator({candidates, strategy: "quality", maxAttemptUsd: 1, onDecision})).toThrow("Invalid routing policy");
  for (const strategy of ["configured", "cost", "latency"] as const) expect(() => new RoutedGenerator({candidates, strategy, quality: qualityFallback("x"), maxAttemptUsd: 1, onDecision})).toThrow("Invalid routing policy");
  const valid: RoutingQuality = {schema: "hv-routing-quality/1", resultsSha256: "a".repeat(64), metric: "identity-dhash256-midframe/1", fixtureSha256: "b".repeat(64), fallback: null,
    measured: [{spec: "a", provider: "a", model: "a-model", capabilityRevision: "c".repeat(64), score: .9, scoredShots: 6}]};
  expect(validateRoutingQuality(valid)).toEqual(valid);
  const invalid: unknown[] = [
    {...valid, measured: [{...valid.measured[0]!, score: 1.5}]},
    {...valid, measured: [{...valid.measured[0]!, score: .9, scoredShots: 0}]},
    {...valid, measured: [{...valid.measured[0]!, score: null, scoredShots: 6}]},
    {...valid, measured: [{...valid.measured[0]!, score: NaN}]},
    {...valid, measured: [valid.measured[0], valid.measured[0]]},
    {...valid, resultsSha256: null},
    {...qualityFallback("refused"), measured: valid.measured},
    {...qualityFallback("refused"), resultsSha256: "a".repeat(64)},
    {...valid, extra: true},
  ];
  for (const value of invalid) expect(() => new RoutedGenerator({candidates, strategy: "quality", quality: value as RoutingQuality, maxAttemptUsd: 1, onDecision})).toThrow("Invalid routing quality evidence");
});

test("admission pins the measured scores and the file's digest into the plan; quality is selectable but never the default", () => {
  const pool = '["fal:kling-o3-standard-reference","fal:kling-v2.5-turbo-pro","mock"]';
  const [reference, turbo] = configuredPool("final", {HV_PROVIDER_POOL: pool});
  const file = resultsFile([measuredRecord({spec: turbo!.spec, provider: turbo!.snapshot.adapter, model: turbo!.snapshot.model, capabilityRevision: turbo!.snapshot.revision}, 8),
    measuredRecord({spec: reference!.spec, provider: reference!.snapshot.adapter, model: reference!.snapshot.model, capabilityRevision: reference!.snapshot.revision}, 64)]);
  const env = {HV_PROVIDER_POOL: pool, HV_ROUTING_STRATEGY: "quality", HV_ROUTING_QUALITY_RESULTS_PATH: file.path};
  const plan = createProviderPlan("final", 5, undefined, env), configured = createProviderPlan("final", 5, undefined, {HV_PROVIDER_POOL: pool});
  expect(plan.strategy).toBe("quality");
  expect(plan.quality).toMatchObject({resultsSha256: file.sha256, fallback: null, measured: [{spec: "fal:kling-v2.5-turbo-pro", score: HIGH}, {spec: "fal:kling-o3-standard-reference", score: LOW}]});
  // The pool, its order, its prices and the per-shot cap are exactly the configured plan's.
  expect(plan.pool).toEqual(configured.pool);
  expect(plan.maxShotUsd).toBe(configured.maxShotUsd);
  expect(validateProviderPlan(plan)).toEqual(plan);
  const {schema: _schema, revision, ...data} = plan;
  expect(revision).toBe(contentHash(data));
  // An edited score is a changed plan; a resealed impossible score is not a plan at all.
  const edited = structuredClone(plan); edited.quality!.measured[0]!.score = .5;
  expect(() => validateProviderPlan(edited)).toThrow("changed");
  const {schema: _s, revision: _r, ...resealed} = edited; resealed.quality!.measured[0]!.score = 2;
  expect(() => validateProviderPlan({...resealed, schema: "hv-provider-plan/1", revision: contentHash(resealed)})).toThrow("Invalid routing quality evidence");
  const {quality: _quality, ...withoutQuality} = data;
  expect(() => validateProviderPlan({...withoutQuality, schema: "hv-provider-plan/1", revision: contentHash(withoutQuality)})).toThrow("Invalid saved provider plan");
  const stray = {...configured, quality: plan.quality}, {schema: _x, revision: _y, ...strayData} = stray;
  expect(() => validateProviderPlan({...strayData, schema: "hv-provider-plan/1", revision: contentHash(strayData)})).toThrow("Invalid saved provider plan");
  // An anchored job's appended storyboard slot keeps the pinned block and is simply unmeasured.
  const anchored = withAnchorStoryboard(plan, true, env);
  expect(anchored.quality).toEqual(plan.quality);
  expect(validateProviderPlan(anchored).pool.at(-1)!.spec).toBe("anchor-storyboard");
  // A refused file still admits the job, on the configured order, saying why.
  const refused = createProviderPlan("final", 5, undefined, {...env, HV_ROUTING_QUALITY_RESULTS_PATH: "/nonexistent/results.json"});
  expect(refused.quality).toEqual(qualityFallback("the configured results file could not be read (ENOENT)"));
  expect(validateProviderPlan(refused)).toEqual(refused);
  expect(() => createProviderPlan("final", 5, undefined, {HV_ROUTING_STRATEGY: "best"})).toThrow("Unknown routing strategy");
});

test("existing strategies are unchanged: no quality block in their plans, rankings or decisions", async () => {
  for (const strategy of [undefined, "configured", "cost", "latency"] as const) {
    const plan = createProviderPlan("final", 5, undefined, strategy ? {HV_ROUTING_STRATEGY: strategy, HV_ROUTING_QUALITY_RESULTS_PATH: "/nonexistent"} : {});
    expect(plan.strategy).toBe(strategy ?? "configured");
    expect(Object.keys(plan).sort()).toEqual(["maxShotUsd", "pool", "requirements", "revision", "schema", "stage", "strategy"]);
    const {schema: _schema, revision, ...data} = plan;
    expect(revision).toBe(contentHash({stage: data.stage, strategy: data.strategy, maxShotUsd: data.maxShotUsd, requirements: data.requirements, pool: data.pool}));
  }
  const health = new ProviderHealth();
  const expensive = fixture("expensive", 3), cheap = fixture("cheap", 1), tie = fixture("tie", 1);
  for (const [strategy, expected] of [["configured", ["expensive", "cheap", "tie"]], ["cost", ["cheap", "tie", "expensive"]], ["latency", ["expensive", "cheap", "tie"]]] as const) {
    const {decisions, ranking} = await route([expensive, cheap, tie], {strategy, health});
    expect(ranking.orderedIds).toEqual([...expected]);
    for (const decision of decisions) expect(Object.hasOwn(decision, "quality")).toBe(false);
  }
});
