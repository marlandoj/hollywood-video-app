/**
 * HV-016-18 — the Director's desk waited on a stuck render for as long as the tab stayed open.
 *
 * HV-030-08 gave the studio's `pollJob` a ceiling. The desk's own `pollJob`, in `index.html`, which
 * Create film, Approve and generate and a reopened project link all wait on, still had none:
 *
 *     async function pollJob(jobId) {
 *       while (true) {
 *         const job = await api(`/api/jobs/${jobId}`, ...);
 *         if (job.status === "done") return job;
 *         if (job.status === "failed" || job.status === "cancelled") throw ...;
 *         setStatus(...);
 *         await new Promise((resolve) => setTimeout(resolve, 1500));
 *       }
 *     }
 *
 * A job that never reaches a terminal status (queued with no worker, a saturated queue) was polled
 * every 1.5 s, 2,400 requests an hour, with Create film disabled the whole time. The only way out
 * was a reload, and nothing said the render was still on the server.
 *
 * The desk now keeps the studio's rule. It counts polls in which neither the status nor the finished
 * shot count moved, and after thirty minutes of those (the queue's own lease clock, measured in the
 * desk's own interval) it stops. It says the job is still there, names it, and says that asking again
 * is free. Create film is live again.
 *
 * `setTimeout` is the page's, recorded by `desk-page.js`, so each test runs its half hours in about a
 * second and still checks exactly how long the page meant to wait.
 */
import {expect, test} from "bun:test";
import {openDesk, ok, pathOf} from "./desk-page.js";

const INTERVAL_MS = 1500, WINDOW_POLLS = 30 * 60 * 1000 / INTERVAL_MS;

/** Press Create film against a render whose n-th poll answers `jobAt(n)`, and run until `polls` stops at `expected`. */
async function pressAndWait(jobAt, expected) {
  let polls = 0;
  const fetch = async (url, options = {}) => {
    const path = pathOf(url);
    if (path === "/api/projects" && options.method === "POST") return ok({projectId: "p1", token: "t.sig"});
    if (path === "/api/projects/p1/jobs") return ok({jobId: "j1"});
    if (path === "/api/jobs/j1") return ok({id: "j1", checkpointShots: 0, ...jobAt(++polls)});
    return ok({});
  };
  const desk = await openDesk({fetch});
  void desk.q("#screenplay-form").listeners.submit[0]({preventDefault() {}});
  for (let i = 0; i < 2000 && polls < expected; i++) await desk.settle(10);
  const reached = polls; await desk.settle(60);
  return {desk, reached, polls, status: desk.q("#status")};
}

test("a render that never moves stops being polled after thirty minutes, and the desk says it is still on the server", async () => {
  const run = await pressAndWait(() => ({status: "queued"}), WINDOW_POLLS + 1);
  try {
    // The first poll, then a window of polls that saw nothing move, and then no more.
    expect(run.reached).toBe(WINDOW_POLLS + 1);
    expect(run.polls).toBe(run.reached);
    expect(run.desk.waits.length).toBe(WINDOW_POLLS);
    expect(run.desk.waits.every(ms => ms === INTERVAL_MS)).toBe(true);
    expect(run.desk.waits.reduce((a, b) => a + b, 0)).toBe(30 * 60 * 1000);
    expect(run.status.textContent).toContain("has not moved for 30 minutes");
    expect(run.status.textContent).toContain("still queued on the server as job j1");
    expect(run.status.textContent).toContain("retained");
    expect(run.status.textContent).toContain("asking again is free");
    expect(run.status.textContent).not.toContain("failed");
    expect(run.status.dataset.state).toBe("error");
    expect(run.desk.q("#submit").disabled).toBe(false);
  } finally {run.desk.restore();}
}, 60000);

test("a render that keeps finishing shots is waited on for as long as it moves, and the ceiling counts from its last shot", async () => {
  // A shot finishes every 1,000 polls (25 minutes) for three shots, and then nothing more happens.
  const lastMove = 3 * 1000 + 1;
  const run = await pressAndWait(n => ({status: "running", checkpointShots: Math.min(3, Math.floor((n - 1) / 1000))}), lastMove + WINDOW_POLLS);
  try {
    expect(run.reached).toBe(lastMove + WINDOW_POLLS);
    expect(run.polls).toBe(run.reached);
    expect(run.status.textContent).toContain("still running on the server as job j1");
    expect(run.desk.q("#submit").disabled).toBe(false);
  } finally {run.desk.restore();}
}, 60000);

test("a change of status resets the clock as a finished shot does", async () => {
  // Queued, then running, then queued again, each for less than a window; then it stays queued.
  const lastMove = 2 * 1100 + 1;
  const run = await pressAndWait(n => ({status: n <= 1100 ? "queued" : n <= 2200 ? "running" : "queued"}), lastMove + WINDOW_POLLS);
  try {
    expect(run.reached).toBe(lastMove + WINDOW_POLLS);
    expect(run.polls).toBe(run.reached);
    expect(run.status.textContent).toContain("still queued on the server as job j1");
  } finally {run.desk.restore();}
}, 60000);
