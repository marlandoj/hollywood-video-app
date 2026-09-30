/**
 * HV-039-01. The first contrast assertions in this repository.
 *
 * Before this file there was no WCAG or contrast assertion anywhere in the
 * twelve packages, and the shipped product failed SC 1.4.3 on every primary
 * button in both UIs — 3.25:1 for the label, 2.44:1 once `:hover` repainted the
 * fill with the lighter accent — failed 1.4.11 on every text input, select,
 * textarea and secondary-button boundary at 1.56:1 to 1.71:1, and failed 1.4.3
 * again on the textarea placeholder at 4.13:1. Nothing caught it, because
 * nothing looked.
 *
 * Three rules govern how this file is written, and each is a correction to an
 * earlier draft of it:
 *
 * 1. **The thresholds are literals here.** 4.5 and 3.0 are written into this
 *    file, never read from the stylesheet, so the test cannot pass by agreeing
 *    with whatever the palette currently says.
 * 2. **The conversion is done here.** Each OKLCH triple is converted to sRGB
 *    and the WCAG relative-luminance ratio computed, with no browser, no
 *    headless Chrome and no colour library. A ratio is never read from a
 *    comment, a doc or a stylesheet.
 * 3. **The rules are checked by computing, not by banning a spelling.** The
 *    first draft banned the string `var(--line)` on a list of selectors and
 *    banned the literal declaration `button:hover { background: var(--accent) }`.
 *    Both were trivially evaded — `background-color` instead of `background`,
 *    `border-bottom` instead of `border`, `:active` instead of `:hover`, a bare
 *    `#3a3f4c` instead of a token, a different low-contrast token, or the same
 *    rule split across two lines, which the line-by-line scan could not see at
 *    all. This draft parses rule blocks, resolves the token each declaration
 *    names, and asserts the ratio.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TOKENS = "packages/frontend/src/tokens.css";
const CREATOR = "packages/frontend/src/index.html";
const OPERATOR = "packages/frontend/src/operator.css";
const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), "utf8");

type Rgb = [number, number, number];

/** OKLCH -> linear sRGB -> gamma-encoded sRGB. Björn Ottosson's matrices. */
function oklchToSrgb(L: number, C: number, H: number): Rgb {
  const h = (H * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(value => {
    const clamped = Math.min(1, Math.max(0, value));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

/** WCAG 2.x relative luminance, then (L1 + 0.05) / (L2 + 0.05). */
function contrast(a: Rgb, b: Rgb): number {
  const luminance = (rgb: Rgb) => {
    const [r, g, bl] = rgb.map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

/** Anything that looks like a colour value, whatever its notation. */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:oklch|oklab|lab|lch|rgba?|hsla?|color-mix|color)\s*\(/;

/**
 * Every custom property declared in a file, with its raw value. Declared
 * properties are read in full — not only the OKLCH ones — because a token
 * written in hex was invisible to the first draft of this file and could carry
 * a 1.3:1 control boundary past every assertion in it.
 */
function declarations(relative: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of read(relative).matchAll(/(--[a-z][a-z0-9-]*)\s*:\s*([^;{}]+)/g)) {
    found.set(match[1]!, match[2]!.trim());
  }
  return found;
}

/** The palette as colours, refusing any notation this file cannot evaluate. */
function palette(relative: string): Map<string, Rgb> {
  const parsed = new Map<string, Rgb>();
  for (const [name, value] of declarations(relative)) {
    if (!COLOUR.test(value)) continue;
    const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
    // A colour token this file cannot convert is a hole, not a pass, so it is
    // recorded as an unevaluable entry and asserted against below.
    if (!oklch) { parsed.set(name, null as unknown as Rgb); continue; }
    parsed.set(name, oklchToSrgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3])));
  }
  return parsed;
}

/**
 * Every CSS rule as { selector, body }, from a stylesheet or from the inline
 * <style> blocks of an HTML file. Comments are stripped first. Parsing blocks
 * rather than lines is what makes a rule split across several lines, or two
 * rules on one line, visible to the checks below.
 */
function rules(relative: string): { selector: string; body: string }[] {
  let source = read(relative);
  if (relative.endsWith(".html")) source = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]!).join("\n");
  source = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1]!.trim().replace(/\s+/g, " "), body: m[2]! }));
}

/** Colour-bearing declarations of the given properties inside one rule body. */
function colourDeclarations(body: string, property: RegExp): { property: string; value: string }[] {
  return [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)]
    .filter(match => property.test(match[1]!))
    .map(match => ({ property: match[1]!, value: match[2]!.trim() }))
    .filter(declaration => COLOUR.test(declaration.value) || declaration.value.includes("var(--"));
}

