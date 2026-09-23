/**
 * HV-030-10 — the studio knew the render was free and did not say so, in the front door too.
 *
 * The route's half of this is `packages/api/test/render-already-admitted.test.ts`. This is what the
 * creator sees: when the crew is asked for a film it has already made, the studio says so, once,
 * instead of letting them believe they have just been charged again.
 *
 * `askForRender` is the only place that reads the flag, so the two approvals cannot come to describe
 * the same thing differently — which is the mistake `voiceFinal`'s siblings made in HV-030-07, where
 * two of three guarded paths were guarded and the third was not.
 */
import {expect, test} from 'bun:test';
import {createStudioFlow} from '../src/studio.js';

const readThrough = () => ({facts: {concerns: [], scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
  logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}],
  expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}});

/** The studio driven to its first render, with `admitted` under the test's control. */
function fake({admitted = true} = {}) {
  let project = null;
  const asked = [];
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => readThrough(),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: false}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
    'POST /api/projects/p1/jobs': () => {asked.push(1); return {jobId: 'animatic-1', admitted};},
    'GET /api/projects/p1/spend': () => ({spentUsd: 1, heldUsd: 0, capUsd: 40}),
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    if (path.startsWith('/api/jobs/')) return {id: path.split('/').at(-1), status: 'done', outputRevision: 'r'.repeat(64), storyboard: [], output: {}};
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(typeof options.body === 'string' ? JSON.parse(options.body) : options.body);
  };
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => {project = value;}, wait: async () => {},
    fetchImage: async () => new Uint8Array([137, 80, 78, 71]).buffer});
  const reach = async () => {
    await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: 'warm', rightsAttested: true});
    await flow.plan([{id: 'q1', accepted: true}]);
    return flow.approveLook(true);
  };
  return {flow, reach, asked: () => asked.length};
}

test('a film the crew had already made is said to have cost nothing', async () => {
  const state = await fake({admitted: false}).reach();
  expect(state.step).toBe('rough-cut');
  expect(state.reusedNote).toBe('The crew had already made this, so it was not rendered or paid for again.');
});

test('and a film the crew made just now says nothing about it', async () => {
  // The note is news. A render that was actually made is the ordinary case and needs no remark, and
  // a studio that said this every time would be saying nothing.
  const state = await fake({admitted: true}).reach();
  expect({step: state.step, note: state.reusedNote}).toEqual({step: 'rough-cut', note: undefined});
});

test('and a studio whose server says nothing at all is not told a film was free', async () => {
  // `admitted` is checked for `false`, not for falsiness: a response without the field -- an older
  // server, or a route that does not report it -- must not be read as "already made".
  const quiet = fake({admitted: undefined});
  const state = await quiet.reach();
  expect({note: state.reusedNote, renders: quiet.asked()}).toEqual({note: undefined, renders: 1});
});
