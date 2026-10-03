/**
 * HV-030-20 — the studio lets the creator keep their style card, and attach it when they choose.
 *
 * HV-030-19 made the crew's memory of a creator a card the plan step hands back, which the server
 * keeps no copy of (ADR-0018: no accounts, no cookies, no tracking). The studio did nothing with it,
 * so the crew still remembered no one. Now the final step offers to keep the card in this browser or
 * download it as a file, and the pitch offers to attach a kept or loaded card. Each happens only when
 * the creator asks: nothing is written to the device unasked, attaching starts unticked, and the card
 * is sent to the crew with a pitch the creator attached it to, and with nothing else. A browser that
 * will not store anything still makes the film.
 */
import {expect, test} from 'bun:test';
import {planInput} from '../../planner/src/crew/production-plan';
import {styleCardFrom} from '../../planner/src/crew/style-card';
import {STYLE_CARD_FILE, STYLE_CARD_KEY, createStudioFlow, initStudio, parseStyleCard} from '../src/studio.js';

const CARD = styleCardFrom(planInput({format: 'short', tone: 'Dry and melancholy', answers: [
  {id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.', accepted: false, reply: 'Leave it unresolved.'},
  {id: 'q2', persona: 'sound', question: 'Music?', proposal: 'Light.', accepted: true}]}), 'Cool night light.');
const readThrough = () => ({facts: {concerns: [], scenes: 1, shots: 2, estimatedRuntimeSec: 4, estimate: {finalVideoUsd: 0.7}},
  logline: 'A reunion.', summary: 'Quiet.', questions: [{id: 'q1', persona: 'director', question: 'Hopeful?', proposal: 'Yes.'}],
  expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}});

/** A browser's storage that records every write, or one that refuses everything. */
function memory() {
  const items = new Map(), writes = [];
  return {items, writes, getItem: key => items.get(key) ?? null, setItem: (key, value) => {writes.push(key); items.set(key, String(value));}, removeItem: key => {writes.push(`-${key}`); items.delete(key);}};
}
const refusing = {getItem() {throw new Error('SecurityError');}, setItem() {throw new Error('QuotaExceededError');}, removeItem() {throw new Error('SecurityError');}};

