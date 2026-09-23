/**
 * HV-039-04 — the studio replaced the step under the creator and left their focus behind.
 *
 * Every step of the front door is drawn by `body.replaceChildren(...)`, so the control the creator
 * pressed stops existing the moment it works. A browser has nowhere to put focus then and drops it
 * to the start of the document: someone who had just approved the plan was above the page heading,
 * with the storyboard several tab stops away and nothing said about where they were. That is WCAG
 * 2.4.3 Focus Order, and it happened at every one of the five steps.
 *
 * The fix is one line in `run` and one table. These tests drive `initStudio` against a DOM stub that
 * records what was focused, because the defect is not visible in `createStudioFlow` at all -- the
 * flow is correct and always was; it is the drawing that dropped the creator.
 */
import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BLOCKED_TITLE, STEP_TITLES, arrivalOf, initStudio} from '../src/studio.js';

/** A DOM element that records focus and keeps its children, rather than swallowing either. */
class Element {
  constructor(tag) {this.tag = tag; this.attributes = {}; this.children = []; this.dataset = {}; this.style = {}; this.focused = 0;}
  setAttribute(name, value) {this.attributes[name] = String(value);}
  getAttribute(name) {return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;}
  append(...nodes) {this.children.push(...nodes);}
  prepend(...nodes) {this.children.unshift(...nodes);}
  replaceChildren(...nodes) {this.children = [...nodes];}
  get lastChild() {return this.children.at(-1) ?? null;}
  focus() {this.focused += 1; focusedElement = this;}
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
let focusedElement = null;

/** Every element in the tree, so a test can find a control by the words on it. */
const all = element => element.children.flatMap(child => [child, ...all(child)]);
const find = (root, tag, text) => all(root).find(element => element.tag === tag && element.textContent === text);
const headings = root => all(root).filter(element => element.tag === 'h1' || element.tag === 'h2');

const readThrough = (concerns = []) => ({facts: {concerns, scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
  logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}],
  expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}});

/** The studio mounted on the stub, with the crew's answers under the test's control. */
function studio({concerns = [], fail = null} = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.Option = class extends Element {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  focusedElement = null;
  let project = null;
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => readThrough(concerns),
    'POST /api/projects/p1/crew/plan': () => {if (fail === 'plan') throw new Error('The crew could not plan this film.'); return {lookNote: 'Soft light.', notes: [], finalAnchors: false};},
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
    'POST /api/projects/p1/jobs': () => ({jobId: 'animatic-1', admitted: true}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 1, heldUsd: 0, capUsd: 40}),
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET';
    if (path.startsWith('/api/jobs/')) return {id: path.split('/').at(-1), status: 'done', outputRevision: 'r'.repeat(64), storyboard: [], output: {}};
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(typeof options.body === 'string' ? JSON.parse(options.body) : options.body);
  };
  const root = new Element('main');
  const view = initStudio({root, api, getProject: () => project, setProject: value => {project = value;},
    attach: () => {}, assetUrl: url => String(url)});
  const status = root.children.find(child => child.attributes.role === 'status');
  return {root, status, flow: view.flow,
    /**
     * Hand the script over, the way the form does.
     *
     * The submit handler does not hand its promise back -- a browser has nowhere to put one -- so
     * this waits for the step to finish the way the creator does: until focus has moved.
     */
    pitch: async () => {
      const form = all(root).find(element => element.tag === 'form');
      const script = all(form).find(element => element.tag === 'textarea');
      script.value = 'INT. ROOM - DAY';
      all(form).find(element => element.tag === 'input' && element.type === 'checkbox').checked = true;
      const before = focusedElement;
      form.onsubmit({preventDefault() {}});
      for (let turn = 0; turn < 200 && focusedElement === before; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
      if (focusedElement === before) throw new Error('the pitch never settled');
    },
    press: async label => find(root, 'button', label).onclick(),
    restore() {
      if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
      if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
    },
  };
}

