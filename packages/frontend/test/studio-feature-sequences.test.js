/**
 * HV-030-29 — the front door makes a feature one sequence at a time (G20-202610031349: the look is
 * approved once for the whole feature, then the rough cut and the final per sequence).
 *
 * Driven through a fake network that records every call. A reel's requests and words are unchanged;
 * `studio.test.js` holds its whole route.
 */
import {expect, test} from 'bun:test';
import {STEP_TITLES, createStudioFlow, initStudio, spendText, stepTitle} from '../src/studio.js';

const SEQUENCES = [{number: 1, firstScene: 1, lastScene: 4, shots: 22}, {number: 2, firstScene: 5, lastScene: 9, shots: 24}, {number: 3, firstScene: 10, lastScene: 12, shots: 9}];
const ref = number => ({number, of: 3, firstScene: SEQUENCES[number - 1].firstScene, lastScene: SEQUENCES[number - 1].lastScene, planRevision: 'a'.repeat(64)});

function fake({feature = true} = {}) {
  const calls = [], jobs = new Map();
  let project = null, next = 0;
  const spend = () => ({spentUsd: 1.5, heldUsd: 0.5, capUsd: feature ? 150 : 40,
    ...(feature ? {sequences: SEQUENCES.map(sequence => ({...sequence, spentUsd: sequence.number === 1 ? 1.25 : 0, heldUsd: 0}))} : {})});
  const routes = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => ({facts: {concerns: [], scenes: 12, shots: 55, estimatedRuntimeSec: 110, estimate: {finalVideoUsd: 23.1}},
      logline: 'A long night.', summary: 'Long.', questions: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [{persona: 'showrunner', change: 'Split the feature into 3 sequences.'}], finalAnchors: false,
      ...(feature ? {sequences: {source: 'stand-in', revision: 'a'.repeat(64), sequences: SEQUENCES}} : {})}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: [{name: 'MARA', kind: 'original-fictional', permission: {status: 'pending'}}]}}),
    'POST /api/projects/p1/crew/approve-cast': () => ({}),
    'POST /api/projects/p1/jobs': body => {
      const id = `${body.stage === 'final' ? 'final' : 'animatic'}-${++next}`;
      const animatic = body.stage === 'final' ? jobs.get(body.animaticJobId) : null;
      const sequence = body.stage === 'final' ? animatic.sequence : body.sequence ? ref(body.sequence) : undefined;
      jobs.set(id, {id, status: 'done', storyboard: [], output: {}, outputRevision: 'r'.repeat(64), ...(sequence ? {sequence} : {})});
      return {jobId: id};
    },
    'POST /api/projects/p1/animatic/decision': () => ({}),
    'GET /api/projects/p1/spend': spend,
    'GET /api/projects/p1/audio-takes': () => ({enabled: false}),
    'GET /api/projects/p1/graphics': () => ({rendering: {available: false}, library: {version: 0}, graphics: []}),
    'POST /api/projects/p1/reviews': body => ({reviewUrl: 'https://studio.test/#/review/x', maxViews: body.maxViews}),
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body});
    if (method === 'GET' && path.startsWith('/api/jobs/')) return jobs.get(path.slice('/api/jobs/'.length));
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(body);
  };
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {}});
  const renders = () => calls.filter(call => call.method === 'POST' && call.path === '/api/projects/p1/jobs').map(call => call.body);
  return {flow, calls, renders};
}

test('a feature: the look once, then each sequence\'s rough cut and final, one after another', async () => {
  const {flow, calls, renders} = fake();
  await flow.pitch({script: 'INT. ROOM - DAY', format: 'feature', tone: '', rightsAttested: true});
  const look = await flow.plan([]);
  expect([look.sequence, look.sequences]).toEqual([1, SEQUENCES]);
  expect(stepTitle(look)).toBe('Approval 1 of 7: the plan and the look, once for the whole feature');
  let state = await flow.approveLook(true);
  for (const number of [1, 2, 3]) {
    expect(state.step).toBe('rough-cut');
    expect(state.animatic.sequence.number).toBe(number);
    expect(stepTitle(state)).toBe(`Approval ${2 * number} of 7: sequence ${number} of 3, its storyboard and rough cut`);
    state = await flow.approveRoughCut();
    expect(state.step).toBe('final');
    expect(stepTitle(state)).toBe(`Approval ${2 * number + 1} of 7: sequence ${number} of 3, its film`);
    expect(state.finishNotes).toContain("Editor: a sequence carries no title or credits. They belong to the whole feature, once its sequences are joined into one film, which the studio doesn't do yet.");
    if (number < 3) state = await flow.nextSequence();
  }
  await expect(flow.nextSequence()).rejects.toThrow('Every sequence of this feature is made.');
  // The look approval happened once; each render named its sequence; each final followed its own rough cut.
  expect(calls.filter(call => call.path.endsWith('/crew/approve-cast'))).toHaveLength(1);
  expect(renders()).toEqual([{sequence: 1}, {stage: 'final', animaticJobId: 'animatic-1', sequence: 1}, {sequence: 2}, {stage: 'final', animaticJobId: 'animatic-3', sequence: 2},
    {sequence: 3}, {stage: 'final', animaticJobId: 'animatic-5', sequence: 3}]);
  // No title, credits or joined film was asked for.
  expect(calls.some(call => call.path.includes('/graphics') || call.path.includes('/editorial'))).toBe(false);
  expect(Object.keys(state.finals)).toEqual(['1', '2']);
});

