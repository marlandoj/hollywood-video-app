/**
 * HV-031-15 — every export carries a signed C2PA manifest beside it, when the host holds the key.
 *
 * Before this, `provenance.json` was JSON in C2PA's shape, unsigned, and said so (`c2pa-style`). The
 * operator approved a self-issued ES256 key on the staging host (G15 item 4). These tests sign real
 * ffmpeg exports with a throwaway identity generated at test time, and read the result back with the
 * same C2PA reader any validator uses.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicMockProvider, type VideoClip } from "../../generator/src/index";
import type { Shot } from "../../planner/src/index";
import { PROVENANCE_SIDECAR_NAME, provenanceClaim, provenanceCredentials, provenanceMatches } from "../../planner/src/provenance";
import { C2paError, c2paSigningFromEnv, verifyC2paSidecar } from "../src/c2pa";
import { assemble } from "../src/index";
import { makeC2paTestIdentity, withC2paEnv, type C2paTestIdentity } from "./c2pa-fixture";

const TMP = mkdtempSync(join(tmpdir(), "hv-c2pa-"));
const AT = "2026-10-01T09:00:00.000Z";
const shots: Shot[] = [{ id: "shot-1-1", sceneIndex: 0, prompt: "INT. KITCHEN - DAY. Kettle.", dialogue: [], durationSec: 1, seed: 1 }];
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
let id: C2paTestIdentity, clips: VideoClip[];

beforeAll(async () => {
  id = makeC2paTestIdentity(join(TMP, "identity"));
  clips = [await new DeterministicMockProvider().generate(shots[0]!.prompt, 1, { seed: 1, durationSec: 1 }, join(TMP, "clips", "shot-1-1.mp4"))];
}, 60000);

const signed = (dir: string) => assemble(clips, shots, join(TMP, dir), { assembledAt: AT, projectId: "project-c2pa", size: "320x180", c2pa: { keyPath: id.keyPath, certPath: id.chainPath } });

describe("a host with a signing key", () => {
  /** The sidecar is real C2PA, chains to the root it was issued from, and the record names its bytes. */
  test("signs the export with a sidecar that a C2PA reader trusts when given the issuing root", async () => {
    const result = signed("signed");
    expect(result.c2paPath).toBe(join(TMP, "signed", PROVENANCE_SIDECAR_NAME));
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.credentials).toEqual({ type: "c2pa-sidecar", issuer: "hollywood-video-app", claim: provenanceClaim(result.sha256),
      sidecar: { name: "provenance.c2pa", sha256: sha(result.c2paPath!) } });
    expect(provenanceMatches(manifest, { projectId: "project-c2pa", sha256: result.sha256 })).toBe(true);
    const verified = await verifyC2paSidecar(result.mp4Path, readFileSync(result.c2paPath!), id.anchorPem);
    expect(verified.state).toBe("Trusted");
    expect(verified.codes).toEqual([]);
    expect(verified.signer).toEqual({ commonName: "Rough Cut test signer", issuer: "Rough Cut test", alg: "Es256" });
    // The signed assertion is bound to this export's own bytes and record.
    expect(verified.provenance).toEqual({ spec: "hv-provenance/1.0", issuer: "hollywood-video-app", projectId: "project-c2pa", assembledAt: AT, mp4Sha256: result.sha256 });
  }, 60000);

  /** What a public validator shows for the self-issued key: intact, signer unrecognized. */
  test("reads as valid with an untrusted signer when no anchor is supplied, and nothing else is wrong", async () => {
    const result = signed("untrusted");
    const verified = await verifyC2paSidecar(result.mp4Path, readFileSync(result.c2paPath!));
    expect(verified.state).toBe("Valid");
    expect(verified.codes).toEqual(["signingCredential.untrusted"]);
  }, 60000);

  /** A sidecar leaves the MP4 byte-identical to the unsigned export, so every sha256 comparison still holds. */
  test("leaves the MP4 byte for byte the same as an unsigned export of the same inputs", () => {
    const signedResult = signed("same-signed");
    const unsigned = assemble(clips, shots, join(TMP, "same-unsigned"), { assembledAt: AT, projectId: "project-c2pa", size: "320x180", c2pa: null });
    expect(signedResult.sha256).toBe(unsigned.sha256);
    expect(sha(signedResult.mp4Path)).toBe(signedResult.sha256);
  }, 60000);

  /** The signature binds the film's own bytes through C2PA's BMFF hash. */
  test("a single changed byte in the film fails the sidecar's hash binding", async () => {
    const result = signed("tamper");
    const tampered = join(TMP, "tamper", "tampered.mp4");
    copyFileSync(result.mp4Path, tampered);
    const bytes = readFileSync(tampered), at = bytes.indexOf("mdat") + 200;
    bytes[at] = bytes[at]! ^ 0xff;writeFileSync(tampered, bytes);
    const verified = await verifyC2paSidecar(tampered, readFileSync(result.c2paPath!), id.anchorPem);
    expect(verified.state).toBe("Invalid");
    expect(verified.codes).toContain("assertion.bmffHash.mismatch");
  }, 60000);

  /** The production path reads the two paths from the environment the operator sets. */
  test("signs from HV_C2PA_SIGNING_KEY and HV_C2PA_SIGNING_CERT when the caller passes nothing", async () => {
    const result = await withC2paEnv({ key: id.keyPath, cert: id.chainPath }, () =>
      assemble(clips, shots, join(TMP, "from-env"), { assembledAt: AT, projectId: "project-c2pa", size: "320x180" }));
    expect(existsSync(result.c2paPath!)).toBe(true);
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).credentials.type).toBe("c2pa-sidecar");
  }, 60000);
});

