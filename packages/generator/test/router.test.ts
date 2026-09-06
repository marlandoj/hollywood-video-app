import { expect, test } from "bun:test";
import { baseCapability, capability, contentHash, matchCapability, validateCapability, videoRequirements, type CapabilitySnapshot } from "../src/capabilities";
import { configuredPool, createProviderPlan, instantiateProviderPlan, validateProviderPlan } from "../src/catalog";
import { falVideoCapability } from "../src/fal";
import { falImageCapability } from "../src/fal-image";
import { ProviderHealth, RoutedGenerator, type RouteDecision } from "../src/router";
import { sunkCostsOf, type CostRecord, type ProviderAdapter } from "../src/index";

function fixture(name: string, price = 0, behavior?: ProviderAdapter["generate"]): ProviderAdapter {
  const definition = baseCapability(name, name + "-model", "video");
  definition.output.nativeResolution = "requested";
  definition.price = {...definition.price, unit: price ? "request" : "free", usd: price};
  const caps = capability(definition);
  return {name, model: caps.model, capabilities: caps, generate: behavior ?? (async (_prompt, seed, _params, path) => ({
    path, seed, provider: name, model: caps.model, fingerprint: "a".repeat(64), durationSec: 2, cost: cost(name, price),
  }))};
}
function cost(provider: string, usd: number): CostRecord {
  return {provider, model: provider + "-model", prompt_tokens: 0, output_frames: 60, gpu_seconds: 0, total_cost_usd: usd};
}
const params = {seed: 42, shotId: "shot-1", widthxheight: "640x360", durationSec: 2, fps: 30};
const prompt = "A quiet garden in the rain.";

test("metadata quotes billed duration and megapixel ceilings without an inference key", () => {
  const kling = falVideoCapability();
  expect(matchCapability(kling, videoRequirements({...params, durationSec: 6}), 5)).toMatchObject({eligible: true, estimateUsd: .7, billedDurationSec: 10});
  expect(matchCapability(kling, videoRequirements({...params, durationSec: 11}), 5).reasons).toContain("duration");
  expect(matchCapability(falVideoCapability("veo3-fast"), videoRequirements(params), 5)).toMatchObject({eligible: false, reasons: ["provider-retired"]});
  const image = {...videoRequirements(params), modality: "image" as const, width: 1920, height: 1080, fps: null, durationSec: null};
  expect(matchCapability(falImageCapability(), image, 5).estimateUsd).toBe(.009);
  expect(createProviderPlan("final", 5, undefined, {HV_PROVIDER_PRIMARY: "fal"}).pool[0]!.snapshot).toEqual(kling);
});

test("unsupported references, identity, audio, deterministic output and native resolution cannot silently degrade", () => {
  const requirements = videoRequirements({...params, widthxheight: "1920x1080", referenceFrames: ["private://never-read"], identityLocks: ["person-1"],
    routingRequirements: {audio: "native-dialogue", deterministic: true, nativeResolution: true, region: "local"}});
  const match = matchCapability(falVideoCapability("veo3-fast"), requirements, 5);
  expect(match.eligible).toBe(false);
  for (const reason of ["references", "identity", "audio", "determinism", "native-resolution", "region"] as const) expect(match.reasons).toContain(reason);
  expect(JSON.stringify(requirements)).not.toContain("private://");
  expect(matchCapability(falVideoCapability(), videoRequirements(params), .1).reasons).toContain("price");
});

test("capability snapshots are immutable, hashed and reject malformed numeric prices and bounds", () => {
  const snapshot = fixture("test").capabilities!;
  expect(Object.isFrozen(snapshot.output)).toBe(true);
  expect(validateCapability(snapshot)).toEqual(snapshot);
  expect(() => validateCapability({...snapshot, output: {...snapshot.output, maxWidth: 8192}})).toThrow("integrity");
  const {schema: _schema, revision: _revision, priceVersion: _price, ...definition} = snapshot;
  for (const patch of [{price: {...definition.price, usd: 1}}, {output: {...definition.output, maxWidth: NaN}},
    {price: {...definition.price, unit: "billed-second", usd: .1, billedDurationsSec: [10, 5]}}]) {
    expect(() => capability({...definition, ...patch} as typeof definition)).toThrow();
  }
});

