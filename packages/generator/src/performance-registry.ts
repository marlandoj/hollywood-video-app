// The one enumerable statement of what a performance adapter is — the Voice and
// Lip-sync lanes, which FULL-SCOPE §7 lists in the same candidate matrix as the
// video adapters and holds to the same rule: "each must pass the adapter
// conformance suite and the studio benchmark before promotion."
//
// This is NOT the video registry and must not be mistaken for a step toward
// merging the two. The two lanes have opposite hashing properties, and that is
// the whole reason this file exists rather than an extension of registry.ts:
//
//   - A video snapshot's revision is contentHash(definition) where the
//     definition has NO `schema` key: capability() adds the schema literal
//     after hashing. Renaming the video schema would move no revision.
//   - Every performance capability builds its definition WITH the schema string
//     inside it and then hashes that. Renaming a performance schema moves the
//     revision of every capability that carries it — before any field changes.
//
// So "re-express the performance capabilities as hv-capability/2" is not an
// additive change under any shim; see "Audio and lip-sync revisions are
// immovable" in docs/PROVIDER-ROUTING.md. The registry keeps the two lanes
// separate and enumerable so that the constraint is checkable rather than
// rediscovered on a restore.
//
// Everything here is derived from the capability constants, so a new constant
// appears automatically and the conformance suite immediately demands a pin for
// it. Nothing in this file builds, copies or mutates a capability definition.
import { AUDIO_CAPABILITIES } from "./audio-capabilities";
import { LIPSYNC_CAPABILITY } from "./lipsync-capability";

export type PerformanceLane = "voice" | "lip-sync";
export const PERFORMANCE_LANES: readonly PerformanceLane[] = Object.freeze(["voice", "lip-sync"] as const);

export interface PerformanceEntry {
  /** Which product lane this capability serves. */
  readonly lane: PerformanceLane;
  /** The vendor the capability names. Performance capabilities carry `provider`; video snapshots carry `adapter`. */
  readonly provider: string;
  /**
   * The capability's schema string. Deliberately NOT a key: `hv-audio-capability/3`
   * is carried by two different capabilities (Azure, and the Cartesia multilingual
   * contract), so a registry keyed on schema silently loses one of them.
   */
  readonly schema: string;
  readonly model: string;
  readonly apiVersion: string;
  /** The content hash every stored record pins. This is the key, and it is immovable. */
  readonly capabilityRevision: string;
  /** True when dispatching to this capability bills. Every performance capability does. */
  readonly paid: boolean;
  /** The capability's own statement of how far it has been qualified. */
  readonly qualification: string;
  readonly doc: string;
}

function entry(value: PerformanceEntry): PerformanceEntry {
  return Object.freeze({ ...value });
}

const LANE_DOC: Record<string, string> = {
  "hv-audio-capability/1": "Cartesia line-level voice: line controls only, English, no phrase direction.",
  "hv-audio-capability/2": "Cartesia phrase direction: source-bound reviewed ranges with a compiler-generated transcript.",
  "hv-audio-capability/3": "Multilingual and native-style contracts; carried by two providers, so the revision is the key.",
  "hv-lipsync-capability/1": "sync.so closed-transport lip-sync: manual speaker selection, owner rubric, no automatic score.",
};

/**
 * Every performance capability this build can produce, keyed by revision.
 *
 * A record stored by an earlier build pins a revision that is NOT in this array.
 * That is not a bug in the record — it means this build cannot reproduce the
 * capability that record was written against, and every validator that
 * re-derives the revision will refuse it. See the immovability section in
 * docs/PROVIDER-ROUTING.md for what that costs.
 */
export const PERFORMANCE_REGISTRY: readonly PerformanceEntry[] = Object.freeze([
  ...AUDIO_CAPABILITIES.map((capability) =>
    entry({
      lane: "voice",
      provider: capability.provider,
      schema: capability.schema,
      model: capability.model,
      apiVersion: capability.apiVersion,
      capabilityRevision: capability.revision,
      paid: true,
      qualification: capability.qualification,
      doc: LANE_DOC[capability.schema] ?? "A configured voice capability.",
    }),
  ),
  entry({
    lane: "lip-sync",
    provider: LIPSYNC_CAPABILITY.provider,
    schema: LIPSYNC_CAPABILITY.schema,
    model: LIPSYNC_CAPABILITY.model,
    apiVersion: LIPSYNC_CAPABILITY.apiVersion,
    capabilityRevision: LIPSYNC_CAPABILITY.revision,
    paid: true,
    qualification: LIPSYNC_CAPABILITY.qualification,
    doc: LANE_DOC[LIPSYNC_CAPABILITY.schema] ?? "A configured lip-sync capability.",
  }),
]);

/** The registry entry for a pinned revision, or undefined when this build cannot reproduce it. */
export function performanceEntry(revision: string): PerformanceEntry | undefined {
  if (typeof revision !== "string") return undefined;
  return PERFORMANCE_REGISTRY.find((value) => value.capabilityRevision === revision);
}

/**
 * The capability object behind a pinned revision, across BOTH lanes.
 *
 * `audioCapability()` in audio-capabilities.ts covers only the four voice
 * entries — `LIPSYNC_CAPABILITY` is in neither its array nor its lookup — so a
 * lip-sync revision has no resolver there. This is that resolver.
 */
export function performanceCapability(revision: string): unknown {
  if (typeof revision !== "string") return undefined;
  const audio = AUDIO_CAPABILITIES.find((value) => value.revision === revision);
  if (audio) return audio;
  return LIPSYNC_CAPABILITY.revision === revision ? LIPSYNC_CAPABILITY : undefined;
}

/** The revisions of one lane, optionally narrowed to one provider, in registry order. */
export function performanceRevisions(lane: PerformanceLane, provider?: string): string[] {
  return PERFORMANCE_REGISTRY.filter(
    (value) => value.lane === lane && (provider === undefined || value.provider === provider),
  ).map((value) => value.capabilityRevision);
}
