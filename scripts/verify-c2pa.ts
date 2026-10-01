/**
 * HV-031-15: verify one export's signed C2PA sidecar, the way a person checking a contested film would.
 *
 *   bun scripts/verify-c2pa.ts <export directory> [--anchor <root certificate PEM>]
 *
 * The directory holds `export.mp4`, `provenance.json` and `provenance.c2pa`. The check:
 *   1. the record says it is signed and names the sidecar's exact bytes;
 *   2. a C2PA reader finds the sidecar intact and bound to the MP4's own bytes;
 *   3. the signed assertion names the MP4's sha256, and so does the record's claim.
 *
 * Without `--anchor` the signer is unrecognized and the expected result is `Valid` with
 * `signingCredential.untrusted` and nothing else, which is what public validators show for the
 * self-issued staging key (G15 item 4). With the host's own certificate as anchor it is `Trusted`.
 * It prints one JSON line and exits 0 when every check holds, 1 otherwise. It reads no key.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyC2paSidecar, type C2paVerification } from "../packages/assembler/src/c2pa";
import { PROVENANCE_SIDECAR_NAME, PROVENANCE_SIGNED_CREDENTIAL_TYPE, provenanceClaim } from "../packages/planner/src/provenance";

export interface ExportC2paReport { ok: boolean; state: C2paVerification["state"]; codes: string[]; signer: C2paVerification["signer"]; problems: string[] }

export async function verifyExportC2pa(directory: string, anchorPem?: string): Promise<ExportC2paReport> {
  const mp4 = join(directory, "export.mp4"), problems: string[] = [];
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const record = JSON.parse(readFileSync(join(directory, "provenance.json"), "utf8")) as { credentials?: { type?: string; claim?: string; sidecar?: { name?: string; sha256?: string } } };
  const sidecar = readFileSync(join(directory, PROVENANCE_SIDECAR_NAME)), mp4Sha256 = digest(readFileSync(mp4));
  if (record.credentials?.type !== PROVENANCE_SIGNED_CREDENTIAL_TYPE) problems.push("The record does not say the export is signed.");
  if (record.credentials?.sidecar?.name !== PROVENANCE_SIDECAR_NAME || record.credentials.sidecar.sha256 !== digest(sidecar)) problems.push("The record does not name this sidecar's bytes.");
  if (record.credentials?.claim !== provenanceClaim(mp4Sha256)) problems.push("The record's claim is not bound to this MP4.");
  const verified = await verifyC2paSidecar(mp4, sidecar, anchorPem);
  if (verified.state === "Invalid") problems.push("The C2PA manifest is not intact or not bound to this MP4.");
  const expectedCodes = verified.state === "Trusted" ? [] : ["signingCredential.untrusted"];
  if (verified.codes.join(",") !== expectedCodes.join(",")) problems.push("Unexpected C2PA status codes: " + verified.codes.join(", "));
  if (verified.provenance?.mp4Sha256 !== mp4Sha256) problems.push("The signed assertion does not name this MP4's sha256.");
  return { ok: problems.length === 0, state: verified.state, codes: verified.codes, signer: verified.signer, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2), anchorAt = args.indexOf("--anchor");
  const anchor = anchorAt >= 0 ? readFileSync(args[anchorAt + 1]!, "utf8") : undefined, directory = args.find((_, i) => anchorAt < 0 || (i !== anchorAt && i !== anchorAt + 1));
  if (!directory) {console.error("usage: bun scripts/verify-c2pa.ts <export directory> [--anchor <root certificate PEM>]");process.exit(2);}
  const report = await verifyExportC2pa(directory, anchor);
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}