function fake(storage) {
  const calls = [];
  let project = null;
  const responses = {
    'POST /api/projects': () => ({projectId: 'p1', token: 't1'}),
    'PUT /api/projects/p1/script': () => ({version: 1}),
    'POST /api/projects/p1/rights': () => ({}),
    'POST /api/projects/p1/crew/read-through': () => readThrough(),
    'POST /api/projects/p1/crew/plan': () => ({lookNote: 'Cool night light.', notes: [], finalAnchors: false, styleCard: CARD}),
    'GET /api/projects/p1/cast': () => ({casting: {version: 1, characters: []}}),
    'POST /api/projects/p1/jobs': body => ({jobId: body.stage === 'final' ? 'final-1' : 'animatic-1'}),
    'POST /api/projects/p1/animatic/decision': () => ({}),
    'GET /api/projects/p1/spend': () => ({spentUsd: 0, heldUsd: 0, capUsd: 40}),
    'GET /api/projects/p1/audio-takes': () => ({enabled: false}),
    'GET /api/projects/p1/sound-mixes/final-1': () => ({sourceRevision: 's', engineVersion: 'e', durationSec: 4}),
    'GET /api/projects/p1/sounds': () => ({library: {version: 0, assets: []}}),
    'POST /api/projects/p1/sounds': () => ({asset: {id: 'a', revision: 'r', label: 'x', original: {bytes: 1}, audio: {frames: 1}}}),
    'POST /api/projects/p1/sound-mixes/final-1': () => ({jobId: 'scored-1'}),
    'GET /api/projects/p1/graphics': () => ({rendering: {available: false}, library: {version: 0}, graphics: []}),
  };
  const api = async (path, options = {}) => {
    const method = options.method ?? 'GET', body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    calls.push({method, path, body});
    if (path.startsWith('/api/jobs/')) return {id: path.split('/').at(-1), status: 'done', outputRevision: 'r'.repeat(64), storyboard: [], output: {}};
    const handler = responses[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected ${method} ${path}`);
    return handler(body);
  };
  const project_ = {getProject: () => project, setProject: value => {project = value;}};
  const flow = createStudioFlow({api, storage, ...project_, wait: async () => {}});
  return {flow, api, ...project_, calls, bodies: path => calls.filter(call => call.path === path).map(call => call.body)};
}
async function toFinal(flow, styleCard) {
  await flow.pitch({script: 'INT. ROOM - DAY', format: 'short', tone: 'warm', rightsAttested: true, styleCard});
  await flow.plan([{id: 'q1', accepted: true}]);
  await flow.approveLook(true);
  return flow.approveRoughCut();
}

test('the card is kept in this browser only when the creator asks, exactly as the crew handed it back, and nothing is sent', async () => {
  const storage = memory(), {flow, calls} = fake(storage);
  await toFinal(flow);
  expect(storage.writes).toEqual([]);
  expect(flow.savedStyleCard()).toBeNull();
  const before = calls.length;
  expect(flow.keepStyleCard().styleCardKept).toBe(true);
  expect(calls.length).toBe(before);
  expect(storage.writes).toEqual([STYLE_CARD_KEY]);
  expect(JSON.parse(storage.items.get(STYLE_CARD_KEY))).toEqual(CARD);
  expect(flow.savedStyleCard()).toEqual(CARD);
  // The file is the same card, for the creator to keep elsewhere.
  const file = flow.styleCardFile();
  expect({name: file.name, type: file.type, card: JSON.parse(file.text)}).toEqual({name: STYLE_CARD_FILE, type: 'application/json', card: CARD});
  flow.forgetStyleCard();
  expect(flow.savedStyleCard()).toBeNull();
  expect(calls.length).toBe(before);
});

test('a kept card is sent to the crew only with a pitch the creator attached it to, and again when they send the crew back', async () => {
  const storage = memory();
  storage.items.set(STYLE_CARD_KEY, JSON.stringify(CARD));
  const plain = fake(storage);
  await plain.flow.pitch({script: 'INT. ROOM - DAY', format: 'short', tone: 'warm', rightsAttested: true});
  expect(plain.bodies('/api/projects/p1/crew/read-through')).toEqual([{format: 'short', tone: 'warm'}]);
  const attached = fake(storage);
  await toFinal(attached.flow, attached.flow.savedStyleCard());
  expect(attached.bodies('/api/projects/p1/crew/read-through')).toEqual([{format: 'short', tone: 'warm', styleCard: CARD}]);
  // Sending the crew back from the rough cut reads the same pitch again, card and all.
  const again = fake(storage);
  await again.flow.pitch({script: 'INT. ROOM - DAY', format: 'short', tone: 'warm', rightsAttested: true, styleCard: CARD});
  await again.flow.plan([{id: 'q1', accepted: true}]);
  await again.flow.approveLook(true);
  await again.flow.requestChanges();
  expect(again.bodies('/api/projects/p1/crew/read-through')).toEqual([{format: 'short', tone: 'warm', styleCard: CARD}, {format: 'short', tone: 'warm', styleCard: CARD}]);
  // No other request carries it.
  expect(again.calls.filter(call => call.path !== '/api/projects/p1/crew/read-through' && JSON.stringify(call.body ?? {}).includes('hv-crew-style-card'))).toEqual([]);
});

test('a browser that will not store anything still makes the film, and says to download the card instead', async () => {
  for (const storage of [refusing, {get getItem() {throw new Error('SecurityError');}}]) {
    const {flow} = fake(storage);
    expect(flow.savedStyleCard()).toBeNull();
    expect((await toFinal(flow)).step).toBe('final');
    expect(() => flow.keepStyleCard()).toThrow('Download it instead');
    expect(() => flow.forgetStyleCard()).not.toThrow();
    expect(JSON.parse(flow.styleCardFile().text)).toEqual(CARD);
  }
  // A film whose plan was not retained here (a resumed one) has no card to keep, and says why.
  const {flow} = fake(memory());
  expect(() => flow.keepStyleCard()).toThrow('there is no style card to keep');
});

test('a card from the device or a file is read only if it is one the studio made', () => {
  expect(parseStyleCard(JSON.stringify(CARD))).toEqual(CARD);
  for (const text of [null, '', 'not json', '[]', '{}', JSON.stringify({...CARD, schema: 'other/1'}), JSON.stringify({...CARD, format: 'film'}), JSON.stringify({...CARD, choices: 'x'})])
    expect(parseStyleCard(text)).toBeNull();
});

/** Just enough DOM to draw the studio and find its controls. */
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

test('the pitch offers a kept card unticked, and the finished film offers to keep and download it', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousOption = Object.getOwnPropertyDescriptor(globalThis, 'Option');
  globalThis.document = {createElement: tag => new Element(tag)};
  globalThis.Option = class extends Element {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  try {
    const mount = storage => {
      const root = new Element('main'), {api, getProject, setProject, bodies} = fake(storage);
      return {root, bodies, view: initStudio({root, storage, api, getProject, setProject, attach: () => {}, assetUrl: url => String(url)})};
    };
    /** Fill the pitch and hand it over, the way the form does, ticking the card or not. */
    const submit = async (mounted, tick) => {
      const find = id => all(mounted.root).find(element => element.id === id);
      find('studio-script').value = 'INT. ROOM - DAY'; find('studio-rights').checked = true;
      if (tick) {find('studio-style-card').checked = true; find('studio-style-card').onchange();}
      all(mounted.root).find(element => element.tag === 'form').onsubmit({preventDefault() {}});
      for (let turn = 0; turn < 200 && mounted.view.flow.state.step === 'pitch'; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
      return mounted.bodies('/api/projects/p1/crew/read-through');
    };
    // No kept card: no box to tick, only the file to load.
    expect(all(mount(memory()).root).some(element => element.id === 'studio-style-card')).toBe(false);
    const kept = memory(); kept.items.set(STYLE_CARD_KEY, JSON.stringify(CARD));
    const box = all(mount(kept).root).find(element => element.id === 'studio-style-card');
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    // Left unticked, the pitch goes without it; ticked, it goes with it, and fills an empty tone from it.
    const kept2 = memory(); kept2.items.set(STYLE_CARD_KEY, JSON.stringify(CARD));
    expect(await submit(mount(kept2), false)).toEqual([{format: 'reel', tone: ''}]);
    expect(await submit(mount(kept2), true)).toEqual([{format: 'reel', tone: 'Dry and melancholy', styleCard: CARD}]);
    // The finished film: the card to keep and to download, from the crew's own answer.
    const {root, view} = mount(memory());
    await toFinal(view.flow);
    view.render();
    expect(all(root).some(element => element.tag === 'button' && element.textContent === 'Keep my style card in this browser')).toBe(true);
    const link = all(root).find(element => element.tag === 'a' && element.textContent === 'Download my style card');
    expect(link.download).toBe(STYLE_CARD_FILE);
    expect(JSON.parse(decodeURIComponent(link.href.slice(link.href.indexOf(',') + 1)))).toEqual(CARD);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document;
    if (previousOption) Object.defineProperty(globalThis, 'Option', previousOption); else delete globalThis.Option;
  }
});
