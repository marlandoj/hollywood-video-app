/**
 * HV-030-03 -- the studio front door: script -> crew questions -> three approvals.
 * The flow is driven here through a fake network that records every call, so the
 * sequence of requests the studio makes is itself the assertion.
 */
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BLOCKING_CONCERNS, PERSONA_TITLES, createStudioFlow} from '../src/studio.js';

const SRC = join(import.meta.dir, '..', 'src');
const readThrough = (concerns = []) => ({facts: {concerns, scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
  logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}, {id: 'q2', persona: 'sound', question: 'Music?', proposal: 'Light.'}],
  expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}});

function fake(overrides = {}) {
  const calls = [];
  let project = null;
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => readThrough(),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [{persona: 'casting', change: 'Cast Maya.'}]}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: [{name: 'MAYA', kind: 'original-fictional', permission: {status: 'pending'}}]}}),
    'POST /api/projects/p1/crew/approve-cast': () => ({}),
    'POST /api/projects/p1/jobs': body => ({jobId: body.stage === 'final' ? 'final-1' : 'animatic-1'}),
    'GET /api/jobs/animatic-1': () => ({id: 'animatic-1', status: 'done', storyboard: [], output: {}}),
    'GET /api/jobs/final-1': () => ({id: 'final-1', status: 'done', outputRevision: 'r'.repeat(64), output: {}}),
    'POST /api/projects/p1/animatic/decision': () => ({}),
    'POST /api/projects/p1/reviews': body => ({reviewUrl: 'https://studio.test/#/review/x', maxViews: body.maxViews}),
    ...overrides,
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({method, path, body, auth: options.headers?.authorization});
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(body);
  };
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {}});
  return {flow, calls, route: () => calls.map(call => `${call.method} ${call.path}`)};
}

test('pitch -> questions -> plan -> look -> rough cut -> final -> share, in that order', async () => {
  const {flow, calls, route} = fake();
  expect((await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: 'warm', rightsAttested: true})).step).toBe('questions');
  expect((await flow.plan([{id: 'q1', accepted: true}, {id: 'q2', accepted: false, reply: 'No music.'}])).step).toBe('look');
  expect(flow.state.pending).toHaveLength(1);
  expect((await flow.approveLook(true)).step).toBe('rough-cut');
  expect((await flow.approveRoughCut()).step).toBe('final');
  expect((await flow.share(5)).reviewUrl).toBe('https://studio.test/#/review/x');
  expect(route()).toEqual([
    'POST /api/projects', 'PUT /api/projects/p1/script', 'POST /api/projects/p1/rights', 'POST /api/projects/p1/crew/read-through',
    'POST /api/projects/p1/crew/plan', 'GET /api/projects/p1/cast', 'POST /api/projects/p1/crew/approve-cast',
    'POST /api/projects/p1/jobs', 'GET /api/jobs/animatic-1', 'POST /api/projects/p1/animatic/decision', 'POST /api/projects/p1/jobs', 'GET /api/jobs/final-1',
    'POST /api/projects/p1/reviews']);
  // Every call after the project exists carries its token.
  expect(calls.slice(1).every(call => call.auth === 'Bearer t1')).toBe(true);
  const plan = calls.find(call => call.path.endsWith('/crew/plan')).body;
  expect(plan.answers).toEqual([
    {id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.', accepted: true, reply: ''},
    {id: 'q2', persona: 'sound', question: 'Music?', proposal: 'Light.', accepted: false, reply: 'No music.'}]);
  expect(plan.expected).toEqual({scriptVersion: 1, castingVersion: 0, directionVersion: 0});
  expect(calls.find(call => call.path.endsWith('/approve-cast')).body).toEqual({attested: true, expectedVersion: 1});
  expect(calls.filter(call => call.path.endsWith('/jobs'))[1].body).toMatchObject({stage: 'final', animaticJobId: 'animatic-1'});
  expect(calls.at(-1).body).toMatchObject({permission: 'approve', jobId: 'final-1', maxViews: 5});
});

test('nothing is sent without the rights attestation or a script', async () => {
  const {flow, calls} = fake();
  await expect(flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: '', rightsAttested: false})).rejects.toThrow('rights');
  await expect(flow.pitch({script: '  ', format: 'reel', tone: '', rightsAttested: true})).rejects.toThrow('script');
  expect(calls).toEqual([]);
});

test('a script the crew cannot make stays at the pitch with the reason', async () => {
  for (const kind of BLOCKING_CONCERNS) {
    const {flow} = fake({'POST /api/projects/p1/crew/read-through': () => readThrough([{kind, detail: `blocked: ${kind}`}])});
    const state = await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: '', rightsAttested: true});
    expect(state.step).toBe('pitch');
    expect(state.blocked.map(concern => concern.detail)).toEqual([`blocked: ${kind}`]);
    expect(state.script).toBe('INT. ROOM - DAY');
  }
  const {flow} = fake({'POST /api/projects/p1/crew/read-through': () => readThrough([{kind: 'over_format', detail: 'long'}])});
  expect((await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true})).step).toBe('questions');
});

test('the crew never permits the cast; the creator must, before anything renders', async () => {
  const {flow, route} = fake();
  await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true});
  await flow.plan([]);
  await expect(flow.approveLook(false)).rejects.toThrow('original characters');
  expect(route().some(entry => entry.endsWith('/jobs') || entry.endsWith('/approve-cast'))).toBe(false);
});

test('asking for changes takes the film back to the crew', async () => {
  const {flow, calls} = fake();
  await flow.pitch({script: 'x', format: 'short', tone: 'noir', rightsAttested: true});
  await flow.plan([]);
  await flow.approveLook(true);
  expect((await flow.requestChanges()).step).toBe('questions');
  expect(calls.find(call => call.path.endsWith('/animatic/decision')).body).toEqual({animaticJobId: 'animatic-1', decision: 'changes_requested'});
  expect(calls.filter(call => call.path.endsWith('/read-through')).at(-1).body).toEqual({format: 'short', tone: 'noir'});
});

test('a failed render is reported, not shown as done', async () => {
  const {flow} = fake({'GET /api/jobs/animatic-1': () => ({status: 'failed', failureReason: 'We can\'t generate this shot.'})});
  await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true});
  await flow.plan([]);
  await expect(flow.approveLook(true)).rejects.toThrow("can't generate");
  expect(flow.state.step).toBe('look');
});

test('the page opens on the studio and keeps the Director\'s desk behind Advanced', () => {
  const page = readFileSync(join(SRC, 'index.html'), 'utf8');
  expect(page).toContain('<section id="studio" class="studio-panel" aria-label="Studio"></section>');
  expect(page).toContain('<section id="creator-flow" hidden>');
  expect(page).toContain('<input type="checkbox" id="advanced"> Advanced: Director\'s desk');
  expect(page).toContain('/api/studio/app.js');
  expect(Object.keys(PERSONA_TITLES)).toEqual(['producer', 'director', 'casting', 'cinematographer', 'sound', 'editor']);
  // Crew and creator text is assigned as text, never parsed as markup.
  expect(readFileSync(join(SRC, 'studio.js'), 'utf8')).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
});
