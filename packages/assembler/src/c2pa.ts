/**
 * HV-031-15: a real C2PA manifest store, signed with the staging host's own ES256 key, written as a
 * sidecar beside each export's MP4.
 *
 * **Sidecar, not embedded.** Embedding rewrites the MP4, and five flows compare a retained export's
 * bytes to the sha256 its `provenance.json` claims. A sidecar leaves the MP4 byte-identical, and its
 * hard binding is C2PA's BMFF hash over the MP4's own boxes, so changing a byte of the film breaks it.
 *
 * **The key never leaves the host.** `HV_C2PA_SIGNING_KEY` and `HV_C2PA_SIGNING_CERT` are file
 * paths in the host's environment, set by the operator. Neither file's contents is logged, returned
 * or put in an error. With neither set, nothing is signed and the record says it is unsigned. With
 * only one set the export refuses, because a half-configured host silently shipping unsigned films
 * is the dishonest outcome.
 *
 * **The EKU list is explicit.** c2pa-node 0.9.9's default settings carry an empty list of allowed
 * extended key usages, so every certificate reads "missing required EKU", and with verify-after-sign
 * on by default even a correct one fails to sign. The list below is the one the C2PA specification
 * names, passed on every sign and every read.
 *
 * The self-issued certificate is not on any public trust list (G15 item 4), so public validators show
 * an unrecognized signer: `Valid` with `signingCredential.untrusted`. That is the honest status.
 */
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { Builder, Context, LocalSigner, Reader } from "@contentauth/c2pa-node";

export const C2PA_KEY_ENV = "HV_C2PA_SIGNING_KEY";
export const C2PA_CERT_ENV = "HV_C2PA_SIGNING_CERT";

/** id-kp-emailProtection, id-kp-documentSigning, id-kp-timeStamping, id-kp-OCSPSigning, c2pa-kp-claimSigning. */
export const C2PA_SIGNING_EKUS = ["1.3.6.1.5.5.7.3.4", "1.3.6.1.5.5.7.3.36", "1.3.6.1.5.5.7.3.8", "1.3.6.1.5.5.7.3.9", "1.3.6.1.4.1.62558.2.1"] as const;
const TRUST_CONFIG = C2PA_SIGNING_EKUS.join("\n") + "\n";
/** IPTC's term for media a trained model produced, which every export of this program is. */
const AI_SOURCE = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

export class C2paError extends Error {
  override readonly name = "C2paError";
}

/** Where the host keeps its signing key and certificate chain (leaf first), as file paths. */
export interface C2paSigning { keyPath: string; certPath: string }

/** The host's signing configuration, or `null` when it holds none. One without the other refuses. */
export function c2paSigningFromEnv(env: Record<string, string | undefined> = process.env): C2paSigning | null {
  const keyPath = env[C2PA_KEY_ENV] || undefined, certPath = env[C2PA_CERT_ENV] || undefined;
  if (!keyPath && !certPath) return null;
  if (!keyPath || !certPath) throw new C2paError(`Set both ${C2PA_KEY_ENV} and ${C2PA_CERT_ENV}, or neither.`);
  return { keyPath, certPath };
}

/** A loaded signer. Opaque on purpose: it holds the key, and nothing outside this module reads it. */
export interface C2paSigner { readonly signer: LocalSigner; readonly subject: string }

/**
 * Load and check the key and certificate before any media is encoded, so a misconfigured host costs
 * no ffmpeg run. The key may be PKCS#8 or SEC1 (`EC PRIVATE KEY`); c2pa-node accepts only PKCS#8, so
 * it is converted in memory. It must be P-256, the leaf must carry `digitalSignature` use and one of
 * the C2PA signing EKUs, and the leaf's public key must be the key's.
 */
export function loadC2paSigner(signing: C2paSigning): C2paSigner {
  let key: ReturnType<typeof createPrivateKey>;
  try {key = createPrivateKey(readFileSync(signing.keyPath));} catch {throw new C2paError(`The C2PA signing key at ${C2PA_KEY_ENV} is unreadable or not a private key.`);}
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new C2paError("The C2PA signing key must be an EC P-256 key for ES256.");
  let chain: Buffer, leaf: X509Certificate;
  try {chain = readFileSync(signing.certPath);leaf = new X509Certificate(chain);} catch {throw new C2paError(`The C2PA certificate at ${C2PA_CERT_ENV} is unreadable or not a PEM certificate.`);}
  if (!leaf.checkPrivateKey(key)) throw new C2paError("The C2PA certificate's first entry is not the signing key's certificate.");
  if (leaf.ca) throw new C2paError("The C2PA signing certificate must be an end-entity certificate, not a CA.");
  const ekus = leaf.keyUsage ?? [];
  if (!ekus.some(oid => (C2PA_SIGNING_EKUS as readonly string[]).includes(oid))) {
    throw new C2paError(`The C2PA signing certificate needs an extended key usage C2PA accepts, such as documentSigning (1.3.6.1.5.5.7.3.36); it has ${ekus.length ? ekus.join(", ") : "none"}.`);
  }
  const pkcs8 = Buffer.from(key.export({ type: "pkcs8", format: "pem" }) as string);
  try {return { signer: LocalSigner.newSigner(chain, pkcs8, "es256"), subject: leaf.subject };}
  catch {throw new C2paError("c2pa-node refused the C2PA signing key or certificate.");}
}

