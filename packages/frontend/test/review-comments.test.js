/**
 * HV-029-15 — timecoded review comments and per-stage approvals on screen.
 *
 * HV-029-14 gave the API what a reviewer needs to say *where* in a cut, and what the owner needs to
 * see the answer: comments pinned to 30 fps frames of the link's bound cut, resolvable by the owner,
 * and decisions recorded per stage. Neither screen used them. The review page offered two decision
 * buttons and one status line; the owner's export showed nothing a reviewer had said.
 *
 * The review page now has a comment box. It appears once the cut is on screen and the link may
 * decide. Typing pauses the cut, and the pin button names the frame on screen, which is sent. The
 * owner's export lists decisions per stage and every comment. A comment's timecode moves the player
 * to that exact frame, when the comment is on the cut the player is showing. Resolve and Reopen
 * go to the server.
 *
 * The pure frame arithmetic is tested directly; the wiring runs `index.html`'s own module script
 * through `desk-page.js`, with the real `review-notes.js`.
 */
import {expect, test} from "bun:test";
import {openDesk, ok, refused, pathOf} from "./desk-page.js";
import {frameAt, secondsAt, stageLine, timecode} from "../src/review-notes.js";

/** The server's own arithmetic, so the page and the API cannot disagree about a frame. */
import {reviewTimecode} from "../../api/src/review-comments.ts";

test("the frame on screen and the seek to a frame agree for every frame, and read as the server's timecode", () => {
  for (let frame = 0; frame < 30 * 60 * 10; frame++) {
    expect(frameAt(secondsAt(frame))).toBe(frame);
    expect(timecode(frame)).toBe(reviewTimecode(frame));
  }
  // 2.3 s is 68.99999999999999 frames in floating point; it is frame 69 on screen.
  expect(frameAt(2.3)).toBe(69);
  expect(frameAt(1.5)).toBe(45);
  for (const value of [undefined, Number.NaN, -1, 0]) expect(frameAt(value)).toBe(0);
  expect(timecode(30 * 3600 * 3 + 30 * 61 + 7)).toBe("03:01:01:07");
});

const VIEW = {stage: "final", permission: "approve", viewsRemaining: 2, maxViews: 3, output: {hlsUrl: "/h", mp4Url: "/m", captionsUrl: "/c"}};

/** Open `#/review/tok`; `commentAnswer(n, body)` answers the n-th comment. */
async function openReviewPage(view = async () => ok(VIEW), commentAnswer = async (_, body) => ok({comment: {id: "c", ...body}})) {
  const sent = [], decisions = [];
  let approve, changes, player;
  const fetch = async (url, options = {}) => {
    const path = pathOf(url);
    if (path === "/api/reviews/tok") return view();
    if (path === "/api/reviews/tok/comments") {const body = JSON.parse(options.body); sent.push({body, viewer: options.headers["x-hv-review-viewer"]}); return commentAnswer(sent.length, body);}
    if (path === "/api/reviews/tok/decision") {decisions.push(JSON.parse(options.body).decision); return ok({accepted: true});}
    return ok({});
  };
  const desk = await openDesk({hash: "#/review/tok", fetch, setup: (q, make) => {
    approve = make("button"); approve.dataset.decision = "approved";
    changes = make("button"); changes.dataset.decision = "changes_requested";
    q("#review-panel").select = selector => selector === "button[data-decision]" ? [approve, changes] : [];
    q("#review-comment").hidden = true; q("#review-comment-pin").disabled = true;
    player = q("#review-player"); player.paused = 0; player.pause = () => {player.paused++;};
  }});
  const q = desk.q;
  return {desk, sent, decisions, approve, player, box: q("#review-comment"), text: q("#review-comment-text"), pin: q("#review-comment-pin"),
    list: q("#review-comments"), status: q("#review-comment-status"), click: () => q("#review-comment-pin").listeners.click[0]()};
}

test("the comment box appears only once the cut is on screen, and only on a link that may decide", async () => {
  let show; const shown = new Promise(resolve => {show = resolve;});
  const waiting = await openReviewPage(() => shown);
  try {
    await waiting.desk.settle(5);
    expect(waiting.box.hidden).toBe(true);
    expect(waiting.pin.disabled).toBe(true);
    show(ok(VIEW)); await waiting.desk.settle();
    expect(waiting.box.hidden).toBe(false);
    expect(waiting.pin.disabled).toBe(false);
    expect(waiting.pin.textContent).toBe("Comment at 00:00:00:00");
  } finally {waiting.desk.restore();}

  const read = await openReviewPage(async () => ok({...VIEW, permission: "read"}));
  try {
    await read.desk.settle();
    expect(read.box.hidden).toBe(true);
    expect(read.pin.disabled).toBe(true);
  } finally {read.desk.restore();}

  const gone = await openReviewPage(async () => refused(403, "review link is invalid, expired, revoked, or fully used"));
  try {
    await gone.desk.settle();
    expect(gone.box.hidden).toBe(true);
    gone.text.value = "Too late"; gone.click(); await gone.desk.settle();
    expect(gone.sent).toEqual([]);
  } finally {gone.desk.restore();}
});

