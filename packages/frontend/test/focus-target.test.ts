/**
 * HV-039-21 — WCAG 2.2 AA 2.5.8 (Target Size, Minimum) and 2.4.7 (Focus Visible), computed from
 * the stylesheets the browser actually gets.
 *
 * The creator UI sized native checkboxes panel by panel: `.dialogue-workbench`, `.motion-workbench`,
 * `.editorial-studio`, `.graphic-studio`, `.living-script`, `.render-options` and the take desk's
 * attestation each drew theirs at 44px. Everywhere else a checkbox was the browser's own 13px
 * square: the studio front door's rights and cast consent boxes, the Advanced switch in the page
 * header, the screenplay form's rights box, and every consent, view and attestation box on the cast
 * desk, shot direction, frame anchors and the shared-actor import. 13px is under the 24px minimum;
 * such a target can still pass through the spacing exception, but whether it does depends on the
 * layout around it, which no one had measured and this file cannot.
 *
 * The creator UI also drew its own focus ring only on `textarea`, `button`, `a`, `input` and
 * `summary`, and on `select` inside three panels. A `select` in the voice studio, the sound session,
 * picture editorial, graphics, lip-sync, the take desk or subject motion, and every heading the
 * focus-return work of HV-039-04 to -17 moves focus to (`tabindex="-1"`), fell back to the browser's
 * default ring, whose colour and width vary by browser and are not held to 3:1 on this palette.
 *
 * So this file resolves the cascade itself: it parses both stylesheets into rules (including those
 * inside `@media`, which may apply), matches each rule's selector against an element described the
 * way the modules build it -- tag, attributes, classes and the chain of panels above it -- and takes
 * the winning declaration by specificity and source order. Nothing is read from a comment, and a
 * selector the matcher does not understand is a failure rather than a silent non-match.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CREATOR = "packages/frontend/src/index.html";
const OPERATOR = "packages/frontend/src/operator.css";
const TOKENS = "packages/frontend/src/tokens.css";
const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), "utf8");

/** The smallest target WCAG 2.5.8 allows without the spacing exception, in CSS pixels. A literal. */
const MIN_TARGET_PX = 24;
/** The browsers' own checkbox and radio: 13px square in Chromium and Firefox. */
const NATIVE_CHECK_PX = 13;

type Rule = { selector: string; declarations: Map<string, { value: string; important: boolean }>; order: number };

/** Every rule of a stylesheet, or of an HTML file's `<style>` blocks, with rules inside `@media` kept in place. */
function rules(relative: string): Rule[] {
  let source = read(relative);
  if (relative.endsWith(".html")) source = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]!).join("\n");
  source = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  let depth = 0, start = 0, prelude = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "{") {
      const head = source.slice(start, i).trim();
      if (head.startsWith("@")) { depth++; start = i + 1; continue; }
      prelude = head; start = i + 1; depth++;
    } else if (c === "}") {
      if (prelude) {
        const declarations = new Map<string, { value: string; important: boolean }>();
        for (const part of source.slice(start, i).split(";")) {
          const colon = part.indexOf(":");
          if (colon < 0) continue;
          const property = part.slice(0, colon).trim().toLowerCase();
          let value = part.slice(colon + 1).trim();
          const important = value.endsWith("!important");
          value = value.replace(/\s*!important$/, "");
          if (property) declarations.set(property, { value, important });
        }
        out.push({ selector: prelude.replace(/\s+/g, " "), declarations, order: out.length });
        prelude = "";
      }
      depth--; start = i + 1;
    }
  }
  return out;
}

/** An element as a module builds it. `states` are the pseudo-classes it is in, such as `focus-visible`. */
type El = { tag: string; attrs?: Record<string, string>; classes?: string[]; id?: string; parent?: El };
const el = (tag: string, options: Omit<El, "tag"> = {}): El => ({ tag, ...options });

