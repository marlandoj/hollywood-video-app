/**
 * HV-039-02 — aria-busy must never cover a live region.
 *
 * The defect these cases pin is not a missing attribute but a misplaced one:
 * eleven modules set `aria-busy` on an element that contains their own
 * `role="status"` region, so every success and error message was written while
 * assistive technology had been told to ignore that subtree. The last two cases
 * are the ones that stop the defect coming back — one holds the eleven copies
 * equal by proving there is only one, the other drives a real panel into its
 * busy window and looks at where the attribute landed.
 */
import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {applyBusy,busyRegions,isLiveRegion,whileBusy} from '../src/busy.js';
import {assemblyFixture,Element,installDom} from './edit-assemblies-fixture.js';
import {createEditAssemblyStudio} from '../src/edit-assemblies.js';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const element = (tag, attributes = {}) => {
  const node = new Element(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
};
/** Every element in the tree, so an assertion can name the whole marked set. */
const tree = root => [root, ...root.children.flatMap(child => tree(child))];
const busyOf = root => tree(root).filter(node => node.getAttribute('aria-busy') === 'true').map(node => node.tagName);

test('a live region is never marked, and everything beside it is', () => {
  const panel = element('section'), title = element('h2'), status = element('p', {role: 'status', 'aria-live': 'polite'}), body = element('div');
  panel.append(title, status, body);

  applyBusy(panel, true);
  expect(busyOf(panel)).toEqual(['h2', 'div']);
  // The point of the increment: the announcement channel is not suppressed.
  expect(status.getAttribute('aria-busy')).toBeNull();
  // And the panel itself is not, because marking it would silence the status.
  expect(panel.getAttribute('aria-busy')).toBeNull();

  applyBusy(panel, false);
  expect(busyOf(panel)).toEqual([]);
});

test('marking descends past every ancestor that carries a live region, however deep', () => {
  const panel = element('section'), plain = element('header'), branch = element('div'), row = element('span'),
    status = element('output', {role: 'status'}), sibling = element('button'), cousin = element('a');
  row.append(status, sibling);
  branch.append(row, cousin);
  panel.append(plain, branch);

  applyBusy(panel, true);
  // header and cousin are whole subtrees with no live region; sibling is the
  // shallowest markable node inside the row that holds one. branch and row
  // stay unmarked because marking them would cover the status.
  expect(busyOf(panel)).toEqual(['header', 'button', 'a']);
  expect([branch, row, status, panel].map(node => node.getAttribute('aria-busy'))).toEqual([null, null, null, null]);
});

test('a subtree with no live region marks the element itself, which is what the eleven copies did', async () => {
  // performances.js sets this on a play button with no live region inside it.
  const play = element('button');
  await whileBusy(play, async () => { expect(play.getAttribute('aria-busy')).toBe('true'); });
  expect(play.getAttribute('aria-busy')).toBeNull();

  // Same for a panel of controls only: behaviour is unchanged from before.
  const panel = element('section'), input = element('input');
  panel.append(input);
  applyBusy(panel, true);
  expect(busyOf(panel)).toEqual(['section']);
  expect(input.getAttribute('aria-busy')).toBeNull();
  applyBusy(panel, false);
});

test('a nested panel and its container do not clear each other', () => {
  const outer = element('section'), outerStatus = element('p', {role: 'status'}), inner = element('details'),
    innerStatus = element('p', {role: 'status'}), innerBody = element('div'), outerBody = element('div');
  inner.append(innerStatus, innerBody);
  outer.append(outerStatus, outerBody, inner);

  applyBusy(outer, true);
  expect(innerBody.getAttribute('aria-busy')).toBe('true');
  expect(outerBody.getAttribute('aria-busy')).toBe('true');

  // The inner panel finishes first. Its own clear must not strip the mark the
  // container still holds on the element they share -- this is editorial.js
  // with the edit-assemblies panel mounted inside it, and it is the case the
  // first draft of this helper got wrong: a plain remove left innerBody
  // unmarked while its container was still busy.
  applyBusy(inner, true);
  applyBusy(inner, false);
  expect(outerBody.getAttribute('aria-busy')).toBe('true');
  expect(innerBody.getAttribute('aria-busy')).toBe('true');

  applyBusy(outer, false);
  expect(busyOf(outer)).toEqual([]);

  // And the other order: the container finishes first, the inner panel keeps
  // its own mark, and nothing is left behind when it finishes too.
  applyBusy(outer, true);
  applyBusy(inner, true);
  applyBusy(outer, false);
  expect(innerBody.getAttribute('aria-busy')).toBe('true');
  expect(outerBody.getAttribute('aria-busy')).toBeNull();
  applyBusy(inner, false);
  expect(busyOf(outer)).toEqual([]);
});

test('only the roles and attributes that are really live regions count', () => {
  expect([
    isLiveRegion(element('p', {role: 'status'})),
    isLiveRegion(element('p', {role: 'alert'})),
    isLiveRegion(element('p', {role: 'log'})),
    isLiveRegion(element('p', {'aria-live': 'polite'})),
    isLiveRegion(element('p', {'aria-live': 'assertive'})),
    isLiveRegion(element('p', {'aria-live': 'off'})),
    isLiveRegion(element('p', {role: 'region'})),
    // role is a token list and the first valid token decides, so this IS a
    // status region; an earlier draft compared the whole attribute and
    // answered false, which suppressed a real live region's announcements.
    isLiveRegion(element('p', {role: 'status region'})),
    isLiveRegion(element('p', {role: '  STATUS  '})),
    // An explicit aria-live wins over the role's implicit value in both
    // directions. edit-script.js already writes aria-live="off".
    isLiveRegion(element('p', {role: 'status', 'aria-live': 'off'})),
    isLiveRegion(element('div', {'aria-live': 'ASSERTIVE'})),
    isLiveRegion(element('p')),
  ]).toEqual([true, true, true, true, true, false, false, true, true, false, true, false]);

  // A region that is only labelled, not live, is marked like any other content.
  const panel = element('section'), labelled = element('div', {role: 'region', 'aria-label': 'Renders'}), status = element('p', {role: 'status'});
  panel.append(labelled, status);
  applyBusy(panel, true);
  expect(busyOf(panel)).toEqual(['div']);
  applyBusy(panel, false);
});

test('a live region with markup inside it is still a live region', () => {
  // Every other case here builds a leaf live region, and a helper that
  // answered `false` for any element with children passed all of them while
  // silencing a status element that says "Saved <strong>3</strong> takes".
  const panel = element('section'), status = element('p', {role: 'status'}), strong = element('strong'), body = element('div');
  status.append(element('span'), strong);
  panel.append(status, body);

  applyBusy(panel, true);
  expect(busyOf(panel)).toEqual(['div']);
  expect([status, strong, panel].map(node => node.getAttribute('aria-busy'))).toEqual([null, null, null]);
  applyBusy(panel, false);
});

test('the shapes where there is nothing safe to mark, and nothing is marked', () => {
  // A panel whose only element child is its own live region: every markable
  // position is live, so applyBusy is a complete no-op rather than marking the
  // panel and silencing it.
  const bare = element('section'), onlyStatus = element('p', {role: 'status'});
  bare.append(onlyStatus);
  applyBusy(bare, true);
  expect(busyOf(bare)).toEqual([]);
  expect(busyRegions(bare)).toEqual([]);
  applyBusy(bare, false);
  expect(busyOf(bare)).toEqual([]);

  // A root that is itself a live region -- aria-live on the panel -- is never
  // marked, and its non-live children still are.
  const live = element('section', {'aria-live': 'polite'}), child = element('div');
  live.append(child);
  applyBusy(live, true);
  expect(busyOf(live)).toEqual(['div']);
  expect(live.getAttribute('aria-busy')).toBeNull();
  applyBusy(live, false);

  // An empty element with no live region marks itself: the button case with
  // nothing in it yet.
  const empty = element('button');
  applyBusy(empty, true);
  expect(empty.getAttribute('aria-busy')).toBe('true');
  applyBusy(empty, false);
  expect(empty.getAttribute('aria-busy')).toBeNull();
});

test('whileBusy clears its marks when the action throws, and cannot be forgotten', async () => {
  const panel = element('section'), status = element('p', {role: 'status'}), body = element('div');
  panel.append(status, body);

  // The reason the helper takes the action instead of returning a release
  // call: a caller that dropped the release left the panel marked for the rest
  // of the session, silencing every later message, and no test could see it.
  await expect(whileBusy(panel, async () => { expect(busyOf(panel)).toEqual(['div']); throw new Error('provider refused'); }))
    .rejects.toThrow('provider refused');
  expect(busyOf(panel)).toEqual([]);

  // And it returns what the action returned, so a caller has no reason to
  // reach around it.
  expect(await whileBusy(panel, async () => 'saved')).toBe('saved');
  expect(busyOf(panel)).toEqual([]);
});

test('marking twice then clearing once leaves nothing marked', () => {
  const panel = element('section'), status = element('p', {role: 'status'}), body = element('div');
  panel.append(status, body);
  applyBusy(panel, true);
  applyBusy(panel, true);
  expect(busyOf(panel)).toEqual(['div']);
  applyBusy(panel, false);
  expect(busyOf(panel)).toEqual([]);

  // busyRegions is a pure read: asking twice does not change the tree.
  expect(busyRegions(panel).map(node => node.tagName)).toEqual(['div']);
  expect(busyOf(panel)).toEqual([]);
});

test('aria-busy is written in exactly one file, and every module that needs it imports that file', () => {
  const files = [...new Bun.Glob('packages/frontend/src/**/*.{js,html,css}').scanSync(REPO_ROOT)]
    .map(file => file.split('\\').join('/')).sort();
  // The glob must actually be finding the frontend, or the two scans below are
  // vacuous. These four are the raw-served panels and the bundled one.
  expect(files).toContain('packages/frontend/src/busy.js');
  expect(files.length).toBeGreaterThan(40);

  const source = new Map(files.map(file => [file, readFileSync(join(REPO_ROOT, file), 'utf8')]));
  const writers = files.filter(file => /aria-busy/.test(source.get(file)));
  expect(writers).toEqual(['packages/frontend/src/busy.js']);

  // And the helper reaches every element that used to be marked by hand. This
  // list is the increment's claim about its own scope: eleven call sites, ten
  // panels that hold a live region plus one button that does not.
  // HV-026-08 added a twelfth: the color grade panel.
  // HV-021-07 added a thirteenth: the continuity panel on the Director's desk,
  // which holds its own live region and marks the rest of itself while a
  // request is out.
  // HV-016-33 added a fourteenth: the crew's line notes beside the screenplay.
  // HV-017-16 added a fifteenth: the cast desk, while a cast save is in flight.
  const importers = files.filter(file => /from ['"]\.\/busy\.js['"]/.test(source.get(file)));
  expect(importers).toEqual([
    'packages/frontend/src/audio-studio.js',
    'packages/frontend/src/casting.js',
    'packages/frontend/src/color-grade.js',
    'packages/frontend/src/continuity.js',
    'packages/frontend/src/dialogue-replacement.js',
    'packages/frontend/src/edit-assemblies-render.js',
    'packages/frontend/src/edit-assemblies.js',
    'packages/frontend/src/edit-script.js',
    'packages/frontend/src/editorial.js',
    'packages/frontend/src/graphic-studio.js',
    'packages/frontend/src/line-notes.js',
    'packages/frontend/src/lipsync.js',
    'packages/frontend/src/living-script.js',
    'packages/frontend/src/performances.js',
    'packages/frontend/src/sound-studio.js',
  ]);
  // Each importer calls the helper rather than importing it and going on to
  // write the attribute some other way.
  for (const file of importers) expect(source.get(file)).toMatch(/\b(applyBusy|whileBusy)\(/);

  // And no importer marks with a constant. `whileBusy` takes the action, so the
  // clear cannot be forgotten by accident; the remaining way to leave a panel
  // marked for ever is `applyBusy(panel, true)` with no matching clear, which
  // is what this refuses. Every real call passes the panel's own busy state.
  const constantMark = importers.filter(file => /\bapplyBusy\([^),]*,\s*(?:true|false)\s*\)/.test(source.get(file)));
  expect(constantMark).toEqual([]);
});

test('a real panel announces from outside its own busy window', async () => {
  const restore = installDom();
  let release, hold = false;
  const fixture = assemblyFixture({intercept: async (call, run) => {
    if (!hold) return run();
    await new Promise(resolve => { release = resolve; });
    return run();
  }});
  const root = new Element('section');
  const ui = createEditAssemblyStudio({parent: root, current: () => fixture.current, request: fixture.request, onDirty: () => {}, onAccepted: () => {}, onParentRange: () => {}});
  try {
    ui.bind();
    ui.panel.open = true;
    ui.panel.emit('toggle');
    await Bun.sleep(0);
    const all = tree(root);
    const status = all.find(node => node.className === 'edit-assembly-status');
    expect(status.getAttribute('role')).toBe('status');

    const find = text => tree(root).find(node => node.tagName === 'button' && node.textContent === text);
    await find('Start from complete saved cut').onclick();
    hold = true;
    const pending = find('Save proposal and review').onclick();   // in flight: the panel is busy
    await Bun.sleep(0);

    const ancestors = element => { const chain = []; for (let node = element; node; node = node.parentElement) chain.push(node); return chain; };
    // The defect, stated as an assertion: nothing from the live region up to the
    // document root is busy, so the message it is about to carry is announced.
    // Pinned by length as well as by value: an expected array derived from the
    // actual one degrades to [null] vs [null] if the chain ever shortens.
    expect(ancestors(status).map(node => node.tagName)).toEqual(['p', 'details', 'section']);
    expect(ancestors(status).map(node => node.getAttribute('aria-busy'))).toEqual([null, null, null]);
    // While the panel really is busy -- otherwise this test would pass against
    // a version that simply stopped setting the attribute at all.
    expect(tree(ui.panel).some(node => node.getAttribute('aria-busy') === 'true')).toBe(true);

    release();
    await pending;
    expect(tree(ui.panel).some(node => node.getAttribute('aria-busy') === 'true')).toBe(false);
    expect(status.textContent.length).toBeGreaterThan(0);
  } finally {
    ui.dispose();
    restore();
  }
});
