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
  shots: { id: string; provider: string; model: string; seed: number; fingerprint: string; routing?: import("../../generator/src/router").RenderRoute;
    /** HV-017-17: the locked looks this shot's render was conditioned on; absent when no character in it was locked. */
    identityLocks?: import("./identity-locks").ShotIdentityLock[];
    /** HV-019-16: the reference images an adapter recorded by digest without rendering from them (the mock); absent from a vendor's shot. */
    referenceRecord?: import("../../generator/src/image").ReferenceRecord;
    /**
     * HV-019-17: which of the shot's characters' images were sent and which dropped, when they held more than
     * its pool takes. Absent when none were cut. This is the planner's choice; `referenceRecord` is what a
     * recording adapter did with what it was sent, and when both are present the record's images are
     * checked to be exactly the budget's sent images (`assertBudgetMatchesRecord`).
     */
    referenceBudget?: import("./reference-budget").ShotReferenceBudget;
    /**
     * HV-019-19: present when the shot's prompt was longer than its provider takes and was fitted before it
     * was sent: the limit, the original and fitted lengths and sha256s, and each part cut. Absent when the
     * prompt was sent whole.
     */
    promptFit?: import("./prompt-fit").ShotPromptFit }[];
  /** When this export was assembled. A provenance record, not a placeholder. */
  assembledAt: string;
  casting?: import("./casting").CastingSnapshot;
  direction?: import("./direction").DirectionSnapshot;
  coverage?: import("./coverage").CoverageReport;
  credentials: ProvenanceCredentials;
}

/**
 * The credential block. Unsigned it is JSON in C2PA's shape and says so by name. Signed (HV-031-15)
 * it names the C2PA manifest store written beside the MP4 and the sha256 of that file's bytes. The
 * signature inside the sidecar binds the MP4's own bytes, so this JSON is not hashed into it and the
 * two can never refer to each other in a circle.
 */
export type ProvenanceCredentials =
  | { type: typeof PROVENANCE_CREDENTIAL_TYPE; issuer: typeof PROVENANCE_ISSUER; claim: string }
  | { type: typeof PROVENANCE_SIGNED_CREDENTIAL_TYPE; issuer: typeof PROVENANCE_ISSUER; claim: string; sidecar: ProvenanceSidecar };
/** The signed C2PA manifest store beside an export, by its fixed name and the sha256 of its bytes. */
export interface ProvenanceSidecar { name: typeof PROVENANCE_SIDECAR_NAME; sha256: string }

export const PROVENANCE_SPEC = "hv-provenance/1.0";

export class ProvenanceError extends Error {
  override readonly name = "ProvenanceError";
}
export const PROVENANCE_ISSUER = "hollywood-video-app";
/** Named for what it is: JSON beside the MP4, in C2PA's shape, unsigned. */
export const PROVENANCE_CREDENTIAL_TYPE = "c2pa-style";
/** A real C2PA manifest store, signed with the host's key, beside the MP4 (HV-031-15). */
export const PROVENANCE_SIGNED_CREDENTIAL_TYPE = "c2pa-sidecar";
/** The sidecar's file name, in the same directory as `provenance.json`. */
export const PROVENANCE_SIDECAR_NAME = "provenance.c2pa";

/** The content-credential claim for an export whose MP4 hashes to `sha256`. */
export const provenanceClaim = (sha256: string): string =>
  `AI-generated video; content credentials sha256:${sha256}`;

/**
 * The whole credential block, so no writer assembles one field at a time. With a sidecar it is the
 * signed form; without one it is the unsigned form, and nothing in between exists: a sidecar whose
 * name or digest is not exactly right is refused rather than recorded.
 */
export function provenanceCredentials(sha256: string, sidecar?: unknown): ProvenanceCredentials {
  if (sidecar === undefined) return { type: PROVENANCE_CREDENTIAL_TYPE, issuer: PROVENANCE_ISSUER, claim: provenanceClaim(sha256) };
  return { type: PROVENANCE_SIGNED_CREDENTIAL_TYPE, issuer: PROVENANCE_ISSUER, claim: provenanceClaim(sha256), sidecar: provenanceSidecar(sidecar) };
}

