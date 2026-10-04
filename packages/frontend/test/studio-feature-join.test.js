/**
 * HV-030-30 — after the last sequence's film the Editor joins the feature's sequences into one film,
 * with one opening title and one end credits, and that one film is what the creator shares
 * (Release 3 step 7).
 *
 * Driven through a fake network that records every call. `studio-feature-sequences.test.js` holds the
 * sequence-by-sequence route and a join that stops; `studio.test.js` holds a reel's whole route; the
 * real join is `packages/api/test/studio-feature-join.test.ts`.
 */
import {expect, test} from 'bun:test';
import {createStudioFlow, featureJoinKey, initStudio, stepTitle} from '../src/studio.js';
import {TITLE_FRAMES, creditRows} from '../src/titles.js';

const SEQUENCES = [{number: 1, firstScene: 1, lastScene: 4, shots: 22}, {number: 2, firstScene: 5, lastScene: 9, shots: 24}, {number: 3, firstScene: 10, lastScene: 12, shots: 9}];
const ref = number => ({number, of: 3, firstScene: SEQUENCES[number - 1].firstScene, lastScene: SEQUENCES[number - 1].lastScene, planRevision: 'a'.repeat(64)});

function fake({graphics = true, joinFails = 0} = {}) {
  const calls = [], jobs = new Map(), saved = [];
  let project = null, next = 0, failures = joinFails;
  const routes = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => ({facts: {concerns: [], scenes: 12, shots: 55, estimatedRuntimeSec: 110, estimate: {finalVideoUsd: 23.1}},
      logline: 'A long night.', summary: 'Long.', questions: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [{persona: 'showrunner', change: 'Split the feature into 3 sequences.'}], finalAnchors: false,
      sequences: {source: 'stand-in', revision: 'a'.repeat(64), sequences: SEQUENCES}}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
    'POST /api/projects/p1/jobs': body => {
      const id = `${body.stage === 'final' ? 'final' : 'animatic'}-${++next}`;
      const sequence = body.stage === 'final' ? jobs.get(body.animaticJobId).sequence : ref(body.sequence);
      jobs.set(id, {id, stage: body.stage ?? 'animatic', status: 'done', storyboard: [], output: {}, outputRevision: 'r'.repeat(64), sequence});
      return {jobId: id};
    },
    'POST /api/projects/p1/animatic/decision': () => ({}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 1.5, heldUsd: 0, capUsd: 150, sequences: SEQUENCES.map(sequence => ({...sequence, spentUsd: 0.5, heldUsd: 0}))}),
    'GET /api/projects/p1/audio-takes': () => ({enabled: false}),
    'GET /api/projects/p1/graphics': () => ({rendering: {available: graphics}, library: {version: saved.length}, graphics: graphicsView()}),
    'PUT /api/projects/p1/graphics': body => { saved.push(body); return {library: {version: body.expectedVersion + 1}, graphics: graphicsView()}; },
    'POST /api/projects/p1/graphics/crew-title/renders': () => ({jobId: 'g-title'}),
    'POST /api/projects/p1/graphics/crew-credits/renders': () => ({jobId: 'g-credits'}),
    'GET /api/projects/p1/graphics/jobs/g-title': () => ({id: 'g-title', status: 'done'}),
    'GET /api/projects/p1/graphics/jobs/g-credits': () => ({id: 'g-credits', status: 'done'}),
    'GET /api/projects/p1/feature-film': () => ({planRevision: 'a'.repeat(64), size: {width: 1280, height: 720}, crossfadeFrames: 12, costUsd: 0, jobs: [],
      sequences: SEQUENCES.map((sequence, index) => ({...sequence, final: {jobId: `final-${2 * index + 2}`, frames: 600}}))}),
    'POST /api/projects/p1/feature-film': () => {
      if (failures-- > 0) throw new Error("Sequence 2's final is stale.");
      jobs.set('joined-1', {id: 'joined-1', stage: 'feature-film', status: 'done', outputRevision: 'j'.repeat(64), output: {mp4Url: '/joined.mp4'}});
      return {jobId: 'joined-1', admitted: true};
    },
    'POST /api/projects/p1/reviews': body => ({reviewUrl: 'https://studio.test/#/review/x', maxViews: body.maxViews}),
  };
  // The library answers each saved graphic at its latest plan, as the graphics route does.
  const graphicsView = () => [...new Map(saved.map(value => [value.change.id, value])).values()].map(value => ({available: true,
    spec: {id: value.change.id, label: value.change.label, plan: value.change.plan, revision: `${value.change.id}-revision-0123456789abcdef0123456789abcdef`}}));
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body});
    if (method === 'GET' && path.startsWith('/api/jobs/')) return jobs.get(path.slice('/api/jobs/'.length));
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(body);
  };
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {}});
  return {flow, calls, saved};
}

async function makeFeature(flow) {
  await flow.pitch({script: 'Title: The Long Night\nAuthor: Ana Ruiz\n\nINT. ROOM - DAY', format: 'feature', tone: '', rightsAttested: true});
  await flow.plan([]);
  let state = await flow.approveLook(true);
  for (const number of [1, 2, 3]) {
    state = await flow.approveRoughCut();
    if (number < 3) state = await flow.nextSequence();
  }
  return state;
}
const joins = calls => calls.filter(call => call.method === 'POST' && call.path === '/api/projects/p1/feature-film').map(call => call.body);