test("typing pauses the cut, and the comment is pinned to the frame on screen with this tab's viewer id", async () => {
  let reply; const replied = new Promise(resolve => {reply = resolve;});
  const page = await openReviewPage(undefined, () => replied);
  try {
    await page.desk.settle();
    page.text.listeners.focus[0]();
    expect(page.player.paused).toBe(1);
    page.player.currentTime = 1.5;
    page.player.listeners.pause[0]();
    expect(page.pin.textContent).toBe("Comment at 00:00:01:15");
    page.text.value = "  The door opens a beat early.  ";
    page.click();
    // One comment in flight: the pin is off, and a second press sends nothing.
    expect(page.pin.disabled).toBe(true);
    page.click(); await page.desk.settle(5);
    expect(page.sent).toHaveLength(1);
    expect(page.sent[0].body).toEqual({frame: 45, text: "The door opens a beat early."});
    expect(page.sent[0].viewer).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    reply(ok({comment: {id: "c1", frame: 45, text: "The door opens a beat early."}})); await page.desk.settle();
    expect(page.list.children.map(item => item.textContent)).toEqual(["00:00:01:15 — The door opens a beat early."]);
    expect(page.text.value).toBe("");
    expect(page.status.textContent).toBe("Comment pinned at 00:00:01:15.");
    expect(page.pin.disabled).toBe(false);
  } finally {page.desk.restore();}
});

test("a refused comment keeps the words and says why; an empty one is not sent", async () => {
  const policy = "We can't generate this shot.";
  const page = await openReviewPage(undefined, async () => refused(422, policy));
  try {
    await page.desk.settle();
    page.text.value = "   "; page.click(); await page.desk.settle();
    expect(page.sent).toEqual([]);
    expect(page.status.textContent).toBe("Write a comment first.");
    page.text.value = "x".repeat(501); page.click(); await page.desk.settle();
    expect(page.sent).toEqual([]);
    page.text.value = "Something refused"; page.click(); await page.desk.settle();
    expect(page.sent).toHaveLength(1);
    expect(page.status.textContent).toBe(policy);
    expect(page.text.value).toBe("Something refused");
    expect(page.list.children).toEqual([]);
    expect(page.pin.disabled).toBe(false);
  } finally {page.desk.restore();}
});

test("a reviewer may still comment after deciding", async () => {
  const page = await openReviewPage();
  try {
    await page.desk.settle();
    page.approve.listeners.click[0](); await page.desk.settle();
    expect(page.decisions).toEqual(["approved"]);
    expect(page.approve.disabled).toBe(true);
    page.player.listeners.timeupdate[0]();
    expect(page.pin.disabled).toBe(false);
    page.text.value = "One more note."; page.click(); await page.desk.settle();
    expect(page.sent).toHaveLength(1);
  } finally {page.desk.restore();}
});

const PROJECT = "project-1";
const TOKEN = btoa(JSON.stringify({projectId: PROJECT})).replace(/=+$/, "") + ".signature";
const JOB = {id: "job-final", stage: "final", castingVersion: 0, directionVersion: 0, output: {hlsUrl: "/h", mp4Url: "/m", captionsUrl: "/c"}};
const STAGES = [
  {stage: "rough-cut", label: "Rough cut (animatic)", approved: 0, changesRequested: 1, latest: {decision: "changes_requested", at: "2026-09-30T10:00:00.000Z", jobId: "job-animatic"}},
  {stage: "final", label: "Final", approved: 1, changesRequested: 0, latest: {decision: "approved", at: "2026-09-30T11:00:00.000Z", jobId: "job-final"}},
  {stage: "picture-edit", label: "Picture edit", approved: 0, changesRequested: 0, latest: null},
  {stage: "sound-mix", label: "Sound mix", approved: 0, changesRequested: 0, latest: null},
  {stage: "deliverable", label: "Deliverable", approved: 0, changesRequested: 0, latest: null},
];
const comment = (id, frame, text, extra = {}) => ({id, frame, timecode: timecode(frame), text, viewer: 2, at: "2026-09-30T11:00:00.000Z", resolvedAt: null, ...extra});
const REVIEWS = {stages: STAGES, links: [
  {id: "a", jobId: "job-final", comments: [comment("late", 90, "Music swells too soon."), comment("early", 45, "<b>Door</b> opens early.")]},
  {id: "b", jobId: "job-animatic", comments: [comment("old", 12, "Shot is soft.", {viewer: null})]},
]};