/**
 * A sidecar reference is exactly `{name: "provenance.c2pa", sha256: <64 lowercase hex>}`. A name, not
 * a path: public provenance carries no storage paths, and the sidecar is always beside the record.
 */
export function provenanceSidecar(value: unknown): ProvenanceSidecar {
  const sidecar = value as Partial<ProvenanceSidecar> | null;
  if (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar) || Object.keys(sidecar).sort().join(",") !== "name,sha256"
    || sidecar.name !== PROVENANCE_SIDECAR_NAME || typeof sidecar.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sidecar.sha256)) {
    throw new ProvenanceError("A signed provenance record names its sidecar as provenance.c2pa with the sha256 of its bytes.");
  }
  return { name: sidecar.name, sha256: sidecar.sha256 };
}

/**
 * Do a record and the sidecar bytes beside it agree? A signed record must name exactly those bytes'
 * sha256; an export with no sidecar must not carry a signed record. `sidecarSha256` is `null` when
 * there is no sidecar. This is the digest check only; the signature is a C2PA validator's to check.
 */
export function provenanceSidecarAgrees(record: unknown, sidecarSha256: string | null): boolean {
  const credentials = (record as { credentials?: { type?: unknown; sidecar?: unknown } } | null)?.credentials;
  const signed = Boolean(credentials) && typeof credentials === "object" && credentials!.type === PROVENANCE_SIGNED_CREDENTIAL_TYPE;
  if (sidecarSha256 === null) return !signed;
  if (!signed) return false;
  try {return provenanceSidecar(credentials!.sidecar).sha256 === sidecarSha256;} catch {return false;}
}

/**
 * An export's sidecar, and each take's, is exactly the `provenance.c2pa` beside its own
 * `provenance.json`, or absent. Storage paths that accept a job's output from outside (import,
 * restore, snapshots) check this, so a sidecar path cannot name some other file in the job.
 */
export function assertProvenanceSidecarsBeside(output: { manifestPath: string; c2paPath?: string; takeClips?: { manifestPath: string; c2paPath?: string }[] }): void {
  for (const value of [output, ...(output.takeClips ?? [])]) {
    if (value.c2paPath !== undefined && value.c2paPath !== provenanceSidecarPath(value.manifestPath)) throw new ProvenanceError("A C2PA sidecar sits beside its own provenance record.");
  }
}

/** The sidecar's artifact path for an export whose `provenance.json` is at `manifestPath`. */
export function provenanceSidecarPath(manifestPath: string): string {
  if (!manifestPath.endsWith("/provenance.json")) throw new ProvenanceError("A sidecar sits beside its provenance.json.");
  return manifestPath.slice(0, -"provenance.json".length) + PROVENANCE_SIDECAR_NAME;
}

/**
 * HV-031-17: the credential block a stage's own record carries for its export. The picture edit,
 * the assembly, a sound mix and a dialogue or lip-sync version each write their own record schema;
 * each now carries the same `credentials` block as the assembler's record.
 *
 * Returns what is wrong, or `null` when the block is exactly `provenanceCredentials(mp4Sha256)`, or
 * its signed form. `sidecar` is `null` when the sealed output holds no sidecar, that sidecar's bytes
 * when it holds one, and `undefined` when the caller checks the record alone. Keys are compared as a
 * set, because PostgreSQL's jsonb reorders them.
 */
export function exportCredentialsProblem(credentials: unknown, mp4Sha256: string, sidecar?: { sha256: string } | null): string | null {
  const value = credentials as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "An export's record carries its content credentials.";
  const signed = value.type === PROVENANCE_SIGNED_CREDENTIAL_TYPE;
  if (Object.keys(value).sort().join(",") !== (signed ? "claim,issuer,sidecar,type" : "claim,issuer,type")
    || (!signed && value.type !== PROVENANCE_CREDENTIAL_TYPE) || value.issuer !== PROVENANCE_ISSUER || value.claim !== provenanceClaim(mp4Sha256)) return "An export's content credentials name another export.";
  if (signed) {
    let named: ProvenanceSidecar;
    try {named = provenanceSidecar(value.sidecar);} catch (error) {return (error as Error).message;}
    if (sidecar === null) return "A signed record names a C2PA sidecar the export does not hold.";
    if (sidecar && sidecar.sha256 !== named.sha256) return "The C2PA sidecar differs from the bytes its provenance record names.";
  } else if (sidecar) return "An unsigned record cannot have a C2PA sidecar beside it.";
  return null;
}

