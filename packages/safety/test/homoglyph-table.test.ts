/**
 * HV-031-07 — two characters the gate's own table lists, that the gate never looked at.
 *
 * `foldForMatching` folds a homoglyph by looking it up in `HOMOGLYPHS`, and it offered the lookup
 * only the characters matching a hand-written class:
 *
 *     .replace(/[\u0400-\u04ff\u0370-\u03ff\u0250-\u02af\u2010\u2011\u2044]/gu, c => HOMOGLYPHS[c] ?? c)
 *
 * Two of the table's thirty-four entries fall outside it. `\u0501` is one codepoint past the
 * Cyrillic range's end; `\u0131` is Latin Extended-A, in none of the three. The table said they
 * fold. The class said they never reach it. The class won:
 *
 *     table entries: 34, never applied: 2
 *     \u0501 stands for "d" -> 62 of the 185 listed names passed the gate
 *     \u0131 stands for "i" -> 105 of them
 *     union: 134 of 185
 *
 * A listed name written with one of those two characters in place of a letter renders to a person
 * as the name, tokenizes for a provider as the name, and was allowed. Nothing about the list was
 * wrong and nothing about the table was wrong; a second, hand-written description of what the table
 * holds was, which is the defect this file is really about — `packages/api` learned the same lesson
 * in HV-029-07 and `provider-kinds.ts` says it in its own header about six copies of one closed set.
 *
 * The pattern is derived from the table's keys now, so it cannot disagree with it. These tests are
 * over the table and the list, not over hand-written strings: there is no ready-made evasion in this
 * file, only the cross product of what the module already declares.
 */
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {PUBLIC_FIGURES, foldForMatching, namesPublicFigure} from "../src/public-figures";
import {checkPrompt} from "../src/index";

/** The table, read from the source, so the test cannot be looking at a different one. */
function table(): [string, string][] {
  const source = readFileSync(new URL("../src/public-figures.ts", import.meta.url).pathname, "utf8");
  const block = source.match(/const HOMOGLYPHS[^;]*;/s)![0];
  const entries = [...block.matchAll(/"\\u([0-9a-f]{4})":"(.)"/g)]
    .map(match => [String.fromCodePoint(parseInt(match[1]!, 16)), match[2]!] as [string, string]);
  expect(entries.length).toBeGreaterThan(30);
  return entries;
}

test("every character the table lists is a character the fold folds", () => {
  // The structural claim. Two entries were dead; the point is not that those two now work but that
  // no entry can be dead, because the thing that decides which characters are offered is the table.
  const dead = table().filter(([character, latin]) => foldForMatching(character) !== latin);
  expect({dead: dead.map(([character]) => "U+" + character.codePointAt(0)!.toString(16).padStart(4, "0"))}).toEqual({dead: []});
});

test("and no listed name is allowed with one of them standing in for a letter", () => {
  // The whole cross product: 185 names x 34 table entries, each substitution applied everywhere the
  // Latin letter it stands for appears, in either case. Built from the module's own declarations, so
  // this file contains no evasion string of its own.
  const entries = table();
  const missed: string[] = [];
  for (const name of PUBLIC_FIGURES) {
    expect({name, refused: namesPublicFigure(name)}).toEqual({name, refused: true});
    for (const [character, latin] of entries) {
      if (!/[a-z]/.test(latin)) continue;
      const swapped = name.replaceAll(latin, character).replaceAll(latin.toUpperCase(), character);
      if (swapped === name) continue;
      if (!namesPublicFigure(swapped)) missed.push(latin + " -> U+" + character.codePointAt(0)!.toString(16));
    }
  }
  expect({missed: [...new Set(missed)]}).toEqual({missed: []});
});

test("and the gate the studio actually calls refuses them too", () => {
  // `namesPublicFigure` is the predicate; `checkPrompt` is what every prompt goes through, and it is
  // the one whose answer decides whether a render happens.
  const entries = table().filter(([, latin]) => /[a-z]/.test(latin));
  const name = PUBLIC_FIGURES[0]!;
  for (const [character, latin] of entries) {
    const swapped = name.replaceAll(latin, character).replaceAll(latin.toUpperCase(), character);
    if (swapped === name) continue;
    const verdict = checkPrompt("A close-up of " + swapped + " at the window.");
    expect({latin, allowed: verdict.allowed}).toEqual({latin, allowed: false});
    expect({latin, category: verdict.category}).toEqual({latin, category: "named_public_figure"});
  }
});

test("and folding a character the table does not list still leaves it alone", () => {
  // A fold that removed anything it did not recognise would refuse far more than the list, which is
  // a different defect in the same place. The fold's other rules are unchanged and asserted here by
  // the shapes the module already documents: case, accents, and the characters that are not there.
  expect(foldForMatching("Beyoncé")).toBe(foldForMatching("BEYONCE"));
  expect(foldForMatching("ABC-123 / xyz")).toBe("abc-123 / xyz");
  expect(foldForMatching("a\u200bb")).toBe("ab");
  expect(foldForMatching("\u4e16\u754c")).toBe("\u4e16\u754c");
  // And an unlisted Cyrillic letter is still left as itself, rather than silently becoming Latin.
  expect(foldForMatching("\u0448")).toBe("\u0448");
});

test("and the fold is still linear in the text it is given", () => {
  // The old class was a character range; the new one is a set built from the table. A set of
  // thirty-four is not a range, so this is the assertion that it did not become a per-character
  // callback over the whole string. Measured here: 0.03 ms at 25,000 characters, 0.21 at 200,000.
  const ms = (work: () => unknown) => {const started = Bun.nanoseconds(); work(); return (Bun.nanoseconds() - started) / 1e6;};
  const text = (count: number) => "Marla crosses the room and waits by the window. ".repeat(Math.ceil(count / 47)).slice(0, count);
  const small = text(25_000), large = text(200_000);
  foldForMatching(small); foldForMatching(large);
  const at25 = Math.min(...[0, 1, 2].map(() => ms(() => foldForMatching(small))));
  const at200 = Math.min(...[0, 1, 2].map(() => ms(() => foldForMatching(large))));
  const round = (value: number) => Number(value.toFixed(2));
  // Eight times the text, at most twenty-four times the work: three times the slack linear needs.
  expect({linear: at200 <= Math.max(at25, 0.02) * 24, at25: round(at25), at200: round(at200)})
    .toEqual({linear: true, at25: round(at25), at200: round(at200)});
});
