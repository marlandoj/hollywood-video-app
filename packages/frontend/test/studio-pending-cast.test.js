/**
 * HV-016-15 — every studio film offered to "Wait for my rough cut", and the button asked for a job
 * called `undefined`.
 *
 * `state.pending` meant two things in `studio.js`:
 *
 * - HV-016-11 made it the render a resumed project left running, `{stage, jobId, status}`, and
 *   `render` prepends "Wait for my rough cut" (or "…final film") to any step whose state has one;
 * - the look step, since HV-030-01, kept in it the cast still waiting for the creator's permission --
 *   an array, and usually an empty one.
 *
 * An empty array is truthy, and every later step spreads the look step's state forward. So every
 * creator who planned a film saw "Wait for my rough cut" on the look, the rough cut and the final,
 * above everything else on the page, and pressing it asked the server for `/api/jobs/undefined` and
 * put its error where the film had been. The cast list is now `pendingCast`, and `pending` means
 * only the render.
 */
import {expect, test} from 'bun:test';
import {initStudio} from '../src/studio.js';

/** A DOM element that keeps its children, rather than swallowing them. */
class Element {
  constructor(tag) {this.tag = tag; this.attributes = {}; this.children = []; this.dataset = {}; this.style = {}; }
  setAttribute(name, value) {this.attributes[name] = String(value);}
  getAttribute(name) {return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;}
  append(...nodes) {this.children.push(...nodes);}
  prepend(...nodes) {this.children.unshift(...nodes);}
  replaceChildren(...nodes) {this.children = [...nodes];}
  get lastChild() {return this.children.at(-1) ?? null;}
  focus() {}
  querySelectorAll(selector) {
    const tags = selector.split(',');
    const found = [];
    const walk = element => {for (const child of element.children) {if (tags.includes(child.tag)) found.push(child); walk(child);}};
    walk(this);
    return found;
  }
  set textContent(value) {this.written = value;}
  get textContent() {return this.written ?? '';}
}

/** Every element in the tree, so a test can find a control by the words on it. */
const all = element => element.children.flatMap(child => [child, ...all(child)]);
const find = (root, tag, text) => all(root).find(element => element.tag === tag && element.textContent === text);

const readThrough = (concerns = []) => ({facts: {concerns, scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
  logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}],
  expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}});

/** The studio mounted on the stub, with the crew's answers under the test's control. */
function studio({characters = []} = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.Option = class extends Element {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  let project = null;
  const requests = [];
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => readThrough(),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Soft light.', notes: [], finalAnchors: false}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters}}),
    'POST /api/projects/p1/crew/approve-cast': () => ({}),
    'POST /api/projects/p1/jobs': () => ({jobId: 'animatic-1', admitted: true}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 1, heldUsd: 0, capUsd: 40}),
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET'; requests.push(`${method} ${path}`);
    if (path.startsWith('/api/jobs/')) {
      if (path.endsWith('/undefined')) throw new Error('Job not found.');
      return {id: path.split('/').at(-1), status: 'done', outputRevision: 'r'.repeat(64), storyboard: [], output: {}};
    }
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(typeof options.body === 'string' ? JSON.parse(options.body) : options.body);
  };
  const root = new Element('main');
  const view = initStudio({root, api, getProject: () => project, setProject: value => {project = value;}, attach: () => {}, assetUrl: url => String(url)});
  const status = root.children.find(child => child.attributes.role === 'status');
  const settle = async () => {for (let turn = 0; turn < 50; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));};
  return {root, status, flow: view.flow, requests, settle,
    pitch: async () => {
      const form = all(root).find(element => element.tag === 'form');
      all(form).find(element => element.tag === 'textarea').value = 'INT. ROOM - DAY';
      all(form).find(element => element.tag === 'input' && element.type === 'checkbox').checked = true;
      form.onsubmit({preventDefault() {}}); await settle();
    },
    press: async label => {await find(root, 'button', label).onclick(); await settle();},
    buttons: () => all(root).filter(element => element.tag === 'button').map(element => element.textContent),
    restore() {
      if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
      if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
    },
  };
}

const WAIT = ['Wait for my rough cut', 'Wait for my final film'];

test('a film planned in the studio offers no render to wait for on the look or the rough cut, because none is running', async () => {
  const s = studio();
  try {
    await s.pitch();
    await s.press('Plan the film');
    expect(s.flow.state.step).toBe('look');
    expect(s.buttons().filter(label => WAIT.includes(label))).toEqual([]);
    await s.press('Approve and draw the storyboard');
    expect(s.flow.state.step).toBe('rough-cut');
    expect(s.buttons().filter(label => WAIT.includes(label))).toEqual([]);
    // Nothing is left in the state that a later step would take for a running render.
    expect(s.flow.state.pending).toBeUndefined();
    expect(s.requests).not.toContain('GET /api/jobs/undefined');
  } finally {s.restore();}
});

test('the cast still waiting for permission is still asked for before the storyboard is drawn', async () => {
  const s = studio({characters: [{id: 'c1', name: 'Maya', kind: 'original-fictional', permission: {status: 'pending'}}]});
  try {
    await s.pitch();
    await s.press('Plan the film');
    const attest = all(s.root).find(element => element.tag === 'input' && element.id === 'studio-cast-attested');
    expect(attest).toBeDefined();
    await s.press('Approve and draw the storyboard');
    expect(s.flow.state.step).toBe('look');
    expect(s.status.textContent).toBe('Confirm that the cast are original characters you may use.');
    expect(s.requests).not.toContain('POST /api/projects/p1/crew/approve-cast');
    all(s.root).find(element => element.tag === 'input' && element.id === 'studio-cast-attested').checked = true;
    await s.press('Approve and draw the storyboard');
    expect(s.requests).toContain('POST /api/projects/p1/crew/approve-cast');
    expect(s.flow.state.step).toBe('rough-cut');
  } finally {s.restore();}
});
