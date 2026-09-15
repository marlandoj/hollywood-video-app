// The one enumerable statement of what a provider is.
//
// Before this file the same spec grammar was re-implemented in four independent
// string switches — describeProvider (catalog.ts), resolveProvider and
// providerUsesPaidInference (index.ts), and resolveAnimaticProvider /
// resolveImageProvider (index.ts, fal-image.ts). Nothing enumerated the set, so
// nothing could prove the four agreed, and they did not: a final-stage "image:"
// spec kept its un-normalized spelling, so "image:fal" and
// "image:fal:flux-schnell" survived pool de-duplication as two entries carrying
// byte-identical capability snapshots — and RoutedGenerator keys its circuit
// breaker on snapshot.revision, so those two nominal providers shared one
// circuit.
//
// The registry is the source of truth for routing identity only: which
// (stage, spec) pairs exist, what each one's canonical spelling is, which
// adapter answers for it, and whether it bills. Capability content stays in the
// adapters — this file never builds or copies a snapshot. The fal families are
// derived from FAL_MODELS and FAL_IMAGE_MODELS rather than transcribed, so a new
// model key appears here automatically and the conformance suite immediately
// demands a matching adapter for it.
import { DEFAULT_FAL_MODEL, FAL_MODELS } from "./fal";
import { DEFAULT_FAL_IMAGE_MODEL, FAL_IMAGE_MODELS } from "./fal-image";

export type Stage = "animatic" | "final" | "character-sheet";
export const STAGES: readonly Stage[] = Object.freeze(["final", "animatic", "character-sheet"] as const);

export interface RegistryEntry {
  /** The render stage this spelling is admissible on. */
  readonly stage: Stage;
  /** The canonical spec: what describeProvider returns and what a plan pins. */
  readonly spec: string;
  /** The adapter name the resolved provider must report, and the one its capability snapshot carries. */
  readonly adapter: string;
  readonly modality: "image" | "video";
  /** True when dispatching to this provider costs money. Cross-checked against snapshot.price.unit !== "free". */
  readonly paid: boolean;
  /** Non-canonical spellings accepted on this stage. Every alias normalizes to spec. */
  readonly aliases: readonly string[];
  readonly doc: string;
}

function entry(value: RegistryEntry): RegistryEntry {
  return Object.freeze({ ...value, aliases: Object.freeze([...value.aliases]) });
}

const falVideoSpecs = Object.keys(FAL_MODELS).map((model) =>
  entry({
    stage: "final",
    spec: `fal:${model}`,
    adapter: "fal",
    modality: "video",
    paid: true,
    aliases: model === DEFAULT_FAL_MODEL ? ["fal"] : [],
    doc: `fal.ai hosted video model "${model}".`,
  }),
);

const falImageSpecs = (stage: Stage) =>
  Object.keys(FAL_IMAGE_MODELS).map((model) =>
    entry({
      stage,
      spec: `image:fal:${model}`,
      adapter: "rich-animatic",
      modality: "video",
      paid: true,
      aliases: model === DEFAULT_FAL_IMAGE_MODEL ? ["image:fal"] : [],
      doc: `Rich animatic over the fal.ai hosted image model "${model}".`,
    }),
  );

/**
 * Every (stage, spec) pair the product admits. A pair absent from this table is
 * not a provider: describeProvider refuses it and no plan can pin it.
 */
