import type { CapabilitySnapshot } from "./capabilities";

/**
 * HV-019-14. The `quality` routing strategy's evidence, as it is pinned in an admitted provider plan.
 *
 * The scores come from one committed benchmark results file of `hv-benchmark-measured/1` records,
 * which `packages/benchmarks/src/routing-results.ts` reads at admission and refuses unless every
 * score follows from the fingerprints the file carries (HV-037-02's `readMeasuredRecord`). This
 * module holds no file access and no benchmark code: it is the shape the plan carries and the pure
 * derivation that the router, the job journal and the execution-capture validators all share, so
 * each of them reaches the same order from the same plan.
 *
 * Nothing here invents a score. A provider with no measured record, or a record measured under a
 * different capability revision, or a pass that scored no shot, ranks after every measured one with
 * score `null` and the reason. When the file is absent or refused, `fallback` says why, nothing is
 * measured, and the order is the configured one.
 */
export const ROUTING_QUALITY_SCHEMA = "hv-routing-quality/1";
/** A plan holds at most this many measured providers; a pool holds at most nine. */
export const ROUTING_QUALITY_MAX_MEASURED = 16;

export interface QualityMeasurement {
  spec: string; provider: string; model: string; capabilityRevision: string;
  /** The record's `aggregate.identityMean`, or null when the pass scored no shot. */
  score: number | null; scoredShots: number;
}
export interface RoutingQuality {
  schema: typeof ROUTING_QUALITY_SCHEMA;
  /** sha256 of the results file's bytes; null when no valid file was used. */
  resultsSha256: string | null;
  metric: string | null;
  fixtureSha256: string | null;
  /** Why the configured order was used instead; null when the file was read and accepted. */
  fallback: string | null;
  measured: QualityMeasurement[];
}
export interface CandidateQuality {id: string; score: number | null; reason: string}
/** What a `quality` route decision records beside its candidates. */
export interface RouteQuality {
  resultsSha256: string | null; metric: string | null; fallback: string | null;
  candidates: CandidateQuality[]; selectedScore: number | null;
}

const HEX = /^[0-9a-f]{64}$/, SPEC = /^[A-Za-z0-9_.:/-]{1,200}$/;
const keys = (value: object) => Object.keys(value).sort().join(",");

/** The block a plan carries when no score may be used. */
export function qualityFallback(reason: string): RoutingQuality {
  const text = reason.replace(/\s+/g, " ").trim().slice(0, 300) || "the results file was not used";
  return {schema: ROUTING_QUALITY_SCHEMA, resultsSha256: null, metric: null, fixtureSha256: null, fallback: text, measured: []};
}

export function validateRoutingQuality(input: unknown): RoutingQuality {
  const value = input as RoutingQuality;
  if (!value || typeof value !== "object" || Array.isArray(value) || keys(value) !== "fallback,fixtureSha256,measured,metric,resultsSha256,schema"
    || value.schema !== ROUTING_QUALITY_SCHEMA || !Array.isArray(value.measured) || value.measured.length > ROUTING_QUALITY_MAX_MEASURED) throw new Error("Invalid routing quality evidence.");
  if (value.fallback !== null) {
    if (typeof value.fallback !== "string" || !value.fallback || value.fallback.length > 300
      || value.resultsSha256 !== null || value.metric !== null || value.fixtureSha256 !== null || value.measured.length) throw new Error("Invalid routing quality evidence.");
  } else if (!HEX.test(value.resultsSha256 ?? "") || !HEX.test(value.fixtureSha256 ?? "") || typeof value.metric !== "string" || !/^[A-Za-z0-9_.:/-]{1,100}$/.test(value.metric)) {
    throw new Error("Invalid routing quality evidence.");
  }
  for (const entry of value.measured) {
    if (!entry || typeof entry !== "object" || keys(entry) !== "capabilityRevision,model,provider,score,scoredShots,spec"
      || typeof entry.spec !== "string" || !SPEC.test(entry.spec) || typeof entry.provider !== "string" || !/^[a-z0-9-]{1,64}$/.test(entry.provider)
      || typeof entry.model !== "string" || !/^[A-Za-z0-9._:/-]{1,200}$/.test(entry.model) || !HEX.test(entry.capabilityRevision)
      || !Number.isSafeInteger(entry.scoredShots) || entry.scoredShots < 0 || entry.scoredShots > 10_000
      || (entry.score === null ? entry.scoredShots !== 0 : typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1 || entry.scoredShots < 1)) throw new Error("Invalid routing quality evidence.");
  }
  if (new Set(value.measured.map(entry => entry.spec)).size !== value.measured.length) throw new Error("Invalid routing quality evidence.");
  return structuredClone(value);
}

/** The score a pool entry ranks by, and why. Never a default: anything not measured is `null`. */
export function qualityOf(quality: RoutingQuality, id: string, snapshot: Pick<CapabilitySnapshot, "adapter" | "model" | "revision" | "synthetic">): CandidateQuality {
  if (quality.fallback !== null) return {id, score: null, reason: "not measured: the benchmark results were not used (" + quality.fallback + ")"};
  const entry = quality.measured.find(value => value.spec === id);
  if (!entry) return {id, score: null, reason: "not measured: the results file has no record for " + id};
  if (entry.provider !== snapshot.adapter || entry.model !== snapshot.model || entry.capabilityRevision !== snapshot.revision)
    return {id, score: null, reason: "not measured: the record was measured under capability revision " + entry.capabilityRevision.slice(0, 12) + ", not this provider's " + snapshot.revision.slice(0, 12)};
  if (snapshot.synthetic) return {id, score: null, reason: "not measured: a synthetic stand-in's picture is not routing evidence"};
  if (entry.score === null) return {id, score: null, reason: "not measured: the measured pass scored no shot"};
  return {id, score: entry.score, reason: "measured: " + quality.metric + " mean over " + entry.scoredShots + " scored shots"};
}

/** Measured before unmeasured; higher score first; otherwise the configured order. */
export function compareQuality(a: {score: number | null; index: number}, b: {score: number | null; index: number}): number {
  if (a.score !== null && b.score !== null) return b.score - a.score || a.index - b.index;
  if (a.score !== null) return -1;
  if (b.score !== null) return 1;
  return a.index - b.index;
}

/** The record a `quality` route decision carries, for its candidates in their ranked order. */
export function routeQuality(quality: RoutingQuality, candidates: readonly {id: string; snapshot: Pick<CapabilitySnapshot, "adapter" | "model" | "revision" | "synthetic">}[], selectedId: string | null): RouteQuality {
  const scored = candidates.map(candidate => qualityOf(quality, candidate.id, candidate.snapshot));
  return {resultsSha256: quality.resultsSha256, metric: quality.metric, fallback: quality.fallback, candidates: scored,
    selectedScore: selectedId === null ? null : scored.find(value => value.id === selectedId)?.score ?? null};
}
