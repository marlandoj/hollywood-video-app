/**
 * HV-016-19 — a character cue with a lowercase extension, a typographic apostrophe, an accented
 * capital, a dual-dialogue caret or a forcing `@` was not a cue, and its speech became action.
 *
 * The cue test was one pattern over the whole line:
 *
 *     const CHARACTER = /^[A-Z][A-Z0-9 '().-]*$/;
 *     if (CHARACTER.test(t) && t.length <= 40 && !SCENE_HEADING.test(t) && speechAfter[i] && openBefore[i]) {
 *
 * So each of these failed it, and the cue and every line spoken under it were filed as action:
 *
 * - `HANS (on the radio)` -- the Fountain spec's own example of an extension, which is written in
 *   any case;
 * - `MAYA (CONT’D)` and `O’BRIEN` -- the typographic apostrophe every word processor types;
 * - `JOSÉ` -- a capital outside A to Z;
 * - `STEEL ^` -- Fountain's mark for the second speaker of dual dialogue;
 * - `@McCLANE` -- Fountain's forced cue, for a name that is not all capitals.
 *
 * The speech was then not a speech. It was not voiced, not captioned and not in the dialogue coverage
 * asks, and it became an extra shot whose prompt read the line aloud as scene description --
 * `STEEL ^` put a caret in the prompt.
 *
 * The name and the extension are now tested separately: the name is capitals in any script (with
 * digits, spaces and `'’().-`), the trailing `(...)` is anything; a trailing `^` is dropped; a leading
 * `@` makes the line a cue whatever its case and is dropped from the name. The neighbour rule
 * (HV-016-06) is unchanged. `cueCharacter` is the one place a cue's name is derived, and the living
 * script's evidence check uses it too, so it still binds the speech to the cue line it came from.
 */
import {expect, test} from "bun:test";
import * as parser from "../src/index";
import {parseFountain} from "../src/index";
import {planShots} from "../../planner/src/index";
import {charactersForScene, type CastingSnapshot} from "../../planner/src/casting";
import {compileLivingScriptDocument} from "../../planner/src/living-script-document";
import {createLivingScriptStructureBase} from "../../planner/src/living-script-structure";

const scene = (cue: string) => parseFountain(`INT. BAR - NIGHT\n\n${cue}\nGet down here.\n`).scenes[0]!;

test("a cue with a lowercase extension, a typographic apostrophe or an accented capital keeps its speech", () => {
  for (const [cue, name] of [["HANS (on the radio)", "HANS"], ["MAYA (CONT’D)", "MAYA"], ["O’BRIEN", "O’BRIEN"], ["JOSÉ", "JOSÉ"], ["ZOË (V.O.)", "ZOË"]] as const) {
    const parsed = scene(cue);
    expect({cue, dialogue: parsed.dialogue, action: parsed.action}).toEqual({cue, dialogue: [{character: name, lines: ["Get down here."]}], action: []});
  }
});

test("MAYA (CONT’D) names the same speaker as MAYA (CONT'D), and the cast finds MAYA under either", () => {
  const cast = {characters: [{name: "MAYA", aliases: []}]} as unknown as CastingSnapshot;
  for (const cue of ["MAYA (CONT'D)", "MAYA (CONT’D)"]) {
    const parsed = parseFountain(`INT. BAR - NIGHT\n\n${cue}\nGet down here.\n`);
    expect(parsed.scenes[0]!.dialogue[0]!.character).toBe("MAYA");
    expect(charactersForScene(cast, 0, parsed).map(character => character.name)).toEqual(["MAYA"]);
  }
});

test("the second speaker of dual dialogue keeps the line, and no caret reaches a shot prompt", () => {
  const parsed = parseFountain("INT. BAR - NIGHT\n\nBRICK\nScrew retirement.\n\nSTEEL ^\nScrew retirement.\n");
  expect(parsed.scenes[0]!.dialogue).toEqual([{character: "BRICK", lines: ["Screw retirement."]}, {character: "STEEL", lines: ["Screw retirement."]}]);
  expect(parsed.scenes[0]!.action).toEqual([]);
  expect(planShots(parsed).map(shot => shot.prompt).join("\n")).not.toContain("^");
});

test("a forced @ cue speaks under its name without the @, whatever its case", () => {
  expect(scene("@McCLANE").dialogue).toEqual([{character: "McCLANE", lines: ["Get down here."]}]);
  expect(scene("@McCLANE (V.O.) ^").dialogue).toEqual([{character: "McCLANE", lines: ["Get down here."]}]);
  // Without the @ a mixed-case line is action, as it always was, and so is a lowercase one.
  expect(scene("McCLANE").action).toEqual(["McCLANE", "Get down here."]);
  expect(scene("Maya (quietly)").action).toEqual(["Maya (quietly)", "Get down here."]);
});

test("every cue the old pattern accepted is still a cue and names the same speaker", () => {
  const OLD = /^[A-Z][A-Z0-9 '().-]*$/;
  for (const cue of ["MAYA", "MAYA (V.O.)", "MAYA (V.O.) (CONT'D)", "DR. O'NEIL", "R2-D2", "BOB (O.S.) JR", "MAYA(CONT'D)", "THE MAN IN BLACK"]) {
    expect(OLD.test(cue)).toBe(true);
    expect({cue, dialogue: scene(cue).dialogue}).toEqual({cue, dialogue: [{character: cue.replace(/\s*\(.*\)$/, ""), lines: ["Get down here."]}]});
    expect(parser.cueCharacter?.(cue)).toBe(cue.replace(/\s*\(.*\)$/, ""));
  }
  // And the neighbour rule still decides: a caret or accented cue with a blank line after it is action.
  expect(parseFountain("INT. BAR - NIGHT\n\nJOSÉ\n\nHe waits.\n").scenes[0]!.action).toEqual(["JOSÉ", "He waits."]);
});

test("the living script binds a dual-dialogue, forced or typographic cue to the speech under it", () => {
  const text = "INT. BAR - NIGHT\n\nBRICK\nScrew retirement.\n\nSTEEL ^\nScrew retirement.\n\n@McCLANE\nYippee.\n\nMAYA (CONT’D)\nGo.\n";
  const document = compileLivingScriptDocument({base: createLivingScriptStructureBase({projectId: "cue-marks", version: 1, text, locks: []}), ancestry: []});
  expect(document.scenes[0]!.beats.map(beat => [beat.kind, beat.character, beat.lineIds.length])).toEqual([
    ["dialogue", "BRICK", 2], ["dialogue", "STEEL", 2], ["dialogue", "McCLANE", 2], ["dialogue", "MAYA", 2],
  ]);
  expect(document.unbound).toEqual([]);
});
