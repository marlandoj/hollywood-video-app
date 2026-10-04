/**
 * HV-021-11 — the front door says where a feature's continuity findings meet a sequence boundary.
 *
 * The look approval shows the plan step's crew notes. For a feature, the Continuity Supervisor's notes
 * are made from a report that covers each sequence boundary, and name the scene opening a sequence as
 * such. The notes here are the planner's own (`continuitySupervisorNotes` over `continuityReport` with
 * the sequence plan) for a six-scene feature in three sequences, so what the studio shows is what the
 * plan route answers.
 */
import {expect, test} from 'bun:test';
import {parseFountain} from '../../parser/src/index';
import {castingSnapshot} from '../../planner/src/casting';
import {directionEntry, directionSnapshot} from '../../planner/src/direction';
import {continuityReport} from '../../planner/src/continuity';
import {continuitySupervisorNotes} from '../../planner/src/crew/continuity-supervisor';
import {featureShots, greedySequences, sceneShotCounts, sequencePlan} from '../../planner/src/sequences';
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

const now = Date.UTC(2026, 9, 4);
const HEADINGS = ['INT. LIGHTHOUSE - NIGHT', 'INT. LANTERN ROOM - NIGHT', 'INT. STAIRWELL - CONTINUOUS', 'INT. STAIRWELL - NIGHT', 'INT. STAIRWELL - CONTINUOUS', 'EXT. CLIFF - DAY'];
const SCRIPT = HEADINGS.map((heading, i) => heading + '\n\n' + Array.from({length: 9}, (_, b) => `Marguerite moves through scene ${i + 1}, step ${b + 1}.`).join('\n\n')).join('\n\n');

test('the look approval names the scene opening each sequence in the Continuity Supervisor\'s notes', async () => {
  const parsed = parseFountain(SCRIPT), shots = featureShots(parsed), plan = sequencePlan(1, greedySequences(sceneShotCounts(parsed)));
  const shot = id => shots.find(value => value.id === id);
  // Scene 5 opens sequence 3, CONTINUOUS in the stairwell scene 4 closed sequence 2 in, and is lit otherwise; scene 3 opens sequence 2 directed day after a NIGHT scene.
  const entries = [directionEntry(shot('shot-4-1'), {keyLight: 'Low lamp light'}), directionEntry(shot('shot-5-1'), {keyLight: 'Bright daylight'}), directionEntry(shot('shot-3-1'), {timeOfDay: 'day'})];
  const notes = continuitySupervisorNotes(continuityReport(shots, castingSnapshot('project-1', 0, [], now), directionSnapshot('project-1', 1, entries, now), parsed, plan));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.Option = class extends Element {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  try {
    let project = null;
    const sequences = plan.sequences.map((sequence, index) => ({number: index + 1, ...sequence}));
    const responses = {
      'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
      'PUT /api/projects/p1/script': () => ({version: 1}),
      'POST /api/projects/p1/rights': () => ({}),
      'POST /api/projects/p1/crew/read-through': () => ({facts: {concerns: [], scenes: 6, shots: 54, estimatedRuntimeSec: 108, estimate: {finalVideoUsd: 18.9}},
        logline: 'A long night.', summary: 'Long.', questions: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}),
      'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [{persona: 'showrunner', change: 'Split the feature into 3 sequences.'}, ...notes], finalAnchors: false,
        sequences: {source: 'stand-in', revision: plan.revision, sequences}}),
      'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
      'GET /api/projects/p1/spend': () => ({spentUsd: 0, heldUsd: 0, capUsd: 150, sequences: sequences.map(sequence => ({...sequence, spentUsd: 0, heldUsd: 0}))}),
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
    all(form).find(element => element.tag === 'textarea').value = SCRIPT;
    all(form).find(element => element.tag === 'select').value = 'feature';
    all(form).find(element => element.tag === 'input' && element.type === 'checkbox').checked = true;
    form.onsubmit({preventDefault() {}}); await settle();
    await all(root).find(element => element.tag === 'button' && element.textContent === 'Plan the film').onclick(); await settle();
    expect(view.flow.state.step).toBe('look');
    const shown = all(root).filter(element => element.tag === 'li').map(element => element.textContent).filter(text => text.startsWith('Continuity Supervisor: '));
    expect(shown).toContain('Continuity Supervisor: Found 1 light setting changing across a sequence boundary in scene 5 (opening sequence 3), where a sequence opens in the place and moment the one before it closes.'
      + ' Under Continuity at the Director\'s desk, "Review continuity repair" offers to hold it to the sequence before.');
    expect(shown.some(text => text.startsWith('Continuity Supervisor: In scene 3 (opening sequence 2): This scene is CONTINUOUS from scene 2'))).toBe(true);
    // A finding inside a sequence is not labelled.
    expect(shown.filter(text => text.includes('do not start from the frame before')).every(text => !text.includes('opening sequence'))).toBe(true);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
  }
});
