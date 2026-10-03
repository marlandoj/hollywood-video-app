import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { frameFingerprint, sunkCostsOf, type CostRecord, type GenParams, type ProviderAdapter } from "../../generator/src/index";
import { matchCapability, videoRequirements, type CapabilityMatch } from "../../generator/src/capabilities";
import { privatePngReferences } from "../../generator/src/image";
import type { CostEvent } from "../../operator/src/index";
import { parseFountain } from "../../parser/src/index";
import { planShots, type Shot } from "../../planner/src/index";
import { IDENTITY_METRIC, isFlatFingerprint, scoreShotIdentity, shotCharacters, stillFingerprint } from "./identity";

/**
 * HV-037-02. The measured pass over the frozen 24-shot corpus: one provider, every shot rendered
 * once, and per shot a score computed from the rendered file. Its record is what Release 3 step 10
 * ("Routing on measured quality") reads, and `readMeasuredRecord` refuses a record whose scores do
 * not follow from the fingerprints it carries -- so a score that was typed in rather than measured
 * cannot reach the router.
 *
 * Nothing here decides whether money may be spent. A priced provider runs only under a ledger, and
 * `packages/benchmarks/src/paid.ts` is the one place that admits it.
 */
export const MEASURED_SCHEMA = "hv-benchmark-measured/1";
export const MEASURED_FIXTURE_VERSION = "1.0.0";
/** 720p: native for every dispatchable fal video model, so no shot is scored on an upscale. */
export const MEASURED_FRAME_SIZE = "1280x720";
export const MEASURED_FPS = 30;
/** Every shot of a measured pass is one cost event under this project id, so a pass's spend is readable on its own. */
export const BENCHMARK_PROJECT_PREFIX = "benchmark:";

export interface BenchmarkLedger {
  reserve(jobId: string, stage: "final", amountUsd: number, monthlyCapUsd: number): void | Promise<void>;
  assertCanSpend(jobId: string, estimateUsd: number): void | Promise<void>;
  record(event: CostEvent): void | Promise<void>;
  release(jobId: string): void | Promise<void>;
  all(): CostEvent[] | Promise<CostEvent[]>;
}

export interface ReferenceImage { character: string; path: string; sha256: string; fingerprint: string; flat: boolean; dataUri: string }

export interface PlannedMeasuredShot {
  shot: Shot;
  characters: string[];
  params: GenParams;
  match: CapabilityMatch;
}

export interface MeasuredShot {
  shotId: string;
  sceneIndex: number;
  characters: string[];
  status: "rendered" | "skipped" | "failed";
  reason?: string;
  referencesSent: number;
  estimateUsd: number | null;
  costUsd: number;
  latencyMs?: number;
  clipSha256?: string;
  frameAtSec?: number;
  frameFingerprint?: string;
  flatFrame?: boolean;
  identity: { character: string; score: number }[];
  identityScore: number | null;
}

export interface MeasuredAggregate {
  shots: number;
  rendered: number;
  skipped: number;
  failed: number;
  flatFrames: number;
  /** Rendered shots with at least one referenced character and a frame that carries structure. */
  scoredShots: number;
  identityMean: number | null;
  identityMin: number | null;
  identityMax: number | null;
  totalCostUsd: number;
}

export interface MeasuredRecord {
  schema: typeof MEASURED_SCHEMA;
  metric: typeof IDENTITY_METRIC;
  fixtureVersion: string;
  fixtureSha256: string;
  providerSpec: string;
  provider: string;
  model: string;
  capabilityRevision: string;
  /** From the provider's capability snapshot: true for a local stand-in. Never routing evidence. */
  synthetic: boolean;
  increment: string | null;
  declaredUsd: number;
  frameSize: string;
  references: { character: string; sha256: string; fingerprint: string; flat: boolean }[];
  shots: MeasuredShot[];
  aggregate: MeasuredAggregate;
  recordedAt: string;
}

