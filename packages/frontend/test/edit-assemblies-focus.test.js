/**
 * HV-039-15 — reordering an assembly's ranges dropped keyboard focus to the page body on every move.
 *
 * The assembly studio (a trailer or 60-second cut built from ranges of a saved parent) redraws on
 * every change except typing, and `render` begins
 *
 *     controls=[];top.replaceChildren();recovery.replaceChildren();library.replaceChildren();form.replaceChildren();actions.replaceChildren();
 *
 * so "Move range 2 up", "Duplicate range 2", "Remove range 2", "Add parent range", the pager and
 * "Save proposal and review" all destroyed the button that was pressed. A keyboard user reordering
 * five ranges had to find their way back from the top of the page after every single move, and
 * could not simply press the same button again.
 *
 * A range button is now remembered by its range and its job, since after "Move range 2 up" that range
 * is range 1 and its button says so; the first render that is not busy focuses the new copy, or the
 * nearest control still standing.
 */
import {afterEach, expect, test} from 'bun:test';
import {createEditAssemblyStudio} from '../src/edit-assemblies.js';
import {assemblyFixture, Element, installDom} from './edit-assemblies-fixture.js';

let cleanup = () => {};
afterEach(() => cleanup());

async function studio() {
  const restore = installDom(), fixture = assemblyFixture(), root = new Element('section');
  let focused = null;
  // The fixture's element has no focus(); record it where a browser would.
  Element.prototype.focus = function () {focused = this;};
  const ui = createEditAssemblyStudio({parent: root, current: () => fixture.current, request: fixture.request, onDirty() {}, onAccepted() {}});
  cleanup = () => {ui.dispose(); restore(); delete Element.prototype.focus;};
  const all = (at = root) => [at, ...at.children.flatMap(child => all(child))];
  const find = (tag, text) => all().find(element => element.tagName === tag && element.textContent === text);
  const rows = () => all().filter(element => element.className.split(' ').includes('edit-assembly-range'));
  /** Press a button as a keyboard user does: it has focus, then it is activated. */
  const press = async text => {const button = find('button', text); focused = button; await button.onclick(); await Bun.sleep(0);};
  ui.bind(); ui.panel.open = true; ui.panel.emit('toggle'); await Bun.sleep(0);
  await press('Start from complete saved cut');
  await press('Add parent range'); await press('Add parent range');
  return {all, find, rows, press, focused: () => focused, onPage: element => all().includes(element)};
}

test('moving a range up leaves focus on that range\'s own Move up button, which now carries its new number', async () => {
  const s = await studio();
  const third = s.rows()[2].dataset.rangeId;
  await s.press('Move range 3 up');
  expect(s.rows()[1].dataset.rangeId).toBe(third);
  expect(s.onPage(s.focused())).toBe(true);
  // Pressing it again moves the same range again: the button a keyboard user is on is the one they want.
  expect(s.focused().textContent).toBe('Move range 2 up');
  expect(s.rows()[1].children.flatMap(child => [child, ...child.children]).includes(s.focused())).toBe(true);
});

test('a range moved to the top keeps focus in its own row, on a button that still works', async () => {
  const s = await studio();
  await s.press('Move range 2 up');
  // Range 1 cannot move up again, so focus stays with it rather than on a disabled button.
  expect(s.focused().disabled).toBe(false);
  expect(s.focused().dataset.edge).not.toBe('true');
  expect(s.focused().textContent).toBe('Move range 1 down');
});

test('removing a range hands focus to the range that took its place, and duplicating to the same range', async () => {
  const s = await studio();
  const third = s.rows()[2].dataset.rangeId;
  await s.press('Remove range 2');
  expect(s.rows()).toHaveLength(2);
  expect(s.onPage(s.focused())).toBe(true);
  expect(s.rows()[1].dataset.rangeId).toBe(third);
  expect(s.focused().textContent).toBe('Move range 2 up');
  await s.press('Duplicate range 1');
  expect(s.focused().textContent).toBe('Duplicate range 1');
  expect(s.onPage(s.focused())).toBe(true);
});

test('a button outside the ranges returns to its own new copy', async () => {
  const s = await studio();
  await s.press('Add parent range');
  expect(s.onPage(s.focused())).toBe(true);
  expect(s.focused().textContent).toBe('Add parent range');
});