test("admission pins normalized pool, policy and prices; execution rejects drift and untrusted models", () => {
  expect(configuredPool("final", {HV_PROVIDER_POOL: '["fal","fal:kling-v2.5-turbo-pro","mock"]'}).map(value => value.spec))
    .toEqual(["fal:kling-v2.5-turbo-pro", "mock"]);
  const plan = createProviderPlan("final", 5, {deterministic: true}, {});
  expect(validateProviderPlan(plan)).toEqual(plan);
  expect(instantiateProviderPlan(plan, {})[0]!.adapter.name).toBe("mock");
  expect(() => validateProviderPlan({...plan, maxShotUsd: 50})).toThrow("changed");
  expect(() => instantiateProviderPlan(plan, {HV_PROVIDER_POOL: '["fal"]'})).toThrow("changed");
  const paid = createProviderPlan("final", 5, undefined, {HV_PROVIDER_PRIMARY: "fal"});
  expect(() => instantiateProviderPlan(paid, {HV_PROVIDER_PRIMARY: "fal", HV_FAL_USD_PER_BILLED_SECOND: ".9"})).toThrow("changed");
  for (const spec of ['["https://evil.invalid/model"]', '["fal:__proto__"]', "[]", "{}"]) {
    expect(() => configuredPool("final", {HV_PROVIDER_POOL: spec})).toThrow();
  }
  expect(() => createProviderPlan("final", 5, {endpoint: "https://evil.invalid"}, {})).toThrow();
});

test("routing skips incapable adapters and saves a decision before the first dispatch", async () => {
  const events: string[] = [], decisions: RouteDecision[] = [];
  const expensive = fixture("expensive", 3), free = fixture("free");
  const original = free.generate;
  free.generate = async (...args) => {events.push("dispatch"); return original(...args);};
  const router = new RoutedGenerator({candidates: [{id: "expensive", adapter: expensive}, {id: "free", adapter: free}], maxAttemptUsd: 1,
    onDecision: async decision => {events.push("saved"); decisions.push(decision);}});
  const result = await router.generate(prompt, 42, params, "unused");
  expect(events).toEqual(["saved", "dispatch"]);
  expect(decisions[0]!.candidates[0]).toMatchObject({eligible: false, reasons: ["price"]});
  expect(result.routing?.decisionIds).toEqual([decisions[0]!.id]);
  expect(result.routing?.selectedCapability.adapter).toBe("free");
});

test("cost strategy chooses the cheapest eligible adapter; failed persistence prevents inference", async () => {
  const decisions: RouteDecision[] = [];
  const router = new RoutedGenerator({candidates: [{id: "costly", adapter: fixture("costly", .4)}, {id: "cheap", adapter: fixture("cheap", .2)}],
    strategy: "cost", maxAttemptUsd: 5, onDecision: async decision => {decisions.push(decision);}});
  expect((await router.generate(prompt, 42, params, "unused")).provider).toBe("cheap");
  expect(decisions[0]!.selectedId).toBe("cheap");
  let calls = 0;
  const adapter = fixture("never", 0, async () => {calls++; throw new Error("must not dispatch");});
  await expect(new RoutedGenerator({candidates: [{id: "never", adapter}], maxAttemptUsd: 5, onDecision: async () => {throw new Error("storage offline");}})
    .generate(prompt, 42, params, "unused")).rejects.toThrow("storage offline");
  expect(calls).toBe(0);
});