/** The frozen corpus, planned exactly as `runBenchmark` plans it. */
export function corpusShots(): { shots: Shot[]; fixtureSha256: string } {
  const text = readFileSync(fileURLToPath(new URL("../fixtures/benchmark-24shot.fountain", import.meta.url)), "utf8");
  const shots = planShots(parseFountain(text), 1000);
  if (shots.length !== 24) throw new Error(`benchmark fixture must plan exactly 24 shots, got ${shots.length}`);
  return { shots, fixtureSha256: createHash("sha256").update(text).digest("hex") };
}

/** Read one locked reference per character: `<CHARACTER>` -> a PNG path. */
export function loadReferences(paths: Readonly<Record<string, string>>): ReferenceImage[] {
  return Object.entries(paths).map(([name, path]) => {
    const bytes = readFileSync(path);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`The reference for ${name} is not a PNG.`);
    const fingerprint = stillFingerprint(path);
    return { character: name.toUpperCase(), path, sha256: createHash("sha256").update(bytes).digest("hex"), fingerprint, flat: isFlatFingerprint(fingerprint),
      dataUri: "data:image/png;base64," + bytes.toString("base64") };
  }).sort((a, b) => a.character.localeCompare(b.character));
}

/**
 * What each shot would ask of the provider, and what the provider's own capability says it would
 * cost. A provider that takes reference images is given the shot's characters' references; one
 * that requires a reference cannot render a shot with no locked character, and that shot is
 * skipped rather than given someone else's face.
 */
export function planMeasuredPass(provider: ProviderAdapter, references: readonly ReferenceImage[], shotCapUsd: number, shots = corpusShots().shots): PlannedMeasuredShot[] {
  const capabilities = provider.capabilities;
  if (!capabilities) throw new Error(`Provider ${provider.name} publishes no capability, so its price cannot be checked.`);
  if (capabilities.modality !== "video") throw new Error("The measured benchmark renders video shots.");
  const byName = new Map(references.map(reference => [reference.character, reference]));
  return shots.map(shot => {
    const characters = shotCharacters(shot, byName.keys());
    const sent = capabilities.input.referenceFrames > 0 ? characters.slice(0, capabilities.input.referenceFrames).map(name => byName.get(name)!.dataUri) : [];
    if (sent.length) privatePngReferences(sent, 1, capabilities.input.referenceFrames);
    const params: GenParams = { seed: shot.seed, durationSec: shot.durationSec, widthxheight: MEASURED_FRAME_SIZE, fps: MEASURED_FPS, ...(sent.length ? { referenceFrames: sent } : {}) };
    return { shot, characters, params, match: matchCapability(capabilities, videoRequirements(params), shotCapUsd) };
  });
}

/** The most the pass can cost: every eligible shot at its estimate, once. */
export function plannedCostUsd(plan: readonly PlannedMeasuredShot[]): number {
  return Number(plan.reduce((sum, entry) => sum + (entry.match.eligible ? entry.match.estimateUsd ?? 0 : 0), 0).toFixed(6));
}

export function aggregateOf(shots: readonly MeasuredShot[]): MeasuredAggregate {
  const scores = shots.map(shot => shot.identityScore).filter((score): score is number => score !== null);
  return {
    shots: shots.length,
    rendered: shots.filter(shot => shot.status === "rendered").length,
    skipped: shots.filter(shot => shot.status === "skipped").length,
    failed: shots.filter(shot => shot.status === "failed").length,
    flatFrames: shots.filter(shot => shot.flatFrame === true).length,
    scoredShots: scores.length,
    identityMean: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    identityMin: scores.length ? Math.min(...scores) : null,
    identityMax: scores.length ? Math.max(...scores) : null,
    totalCostUsd: Number(shots.reduce((sum, shot) => sum + shot.costUsd, 0).toFixed(6)),
  };
}

