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
 * only one set, or a key, certificate or chain that is wrong or outside its validity window, the
 * worker refuses to start (`assertC2paSigningConfig`), and an export refuses before encoding: a
 * half-configured host silently shipping unsigned films is the dishonest outcome.
 *
 * **The worker signs off the event loop.** `signC2paSidecar` uses the Builder's `signAsync` with a
 * callback signer and streams its digests, yielding per chunk and honouring cancellation; the
 * synchronous form is for `assemble()` (benchmarks, local tooling) only.
 *
 * **The EKU list is explicit.** c2pa-node 0.9.9's default settings carry an empty list of allowed
 * extended key usages, so every certificate reads "missing required EKU", and with verify-after-sign
 * on by default even a correct one fails to sign. The list below is the one the C2PA specification
 * names, passed on every sign and every read.
 *
 * The self-issued certificate is not on any public trust list (G15 item 4), so public validators show
 * an unrecognized signer: `Valid` with `signingCredential.untrusted`. That is the honest status.
 */
import { createHash, createPrivateKey, sign, X509Certificate } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { Builder, CallbackSigner, Context, LocalSigner, Reader } from "@contentauth/c2pa-node";

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
export interface C2paSigner {
  /** For the synchronous `assemble()` used by benchmarks and local tooling. */
  readonly local: LocalSigner;
  /** For the worker: signs off the event loop through `Builder.signAsync`. */
  readonly callback: CallbackSigner;
  readonly subject: string;
  /** The earliest `validTo` in the chain, so a caller can say when the host's certificate lapses. */
  readonly notAfter: string;
}

/**
 * Touch the native binding before any key is read, so a host whose binding cannot load is told
 * that, not that its key or certificate was refused. c2pa-node loads `dist/index.node`, or
 * `C2PA_LIBRARY_PATH` when set, on first use.
 */
function loadNative(): void {
  try {Builder.new();}
  catch (error) {throw new C2paError("The C2PA native library could not be loaded: " + String((error as Error)?.message ?? error).slice(0, 200));}
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * Load and check the key and certificate chain before any media is encoded. The worker also calls
 * this at startup, so a misconfigured host refuses to start rather than generating films (and
 * spending on them) that then cannot be signed.
 *
 * The key may be PKCS#8 or SEC1 (`EC PRIVATE KEY`); c2pa-node accepts only PKCS#8, so it is
 * converted in memory. It must be P-256. The chain's first certificate must be the key's, an end
 * entity, and carry one of the C2PA signing EKUs. Every certificate in the chain must be valid at
 * `now`: C2PA validators refuse an expired signer, so an expired or not-yet-valid one is refused here.
 */
export function loadC2paSigner(signing: C2paSigning, now: number = Date.now()): C2paSigner {
  loadNative();
  let key: ReturnType<typeof createPrivateKey>;
  try {key = createPrivateKey(readFileSync(signing.keyPath));} catch {throw new C2paError(`The C2PA signing key at ${C2PA_KEY_ENV} is unreadable or not a private key.`);}
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new C2paError("The C2PA signing key must be an EC P-256 key for ES256.");
  let pem: string, certificates: X509Certificate[];
  try {pem = readFileSync(signing.certPath, "utf8");certificates = (pem.match(PEM_CERTIFICATE) ?? []).map(block => new X509Certificate(block));}
  catch {throw new C2paError(`The C2PA certificate at ${C2PA_CERT_ENV} is unreadable or not a PEM certificate.`);}
  const leaf = certificates[0];
  if (!leaf || certificates.length > 8) throw new C2paError(`The C2PA certificate at ${C2PA_CERT_ENV} must hold the signing certificate first, then at most seven issuers.`);
  if (!leaf.checkPrivateKey(key)) throw new C2paError("The C2PA certificate's first entry is not the signing key's certificate.");
  if (leaf.ca) throw new C2paError("The C2PA signing certificate must be an end-entity certificate, not a CA.");
  const ekus = leaf.keyUsage ?? [];
  if (!ekus.some(oid => (C2PA_SIGNING_EKUS as readonly string[]).includes(oid))) {
    throw new C2paError(`The C2PA signing certificate needs an extended key usage C2PA accepts, such as documentSigning (1.3.6.1.5.5.7.3.36); it has ${ekus.length ? ekus.join(", ") : "none"}.`);
  }
  for (const [index, certificate] of certificates.entries()) {
    const from = Date.parse(certificate.validFrom), to = Date.parse(certificate.validTo), which = index ? `issuer certificate ${index}` : "signing certificate";
    if (!(from <= now)) throw new C2paError(`The C2PA ${which} is not valid until ${new Date(from).toISOString()}.`);
    if (!(now <= to)) throw new C2paError(`The C2PA ${which} expired at ${new Date(to).toISOString()}; re-issue it for the same key.`);
  }
  const notAfter = new Date(Math.min(...certificates.map(certificate => Date.parse(certificate.validTo)))).toISOString();
  let local: LocalSigner;
  try {local = LocalSigner.newSigner(Buffer.from(pem), Buffer.from(key.export({ type: "pkcs8", format: "pem" }) as string), "es256");}
  catch {throw new C2paError("c2pa-node refused the C2PA signing key or certificate.");}
  // COSE ES256 is the raw r||s pair, which node calls IEEE P1363.
  const callback = CallbackSigner.newSigner({ alg: "es256", certs: (pem.match(PEM_CERTIFICATE) ?? []).map(block => Buffer.from(block)), reserveSize: local.reserveSize(), directCoseHandling: false },
    async data => sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }));
  return { local, callback, subject: leaf.subject, notAfter };
}

