/**
 * HV-034-02 — the front door shows a feature's style bible at Approval 1, and sends the creator's
 * attached style card with a feature's plan so the Showrunner's bible can read it. A reel's and a
 * short's plan request and look step are unchanged.
 */
import {expect, test} from 'bun:test';
import {createStudioFlow, initStudio, styleBibleSummary} from '../src/studio.js';

const CARD = {schema: 'hv-crew-style-card/1', format: 'short', tone: 'Wry.', look: 'Pastel colour.', choices: []};
const BIBLE = {schema: 'hv-style-bible/1', version: 1, scriptVersion: 1, source: 'stand-in', look: 'Pastel colour.', palette: 'Teal and amber.', lighting: 'Practical lamps.',
  lens: 'Long lenses.', tone: 'Wry.', sound: 'Wind.', characters: [{name: 'MARA', description: 'A tall woman.'}],
  locations: [{name: 'KITCHEN', description: 'A kitchen.'}, {name: 'YARD', description: 'A yard.'}], revision: 'b'.repeat(64)};

function fake({feature}) {
  const calls = [];
  const routes = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => ({facts: {concerns: [], scenes: 2, shots: 30, estimatedRuntimeSec: 60, estimate: {finalVideoUsd: 1}},
      logline: 'A night.', summary: 'Short.', questions: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: false,
      ...(feature ? {sequences: {source: 'stand-in', revision: 'a'.repeat(64), sequences: [{number: 1, firstScene: 1, lastScene: 1, shots: 13, bibleRevision: BIBLE.revision},
        {number: 2, firstScene: 2, lastScene: 2, shots: 13, bibleRevision: BIBLE.revision}]},
      styleBible: {kept: false, source: 'stand-in', dropped: [], bible: BIBLE}} : {})}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: [{name: 'MARA', kind: 'original-fictional', appearance: 'A tall woman.', permission: {status: 'pending'}}]}}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 0, heldUsd: 0, capUsd: feature ? 150 : 40}),
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body});
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(body);
  };
  let project = null;
  const flow = createStudioFlow({api, getProject: () => project, setProject: value => { project = value; }, wait: async () => {}});
  return {flow, plans: () => calls.filter(call => call.path.endsWith('/crew/plan')).map(call => call.body)};
}

test('a feature\'s plan carries the attached style card; a reel\'s and a short\'s request is unchanged', async () => {
  const feature = fake({feature: true});
  await feature.flow.pitch({script: 'INT. ROOM - DAY', format: 'feature', tone: '', rightsAttested: true, styleCard: CARD});
  await feature.flow.plan([]);
  expect(feature.plans()).toEqual([{format: 'feature', tone: '', answers: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}, styleCard: CARD}]);
  const unattached = fake({feature: true});
  await unattached.flow.pitch({script: 'INT. ROOM - DAY', format: 'feature', tone: '', rightsAttested: true});
  await unattached.flow.plan([]);
  expect(unattached.plans()[0]).not.toHaveProperty('styleCard');
  for (const format of ['reel', 'short']) {
    const other = fake({feature: false});
    await other.flow.pitch({script: 'INT. ROOM - DAY', format, tone: '', rightsAttested: true, styleCard: CARD});
    await other.flow.plan([]);
    expect(other.plans()).toEqual([{format, tone: '', answers: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}]);
  }
});

test('the summary is the bible\'s look, palette, lighting and lens, and what it holds; a reel has none', () => {
  expect(styleBibleSummary({styleBible: {bible: BIBLE}})).toEqual({heading: 'The style bible, kept for every sequence',
    lines: ['Look: Pastel colour.', 'Palette: Teal and amber.', 'Lighting: Practical lamps.', 'Lens and framing: Long lenses.', '1 character and 2 locations, described once for the whole feature.']});
  expect(styleBibleSummary({lookNote: 'Soft light.'})).toBeNull();
  expect(styleBibleSummary(undefined)).toBeNull();
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

test('Approval 1 of a feature shows the bible\'s summary; a reel\'s look step doesn\'t', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.Option = class extends Element {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  try {
    for (const feature of [true, false]) {
      const {flow} = fake({feature});
      await flow.pitch({script: 'INT. ROOM - DAY', format: feature ? 'feature' : 'reel', tone: '', rightsAttested: true});
      await flow.plan([]);
      const root = new Element('main');
      const view = initStudio({root, api: async () => ({}), getProject: () => null, setProject() {}, attach() {}, assetUrl: url => url, storage: null});
      Object.defineProperty(view.flow, 'state', {get: () => flow.state});
      view.render();
      const words = all(root).map(element => element.textContent).filter(Boolean);
      if (feature) {
        expect(words).toContain('The style bible, kept for every sequence');
        expect(words).toContain('Look: Pastel colour.');
        expect(words).toContain('1 character and 2 locations, described once for the whole feature.');
      } else expect(words.some(text => text.includes('style bible'))).toBe(false);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
  }
});
