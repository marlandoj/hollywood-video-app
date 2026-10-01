/**
 * HV-031-17 — the credentials of an export another stage wrote: the picture edit, the assembly, a
 * sound mix, a dialogue or lip-sync version. `exportCredentials` is the one call each of those
 * stages makes; these tests hold it to the same signer and the same honesty as the assembler's own
 * export (HV-031-15), on a real ffmpeg MP4 and a throwaway identity generated at test time.
 */
import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicMockProvider, type VideoClip } from "../../generator/src/index";
import type { Shot } from "../../planner/src/index";
import { exportCredentialsProblem, provenanceClaim } from "../../planner/src/provenance";
import { verifyC2paSidecar } from "../src/c2pa";
import { exportC2paSigner, exportCredentials } from "../src/export-credentials";
import { assemble } from "../src/index";
import { makeC2paTestIdentity, withC2paEnv, type C2paTestIdentity } from "./c2pa-fixture";

const TMP = mkdtempSync(join(tmpdir(), "hv-export-credentials-"));
const shots: Shot[] = [{ id: "shot-1-1", sceneIndex: 0, prompt: "INT. KITCHEN - DAY. Kettle.", dialogue: [], durationSec: 1, seed: 1 }];
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
let id: C2paTestIdentity, mp4: string;

beforeAll(async () => {
  id = makeC2paTestIdentity(join(TMP, "identity"));
  const clips: VideoClip[] = [await new DeterministicMockProvider().generate(shots[0]!.prompt, 1, { seed: 1, durationSec: 1 }, join(TMP, "clips", "shot-1-1.mp4"))];
  mp4 = assemble(clips, shots, join(TMP, "film"), { assembledAt: "2026-10-01T09:00:00.000Z", projectId: "project-1", size: "320x180", c2pa: null }).mp4Path;
}, 60000);

function recordDirectory(name: string): string {const dir = join(TMP, name);mkdirSync(dir, { recursive: true });return dir;}

/** With the host's key, a stage's export is signed beside its record and the credentials name the sidecar's bytes. */
test("a stage's export is signed beside its own record with the host's key, and the sidecar reads Trusted", async () => {
  const dir = recordDirectory("signed"), signer = exportC2paSigner({ keyPath: id.keyPath, certPath: id.chainPath });
  const result = await exportCredentials(signer, { mp4Path: mp4, recordDirectory: dir, spec: "hv-edit-result/1", projectId: "project-1", signedAt: "2026-10-01T10:00:00.000Z" });
  expect(result.sidecarPath).toBe(join(dir, "provenance.c2pa"));
  expect(result.credentials).toEqual({ type: "c2pa-sidecar", issuer: "hollywood-video-app", claim: provenanceClaim(sha(mp4)), sidecar: { name: "provenance.c2pa", sha256: sha(result.sidecarPath!) } });
  expect(exportCredentialsProblem(result.credentials, sha(mp4), { sha256: sha(result.sidecarPath!) })).toBeNull();
  const verified = await verifyC2paSidecar(mp4, readFileSync(result.sidecarPath!), id.anchorPem);
  expect({ state: verified.state, codes: verified.codes }).toEqual({ state: "Trusted", codes: [] });
  expect(verified.provenance).toEqual({ spec: "hv-edit-result/1", issuer: "hollywood-video-app", projectId: "project-1", assembledAt: "2026-10-01T10:00:00.000Z", mp4Sha256: sha(mp4) });
}, 60000);

/** The production path reads the two host variables; with neither set nothing is signed and nothing is written. */
test("the signer comes from the host's two variables, and without them the credentials say unsigned and no sidecar is written", async () => {
  expect(await withC2paEnv({ key: id.keyPath, cert: id.chainPath }, () => exportC2paSigner()?.subject)).toContain("Rough Cut test signer");
  const dir = recordDirectory("unsigned"), signer = await withC2paEnv({}, () => exportC2paSigner());
  expect(signer).toBeNull();
  const result = await exportCredentials(signer, { mp4Path: mp4, recordDirectory: dir, spec: "hv-edit-result/1", projectId: "project-1" });
  expect(result).toEqual({ credentials: { type: "c2pa-style", issuer: "hollywood-video-app", claim: provenanceClaim(sha(mp4)) } });
  expect(readdirSync(dir)).toEqual([]);
  // A half-set host and an EKU-less certificate refuse, so a stage refuses before it encodes anything.
  await expect(withC2paEnv({ key: id.keyPath }, () => exportC2paSigner())).rejects.toThrow("Set both");
  await expect(withC2paEnv({ key: id.keyPath, cert: id.noEkuChainPath }, () => exportC2paSigner())).rejects.toThrow("documentSigning");
}, 60000);

/** Signing runs off the event loop under the job's signal: a cancelled job stops and leaves no sidecar. */
test("a cancelled stage writes no sidecar", async () => {
  const dir = recordDirectory("cancelled"), signer = exportC2paSigner({ keyPath: id.keyPath, certPath: id.chainPath }), abort = new AbortController();
  abort.abort(new Error("job cancelled"));
  await expect(exportCredentials(signer, { mp4Path: mp4, recordDirectory: dir, spec: "hv-edit-result/1", projectId: "project-1" }, abort.signal)).rejects.toThrow("job cancelled");
  expect(existsSync(join(dir, "provenance.c2pa"))).toBe(false);
}, 60000);