test('after the last sequence the Editor joins the three films with one title and one credits, and shares that one film', async () => {
  const {flow, calls, saved} = fake();
  const state = await makeFeature(flow);
  // Nothing was joined or titled before the last sequence's final.
  const first = calls.findIndex(call => call.path.includes('/feature-film') || call.path.includes('/graphics'));
  expect(calls.slice(0, first).filter(call => call.path === '/api/projects/p1/jobs').map(call => call.body)).toEqual([{sequence: 1}, {stage: 'final', animaticJobId: 'animatic-1', sequence: 1},
    {sequence: 2}, {stage: 'final', animaticJobId: 'animatic-3', sequence: 2}, {sequence: 3}, {stage: 'final', animaticJobId: 'animatic-5', sequence: 3}]);
  expect(calls.slice(first).some(call => call.path.includes('/editorial'))).toBe(false);

  expect([state.step, state.joined, state.joinedTitled, state.final.id, state.final.stage]).toEqual(['final', true, true, 'joined-1', 'feature-film']);
  expect(stepTitle(state)).toBe('Approval 7 of 7: the whole feature, its 3 sequences joined into one film');
  // One opening title and one end credits, at the feature's size; the credits name the Showrunner.
  expect(saved.map(value => [value.change.id, value.change.plan.kind, value.change.plan.width, value.change.plan.height])).toEqual([['crew-title', 'title', 1280, 720], ['crew-credits', 'credits', 1280, 720]]);
  expect([saved[0].change.plan.text, saved[0].change.plan.frames]).toEqual(['The Long Night', TITLE_FRAMES]);
  expect(saved[1].change.plan.credits[0]).toEqual({role: 'Written by', name: 'Ana Ruiz'});
  expect(saved[1].change.plan.credits).toContainEqual({role: 'Sequences by', name: 'Showrunner (AI crew)'});
  // One join, naming each sequence's film in order and the two graphics, keyed by them.
  expect(joins(calls)).toEqual([{idempotencyKey: featureJoinKey(['final-2', 'final-4', 'final-6', 'g-title', 'g-credits']), generationApproved: true,
    sequences: [{number: 1, jobId: 'final-2'}, {number: 2, jobId: 'final-4'}, {number: 3, jobId: 'final-6'}], title: 'g-title', credits: 'g-credits'}]);
  expect(featureJoinKey(['final-2', 'final-4', 'final-6', 'g-title', 'g-credits'])).toMatch(/^crew-feature-[0-9a-f]{16}$/);
  // One review link, bound to the joined film.
  await flow.share(2);
  expect(calls.filter(call => call.path === '/api/projects/p1/reviews').map(call => call.body)).toEqual([{permission: 'approve', jobId: 'joined-1', expectedOutputRevision: 'j'.repeat(64), maxViews: 2}]);
});

test('a join the studio refuses keeps the last sequence\'s film; asked again, it is the same join with the same graphics', async () => {
  const {flow, calls, saved} = fake({joinFails: 1});
  const stopped = await makeFeature(flow);
  expect([stopped.joined, stopped.final.id]).toEqual([false, 'final-6']);
  expect(stopped.finishNotes.at(-1)).toBe("Editor: the sequences could not be joined into one film (Sequence 2's final is stale.); each sequence is still its own film, and you can ask the Editor to join them again.");
  expect(stepTitle(stopped)).toBe('Approval 7 of 7: sequence 3 of 3, its film');
  const joined = await flow.joinAgain();
  expect([joined.joined, joined.final.id]).toEqual([true, 'joined-1']);
  expect(joined.finishNotes.some(note => note.startsWith('Editor: the sequences could not be joined'))).toBe(false);
  const [one, two] = joins(calls);
  expect(two).toEqual(one);
  // The saved graphics were reused, not saved again.
  expect(saved).toHaveLength(2);
  await expect(flow.joinAgain()).rejects.toThrow('The feature is already joined into one film.');
});

test('without a graphics renderer the sequences are still joined, untitled, and the Editor says so', async () => {
  const {flow, calls} = fake({graphics: false});
  const state = await makeFeature(flow);
  expect([state.joined, state.joinedTitled]).toEqual([true, false]);
  expect(state.finishNotes).toContain('Editor: titles and credits were skipped because this studio has no graphics renderer installed; the feature is joined untitled.');
  expect(joins(calls).map(body => [body.title, body.credits, body.idempotencyKey])).toEqual([[null, null, featureJoinKey(['final-2', 'final-4', 'final-6', 'untitled', 'untitled'])]]);
});

test('the credits name the Showrunner only for a feature', () => {
  expect(creditRows({script: ''}).some(row => row.role === 'Sequences by')).toBe(false);
  expect(creditRows({script: '', showrunner: true}).filter(row => row.role === 'Sequences by')).toEqual([{role: 'Sequences by', name: 'Showrunner (AI crew)'}]);
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

test('the joined feature is the one film downloaded and shared, and no "not joined yet" wording is left', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.Option = class extends Element {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  try {
    const {flow} = fake();
    await makeFeature(flow);
    const root = new Element('main');
    const view = initStudio({root, api: async () => ({}), getProject: () => null, setProject() {}, attach() {}, assetUrl: url => url, storage: null});
    Object.defineProperty(view.flow, 'state', {get: () => flow.state});
    view.render();
    const words = all(root).map(element => element.textContent).filter(Boolean);
    expect(words).toContain('Approval 7 of 7: the whole feature, its 3 sequences joined into one film');
    expect(words).toContain('All 3 sequences are joined into one film, with its opening title and end credits.');
    expect(words).toContain('Download the feature (MP4)');
    expect(words).toContain('Share the feature with a reviewer');
    expect(words.some(text => /Share sequence|Download sequence|join the sequences again|not joined yet|isn't built yet|doesn't do yet/i.test(text))).toBe(false);
    const source = await Bun.file(new URL('../src/studio.js', import.meta.url)).text();
    expect(source).not.toMatch(/isn't built yet|doesn't do yet|not joined yet/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
  }
});
