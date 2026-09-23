/**
 * HV-030-08 — the studio waited on a stuck render for as long as the tab stayed open.
 *
 * `pollJob` is what every paid step of the studio waits on, and it was:
 *
 *     for (;;) {
 *       const job = await api(path, {headers: auth()});
 *       if (job.status === "done") return job;
 *       if (job.status === "failed" || job.status === "cancelled") throw ...
 *       onProgress(...);
 *       await wait(1500);
 *     }
 *
 * Nothing ends it but a terminal status. A job that never reaches one — queued with no worker
 * registered, or a queue that stays saturated — was polled every 1,500 ms forever: **2,400 requests
 * an hour from one tab, against an api bucket of 120 a minute**, a promise that never settles, and
 * a step of the studio that never advances so the only screen left is the one that renders again.
 *
 * The file already knew. `inspect`, one function over, caps at `INSPECTION_POLLS` and says "The
 * Editor is still checking the film." The render loop had no cap at all. That is the same shape as
 * HV-031-08 and HV-016-05: not missing knowledge, knowledge that did not reach the place that
 * needed it.
 *
 * Measured before, with `wait` stubbed out so the loop runs at full speed: the loop was stopped at
 * 5,000 requests by the harness, having simulated 7,500,000 ms — two hours — of waiting, and would
 * not otherwise have stopped.
 */
import {expect, test} from 'bun:test';
import {DEFAULT_LEASE_MS, MAX_LEASE_RECOVERIES} from '../../queue/src/index.ts';
import {POLL_INTERVAL_MS, STALL_LIMIT_MS, createStudioFlow} from '../src/studio.js';

/** The studio driven to its first render, with every job read answered by `job`. */
function fake(job) {
  let project = null, requests = 0, waited = 0;
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => ({facts: {concerns: [], scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
      logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}],
      expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: true}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
    'POST /api/projects/p1/jobs': () => ({jobId: 'animatic-1'}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 1, heldUsd: 0, capUsd: 40}),
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    if (path.startsWith('/api/jobs/')) { requests++; return job(requests); }
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(typeof options.body === 'string' ? JSON.parse(options.body) : options.body);
  };
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; },
    wait: async ms => { waited += ms; }, fetchImage: async () => new Uint8Array([137, 80, 78, 71]).buffer});
  const reach = async () => {
    await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: 'warm', rightsAttested: true});
    await flow.plan([{id: 'q1', accepted: true}]);
    return flow.approveLook(true);
  };
  return {reach, polls: () => requests, waited: () => waited};
}

test('the ceiling is the queue\'s own clock, not a number someone chose', () => {
  // The two descriptions of the same thing, read from the two packages. A job the server has not
  // given up on has moved within one lease times the recoveries it is allowed, so that is how long
  // the studio waits for it to move.
  expect({limit: STALL_LIMIT_MS, derived: DEFAULT_LEASE_MS * (MAX_LEASE_RECOVERIES + 1)})
    .toEqual({limit: 30 * 60 * 1000, derived: 30 * 60 * 1000});
  expect({minutes: STALL_LIMIT_MS / 60000, interval: POLL_INTERVAL_MS}).toEqual({minutes: 30, interval: 1500});
});

test('a render that never moves stops being polled, and is not called a failure', async () => {
  // Before: this never returned. The harness had to stop it.
  const stuck = fake(() => ({id: 'animatic-1', status: 'queued'}));
  await expect(stuck.reach()).rejects.toThrow('has not moved for 30 minutes');
  // It says where the render is, which is the thing the creator needs, and it does not say it died.
  await expect(fake(() => ({id: 'animatic-1', status: 'queued'})).reach()).rejects.toThrow('still queued on the server as job animatic-1');
  // And it stops at the ceiling rather than somewhere near it: one poll per interval, no more.
  expect({polls: stuck.polls(), waited: stuck.waited()}).toEqual({polls: STALL_LIMIT_MS / POLL_INTERVAL_MS + 1, waited: STALL_LIMIT_MS});
});

test('and a render that is moving is waited on for as long as it keeps moving', async () => {
  // The distinction the whole increment turns on. A film that checkpoints a shot every so often is
  // alive, and this must not put a stopwatch on the film itself: four times the ceiling in polls,
  // with a shot finishing just inside each window, finishes.
  const window = STALL_LIMIT_MS / POLL_INTERVAL_MS;
  const moving = fake(count => count >= window * 4 ? {id: 'animatic-1', status: 'done', storyboard: [], output: {}}
    : {id: 'animatic-1', status: 'running', checkpointShots: Math.floor(count / (window - 1))});
  const state = await moving.reach();
  expect(state.step).toBe('rough-cut');
  expect({polls: moving.polls(), beyondTheCeiling: moving.polls() > window}).toEqual({polls: window * 4, beyondTheCeiling: true});
});

test('and a status change resets the clock as well as a finished shot', async () => {
  // Queued for just under the ceiling, then running, then queued again -- nearly three windows in
  // total and none of them stalled, because the job moved each time.
  const window = STALL_LIMIT_MS / POLL_INTERVAL_MS;
  const shifting = fake(count => count >= window * 3 ? {id: 'animatic-1', status: 'done', storyboard: [], output: {}}
    : {id: 'animatic-1', status: count < window ? 'queued' : count < window * 2 ? 'running' : 'queued'});
  await shifting.reach();
  expect(shifting.polls()).toBe(window * 3);
});

test('and the terminal answers the loop already had are unchanged', async () => {
  await expect(fake(() => ({id: 'animatic-1', status: 'failed', failureReason: 'the renderer ran out of memory'})).reach())
    .rejects.toThrow('the renderer ran out of memory');
  await expect(fake(() => ({id: 'animatic-1', status: 'cancelled', cancelReason: 'you stopped it'})).reach()).rejects.toThrow('you stopped it');
  await expect(fake(() => ({id: 'animatic-1', status: 'failed'})).reach()).rejects.toThrow('The render stopped.');
  const done = fake(() => ({id: 'animatic-1', status: 'done', storyboard: [], output: {}}));
  expect((await done.reach()).step).toBe('rough-cut');
  expect(done.polls()).toBe(1);
});
