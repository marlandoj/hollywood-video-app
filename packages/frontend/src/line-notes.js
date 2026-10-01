/**
 * HV-016-33 -- the crew's line notes in the studio.
 *
 * HV-016-32 gave the API a way for the crew to suggest one-line changes to the saved screenplay, and
 * for the writer to take only the ones they want (docs/CREW.md). This is the panel beside the script
 * where the writer does that:
 *
 * - "Ask the crew for line notes" saves the script in the box, then asks, with an optional "what to
 *   work on". Each note shows the line as it is now, the proposed line, and who suggests it and why.
 * - Every note starts skipped. Accept and Skip are a pair of pressed-state buttons; nothing changes
 *   until "Apply accepted notes", which is off while no note is accepted.
 * - The notes are bound to the script version (and text) they were written against. If the script
 *   changes in the studio after that -- typed in the box, or saved as a new version -- they are set
 *   aside, never sent. A 409 from the server says the same and sets them aside too; it is not retried.
 * - One request is in flight at a time, and a second click while it is out does nothing.
 *
 * Everything the crew or the server wrote is set with `textContent`, never as markup.
 */
import {applyBusy} from "./busy.js";

export const LINE_NOTES_SCHEMA = "hv-crew-line-notes/1";
export const LINE_NOTES_REQUEST_MAX = 300;

/** The crew's answer, if it is the shape the studio can show; otherwise null. */
export function readLineNotes(value) {
  if (!value || typeof value !== "object" || value.schema !== LINE_NOTES_SCHEMA || !Array.isArray(value.notes) || typeof value.message !== "string"
    || !value.script || !Number.isSafeInteger(value.script.version) || typeof value.script.sha256 !== "string") return null;
  const text = item => typeof item === "string";
  for (const note of value.notes)
    if (!note || !text(note.id) || !text(note.persona) || !Number.isSafeInteger(note.line) || !text(note.before) || !text(note.after) || !text(note.reason)) return null;
  return value;
}

/**
 * Draws the panel into `parent`.
 *
 * - `prepare()` saves the script in the box (and makes the project if there is none).
 * - `request(suffix, body)` posts `body` to `…/crew/line-notes` + `suffix` and resolves to the
 *   server's answer, or throws an error carrying the server's message and `status`.
 * - `current()` is `{text, version}`: the script in the box and the saved version the page knows.
 * - `onApplied(version)` reloads the studio's script once the server has made `version`.
 * - `canEdit()` is false while another panel holds an unsaved edit.
 *
 * Returns `{panel, sync}`. The page calls `sync()` whenever the script may have changed, and notes
 * bound to anything else are set aside.
 */
