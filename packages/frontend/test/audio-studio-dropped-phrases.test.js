/**
 * HV-024-05 — the studio said a phrase direction had been dropped, and then said something else.
 *
 * HV-024-04 kept the phrase directions an edit leaves standing, dropped the rest, and told the
 * creator how many went:
 *
 *     function retext(text){
 *       const dropped=phraseEditor.retext(text);
 *       if(dropped)tell(dropped+" phrase direction"+…+" removed because the words "+…+" changed. …");
 *     }
 *
 * Every path that can reach `retext` reaches `editChanged` immediately afterwards, and `editChanged`
 * ends with `tell("Review this line's settings before generating an audition.")`:
 *
 * - `language.onchange` calls `retext(...)` and then `editChanged()` outright;
 * - `narrationText.oninput` does the same;
 * - `translation` sits inside the `settings` fieldset, and `settings.addEventListener("input",
 *   editChanged)` fires after the target's own handler.
 *
 * So the sentence was written and overwritten on all three, every time. HV-024-04's acceptance
 * criterion — "editing a word inside one phrase costs that one and reports one" — was true of the
 * retention and false of the report, and its headline, "the studio says so", was not made good on.
 * Nothing caught it because nothing in this repository mounted the voice studio: the defect is not
 * inside any function, it is the order in which two handlers for one gesture write the same line.
 */
import {expect, test} from "bun:test";
import {initAudioStudio} from "../src/audio-studio.js";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

/** The voice studio, mounted, with the controls this test drives found by their labels. */
function studio() {
  const restore = mountDom();
  const parent = new Element("div");
  const view = initAudioStudio({parent, prepare: async () => {}, prepareGeneration: async () => {}, request: async () => ({characters: [], lines: [], scenes: [], jobs: [], voices: [], enabled: true}),
    saveVoice: async () => ({casting: {version: 1}}), savePerformance: async () => ({}), projectId: () => "p1", assetUrl: url => String(url), canEdit: () => true, changed: () => {}});
  const all = tree(parent);
  const labelled = text => {
    const label = all.find(element => element.tag === "label" && element.textContent === text);
    return all.find(element => element.attributes === undefined ? false : element.id === label?.htmlFor);
  };
  const status = all.find(element => element.getAttribute("role") === "status");
  return {view, parent, all, status, labelled, restore,
    button: label => all.find(element => element.tag === "button" && element.textContent === label)};
}

/**
 * Direct words `from`–`to` of the line draft at a slower speed, through the phrase editor's own UI.
 *
 * Awaited, because every button in this panel goes through `run`, which refuses to start while the
 * previous one is in flight -- a second phrase applied in the same turn is simply ignored.
 */
async function directPhrase(s, from, to) {
  s.labelled("Phrase first word").value = String(from);
  s.labelled("Phrase last word").value = String(to);
  s.labelled("Phrase speed multiplier").value = "1.2";
  s.button("Apply phrase to line draft").onclick();
  await settle();
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("a phrase direction an edit dropped is reported, and not written over by the generic line", async () => {
  const s = studio();
  try {
    const translation = s.labelled("Reviewed translation");
    // The line draft, and a direction on its first two words.
    fire(translation, "input", "the quick brown fox");
    await directPhrase(s, 0, 1);
    expect(s.status.textContent).toBe("Review this line's settings before generating an audition.");
    // Now the words that direction names change. One direction cannot survive that, and this is the
    // sentence HV-024-04 wrote and never managed to leave on the screen.
    fire(translation, "input", "a quick brown fox");
    expect(s.status.textContent).toBe("1 phrase direction was removed because the words it names changed. "
      + "Review this line's settings before generating an audition.");
    expect(s.status.dataset.state).not.toBe("error");
  } finally { s.restore(); }
});

test("and it is reported in the plural, and from the narration box as well as the translation box", async () => {
  const s = studio();
  try {
    // Narration takes the other route into `retext`: its own handler calls `editChanged` outright
    // rather than relying on the fieldset above it, and it was overwritten just the same.
    const narration = s.labelled("Narration text");
    fire(narration, "input", "the quick brown fox jumps");
    await directPhrase(s, 0, 1);
    await directPhrase(s, 2, 3);
    fire(narration, "input", "a swift brown fox jumps");
    expect(s.status.textContent).toBe("2 phrase directions were removed because the words they name changed. "
      + "Review this line's settings before generating an audition.");
  } finally { s.restore(); }
});

test("and an edit that costs nothing says nothing about phrases", async () => {
  // The notice is news. Typing at the end of a line leaves every earlier direction exactly where it
  // was -- which is what HV-024-04 is for -- and a studio that reported a loss there would be wrong.
  const s = studio();
  try {
    const translation = s.labelled("Reviewed translation");
    fire(translation, "input", "the quick brown fox");
    await directPhrase(s, 0, 1);
    fire(translation, "input", "the quick brown fox jumps");
    expect(s.status.textContent).toBe("Review this line's settings before generating an audition.");
  } finally { s.restore(); }
});

test("and a loss is still reported after an unrelated edit, until the draft itself is discarded", async () => {
  // It outlives the keystroke that caused it, because the direction is still gone. What ends it is
  // the draft ending: discarding resets to the saved defaults, and there is nothing left to have
  // lost.
  const s = studio();
  try {
    const translation = s.labelled("Reviewed translation");
    fire(translation, "input", "the quick brown fox");
    await directPhrase(s, 0, 1);
    fire(translation, "input", "a quick brown fox");
    fire(s.labelled("Speed multiplier"), "input", "1.1");
    expect(s.status.textContent).toContain("1 phrase direction was removed");
    s.button("Discard unsubmitted changes").onclick();
    await settle();
    fire(s.labelled("Speed multiplier"), "input", "1.2");
    expect(s.status.textContent).toBe("Review this line's settings before generating an audition.");
  } finally { s.restore(); }
});

test("and the sentence is written in one place, so the two paths cannot come to say it differently", () => {
  // `retext` no longer writes the status at all: `editChanged` is the only thing that writes it for
  // an edit, which is what stops an ordering between a handler and a bubbled listener from covering
  // it. Guarded on the source, because the failure mode is a second `tell` reappearing next to it.
  const source = require("node:fs").readFileSync(new URL("../src/audio-studio.js", import.meta.url), "utf8");
  const retext = source.slice(source.indexOf("  function retext("), source.indexOf("  settings.addEventListener("));
  expect(retext).not.toContain("tell(");
  expect(retext).toContain("editChanged()");
  const code = source.replaceAll(/^\s*\*.*$/gm, "").replaceAll(/\/\/.*$/gm, "");
  expect(code.split("phrase direction").length - 1).toBe(1);
});