/**
 * HV-031-17: a stage's sealed output against its record's credentials. The output's `c2paPath` is
 * the `provenance.c2pa` beside its own `provenance.json` and in the output's inventory, or absent;
 * the record is signed exactly when it is present, naming those bytes. A record with no credentials
 * at all was made before HV-031-17 and agrees only with an output that claims no sidecar.
 */
export function exportSidecarProblem(output: { manifestPath: string; c2paPath?: unknown }, credentials: unknown, mp4Sha256: string, files: readonly { path: string; sha256: string }[]): string | null {
  if (output.c2paPath !== undefined && output.c2paPath !== provenanceSidecarPath(output.manifestPath)) return "A C2PA sidecar sits beside its own provenance record.";
  const sidecar = output.c2paPath === undefined ? null : files.find(file => file.path === output.c2paPath) ?? null;
  if (output.c2paPath !== undefined && !sidecar) return "The export's C2PA sidecar is missing from its media.";
  if (credentials === undefined) return sidecar ? "An export with a C2PA sidecar names it in its record." : null;
  return exportCredentialsProblem(credentials, mp4Sha256, sidecar);
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
/**
 * The render records a manifest carries, in comparison order — `null` when it carries none.
 *
 * HV-031-09: four verifiers wrote `provenance.shots?.map(s => s.renderRecord)` inline, and two of
 * them left the `?? null` off. That is not a cosmetic difference. `contentHash(undefined)` is not a
 * hash of nothing: `canonical(undefined)` is `JSON.stringify(undefined)`, which is `undefined`, and
 * `createHash("sha256").update(undefined)` throws a `TypeError`.
 *
 * So a manifest that satisfied `provenanceMatches` — right spec, right project, valid `assembledAt`,
 * a claim bound to the file's sha256 — and had lost its `shots` key killed the job with
 * `The "data" argument must be of type string or an instance of Buffer…` as its `failureReason`,
 * instead of the refusal each verifier has written out. A tamper signal became an internal type
 * error, and the creator was told nothing about their film.
 *
 * This module exists because the spec and the claim were each written in five places and "each
 * verifier reported a different failure". The identity check moved here and this comparison did not.
 * Now the extraction is a function, so the `?? null` cannot be left off: there is nowhere to leave it.
 */
export function provenanceShotRecords(manifest: unknown): unknown[] | null {
  const value = manifest as Partial<ProvenanceManifest> | null;
  if (!value || typeof value !== "object" || !Array.isArray(value.shots)) return null;
  return value.shots.map(shot => (shot as { renderRecord?: unknown }).renderRecord);
}

export function provenanceMatches(
  manifest: unknown,
  expected: { projectId: string; sha256: string },
): boolean {
  const value = manifest as Partial<ProvenanceManifest> | null;
  if (!value || typeof value !== "object") return false;
  if (value.assembledAt !== PROVENANCE_PLACEHOLDER_AT) {
    try {provenanceAssembledAt(value.assembledAt);} catch {return false;}
  }
  const credentials = value.credentials as Partial<{ type: string; issuer: string; claim: string; sidecar: unknown }> | undefined;
  if (!credentials || typeof credentials !== "object") return false;
  // Signed or unsigned, and nothing else (HV-031-15). A signed record must name its sidecar
  // exactly; an unsigned one must not carry a sidecar at all, so a stray field cannot make an
  // unsigned record look signed to a reader that only checks for the key.
  if (credentials.type === PROVENANCE_SIGNED_CREDENTIAL_TYPE) {
    try {provenanceSidecar(credentials.sidecar);} catch {return false;}
  } else if (credentials.type !== PROVENANCE_CREDENTIAL_TYPE || "sidecar" in credentials) return false;
  return value.spec === PROVENANCE_SPEC
    && value.projectId === expected.projectId
    && credentials.issuer === PROVENANCE_ISSUER
    && credentials.claim === provenanceClaim(expected.sha256);
}
