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
 * - `current()` is `{text, version, saved}`: the script in the box, the saved version the page knows,
 *   and that version's text as the box last held it.
 * - `onApplying(on)` is told when an accept goes out and when it is answered, so the page can keep
 *   the box and its saves still meanwhile.
 * - `onApplied(version, {text})` reloads the studio's script once the server has made `version`.
 *   `text` is the box as it was when Apply was pressed: a box that differs is the writer's draft and
 *   is kept. It resolves to `{version, draft}`: the version the page now holds, and whether it kept a draft.
 * - `canEdit()` is false while another panel holds an unsaved edit.
 *
 * Returns `{panel, sync}`. The page calls `sync()` whenever the script may have changed, and notes
 * bound to anything else are set aside.
 */
export function initLineNotes({parent, prepare, request, current, onApplied, onApplying = () => {}, canEdit = () => true, personaTitles = {}}) {
  const node = (tag, text, className) => {const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element;};
  const panel = node("section", undefined, "line-notes"), heading = node("h2", "Line notes from the crew"), field = node("div", undefined, "cast-field");
  const label = node("label", "What should the crew work on? (optional)"), ask = node("input"), askButton = node("button", "Ask the crew for line notes");
  const status = node("p", "", "line-notes-status"), list = node("ol", undefined, "line-notes-list"), apply = node("button", "Apply accepted notes");
  heading.id = "line-notes-title"; heading.tabIndex = -1; panel.setAttribute("aria-labelledby", heading.id);
  ask.id = "line-notes-request"; ask.type = "text"; ask.maxLength = LINE_NOTES_REQUEST_MAX; ask.placeholder = "For example: tighten the dialogue"; label.htmlFor = ask.id;
  askButton.type = "button"; askButton.className = "secondary"; apply.type = "button";
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  field.append(label, ask);
  panel.append(heading, node("p", "The crew suggests changes to single lines of your saved script. Take the ones you want: nothing changes until you apply them.", "environment"),
    field, askButton, status, list, apply);
  parent.append(panel);

  /** The notes on screen, with the script they were written against and the ids the writer accepts. */
  let held = null, busy = false, applying = false, rows = [];
  const tell = (message, error = false) => {status.textContent = message; status.dataset.state = error ? "error" : "working";};
  const stale = () => {if (!held) return false; const now = current(); return now.version !== held.version || now.text !== held.text;};
  const setAside = message => {held = null; draw(); tell(message, true);};
  const plural = count => count + " note" + (count === 1 ? "" : "s");
  const within = (root, target) => Boolean(target) && (target === root || Array.from(root.children ?? []).some(child => within(child, target)));
  /** After a request, focus goes back to `target` only if it is in this panel or nowhere: a writer who moved on keeps their place. */
  const restore = target => {const active = document.activeElement; if (!active || active === document.body || within(panel, active)) target.focus();};

  /** The set of notes changed: rebuild the list. Focus that was in it goes to the panel's heading, never to the page's top. */
  function draw() {
    const lost = within(list, document.activeElement) || document.activeElement === apply;
    rows = [];
    list.replaceChildren();
    for (const note of held?.notes ?? []) {
      const item = node("li", undefined, "line-note"), actions = node("div", undefined, "line-note-actions"), state = node("p", "", "environment");
      const take = node("button", "Accept line " + note.line, "secondary"), skip = node("button", "Skip line " + note.line, "secondary");
      take.type = skip.type = "button";
      take.addEventListener("click", () => choose(note.id, true)); skip.addEventListener("click", () => choose(note.id, false));
      actions.append(take, skip);
      item.append(node("h3", "Line " + note.line + ", from the " + (personaTitles[note.persona] ?? note.persona)), node("p", "Why: " + note.reason),
        node("p", "Now: " + note.before, "line-note-text"), node("p", "Proposed: " + note.after, "line-note-text"), state, actions);
      list.append(item);
      rows.push({note, item, take, skip, state});
    }
    refresh();
    if (lost) heading.focus();
  }

  /** What is accepted, and what may be pressed, written onto the controls already on screen, so focus stays where it is. */
  function refresh() {
    for (const {note, item, take, skip, state} of rows) {
      const accepted = Boolean(held?.accepted.has(note.id));
      take.setAttribute("aria-pressed", String(accepted)); skip.setAttribute("aria-pressed", String(!accepted));
      take.disabled = skip.disabled = busy;
      item.dataset.accepted = String(accepted);
      state.textContent = accepted ? "Accepted" : "Skipped";
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
    refresh();
    const count = held.accepted.size;
    tell(count ? plural(count) + " accepted. Apply them to change the script." : "No notes accepted yet.");
  }

  askButton.addEventListener("click", async () => {
    if (busy) return;
    if (!canEdit()) {tell("Save or discard the open cast, shot, voice or picture edit before asking for line notes.", true); return;}
    busy = true; held = null; draw(); tell("Saving your script and asking the crew for line notes…");
    try {
      await prepare();
      const asked = current();
      // A save already in flight may have been of older text than the box holds now: the crew would read
      // one script and the notes would be bound to another, so nothing is asked.
      if (asked.text !== asked.saved) throw new Error("The script in the box changed while it was being saved, so the crew wasn't asked. Ask again.");
      const answer = readLineNotes(await request("", {request: ask.value.trim()}));
      if (!answer) throw new Error("The crew's answer couldn't be read. Try again; your script is unchanged.");
      // HV-016-35: with no notes left, the server's message already says how many were dropped and why.
      const dropped = answer.dropped > 0 && answer.notes.length ? " " + answer.dropped + " of the crew's notes couldn't be used and were left out." : "";
      // Notes on a script this page isn't showing would land on lines the writer can't see.
      const now = current();
      if (answer.script.version !== asked.version || now.version !== asked.version || now.text !== asked.text)
        tell("The script changed while the crew was reading it, so its notes were set aside. Ask the crew again.", true);
      else {
        if (answer.notes.length) held = {version: answer.script.version, sha256: answer.script.sha256, text: asked.text, notes: answer.notes, accepted: new Set()};
        tell(answer.message + dropped);
      }
    } catch (error) {tell(error.message || "The crew couldn't give line notes. Try again.", true);}
    finally {busy = false; draw(); restore(askButton);}
  });

  apply.addEventListener("click", async () => {
    if (busy || !held || !held.accepted.size) return;
    if (!canEdit()) {tell("Save or discard the open cast, shot, voice or picture edit before applying line notes.", true); return;}
    if (stale()) {setAside("The script changed after the crew wrote these notes, so they were set aside. Ask the crew again."); heading.focus(); return;}
    const taking = held, acceptedIds = taking.notes.map(note => note.id).filter(id => taking.accepted.has(id));
    // While the accept is out the box is held still (by the page), and a change the page reports is
    // judged when the answer comes back, against the text captured here.
    busy = applying = true; refresh(); onApplying(true); tell("Applying " + acceptedIds.length + " accepted note" + (acceptedIds.length === 1 ? "" : "s") + "…");
    let made;
    try {
      made = await request("/accept", {version: taking.version, sha256: taking.sha256, notes: taking.notes, acceptedIds});
    } catch (error) {
      busy = applying = false; onApplying(false);
      // 409: the saved script moved on. These notes can't land, so they go; asking again is the writer's call.
      if (error.status === 409) {setAside((error.message || "The script changed since the crew wrote these notes.") + " The notes were set aside; ask the crew again."); restore(heading);}
      else {refresh(); tell(error.message || "The notes couldn't be applied. Try again.", true); restore(apply);}
      return;
    }
    held = null;
    try {
      const shown = await onApplied(made.version, {text: taking.text}) ?? {version: made.version, draft: false};
      const now = shown.version === made.version ? "" : " The saved script is now version " + shown.version + ".";
      if (shown.draft) tell("Applied " + plural(acceptedIds.length) + " as version " + made.version + "." + now
        + " What you typed meanwhile is kept in the box as an unsaved draft; saving it replaces that version.", true);
      else tell("Applied " + plural(acceptedIds.length) + " as version " + made.version + "." + now);
    } catch (error) {
      tell("The notes were applied as version " + made.version + ", but the script couldn't be reloaded here (" + (error.message || "try again") + "). Reload the page to see it.", true);
    } finally {busy = applying = false; onApplying(false); draw(); restore(heading);}
  });

  draw();
  return {panel, get applying() {return applying;}, sync() {if (!applying && stale()) setAside("The script changed after the crew wrote these notes, so they were set aside. Ask the crew again.");}};
}