describe("the operator's verification script", () => {
  const script = join(import.meta.dir, "..", "..", "..", "scripts", "verify-c2pa.ts");
  const run = (...args: string[]) => {const p = Bun.spawnSync(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });return { code: p.exitCode, report: JSON.parse(p.stdout.toString() || "null") };};

  /** It passes a signed export as Trusted with the root and as Valid/untrusted without, and fails a tampered one. */
  test("passes a signed export with or without the anchor, and fails one whose film changed", () => {
    const result = signed("script");
    const anchor = join(id.dir, "ca.pem");
    expect(run(join(TMP, "script"), "--anchor", anchor)).toEqual({ code: 0, report: { ok: true, state: "Trusted", codes: [], signer: { commonName: "Rough Cut test signer", issuer: "Rough Cut test", alg: "Es256" }, problems: [] } });
    expect(run(join(TMP, "script"))).toMatchObject({ code: 0, report: { ok: true, state: "Valid", codes: ["signingCredential.untrusted"] } });
    const bytes = readFileSync(result.mp4Path), at = bytes.indexOf("mdat") + 200;
    bytes[at] = bytes[at]! ^ 0xff;writeFileSync(result.mp4Path, bytes);
    const failed = run(join(TMP, "script"), "--anchor", anchor);
    expect(failed.code).toBe(1);
    expect(failed.report.state).toBe("Invalid");
    expect(failed.report.problems).toContain("The record's claim is not bound to this MP4.");
    expect(failed.report.problems).toContain("The C2PA manifest is not intact or not bound to this MP4.");
  }, 60000);
});

describe("a host without one, or with a wrong one", () => {
  /** No key, no sidecar, and the record says unsigned by its existing name. */
  test("writes no sidecar and keeps the unsigned c2pa-style record when neither variable is set", async () => {
    const result = await withC2paEnv({}, () => assemble(clips, shots, join(TMP, "no-env"), { assembledAt: AT, projectId: "project-c2pa", size: "320x180" }));
    expect(Object.hasOwn(result, "c2paPath")).toBe(false);
    expect(existsSync(join(TMP, "no-env", PROVENANCE_SIDECAR_NAME))).toBe(false);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
    expect(manifest.credentials).toEqual(provenanceCredentials(result.sha256));
    expect(manifest.credentials.type).toBe("c2pa-style");
  }, 60000);

  /** A half-configured host refuses rather than shipping unsigned films it believes are signed. */
  test("refuses when only one of the two variables is set", () => {
    expect(c2paSigningFromEnv({})).toBeNull();
    expect(() => c2paSigningFromEnv({ HV_C2PA_SIGNING_KEY: id.keyPath })).toThrow("Set both HV_C2PA_SIGNING_KEY and HV_C2PA_SIGNING_CERT, or neither.");
    expect(() => c2paSigningFromEnv({ HV_C2PA_SIGNING_CERT: id.chainPath })).toThrow(C2paError);
  });

  /** C2PA refuses a leaf without a signing EKU; the export refuses before encoding, naming the fix. */
  test("a certificate without a C2PA extended key usage refuses before any media is encoded", () => {
    const dir = join(TMP, "no-eku");
    expect(() => assemble(clips, shots, dir, { assembledAt: AT, projectId: "project-c2pa", size: "320x180", c2pa: { keyPath: id.keyPath, certPath: id.noEkuChainPath } }))
      .toThrow("needs an extended key usage C2PA accepts, such as documentSigning (1.3.6.1.5.5.7.3.36); it has none");
    expect(existsSync(join(dir, "export.mp4"))).toBe(false);
  });

  /** A certificate for some other key is refused, and so is a key file that is not a key. */
  test("a certificate that is not the key's, or a key file that is not a key, refuses clearly", () => {
    const other = makeC2paTestIdentity(join(TMP, "other-identity"));
    expect(() => assemble(clips, shots, join(TMP, "mismatch"), { assembledAt: AT, projectId: "project-c2pa", c2pa: { keyPath: id.keyPath, certPath: other.chainPath } }))
      .toThrow("The C2PA certificate's first entry is not the signing key's certificate.");
    expect(() => assemble(clips, shots, join(TMP, "not-a-key"), { assembledAt: AT, projectId: "project-c2pa", c2pa: { keyPath: id.chainPath, certPath: id.chainPath } }))
      .toThrow("The C2PA signing key at HV_C2PA_SIGNING_KEY is unreadable or not a private key.");
  }, 60000);
});