test('the spend line says the sequence\'s and the feature\'s running cost; a reel\'s is unchanged', () => {
  const sequences = SEQUENCES, spend = {spentUsd: 1.5, heldUsd: 0.5, capUsd: 150, sequences: SEQUENCES.map(sequence => ({...sequence, spentUsd: sequence.number === 2 ? 0.75 : 0, heldUsd: 0.25}))};
  expect(spendText({sequences, sequence: 2, spend})).toBe('Sequence 2 of 3 so far: $1.00. The whole feature so far: $2.00 of its $150.00 limit.');
  expect(spendText({spend: {spentUsd: 1.5, heldUsd: 0.5, capUsd: 40}})).toBe('Spent on this film so far: $2.00 of its $40.00 limit.');
  for (const step of ['pitch', 'questions', 'look', 'rough-cut', 'final']) expect(stepTitle({step})).toBe(STEP_TITLES[step]);
});

test('a reel renders whole and names no sequence, and the next-sequence step is refused', async () => {
  const {flow, renders} = fake({feature: false});
  await flow.pitch({script: 'INT. ROOM - DAY', format: 'reel', tone: '', rightsAttested: true});
  expect((await flow.plan([])).sequences).toBeUndefined();
  await flow.approveLook(true);
  const final = await flow.approveRoughCut();
  expect(renders()).toEqual([{}, {stage: 'final', animaticJobId: 'animatic-1'}]);
  expect(final.finishNotes.some(note => note.startsWith('Editor: a sequence'))).toBe(false);
  await expect(flow.nextSequence()).rejects.toThrow('Only a feature is made one sequence after another.');
});

/** Just enough DOM to draw a step and read it. */
class Element {
  constructor(tag) {this.tag = tag; this.attributes = {}; this.children = []; this.dataset = {}; this.style = {};}
  setAttribute(name, value) {this.attributes[name] = String(value);}
  append(...nodes) {this.children.push(...nodes);}
  prepend(...nodes) {this.children.unshift(...nodes);}
  replaceChildren(...nodes) {this.children = [...nodes];}
  get lastChild() {return this.children.at(-1) ?? null;}
  focus() {}
  querySelectorAll() {return [];}
  set textContent(value) {this.written = value;}
  get textContent() {return this.written ?? '';}
}
const all = element => element.children.flatMap(child => [child, ...all(child)]);

test('each sequence\'s film offers the next sequence; the last says the sequences aren\'t joined yet', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.Option = class extends Element {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  try {
    const {flow} = fake();
    await flow.pitch({script: 'INT. ROOM - DAY', format: 'feature', tone: '', rightsAttested: true});
    await flow.plan([]);
    await flow.approveLook(true);
    await flow.approveRoughCut();
    const root = new Element('main');
    const view = initStudio({root, api: async () => ({}), getProject: () => null, setProject() {}, attach() {}, assetUrl: url => url, storage: null});
    // Draw the flow's state through the studio's own renderer.
    Object.defineProperty(view.flow, 'state', {get: () => flow.state});
    view.render();
    const words = () => all(root).map(element => element.textContent).filter(Boolean);
    expect(words()).toContain('Approve sequence 1 and make sequence 2\'s rough cut');
    expect(words()).toContain('Share sequence 1 with a reviewer');
    expect(words()).toContain('Sequence 1 of 3 so far: $1.25. The whole feature so far: $2.00 of its $150.00 limit.');
    await flow.nextSequence(); await flow.approveRoughCut(); await flow.nextSequence(); await flow.approveRoughCut();
    view.render();
    expect(words().some(text => text.startsWith('Approve sequence'))).toBe(false);
    expect(words()).toContain('All 3 sequences are made. Each is its own film for now: joining them into one feature, with its title and credits, isn\'t built yet.');
    expect(words().some(text => /the feature is (ready|made)|your feature/i.test(text))).toBe(false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
  }
});
