/**
 * HV-016-06 — an all-caps action line was a character with nothing to say.
 *
 * The cue test was the shape of the line and nothing else:
 *
 *     if (CHARACTER.test(t) && t.length <= 40 && !SCENE_HEADING.test(t))
 *
 * `CHARACTER` is `/^[A-Z][A-Z0-9 '().-]*$/`, so `SHE SLAMS THE DOOR.` passed it. Measured on this
 * repo's own parser, before:
 *
 *     INT. BAR - DAY / SHE SLAMS THE DOOR. / He flinches.
 *       action:    ["He flinches."]
 *       dialogue:  [{character: "SHE SLAMS THE DOOR.", lines: []}]
 *       beats:     ["dialogue", "action"]
 *       warnings 0, unparseable 0
 *
 * Two things at once, both silent. The writer's action line left the film — it is in neither
 * `action` nor the beats, so it never reaches a prompt — and a speaker who does not exist entered
 * it. That name is what the rest of the studio takes a character to be: `coverageReport` asks for
 * single or over-shoulder coverage of it by name, which is measured below, and casting, the
 * character sheets and the voice paths read the same field.
 *
 * Fountain's rule is one sentence and the parser had half of it: a Character is a line in uppercase
 * with an empty line *before* it and no empty line *after* it. A scene heading counts here as the
 * boundary a blank line is, because the parse loop already treats a heading that way — it clears
 * `pendingCharacter` — and this repo's own fixtures write a cue directly under a heading.
 */
import {expect, test} from "bun:test";
import {parseFountain} from "../src/index";
import {coverageReport} from "../../planner/src/coverage";

const shape = (text: string) => {
  const result = parseFountain(text);
  return {
    action: result.scenes.flatMap(scene => scene.action),
    dialogue: result.scenes.flatMap(scene => scene.dialogue),
    beats: result.scenes.flatMap(scene => scene.beats!.map(beat => beat.kind)),
    warnings: result.warnings.length,
    unparseable: result.unparseable.length,
  };
};

test("an all-caps action line stays in the film instead of becoming a character", () => {
  expect(shape("INT. BAR - DAY\n\nSHE SLAMS THE DOOR.\n\nHe flinches.")).toEqual({
    action: ["SHE SLAMS THE DOOR.", "He flinches."],
    dialogue: [], beats: ["action", "action"], warnings: 0, unparseable: 0,
  });
  // And in the middle of a scene, after a real speech, which is where a writer actually puts one.
  expect(shape("INT. BAR - DAY\n\nMAYA\nGet out.\n\nTHE DOOR SLAMS.\n\nSilence.")).toEqual({
    action: ["THE DOOR SLAMS.", "Silence."],
    dialogue: [{character: "MAYA", lines: ["Get out."]}],
    beats: ["dialogue", "action", "action"], warnings: 0, unparseable: 0,
  });
  // A caps line at the end of a scene has nothing after it at all, which is the same rule.
  expect(shape("INT. BAR - DAY\n\nHe waits.\n\nTHE LIGHTS GO OUT.").action).toEqual(["He waits.", "THE LIGHTS GO OUT."]);
});

test("and an all-caps line inside a run of action is action too", () => {
  // The other half of the rule. Nothing separates this line from the action above it, so it is not
  // a cue however it is capitalised -- and the line under it is not its dialogue.
  expect(shape("INT. BAR - DAY\n\nHe waits.\nSHE SLAMS THE DOOR.\nHe flinches.")).toEqual({
    action: ["He waits.", "SHE SLAMS THE DOOR.", "He flinches."],
    dialogue: [], beats: ["action", "action", "action"], warnings: 0, unparseable: 0,
  });
});

