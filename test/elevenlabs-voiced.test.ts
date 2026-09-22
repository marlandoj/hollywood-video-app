import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ELEVENLABS_AUDIO_CAPABILITY, ELEVENLABS_MAX_LINE_CHARACTERS, ELEVENLABS_OUTPUT_FORMAT, ELEVENLABS_VOICE_ID } from "../packages/generator/src/elevenlabs-capability";
import { AUDIO_SAMPLE_RATE } from "../packages/generator/src/audio-capabilities";
import { DEFAULT_VOICE_VENDOR_CAP_USD, VOICE_VENDOR_ALERTS_USD } from "../packages/operator/src/voice-vendor-budget";
import { elevenLabsTakeHoldUsd } from "../packages/generator/src/elevenlabs-policy-catalogue";

/**
 * HV-022-11: the first film voiced by the operator's second vendor, read from the record made on
 * private staging. Six increments built the vendor against fixtures and none of them had spoken a
 * word; two of the three attempts recorded here found real defects that no fixture could, because a
 * fixture builds its request the way the contract says to.
 *
 * This holds the record to the increment's criteria. The numbers are re-derived from the contract
 * wherever the contract can produce them, so the record cannot drift from the code that made it.
 */
const REPO = resolve(import.meta.dir, "..");
const run = JSON.parse(readFileSync(resolve(REPO, "docs/evidence/release-2/elevenlabs-voiced.json"), "utf8"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("the crew cast the first vendor for every part, matching each part's stated sex", () => {
  expect(run.schema).toBe("hv-live-proof/1");
  expect(run.increment).toBe("HV-022-11");
  expect(run.driver).toContain("createStudioFlow");
  expect(run.crew.azureCast).toBe(0);
  const byId = new Map<string, {sex: string; label: string}>(run.voiceCatalogue.voices.map((v: any) => [v.id, v]));
  const cast = Object.entries<any>(run.crew.voices);
  expect(cast.length).toBeGreaterThanOrEqual(3);
  for (const [part, entry] of cast) {
    // Authorized by the operator's own catalogue, in the service's own id shape.
    expect(ELEVENLABS_VOICE_ID.test(entry.voiceId)).toBe(true);
    const voice = byId.get(entry.voiceId);
    expect({part, authorized: Boolean(voice)}).toEqual({part, authorized: true});
    // The part's stated sex is the voice's stated sex; nothing is inferred from a name.
    expect({part, sex: voice!.sex}).toEqual({part, sex: entry.sex});
    expect(voice!.label).toContain(entry.label);
  }
  // A female part cast female and a male part cast male is only evidence if both appear.
  expect(new Set(cast.map(([, entry]) => entry.sex)).size).toBeGreaterThan(1);
});

test("every take came back on the vendor's own contract and was delivered at the studio's rate", () => {
  expect(run.voicing.provider).toBe("elevenlabs");
  expect(run.voicing.schema).toBe("hv-audio-voice/4");
  expect(run.voicing.failed).toBe(0);
  expect(run.voicing.takes).toBe(run.voicing.lines);
  // What was asked for and what was delivered both come from the contract, not the record.
  expect(run.voicing.outputFormatRequested).toBe(ELEVENLABS_OUTPUT_FORMAT);
  expect(run.voicing.deliveredSampleRate).toBe(AUDIO_SAMPLE_RATE);
  expect(run.voicing.conversion).toBe(ELEVENLABS_AUDIO_CAPABILITY.output.conversion);
  expect(run.voicing.detail).toHaveLength(run.voicing.takes);
  const hold = elevenLabsTakeHoldUsd(run.voiceCatalogue.planUsdPerPeriod, run.voiceCatalogue.characterLimit, ELEVENLABS_MAX_LINE_CHARACTERS);
  for (const take of run.voicing.detail) {
    expect(take.jobId).toMatch(UUID);
    // The hold is the plan's own arithmetic, re-derived here rather than trusted.
    expect(take.heldUsd).toBeCloseTo(hold, 6);
    expect(take.seconds).toBeGreaterThan(0);
    expect(Object.keys(run.crew.voices)).toContain(take.character);
  }
  expect(run.voiceCatalogue.holdPerTakeUsd).toBeCloseTo(hold, 6);
});

test("the vendor's own line carried the run, under its alerts, and the picture spent nothing", () => {
  const line = run.spend.elevenLabsLine;
  expect(line.capUsd).toBe(DEFAULT_VOICE_VENDOR_CAP_USD);
  expect(line.alertsUsd).toEqual([...VOICE_VENDOR_ALERTS_USD]);
  expect(line.heldUsd).toBeLessThan(line.capUsd);
  expect(line.heldUsd).toBeLessThan(Math.min(...VOICE_VENDOR_ALERTS_USD));
  // The picture was mock, so the month's generation spend cannot have moved.
  expect(run.spend.generationUsd).toBe(0);
  expect(run.spend.ledgerAfter.spentUsd).toBe(run.spend.ledgerBefore.spentUsd);
  // Every take's hold is accounted for in the line, the failures from attempt 2 included.
  expect(line.takesHeld * run.voiceCatalogue.holdPerTakeUsd).toBeCloseTo(line.heldUsd, 5);
  // The declared ceiling held: what the vendor actually billed is far under it.
  const billed = run.spend.providerBilled;
  expect(billed.provider).toBe("elevenlabs");
  expect(billed.charactersBilled).toBe(billed.charactersAfter - billed.charactersBefore);
  expect(billed.approxUsd).toBeLessThan(run.spend.declaredCeilingUsd);
  expect(billed.approxUsd).toBeCloseTo(billed.charactersBilled * run.voiceCatalogue.planUsdPerPeriod / run.voiceCatalogue.characterLimit, 3);
});

test("the film finished, plays with the vendor's reads, and says nothing was skipped", () => {
  expect(run.film.projectId).toMatch(UUID);
  expect(run.film.finishNotes).toEqual([]);
  expect(run.film.jobs.every((job: any) => job.status === "done")).toBe(true);
  expect(run.film.jobs.filter((job: any) => job.stage === "audio-take")).toHaveLength(run.voicing.takes);
  // The reads reached the film: a dialogue replacement is what lays them over the final.
  expect(run.film.jobs.some((job: any) => job.stage === "dialogue-replacement")).toBe(true);
  const out = run.film.output;
  expect(out.sampleRate).toBe(AUDIO_SAMPLE_RATE);
  expect(out.audio).toBe("aac");
  expect(out.durationSec).toBeGreaterThan(0);
  expect(out.bytes).toBeGreaterThan(0);
  // Audible, and not clipped: the range Release 1 recorded for a finished film.
  expect(out.meanVolumeDb).toBeLessThan(-12);
  expect(out.meanVolumeDb).toBeGreaterThan(-45);
  expect(out.maxVolumeDb).toBeLessThan(0);
});

test("the two attempts this vendor cost are recorded with what fixed them, and neither spent anything", () => {
  const attempts: any[] = run.attempts;
  expect(attempts).toHaveLength(3);
  const failed = attempts.filter(attempt => attempt.outcome !== "completed");
  expect(failed).toHaveLength(2);
  for (const attempt of failed) {
    expect(attempt.reason.length).toBeGreaterThan(40);
    expect(attempt.fixedBy).toMatch(/^HV-022-1[02] \(PR #15[89]\)/);
    expect(attempt.spentUsd).toBe(0);
  }
  expect(attempts.at(-1)!.outcome).toBe("completed");
  // The gaps this proof leaves are stated, not implied by silence.
  expect(run.knownGaps.length).toBeGreaterThanOrEqual(3);
  expect(run.knownGaps.join(" ")).toContain("settle");
  expect(run.findings.length).toBeGreaterThanOrEqual(3);
});