const tokenIn = (value: string) => /var\(\s*(--[a-z][a-z0-9-]*)/.exec(value)?.[1];

/**
 * A component a person operates, whose boundary SC 1.4.11 reaches.
 *
 * `details` and `fieldset` are deliberately absent. A `border-bottom` on a
 * stacked `details` row is a separator between disclosures, and the control's
 * own boundary is the focusable `summary` and its focus ring; a `fieldset` is a
 * grouping container, not a control. Both keep `--line`, and that is a judgement
 * this comment exists to record rather than hide.
 */
const OPERABLE = /(^|[\s,>+~])(input|select|textarea|button|summary|option|label)\b|\[role=|\.secondary\b|\.button-link\b|\.chip\b|\.cta\b|\.mask-viewport\b|\.take-card\b|\.edit-script-entry\b/;
/** A button, or something dressed as one, whose fill sits behind a --text label. */
const BUTTONLIKE = /(^|[\s,>+~])button\b|\.secondary\b|\.button-link\b|\.cta\b|\[role="?button/;
/** Notation this file allows where a token would be meaningless. */
const MAX_CONTRAST_OVERLAY = /^#(fff|ffffff|000|000000)$/i;

test("every token pair the UI relies on clears its WCAG 2.2 AA threshold", () => {
  const tokens = palette(TOKENS);
  // Thirteen colour tokens, every one evaluable. A token in a notation this
  // file cannot convert would otherwise sit outside every assertion below.
  expect([...tokens.keys()].sort()).toEqual([
    "--accent", "--accent-strong", "--bg", "--control-border", "--danger", "--line",
    "--muted", "--placeholder", "--success", "--surface", "--surface-raised", "--text", "--warning",
  ]);
  expect([...tokens].filter(([, value]) => value === null).map(([name]) => name)).toEqual([]);

  // Each pair appears once, at the strictest threshold that applies to it. An
  // earlier draft listed three pairs twice — once at 4.5 and again at 3 — where
  // the 3:1 entry was implied by the 4.5:1 one and could never fail alone.
  const required: [string, string, number, string][] = [
    // SC 1.4.3, 4.5:1. Every label below is under 24px and under 18.66px bold.
    ["--text", "--accent-strong", 4.5, "primary button label"],
    ["--text", "--bg", 4.5, "body text on the page"],
    ["--text", "--surface", 4.5, "text on a panel"],
    ["--text", "--surface-raised", 4.5, "secondary button label"],
    ["--muted", "--bg", 4.5, "muted text on the page"],
    ["--muted", "--surface", 4.5, "muted text on a panel"],
    ["--muted", "--surface-raised", 4.5, "muted text on a raised panel"],
    ["--placeholder", "--surface", 4.5, "placeholder inside a control"],
    ["--placeholder", "--bg", 4.5, "placeholder on the page"],
    ["--accent", "--bg", 4.5, "link text on the page"],
    ["--accent", "--surface", 4.5, "link text on a panel"],
    ["--success", "--bg", 4.5, "healthy status text"],
    ["--danger", "--bg", 4.5, "failure status text"],
    ["--warning", "--bg", 4.5, "warning status text"],
    // SC 1.4.11, 3:1. Boundaries, state indicators, and graphical objects
    // needed to understand content (the chart axis and its series strokes).
    ["--control-border", "--bg", 3, "control boundary against the page"],
    ["--control-border", "--surface", 3, "control boundary against a panel"],
    ["--control-border", "--surface-raised", 3, "control boundary against a raised panel"],
    ["--accent-strong", "--bg", 3, "primary button surface against the page"],
    ["--accent-strong", "--surface", 3, "primary button surface against a panel"],
    ["--accent", "--surface-raised", 3, "focus ring against a raised panel"],
    ["--success", "--surface", 3, "chart series against a panel"],
    ["--warning", "--surface", 3, "chart series against a panel"],
  ];
  expect(required.length).toBe(22);
  expect(new Set(required.map(([a, b]) => `${a}/${b}`)).size).toBe(22);

  const failures = required.flatMap(([foreground, background, minimum, what]) => {
    const ratio = contrast(tokens.get(foreground)!, tokens.get(background)!);
    return ratio >= minimum ? [] : [`${what}: ${ratio.toFixed(2)}:1 is below ${minimum}:1 (${foreground} on ${background})`];
  });
  expect(failures).toEqual([]);

  const at = (a: string, b: string) => Number(contrast(tokens.get(a)!, tokens.get(b)!).toFixed(2));
  // The three values this increment moved, pinned at the ratio they reach, so a
  // later edit that stays above threshold but erodes the margin has to be a
  // deliberate change here.
  expect([at("--text", "--accent-strong"), at("--control-border", "--surface-raised"), at("--placeholder", "--surface")])
    .toEqual([4.75, 3.03, 4.86]);
  // The one pair that cannot be satisfied, recorded rather than omitted:
  // --surface-raised is 1.21:1 from --bg, so no lightness of this hue clears
  // 3:1 there while the --text label still clears 4.5:1 on the same fill. A
  // primary button must not be placed on a raised panel.
  expect(at("--accent-strong", "--surface-raised")).toBe(2.83);
  expect(at("--surface-raised", "--bg")).toBe(1.21);
});

test("the creator UI and the operator console declare the same palette as tokens.css", () => {
  const normalise = (relative: string) => [...declarations(relative)]
    .filter(([, value]) => COLOUR.test(value))
    .map(([name, value]) => `${name}=${value}`).sort();
  expect(normalise(CREATOR)).toEqual(normalise(TOKENS));
  expect(normalise(OPERATOR)).toEqual(normalise(TOKENS));

  // No fourth palette anywhere in the frontend, in any notation.
  const others = [...new Bun.Glob("packages/frontend/src/**/*.{css,html,js,ts,mjs}").scanSync(REPO_ROOT)]
    .map(file => file.split("\\").join("/"))
    .filter(file => ![TOKENS, CREATOR, OPERATOR].includes(file))
    .filter(file => normalise(file).length > 0);
  expect(others).toEqual([]);
});

test("every operable boundary and every button fill in both UIs is a token that clears its threshold", () => {
  const tokens = palette(TOKENS);
  const boundary = /^(border|outline|box-shadow)/;
  const fill = /^background/;
  const surfaces = ["--bg", "--surface", "--surface-raised"] as const;
  const offenders: string[] = [];

  for (const relative of [CREATOR, OPERATOR]) {
    const file = relative.split("/").at(-1);
    for (const { selector, body } of rules(relative)) {
      const operable = OPERABLE.test(selector), buttonlike = BUTTONLIKE.test(selector);
      if (!operable && !buttonlike) continue;

      // A boundary drawn on something a person operates: 1.4.11, 3:1 against
      // every surface it can sit on.
      if (operable) for (const { property, value } of colourDeclarations(body, boundary)) {
        const literal = value.match(/#[0-9a-fA-F]{3,8}/)?.[0];
        // Pure white and pure black are allowed on an overlay drawn across
        // arbitrary imagery, where no token's contrast is knowable.
        if (literal && MAX_CONTRAST_OVERLAY.test(literal)) continue;
        if (literal) { offenders.push(`${file} ${selector} ${property}: literal ${literal}, not a token`); continue; }
        const token = tokenIn(value);
        if (!token) continue;
        const colour = tokens.get(token);
        if (!colour) { offenders.push(`${file} ${selector} ${property}: ${token} is not a palette colour`); continue; }
        for (const surface of surfaces) {
          const ratio = contrast(colour, tokens.get(surface)!);
          if (ratio < 3) offenders.push(`${file} ${selector} ${property}: ${token} is ${ratio.toFixed(2)}:1 on ${surface}, below 3:1`);
        }
      }

      // Text drawn inside something a person operates: 1.4.3, 4.5:1 against
      // both backgrounds a control can sit on. This is what the placeholder
      // missed -- it was an inline oklch literal the palette never saw, and a
      // boundary-only check could not see it either.
      if (operable) for (const { property, value } of colourDeclarations(body, /^color$/)) {
        const token = tokenIn(value);
        if (!token) { offenders.push(`${file} ${selector} ${property}: ${value} is not a token`); continue; }
        const colour = tokens.get(token);
        if (!colour) { offenders.push(`${file} ${selector} ${property}: ${token} is not a palette colour`); continue; }
        for (const surface of ["--bg", "--surface"] as const) {
          const ratio = contrast(colour, tokens.get(surface)!);
          if (ratio < 4.5) offenders.push(`${file} ${selector} ${property}: ${token} is ${ratio.toFixed(2)}:1 on ${surface}, below 4.5:1`);
        }
      }

      // A fill behind a --text label: 1.4.3, 4.5:1. This is what the hover
      // repaint broke, and it is checked by ratio rather than by banning one
      // declaration, so `background-color`, `:active` and a different
      // low-contrast token are all caught.
      if (buttonlike) for (const { property, value } of colourDeclarations(body, fill)) {
        if (/^(transparent|none|inherit|currentColor)$/i.test(value)) continue;
        const token = tokenIn(value);
        if (!token) { offenders.push(`${file} ${selector} ${property}: ${value} is not a token`); continue; }
        const colour = tokens.get(token);
        if (!colour) { offenders.push(`${file} ${selector} ${property}: ${token} is not a palette colour`); continue; }
        const ratio = contrast(tokens.get("--text")!, colour);
        if (ratio < 4.5) offenders.push(`${file} ${selector} ${property}: --text on ${token} is ${ratio.toFixed(2)}:1, below 4.5:1`);
      }
    }
  }
  expect(offenders).toEqual([]);

  // The parse is not vacuous: both files yield rules, and the checks above
  // reach a known number of operable and button-like ones.
  const reached = [CREATOR, OPERATOR].map(relative => rules(relative)
    .filter(({ selector }) => OPERABLE.test(selector) || BUTTONLIKE.test(selector)).length);
  // HV-030-03 added two: the studio question labels and the Advanced switch.
  // HV-029-15 added two: the review comment box and the owner's review list buttons.
  // HV-039-21 added one: the 24px minimum for every checkbox and radio.
  expect(reached).toEqual([79, 11]);
});