test("and a real cue is still a cue, in every way the parser already accepted one", () => {
  // The refusal must not have eaten the thing it guards. A cue under a blank line, a cue directly
  // under a heading (which this repo's fixtures write), a cue with a parenthetical extension, a cue
  // whose speech runs to several lines, and two speakers in a row.
  expect(shape("INT. BAR - DAY\n\nMAYA\nGet out.").dialogue).toEqual([{character: "MAYA", lines: ["Get out."]}]);
  expect(shape("INT. BAR - DAY\nMAYA\nGet out.").dialogue).toEqual([{character: "MAYA", lines: ["Get out."]}]);
  expect(shape(".A FORCED HEADING\nMAYA\nGet out.").dialogue).toEqual([{character: "MAYA", lines: ["Get out."]}]);
  expect(shape("INT. BAR - DAY\n\nMAYA (V.O.)\nGet out.").dialogue).toEqual([{character: "MAYA", lines: ["Get out."]}]);
  expect(shape("INT. BAR - DAY\n\nMAYA\nGet out.\nNow.").dialogue).toEqual([{character: "MAYA", lines: ["Get out.", "Now."]}]);
  expect(shape("INT. BAR - DAY\n\nMAYA\nGet out.\n\nSAM\nNo.").dialogue)
    .toEqual([{character: "MAYA", lines: ["Get out."]}, {character: "SAM", lines: ["No."]}]);
});

test("and a note between a cue and its speech still does not separate them", () => {
  // HV-016-05: a line that was nothing but a note is skipped rather than treated as blank, so it
  // does not end a speech. The new rule reads the same lines the loop acts on, or it would have
  // quietly undone that: the note is not the blank line after the cue, and not the one before it.
  expect(shape("INT. BAR - DAY\n\n[[check this]]\nMAYA\n[[and this]]\nGet out.").dialogue)
    .toEqual([{character: "MAYA", lines: ["Get out."]}]);
  // A boneyard spanning the lines between them is skipped the same way.
  expect(shape("INT. BAR - DAY\n\nMAYA\n/* cut\nstill cut */\nGet out.").dialogue)
    .toEqual([{character: "MAYA", lines: ["Get out."]}]);
  // But a genuinely blank line after the caps line still makes it action.
  expect(shape("INT. BAR - DAY\n\n[[check this]]\nSHE SLAMS THE DOOR.\n\nHe flinches.").dialogue).toEqual([]);
});

test("and the studio no longer asks for coverage of a door slamming", () => {
  // The consequence one package over, measured. `coverageReport` takes a scene's speakers straight
  // from `shot.dialogue` and raises a finding naming each one that has no single or over-shoulder
  // shot. Before, both of these came back:
  //   "No single or over-shoulder coverage is declared for MAYA."
  //   "No single or over-shoulder coverage is declared for THE DOOR SLAMS BEHIND HIM.."
  const scene = parseFountain("INT. BAR - DAY\n\nMAYA\nGet out.\n\nTHE DOOR SLAMS BEHIND HIM.\n\nShe exhales.").scenes[0]!;
  const shot = {id: "shot-1-10001", sceneIndex: 0, prompt: scene.action.join(" "), dialogue: scene.dialogue} as never;
  const findings = coverageReport([shot], {entries: []} as never).scenes
    .flatMap(value => value.findings).filter(finding => finding.code === "speaker-coverage-missing");
  expect(findings.map(finding => finding.message))
    .toEqual(["No single or over-shoulder coverage is declared for MAYA. Review whether this scene needs it."]);
});

test("and deciding the rule is two passes over the document, not a search per line", () => {
  // HV-016-04 made this parser linear in the document and proved it. A capitalised line asking "is
  // there a blank line after me" by scanning forward would be quadratic on a document of them,
  // which is exactly the document an attacker sends. Same assertion shape: eight times the
  // document, at most twenty-four times the work.
  const ms = (work: () => unknown) => {const started = Bun.nanoseconds(); work(); return (Bun.nanoseconds() - started) / 1e6;};
  for (const shape of ["CAPS LINE\n", "CAPS LINE\n[[note]]\n", "CAPS LINE\n\n"]) {
    const small = "INT. BAR - DAY\n\n" + shape.repeat(2_000);
    const large = "INT. BAR - DAY\n\n" + shape.repeat(16_000);
    parseFountain(small); parseFountain(large);
    const at2 = Math.min(...[0, 1, 2].map(() => ms(() => parseFountain(small))));
    const at16 = Math.min(...[0, 1, 2].map(() => ms(() => parseFountain(large))));
    const round = (value: number) => Number(value.toFixed(2));
    expect({shape, linear: at16 <= Math.max(at2, 1) * 24, at2: round(at2), at16: round(at16)})
      .toEqual({shape, linear: true, at2: round(at2), at16: round(at16)});
  }
});
