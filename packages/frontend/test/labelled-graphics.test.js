/**
 * HV-039-24 — The preview pictures and the sound timeline's cues had names no screen reader was given.
 *
 * Three graphics in the creator UI were given a text alternative as `aria-label` on an element with
 * no role:
 *
 *     canvas.setAttribute('aria-label','Preview of the '+savedName);                  // preview-controller.js
 *     canvas.setAttribute('aria-label','Version '+(index?'B':'A')+' picture');         // preview-comparison.js
 *     const bar=node("span",c.asset.label);...bar.setAttribute("aria-label",bar.title); // sound-studio.js
 *
 * A `canvas`, `span` or `div` has no role a name can attach to. ARIA 1.2 prohibits naming `generic`,
 * and browsers drop the name from the accessibility tree, so the alternative text never reached
 * anyone (WCAG 1.1.1). The editorial preview and the comparison were unnamed blank areas. A sound
 * cue was read as its asset's label alone. Its role, start, end and level ("Rain · ambience ·
 * 1.000–4.500 s · -12 dB") reached only a mouse user who hovered for the `title`.
 *
 * Each is now `role="img"`, which takes the name and presents it as the picture's alternative. The
 * same family guard found a fourth instance, the cast desk's "Project cast" `div`
 * (`casting.js`), which is now `role="group"`.
 */
import {expect, test} from "bun:test";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {mountEditorialPreview} from "../src/preview-controller.js";
import {mountEditorialComparison} from "../src/preview-comparison.js";
import {Element, mountDom, tree} from "./audio-studio-dom.js";

const SRC = join(import.meta.dir, "..", "src");

/** Elements whose implicit role is `generic` or none, so an `aria-label` on them is not exposed. */
const UNNAMEABLE = /^(?:span|div|canvas|p|b|i|strong|em|small|label)$/;

/** Every element a mount built that carries `aria-label`, with the role a name would attach to. */
function labelled(parent) {
  return tree(parent).filter(e => e.getAttribute("aria-label") !== null)
    .map(e => ({tag: e.tag, role: e.getAttribute("role"), name: e.getAttribute("aria-label")}));
}

/** The preview panels mount on the DOM stub given a 2D context and animation-frame cancelling. */
function withPanels(run) {
  const restore = mountDom(), saved = globalThis.cancelAnimationFrame;
  Element.prototype.getContext = () => new Proxy({}, {get: (target, key) => target[key] ?? (() => {})});
  globalThis.cancelAnimationFrame = () => {};
  try {return run();} finally {delete Element.prototype.getContext; globalThis.cancelAnimationFrame = saved; restore();}
}

test("the editorial preview's picture is an image with a name, not an unnamed canvas", () => {
  withPanels(() => {
    const parent = new Element("div");
    mountEditorialPreview({parent, client: () => ({}), current: () => null});
    const assembly = new Element("div");
    mountEditorialPreview({parent: assembly, client: () => ({}), current: () => null, assembly: true});
    expect(labelled(parent).filter(e => e.tag === "canvas")).toEqual([{tag: "canvas", role: "img", name: "Preview of the saved cut"}]);
    expect(labelled(assembly).filter(e => e.tag === "canvas")).toEqual([{tag: "canvas", role: "img", name: "Preview of the saved assembly"}]);
    // Nothing else the panel names is left on an element that cannot carry the name.
    expect([...labelled(parent), ...labelled(assembly)].filter(e => UNNAMEABLE.test(e.tag) && !e.role)).toEqual([]);
  });
});

test("both pictures of a rendered-version comparison are images named A and B", () => {
  withPanels(() => {
    const parent = new Element("div");
    const cut = jobId => ({jobId, outputRevision: "o", timeline: {width: 1920, height: 1080, frames: 90, revision: "t"}, sequence: {id: "s", label: "Main cut", history: {revision: "h"}}});
    mountEditorialComparison({parent, client: () => ({}), current: () => null, cuts: [cut("aaaaaaaa1"), cut("bbbbbbbb2")]});
    expect(labelled(parent).filter(e => e.tag === "canvas")).toEqual([
      {tag: "canvas", role: "img", name: "Version A picture"},
      {tag: "canvas", role: "img", name: "Version B picture"},
    ]);
    expect(labelled(parent).filter(e => UNNAMEABLE.test(e.tag) && !e.role)).toEqual([]);
  });
});

