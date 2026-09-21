import { describe, expect, test } from "bun:test";
import { parseFountain } from "../../parser/src/index";
import { audioPolicy } from "../src/audio-jobs";
import { audioVoiceProfile } from "../src/audio-performances";
import { scriptIntroductions } from "../src/crew/introductions";
import { castVoices, CREW_VOICE_SPEED, VOICE_VENDOR_ORDER } from "../src/crew/voice-casting";
import { ELEVENLABS_DEFAULTS } from "../src/elevenlabs-performance";

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

// HV-022-09: the operator put ElevenLabs first and Azure behind it (G14). The crew casts from the
// first vendor that has an authorized voice for the part, and says which voice it cast.
const ROGER = "CwhRBWXzGAHq8TQ4Fs17", SARAH = "EXAVITQu4vr4xnSDxMaL";
const eleven = (voiceId: string, sex: "female" | "male") => audioPolicy({provider: "elevenlabs", voiceId, label: (sex === "female" ? "Sarah" : "Roger") + " (ElevenLabs)", sex,
  accountRevision: "1".repeat(64), catalogueRevision: "2".repeat(64), licenceEvidenceSha256: "3".repeat(64), priceEvidenceSha256: "4".repeat(64),
  heldUsd: 0.666667, maxCharacters: 10000, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z"});

describe("the crew casts from the operator's first vendor", () => {
  test("with both vendors authorized, the parts go to the first one", () => {
    expect(VOICE_VENDOR_ORDER).toEqual(["elevenlabs", "azure"]);
    const {assignments, notes} = castVoices([{id: "n", name: "NORA"}, {id: "t", name: "TEO"}], intros(LIGHTHOUSE, ["NORA", "TEO"]),
      [...ALL, eleven(SARAH, "female"), eleven(ROGER, "male")], now);
    expect(assignments.map(value => [value.name, value.voiceId])).toEqual([["NORA", SARAH], ["TEO", ROGER]]);
    // Its own voice contract, with the crew's brisker pace and the vendor's own settings.
    expect(assignments[0]!.profile).toEqual(audioVoiceProfile(assignments[0]!.profile));
    expect(assignments[0]!.profile.schema).toBe("hv-audio-voice/4");
    expect(assignments[0]!.profile.provider).toBe("elevenlabs");
    expect(assignments[0]!.profile.controls).toEqual({speed: CREW_VOICE_SPEED, volume: 1, emotion: "neutral", ...ELEVENLABS_DEFAULTS});
    expect(notes[0]!.change).toContain("Sarah (ElevenLabs)");
  });

  test("a part the first vendor cannot fill falls back to the next, and the rest still do not", () => {
    // Only a male voice is authorized at the first vendor, so the female part falls back to Azure.
    const {assignments} = castVoices([{id: "n", name: "NORA"}, {id: "t", name: "TEO"}], intros(LIGHTHOUSE, ["NORA", "TEO"]),
      [...ALL, eleven(ROGER, "male")], now);
    expect(assignments.map(value => [value.name, value.voiceId])).toEqual([["NORA", "en-US-JaneNeural"], ["TEO", ROGER]]);
    expect(assignments[0]!.profile.provider).toBe("azure");
    expect(assignments[1]!.profile.provider).toBe("elevenlabs");
  });

  test("with the first vendor unauthorized, nothing changes for the films already cast on Azure", () => {
    const {assignments} = castVoices([{id: "n", name: "NORA"}, {id: "t", name: "TEO"}], intros(LIGHTHOUSE, ["NORA", "TEO"]), ALL, now);
    expect(assignments.map(value => [value.name, value.voiceId])).toEqual([["NORA", "en-US-JaneNeural"], ["TEO", "en-US-GuyNeural"]]);
  });

  test("an expired ElevenLabs voice is not cast, and the part goes to a valid one", () => {
    const expired = audioPolicy({provider: "elevenlabs", voiceId: SARAH, label: "Sarah (ElevenLabs)", sex: "female",
      accountRevision: "1".repeat(64), catalogueRevision: "2".repeat(64), licenceEvidenceSha256: "3".repeat(64), priceEvidenceSha256: "4".repeat(64),
      heldUsd: 0.666667, maxCharacters: 10000, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2026-02-01T00:00:00.000Z"});
    const {assignments} = castVoices([{id: "n", name: "NORA"}], intros(LIGHTHOUSE, ["NORA"]), [...ALL, expired], now);
    expect(assignments.map(value => [value.name, value.voiceId])).toEqual([["NORA", "en-US-JaneNeural"]]);
  });
});