/**
 * Check the host's signing configuration once, at worker startup: `null` when the host holds no key,
 * otherwise the loaded signer's subject and expiry. Half-set, unreadable, mismatched, expired or
 * EKU-less configuration throws, and the worker refuses to start.
 */
export function assertC2paSigningConfig(env: Record<string, string | undefined> = process.env, now: number = Date.now()): { subject: string; notAfter: string } | null {
  const signing = c2paSigningFromEnv(env);if (!signing) return null;
  const { subject, notAfter } = loadC2paSigner(signing, now);return { subject, notAfter };
}

/** What the sidecar asserts beside C2PA's own actions: this program's record of the export. */
export interface C2paProvenanceAssertion { spec: string; issuer: string; projectId: string; assembledAt: string; mp4Sha256: string }
export const C2PA_PROVENANCE_LABEL = "hv.provenance";

function definition(record: C2paProvenanceAssertion, generator: string) {
  return {
    claim_generator_info: [{ name: generator }], title: "export.mp4", format: "video/mp4",
    assertions: [
      { label: "c2pa.actions", data: { actions: [{ action: "c2pa.created", digitalSourceType: AI_SOURCE }] } },
      { label: C2PA_PROVENANCE_LABEL, data: record },
    ],
  } as never;
}
function signingFailure(error: unknown): C2paError {
  return error instanceof C2paError ? error : new C2paError("C2PA signing failed: " + String((error as Error)?.message ?? error).slice(0, 300));
}
function written(sidecarPath: string, manifest: Buffer): { sha256: string; bytes: number } {
  writeFileSync(sidecarPath, manifest);
  return { sha256: createHash("sha256").update(manifest).digest("hex"), bytes: manifest.byteLength };
}

/**
 * Sign `mp4Path` and write the manifest store to `sidecarPath`, off the event loop. The MP4 is read,
 * never written. Its digest is streamed before and after, checking `signal` between chunks, so a
 * cancelled job stops promptly and a file that changed while being signed is refused rather than
 * recorded with a signature over bytes nobody holds. The native sign itself cannot be interrupted;
 * cancellation is honoured as soon as it returns.
 */
export async function signC2paSidecar(signer: C2paSigner, mp4Path: string, sidecarPath: string, record: C2paProvenanceAssertion, generator: string, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  if (await sha256Stream(mp4Path, signal) !== record.mp4Sha256) throw new C2paError("The export changed before its C2PA manifest was signed.");
  const builder = await Builder.withJsonAsync(definition(record, generator), new Context({ trust: { trustConfig: TRUST_CONFIG } }));
  builder.setNoEmbed(true);
  let manifest: Buffer;
  try {signal?.throwIfAborted();manifest = await builder.signAsync(signer.callback, { path: mp4Path, mimeType: "video/mp4" }, { buffer: null } as never);}
  catch (error) {if (signal?.aborted) throw signal.reason;throw signingFailure(error);}
  signal?.throwIfAborted();
  if (await sha256Stream(mp4Path, signal) !== record.mp4Sha256) throw new C2paError("The export changed while its C2PA manifest was signed.");
  return written(sidecarPath, manifest);
}

/** The synchronous form, for `assemble()`: benchmarks and local tooling, never the worker. */
export function signC2paSidecarSync(signer: C2paSigner, mp4Path: string, sidecarPath: string, record: C2paProvenanceAssertion, generator: string): { sha256: string; bytes: number } {
  if (sha256File(mp4Path) !== record.mp4Sha256) throw new C2paError("The export changed before its C2PA manifest was signed.");
  const builder = Builder.withJson(definition(record, generator), { trust: { trust_config: TRUST_CONFIG } } as never);
  builder.setNoEmbed(true);
  let manifest: Buffer;
  try {manifest = builder.sign(signer.local, { path: mp4Path, mimeType: "video/mp4" }, { buffer: null } as never);}
  catch (error) {throw signingFailure(error);}
  if (sha256File(mp4Path) !== record.mp4Sha256) throw new C2paError("The export changed while its C2PA manifest was signed.");
  return written(sidecarPath, manifest);
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

/** Streamed, yielding to the event loop and checking `signal` between chunks. */
export async function sha256Stream(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  // A file stream's chunks resolve as microtasks, which starve timers (lease heartbeats included)
  // for the whole read; yielding to the macrotask queue per chunk keeps the loop turning.
  for await (const chunk of Bun.file(path).stream()) {signal?.throwIfAborted();hash.update(chunk);await new Promise(resolve => setImmediate(resolve));}
  signal?.throwIfAborted();return hash.digest("hex");
}

/** Chunked, so a long export is not read into memory whole. */
function sha256File(path: string): string {
  const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024), fd = openSync(path, "r");
  try {for (let read = readSync(fd, chunk); read > 0; read = readSync(fd, chunk)) hash.update(chunk.subarray(0, read));}
  finally {closeSync(fd);}
  return hash.digest("hex");
}