export function initLineNotes({parent, prepare, request, current, onApplied, canEdit = () => true, personaTitles = {}}) {
  const node = (tag, text, className) => {const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;};
  const panel = node("section", undefined, "line-notes"), heading = node("h2", "Line notes from the crew"), field = node("div", undefined, "cast-field");
  const label = node("label", "What should the crew work on? (optional)"), ask = node("input"), askButton = node("button", "Ask the crew for line notes");
  const status = node("p", "", "line-notes-status"), list = node("ol", undefined, "line-notes-list"), apply = node("button", "Apply accepted notes");
  heading.id = "line-notes-title"; panel.setAttribute("aria-labelledby", heading.id);
  ask.id = "line-notes-request"; ask.type = "text"; ask.maxLength = LINE_NOTES_REQUEST_MAX; ask.placeholder = "For example: tighten the dialogue"; label.htmlFor = ask.id;
  askButton.type = "button"; askButton.className = "secondary"; apply.type = "button";
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  field.append(label, ask);
  panel.append(heading, node("p", "The crew suggests changes to single lines of your saved script. Take the ones you want: nothing changes until you apply them.", "environment"),
    field, askButton, status, list, apply);
  parent.append(panel);

  /** The notes on screen, with the script they were written against and the ids the writer accepts. */
  let held = null, busy = false;
  const tell = (message, error = false) => {status.textContent = message; status.dataset.state = error ? "error" : "working";};
  const stale = () => {if (!held) return false; const now = current(); return now.version !== held.version || now.text !== held.text;};
  const setAside = message => {held = null; draw(); tell(message, true);};

  function draw() {
    list.replaceChildren();
    for (const note of held?.notes ?? []) {
      const accepted = held.accepted.has(note.id), item = node("li", undefined, "line-note"), actions = node("div", undefined, "line-note-actions");
      const take = node("button", "Accept line " + note.line, "secondary"), skip = node("button", "Skip line " + note.line, "secondary");
      take.type = skip.type = "button";
      take.setAttribute("aria-pressed", String(accepted)); skip.setAttribute("aria-pressed", String(!accepted));
      take.disabled = skip.disabled = busy;
      take.addEventListener("click", () => choose(note.id, true)); skip.addEventListener("click", () => choose(note.id, false));
      actions.append(take, skip);
      item.dataset.accepted = String(accepted);
      item.append(node("h3", "Line " + note.line + ", from the " + (personaTitles[note.persona] ?? note.persona)), node("p", "Why: " + note.reason),
        node("p", "Now: " + note.before, "line-note-text"), node("p", "Proposed: " + note.after, "line-note-text"),
        node("p", accepted ? "Accepted" : "Skipped", "environment"), actions);
      list.append(item);
    }
    list.hidden = !held?.notes.length;
    apply.hidden = !held?.notes.length;
    apply.disabled = busy || !held?.accepted.size;
    askButton.disabled = ask.disabled = busy;
    applyBusy(panel, busy);
  }

  function choose(id, take) {
    if (busy || !held) return;
    if (stale()) {setAside("The script changed after the crew wrote these notes, so they were set aside. Ask the crew again."); return;}
    if (take) held.accepted.add(id); else held.accepted.delete(id);
    draw();
    const count = held.accepted.size;
    tell(count ? count + " note" + (count === 1 ? "" : "s") + " accepted. Apply them to change the script." : "No notes accepted yet.");
  }

  askButton.addEventListener("click", async () => {
    if (busy) return;
    if (!canEdit()) {tell("Save or discard the open cast, shot, voice or picture edit before asking for line notes.", true); return;}
    busy = true; held = null; draw(); tell("Saving your script and asking the crew for line notes…");
    try {
      await prepare();
      const asked = current();
      const answer = readLineNotes(await request("", {request: ask.value.trim()}));
      if (!answer) throw new Error("The crew's answer couldn't be read. Try again; your script is unchanged.");
      const dropped = answer.dropped > 0 ? " " + answer.dropped + " of the crew's notes couldn't be used and were left out." : "";
      // Notes on a script this page isn't showing would land on lines the writer can't see.
      const now = current();
      if (answer.script.version !== asked.version || now.version !== asked.version || now.text !== asked.text)
        tell("The script changed while the crew was reading it, so its notes were set aside. Ask the crew again.", true);
      else {
        if (answer.notes.length) held = {version: answer.script.version, sha256: answer.script.sha256, text: asked.text, notes: answer.notes, accepted: new Set()};
        tell(answer.message + dropped);
      }
    } catch (error) {tell(error.message || "The crew couldn't give line notes. Try again.", true);}
    finally {busy = false; draw();}
  });

  apply.addEventListener("click", async () => {
    if (busy || !held || !held.accepted.size) return;
    if (!canEdit()) {tell("Save or discard the open cast, shot, voice or picture edit before applying line notes.", true); return;}
    if (stale()) {setAside("The script changed after the crew wrote these notes, so they were set aside. Ask the crew again."); return;}
    const taking = held, acceptedIds = taking.notes.map(note => note.id).filter(id => taking.accepted.has(id));
    busy = true; draw(); tell("Applying " + acceptedIds.length + " accepted note" + (acceptedIds.length === 1 ? "" : "s") + "…");
    let made;
    try {
      made = await request("/accept", {version: taking.version, sha256: taking.sha256, notes: taking.notes, acceptedIds});
    } catch (error) {
      busy = false;
      // 409: the saved script moved on. These notes can't land, so they go; asking again is the writer's call.
      if (error.status === 409) setAside((error.message || "The script changed since the crew wrote these notes.") + " The notes were set aside; ask the crew again.");
      else {draw(); tell(error.message || "The notes couldn't be applied. Try again.", true);}
      return;
    }
    held = null;
    try {
      await onApplied(made.version);
      tell("Applied " + acceptedIds.length + " note" + (acceptedIds.length === 1 ? "" : "s") + ". The script is now version " + made.version + ".");
    } catch (error) {
      tell("The notes were applied as version " + made.version + ", but the script couldn't be reloaded here (" + (error.message || "try again") + "). Reload the page to see it.", true);
    } finally {busy = false; draw();}
  });

  draw();
  return {panel, sync() {if (stale()) setAside("The script changed after the crew wrote these notes, so they were set aside. Ask the crew again.");}};
}
