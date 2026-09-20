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
    'GET /api/projects/p1/spend': () => ({spentUsd: 0, heldUsd: 0, capUsd: 40}),
    ...overrides,
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body, auth: options.headers?.authorization});
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(body);
  };
  const images = [];
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {},
    fetchImage: async url => { images.push(url); return new Uint8Array([137, 80, 78, 71]).buffer; }});
  return {flow, calls, images, route: () => calls.map(call => `${call.method} ${call.path}`)};
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
    'POST /api/projects/p1/crew/plan', 'GET /api/projects/p1/cast', 'GET /api/projects/p1/spend', 'POST /api/projects/p1/crew/approve-cast',
    'POST /api/projects/p1/jobs', 'GET /api/jobs/animatic-1', 'GET /api/projects/p1/spend', 'POST /api/projects/p1/animatic/decision', 'POST /api/projects/p1/jobs', 'GET /api/jobs/final-1',
    'GET /api/projects/p1/spend', 'POST /api/projects/p1/reviews']);
  expect(flow.state.spend).toEqual({spentUsd: 0, heldUsd: 0, capUsd: 40});
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

// HV-017-06: with a final provider that starts from a given frame, the crew pins each still of
// the rough cut as its shot's first frame and re-cuts the rough cut from them.
test('the storyboard stills become the final\'s first frames when the final pool can use them', async () => {
  const entry = (id, extra = {}) => ({source: {id}, sourceHash: 'h-' + id, settings: {size: 'wide', durationFrames: 150, ...extra}});
  let jobs = 0;
  const {flow, calls, images, route} = fake({
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: true}),
    'POST /api/projects/p1/jobs': body => ({jobId: body.stage === 'final' ? 'final-1' : `animatic-${++jobs}`}),
    'GET /api/jobs/animatic-2': () => ({id: 'animatic-2', status: 'done', storyboard: [], output: {}}),
    'GET /api/projects/p1/direction': () => ({scriptVersion: 1, direction: {version: 1, entries: [entry('shot-1-1'), entry('shot-2-1', {frameAnchors: {frames: [], fallback: 'stop'}})]},
      plan: [{source: {id: 'shot-1-1'}, sourceHash: 'h-shot-1-1'}, {source: {id: 'shot-2-1'}, sourceHash: 'h-shot-2-1'}],
      viewfinderSources: [{shotId: 'shot-1-1', jobId: 'animatic-1', url: '/artifacts/x/shot-1-1.png'}, {shotId: 'shot-2-1', jobId: 'animatic-1', url: '/artifacts/x/shot-2-1.png'},
        {shotId: 'shot-3-1', jobId: 'older', url: '/artifacts/y/shot-3-1.png'}]}),
    'POST /api/projects/p1/direction/shot-1-1/anchors?label=Storyboard%20still': () => ({asset: {id: 'a1'}}),
    'PUT /api/projects/p1/direction/shot-1-1': () => ({direction: {version: 2}}),
  });
  await flow.pitch({script: 'x', format: 'reel', tone: '', rightsAttested: true});
  await flow.plan([]);
  expect((await flow.approveLook(true)).animatic.id).toBe('animatic-2');
  // Only the crew-directed, unanchored shot of this rough cut is pinned; the creator's own anchor and older renders are left.
  expect(images).toEqual(['/artifacts/x/shot-1-1.png']);
  expect(route().slice(8)).toEqual(['POST /api/projects/p1/jobs', 'GET /api/jobs/animatic-1', 'GET /api/projects/p1/direction',
    'POST /api/projects/p1/direction/shot-1-1/anchors?label=Storyboard%20still', 'PUT /api/projects/p1/direction/shot-1-1',
    'POST /api/projects/p1/jobs', 'GET /api/jobs/animatic-2', 'GET /api/projects/p1/spend']);
  const upload = calls.find(call => call.path.includes('/anchors'));
  expect(upload.body).toBeInstanceOf(ArrayBuffer);
  const put = calls.find(call => call.method === 'PUT' && call.path.endsWith('/direction/shot-1-1')).body;
  expect(put).toEqual({settings: {size: 'wide', durationFrames: 150, frameAnchors: {frames: [{at: 0, asset: {id: 'a1'}}], fallback: 'stop'}},
    sourceHash: 'h-shot-1-1', expectedVersion: 1, expectedScriptVersion: 1});
  await flow.approveRoughCut();
  expect(calls.filter(call => call.path.endsWith('/jobs')).at(-1).body).toMatchObject({stage: 'final', animaticJobId: 'animatic-2'});
});

