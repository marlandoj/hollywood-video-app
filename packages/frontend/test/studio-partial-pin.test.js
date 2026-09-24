/**
 * HV-017-13 — some stills were pinned, and the studio said none had been.
 *
 * HV-017-06 pins each storyboard still of the rough cut as its shot's first frame, then re-cuts the
 * rough cut from them, so the cut the creator approves is the cut the final will render. The pins
 * are saved one shot at a time — an anchor upload and a direction save each — with no undoing them.
 *
 * `pinStills` threw on the first refusal, and the caller caught it with one sentence:
 *
 *     "the storyboard stills could not be pinned as the final's first frames (…); the final begins
 *      from the script."
 *
 * If shot 3 of 5 was refused — the project's reference-image limit, "Image processing is busy", a
 * moved direction version — shots 1 and 2 were already anchored. The creator was told none were and
 * that the final would begin from the script; the final began from those two stills; and the rough
 * cut was not re-cut from them, so what the creator approved at approval 2 was not what approval 3
 * would render. That is the exact mismatch HV-017-06 exists to close.
 *
 * The same catch also covered a failure of the *re-cut*, after every pin had succeeded, with the same
 * untrue sentence.
 */
import {expect, test} from 'bun:test';
import {createStudioFlow} from '../src/studio.js';

const entry = id => ({source: {id}, sourceHash: 'h-' + id, settings: {size: 'wide', durationFrames: 150}});
const SHOTS = ['shot-1-1', 'shot-2-1', 'shot-3-1'];

/** The studio driven to its rough cut, with three stills to pin and each step under the test's control. */
function fake({refuseAt = null, recut = 'done'} = {}) {
  let project = null, jobs = 0;
  const calls = [];
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => ({facts: {concerns: [], scenes: 1, shots: 3, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
      logline: 'A reunion.', summary: 'Quiet.', questions: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: true}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
    'POST /api/projects/p1/jobs': () => ({jobId: `animatic-${++jobs}`}),
    'GET /api/jobs/animatic-1': () => ({id: 'animatic-1', status: 'done', storyboard: [], output: {}}),
    'GET /api/jobs/animatic-2': () => recut === 'done' ? {id: 'animatic-2', status: 'done', storyboard: [], output: {}}
      : {id: 'animatic-2', status: 'failed', failureReason: 'The worker ran out of room.'},
    'GET /api/projects/p1/direction': () => ({scriptVersion: 1, direction: {version: 1, entries: SHOTS.map(entry)},
      plan: SHOTS.map(id => ({source: {id}, sourceHash: 'h-' + id})),
      viewfinderSources: SHOTS.map(id => ({shotId: id, jobId: 'animatic-1', url: `/artifacts/x/${id}.png`}))}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 1, heldUsd: 0, capUsd: 40}),
  };
  SHOTS.forEach((id, index) => {
    responses[`POST /api/projects/p1/direction/${id}/anchors?label=Storyboard%20still`] = () => {
      if (index === refuseAt) throw new Error('This project already holds its 96 reference images.');
      return {asset: {id: 'a-' + id}};
    };
    responses[`PUT /api/projects/p1/direction/${id}`] = () => ({direction: {version: 2 + index}});
  });
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(typeof options.body === 'string' ? JSON.parse(options.body) : options.body);
  };
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => {project = value;}, wait: async () => {},
    fetchImage: async () => new Uint8Array([137, 80, 78, 71]).buffer});
  const reach = async () => {
    await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: '', rightsAttested: true});
    await flow.plan([]);
    return flow.approveLook(true);
  };
  return {reach, pinned: () => calls.filter(call => call.startsWith('PUT /api/projects/p1/direction/')).length,
    recuts: () => calls.filter(call => call === 'POST /api/projects/p1/jobs').length - 1};
}

test('a pin that stopped part-way says how many it made, and the rough cut is re-cut from them', async () => {
  const f = fake({refuseAt: 2});
  const state = await f.reach();
  // Two shots are anchored, and the studio says so rather than that none were.
  expect(f.pinned()).toBe(2);
  const note = state.lookNotes.find(text => text.startsWith('Cinematographer:'));
  expect(note).toContain('2 storyboard stills were pinned');
  expect(note).toContain('96 reference images');
  expect(note).not.toContain('the final begins from the script');
  // And the cut the creator approves is the one those two pins make.
  expect({recuts: f.recuts(), animatic: state.animatic.id}).toEqual({recuts: 1, animatic: 'animatic-2'});
});

test('and a pin that made nothing still says the final begins from the script, which is then true', async () => {
  const f = fake({refuseAt: 0});
  const state = await f.reach();
  expect(f.pinned()).toBe(0);
  expect(state.lookNotes).toEqual([
    "Cinematographer: the storyboard stills could not be pinned as the final's first frames (This project already holds its 96 reference images.); the final begins from the script.",
  ]);
  expect({recuts: f.recuts(), animatic: state.animatic.id}).toEqual({recuts: 0, animatic: 'animatic-1'});
});

test('and a re-cut that failed after every pin was saved does not say the pins were not made', async () => {
  const f = fake({recut: 'failed'});
  const state = await f.reach();
  expect(f.pinned()).toBe(3);
  const note = state.lookNotes.find(text => text.startsWith('Cinematographer:'));
  expect(note).toContain('were pinned');
  expect(note).toContain('does not show');
  expect(note).not.toContain('could not be pinned');
  // The creator is still brought to the approval, with the note above it rather than no rough cut.
  expect(state.step).toBe('rough-cut');
});

test('and when everything works there is nothing to say', async () => {
  const f = fake();
  const state = await f.reach();
  expect({pinned: f.pinned(), recuts: f.recuts(), notes: state.lookNotes}).toEqual({pinned: 3, recuts: 1, notes: []});
});
