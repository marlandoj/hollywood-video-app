/**
 * HV-016-09 — a reopened project link took the creator to the Director's desk, not to their film.
 *
 * `docs/CREW.md` lists this under "Not yet", in its own words:
 *
 *     Resuming inside the studio. A reopened project link opens the Director's desk, because the
 *     studio does not yet rebuild its step from the project.
 *
 * `index.html` did exactly that: `showDesk(deskPreferred || current?.kind === "p")`. A creator who
 * closed the tab and came back to their own link landed in every detailed panel of the application
 * — the surface HV-030-03 put behind the Advanced switch precisely because it is not the front door
 * — and the studio itself, if they switched back to it, was at the pitch with an empty box. The one
 * path it offered was to pitch the script again, which renders, and charges, again.
 *
 * The project holds what was *made*: the script, and every job with its stage and status. It does
 * not hold what the crew *said*, nor what the creator told the crew — the read-through is the
 * model's answer, and the format, the tone and the replies to the questions are not stored. So the
 * furthest step this rebuilds is the furthest one whose evidence is in the project, and each one
 * says what it could not bring back instead of inventing it.
 */
import {expect, test} from 'bun:test';
import {createStudioFlow} from '../src/studio.js';

/** A project as `GET /api/projects/:id` returns it, with the jobs a film leaves behind. */
function fake(project) {
  let requests = 0;
  const api = async (path, options = {}) => {
    requests++;
    if (path === '/api/projects/p1') return project;
    if (path === '/api/projects/p1/spend') return {spentUsd: 9, heldUsd: 0, capUsd: 40};
    if (path === '/api/projects/p1/animatic/decision') return {};
    if (path === '/api/projects/p1/jobs') return {jobId: 'final-1'};
    if (path.startsWith('/api/jobs/')) return {id: path.split('/').at(-1), status: 'done', outputRevision: 'r'.repeat(64), output: {}};
    if (path === '/api/projects/p1/audio-takes') return {enabled: false};
    if (path === '/api/projects/p1/sounds') return {library: {version: 0, assets: []}};
    if (path === '/api/projects/p1/crew/read-through') throw new Error('the crew should not be asked to read again');
    throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
  };
  const flow = createStudioFlow({api, getProject: () => ({projectId: 'p1', token: 't1'}), setProject: () => {}, wait: async () => {}});
  return {flow, requests: () => requests};
}

const job = (id, stage, status = 'done') => ({id, stage, status, outputRevision: 'r'.repeat(64), output: {}});
const SCRIPT = 'INT. LIGHTHOUSE - NIGHT\n\nShe winds the lamp.';

test('a project with a finished film resumes to the film, not to the pitch', async () => {
  const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic'), job('final-1', 'final')]});
  const state = await flow.resume();
  expect({step: state.step, film: state.final.id, resumed: state.resumed}).toEqual({step: 'final', film: 'final-1', resumed: 'final'});
  expect(state.script).toBe(SCRIPT);
  expect(state.spend).toEqual({spentUsd: 9, heldUsd: 0, capUsd: 40});
  // Approval 3 is the creator's own and needs nothing but the film, so a resumed final is whole.
  expect(state.resumedNote).toContain('read-through was not retained');
});

test('and a project with a rough cut resumes to the approval, so the film it paid for is not rendered again', async () => {
  const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic')]});
  const state = await flow.resume();
  expect({step: state.step, cut: state.animatic.id, resumed: state.resumed}).toEqual({step: 'rough-cut', cut: 'animatic-1', resumed: 'rough-cut'});
  // And it says, before the creator approves, what the crew will not have: the tone and the answers
  // were the creator's words and the project does not keep them, so the score is the default one.
  expect(state.resumedNote).toContain('does not render it again');
  expect(state.resumedNote).toContain('The tone and your answers to the crew were not retained');
});

test('and a project with a script and nothing rendered resumes to the pitch, with the script in the box', async () => {
  const {flow} = fake({script: SCRIPT, jobs: []});
  const state = await flow.resume();
  expect({step: state.step, script: state.script, resumed: state.resumed}).toEqual({step: 'pitch', script: SCRIPT, resumed: 'pitch'});
  expect(state.resumedNote).toContain('costs nothing');
  // A project with nothing at all is the pitch with an empty box and nothing to explain.
  const empty = await fake({script: '', jobs: []}).flow.resume();
  expect({step: empty.step, script: empty.script, resumed: empty.resumed, note: empty.resumedNote})
    .toEqual({step: 'pitch', script: '', resumed: null, note: undefined});
});

test('and an unfinished render is not a film: only a job that is done resumes a step', async () => {
  // A queued or running final is not something to show, and a failed one is not something to share.
  for (const status of ['queued', 'running', 'failed', 'cancelled']) {
    const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic'), job('final-1', 'final', status)]});
    expect({status, step: (await flow.resume()).step}).toEqual({status, step: 'rough-cut'});
  }
  for (const status of ['queued', 'running', 'failed']) {
    const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic', status)]});
    expect({status, step: (await flow.resume()).step}).toEqual({status, step: 'pitch'});
  }
  // The latest finished job of a stage is the one, because a film may be rendered more than once.
  const {flow} = fake({script: SCRIPT, jobs: [job('final-1', 'final'), job('final-2', 'final')]});
  expect((await flow.resume()).final.id).toBe('final-2');
});

test('and a resumed rough cut can be approved but not sent back, because the read-through is gone', async () => {
  // Approving spends nothing on the rough cut itself -- it is already rendered and paid for -- and
  // carries straight on to the final, which is the whole point of resuming here.
  const {flow} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic')]});
  await flow.resume();
  const approved = await flow.approveRoughCut();
  expect({step: approved.step, film: approved.final.id}).toEqual({step: 'final', film: 'final-1'});
  // Sending the crew back needs a fresh read-through, and that needs the format and tone this film
  // was pitched with. Refused by name rather than read back with a format nobody chose -- the fake
  // throws if the crew is asked, so this would be a different failure if the guard were missing.
  const second = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic')]});
  await second.flow.resume();
  await expect(second.flow.requestChanges()).rejects.toThrow('was not retained');
});

test('and resuming asks the project once, not the crew at all', async () => {
  // The cost of reopening a link must be a read. Nothing here may render, and nothing may ask the
  // model: the fake throws on the read-through route, and counts what was asked for.
  const {flow, requests} = fake({script: SCRIPT, jobs: [job('animatic-1', 'animatic'), job('final-1', 'final')]});
  await flow.resume();
  expect(requests()).toBe(2);
});
