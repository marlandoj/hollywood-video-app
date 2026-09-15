// The adapter conformance suite FULL-SCOPE §7 and §8 require before a provider
// is promoted. It is table-driven over PROVIDER_REGISTRY × stages, so every
// registered (stage, spec) pair is checked and a new registry entry — including
// one that appears automatically from a new FAL_MODELS key — immediately demands
// a matching adapter.
//
// Nothing here dispatches to a paid provider. Every paid adapter is constructed
// with a literal fixture key, globalThis.fetch is replaced by a stub that throws
// on any call, and the stub is asserted never to have been called.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  PAID_SPEC_FAMILIES, PROVIDER_REGISTRY, STAGES, normalizeSpec, registeredSpecs, registeredSpellings,
  registryEntry, specIsPaid, specNamesPaidFamily, type RegistryEntry, type Stage,
} from "../src/registry";
import { configuredPool, createProviderPlan, describeProvider, instantiateProviderPlan, type ProviderPlan } from "../src/catalog";
import { capability, contentHash, matchCapability, validateCapability, type CapabilitySnapshot, type RejectionReason, type ShotRequirements } from "../src/capabilities";
import { DeterministicMockProvider, resolveAnimaticProvider, resolveProvider, providerUsesPaidInference, type ProviderAdapter } from "../src/index";
import { AnchorStoryboardProvider } from "../src/anchor-storyboard";
import { DEFAULT_FAL_MODEL, FAL_MODELS } from "../src/fal";
import { DEFAULT_FAL_IMAGE_MODEL, FAL_IMAGE_MODELS, FalImageProvider, resolveImageProvider } from "../src/fal-image";
// The leaf module: importing ../../observability/src/index here would pull the OpenTelemetry SDK
// and two OTLP exporters into this suite's module graph for two functions.
import { PROVIDER_KINDS, providerKind } from "../../observability/src/provider-kinds";

const FIXTURE_KEY = "hv019-conformance-fixture-only";
const ENV: Record<string, string | undefined> = { FAL_KEY: FIXTURE_KEY };
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const EVIDENCE_PATH = join(REPO_ROOT, "docs/evidence/hv019-router/adapter-conformance.json");
const HAS_FFMPEG = Bun.which("ffmpeg") !== null;

