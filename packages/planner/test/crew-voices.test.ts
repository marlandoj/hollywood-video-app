import { describe, expect, test } from "bun:test";
import { parseFountain } from "../../parser/src/index";
import { audioPolicy } from "../src/audio-jobs";
import { audioVoiceProfile } from "../src/audio-performances";
import { scriptIntroductions } from "../src/crew/introductions";
import { castVoices, CREW_VOICE_SPEED } from "../src/crew/voice-casting";

// HV-022-02: the Sound persona casts a production voice per speaking character. Synthetic
// policies only: never an active catalogue, licence or price.
const policy = (voiceId: string, overrides: Record<string, unknown> = {}) => audioPolicy({provider: "azure", voiceId, label: voiceId.slice(6, -6) + " (fixture)",
  accountRevision: "5".repeat(64), catalogueRevision: "6".repeat(64), licenceEvidenceSha256: "7".repeat(64), priceEvidenceSha256: "8".repeat(64),
  heldUsd: 0.0225, maxCharacters: 1500, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", ...overrides});
const ALL = [policy("en-US-JaneNeural"), policy("en-US-GuyNeural"), policy("en-US-DavisNeural")];
const LIGHTHOUSE = "INT. LIGHTHOUSE - NIGHT\n\nNORA, the old keeper, trims the wick.\n\nNORA\nOne more night.\n\nEXT. CLIFF - DAWN\n\nHer grandson TEO climbs.\n\nTEO\nGrandma! You kept it burning!\n\nNORA\nAlways.";
const intros = (script: string, names: string[]) => scriptIntroductions(parseFountain(script), names);
const now = Date.parse("2026-09-20T02:00:00.000Z");

describe("the crew casts voices", () => {
  test("the lighthouse: NORA gets the female voice, TEO a male one, with the crew's pace", () => {
    const {assignments, notes} = castVoices([{id: "n", name: "NORA"}, {id: "t", name: "TEO"}], intros(LIGHTHOUSE, ["NORA", "TEO"]), ALL, now);
    expect(assignments.map(value => [value.name, value.voiceId])).toEqual([["NORA", "en-US-JaneNeural"], ["TEO", "en-US-GuyNeural"]]);
    expect(assignments[0]!.profile).toEqual(audioVoiceProfile(assignments[0]!.profile));
    expect(assignments[0]!.profile.controls).toMatchObject({speed: CREW_VOICE_SPEED, style: "neutral", intensity: 1});
    expect(assignments[0]!.policyRevision).toBe(ALL[0]!.revision);
    expect(notes[0]).toEqual({persona: "sound", change: "Cast voices: NORA (Jane (fixture)), TEO (Guy (fixture))."});
  });

  test("voices are shared out evenly and deterministically; unknown sex may take any voice", () => {
    const script = "INT. ROOM - DAY\n\nA man, AL, sits. A man, BO, stands. A man, CY, waits. DEE waves.";
    const cast = () => castVoices(["AL", "BO", "CY", "DEE"].map(name => ({id: name, name})), intros(script, ["AL", "BO", "CY", "DEE"]), ALL, now).assignments.map(value => value.voiceId);
    expect(cast()).toEqual(["en-US-GuyNeural", "en-US-DavisNeural", "en-US-GuyNeural", "en-US-JaneNeural"]);
    expect(cast()).toEqual(cast());
  });

  test("the creator's voice is kept and counted; a real person never gets a synthetic voice", () => {
    const own = {id: "t", name: "TEO", audioVoice: castVoices([{id: "x", name: "X"}], [], [ALL[1]!], now).assignments[0]!.profile};
    const {assignments} = castVoices([own, {id: "k", name: "KEVIN", kind: "consented-real-person"}, {id: "m", name: "MAX"}],
      intros("INT. ROOM - DAY\n\nA man, MAX, waits. KEVIN waves.", ["TEO", "KEVIN", "MAX"]), ALL, now);
    expect(assignments.map(value => [value.name, value.voiceId])).toEqual([["MAX", "en-US-DavisNeural"]]);
  });

  test("no authorized voice of the stated sex keeps the temporary voice, and the crew says so", () => {
    const {assignments, notes} = castVoices([{id: "n", name: "NORA"}], intros(LIGHTHOUSE, ["NORA", "TEO"]), [ALL[1]!, ALL[2]!], now);
    expect(assignments).toEqual([]);
    expect(notes).toEqual([{persona: "sound", change: "No authorized female voice is available, so NORA keeps the temporary voice."}]);
  });

  test("a child is voiced by an adult voice, and the crew says so", () => {
    const {notes} = castVoices([{id: "b", name: "BEN"}], intros("INT. ROOM - DAY\n\nThe little boy, BEN, laughs.", ["BEN"]), ALL, now);
    expect(notes.at(-1)!.change).toBe("BEN is a child, and every authorized voice is an adult's; Guy (fixture) reads the part.");
  });

  test("expired, not-yet-valid and non-Azure policies are never cast; with none, nothing is said", () => {
    const expired = policy("en-US-JaneNeural", {validFrom: "2025-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z"});
    const later = policy("en-US-GuyNeural", {validFrom: "2027-01-01T00:00:00.000Z"});
    expect(castVoices([{id: "n", name: "NORA"}, {id: "t", name: "TEO"}], intros(LIGHTHOUSE, ["NORA", "TEO"]), [expired, later], now)).toEqual({assignments: [], notes: []});
    expect(castVoices([{id: "n", name: "NORA"}], [], [], now)).toEqual({assignments: [], notes: []});
  });
});