/** What the sidecar asserts beside C2PA's own actions: this program's record of the export. */
export interface C2paProvenanceAssertion { spec: string; issuer: string; projectId: string; assembledAt: string; mp4Sha256: string }
export const C2PA_PROVENANCE_LABEL = "hv.provenance";

/**
 * Sign `mp4Path` and write the manifest store to `sidecarPath`. The MP4 is read, never written. Its
 * digest is checked before and after, so a file that changed while being signed is refused rather
 * than recorded with a signature over bytes nobody holds.
 */
export function signC2paSidecar(signer: C2paSigner, mp4Path: string, sidecarPath: string, record: C2paProvenanceAssertion, generator: string): { sha256: string; bytes: number } {
  const before = sha256File(mp4Path);
  if (before !== record.mp4Sha256) throw new C2paError("The export changed before its C2PA manifest was signed.");
  const builder = Builder.withJson({
    claim_generator_info: [{ name: generator }], title: "export.mp4", format: "video/mp4",
    assertions: [
      { label: "c2pa.actions", data: { actions: [{ action: "c2pa.created", digitalSourceType: AI_SOURCE }] } },
      { label: C2PA_PROVENANCE_LABEL, data: record },
    ],
  } as never, { trust: { trust_config: TRUST_CONFIG } } as never);
  builder.setNoEmbed(true);
  let manifest: Buffer;
  try {manifest = builder.sign(signer.signer, { path: mp4Path, mimeType: "video/mp4" }, { buffer: null } as never);}
  catch (error) {throw new C2paError("C2PA signing failed: " + String((error as Error)?.message ?? error).slice(0, 300));}
  if (sha256File(mp4Path) !== before) throw new C2paError("The export changed while its C2PA manifest was signed.");
  writeFileSync(sidecarPath, manifest);
  return { sha256: createHash("sha256").update(manifest).digest("hex"), bytes: manifest.byteLength };
}

export interface C2paVerification {
  /** `Trusted` chains to a supplied anchor; `Valid` is intact but its signer is unrecognized; `Invalid` is not intact. */
  state: "Trusted" | "Valid" | "Invalid";
  /** Every validation status code reported, failures and informational alike. */
  codes: string[];
  signer: { commonName: string | null; issuer: string | null; alg: string | null };
  provenance: C2paProvenanceAssertion | null;
}

/**
 * Read a sidecar against its MP4 with the C2PA EKU list, and with `anchorsPem` as user trust anchors
 * when given. This is the same check any C2PA validator runs; it is used by the tests and by
 * `scripts/verify-c2pa.ts`.
 */
export async function verifyC2paSidecar(mp4Path: string, sidecar: Buffer, anchorsPem?: string): Promise<C2paVerification> {
  const context = new Context({ trust: { trustConfig: TRUST_CONFIG, ...(anchorsPem ? { userAnchors: anchorsPem } : {}) } });
  const reader = await Reader.fromManifestDataAndAsset(sidecar, { path: mp4Path, mimeType: "video/mp4" }, context);
  const raw = reader.json() as unknown, store = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    active_manifest?: string; validation_state?: string; validation_status?: { code: string }[];
    validation_results?: { activeManifest?: { failure?: { code: string }[]; informational?: { code: string }[] } };
    manifests?: Record<string, { signature_info?: { common_name?: string; issuer?: string; alg?: string }; assertions?: { label: string; data: unknown }[] }>;
  };
  const active = store.active_manifest ? store.manifests?.[store.active_manifest] : undefined;
  const state = store.validation_state === "Trusted" || store.validation_state === "Valid" ? store.validation_state : "Invalid";
  const codes = [...new Set([...(store.validation_status ?? []), ...(store.validation_results?.activeManifest?.failure ?? [])].map(s => s.code))];
  const provenance = (active?.assertions?.find(a => a.label === C2PA_PROVENANCE_LABEL)?.data ?? null) as C2paProvenanceAssertion | null;
  return { state, codes, signer: { commonName: active?.signature_info?.common_name ?? null, issuer: active?.signature_info?.issuer ?? null, alg: active?.signature_info?.alg ?? null }, provenance };
}

/** Chunked, so a long export is not read into memory whole. */
function sha256File(path: string): string {
  const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, "r");
  try {for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) hash.update(chunk.subarray(0, read));}
  finally {closeSync(fd);}
  return hash.digest("hex");
}
