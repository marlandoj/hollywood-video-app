/**
 * HV-016-11 — a film that was still being made had nowhere to come back to.
 *
 * HV-016-09 brought a creator back to the step their evidence supported, and it named this gap
 * itself: *"Nothing resumes a render in flight. A project whose final is still running resumes to
 * the rough cut rather than waiting on that job, even though HV-030-08 now gives the studio a
 * bounded way to wait."* HV-030-08 named the other half: *"The studio does not offer to resume. The
 * refusal gives the job id and says asking again is free, but nothing takes the creator back to
 * that job."*
 *
 * So the state a creator is most likely to close the tab in — the film is rendering, it takes
 * minutes, they go away — resumed to the step *below* the render, where the only button renders
 * something. The job was already paid for and already running.
 *
 * `resume` now reports it as `pending`, and `waitForPending` polls it with the ceiling HV-030-08
 * gave `pollJob` and carries on from it. A finished final goes through the same three finishing
 * passes an approval runs — the tail is one function now, shared, because a film that finished
 * while the tab was closed must be finished the same way as one that finished in front of the
 * creator, and two copies would have drifted the first time one changed.
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

test('a project whose final is still being made resumes to the rough cut and says the film is coming', async () => {
  const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic'), job('final-1', 'final', 'running')]});
  const state = await flow.resume();
  expect({step: state.step, pending: state.pending, cut: state.animatic.id})
    .toEqual({step: 'rough-cut', pending: {stage: 'final', jobId: 'final-1', status: 'running'}, cut: 'animatic-1'});
  // It says the film is already paid for, and what the finishing will be missing.
  expect(state.resumedNote).toContain('still being made');
  expect(state.resumedNote).toContain('already paid for');
  expect(state.resumedNote).toContain("Composer's own direction");
});

test('and waiting for it lands on the finished film, finished the same way an approval finishes one', async () => {
  // Two polls of a running job, then done -- and the three finishing passes run against it, which
  // is what makes the resumed film the same film as one finished in front of the creator.
  const {flow, polls} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic'), job('final-1', 'final', 'running')]},
    {jobs: {'final-1': count => ({...OUT, id: 'final-1', status: count < 3 ? 'running' : 'done'})}});
  await flow.resume();
  const state = await flow.waitForPending();
  // The film the creator gets is the *scored* cut, not the raw final -- which is the whole point:
  // the finishing passes ran, and they replace the cut as they go, exactly as an approval's do.
  expect({step: state.step, film: state.final.id, pending: state.pending}).toEqual({step: 'final', film: 'scored-1', pending: undefined});
  // Three reads of the final -- running, running, done -- and then the score's own job.
  expect(polls()).toBe(4);
  // And what could not be done is a note rather than a failure: this studio has no graphics
  // renderer, so the Editor could not title it and says so.
  expect(state.finishNotes.join(' ')).toContain('no graphics renderer');
  expect(state.spend).toEqual({spentUsd: 9, heldUsd: 0, capUsd: 40});
});

test('and a project whose rough cut is still being made waits for that instead of pitching again', async () => {
  const {flow, polls} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic', 'queued')]},
    {jobs: {'animatic-1': count => ({...OUT, id: 'animatic-1', status: count < 2 ? 'queued' : 'done'})}});
  const state = await flow.resume();
  expect({step: state.step, pending: state.pending}).toEqual({step: 'pitch', pending: {stage: 'animatic', jobId: 'animatic-1', status: 'queued'}});
  expect(state.resumedNote).toContain('rather than pitching');
  const waited = await flow.waitForPending();
  expect({step: waited.step, cut: waited.animatic.id, pending: waited.pending}).toEqual({step: 'rough-cut', cut: 'animatic-1', pending: undefined});
  expect(polls()).toBe(2);
  // The pinning pass needs the crew's plan, which is not retained. Said, not skipped silently.
  expect(waited.lookNotes.join(' ')).toContain('storyboard stills were not pinned');
  expect(waited.lookNotes.join(' ')).toContain('begins from the script');
});

test('and a finished film still wins over anything in flight', async () => {
  // A final that is done is the film; a second one queued behind it does not make the creator wait.
  const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic'), job('final-1', 'final'), job('final-2', 'final', 'queued')]});
  const state = await flow.resume();
  expect({step: state.step, film: state.final.id, pending: state.pending}).toEqual({step: 'final', film: 'final-1', pending: undefined});
  await expect(flow.waitForPending()).rejects.toThrow('Nothing is rendering');
});

test('and a render that stops is a refusal, not a film', async () => {
  const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic'), job('final-1', 'final', 'running')]},
    {jobs: {'final-1': () => ({...OUT, id: 'final-1', status: 'failed', failureReason: 'the renderer ran out of memory'})}});
  await flow.resume();
  await expect(flow.waitForPending()).rejects.toThrow('the renderer ran out of memory');
  // And the rough cut is still where the creator is, with the film still named as pending.
  expect({step: flow.state.step, pending: flow.state.pending?.jobId}).toEqual({step: 'rough-cut', pending: 'final-1'});
});
