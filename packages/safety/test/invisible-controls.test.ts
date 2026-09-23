/**
 * HV-031-08 — the one class of invisible character the fold did not remove.
 *
 * HV-031-05 made `foldForMatching` strip the characters that are not there, because a zero-width
 * joiner inserted into a word passed every prohibition this package has. It stripped
 * `[\p{M}\p{Cf}\p{Cs}\p{Co}]`. It did not strip `\p{Cc}` — the C0 controls, `\u007f`, and the C1
 * block — and those are invisible in exactly the same way:
 *
 *     Cc code points: 65 | whitespace: 5 | invisible: 60
 *     invisible controls that evade EVERY listed name: 60 of 60   (185 of 185 names, each)
 *     prohibition battery: 17 of 17 prompts passed, with one invisible control per word
 *
 * Sixty single characters, each of which defeated the gate completely. `motion-graphics.ts` has
 * refused `[\p{Cc}\p{Cs}\p{Cf}]` in every string a title carries since before this fold existed, so
 * the repo knew; the knowledge never reached the gate. That is the same shape as HV-031-05 and
 * HV-031-07: not a wrong list, but a second description of the list that disagreed with it.
 *
 * The fix derives the class from `\p{Cc}` minus `\s` rather than writing it out, because the five control
 * characters that *are* whitespace must stay. Removing a newline would join the end of one line to
 * the start of the next and take the word boundary away from a name that begins a line: a false
 * negative bought to close an evasion that is visible on the page anyway.
 *
 * These tests are the cross product of what the module already declares — every `\p{Cc}` code point
 * against every name in `PUBLIC_FIGURES` and every prompt in `PROHIBITED_PROMPT_BATTERY`. There is
 * no hand-written evasion string in this file.
 */
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {PUBLIC_FIGURES, foldForMatching, namesPublicFigure} from "../src/public-figures";
import {PROHIBITED_PROMPT_BATTERY, checkPrompt} from "../src/index";

/** Every `\p{Cc}` code point: U+0000–U+001F, U+007F, and the C1 block U+0080–U+009F. */
const CONTROLS = Array.from({length: 0xa0}, (_, code) => String.fromCodePoint(code)).filter(character => /\p{Cc}/u.test(character));
const invisible = CONTROLS.filter(character => !/\s/u.test(character));
const whitespace = CONTROLS.filter(character => /\s/u.test(character));
const show = (character: string) => "U+" + character.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase();

test("the class is the whole of Cc, and it splits into sixty invisible characters and five whitespace ones", () => {
  // The count is the claim above, and it is what the rest of this file is a cross product over.
  for (const character of CONTROLS) expect({character: show(character), cc: /\p{Cc}/u.test(character)}).toEqual({character: show(character), cc: true});
  expect({total: CONTROLS.length, invisible: invisible.length, whitespace: whitespace.length}).toEqual({total: 65, invisible: 60, whitespace: 5});
  expect(whitespace.map(show)).toEqual(["U+0009", "U+000A", "U+000B", "U+000C", "U+000D"]);
});

test("the fold removes every invisible control, and every one it removes is invisible", () => {
  // Both directions, so the class cannot quietly widen into whitespace or narrow away from a
  // control. A fold that removed a newline would be a different bug, not a stricter gate.
  const kept = invisible.filter(character => foldForMatching("a" + character + "b") !== "ab");
  expect({kept: kept.map(show)}).toEqual({kept: []});
  const dropped = whitespace.filter(character => foldForMatching("a" + character + "b") !== "a" + character + "b");
  expect({dropped: dropped.map(show)}).toEqual({dropped: []});
});

test("and no invisible control hides a listed name from the gate", () => {
  // 60 x 185. Before: every one of the 60 passed every one of the 185.
  const missed: string[] = [];
  for (const character of invisible) {
    for (const name of PUBLIC_FIGURES) {
      const woven = name.replace(/(\p{L})(?=\p{L})/u, "$1" + character);
      if (!namesPublicFigure("INT. ROOM - DAY. " + woven + " walks in.")) missed.push(show(character) + " in " + name);
    }
  }
  expect({missed: missed.slice(0, 5), count: missed.length}).toEqual({missed: [], count: 0});
});

test("and no invisible control hides a prohibited prompt from checkPrompt", () => {
  // The public-figure list is one rule of many; the fold is shared, so the whole battery is the
  // measurement. One control after the first letter of every word, which is the cheapest edit that
  // leaves the text reading unchanged. Before: 17 of 17 passed, for each of the 60.
  const weave = (text: string, character: string) =>
    text.split(/(\s+)/).map(word => word.length > 1 && /\S/.test(word) ? word[0]! + character + word.slice(1) : word).join("");
  const passed: string[] = [];
  for (const character of invisible) {
    for (const entry of PROHIBITED_PROMPT_BATTERY) {
      const verdict = checkPrompt(weave(entry.prompt, character));
      if (verdict.allowed) passed.push(show(character) + " -> " + entry.category);
      else expect({character: show(character), category: verdict.category}).toEqual({character: show(character), category: entry.category});
    }
  }
  expect({passed: passed.slice(0, 5), count: passed.length}).toEqual({passed: [], count: 0});
});

test("and the two folds HV-031-05 and HV-031-07 established still hold", () => {
  // `\ufeff` is both Cf and, to JavaScript, `\s`. Subtracting `\s` from the *control* class must not
  // reach the format class, or this increment silently undoes the one before last.
  expect(foldForMatching("a\ufeffb")).toBe("ab");
  expect(foldForMatching("a\u200db")).toBe("ab");
  expect(foldForMatching("a\u00adb")).toBe("ab");
  expect(foldForMatching("\u0415L\u041eN MUSK")).toBe(foldForMatching("ELON MUSK"));
  expect(foldForMatching("Café — Beyoncé")).toBe("cafe — beyonce");
  expect(namesPublicFigure("a scene with \u0501onald Trump in it")).toBe(true);
  expect(namesPublicFigure("a scene with B\u0131llie Eilish in it")).toBe(true);
});

test("and the fold's control class is derived from Cc rather than written out", () => {
  // The defect three times running has been a second, hand-written description of a set. A literal
  // range here would be that again, so the source is read and the shape is asserted.
  const source = readFileSync(new URL("../src/public-figures.ts", import.meta.url).pathname, "utf8");
  const derivation = source.match(/const INVISIBLE_CONTROLS = [^;]*;/s)![0];
  expect(derivation).toContain(String.raw`/\p{Cc}/u.test(character) && !/\s/u.test(character)`);
  expect(derivation).not.toMatch(/\\u00[0-9a-f]{2}/);
  // And the ordinary text a screenplay is made of is untouched by all of it.
  expect(foldForMatching("INT. BAR - DAY\n\nShe slides the envelope across the bar.\tTwice."))
    .toBe("int. bar - day\n\nshe slides the envelope across the bar.\ttwice.");
});
