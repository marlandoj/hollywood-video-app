/**
 * HV-030-25 — the read-through says how many of the crew's questions were left out.
 *
 * A paid answer with one defective question (too long, an unknown crew member, past three each) is
 * now kept with that question dropped, and the read-through answers with `dropped`. The studio tells
 * the creator, as line notes do, rather than leaving out questions silently.
 */
import {expect, test} from 'bun:test';
import {initStudio} from '../src/studio.js';

class Element {
  constructor(tag) {this.tag = tag; this.attributes = {}; this.children = []; this.dataset = {}; this.style = {};}
  setAttribute(name, value) {this.attributes[name] = String(value);}
  getAttribute(name) {return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;}
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

async function questionsShown(readThrough) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.Option = class extends Element {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  try {
    let project = null;
    const responses = {
      'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
      'PUT /api/projects/p1/script': () => ({version: 1}),
      'POST /api/projects/p1/rights': () => ({}),
      'POST /api/projects/p1/crew/read-through': () => ({facts: {concerns: [], scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
        logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}],
        expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}, source: 'openrouter', ...readThrough}),
      'GET /api/projects/p1/spend': () => ({spentUsd: 0, heldUsd: 0, capUsd: 40}),
    };
    const api = async (path, options = {}) => {
      const handler = responses[`${options.method ?? 'GET'} ${path}`];
      if (!handler) throw new Error(`unexpected ${options.method ?? 'GET'} ${path}`);
      return handler();
    };
    const root = new Element('main');
    const view = initStudio({root, api, getProject: () => project, setProject: value => {project = value;}, attach: () => {}, assetUrl: url => String(url)});
    const settle = async () => {for (let turn = 0; turn < 50; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));};
    const form = all(root).find(element => element.tag === 'form');
    all(form).find(element => element.tag === 'textarea').value = 'INT. ROOM - DAY';
    all(form).find(element => element.tag === 'input' && element.type === 'checkbox').checked = true;
    form.onsubmit({preventDefault() {}}); await settle();
    expect(view.flow.state.step).toBe('questions');
    return all(root).filter(element => element.tag === 'p').map(element => element.textContent);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
  }
}

test('the read-through says how many of the crew\'s questions were left out', async () => {
  expect(await questionsShown({dropped: 1})).toContain('1 of the crew\'s questions couldn\'t be used and was left out.');
  expect(await questionsShown({dropped: 2})).toContain('2 of the crew\'s questions couldn\'t be used and were left out.');
  for (const quiet of [{dropped: 0}, {}]) expect((await questionsShown(quiet)).some(text => text.includes('left out'))).toBe(false);
});
