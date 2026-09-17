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
 * The earliest instant this program could plausibly have assembled anything.
 *
 * A bound rather than a single forbidden value, because "refused by name" was
 * a millisecond deep: `Date.parse(value) <= 0` refuses the epoch and accepts
 * `1970-01-01T00:00:00.001Z`, which is indistinguishable from a placeholder in
 * any reader that truncates to seconds. Every placeholder anyone reaches for --
 * zero, one, `new Date(0)`, the epoch day -- is below this, and no export of
 * this program predates it.
 */
export const PROVENANCE_EARLIEST_MS = Date.parse("2020-01-01T00:00:00.000Z");

/** The exact placeholder every export assembled before HV-031-02 carries. */
export const PROVENANCE_PLACEHOLDER_AT = "1970-01-01T00:00:00.000Z";

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * The instant an export was assembled, as the manifest must carry it.
 *
 * Every export assembled before this existed carried
 * `"1970-01-01T00:00:00.000Z"` -- a string literal in the manifest
 * constructor, never a parameter and never overwritten. FR-018 requires the
 * content credential to carry a timestamp and V-010's threshold is "every
 * frame carries model, prompt hash, timestamp, and seed", so the one field of
 * that requirement which is a timestamp was a constant, and a rights enquiry
 * asking when a contested export was assembled got 1970.
 *
 * The date is required to round-trip: a first draft matched the shape with a
 * regular expression and then trusted `Date.parse`, which silently rolls
 * `2026-02-30T10:00:00Z` forward two days and `T24:00:00` to the next
 * morning. Both were accepted and stored verbatim, so the manifest said one
 * thing and every reader that re-parsed it said another.
 */
export function provenanceAssembledAt(value: unknown): string {
  if (typeof value !== "string") throw new ProvenanceError("An export's assembly time must be a UTC ISO 8601 instant.");
  const parts = INSTANT.exec(value);
  if (!parts) throw new ProvenanceError("An export's assembly time must be a UTC ISO 8601 instant.");
  const [, year, month, day, hour, minute, second, fraction] = parts;
  const milliseconds = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
    Number((fraction ?? "0").padEnd(3, "0")));
  // Date.UTC normalises out-of-range components rather than refusing them, so
  // the only way to know the string names a real instant is to render the
  // parsed value back and compare it.
  const rendered = new Date(milliseconds).toISOString();
  if (rendered.slice(0, 10) !== value.slice(0, 10) || new Date(milliseconds).getTime() !== Date.parse(value)) {
    throw new ProvenanceError("An export's assembly time must be a date that exists.");
  }
  if (milliseconds < PROVENANCE_EARLIEST_MS) {
    throw new ProvenanceError("An export's assembly time must be a real instant, not a placeholder epoch.");
  }
  return value;
}

/**
 * Does this manifest identify the export the caller is holding? The checks
 * every reader made for itself: the spec, the project, the declared credential
 * type and issuer, and the claim bound to the media's own hash.
 *
 * A predicate rather than a throwing assertion because each of the four read
 * sites reports its own flow-specific refusal — "the editorial source differs
 * from its original current-film picture provenance" and three others — and
 * those sentences are what a person sees. What was duplicated was the identity
 * comparison, not the message, so only the comparison moves here.
 *
 * **The assembly time is checked more loosely here than at the write
 * boundary**, and exactly one value is the reason: every export assembled
 * before this increment carries `PROVENANCE_PLACEHOLDER_AT`, and those are
 * retained media. Refusing them would take existing work away over a defect
 * the user did not cause, so that one literal is tolerated and nothing else
 * is — a missing, null or arbitrary value is refused here as well as there. A
 * first draft did not look at the field at all, which tolerated far more than
 * the decision it was documenting. Anonymous project data auto-deletes after
 * thirty days (FR-057), so the tolerated population clears itself; the
 * tolerance is not removed on a timer because nothing in the tree records when
 * the last placeholder-bearing export was written.
 */
export function provenanceMatches(
  manifest: unknown,
  expected: { projectId: string; sha256: string },
): boolean {
  const value = manifest as Partial<ProvenanceManifest> | null;
  if (!value || typeof value !== "object") return false;
  if (value.assembledAt !== PROVENANCE_PLACEHOLDER_AT) {
    try {provenanceAssembledAt(value.assembledAt);} catch {return false;}
  }
  return value.spec === PROVENANCE_SPEC
    && value.projectId === expected.projectId
    && value.credentials?.type === PROVENANCE_CREDENTIAL_TYPE
    && value.credentials?.issuer === PROVENANCE_ISSUER
    && value.credentials?.claim === provenanceClaim(expected.sha256);
}