const root = mkdtempSync(join(tmpdir(), "hv-conformance-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let fetchCalls = 0;
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("The conformance suite performs no network calls.");
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

interface CheckRecord { name: string; pairs: number; passed: number; skipped: number; skipReason?: string }
const checks: CheckRecord[] = [];
const record = (value: CheckRecord) => { checks.push(value); };

const snapshotOf = (entry: RegistryEntry): CapabilitySnapshot => describeProvider(entry.spec, entry.stage, ENV).snapshot;
const adapterOf = (entry: RegistryEntry): ProviderAdapter =>
  entry.stage === "final" ? resolveProvider(entry.spec, ENV) : resolveAnimaticProvider(entry.spec, ENV);

/** A requirements vector every registered adapter should accept, derived from its own snapshot. */
function eligibleVector(snapshot: CapabilitySnapshot): ShotRequirements {
  const multiple = snapshot.output.dimensionMultiple;
  const width = Math.ceil(snapshot.output.minWidth / multiple) * multiple;
  const height = Math.ceil(snapshot.output.minHeight / multiple) * multiple;
  const anchors = snapshot.frameControlMode && snapshot.frameControls.first && snapshot.input.minimumFirstFrame
    ? { first: true as const, last: false, intermediate: false, mode: snapshot.frameControlMode }
    : undefined;
  return {
    modality: snapshot.modality, width, height,
    fps: snapshot.output.fps ? snapshot.output.fps[0] : null,
    durationSec: snapshot.output.durationSec ? snapshot.output.durationSec[0] : null,
    referenceFrames: snapshot.input.minimumReferenceFrames ?? 0,
    identityLocks: 0, cameraMove: null, audio: "any",
    deterministic: false, nativeResolution: false, allowSynthetic: true, region: "any",
    ...(anchors ? { frameAnchors: anchors } : {}),
  };
}
const estimateFor = (snapshot: CapabilitySnapshot) => matchCapability(snapshot, eligibleVector(snapshot), 1e6).estimateUsd;
/** The budget that makes the eligible vector affordable, and nothing more. */
const exactBudget = (snapshot: CapabilitySnapshot) => estimateFor(snapshot) ?? 0;

// ---------------------------------------------------------------------------
// 1. Registry derivation
// ---------------------------------------------------------------------------
test("conformance: the registry is derived from the model records, in both directions", () => {
  const finalFal = registeredSpecs("final").filter((spec) => spec.startsWith("fal:"));
  expect(finalFal.sort()).toEqual(Object.keys(FAL_MODELS).map((model) => `fal:${model}`).sort());
  expect(registryEntry("fal", "final")?.spec).toBe(`fal:${DEFAULT_FAL_MODEL}`);
  for (const stage of STAGES) {
    const image = registeredSpecs(stage).filter((spec) => spec.startsWith("image:fal:"));
    expect(image.sort()).toEqual(Object.keys(FAL_IMAGE_MODELS).map((model) => `image:fal:${model}`).sort());
    expect(registryEntry("image:fal", stage)?.spec).toBe(`image:fal:${DEFAULT_FAL_IMAGE_MODEL}`);
  }
  // No spec is registered twice on one stage, and no alias collides with a spec.
  for (const stage of STAGES) {
    const spellings = registeredSpellings(stage);
    expect(new Set(spellings).size).toBe(spellings.length);
  }
  // The paid families are derived, not transcribed. A new shape must be a decision, not a surprise.
  expect([...PAID_SPEC_FAMILIES].sort()).toEqual(["fal:", "image:fal:"]);
  record({ name: "registry-derivation", pairs: PROVIDER_REGISTRY.length, passed: PROVIDER_REGISTRY.length, skipped: 0 });
});

// ---------------------------------------------------------------------------
// 2. Totality and mutual consistency of the spec switches
// ---------------------------------------------------------------------------
test("conformance: describeProvider, the stage resolver and specIsPaid agree on every registered pair", () => {
  for (const entry of PROVIDER_REGISTRY) {
    const described = describeProvider(entry.spec, entry.stage, ENV);
    const snapshot = described.snapshot;
    expect(described.spec).toBe(entry.spec);
    expect(snapshot.adapter).toBe(entry.adapter);
    expect(snapshot.modality).toBe(entry.modality);
    expect(specIsPaid(entry.spec, entry.stage)).toBe(snapshot.price.unit !== "free");
    expect(entry.paid).toBe(snapshot.price.unit !== "free");

    const adapter = adapterOf(entry);
    expect(adapter.name).toBe(snapshot.adapter);
    expect(adapter.model).toBe(snapshot.model);
    // The invariant instantiateProviderPlan enforces at claim time.
    expect(adapter.capabilities?.revision).toBe(snapshot.revision);
  }
  record({ name: "switch-totality", pairs: PROVIDER_REGISTRY.length, passed: PROVIDER_REGISTRY.length, skipped: 0 });
});

test("conformance: an unregistered (stage, spec) pair is refused at admission", () => {
  const spellings = [...new Set(PROVIDER_REGISTRY.flatMap((entry) => [entry.spec, ...entry.aliases]))];
  const extra = ["fal:veo3-nonexistent", "image:falcon", "image:fal:flux-nonexistent", " mock ", "MOCK", "x".repeat(201), "fal:constructor", "image:fal:toString"];
  let refused = 0;
  const resolverAccepts: string[] = [];
  for (const stage of STAGES) {
    for (const spec of [...spellings, ...extra]) {
      if (registryEntry(spec, stage)) continue;
      expect(() => describeProvider(spec, stage, ENV)).toThrow();
      refused += 1;
      let accepted = true;
      try { if (stage === "final") resolveProvider(spec, ENV); else resolveAnimaticProvider(spec, ENV); } catch { accepted = false; }
      if (accepted) resolverAccepts.push(`${stage}:${spec}`);
    }
  }
  // The resolvers are laxer than admission in exactly two places: resolveAnimaticProvider
  // answers for anchor-storyboard and legacy-mock regardless of stage, while describeProvider
  // refuses both on character-sheet. Neither is reachable — admission runs first and
  // withAnchorStoryboard skips character-sheet — but the set is pinned so that widening it
  // has to be a decision.
  expect(resolverAccepts.sort()).toEqual(["character-sheet:anchor-storyboard", "character-sheet:legacy-mock"]);
  record({ name: "unregistered-refused", pairs: refused, passed: refused, skipped: 0 });
});

test("conformance: providerUsesPaidInference answers for the family, not only for known models", () => {
  for (const spec of ["fal", "fal:model", "image:fal", "image:fal:flux-schnell"]) expect(providerUsesPaidInference(spec)).toBe(true);
  for (const spec of ["mock", "legacy-mock", "image:mock", "anchor-storyboard", "", "falcon", "image:falcon"]) expect(providerUsesPaidInference(spec)).toBe(false);
  for (const entry of PROVIDER_REGISTRY) expect(specNamesPaidFamily(entry.spec)).toBe(entry.paid);
  record({ name: "paid-family", pairs: PROVIDER_REGISTRY.length + 11, passed: PROVIDER_REGISTRY.length + 11, skipped: 0 });
});

// ---------------------------------------------------------------------------
// 3. Normalization is a fixed point, and the image:-on-final passthrough is gone
// ---------------------------------------------------------------------------
test("conformance: spec normalization is idempotent for every spelling on every stage", () => {
  let pairs = 0;
  for (const stage of STAGES) {
    for (const spelling of registeredSpellings(stage)) {
      const once = normalizeSpec(spelling, stage);
      expect(normalizeSpec(once, stage)).toBe(once);
      const described = describeProvider(spelling, stage, ENV).spec;
      expect(described).toBe(once);
      expect(describeProvider(described, stage, ENV).spec).toBe(described);
      pairs += 1;
    }
  }
  record({ name: "normalization-fixed-point", pairs, passed: pairs, skipped: 0 });
});

test("conformance: two spellings of one image model are one pool entry and therefore one circuit", () => {
  const pool = configuredPool("final", { ...ENV, HV_PROVIDER_POOL: JSON.stringify(["image:fal", "image:fal:flux-schnell"]) });
  expect(pool.map((entry) => entry.spec)).toEqual([`image:fal:${DEFAULT_FAL_IMAGE_MODEL}`]);
  // The circuit breaker is keyed on the capability revision, so identical snapshots
  // under two specs would have shared one circuit and one half-open probe.
  expect(new Set(pool.map((entry) => entry.snapshot.revision)).size).toBe(pool.length);

  // image:mock must not collapse to mock: their final-stage adapters differ.
  const imageMock = describeProvider("image:mock", "final", ENV);
  const plainMock = describeProvider("mock", "final", ENV);
  expect(imageMock.spec).toBe("image:mock");
  expect(imageMock.snapshot.adapter).toBe("rich-animatic");
  expect(plainMock.snapshot.adapter).toBe("mock");
  expect(imageMock.snapshot.revision).not.toBe(plainMock.snapshot.revision);
  record({ name: "image-spec-dedup", pairs: 3, passed: 3, skipped: 0 });
});

test("conformance: a plan admitted under the old spelling fails closed rather than executing", () => {
  const plan = createProviderPlan("final", 10, undefined, { ...ENV, HV_PROVIDER_POOL: JSON.stringify(["image:fal:flux-schnell"]) });
  const { schema: _schema, revision: _revision, ...data } = plan;
  const stale = { ...data, pool: [{ ...data.pool[0]!, spec: "image:fal" }] };
  const staleplan: ProviderPlan = { ...stale, schema: "hv-provider-plan/1", revision: contentHash(stale) };
  expect(() => instantiateProviderPlan(staleplan, { ...ENV, HV_PROVIDER_POOL: JSON.stringify(["image:fal:flux-schnell"]) }))
    .toThrow("Provider configuration changed after this job was queued.");
  record({ name: "stale-spelling-fails-closed", pairs: 1, passed: 1, skipped: 0 });
});

// ---------------------------------------------------------------------------
// 4. Snapshot integrity
// ---------------------------------------------------------------------------
test("conformance: every registered snapshot is valid, stable, frozen and built without a key", () => {
  const bare: Record<string, string | undefined> = {};
  for (const entry of PROVIDER_REGISTRY) {
    // Metadata construction must not need an inference key: the API process holds none.
    const first = describeProvider(entry.spec, entry.stage, bare).snapshot;
    const second = describeProvider(entry.spec, entry.stage, bare).snapshot;
    expect(first.revision).toBe(second.revision);
    expect(first.priceVersion).toBe(second.priceVersion);
    expect(validateCapability(first).revision).toBe(first.revision);
    const unfrozen: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (!value || typeof value !== "object") return;
      if (!Object.isFrozen(value)) unfrozen.push(path);
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    };
    walk(first, `${entry.stage}:${entry.spec}`);
    expect(unfrozen).toEqual([]);
    expect(first.policy.adapterPolicyVersion).toBe("studio-generation-safety/1");
    expect(first.price.invoiceReconciled).toBe(false);
  }
  // Execution, unlike metadata, does need the key, and says so rather than dispatching without one.
  expect(() => resolveImageProvider("image:fal", {})).toThrow("FAL_KEY is required for image inference");
  expect(() => new FalImageProvider({ apiKey: "", model: DEFAULT_FAL_IMAGE_MODEL })).toThrow();

  // --- the revision-bump contract -----------------------------------------------------------
  // A later increment will add a field to CapabilityDefinition. What follows makes the safe shape of
  // that change a test rather than a belief, because the unsafe shape is unrecoverable: a *required*
  // field, or any tightened validator, makes capability() throw on definitions that are already
  // stored, and that propagates through validateCapability -> validateProviderPlan into
  // renderInputHash and the shot-execution equivalence chain — every retained plan permanently
  // unreadable and shot reuse permanently dead, on records that are content-addressed and cannot be
  // rewritten without breaking their own seals.
  const { schema: _s, revision: _r, priceVersion: _p, ...base } = describeProvider("mock", "final", ENV).snapshot;
  const plain = capability(structuredClone(base));
  const extended = capability({ ...structuredClone(base), health: "none" } as typeof base);

  // (i) An additive field moves the revision. A plan admitted before the addition therefore no longer
  //     matches the live pool, and fails closed with the message the operator is meant to see.
  expect(extended.revision).not.toBe(plain.revision);
  const admitted = createProviderPlan("final", 10, undefined, { ...ENV, HV_PROVIDER_POOL: JSON.stringify(["mock"]) });
  const { schema: _ps, revision: _pr, ...planData } = admitted;
  const bumped = { ...planData, pool: [{ spec: "mock", snapshot: extended }] };
  expect(() => instantiateProviderPlan({ ...bumped, schema: "hv-provider-plan/1", revision: contentHash(bumped) },
    { ...ENV, HV_PROVIDER_POOL: JSON.stringify(["mock"]) }))
    .toThrow("Provider configuration changed after this job was queued.");

  // (ii) Both shapes round-trip. A definition carrying the new field validates, and so does one
  //      lacking it — so retained provenance stays verifiable across the addition *and* across a
  //      rollback to the build that predates it.
  expect(validateCapability(extended).revision).toBe(extended.revision);
  expect(validateCapability(plain).revision).toBe(plain.revision);

  // (iii) The forbidden move. Removing a field the validator requires makes every stored definition
  //       unreadable; `region` stands in for any such tightening.
  const { region: _region, ...missingRegion } = structuredClone(base);
  expect(() => capability(missingRegion as typeof base)).toThrow("Invalid provider capability configuration.");

  // (iv) canonical() enumerates Object.keys and stringifies each value, so an explicit `undefined`
  //      is not the same as an absent key — {...base, health: undefined} hashes differently from base.
  //      An optional field must be spread conditionally, the way minimumReferenceFrames and
  //      frameControlMode already are, or "optional" silently becomes "always present".
  expect(contentHash({ ...structuredClone(base), health: undefined })).not.toBe(contentHash(structuredClone(base)));
  expect(contentHash(structuredClone(base))).toBe(contentHash({ ...structuredClone(base) }));

  record({ name: "snapshot-integrity", pairs: PROVIDER_REGISTRY.length, passed: PROVIDER_REGISTRY.length, skipped: 0 });
});

// ---------------------------------------------------------------------------
// 5. Declared behaviour vs actual behaviour
// ---------------------------------------------------------------------------
test("conformance: declared price, region and synthetic match what the matcher and the adapter do", () => {
  for (const entry of PROVIDER_REGISTRY) {
    const snapshot = snapshotOf(entry);
    const vector = eligibleVector(snapshot);
    const match = matchCapability(snapshot, vector, 1e6);
    if (snapshot.price.unit === "free") expect(match.estimateUsd).toBe(0);
    else expect(match.estimateUsd).toBeGreaterThan(0);
    expect(snapshot.region === "local").toBe(!entry.paid);
    const refuseSynthetic = matchCapability(snapshot, { ...vector, allowSynthetic: false }, 1e6);
    if (snapshot.synthetic) expect(refuseSynthetic.reasons).toContain("synthetic");
    else expect(refuseSynthetic.reasons).not.toContain("synthetic");
  }
  record({ name: "declared-price-region-synthetic", pairs: PROVIDER_REGISTRY.length, passed: PROVIDER_REGISTRY.length, skipped: 0 });
});

test("conformance: a local-bitexact claim is verified by rendering twice", async () => {
  const local = PROVIDER_REGISTRY.filter((entry) => snapshotOf(entry).determinism === "local-bitexact");
  if (!HAS_FFMPEG) {
    record({ name: "bit-exactness", pairs: local.length, passed: 0, skipped: local.length, skipReason: "ffmpeg is not on PATH" });
    return;
  }
  let verified = 0, skipped = 0;
  for (const entry of local) {
    const snapshot = snapshotOf(entry);
    if (snapshot.adapter === "anchor-storyboard") { skipped += 1; continue; } // covered below with its own anchor fixture
    const adapter = adapterOf(entry);
    const params = { seed: 7, widthxheight: "320x180", fps: 24, durationSec: 1 };
    const a = join(root, `${entry.stage}-${entry.spec.replace(/[^a-z0-9]/gi, "_")}-a.mp4`);
    const b = a.replace(/-a\.mp4$/, "-b.mp4");
    const first = await adapter.generate("A quiet garden at dusk.", 7, params, a);
    const second = await adapter.generate("A quiet garden at dusk.", 7, params, b);
    expect(readFileSync(first.path)).toEqual(readFileSync(second.path));
    expect(first.cost.total_cost_usd).toBe(0);
    verified += 1;
  }
  record({ name: "bit-exactness", pairs: local.length, passed: verified, skipped, skipReason: skipped ? "anchor-storyboard is verified in the anchor-fixture check" : undefined });
}, 180000);

test("conformance: the anchor storyboard presenter is bit-exact over its own anchor frames", async () => {
  if (!HAS_FFMPEG) { record({ name: "anchor-bit-exactness", pairs: 1, passed: 0, skipped: 1, skipReason: "ffmpeg is not on PATH" }); return; }
  const run = (args: string[]) => { const p = Bun.spawnSync(args); if (p.exitCode) throw new Error(p.stderr.toString()); return p.stdout; };
  const png = (color: string) => "data:image/png;base64," + run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", `color=${color}:s=320x180`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]).toString("base64");
  const provider = new AnchorStoryboardProvider();
  const frames = ["red", "blue"].map((color, index) => ({ at: index * 10000, image: png(color) }));
  const params = { seed: 1, widthxheight: "320x180", fps: 30, durationSec: 31 / 30, frameAnchors: { frames, mode: "storyboard" as const } };
  const first = await provider.generate("A colorful garden.", 1, params, join(root, "anchor-a.mp4"));
  const second = await provider.generate("A colorful garden.", 1, params, join(root, "anchor-b.mp4"));
  expect(readFileSync(first.path)).toEqual(readFileSync(second.path));
  expect(first.cost.total_cost_usd).toBe(0);
  record({ name: "anchor-bit-exactness", pairs: 1, passed: 1, skipped: 0 });
}, 120000);

test("conformance: a local-cancellation claim is verified with an already-aborted signal", async () => {
  const cancellable = PROVIDER_REGISTRY.filter((entry) => snapshotOf(entry).cancellation === "local" && snapshotOf(entry).adapter === "rich-animatic");
  if (!HAS_FFMPEG) { record({ name: "cancellation", pairs: cancellable.length, passed: 0, skipped: cancellable.length, skipReason: "ffmpeg is not on PATH" }); return; }
  let verified = 0;
  for (const entry of cancellable) {
    const adapter = adapterOf(entry);
    const out = join(root, `cancel-${entry.stage}-${entry.spec.replace(/[^a-z0-9]/gi, "_")}.mp4`);
    const signal = AbortSignal.abort();
    await expect(adapter.generate("A quiet garden.", 3, { seed: 3, widthxheight: "320x180", durationSec: 1, signal }, out)).rejects.toThrow();
    expect(await Bun.file(out).exists()).toBe(false);
    verified += 1;
  }
  // The plain video mock declares cancellation "none" and means it: it renders synchronously
  // through Bun.spawnSync, so there is nothing to interrupt. Not asserted to cancel.
  expect(new DeterministicMockProvider().capabilities.cancellation).toBe("none");
  record({ name: "cancellation", pairs: cancellable.length, passed: verified, skipped: 0 });
}, 180000);

// ---------------------------------------------------------------------------
// 6. Eligibility implies dispatchability; every ineligible dimension is named
// ---------------------------------------------------------------------------
const CAMERA_MOVES = ["static", "push-in", "pull-out", "pan-left", "pan-right"];

test("conformance: every registered adapter accepts a vector derived from its own snapshot", () => {
  for (const entry of PROVIDER_REGISTRY) {
    const snapshot = snapshotOf(entry);
    const match = matchCapability(snapshot, eligibleVector(snapshot), exactBudget(snapshot));
    if (snapshot.lifecycle === "retired") {
      expect(match.eligible).toBe(false);
      expect(match.reasons).toEqual(["provider-retired"]);
      continue;
    }
    expect({ spec: entry.spec, stage: entry.stage, reasons: match.reasons }).toEqual({ spec: entry.spec, stage: entry.stage, reasons: [] });
    expect(match.eligible).toBe(true);
  }
  record({ name: "eligible-vector", pairs: PROVIDER_REGISTRY.length, passed: PROVIDER_REGISTRY.length, skipped: 0 });
});

test("conformance: each ineligible dimension yields its own named rejection", () => {
  const seen = new Set<RejectionReason>();
  let cases = 0;
  for (const entry of PROVIDER_REGISTRY) {
    const snapshot = snapshotOf(entry);
    const base = eligibleVector(snapshot);
    const budget = exactBudget(snapshot);
    const output = snapshot.output;
    const multiple = output.dimensionMultiple;
    const expectReason = (vector: ShotRequirements, reason: RejectionReason, usd = budget) => {
      const match = matchCapability(snapshot, vector, usd);
      if (!match.reasons.includes(reason)) {
        throw new Error(`${entry.stage}:${entry.spec} expected rejection "${reason}", got [${match.reasons.join(", ")}]`);
      }
      expect(match.eligible).toBe(false);
      seen.add(reason);
      cases += 1;
    };

    expectReason({ ...base, width: output.maxWidth + multiple }, "dimensions");
    if (output.minWidth - multiple >= 16) expectReason({ ...base, width: output.minWidth - multiple }, "dimensions");
    if (multiple > 1) expectReason({ ...base, width: base.width + 1 }, "dimensions");
    if (output.fps) expectReason({ ...base, fps: Math.min(120, output.fps[1] + 1) }, "fps");
    if (output.durationSec && output.durationSec[1] < 600) expectReason({ ...base, durationSec: output.durationSec[1] + 1 }, "duration");
    if (!(base.frameAnchors && snapshot.frameControlMode === "storyboard")) {
      expectReason({ ...base, referenceFrames: snapshot.input.referenceFrames + 1 }, "references");
      if ((snapshot.input.minimumReferenceFrames ?? 0) > 0) expectReason({ ...base, referenceFrames: 0 }, "references");
    }
    expectReason({ ...base, identityLocks: snapshot.input.identityLocks + 1 }, "identity");
    const move = CAMERA_MOVES.find((value) => !snapshot.cameraMoves.includes(value));
    if (move) expectReason({ ...base, cameraMove: move }, "camera");
    expectReason({ ...base, audio: "native-dialogue" }, "audio");
    if (snapshot.determinism !== "local-bitexact") expectReason({ ...base, deterministic: true }, "determinism");
    if (output.nativeResolution === "unknown") expectReason({ ...base, nativeResolution: true }, "native-resolution");
    if (snapshot.region !== "local") expectReason({ ...base, region: "local" }, "region");
    if (snapshot.synthetic) expectReason({ ...base, allowSynthetic: false }, "synthetic");
    if (entry.paid) expectReason(base, "price", Math.max(0, budget - 0.01));
    expectReason({ ...base, modality: snapshot.modality === "video" ? "image" : "video", fps: null, durationSec: null }, "modality");
    if (snapshot.lifecycle === "retired") expectReason(base, "provider-retired", 1e6);
  }
  // Every rejection the matcher can reach from a requirements vector alone. The three it
  // cannot — circuit-open, capability-changed and frame-anchors — are router and anchor
  // state, covered by router.test.ts and frame-anchor-provider.test.ts respectively.
  expect([...seen].sort()).toEqual(["audio", "camera", "determinism", "dimensions", "duration", "fps", "identity", "modality", "native-resolution", "price", "provider-retired", "references", "region", "synthetic"]);
  record({ name: "boundary-rejections", pairs: cases, passed: cases, skipped: 0 });
});

// ---------------------------------------------------------------------------
// 7. No paid inference, no real HTTP, no key, no spend
// ---------------------------------------------------------------------------
test("conformance: the suite reached no network and dispatched to no paid provider", () => {
  expect(fetchCalls).toBe(0);
  for (const entry of PROVIDER_REGISTRY.filter((value) => value.paid)) {
    const adapter = adapterOf(entry);
    expect(adapter.capabilities?.price.unit).not.toBe("free");
    // Constructed, described, matched — never generated.
    expect(typeof adapter.generate).toBe("function");
  }
  record({ name: "no-paid-dispatch", pairs: PROVIDER_REGISTRY.filter((value) => value.paid).length, passed: PROVIDER_REGISTRY.filter((value) => value.paid).length, skipped: 0 });
});

// ---------------------------------------------------------------------------
// 8. Telemetry labels are a tripwire, not a silent collapse
// ---------------------------------------------------------------------------
test("conformance: providerKind is total over the registry and its collapse set is pinned", () => {
  const collapsed = new Set<string>();
  for (const entry of PROVIDER_REGISTRY) {
    const kind = providerKind(entry.adapter, entry.paid);
    expect(PROVIDER_KINDS as readonly string[]).toContain(kind);
    if (kind === "other") collapsed.add(entry.adapter);
  }
  // HV-019-02 closed both label gaps. No registered adapter reaches "other" any more, so a row
  // labelled "other" now means only "an adapter this build does not enumerate" — a tripwire rather
  // than a bucket. And the paid rich-animatic lane is distinguishable from the free one, which is
  // the question an operator watching spend is actually asking.
  expect([...collapsed].sort()).toEqual([]);
  const richAnimatic = PROVIDER_REGISTRY.filter((entry) => entry.adapter === "rich-animatic");
  expect(new Set(richAnimatic.map((entry) => entry.paid)).size).toBe(2);
  expect(new Set(richAnimatic.map((entry) => providerKind(entry.adapter, entry.paid))).size).toBe(2);
  // What is still not distinguishable, and is not proposed: two different paid image models share
  // one label. A per-model label is unbounded cardinality, which the metric allow-list refuses.
  const paidImage = richAnimatic.filter((entry) => entry.paid && entry.stage === "animatic");
  expect(paidImage.length).toBeGreaterThan(1);
  expect(new Set(paidImage.map((entry) => providerKind(entry.adapter, entry.paid))).size).toBe(1);
  record({ name: "telemetry-labels", pairs: PROVIDER_REGISTRY.length, passed: PROVIDER_REGISTRY.length, skipped: 0 });
});

// ---------------------------------------------------------------------------
// 9. Evidence
// ---------------------------------------------------------------------------
interface ConformanceDocument {
  schema: "hv-adapter-conformance/1";
  recordedAt: string;
  ffmpegPresent: boolean;
  registry: { specs: number; stages: string[]; entries: { stage: string; spec: string; adapter: string; model: string; modality: string; paid: boolean; lifecycle: string; capabilityRevision: string; priceVersion: string }[] };
  checks: CheckRecord[];
  telemetryLabels: { kinds: string[]; collapsedToOther: string[] };
  newProviderSpendUsd: 0;
  liveProviderDispatches: 0;
  provesVendorAvailability: false;
  provesVisualQuality: false;
  provesLivePricing: false;
  provesRegionalExecution: false;
}

function buildDocument(): ConformanceDocument {
  const entries = PROVIDER_REGISTRY.map((entry) => {
    const snapshot = snapshotOf(entry);
    return {
      stage: entry.stage, spec: entry.spec, adapter: snapshot.adapter, model: snapshot.model,
      modality: snapshot.modality, paid: entry.paid, lifecycle: snapshot.lifecycle,
      capabilityRevision: snapshot.revision, priceVersion: snapshot.priceVersion,
    };
  });
  return {
    schema: "hv-adapter-conformance/1",
    recordedAt: new Date().toISOString(),
    ffmpegPresent: HAS_FFMPEG,
    registry: { specs: PROVIDER_REGISTRY.length, stages: [...STAGES], entries },
    checks: [...checks].sort((a, b) => a.name.localeCompare(b.name)),
    telemetryLabels: {
      kinds: [...new Set(PROVIDER_REGISTRY.map((entry) => providerKind(entry.adapter, entry.paid)))].sort(),
      collapsedToOther: [...new Set(PROVIDER_REGISTRY.filter((entry) => providerKind(entry.adapter, entry.paid) === "other").map((entry) => entry.adapter))].sort(),
    },
    newProviderSpendUsd: 0,
    liveProviderDispatches: 0,
    provesVendorAvailability: false,
    provesVisualQuality: false,
    provesLivePricing: false,
    provesRegionalExecution: false,
  };
}

function validateDocument(value: unknown): ConformanceDocument {
  const document = value as ConformanceDocument;
  if (!document || typeof document !== "object" || document.schema !== "hv-adapter-conformance/1") throw new Error("Invalid adapter conformance document.");
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(document.recordedAt) || typeof document.ffmpegPresent !== "boolean") throw new Error("Invalid adapter conformance document.");
  if (!document.registry || !Array.isArray(document.registry.entries) || document.registry.specs !== document.registry.entries.length) throw new Error("Invalid adapter conformance document.");
  for (const entry of document.registry.entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.capabilityRevision) || !/^[a-f0-9]{64}$/.test(entry.priceVersion)) throw new Error("Invalid adapter conformance document.");
  }
  if (!Array.isArray(document.checks) || !document.checks.length) throw new Error("Invalid adapter conformance document.");
  if (document.newProviderSpendUsd !== 0 || document.liveProviderDispatches !== 0) throw new Error("Invalid adapter conformance document.");
  for (const field of ["provesVendorAvailability", "provesVisualQuality", "provesLivePricing", "provesRegionalExecution"] as const) {
    if (document[field] !== false) throw new Error("Invalid adapter conformance document.");
  }
  return document;
}

