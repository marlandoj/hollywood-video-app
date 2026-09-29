/**
 * HV-029-12 — a review link's Approve cut / Request changes were live with no cut on screen, and both
 * could be sent.
 *
 * `openReview` in `index.html` loads the cut and wires the two decision buttons independently:
 *
 *     api(`/api/reviews/${token}`, ...).then(view => { ...attach the player... }).catch(error => { ...say so... });
 *     panel.querySelectorAll("button[data-decision]").forEach(button => button.addEventListener("click", async () => {
 *       try { await api(`/api/reviews/${token}/decision`, ...); ...disable every button... }
 *       catch (error) { ...say so... }
 *     }));
 *
 * Nothing disabled the buttons until a decision had been *recorded*. So:
 *
 * - **Before the cut loaded**, a reviewer could approve a cut they had not seen.
 * - **After the view failed** ("review link is invalid, expired, revoked, or fully used"), both
 *   buttons stayed live under that message, which suggests the link is still good for a decision.
 * - **While a decision was in flight**, the other button was still live. Approve followed by
 *   Request changes before the first reply sent both, and the reviewer's last word depended on
 *   which reply the server handled second.
 *
 * Both buttons now start disabled and are enabled only once the cut has loaded. A click disables
 * both before its request goes out. A refused decision enables them again, with the server's reason,
 * so the reviewer can try again.
 */
import {expect, test} from "bun:test";
import {openDesk, ok, refused, pathOf} from "./desk-page.js";

const VIEW = {stage: "final", viewsRemaining: 2, output: {hlsUrl: "/h", mp4Url: "/m", captionsUrl: "/c"}};

/** Open `#/review/tok` with the view answered by `viewAnswer()` and each decision by `decisionAnswer(n)`. */
async function openReview(viewAnswer, decisionAnswer = async () => ok({accepted: true})) {
  let approve, changes; const decisions = [];
  const fetch = async (url, options = {}) => {
    const path = pathOf(url);
    if (path === "/api/reviews/tok") return viewAnswer();
    if (path === "/api/reviews/tok/decision") {decisions.push(JSON.parse(options.body).decision); return decisionAnswer(decisions.length);}
    return ok({});
  };
  const desk = await openDesk({hash: "#/review/tok", fetch, setup: (q, make) => {
    approve = make("button"); approve.dataset.decision = "approved";
    changes = make("button"); changes.dataset.decision = "changes_requested";
    q("#review-panel").select = selector => selector === "button[data-decision]" || selector === "button" ? [approve, changes] : [];
  }});
  return {desk, approve, changes, decisions, status: desk.q("#review-status")};
}

test("Approve cut and Request changes stay off until the cut has loaded, and come on when it has", async () => {
  let show; const shown = new Promise(resolve => {show = resolve;});
  const review = await openReview(() => shown);
  try {
    await review.desk.settle(5);
    expect(review.approve.disabled).toBe(true);
    expect(review.changes.disabled).toBe(true);
    show(ok(VIEW)); await review.desk.settle();
    expect(review.status.textContent).toContain("Reviewing the final cut");
    expect(review.approve.disabled).toBe(false);
    expect(review.changes.disabled).toBe(false);
  } finally {review.desk.restore();}
});

test("a review link that could not show the cut does not leave Approve cut or Request changes live", async () => {
  const review = await openReview(async () => refused(403, "review link is invalid, expired, revoked, or fully used"));
  try {
    await review.desk.settle();
    expect(review.status.textContent).toContain("fully used");
    expect(review.approve.disabled).toBe(true);
    expect(review.changes.disabled).toBe(true);
    // And a click that reaches the handler anyway sends nothing.
    review.approve.listeners.click[0](); await review.desk.settle();
    expect(review.decisions).toEqual([]);
  } finally {review.desk.restore();}
});

test("a decision in flight holds both buttons off, so the opposite decision cannot follow it", async () => {
  let reply; const replied = new Promise(resolve => {reply = resolve;});
  const review = await openReview(async () => ok(VIEW), () => replied);
  try {
    await review.desk.settle();
    review.approve.listeners.click[0]();          // Approve cut ...
    await review.desk.settle(5);
    expect(review.approve.disabled).toBe(true);
    expect(review.changes.disabled).toBe(true);
    review.changes.listeners.click[0]();          // ... and, before the reply, Request changes.
    reply(ok({accepted: true})); await review.desk.settle();
    expect(review.decisions).toEqual(["approved"]);
    expect(review.status.textContent).toBe("Cut approved.");
    expect(review.approve.disabled).toBe(true);
    expect(review.changes.disabled).toBe(true);
  } finally {review.desk.restore();}
});

test("a decision the server refused turns both buttons back on with its reason, and the reviewer can decide again", async () => {
  let reply; const replied = new Promise(resolve => {reply = resolve;});
  const review = await openReview(async () => ok(VIEW), n => n === 1 ? replied : ok({accepted: true}));
  try {
    await review.desk.settle();
    review.changes.listeners.click[0]();
    await review.desk.settle(5);
    expect(review.approve.disabled).toBe(true);
    expect(review.changes.disabled).toBe(true);
    reply(refused(503, "The review service is busy. Try again.")); await review.desk.settle();
    expect(review.status.textContent).toBe("The review service is busy. Try again.");
    expect(review.approve.disabled).toBe(false);
    expect(review.changes.disabled).toBe(false);
    review.changes.listeners.click[0](); await review.desk.settle();
    expect(review.decisions).toEqual(["changes_requested", "changes_requested"]);
    expect(review.status.textContent).toBe("Changes requested.");
  } finally {review.desk.restore();}
});
