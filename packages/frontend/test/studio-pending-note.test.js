/**
 * HV-016-16 — after the studio waited for a render, the note above the film still said it was
 * being made.
 *
 * HV-016-11 let a resumed project wait for the render it left running. `resume` says so above the
 * step: *"Your final film is still being made — it is running on the server…"*, or the same of the
 * rough cut. `waitForPending` then polled the job and moved the creator to the finished film or the
 * rough cut, carrying the rest of the state forward -- the note with it. So the finished film sat
 * under a line saying it was still being made and telling the creator to wait for it, and the rough
 * cut under one telling them to wait rather than pitch again.
 *
 * Once the render is done, the note is now the one a project that had already finished it resumes
 * with: what was not retained, and nothing about waiting.
 */
import {expect, test} from 'bun:test';
import {createStudioFlow} from '../src/studio.js';

const OUT = {id: 'x', outputRevision: 'r'.repeat(64), output: {}};
const job = (id, stage, status = 'done') => ({...OUT, id, stage, status});
const SCRIPT = 'INT. LIGHTHOUSE - NIGHT\n\nShe winds the lamp.';

/** A project as `GET /api/projects/:id` returns it, and a job read that can move on demand. */
function fake(project, {jobs = {}, takes = {enabled: false}} = {}) {
  let project0 = null, polls = 0;
  const calls = [];
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push(`${method} ${path}`);
    // A fake that answers a retry loop with the same unhelpful answer hangs instead of failing, and
    // a hang says nothing. Sixty calls is far more than any path here makes.
    if (calls.length > 60) throw new Error('the studio asked for 60 things: ' + calls.slice(-8).join(' | '));
    if (path === '/api/projects/p1') return project;
    if (path === '/api/projects/p1/spend') return {spentUsd: 9, heldUsd: 0, capUsd: 40};
    if (path === '/api/projects/p1/audio-takes') return takes;
    if (path === '/api/projects/p1/graphics') return {rendering: {available: false, chromeVersion: '152'}, library: {version: 0}, graphics: []};
    if (path.startsWith('/api/projects/p1/sound-mixes/')) return method === 'GET'
      ? {durationSec: 4, sourceRevision: 'a', engineVersion: '1'} : {jobId: 'scored-1'};
    // The Composer uploads its loop once and reuses it. A fake that answers the upload with the same
    // empty library would spin in `scoreFinal`'s own retry loop rather than test anything.
    if (path === '/api/projects/p1/sounds') return method === 'GET'
      ? {library: {version: 0, assets: []}}
      : {asset: {id: 'a1', revision: 'r'.repeat(64), audio: {frames: 48_000}, original: {bytes: 1}}};
    if (path.startsWith('/api/jobs/')) {
      polls++;
      const id = path.split('/').at(-1);
      return jobs[id] ? jobs[id](polls) : {...OUT, id, status: 'done'};
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const flow = createStudioFlow({api, getProject: () => ({projectId: 'p1', token: 't1'}), setProject: value => {project0 = value;},
    wait: async () => {}, fetchImage: async () => new Uint8Array([137, 80, 78, 71]).buffer});
  return {flow, polls: () => polls, calls: () => calls, project0: () => project0};
}

test('a rough cut that finished while the studio waited is shown under the rough cut\'s own note, not "still being made"', async () => {
  const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic', 'queued')]},
    {jobs: {'animatic-1': count => ({...OUT, id: 'animatic-1', status: count < 2 ? 'queued' : 'done'})}});
  expect((await flow.resume()).resumedNote).toContain('still being made');
  const waited = await flow.waitForPending();
  expect(waited.step).toBe('rough-cut');
  expect(waited.resumedNote).not.toContain('still being made');
  // The note a project that already had this rough cut resumes with.
  const already = await fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic')]}).flow.resume();
  expect(waited.resumedNote).toBe(already.resumedNote);
  expect(waited.resumed).toBe('rough-cut');
});

test('and a final that finished while it waited is shown under the film\'s own note', async () => {
  const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic'), job('final-1', 'final', 'running')]},
    {jobs: {'final-1': count => ({...OUT, id: 'final-1', status: count < 3 ? 'running' : 'done'})}});
  expect((await flow.resume()).resumedNote).toContain('still being made');
  const waited = await flow.waitForPending();
  expect(waited.step).toBe('final');
  expect(waited.resumedNote).not.toContain('still being made');
  const already = await fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic'), job('final-1', 'final')]}).flow.resume();
  expect(waited.resumedNote).toBe(already.resumedNote);
  expect(waited.resumed).toBe('final');
});
