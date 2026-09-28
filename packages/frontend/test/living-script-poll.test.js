/**
 * HV-039-11 — the dialogue-revision studio locked and redrew itself every three seconds while a
 * preview or film generated.
 *
 * While a revised preview or film generates (minutes), the studio checks its status every three
 * seconds:
 *
 *     poll=setTimeout(()=>{void safe(()=>store.showJob(s.job.id))();},3000);
 *
 * `store.showJob` is the creator's own "Check generation status". It sets `busy` and emits before
 * the request, and emits again after it. Every emit runs `render()`, which rebuilds the recovery,
 * library, draft, proposal, generation, media, mapping and review sections, and `busy` disables
 * every control until the answer comes back. So every three seconds, for the whole generation:
 *
 * - every section was rebuilt twice, so an open listing collapsed and focus on any button fell to
 *   the page body;
 * - every control was disabled while the check was in flight, so a click that landed then did
 *   nothing;
 * - `safe` begins `localError=null`, so an error from anything the creator had just tried was wiped
 *   within three seconds.
 *
 * The check is now quiet. It holds no busy state, redraws only when the job's status or output
 * changes, and leaves an error on screen alone.
 */
import {afterEach, expect, test} from 'bun:test';
import {createLivingScriptStudio} from '../src/living-script.js';
import {Element} from './edit-assemblies-fixture.js';
import {deferred, livingFixture, tick} from './living-script-fixture.js';

class View extends Element {
  querySelector(selector) {
    const key = selector.match(/^\[data-([a-z-]+)\]$/)?.[1]?.replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    const scan = element => element.children.flatMap(child => [child, ...scan(child)]);
    return scan(this).find(element => key ? Object.hasOwn(element.dataset, key) : element.tagName === selector) ?? null;
  }
  pause() {}
}

const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
let cleanup = () => {};
afterEach(() => {cleanup(); globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;});

/** The studio, with a revised film admitted and still rendering, and its three-second check in hand. */
async function rendering() {
  const saved = ['document', 'Option'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  globalThis.document = {activeElement: null, createElement: tag => new View(tag)};
  globalThis.Option = class extends View {constructor(label, value) {super('option'); this.textContent = label; this.value = value;}};
  const checks = [];
  globalThis.setTimeout = (callback, delay) => {
    if (delay !== 3000) return realSetTimeout(callback, delay);
    const timer = {callback, cleared: false}; checks.push(timer); return timer;
  };
  globalThis.clearTimeout = timer => {if (timer && typeof timer === 'object' && 'cleared' in timer) timer.cleared = true; else realClearTimeout(timer);};
  let status = 'running', held = null, refuse = false;
  const f = livingFixture({stage: 'animatic', intercept: async (call, run) => {
    if (refuse && call.path === '/screenplay') {refuse = false; throw Object.assign(new Error('The saved proposals could not be loaded.'), {status: 503});}
    return run();
  }, interceptJob: async (_jobId, run) => {
    const job = run(), answer = status === 'running' ? {...job, status: 'running', output: null} : job;
    if (held) await held.promise;
    return answer;
  }});
  const root = new View('div');
  const ui = createLivingScriptStudio({parent: root, current: () => f.current, request: f.request, jobRequest: f.jobRequest, storage: f.storage});
  cleanup = () => {ui.dispose(); f.store.dispose(); for (const [key, value] of saved) if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];};
  const all = (at = root) => [at, ...at.children.flatMap(child => all(child))];
  const find = (tag, text) => all().find(element => element.tagName === tag && element.textContent === text);
  const ack = text => all().find(element => element.tagName === 'label' && element.textContent === text)?.children.find(element => element.type === 'checkbox');
  const input = label => {const field = find('label', label); return all().find(element => element.id === field?.htmlFor);};
  ui.bind(); await tick();
  ui.selectLine(f.selection); input('Revised dialogue').value = 'We are absolutely ready.'; input('Revised dialogue').oninput();
  await find('button', 'Review line and cut impact').onclick();
  let check = ack('I reviewed this exact dialogue, performance rebinding and retained cut impact.'); check.checked = true; check.onchange();
  await find('button', 'Save reviewed proposal').onclick();
  await find('button', 'Review revised film generation').onclick();
  check = ack('I reviewed these exact shots, generation settings and budget.'); check.checked = true; check.onchange();
  await find('button', 'Start revised film generation').onclick(); await tick();
  return {
    ui, f, root, all, find,
    finish: () => {status = 'done';},
    refuseNext: () => {refuse = true;},
    hold: () => {held = deferred(); return () => {held.resolve(); held = null;};},
    /** The next three-second check, as the browser would run it; resolves when its answer is drawn. */
    async check() {
      const next = checks.filter(timer => !timer.cleared).at(-1);
      if (!next) throw new Error('No status check is scheduled.');
      next.cleared = true; next.callback(); await tick(); await tick();
    },
    scheduled: () => checks.some(timer => !timer.cleared),
  };
}

test('a status check that finds the job still rendering redraws nothing', async () => {
  const s = await rendering();
  expect(s.root.textContent).toContain('The worker reports this generation as running');
  const before = s.all();
  const status = s.find('button', 'Check generation status');
  await s.check();
  const after = s.all();
  expect(after.length).toBe(before.length);
  expect(after.every((element, i) => element === before[i])).toBe(true);
  expect(s.find('button', 'Check generation status')).toBe(status);
  // And the next check is scheduled.
  expect(s.scheduled()).toBe(true);
});

test('nothing is disabled while the check is in flight, so a click that lands then is not lost', async () => {
  const s = await rendering();
  const release = s.hold();
  const next = s.all().find(element => element.tagName === 'button' && element.textContent === 'Check generation status');
  const enabled = () => s.all().filter(element => element.tagName === 'button' && !element.disabled && element.dataset.edge !== 'true').length;
  const before = enabled();
  const pending = s.check();
  expect(enabled()).toBe(before);
  expect(next.disabled).toBe(false);
  release(); await pending; await tick();
});

test('an error on screen is not wiped by a status check', async () => {
  const s = await rendering();
  s.refuseNext();
  await s.all().find(element => element.tagName === 'button' && element.textContent.endsWith('saved proposals')).onclick();
  const status = s.all().find(element => element.tagName === 'p' && element.textContent === 'The saved proposals could not be loaded.');
  expect(status).toBeDefined();
  await s.check();
  expect(status.textContent).toBe('The saved proposals could not be loaded.');
});

test('when the job finishes, the check draws the finished film', async () => {
  const s = await rendering();
  s.finish();
  await s.check();
  expect(s.all().some(element => element.tagName === 'video')).toBe(true);
  expect(s.scheduled()).toBe(false);
});