export interface MeasuredRunOptions {
  provider: ProviderAdapter;
  providerSpec: string;
  references: readonly ReferenceImage[];
  outDir: string;
  shotCapUsd: number;
  increment?: string | null;
  declaredUsd?: number;
  /** Required for any provider whose capability is priced. `jobId` must already be reserved on it. */
  ledger?: { ledger: BenchmarkLedger; jobId: string };
  now?: () => Date;
}

/**
 * Render every eligible shot once and measure it. A priced provider without a ledger is refused
 * before any shot. Each shot asks the ledger first; when the reservation can no longer cover a
 * shot's estimate the pass stops, and the shots it did not reach are recorded as skipped.
 */
export async function runMeasuredBenchmark(options: MeasuredRunOptions): Promise<MeasuredRecord> {
  const { provider, references } = options;
  const now = options.now ?? (() => new Date());
  const capabilities = provider.capabilities;
  if (!capabilities) throw new Error(`Provider ${provider.name} publishes no capability, so its price cannot be checked.`);
  if (capabilities.price.unit !== "free" && !options.ledger) throw new Error(`Provider ${provider.name} is priced; it runs only under a ledger reservation.`);
  const { shots, fixtureSha256 } = corpusShots();
  const plan = planMeasuredPass(provider, references, options.shotCapUsd, shots);
  const fingerprints = Object.fromEntries(references.map(reference => [reference.character, reference.fingerprint]));
  mkdirSync(options.outDir, { recursive: true });
  const projectId = BENCHMARK_PROJECT_PREFIX + (options.increment ?? "unrecorded");
  const results: MeasuredShot[] = [];
  let stopped: string | null = null;
  const charge = async (shotId: string, cost: CostRecord, index: number) => {
    if (!options.ledger) return;
    await options.ledger.ledger.record({ ...cost, eventId: `${options.ledger.jobId}:${shotId}:${index}`, at: now().toISOString(), projectId, shotId, jobId: options.ledger.jobId, stage: "final" });
  };
  for (const entry of plan) {
    const base = { shotId: entry.shot.id, sceneIndex: entry.shot.sceneIndex, characters: entry.characters, referencesSent: entry.params.referenceFrames?.length ?? 0,
      estimateUsd: entry.match.estimateUsd, identity: [], identityScore: null, costUsd: 0 };
    if (stopped) { results.push({ ...base, status: "skipped", reason: stopped }); continue; }
    if (!entry.match.eligible) { results.push({ ...base, status: "skipped", reason: "ineligible: " + entry.match.reasons.join(", ") }); continue; }
    if (options.ledger) {
      try { await options.ledger.ledger.assertCanSpend(options.ledger.jobId, entry.match.estimateUsd ?? 0); }
      catch (error) {
        stopped = "declared spend exhausted: " + (error instanceof Error ? error.message : String(error));
        results.push({ ...base, status: "skipped", reason: stopped });
        continue;
      }
    }
    const started = performance.now();
    let clip;
    try {
      clip = await provider.generate(entry.shot.prompt, entry.shot.seed, entry.params, join(options.outDir, `${entry.shot.id}.mp4`));
    } catch (error) {
      const sunk = sunkCostsOf(error);
      for (const [index, cost] of sunk.entries()) await charge(entry.shot.id, cost, index);
      results.push({ ...base, status: "failed", reason: error instanceof Error ? error.message : String(error),
        costUsd: Number(sunk.reduce((sum, cost) => sum + cost.total_cost_usd, 0).toFixed(6)) });
      continue;
    }
    const latencyMs = performance.now() - started;
    await charge(entry.shot.id, clip.cost, 0);
    const atSec = Number((clip.durationSec / 2).toFixed(3));
    const frame = frameFingerprint(clip.path, atSec);
    const scored = scoreShotIdentity(frame, entry.characters, fingerprints);
    results.push({ ...base, status: "rendered", costUsd: clip.cost.total_cost_usd, latencyMs, clipSha256: createHash("sha256").update(readFileSync(clip.path)).digest("hex"),
      frameAtSec: atSec, frameFingerprint: frame, flatFrame: scored.flatFrame, identity: scored.identity, identityScore: scored.identityScore });
  }
  return {
    schema: MEASURED_SCHEMA, metric: IDENTITY_METRIC, fixtureVersion: MEASURED_FIXTURE_VERSION, fixtureSha256,
    providerSpec: options.providerSpec, provider: provider.name, model: provider.model, capabilityRevision: capabilities.revision, synthetic: capabilities.synthetic,
    increment: options.increment ?? null, declaredUsd: options.declaredUsd ?? 0, frameSize: MEASURED_FRAME_SIZE,
    references: references.map(({ character, sha256, fingerprint, flat }) => ({ character, sha256, fingerprint, flat })),
    shots: results, aggregate: aggregateOf(results), recordedAt: now().toISOString(),
  };
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9;

/**
 * Read a measured record for routing. Every score must follow from the fingerprints the record
 * carries: each rendered shot's per-character score is recomputed from its frame hash and the
 * reference hash, its mean is recomputed, and the aggregate is recomputed from the shots. A record
 * from a synthetic (local stand-in) provider is refused unless the caller says otherwise, because
 * a stand-in's picture says nothing about a vendor's.
 */
export function readMeasuredRecord(value: unknown, options: { allowSynthetic?: boolean } = {}): MeasuredRecord {
  const record = value as MeasuredRecord;
  const fail = (why: string): never => { throw new Error("Not a measured benchmark record: " + why); };
  if (!record || typeof record !== "object" || record.schema !== MEASURED_SCHEMA) fail(`schema is not ${MEASURED_SCHEMA}`);
  if (record.metric?.id !== IDENTITY_METRIC.id) fail(`metric is not ${IDENTITY_METRIC.id}`);
  if (typeof record.provider !== "string" || !record.provider || typeof record.model !== "string" || !record.model) fail("provider and model are required");
  if (record.synthetic !== false && !options.allowSynthetic) fail(`provider ${record.provider} is a synthetic stand-in, and its scores are not routing evidence`);
  if (!Array.isArray(record.references) || !Array.isArray(record.shots)) fail("references and shots are required");
  const references: Record<string, string> = {};
  for (const reference of record.references) {
    if (!/^[0-9a-f]{64}$/.test(reference?.fingerprint ?? "") || !/^[0-9a-f]{64}$/.test(reference?.sha256 ?? "")) fail("a reference lacks its hashes");
    references[reference.character] = reference.fingerprint;
  }
  for (const shot of record.shots) {
    if (shot.status !== "rendered") {
      if (shot.identityScore !== null || shot.identity?.length) fail(`${shot.shotId} was not rendered but carries a score`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(shot.frameFingerprint ?? "") || !/^[0-9a-f]{64}$/.test(shot.clipSha256 ?? "")) fail(`${shot.shotId} lacks its frame and clip hashes`);
    const expected = scoreShotIdentity(shot.frameFingerprint!, shot.characters, references);
    if (expected.flatFrame !== shot.flatFrame || expected.identity.length !== shot.identity.length
      || expected.identity.some((value, index) => value.character !== shot.identity[index]!.character || !close(value.score, shot.identity[index]!.score))
      || (expected.identityScore === null ? shot.identityScore !== null : shot.identityScore === null || !close(expected.identityScore, shot.identityScore)))
      fail(`${shot.shotId}'s score does not follow from its fingerprints`);
  }
  const aggregate = aggregateOf(record.shots);
  for (const key of Object.keys(aggregate) as (keyof MeasuredAggregate)[]) {
    const stated = record.aggregate?.[key], computed = aggregate[key];
    if (computed === null ? stated !== null : typeof stated !== "number" || !close(stated, computed)) fail(`aggregate ${key} does not follow from the shots`);
  }
  return record;
}

