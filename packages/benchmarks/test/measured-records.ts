import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_METRIC, scoreShotIdentity, shotCharacters } from "../src/identity";
import { aggregateOf, corpusShots, MEASURED_FIXTURE_VERSION, MEASURED_FRAME_SIZE, MEASURED_SCHEMA, type MeasuredRecord, type MeasuredShot } from "../src/measured";

/**
 * Test-only `hv-benchmark-measured/1` records for the routing tests (HV-019-14). Nothing here was
 * rendered: each record is built over the frozen corpus with a chosen frame fingerprint, and every
 * score in it is computed by the benchmark's own `scoreShotIdentity` and `aggregateOf`, so it passes
 * `readMeasuredRecord` exactly as a measured file would. `flips` is how many of the 256 hash bits the
 * frame disagrees with KEEPER's reference on, so the identity mean is exactly `1 - flips / 256`.
 */
export const KEEPER_REFERENCE = "0123456789abcdef".repeat(4);

function flipped(fingerprint: string, flips: number): string {
  const bits = [...fingerprint].flatMap(digit => parseInt(digit, 16).toString(2).padStart(4, "0").split(""));
  for (let index = 0; index < flips; index++) bits[index] = bits[index] === "1" ? "0" : "1";
  let hex = "";
  for (let index = 0; index < bits.length; index += 4) hex += parseInt(bits.slice(index, index + 4).join(""), 2).toString(16);
  return hex;
}

export interface RecordFor { spec: string; provider: string; model: string; capabilityRevision: string }

export function measuredRecord(target: RecordFor, flips: number, options: { synthetic?: boolean; scored?: boolean } = {}): MeasuredRecord {
  const { shots, fixtureSha256 } = corpusShots(), references = { KEEPER: KEEPER_REFERENCE }, frame = flipped(KEEPER_REFERENCE, flips);
  const measured: MeasuredShot[] = shots.map(shot => {
    const characters = shotCharacters(shot, Object.keys(references));
    const base = { shotId: shot.id, sceneIndex: shot.sceneIndex, characters, referencesSent: 0, estimateUsd: 0.35 };
    if (options.scored === false) return { ...base, status: "skipped", reason: "ineligible: references", costUsd: 0, identity: [], identityScore: null };
    const scored = scoreShotIdentity(frame, characters, references);
    return { ...base, status: "rendered", costUsd: 0.35, latencyMs: 1000, clipSha256: createHash("sha256").update(shot.id).digest("hex"),
      frameAtSec: shot.durationSec / 2, frameFingerprint: frame, flatFrame: scored.flatFrame, identity: scored.identity, identityScore: scored.identityScore };
  });
  return {
    schema: MEASURED_SCHEMA, metric: IDENTITY_METRIC, fixtureVersion: MEASURED_FIXTURE_VERSION, fixtureSha256,
    providerSpec: target.spec, provider: target.provider, model: target.model, capabilityRevision: target.capabilityRevision, synthetic: options.synthetic ?? false,
    increment: "HV-019-14-test-fixture", declaredUsd: 0, frameSize: MEASURED_FRAME_SIZE,
    references: [{ character: "KEEPER", sha256: "ab".repeat(32), fingerprint: KEEPER_REFERENCE, flat: false }],
    shots: measured, aggregate: aggregateOf(measured), recordedAt: "2026-10-04T00:00:00.000Z",
  };
}

/** A temporary results file; returns its path and the sha256 of its bytes. */
export function resultsFile(records: unknown): { path: string; sha256: string } {
  const text = JSON.stringify(records, null, 2) + "\n", path = join(mkdtempSync(join(tmpdir(), "hv-routing-results-")), "results.json");
  writeFileSync(path, text);
  return { path, sha256: createHash("sha256").update(text).digest("hex") };
}
