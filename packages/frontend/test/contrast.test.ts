/**
 * HV-039-01. The first accessibility assertion in this repository.
 *
 * Before this file there were zero accessibility assertions across all twelve
 * packages, and the shipped product failed WCAG 1.4.3 on every primary button
 * in both UIs — 3.25:1 for the label, 2.44:1 once `:hover` swapped in the
 * lighter accent — and 1.4.11 on every text input, select, textarea and
 * secondary-button boundary, at 1.56:1 to 1.71:1. Nothing caught it, because
 * nothing looked.
 *
 * Two rules govern how this file is written, and both are the point:
 *
 * 1. **The thresholds are literals here.** 4.5 and 3.0 are written into this
 *    file, not read from the stylesheet, so the test cannot pass by agreeing
 *    with whatever the palette currently says. That is the defect family this
 *    program keeps finding — an expectation derived from the same live constant
 *    as the code — and a contrast test is the easiest place in the world to
 *    commit it.
 * 2. **The conversion is done here.** This file converts each OKLCH triple to
 *    sRGB and computes the WCAG relative-luminance ratio itself, with no
 *    browser, no headless Chrome and no colour library. A ratio is never read
 *    from a comment, a doc or the stylesheet.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TOKENS = join(REPO_ROOT, "packages/frontend/src/tokens.css");
const CREATOR = join(REPO_ROOT, "packages/frontend/src/index.html");
const OPERATOR = join(REPO_ROOT, "packages/frontend/src/operator.css");

/** OKLCH -> linear sRGB -> gamma-encoded sRGB. Björn Ottosson's matrices. */
function oklchToSrgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map(value => {
    const clamped = Math.min(1, Math.max(0, value));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  }) as [number, number, number];
}