test('the creator is left on the heading of the step they have arrived at, not at the top of the document', async () => {
  const s = studio();
  try {
    // Before anything is pressed, nothing has been focused: the studio does not steal focus on load.
    expect(focusedElement).toBeNull();
    for (const [press, step] of [[s.pitch, 'questions'], [() => s.press('Plan the film'), 'look'],
      [() => s.press('Approve and draw the storyboard'), 'rough-cut']]) {
      await press();
      expect(s.flow.state.step).toBe(step);
      // The heading is the destination, it carries the step's own name, and it is the name the
      // table gives -- one set of words for what is seen and for where focus lands.
      expect(focusedElement.tag).toBe('h2');
      expect(focusedElement.textContent).toBe(arrivalOf(s.flow.state));
      expect(focusedElement.textContent).toBe(STEP_TITLES[step]);
      // Focusable only by this move, never by tabbing into it.
      expect(focusedElement.tabIndex).toBe(-1);
      // And it is the heading that is actually on the page, not a detached one.
      expect(headings(s.root)).toContain(focusedElement);
    }
  } finally { s.restore(); }
});

test('and the live region does not say the step over again', async () => {
  // The heading the creator has just been moved to says the step's name; a polite live region saying
  // the same words a moment later is the announcement twice. What is left for the region is what the
  // heading cannot say.
  const s = studio();
  try {
    await s.pitch();
    expect(s.status.textContent).toBe('');
    expect(s.status.getAttribute('role')).toBe('status');
  } finally { s.restore(); }
});

test('and a script the crew refused lands on the refusal, not on an invitation to start', async () => {
  // The refusal keeps the creator on the pitch step, so a table keyed only by step would have
  // announced "Bring your script to the studio." to someone who had just been turned down.
  const s = studio({concerns: [{kind: 'public_figure', detail: 'A real person is named.'}]});
  try {
    await s.pitch();
    expect(s.flow.state.step).toBe('pitch');
    expect(arrivalOf(s.flow.state)).toBe(BLOCKED_TITLE);
    expect(focusedElement.textContent).toBe(BLOCKED_TITLE);
    expect(focusedElement.tag).toBe('h2');
  } finally { s.restore(); }
});

test('and a step that failed leaves the creator on the page with the reason, not nowhere', async () => {
  const s = studio({fail: 'plan'});
  try {
    await s.pitch();
    await s.press('Plan the film');
    // The step did not change, but the body was rebuilt all the same, so focus had been dropped here
    // too -- and this is the case where the creator most needs to be told something.
    expect(s.flow.state.step).toBe('questions');
    expect(focusedElement.textContent).toBe(STEP_TITLES.questions);
    expect(s.status.textContent).toBe('The crew could not plan this film.');
    expect(s.status.dataset.state).toBe('error');
    // Nothing is said twice here either: the region carries the error, the heading carries the step.
    expect(s.status.textContent).not.toBe(focusedElement.textContent);
  } finally { s.restore(); }
});

test('and no step writes its own name, so the heading and the announcement cannot drift', () => {
  // The guard on the shape rather than on one instance of it. Each title belongs to the table; a
  // renderer that spelled its heading out again would be a second place to change it.
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'studio.js'), 'utf8');
  for (const [step, title] of Object.entries(STEP_TITLES)) {
    expect({step, times: source.split(JSON.stringify(title)).length - 1}).toEqual({step, times: 1});
  }
  expect(source.split(JSON.stringify(BLOCKED_TITLE)).length - 1).toBe(1);
  // And every step the studio can draw has a title, which is what `arrivalOf` reads.
  const drawn = [...source.matchAll(/\{pitch: render\w+, ([^}]*)\}/g)][0][0];
  for (const step of Object.keys(STEP_TITLES)) expect(drawn).toContain(step);
  expect(drawn.split('render').length - 1).toBe(Object.keys(STEP_TITLES).length);
  // Each title is also made into a destination, which is what `heading` does and `node("h2")` does
  // not -- and this is the whole of the claim about `final`, which no test above drives as far as.
  for (const step of Object.keys(STEP_TITLES).filter(key => key !== 'pitch')) {
    expect(source).toContain(/^[a-z]+$/.test(step) ? `heading(STEP_TITLES.${step})` : `heading(STEP_TITLES["${step}"])`);
  }
  expect(source).toContain('heading(BLOCKED_TITLE)');
  // The pitch's heading is the page's own, so it is made a destination where it is created.
  expect(source).toContain('const pageHeading = node("h1", STEP_TITLES.pitch); pageHeading.tabIndex = -1;');
});