test("paid failover rechecks available shot budget and preserves failed attempt costs once", async () => {
  let available = .5, fallbackCalls = 0;
  const billed = cost("billed", .4), accounted: CostRecord[] = [], decisions: RouteDecision[] = [];
  const primary = fixture("billed", .4, async () => {throw Object.assign(new Error("provider failed"), {sunkCosts: [billed]});});
  const secondary = fixture("fallback", .2, async () => {fallbackCalls++; throw new Error("must not dispatch");});
  const router = new RoutedGenerator({candidates: [{id: "billed", adapter: primary}, {id: "fallback", adapter: secondary}], maxAttemptUsd: .5,
    availableUsd: async () => available, onDecision: async value => {decisions.push(value);}});
  try {await router.generate(prompt, 42, {...params, onAttemptCost: value => {accounted.push(value); available -= value.total_cost_usd;}}, "unused"); throw new Error("expected failure");}
  catch (error) {expect(sunkCostsOf(error)).toEqual([billed]);}
  expect(accounted).toEqual([billed]); expect(fallbackCalls).toBe(0); expect(decisions).toHaveLength(1);
});

test("abort with a primitive reason retains current paid cost and never dispatches a fallback", async () => {
  const controller = new AbortController(), billed = cost("paid", .2);
  const adapter = fixture("paid", .2, async () => {controller.abort("stop"); throw Object.assign(new Error("cancelled"), {sunkCosts: [billed]});});
  const router = new RoutedGenerator({candidates: [{id: "paid", adapter}], maxAttemptUsd: 5, onDecision: async () => {}});
  try {await router.generate(prompt, 42, {...params, signal: controller.signal}, "unused"); throw new Error("expected failure");}
  catch (error) {expect(sunkCostsOf(error)).toEqual([billed]);}
});

test("circuit breaker records observed latency, excludes an open provider and admits one recovery probe", async () => {
  let now = 100_000;
  const health = new ProviderHealth(() => now), adapter = fixture("healthy"), key = adapter.capabilities!.revision;
  expect(health.observation(key)).toMatchObject({state: "unknown", latencyMs: null});
  health.record(key, true, 100); health.record(key, true, 200);
  expect(health.observation(key).latencyMs).toBe(null);
  health.record(key, true, 100);
  expect(health.observation(key).latencyMs).toBe(116);
  for (let i = 0; i < 3; i++) health.record(key, false, 50);
  const decisions: RouteDecision[] = [];
  const router = new RoutedGenerator({candidates: [{id: "healthy", adapter}], maxAttemptUsd: 5, health, now: () => now,
    onDecision: async decision => {decisions.push(decision);}});
  await expect(router.generate(prompt, 42, params, "unused")).rejects.toThrow("circuit-open");
  now += 30_001;
  expect(health.acquire(key)).toBe(true); expect(health.acquire(key)).toBe(false);
  await expect(router.generate(prompt, 42, params, "unused")).rejects.toThrow("circuit-open");
  health.release(key);
  await router.generate(prompt, 42, params, "unused");
  expect(decisions.at(-1)!.candidates[0]!.eligible).toBe(true);
  expect(health.observation(key).state).toBe("closed");
  now += 600_001;
  expect(health.observation(key).state).toBe("unknown");
});

test("latency strategy uses observed samples and capability drift halts dispatch", async () => {
  const health = new ProviderHealth(), slow = fixture("slow"), fast = fixture("fast");
  for (let i = 0; i < 3; i++) {health.record(slow.capabilities!.revision, true, 500); health.record(fast.capabilities!.revision, true, 20);}
  const router = new RoutedGenerator({candidates: [{id: "slow", adapter: slow}, {id: "fast", adapter: fast}], strategy: "latency", maxAttemptUsd: 5, health,
    onDecision: async () => {}});
  expect((await router.generate(prompt, 42, params, "unused")).provider).toBe("fast");
  let current = slow.capabilities!;
  const mutable: ProviderAdapter = {...slow, get capabilities() {return current;}};
  const drift = new RoutedGenerator({candidates: [{id: "slow", adapter: mutable}], maxAttemptUsd: 5, onDecision: async () => {}});
  const {schema: _schema, revision: _revision, priceVersion: _price, ...definition} = current;
  current = capability({...definition, price: {...definition.price, unit: "request", usd: 1}});
  await expect(drift.generate(prompt, 42, params, "unused")).rejects.toThrow("capability-changed");
  expect(contentHash(current)).not.toBe(contentHash(slow.capabilities as CapabilitySnapshot));
});
