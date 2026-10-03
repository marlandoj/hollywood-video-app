/**
 * HV-030-28 — the studio's pitch offers a feature (Release 3 step 1, G20-202610031349).
 *
 * The front door's format picker offered a reel and a short only, and a style card was read only if it
 * named one of those. The crew now accepts a feature, up to 20 minutes, so the picker offers it, the
 * pitch sends it, and a card made for a feature is read. The picker's formats are the crew's own
 * (`packages/planner/src/crew/formats.ts`), so the two can't drift apart.
 */
import {expect, test} from 'bun:test';
import {FILM_FORMATS as CREW_FORMATS, FORMAT_LIMIT_SEC} from '../../planner/src/crew/formats';
import {planInput} from '../../planner/src/crew/production-plan';
import {styleCardFrom} from '../../planner/src/crew/style-card';
import {FILM_FORMATS, FORMAT_CHOICES, createStudioFlow, initStudio, parseStyleCard} from '../src/studio.js';

test('the picker offers exactly the crew\'s formats, each labelled with its own limit', () => {
  expect(FILM_FORMATS).toEqual(['reel', 'short', 'feature']);
  expect(FILM_FORMATS).toEqual([...CREW_FORMATS]);
  expect(FORMAT_CHOICES.map(([value]) => value)).toEqual([...CREW_FORMATS]);
  const said = {reel: `${FORMAT_LIMIT_SEC.reel} seconds`, short: `${FORMAT_LIMIT_SEC.short / 60} minutes`, feature: `${FORMAT_LIMIT_SEC.feature / 60} minutes`};
  for (const [value, label] of FORMAT_CHOICES) expect(label).toContain(said[value]);
  expect(FORMAT_CHOICES.find(([value]) => value === 'feature')[1]).toBe('A feature, up to 20 minutes');
});

test('a card made for a feature is read; one naming a format the studio does not make is not', () => {
  const card = styleCardFrom(planInput({format: 'feature', tone: 'Slow and tender', answers: []}), 'Warm lamplight.');
  expect(card.format).toBe('feature');
  expect(parseStyleCard(JSON.stringify(card))).toEqual(card);
  for (const format of ['film', 'Feature', '', null]) expect(parseStyleCard(JSON.stringify({...card, format}))).toBeNull();
});

/** Just enough DOM to draw the pitch and find its controls. */
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

test('the pitch form offers a feature, and a feature pitch reaches the crew as one', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.Option = class extends Element {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  try {
    const sent = [];
    let project = null;
    const api = async (path, options = {}) => {
      const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      if (method === 'POST' && path === '/api/projects') return {projectId: 'p1', token: 't1'};
      if (path === '/api/projects/p1/crew/read-through') {sent.push(body);
        return {facts: {concerns: [], scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.84}}, logline: 'A feature.', summary: 'Long.', questions: [],
          expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}};}
      return {version: 1};
    };
    const storage = {getItem: () => null, setItem() {}, removeItem() {}};
    const root = new Element('main');
    const view = initStudio({root, storage, api, getProject: () => project, setProject: value => {project = value;}, attach: () => {}, assetUrl: url => String(url)});
    const find = id => all(root).find(element => element.id === id);
    const picker = find('studio-format');
    expect(picker.children.map(option => [option.value, option.textContent])).toEqual(FORMAT_CHOICES.map(([value, label]) => [value, label]));
    expect(picker.value).toBe('reel');
    find('studio-script').value = 'INT. ROOM - DAY'; find('studio-rights').checked = true; picker.value = 'feature';
    all(root).find(element => element.tag === 'form').onsubmit({preventDefault() {}});
    for (let turn = 0; turn < 200 && view.flow.state.step === 'pitch'; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toEqual([{format: 'feature', tone: ''}]);
    expect(view.flow.state.format).toBe('feature');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
  }
});

test('the flow hands the crew a feature, and the plan step sends it back as the film\'s format', async () => {
  const calls = [];
  let project = null;
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body});
    if (method === 'POST' && path === '/api/projects') return {projectId: 'p1', token: 't1'};
    if (path.endsWith('/crew/read-through')) return {facts: {concerns: [], scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.84}}, logline: 'A feature.', summary: 'Long.',
      questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}};
    if (path.endsWith('/crew/plan')) return {lookNote: '', notes: [], finalAnchors: false};
    if (path.endsWith('/cast')) return {casting: {version: 1, characters: []}};
    if (path.endsWith('/spend')) return {spentUsd: 0, heldUsd: 0, capUsd: 150};
    return {version: 1};
  };
  const flow = createStudioFlow({api, storage: {getItem: () => null, setItem() {}, removeItem() {}}, getProject: () => project, setProject: value => {project = value;}, wait: async () => {}});
  await flow.pitch({script: 'INT. ROOM - DAY', format: 'feature', tone: 'slow', rightsAttested: true});
  const look = await flow.plan([{id: 'q1', accepted: true}]);
  expect(calls.find(call => call.path.endsWith('/crew/plan')).body.format).toBe('feature');
  expect(look.spend.capUsd).toBe(150);
});