/** Reopen the project at `#/p/<token>` with the final export on screen, answering the reviews with `reviews()`. */
async function openOwner(reviews = async () => ok(REVIEWS)) {
  const requests = [];
  const fetch = async (url, options = {}) => {
    const path = pathOf(url);
    requests.push({path, method: options.method ?? "GET", auth: options.headers?.authorization, body: options.body && JSON.parse(options.body)});
    if (path === `/api/projects/${PROJECT}`) return ok({script: "", castingVersion: 0, directionVersion: 0, rightsAttestedAt: null, animaticApprovals: [], expiresAt: "2026-10-03T00:00:00.000Z"});
    if (path === `/api/projects/${PROJECT}/reviews`) return reviews();
    if (path.startsWith(`/api/projects/${PROJECT}/review-comments/`)) return ok({comment: {resolvedAt: options.body.includes("true") ? "2026-09-30T12:00:00.000Z" : null}});
    return ok({});
  };
  const desk = await openDesk({hash: "#/p/" + TOKEN, fetch, modules: {"living-script.js": {livingScriptResumeMedia: () => ({finalCut: JOB})}},
    setup: q => {q("#reviews").hidden = true; const player = q("#player"); player.pause = () => {}; player.focus = () => {player.focused = true;};}});
  await desk.settle();
  const list = desk.q("#reviews-list");
  return {desk, requests, list, panel: desk.q("#reviews"), player: desk.q("#player"), status: desk.q("#reviews-status")};
}
const rowsOf = list => list.children[1].children;

test("the owner's export lists decisions per stage and each comment, by frame, with the viewer who wrote it", async () => {
  const owner = await openOwner();
  try {
    expect(owner.requests.find(request => request.path === `/api/projects/${PROJECT}/reviews`)).toMatchObject({method: "GET", auth: "Bearer " + TOKEN});
    expect(owner.panel.hidden).toBe(false);
    expect(owner.list.children[0].children.map(item => item.textContent)).toEqual(STAGES.map(stageLine));
    expect(stageLine(STAGES[0])).toBe("Rough cut (animatic): 0 approved, 1 changes requested; latest changes requested.");
    expect(stageLine(STAGES[2])).toBe("Picture edit: no decision yet.");
    const rows = rowsOf(owner.list);
    expect(rows.map(row => row.children[0].textContent)).toEqual(["00:00:01:15", "00:00:03:00", "00:00:00:12"]);
    expect(rows.map(row => row.children[1].textContent)).toEqual(["Viewer 2: <b>Door</b> opens early.", "Viewer 2: Music swells too soon.", "Shot is soft. (on another cut)"]);
    // A reviewer's words are text, never markup.
    expect(rows[0].children[1].children).toEqual([]);
  } finally {owner.desk.restore();}
});

test("a comment's timecode moves the player to its exact frame, only on the cut the player shows", async () => {
  const owner = await openOwner();
  try {
    const [here, , elsewhere] = rowsOf(owner.list);
    here.children[0].listeners.click[0]();
    expect(owner.player.currentTime).toBe(45.5 / 30);
    expect(frameAt(owner.player.currentTime)).toBe(45);
    expect(owner.player.focused).toBe(true);
    expect(elsewhere.children[0].disabled).toBe(true);
    expect(elsewhere.children[0].getAttribute("aria-label")).toBe("00:00:00:12 is on another cut");
    owner.player.currentTime = 0;
    elsewhere.children[0].listeners.click[0]();
    expect(owner.player.currentTime).toBe(0);
  } finally {owner.desk.restore();}
});

test("Resolve and Reopen are sent to the server and shown on the comment", async () => {
  const owner = await openOwner();
  try {
    const row = rowsOf(owner.list)[0], toggle = row.children[2];
    expect(toggle.textContent).toBe("Resolve");
    await toggle.listeners.click[0]();
    expect(owner.requests.at(-1)).toEqual({path: `/api/projects/${PROJECT}/review-comments/early`, method: "POST", auth: "Bearer " + TOKEN, body: {resolved: true}});
    expect(toggle.textContent).toBe("Reopen");
    expect(row.dataset.resolved).toBe("true");
    expect(owner.status.textContent).toBe("Comment resolved.");
    await toggle.listeners.click[0]();
    expect(owner.requests.at(-1).body).toEqual({resolved: false});
    expect(toggle.textContent).toBe("Resolve");
  } finally {owner.desk.restore();}
});

test("a project with no review links shows no review panel; Refresh reviews asks again", async () => {
  let answer = {stages: STAGES.map(stage => ({...stage, approved: 0, changesRequested: 0, latest: null})), links: []};
  const owner = await openOwner(async () => ok(answer));
  try {
    expect(owner.panel.hidden).toBe(true);
    answer = REVIEWS;
    owner.desk.q("#reviews-refresh").listeners.click[0](); await owner.desk.settle();
    expect(owner.panel.hidden).toBe(false);
    expect(rowsOf(owner.list)).toHaveLength(3);
    expect(owner.requests.filter(request => request.path === `/api/projects/${PROJECT}/reviews`)).toHaveLength(2);
  } finally {owner.desk.restore();}
});