/**
 * The family, across every module: a variable made only as a generic element and given
 * `aria-label` must also be given a role. Read from source, because the sound timeline is drawn
 * only once a retained session has a quote and cues, which no DOM test builds yet. The scan is per
 * variable name, and a name that is also used for a named element (such as `value`, a `video` in
 * living-script.js) is left out rather than guessed at.
 */
function namedGenerics(text) {
  const tags = new Map();
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:node|document\.createElement)\(\s*['"]([a-z][a-z0-9]*)['"]/g)) tags.set(m[1], [...(tags.get(m[1]) ?? []), m[2]]);
  const roled = new Set([...text.matchAll(/([A-Za-z_$][\w$]*)\.setAttribute\(\s*['"]role['"]/g)].map(m => m[1]));
  return [...new Set([...text.matchAll(/([A-Za-z_$][\w$]*)\.setAttribute\(\s*['"]aria-label['"]/g)].map(m => m[1]))]
    .filter(name => tags.get(name)?.every(tag => UNNAMEABLE.test(tag)) && !roled.has(name));
}

test("no module names a span, div or canvas without giving it a role the name can attach to", () => {
  const offenders = readdirSync(SRC).filter(file => file.endsWith(".js"))
    .flatMap(file => namedGenerics(readFileSync(join(SRC, file), "utf8")).map(name => file + ": " + name));
  expect(offenders).toEqual([]);
  // The scan bites: each shape it has to catch, and the two it must not.
  expect(namedGenerics(`const bar=node("span","Rain");bar.setAttribute("aria-label","Rain, 1 to 4 s");`)).toEqual(["bar"]);
  expect(namedGenerics(`const c=document.createElement('canvas');c.setAttribute('aria-label','Preview');`)).toEqual(["c"]);
  expect(namedGenerics(`const c=node('canvas');c.setAttribute('role','img');c.setAttribute('aria-label','Preview');`)).toEqual([]);
  expect(namedGenerics(`const v=node('div');const f=()=>{const v=node('video');v.setAttribute('aria-label','Take');};`)).toEqual([]);
});

test("the sound timeline's cue is an image whose name is its whole description", () => {
  // Pinned from source because the timeline needs a quoted session to draw (see above): the bar
  // takes role img and the same description its title shows, so hovering and hearing agree.
  const source = readFileSync(join(SRC, "sound-studio.js"), "utf8");
  const bar = source.slice(source.indexOf('const bar=node("span"'), source.indexOf("track.append(bar)"));
  expect(bar).toContain('bar.title=cueDescription(c);bar.setAttribute("role","img");bar.setAttribute("aria-label",bar.title);');
});

test("no element in index.html is named without a role, and the storyboard is a named group", () => {
  // HV-039-25. `<div id="storyboard" aria-label="Storyboard by scene">` named a generic element, so
  // the name was dropped. It is now `role="group"`, as HV-039-24 made the cast desk's "Project
  // cast": the animatic section around it is already a named region, so a second landmark would
  // only add noise. The scan is now a guard over the whole page.
  const scan = text => [...text.matchAll(/<(span|div|p|canvas)\b[^>]*\baria-label=[^>]*>/g)].map(m => m[0]).filter(tag => !/\brole=/.test(tag));
  const page = readFileSync(join(SRC, "index.html"), "utf8");
  expect(scan(page)).toEqual([]);
  expect(page).toContain('<div id="storyboard" role="group" aria-label="Storyboard by scene">');
  // The scan bites on the shape it refuses.
  expect(scan('<div id="storyboard" aria-label="Storyboard by scene">')).toHaveLength(1);
  expect(scan('<div role="group" aria-label="x">')).toEqual([]);
});
