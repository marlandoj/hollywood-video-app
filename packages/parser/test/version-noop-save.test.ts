/**
 * HV-016-10 — saving the same screenplay again rendered the film again, and charged for it.
 *
 * `VersionStore.commit` pushed a new version for every call, whatever the text. The version is in
 * the key the server derives for a render when the caller sends none:
 *
 *     `${stage}:${scriptVersion}:cast-${castingVersion}:direction-${directionVersion}`
 *
 * HV-030-07 took the studio's `crypto.randomUUID()` idempotency keys away precisely so that derived
 * key would stand and a repeated request would return the job it had already admitted. A save that
 * changed nothing moved the derived key, so the protection did not hold across the one path a
 * returning creator was pushed down: pitch the script again.
 *
 * Measured end to end on this repo's own API, before:
 *
 *     PUT /script "INT. BAR - DAY\n\nShe waits."  ->  version 1
 *     PUT /script  (the same string)              ->  version 2
 *     PUT /script  (the same string)              ->  version 3
 *
 *     POST /jobs {} after the first pitch  ->  9e1226a3-…
 *     PUT /script (unchanged), POST /jobs  ->  4590f8e8-…    a second animatic, charged
 *
 * The screenplay's history is uncapped (recorded at HV-016-04 and still an operator decision), so
 * this also grew the stored state by a whole copy of the script each time nothing happened.
 */
import {expect, test} from "bun:test";
import {VersionStore} from "../src/index";

const SCRIPT = "INT. BAR - DAY\n\nShe waits.";

test("a save that changes nothing is not a revision", () => {
  const store = new VersionStore();
  const first = store.commit(SCRIPT);
  expect({version: first.version, parent: first.parentVersion}).toEqual({version: 1, parent: null});
  // The same text, three more times. Same version, same record, and nothing added to the history.
  for (const attempt of [2, 3, 4]) {
    const again = store.commit(SCRIPT);
    expect({attempt, version: again.version, createdAt: again.createdAt, text: again.text})
      .toEqual({attempt, version: 1, createdAt: first.createdAt, text: SCRIPT});
  }
  expect(store.latest()).toEqual(first);
  expect(store.get(2)).toBeUndefined();
});

test("and a save that changes something still is one", () => {
  const store = new VersionStore();
  store.commit(SCRIPT);
  const changed = store.commit(SCRIPT + "\n\nShe leaves.");
  expect({version: changed.version, parent: changed.parentVersion}).toEqual({version: 2, parent: 1});
  // Including a change that is only whitespace, or only a letter: identical means identical.
  expect(store.commit(SCRIPT + "\n\nShe leaves. ").version).toBe(3);
  expect(store.commit(SCRIPT + "\n\nShe leaves.").version).toBe(4);
  // And going back to a text the history already holds is a new version, not the old one: the
  // screenplay moved away from it and moved back, which is a revision.
  expect(store.get(2)!.text).toBe(SCRIPT + "\n\nShe leaves.");
  expect(store.latest()!.version).toBe(4);
});

test("and only the latest text is compared, never an earlier one", () => {
  // The rule is "nothing changed since the last save", not "this text has been seen before". A
  // screenplay that goes A, B, A ends at three versions, and the third is a real revision away from
  // B -- which is what a restore is, and what the cut impact of a restore is computed against.
  const store = new VersionStore();
  store.commit("A"); store.commit("B");
  const back = store.commit("A");
  expect({version: back.version, parent: back.parentVersion}).toEqual({version: 3, parent: 2});
  expect(store.commit("A").version).toBe(3);
});

test("and the empty store still takes the first save", () => {
  const store = new VersionStore();
  expect(store.latest()).toBeUndefined();
  expect(store.commit("").version).toBe(1);
  expect(store.commit("").version).toBe(1);
});
