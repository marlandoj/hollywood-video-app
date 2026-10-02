/**
 * HV-031-17: the content credentials of an export some stage other than the assembler wrote.
 *
 * HV-031-15 signed the assembler's exports: the film, the mixed film and each take. The films the
 * studio shares are mostly not those. The crew flow shares the Editor's picture edit, and a review
 * link can be bound to an assembly, a sound mix, or a dialogue or lip-sync version. Each of those
 * writes its own `provenance.json` schema, and none carried credentials at all.
 *
 * This signs them the same way, with the same signer: a C2PA manifest store beside the stage's own
 * record, bound by BMFF hash to the stage's MP4, which is never rewritten. The record then carries
 * the same `credentials` block as the assembler's: the signed type naming the sidecar's sha256 when
 * the host holds the key, the unsigned type when it holds none. Signing runs off the event loop
 * (`signC2paSidecar`), honouring the job's cancellation.
 */
import { join } from "node:path";
import { PROVENANCE_ISSUER, PROVENANCE_SIDECAR_NAME, provenanceCredentials, type ProvenanceCredentials } from "../../planner/src/provenance";
import { c2paSigningFromEnv, loadC2paSigner, sha256Stream, signC2paSidecar, type C2paSigner, type C2paSigning } from "./c2pa";

/**
 * The host's signer, loaded and checked, or `null` when the host holds no key. Stages call this at
 * their entry, before any media is encoded, so a host whose key or certificate went wrong after the
 * worker started (an expired certificate, say) refuses before the work rather than after it.
 * `signing` is for tests; left out, it is read from `HV_C2PA_SIGNING_KEY`/`HV_C2PA_SIGNING_CERT`.
 */
export function exportC2paSigner(signing: C2paSigning | null = c2paSigningFromEnv()): C2paSigner | null {
  return signing ? loadC2paSigner(signing) : null;
}

export interface ExportCredentials {
  credentials: ProvenanceCredentials;
  /** The sidecar written beside the record, on disk; absent when the export is unsigned. */
  sidecarPath?: string;
}

/**
 * Sign the export at `mp4Path` and write its sidecar into `recordDirectory`, the directory its
 * `provenance.json` is about to be written in, then return the credentials that record carries.
 * Without a signer nothing is written and the credentials say the export is unsigned. `spec` is the
 * stage's own record schema, named in the signed assertion beside the MP4's sha256.
 */
export async function exportCredentials(signer: C2paSigner | null, input: { mp4Path: string; recordDirectory: string; spec: string; projectId: string; signedAt?: string }, signal?: AbortSignal): Promise<ExportCredentials> {
  const mp4Sha256 = await sha256Stream(input.mp4Path, signal);
  if (!signer) return { credentials: provenanceCredentials(mp4Sha256) };
  const sidecarPath = join(input.recordDirectory, PROVENANCE_SIDECAR_NAME);
  const signed = await signC2paSidecar(signer, input.mp4Path, sidecarPath,
    { spec: input.spec, issuer: PROVENANCE_ISSUER, projectId: input.projectId, assembledAt: input.signedAt ?? new Date().toISOString(), mp4Sha256 }, PROVENANCE_ISSUER, signal);
  return { credentials: provenanceCredentials(mp4Sha256, { name: PROVENANCE_SIDECAR_NAME, sha256: signed.sha256 }), sidecarPath };
}
