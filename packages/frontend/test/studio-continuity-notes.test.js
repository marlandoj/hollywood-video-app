/**
 * HV-021-09 — the studio names the Continuity Supervisor.
 *
 * The plan step now answers with notes from a seventh crew member, `continuity`, whose words come from
 * the continuity report rather than a model. The look approval shows each crew note as "<title>:
 * <change>" from `PERSONA_TITLES`; without the Supervisor's title there, its notes would have read
 * "undefined: …". It is credited only for a film its report could actually check.
 */
import {expect, test} from 'bun:test';
import {initStudio} from '../src/studio.js';
import {PERSONA_TITLES, continuityChecked, creditRows} from '../src/titles.js';

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

const NOTES = [
  {persona: 'cinematographer', change: 'Set the look for 3 shots.'},
  {persona: 'continuity', change: 'No reference image is kept yet for MAYA (scene 1), so how they look from shot to shot rests on the written description alone.', source: 'continuity-report'},
];

test('the look approval shows the Continuity Supervisor\'s notes under its own title', async () => {
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
        logline: 'A reunion.', summary: 'Quiet.', questions: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}),
      'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: NOTES, finalAnchors: false}),
      'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
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
    await all(root).find(element => element.tag === 'button' && element.textContent === 'Plan the film').onclick(); await settle();
    expect(view.flow.state.step).toBe('look');
    const shown = all(root).filter(element => element.tag === 'li').map(element => element.textContent);
    expect(shown).toEqual([`Cinematographer: ${NOTES[0].change}`, `Continuity Supervisor: ${NOTES[1].change}`]);
    expect(shown.some(text => text.startsWith('undefined'))).toBe(false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
  }
  expect(PERSONA_TITLES.continuity).toBe('Continuity Supervisor');
});

test('the Continuity Supervisor is credited only for a film its report could check', () => {
  const row = {role: 'Continuity by', name: 'Continuity Supervisor (AI crew)'};
  expect(creditRows({script: 'INT. ROOM - DAY', continuity: true}).at(-1)).toEqual(row);
  expect(creditRows({script: 'INT. ROOM - DAY'})).not.toContainEqual(row);
  // Checked: its notes came from the report, and the report could compare something.
  expect(continuityChecked({notes: NOTES, continuityComparisons: 3})).toBe(true);
  // Not checked: nothing to compare, no notes of its own, a note without the report's mark, or no plan at all (a resumed film).
  expect(continuityChecked({notes: NOTES, continuityComparisons: 0})).toBe(false);
  expect(continuityChecked({notes: [NOTES[0]], continuityComparisons: 3})).toBe(false);
  expect(continuityChecked({notes: [{...NOTES[1], source: undefined}], continuityComparisons: 3})).toBe(false);
  expect(continuityChecked(undefined)).toBe(false);
});