/** WCAG 2.x relative luminance, then the (L1 + 0.05) / (L2 + 0.05) ratio. */
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const luminance = ([r, g, bl]: [number, number, number]) => {
    const [lr, lg, lb] = [r, g, bl].map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

/** Every `--name: oklch(L C H)` in a stylesheet or an inline <style> block. */
function palette(path: string): Map<string, [number, number, number]> {
  const source = readFileSync(path, "utf8");
  const found = new Map<string, [number, number, number]>();
  for (const match of source.matchAll(/--([a-z-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/g)) {
    const [, name, l, c, h] = match;
    found.set(name!, [Number(l), Number(c), Number(h)]);
  }
  return found;
}

/** The thresholds. Literals, and the reason each one applies. */
const REQUIRED: { foreground: string; background: string; minimum: number; what: string }[] = [
  // 1.4.3 Contrast (Minimum): 4.5:1 for text under 24px, or under 18.66px bold.
  // Every label below is 16px at weight 650, which is not WCAG "large text".
  { foreground: "text", background: "accent-strong", minimum: 4.5, what: "primary button label" },
  { foreground: "text", background: "bg", minimum: 4.5, what: "body text on the page" },
  { foreground: "text", background: "surface", minimum: 4.5, what: "text on a panel" },
  { foreground: "text", background: "surface-raised", minimum: 4.5, what: "secondary button label" },
  { foreground: "muted", background: "bg", minimum: 4.5, what: "muted text on the page" },
  { foreground: "muted", background: "surface", minimum: 4.5, what: "muted text on a panel" },
  { foreground: "accent", background: "bg", minimum: 4.5, what: "link text on the page" },
  { foreground: "success", background: "bg", minimum: 4.5, what: "healthy status text" },
  { foreground: "danger", background: "bg", minimum: 4.5, what: "failure status text" },
  { foreground: "warning", background: "bg", minimum: 4.5, what: "warning status text" },
  // 1.4.11 Non-text Contrast: 3:1 for the visual boundary of a UI component,
  // for state indicators, and for graphical objects needed to understand
  // content. The chart axis and series strokes are in the last category.
  { foreground: "control-border", background: "bg", minimum: 3, what: "control boundary against the page" },
  { foreground: "control-border", background: "surface", minimum: 3, what: "control boundary against a panel" },
  { foreground: "control-border", background: "surface-raised", minimum: 3, what: "control boundary against a raised panel" },
  { foreground: "accent-strong", background: "bg", minimum: 3, what: "primary button surface against the page" },
  { foreground: "accent-strong", background: "surface", minimum: 3, what: "primary button surface against a panel" },
  { foreground: "accent", background: "bg", minimum: 3, what: "focus ring against the page" },
  { foreground: "accent", background: "surface", minimum: 3, what: "focus ring against a panel" },
  { foreground: "success", background: "bg", minimum: 3, what: "chart series against the page" },
  { foreground: "warning", background: "bg", minimum: 3, what: "chart series against the page" },
];

test("every token pair the UI relies on clears its WCAG 2.2 AA threshold", () => {
  const tokens = palette(TOKENS);
  // Sanity on the parse itself: a regex that matched nothing would make every
  // assertion below vacuous.
  expect(tokens.size).toBe(12);

  const failures = REQUIRED.map(({ foreground, background, minimum, what }) => {
    const a = tokens.get(foreground), b = tokens.get(background);
    if (!a || !b) return { what, reason: `missing token ${a ? background : foreground}` };
    const ratio = contrast(oklchToSrgb(...a), oklchToSrgb(...b));
    return ratio >= minimum ? null : { what, reason: `${ratio.toFixed(2)}:1 is below ${minimum}:1 (--${foreground} on --${background})` };
  }).filter(Boolean);
  expect(failures).toEqual([]);

  // The two values this increment moved, pinned with the ratio they now reach,
  // so a later edit that lands above threshold but below these has to be a
  // deliberate change here rather than a silent erosion.
  const at = (fg: string, bg: string) => Number(contrast(oklchToSrgb(...tokens.get(fg)!), oklchToSrgb(...tokens.get(bg)!)).toFixed(2));
  expect(at("text", "accent-strong")).toBe(4.75);
  expect(at("control-border", "surface-raised")).toBe(3.03);
});

test("the creator UI and the operator console declare the same palette as tokens.css", () => {
  const tokens = palette(TOKENS), creator = palette(CREATOR), operator = palette(OPERATOR);
  // Each page declares every token, at the same value. Before this increment
  // the two pages named the same colour `--accent-strong` and `--action`, so a
  // fix applied to one page could not reach the other; the test is written over
  // the whole map rather than over one pair so that a divergence of any kind
  // lands here.
  const normalise = (map: Map<string, [number, number, number]>) =>
    [...map].map(([name, value]) => `${name}=${value.join(" ")}`).sort();
  expect(normalise(creator)).toEqual(normalise(tokens));
  expect(normalise(operator)).toEqual(normalise(tokens));

  // And no third palette appears anywhere else in the frontend.
  const others = [...new Bun.Glob("packages/frontend/src/**/*.{css,html,js}").scanSync(REPO_ROOT)]
    .map(file => file.split("\\").join("/"))
    .filter(file => !["packages/frontend/src/tokens.css", "packages/frontend/src/index.html", "packages/frontend/src/operator.css"].includes(file))
    .filter(file => palette(join(REPO_ROOT, file)).size > 0);
  expect(others).toEqual([]);
});

test("no interactive boundary in either UI is drawn with the decorative separator token", () => {
  // `--line` is deliberately left at its original value: 1.4.11 does not reach
  // a rule between table rows, and raising it turns every hairline into a bar.
  // That makes it a hazard -- reaching for the nearest border token is how the
  // 1.71:1 boundaries got there -- so the rules that draw something a person
  // operates are checked by name.
  const interactive = /(^|[\s,>])(input|select|textarea|button|summary|\.secondary|\.button-link)\b/;
  const offenders: string[] = [];
  for (const path of [CREATOR, OPERATOR]) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const declarations = line.indexOf("{");
      if (declarations < 0 || !line.includes("var(--line)")) continue;
      const selector = line.slice(0, declarations);
      // Only a border drawn on the component itself counts; `border-bottom` on
      // a row or a details element is a separator.
      const border = /border(-color|-top|-inline|-block)?\s*:[^;]*var\(--line\)/.test(line.slice(declarations));
      if (border && interactive.test(selector)) offenders.push(`${path.split("/").at(-1)}: ${selector.trim()}`);
    }
  }
  expect(offenders).toEqual([]);

  // The hover state does not repaint a primary button with the foreground
  // accent. That single declaration is what took the label to 2.44:1, and it
  // was present in both files.
  for (const path of [CREATOR, OPERATOR]) {
    const source = readFileSync(path, "utf8");
    expect({ file: path.split("/").at(-1), repaints: /button:hover\s*\{[^}]*background:\s*var\(--accent\)/.test(source) })
      .toEqual({ file: path.split("/").at(-1), repaints: false });
  }
});
