/**
 * HV-016-21 — a parenthetical wrapped across two lines was spoken aloud and captioned.
 *
 * `lineSources` is where a speech becomes the lines the voice engine says and the captions show. It
 * took a line to be a direction only if the whole line was one:
 *
 *     const value=raw.trim();if(/^\([^\r\n]*\)$/.test(value)){cues.push(value);return;}if(!value)return;
 *
 * A parenthetical too long for the dialogue column is written over two lines in Fountain, exactly as
 * it is printed -- `(quietly, looking at` / `the door)` -- and neither half matches. Both became spoken
 * lines: the temporary voice read "quietly, looking at" and "the door" aloud, the speech captions
 * burned them into the picture, and each took a directable line index and a 128-line budget slot.
 *
 * The parser keeps one entry per physical line, and the living script and the edit index bind each
 * entry to its line, so the join is made here rather than there. A wrap is an opener with no other
 * bracket, lines with no bracket, and a closer whose only bracket ends it. The whole wrap is one
 * direction, held as a cue by the lines after it like any other; a speech that does not have that
 * exact shape is read as before, so every line that was already correct keeps its hash.
 */
import {expect, test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {parseFountain} from "../../parser/src/index";
import {compilePerformances, lineSources, spokenText} from "../src/performances";

test("a parenthetical wrapped across two lines is one direction, not two spoken lines", () => {
  const parsed = parseFountain("INT. BAR - NIGHT\n\nMAYA\n(quietly, looking at\nthe door)\nI'm leaving.\n");
  const sources = lineSources(parsed.scenes[0]!.dialogue);
  expect(sources.map(source => [source.lineIndex, source.text, source.cues])).toEqual([[2, "I'm leaving.", ["(quietly, looking at the door)"]]]);
});

test("a three-line wrap is one direction too, and the voice never reads it aloud", () => {
  const dialogue = [{character: "MAYA", lines: ["I'm leaving.", "(she stops at the", "door, and does not", "turn round)", "Tonight."]}];
  const performances = compilePerformances(dialogue, undefined);
  expect(performances.map(line => [line.source.text, line.source.cues])).toEqual([
    ["I'm leaving.", []], ["Tonight.", ["(she stops at the door, and does not turn round)"]],
  ]);
  expect(performances.map(spokenText).join(" ")).not.toMatch(/stops|turn round/);
});

test("every speech that was already read correctly keeps its lines and their hashes", () => {
  // The rule before this increment, verbatim.
  const before = (dialogue: {character: string; lines: string[]}[]) => {
    const result: {hash: string}[] = [];
    dialogue.forEach((block, dialogueIndex) => {const cues: string[] = []; block.lines.forEach((raw, lineIndex) => {
      const value = raw.trim(); if (/^\([^\r\n]*\)$/.test(value)) {cues.push(value); return;} if (!value) return;
      const data = {index: result.length, dialogueIndex, lineIndex, character: block.character, text: value, cues: [...cues]}; result.push({...data, hash: contentHash(data)});
    });});
    return result;
  };
  const speeches = [
    ["(quietly)", "I'm leaving.", "(beat)", "Tonight."],
    ["He said (twice) no.", "(to herself)", "Fine."],
    // An opener that never closes, or whose next bracket opens again, is speech as it always was.
    ["(and another thing", "you never listen."],
    ["(and another thing", "you said (twice)", "no."],
    ["(and another thing", "(beat)", "no."],
    ["(nearly", "done) then (more)"],
  ];
  for (const lines of speeches) {
    const dialogue = [{character: "MAYA", lines}];
    expect({lines, hashes: lineSources(dialogue).map(source => source.hash)}).toEqual({lines, hashes: before(dialogue).map(source => source.hash)});
  }
});