export const PROVIDER_REGISTRY: readonly RegistryEntry[] = Object.freeze([
  // --- final ---------------------------------------------------------------
  entry({
    stage: "final", spec: "mock", adapter: "mock", modality: "video", paid: false, aliases: [""],
    doc: "Deterministic local ffmpeg renderer. Bit-exact for a given prompt and seed.",
  }),
  entry({
    stage: "final", spec: "anchor-storyboard", adapter: "anchor-storyboard", modality: "video", paid: false, aliases: [],
    doc: "Free local anchor-frame storyboard presenter; admitted only for jobs that ask for frame anchors.",
  }),
  ...falVideoSpecs,
  entry({
    stage: "final", spec: "image:mock", adapter: "rich-animatic", modality: "video", paid: false, aliases: [],
    doc: "Rich animatic over the deterministic local image renderer, used as a final-stage fallback.",
  }),
  ...falImageSpecs("final"),
  // --- animatic ------------------------------------------------------------
  entry({
    stage: "animatic", spec: "mock", adapter: "rich-animatic", modality: "video", paid: false, aliases: ["", "image:mock"],
    doc: "Rich animatic over the deterministic local image renderer.",
  }),
  entry({
    stage: "animatic", spec: "legacy-mock", adapter: "mock", modality: "video", paid: false, aliases: [],
    doc: "The pre-animatic deterministic video renderer, kept for animatics that predate the rich animatic.",
  }),
  entry({
    stage: "animatic", spec: "anchor-storyboard", adapter: "anchor-storyboard", modality: "video", paid: false, aliases: [],
    doc: "Free local anchor-frame storyboard presenter.",
  }),
  ...falImageSpecs("animatic"),
  // --- character-sheet -----------------------------------------------------
  entry({
    stage: "character-sheet", spec: "mock", adapter: "rich-animatic", modality: "video", paid: false, aliases: ["", "image:mock"],
    doc: "Rich animatic over the deterministic local image renderer, narration and captions forced off.",
  }),
  ...falImageSpecs("character-sheet"),
]);

const UNKNOWN = "Unknown provider configuration for this render stage.";

/** The canonical specs admissible on a stage, in registry order. */
export function registeredSpecs(stage: Stage): string[] {
  return PROVIDER_REGISTRY.filter((value) => value.stage === stage).map((value) => value.spec);
}

/** Every spelling admissible on a stage — canonical specs and aliases together. */
export function registeredSpellings(stage: Stage): string[] {
  return PROVIDER_REGISTRY.filter((value) => value.stage === stage).flatMap((value) => [value.spec, ...value.aliases]);
}

/** The registry entry for a spelling on a stage, or undefined when the pair is not admissible. */
export function registryEntry(spec: string, stage: Stage): RegistryEntry | undefined {
  if (typeof spec !== "string" || spec.length > 200) return undefined;
  const value = spec.trim();
  return PROVIDER_REGISTRY.find(
    (candidate) => candidate.stage === stage && (candidate.spec === value || candidate.aliases.includes(value)),
  );
}

/**
 * The canonical spelling of a spec on a stage. Idempotent by construction:
 * normalizeSpec(normalizeSpec(s, stage), stage) === normalizeSpec(s, stage).
 * Throws for a pair the registry does not admit.
 */
export function normalizeSpec(spec: string, stage: Stage): string {
  const found = registryEntry(spec, stage);
  if (!found) throw new Error(UNKNOWN);
  return found.spec;
}

/** Whether dispatching to this spec on this stage bills. Throws for an unregistered pair. */
export function specIsPaid(spec: string, stage: Stage): boolean {
  const found = registryEntry(spec, stage);
  if (!found) throw new Error(UNKNOWN);
  return found.paid;
}

/**
 * The spec prefixes that name a billing vendor family, derived from the paid
 * entries rather than transcribed. An entry whose canonical spec carries no
 * family separator is deliberately excluded: an empty prefix would make every
 * spec look paid.
 */
export const PAID_SPEC_FAMILIES: readonly string[] = Object.freeze([
  ...new Set(
    PROVIDER_REGISTRY.filter((value) => value.paid && value.spec.includes(":")).map((value) =>
      value.spec.slice(0, value.spec.lastIndexOf(":") + 1),
    ),
  ),
]);

/**
 * Whether a spec names a paid vendor family on any stage, including a model key
 * this build does not know — an unregistered model inside a paid family answers
 * true, because "this build does not know that model" is not a reason to treat
 * it as free.
 *
 * Note what this is NOT: admission does not ask this question. Every budget
 * reservation keys off the admitted snapshot instead (`entry.snapshot.price.unit
 * !== "free"` in packages/api/src/server.ts and packages/queue/src/worker.ts),
 * and those paths never see an unknown model key because describeProvider has
 * already refused it. This function exists so that `providerUsesPaidInference`
 * is derived from the registry rather than being a fourth hand-written switch
 * over the same grammar; it has no production caller today.
 */
export function specNamesPaidFamily(spec: string): boolean {
  if (typeof spec !== "string") return false;
  const value = spec.trim();
  return PAID_SPEC_FAMILIES.some((family) => value === family.slice(0, -1) || value.startsWith(family));
}