test("conformance: the evidence record is written when asked, and the committed one is honest", async () => {
  const output = process.env.HV_ADAPTER_CONFORMANCE_EVIDENCE?.trim();
  if (output) {
    const document = validateDocument(buildDocument());
    const staging = join(dirname(output), ".hv-adapter-conformance.tmp");
    await Bun.write(staging, JSON.stringify(document, null, 2) + "\n");
    renameSync(staging, output);
  }

  const committed = Bun.file(EVIDENCE_PATH);
  expect(await committed.exists()).toBe(true);
  const text = await committed.text();
  const document = validateDocument(JSON.parse(text));
  expect(document.registry.specs).toBe(PROVIDER_REGISTRY.length);
  expect(document.registry.entries.map((entry) => `${entry.stage}:${entry.spec}`).sort())
    .toEqual(PROVIDER_REGISTRY.map((entry) => `${entry.stage}:${entry.spec}`).sort());
  // The recorded revisions are the revisions this build produces: a capability edit
  // that would invalidate already-admitted plans breaks here before it reaches staging.
  for (const entry of document.registry.entries) {
    const snapshot = describeProvider(entry.spec, entry.stage as Stage, ENV).snapshot;
    expect(`${entry.stage}:${entry.spec}:${entry.capabilityRevision}`).toBe(`${entry.stage}:${entry.spec}:${snapshot.revision}`);
  }
  // The label block was previously written but never checked back, so a label-set change could leave
  // the committed file silently stale with a fully green suite — every other assertion passes because
  // the registry, the revisions and the family names are unchanged.
  expect(document.telemetryLabels).toEqual(buildDocument().telemetryLabels);
  expect(document.checks.map((check) => check.name).sort()).toEqual(
    ["anchor-bit-exactness", "bit-exactness", "boundary-rejections", "cancellation", "declared-price-region-synthetic", "eligible-vector",
      "image-spec-dedup", "no-paid-dispatch", "normalization-fixed-point", "paid-family", "registry-derivation", "snapshot-integrity",
      "stale-spelling-fails-closed", "switch-totality", "telemetry-labels", "unregistered-refused"],
  );
  // Nothing in the record may carry a destination, a credential or a host path. The model
  // strings are vendor endpoint paths, which the capability snapshots already publish;
  // they are routing identity, not a secret and not a reachable URL.
  for (const pattern of [/:\/\//, /FAL_KEY/, /\/home\//, /\/Users\//, /\/tmp\//, new RegExp(FIXTURE_KEY, "i"), /fal\.run/, /queue\.fal/, /cartesia/i]) {
    expect(text).not.toMatch(pattern);
  }
  // Every opaque 64-hex string in the file is a capability revision or a price version of
  // this build — nothing else long and unreadable is carried, by construction rather than
  // by inspection.
  const known = new Set(PROVIDER_REGISTRY.flatMap((entry) => { const snapshot = snapshotOf(entry); return [snapshot.revision, snapshot.priceVersion]; }));
  for (const hex of text.match(/[a-f0-9]{32,}/g) ?? []) expect({ hex, known: known.has(hex) }).toEqual({ hex, known: true });
  record({ name: "evidence", pairs: 1, passed: 1, skipped: 0 });
});

test("conformance: every check family reported an outcome", () => {
  const names = checks.map((check) => check.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names.length).toBe(17); // sixteen check families plus the evidence record itself
});
