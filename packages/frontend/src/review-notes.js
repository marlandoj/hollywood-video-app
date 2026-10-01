/**
 * HV-029-15 -- timecoded review comments on screen.
 *
 * The review page lets a reviewer who may decide pin a comment to the frame on screen. The owner's
 * export shows every review link's comments and decisions by stage; a comment's timecode moves the
 * owner's player to that frame, and the owner resolves it. Frames are counted at the studio's 30 fps,
 * as the server counts them (packages/api/src/review-comments.ts). Everything a reviewer wrote is set
 * as text, never as markup.
 */
export const REVIEW_FPS = 30;
export const REVIEW_COMMENT_MAX_CHARS = 500;

/**
 * The frame on screen at `seconds`. `currentTime * 30` is not exact in floating point -- 2.3 s is
 * 68.99999999999999 frames -- so a hair of tolerance keeps it on frame 69 rather than the one before.
 */
export function frameAt(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * REVIEW_FPS + 1e-6) : 0;
}
/** Where to seek to show `frame`: its middle, so `frameAt(secondsAt(frame)) === frame` for every frame. */
export function secondsAt(frame) {
  return (frame + 0.5) / REVIEW_FPS;
}
/** HH:MM:SS:FF at 30 fps. */
export function timecode(frame) {
  const pad = value => String(value).padStart(2, "0"), seconds = Math.floor(frame / REVIEW_FPS);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, frame % REVIEW_FPS].map(pad).join(":");
}

/**
 * The reviewer's comment box. It stays hidden and off until `enable()` -- the cut is showing and
 * the link may comment. Typing pauses the cut, so the comment is pinned to the frame the reviewer
 * stopped on; the frame is read at the click, before the request goes out, and one comment is in
 * flight at a time. `send({frame, text})` resolves to the server's `{comment}`.
 */
export function initReviewComments({box, text, pin, list, status, player, send}) {
  let enabled = false, sending = false;
  const refresh = () => {pin.textContent = "Comment at " + timecode(frameAt(player.currentTime)); pin.disabled = !enabled || sending;};
  for (const type of ["timeupdate", "seeked", "pause", "loadedmetadata"]) player.addEventListener(type, refresh);
  text.addEventListener("focus", () => player.pause());
  pin.addEventListener("click", async () => {
    if (pin.disabled) return;
    const value = text.value.trim();
    if (!value) {status.textContent = "Write a comment first."; return;}
    if (Array.from(value).length > REVIEW_COMMENT_MAX_CHARS) {status.textContent = "Keep a comment to " + REVIEW_COMMENT_MAX_CHARS + " characters."; return;}
    const frame = frameAt(player.currentTime);
    sending = true; refresh();
    try {
      const {comment} = await send({frame, text: value});
      const item = document.createElement("li");
      item.textContent = timecode(comment.frame) + " — " + comment.text;
      list.append(item);
      text.value = "";
      status.textContent = "Comment pinned at " + timecode(comment.frame) + ".";
    } catch (error) {
      status.textContent = error.message || "The comment could not be saved.";
    } finally {sending = false; refresh();}
  });
  refresh();
  return {enable() {enabled = true; box.hidden = false; refresh();}};
}

const DECISIONS = {approved: "approved", changes_requested: "changes requested"};

/** One stage's line: its counts and latest decision, or that none was made. */
export function stageLine(stage) {
  if (!stage.latest) return stage.label + ": no decision yet.";
  return stage.label + ": " + stage.approved + " approved, " + stage.changesRequested + " changes requested; latest " + DECISIONS[stage.latest.decision] + ".";
}

/**
 * The owner's reviews of this project into `container`: decisions per stage, then each comment
 * with its timecode, the link viewer who wrote it, and a Resolve/Reopen button. A timecode jumps
 * `player` only when the comment is on `shownJobId`, the cut the player is showing; a comment on
 * another cut says so. `resolve(id, resolved)` resolves to the server's `{comment}`.
 *
 * HV-039-25: the comments are an `ol`, so each shows its number. Both of a row's buttons name that
 * number and the timecode -- "Resolve comment 3 at 00:00:02:09" -- so a screen reader's list of
 * buttons tells twelve comments apart. Each name starts with or contains the words on the button
 * (WCAG 2.5.3), so a speech user can still say "Resolve".
 */
export function renderOwnerReviews({container, reviews, player, shownJobId, resolve, status}) {
  const make = (tag, text) => {const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;};
  const stages = make("ul");
  stages.append(...reviews.stages.map(stage => make("li", stageLine(stage))));
  const comments = make("ol"), rows = [];
  for (const link of reviews.links) for (const comment of [...link.comments].sort((a, b) => a.frame - b.frame)) {
    const row = make("li"), here = link.jobId === shownJobId, number = rows.length + 1;
    const jump = make("button", comment.timecode);
    jump.type = "button"; jump.className = "secondary"; jump.disabled = !here;
    jump.setAttribute("aria-label", here ? "Play comment " + number + " from " + comment.timecode : "Comment " + number + ", " + comment.timecode + ", is on another cut");
    jump.addEventListener("click", () => {if (jump.disabled) return; player.pause(); player.currentTime = secondsAt(comment.frame); player.focus();});
    const words = make("span", (comment.viewer ? "Viewer " + comment.viewer + ": " : "") + comment.text + (here ? "" : " (on another cut)"));
    const toggle = make("button");
    toggle.type = "button"; toggle.className = "secondary";
    let resolved = comment.resolvedAt !== null;
    const label = () => {toggle.textContent = resolved ? "Reopen" : "Resolve"; toggle.setAttribute("aria-label", toggle.textContent + " comment " + number + " at " + comment.timecode); row.dataset.resolved = String(resolved);};
    toggle.addEventListener("click", async () => {
      if (toggle.disabled) return;
      toggle.disabled = true;
      try {resolved = (await resolve(comment.id, !resolved)).comment.resolvedAt !== null; label(); status.textContent = resolved ? "Comment resolved." : "Comment reopened.";}
      catch (error) {status.textContent = error.message || "The comment could not be updated.";}
      finally {toggle.disabled = false;}
    });
    label();
    row.append(jump, words, toggle);
    rows.push(row);
  }
  comments.append(...rows);
  container.replaceChildren(stages, rows.length ? comments : make("p", "No review comments yet."));
  return rows.length;
}