/** Split a selector list on top-level commas. */
function splitList(list: string): string[] {
  const parts: string[] = []; let depth = 0, current = "";
  for (const c of list) {
    if ((c === "(" || c === "[")) depth++;
    if ((c === ")" || c === "]")) depth--;
    if (c === "," && depth === 0) { parts.push(current.trim()); current = ""; } else current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** A compound selector's simple parts, e.g. `button.secondary:hover` -> [`button`, `.secondary`, `:hover`]. */
function simples(compound: string): string[] {
  const parts: string[] = []; let i = 0;
  while (i < compound.length) {
    let j = i + 1;
    if (compound[i] === "[") { let depth = 1; while (depth && j < compound.length) { if (compound[j] === "[") depth++; if (compound[j] === "]") depth--; j++; } }
    else {
      if (compound[i] === ":" && compound[j] === ":") j++;
      while (j < compound.length && !"[.#:".includes(compound[j]!)) {
        if (compound[j] === "(") { let depth = 1; j++; while (depth && j < compound.length) { if (compound[j] === "(") depth++; if (compound[j] === ")") depth--; j++; } continue; }
        j++;
      }
    }
    parts.push(compound.slice(i, j)); i = j;
  }
  return parts;
}

/** A complex selector as [compound, combinator-before-it] pairs, right-most last. */
function compounds(complex: string): { compound: string; combinator: string }[] {
  const out: { compound: string; combinator: string }[] = []; let depth = 0, current = "", combinator = "";
  const flush = () => { if (current.trim()) { out.push({ compound: current.trim(), combinator }); current = ""; combinator = ""; } };
  for (let i = 0; i < complex.length; i++) {
    const c = complex[i]!;
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (depth === 0 && (c === ">" || c === "+" || c === "~")) { flush(); combinator = c; continue; }
    if (depth === 0 && c === " ") { if (current.trim()) { flush(); combinator = combinator || " "; } continue; }
    current += c;
  }
  flush();
  return out;
}

const UNKNOWN: string[] = [];

function matchesSimple(part: string, e: El, states: Set<string>): boolean {
  if (part === "*") return true;
  if (/^[a-z][a-z0-9-]*$/i.test(part)) return e.tag === part.toLowerCase();
  if (part.startsWith(".")) return (e.classes ?? []).includes(part.slice(1));
  if (part.startsWith("#")) return e.id === part.slice(1);
  if (part.startsWith("[")) {
    const m = /^\[\s*([a-z-]+)\s*(?:=\s*["']?([^"'\]]*)["']?)?\s*\]$/i.exec(part);
    if (!m) { UNKNOWN.push(part); return false; }
    const value = e.attrs?.[m[1]!];
    return m[2] === undefined ? value !== undefined : value === m[2];
  }
  if (part.startsWith("::")) return false; // a pseudo-element is not the element
  const m = /^:([a-z-]+)(?:\((.*)\))?$/i.exec(part);
  if (!m) { UNKNOWN.push(part); return false; }
  const [, name, args] = m;
  switch (name) {
    case "focus-visible": case "focus": case "hover": case "active": return states.has(name);
    case "disabled": return e.attrs?.disabled !== undefined;
    case "not": return !splitList(args!).some(s => matches(s, e, states));
    case "is": case "where": return splitList(args!).some(s => matches(s, e, states));
    // Structural and relational pseudo-classes cannot be decided from one element; no rule this
    // file resolves depends on them, and treating them as non-matching is recorded here.
    case "has": case "first-of-type": case "empty": case "root": return false;
    default: UNKNOWN.push(part); return false;
  }
}

function matchesCompound(compound: string, e: El, states: Set<string>): boolean {
  return simples(compound).every(part => matchesSimple(part, e, states));
}

/** Whether a complex selector matches `e`, walking ancestors for descendant and child combinators. */
function matches(complex: string, e: El, states: Set<string>): boolean {
  const chain = compounds(complex);
  const walk = (index: number, node: El | undefined, own: Set<string>): boolean => {
    if (!node) return false;
    const { compound, combinator } = chain[index]!;
    if (!matchesCompound(compound, node, own)) return false;
    if (index === 0) return true;
    if (combinator === ">") return walk(index - 1, node.parent, new Set());
    if (combinator === " ") { for (let p = node.parent; p; p = p.parent) if (walk(index - 1, p, new Set())) return true; return false; }
    return false; // sibling combinators: no sibling is described, so no match
  };
  return walk(chain.length - 1, e, states);
}

/** [ids, classes/attributes/pseudo-classes, types] for one complex selector. */
function specificity(complex: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  for (const { compound } of compounds(complex)) for (const part of simples(compound)) {
    if (part === "*") continue;
    if (part.startsWith("#")) total[0]++;
    else if (part.startsWith(".") || part.startsWith("[")) total[1]++;
    else if (part.startsWith("::")) total[2]++;
    else if (part.startsWith(":")) {
      const m = /^:([a-z-]+)(?:\((.*)\))?$/i.exec(part)!;
      if (m[1] === "where") continue;
      if (["not", "is", "has"].includes(m[1]!)) {
        const best = splitList(m[2]!).map(specificity).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0]!;
        total[0] += best[0]; total[1] += best[1]; total[2] += best[2];
      } else total[1]++;
    } else total[2]++;
  }
  return total;
}

/** The winning value of `property` on `e` in `states`, expanding the `outline` shorthand. */
function computed(sheet: Rule[], e: El, property: string, states: string[] = []): string | undefined {
  const active = new Set(states);
  let best: { important: boolean; spec: [number, number, number]; order: number; value: string } | undefined;
  for (const rule of sheet) {
    for (const selector of splitList(rule.selector)) {
      if (!matches(selector, e, active)) continue;
      const spec = specificity(selector);
      for (const [name, { value, important }] of rule.declarations) {
        const expanded = name === "outline" ? outlineLonghands(value)[property] : name === property ? value : undefined;
        if (expanded === undefined) continue;
        const beats = !best || (important !== best.important ? important
          : spec[0] !== best.spec[0] ? spec[0] > best.spec[0]
          : spec[1] !== best.spec[1] ? spec[1] > best.spec[1]
          : spec[2] !== best.spec[2] ? spec[2] > best.spec[2]
          : rule.order >= best.order);
        if (beats) best = { important, spec, order: rule.order, value: expanded };
      }
    }
  }
  return best?.value;
}

function outlineLonghands(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of value.match(/var\([^)]*\)|\S+/g) ?? []) {
    if (/^(none|solid|dashed|dotted|double|auto|groove|ridge|inset|outset)$/.test(token)) out["outline-style"] = token;
    else if (/^-?[\d.]+(px|rem|em)?$/.test(token) || /^(thin|medium|thick)$/.test(token)) out["outline-width"] = token;
    else out["outline-color"] = token;
  }
  return out;
}

