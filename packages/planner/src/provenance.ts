/**
 * The provenance manifest and the three strings that identify it.
 *
 * This is a leaf module on purpose: everything it imports is type-only and
 * therefore erased, so the assembler that writes a manifest and the three
 * generator modules that verify one before reusing footage can all reach it
 * without a runtime import cycle between the packages.
 *
 * It exists because the spec identifier and the content-credential claim were
 * each written in five places — once in the assembler and at four call sites
 * across those three modules, two as concatenation and two as template
 * literals. They agreed, and nothing made them agree; a change to the claim
 * in the producer would have made every retained export unreusable one flow
 * at a time, with each verifier reporting a different failure.
 */
export interface ProvenanceManifest {
  spec: typeof PROVENANCE_SPEC;
  projectId: string;
  scriptSha256: string;
  shots: { id: string; provider: string; model: string; seed: number; fingerprint: string; routing?: import("../../generator/src/router").RenderRoute }[];
  /** When this export was assembled. A provenance record, not a placeholder. */
  assembledAt: string;
  casting?: import("./casting").CastingSnapshot;
  direction?: import("./direction").DirectionSnapshot;
  coverage?: import("./coverage").CoverageReport;
  credentials: { type: typeof PROVENANCE_CREDENTIAL_TYPE; issuer: typeof PROVENANCE_ISSUER; claim: string };
}

export const PROVENANCE_SPEC = "hv-provenance/1.0";
export const PROVENANCE_ISSUER = "hollywood-video-app";
/** Named for what it is: JSON beside the MP4, in C2PA's shape, unsigned. */
export const PROVENANCE_CREDENTIAL_TYPE = "c2pa-style";

/** The content-credential claim for an export whose MP4 hashes to `sha256`. */
export const provenanceClaim = (sha256: string): string =>
  `AI-generated video; content credentials sha256:${sha256}`;

/** The whole credential block, so no writer assembles one field at a time. */
export const provenanceCredentials = (sha256: string): ProvenanceManifest["credentials"] =>
  ({ type: PROVENANCE_CREDENTIAL_TYPE, issuer: PROVENANCE_ISSUER, claim: provenanceClaim(sha256) });

export class ProvenanceError extends Error {
  override readonly name = "ProvenanceError";
}

/**
 * The instant an export was assembled, as the manifest must carry it.
 *
 * Every export ever produced shipped `assembledAt: "1970-01-01T00:00:00.000Z"`
 * — a string literal in the manifest constructor, never a parameter and never
 * overwritten. FR-018 requires the content credential to carry a timestamp and
 * V-010's threshold is "every frame carries model, prompt hash, timestamp, and
 * seed", so the one field of that requirement which is a timestamp was a
 * constant, and a rights enquiry asking when a contested export was assembled
 * got 1970 for every project ever rendered.
 *
 * The epoch is refused by name rather than only by shape, because that exact
 * value is what a frozen placeholder looks like and a validator that accepts
 * it would have passed every export this program has produced.
 */
export function provenanceAssembledAt(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new ProvenanceError("An export's assembly time must be a UTC ISO 8601 instant.");
  }
  if (Date.parse(value) <= 0) {
    throw new ProvenanceError("An export's assembly time must be a real instant, not a placeholder epoch.");
  }
  return value;
}

/**
 * Does this manifest identify the export the caller is holding? The three
 * checks every reader made for itself: the spec, the project, and the claim
 * bound to the media's own hash.
 *
 * A predicate rather than a throwing assertion because each of the four read
 * sites reports its own flow-specific refusal — "the editorial source differs
 * from its original current-film picture provenance" and three others — and
 * those sentences are what a person sees. What was duplicated was the identity
 * comparison, not the message, so only the comparison moves here.
 *
 * **`assembledAt` is deliberately not checked here.** Every export assembled
 * before this increment carries the placeholder epoch, and those exports are
 * retained media that people are still editing. Refusing to reuse them would
 * destroy access to existing work over a defect the user did not cause, so the
 * timestamp is enforced where it is written and tolerated where it is read.
 * A test pins that decision rather than leaving it to be rediscovered.
 */
export function provenanceMatches(
  manifest: unknown,
  expected: { projectId: string; sha256: string },
): boolean {
  const value = manifest as Partial<ProvenanceManifest> | null;
  return Boolean(value) && typeof value === "object"
    && value!.spec === PROVENANCE_SPEC
    && value!.projectId === expected.projectId
    && value!.credentials?.claim === provenanceClaim(expected.sha256);
}