/** A length in CSS pixels; a percentage of a panel is at least as wide as any target here. */
function px(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^(-?[\d.]+)(px|rem|%)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === "rem" ? n * 16 : m[2] === "%" ? (n >= 100 ? Infinity : undefined) : n;
}

/** The rendered size of a native checkbox or radio: its declared size, raised by any minimum. */
function checkSize(sheet: Rule[], e: El): { width: number; height: number } {
  const dimension = (axis: "width" | "height") => Math.max(
    px(computed(sheet, e, axis)) ?? NATIVE_CHECK_PX,
    px(computed(sheet, e, "min-" + axis)) ?? 0);
  return { width: dimension("width"), height: dimension("height") };
}

/**
 * The WCAG ratio of two palette tokens. OKLab converts to *linear* sRGB, which is what relative
 * luminance weights, so no gamma step is needed here; contrast.test.ts encodes and decodes again.
 */
function ratio(a: string, b: string, tokens: Map<string, number[]>): number {
  const lum = ([L, C, H]: number[]) => {
    const h = (H! * Math.PI) / 180, A = C! * Math.cos(h), B = C! * Math.sin(h);
    const l = (L! + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L! - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L! - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
      .map(v => Math.min(1, Math.max(0, v)));
    return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
  };
  const [x, y] = [lum(tokens.get(a)!), lum(tokens.get(b)!)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
const palette = () => new Map([...read(TOKENS).matchAll(/(--[a-z-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)].map(m => [m[1]!, [Number(m[2]), Number(m[3]), Number(m[4])]]));

// The panels as the modules and index.html build them.
const creatorFlow = el("section", { id: "creator-flow" });
const castPanel = el("section", { id: "casting-panel", classes: ["cast-panel"], parent: creatorFlow });
const directionPanel = el("section", { id: "direction-panel", classes: ["cast-panel"], parent: creatorFlow });
const studioPanel = el("section", { id: "studio", classes: ["studio-panel"] });
const header = el("header");
const form = el("form", { id: "screenplay-form", parent: creatorFlow });
const lineNotesPanel = el("section", { classes: ["line-notes"], attrs: { "aria-labelledby": "line-notes-title" }, parent: creatorFlow });
const attestation = (parent: El) => el("label", { classes: ["attestation"], parent });
const checkbox = (parent: El, id?: string) => el("input", { attrs: { type: "checkbox" }, id, parent });

/** Every place the creator UI draws a native checkbox, with the source line that builds it. */
const CHECKBOXES: [string, El][] = [
  ["index.html: the Advanced switch in the page header", checkbox(el("label", { classes: ["advanced-switch"], parent: header }), "advanced")],
  ["index.html: screenplay rights", checkbox(attestation(form), "rights")],
  ["index.html: render options, reuse unchanged shots", checkbox(attestation(el("details", { classes: ["render-options"], parent: form })), "reuse-unchanged")],
  ["studio.js: the front door's rights box", checkbox(el("label", { parent: el("li", { parent: el("ol", { classes: ["studio-questions"], parent: studioPanel }) }) }), "studio-rights")],
  ["studio.js: the front door's cast consent box", checkbox(el("label", { parent: studioPanel }), "studio-cast-attested")],
  ["casting.js: cast consent", checkbox(attestation(el("fieldset", { parent: castPanel })), "cast-attested")],
  ["casting.js: a grant on a character card", checkbox(attestation(el("div", { classes: ["cast-card"], parent: castPanel })))],
  ["character-sheets.js: a view to adopt", checkbox(attestation(el("div", { parent: castPanel })))],
  ["direction.js: a coverage checkbox", checkbox(attestation(el("div", { classes: ["cast-field"], parent: directionPanel })))],
  ["frame-anchors.js: anchor attestation", checkbox(attestation(el("div", { classes: ["anchor-row"], parent: directionPanel })), "anchor-attested")],
  ["actor-library.js: shared actor import", checkbox(attestation(creatorFlow))],
  ["scene-cuts.js: a scene cut attestation in shot direction", checkbox(attestation(el("div", { parent: directionPanel })))],
  ["performances.js: \"Direct line\" in shot direction", checkbox(el("div", { classes: ["cast-field"], parent: directionPanel }))],
  ["audio-studio.js: the voice studio", checkbox(el("div", { classes: ["cast-panel", "dialogue-workbench", "audio-studio"], parent: creatorFlow }))],
  ["sound-studio.js: the sound session", checkbox(el("div", { classes: ["motion-workbench", "sound-studio"], parent: creatorFlow }))],
  ["graphic-studio.js: the graphics desk", checkbox(el("div", { classes: ["motion-workbench", "graphic-studio"], parent: creatorFlow }))],
  ["take-player.js: the take desk's attestation", checkbox(attestation(el("div", { classes: ["take-workbench"], parent: directionPanel })))],
  ["living-script.js: the dialogue-revision studio", checkbox(el("div", { classes: ["living-script"], parent: creatorFlow }))],
];

test("every checkbox the creator UI draws is at least 24 by 24 CSS pixels, whichever panel draws it", () => {
  const sheet = rules(CREATOR);
  const small = CHECKBOXES.map(([where, e]) => ({ where, ...checkSize(sheet, e) }))
    .filter(({ width, height }) => width < MIN_TARGET_PX || height < MIN_TARGET_PX);
  expect(small).toEqual([]);
  // A radio button is the same native 13px square; none is drawn today, and one added outside a
  // sized panel is covered too.
  expect(checkSize(sheet, el("input", { attrs: { type: "radio" }, parent: el("label", { parent: studioPanel }) }))).toEqual({ width: 24, height: 24 });
  // The panels that already drew 44px keep 44px: the minimum raises, it never shrinks.
  expect(checkSize(sheet, CHECKBOXES.find(([where]) => where.startsWith("sound-studio"))![1])).toEqual({ width: 44, height: 44 });
  expect(UNKNOWN).toEqual([]);
});

test("a panel that draws a checkbox under 24 pixels is raised to 24, and without the minimum the browser's 13 shows through", () => {
  // The resolver measures rather than agrees. A later, more specific rule drawing a 16px box wins
  // the cascade for width and height, and the 24px minimum still raises it.
  const sheet = rules(CREATOR);
  const probe: Rule = { selector: ".cast-panel .attestation input", declarations: new Map([["width", { value: "16px", important: false }], ["height", { value: "16px", important: false }]]), order: sheet.length };
  expect(checkSize([...sheet, probe], CHECKBOXES[5]![1])).toEqual({ width: 24, height: 24 });
  // Take away every rule that sets a checkbox minimum and the front door's rights box is the
  // browser's own 13px square, which is what it was before this increment.
  const unsized = sheet.filter(rule => !(/checkbox/.test(rule.selector) && [...rule.declarations.keys()].some(key => key.startsWith("min-"))));
  expect(checkSize(unsized, CHECKBOXES[3]![1])).toEqual({ width: NATIVE_CHECK_PX, height: NATIVE_CHECK_PX });
});

/** Every kind of element a keyboard user reaches, in the panels that draw it. */
const FOCUSABLE: [string, El][] = [
  ["a primary button", el("button", { parent: form })],
  ["a secondary button", el("button", { classes: ["secondary"], parent: form })],
  ["a text input", el("input", { attrs: { type: "text" }, parent: form })],
  ["a checkbox", CHECKBOXES[1]![1]],
  ["the screenplay textarea", el("textarea", { id: "script", parent: form })],
  ["a link", el("a", { attrs: { href: "#" }, parent: creatorFlow })],
  ["a disclosure summary", el("summary", { parent: el("details", { parent: castPanel }) })],
  ["a select on the cast desk", el("select", { parent: castPanel })],
  ["a select in the voice studio", el("select", { parent: el("section", { classes: ["cast-panel", "dialogue-workbench", "audio-studio"], parent: creatorFlow }) })],
  ["a select in the sound session", el("select", { parent: el("section", { classes: ["motion-workbench", "sound-studio"], parent: creatorFlow }) })],
  ["a select in picture editorial", el("select", { parent: el("section", { classes: ["motion-workbench", "editorial-studio"], parent: creatorFlow }) })],
  ["a select in the assembly studio", el("select", { parent: el("div", { classes: ["edit-assemblies"], parent: el("section", { classes: ["motion-workbench", "editorial-studio"] }) }) })],
  ["a select in the graphics desk", el("select", { parent: el("section", { classes: ["motion-workbench", "graphic-studio"], parent: creatorFlow }) })],
  ["a select in the lip-sync desk", el("select", { parent: el("section", { classes: ["cast-panel", "lipsync-workbench"], parent: creatorFlow }) })],
  ["a select on the take desk", el("select", { parent: el("section", { classes: ["take-workbench"], parent: directionPanel }) })],
  ["a select in subject motion", el("select", { parent: el("section", { classes: ["motion-workbench"], parent: directionPanel }) })],
  ["the camera path's keyframe select", el("select", { id: "camera-keyframe", parent: el("details", { classes: ["camera-path-editor"], parent: directionPanel }) })],
  ["a studio step heading focus returns to", el("h2", { attrs: { tabindex: "-1" }, parent: studioPanel })],
  ["a cast card heading focus returns to", el("h3", { attrs: { tabindex: "-1" }, parent: castPanel })],
  ["the mask viewport", el("canvas", { attrs: { tabindex: "0" }, classes: ["mask-viewport"], parent: el("div", { classes: ["mask-workspace"] }) })],
  // HV-029-15's review comments: the reviewer's box, and the owner's list, whose timecode moves focus to the player.
  ["the reviewer's comment text", el("textarea", { id: "review-comment-text", parent: el("div", { id: "review-comment", parent: el("section", { id: "review-panel", classes: ["review-panel"] }) }) })],
  ["the reviewer's Comment at button", el("button", { id: "review-comment-pin", classes: ["secondary"], parent: el("div", { id: "review-comment" }) })],
  ["a comment's timecode button", el("button", { classes: ["secondary"], parent: el("li", { parent: el("ol", { parent: el("div", { id: "reviews-list", parent: el("section", { id: "reviews", parent: creatorFlow }) }) }) }) })],
  ["the export player a timecode focuses", el("video", { id: "player", attrs: { controls: "" }, parent: el("section", { id: "result", classes: ["result"], parent: creatorFlow }) })],
  ["a sound preview player", el("audio", { attrs: { controls: "" }, parent: el("div", { classes: ["speech-review"] }) })],
  // HV-016-33's line notes beside the screenplay: the request field, and a note's pressed Accept toggle.
  ["the line notes request field", el("input", { attrs: { type: "text" }, id: "line-notes-request", parent: el("div", { classes: ["cast-field"], parent: lineNotesPanel }) })],
  ["a line note's Accept toggle", el("button", { classes: ["secondary"], attrs: { type: "button", "aria-pressed": "true" }, parent: el("div", { classes: ["line-note-actions"], parent: el("li", { classes: ["line-note"], parent: lineNotesPanel }) }) })],
];

test("every element a keyboard user reaches in the creator UI draws the product's own focus ring", () => {
  const sheet = rules(CREATOR), tokens = palette();
  const missing = FOCUSABLE.map(([what, e]) => ({
    what,
    style: computed(sheet, e, "outline-style", ["focus", "focus-visible"]),
    width: px(computed(sheet, e, "outline-width", ["focus", "focus-visible"])) ?? 0,
    colour: /var\((--[a-z-]+)\)/.exec(computed(sheet, e, "outline-color", ["focus", "focus-visible"]) ?? "")?.[1],
  })).filter(({ style, width, colour }) => style !== "solid" || width < 2 || !colour || ratio(colour, "--bg", tokens) < 3 || ratio(colour, "--surface", tokens) < 3);
  expect(missing).toEqual([]);
  expect(UNKNOWN).toEqual([]);
});

test("the ring appears only with keyboard focus, so it tells the creator where focus is", () => {
  // A ring drawn in every state would satisfy the check above and show nothing.
  const sheet = rules(CREATOR);
  for (const [what, e] of FOCUSABLE) expect({ what, idle: computed(sheet, e, "outline-style") ?? "none" }).toEqual({ what, idle: "none" });
});

test("the operator console already drew a ring on everything it makes focusable, and still does", () => {
  const sheet = rules(OPERATOR), main = el("main");
  const reachable = [el("button", { parent: main }), el("button", { classes: ["secondary"], parent: main }), el("input", { attrs: { type: "text" }, parent: main }),
    el("summary", { parent: el("details", { parent: main }) }), el("a", { attrs: { href: "/" }, parent: el("header") }),
    el("div", { attrs: { tabindex: "0", role: "region" }, classes: ["table-scroll"], parent: main }), el("h3", { id: "trace-detail-title", attrs: { tabindex: "-1" }, parent: main })];
  for (const e of reachable) expect([e.tag, computed(sheet, e, "outline-style", ["focus", "focus-visible"]), computed(sheet, e, "outline-width", ["focus", "focus-visible"])]).toEqual([e.tag, "solid", "3px"]);
});

test("the resolver follows the cascade: specificity, then source order, then !important", () => {
  const sheet = rules(CREATOR);
  // `.cast-panel input:not([type=checkbox])` is 0,2,1 and outranks `input` alone, so a text input
  // on the cast desk is 44px tall and a checkbox there is not caught by that rule.
  expect(computed(sheet, el("input", { attrs: { type: "text" }, parent: castPanel }), "min-height")).toBe("44px");
  expect(computed(sheet, CHECKBOXES[5]![1], "min-height")).toBe("24px");
  // `.editorial-studio input[type=checkbox]` (0,2,1) beats `.editorial-studio input` (0,1,1) for width.
  expect(computed(sheet, checkbox(el("section", { classes: ["editorial-studio"] })), "width")).toBe("44px");
  // `[hidden] { display: none !important }` inside a panel wins over a later, more specific rule.
  expect(computed(sheet, el("div", { attrs: { hidden: "" }, parent: el("section", { classes: ["sound-studio"] }) }), "display")).toBe("none");
  expect(specificity("#creator-flow:has(.audio-studio:not([hidden]))")).toEqual([1, 2, 0]);
});
