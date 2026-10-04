/**
 * HV-034-02 — a feature's style bible, and the bible a sequence render read, survive a state snapshot.
 *
 * The bible is kept on the project beside its sequences, and each sequence render carries the bible it
 * read and names its revision. A snapshot carries both and reads them back; it refuses a bible that
 * isn't the studio's shape or was changed after it was written, a bible on anything but a feature, a
 * bible for a screenplay version the project doesn't have, and a render whose bible isn't the one its
 * sequence names, or that carries one without a sequence.
 */
import { expect, test } from "bun:test";
import { parseFountain } from "../../parser/src/index";
import { STAND_IN_STYLE } from "../../planner/src/crew/style-bible";
import { greedySequences, sceneShotCounts, sequencePlan, sequenceRef } from "../../planner/src/sequences";
import { scriptLocations, styleBible } from "../../planner/src/style-bible";
import { readStateSnapshot, validateSnapshot } from "../src/snapshots";
import { GOLDEN_SOURCE } from "./fixtures/archive-golden/matrix";

const golden = readStateSnapshot(GOLDEN_SOURCE);
const project = golden.projects.projects[0]!, version = project.versions[0]!;
const parsed = parseFountain(version.text);
const plan = sequencePlan(version.version, greedySequences(sceneShotCounts(parsed)));
const bible = styleBible({version: 1, scriptVersion: version.version, source: "stand-in", ...STAND_IN_STYLE, characters: [{name: "MARA", description: "A tall woman in her forties."}],
  locations: scriptLocations(parsed).locations});
const withBible = (styleBibleValue: unknown, format: unknown = "feature") => {
  const copy = structuredClone(golden);
  Object.assign(copy.projects.projects[0]!, {format, sequences: plan, styleBible: styleBibleValue});
  return copy;
};

test("a feature's bible rides in the snapshot and reads back unchanged", () => {
  expect(project.styleBible).toBeUndefined();
  expect(validateSnapshot(structuredClone(golden)).projects.projects[0]).not.toHaveProperty("styleBible");
  const read = validateSnapshot(JSON.parse(JSON.stringify(withBible(bible))));
  expect(read.projects.projects[0]!.styleBible).toEqual(bible);
});

test("anything but the studio's bible of a feature's own screenplay is refused", () => {
  for (const bad of [{...bible, look: "Changed after."}, {...bible, revision: "0".repeat(64)}, {...bible, extra: true}, {...bible, look: ""},
    {...bible, characters: [{name: "MARA"}]}, "bible", null])
    expect(() => validateSnapshot(withBible(bad))).toThrow("invalid project style bible");
  for (const format of ["short", "reel"]) {
    const copy = withBible(bible, format); delete (copy.projects.projects[0] as {sequences?: unknown}).sequences;
    expect(() => validateSnapshot(copy)).toThrow("invalid project style bible");
  }
  const unplanned = withBible(bible); delete (unplanned.projects.projects[0] as {format?: unknown}).format; delete (unplanned.projects.projects[0] as {sequences?: unknown}).sequences;
  expect(() => validateSnapshot(unplanned)).toThrow("invalid project style bible");
  expect(() => validateSnapshot(withBible(styleBible({...bible, scriptVersion: 99})))).toThrow("invalid project style bible");
});

test("a sequence render carries the bible it read; a mismatched or misplaced bible is refused", () => {
  const ref = sequenceRef(plan, 1, bible.revision);
  const carried = withBible(bible); Object.assign(carried.jobs[0]!, {sequence: ref, styleBible: bible});
  const read = validateSnapshot(JSON.parse(JSON.stringify(carried)));
  expect([read.jobs[0]!.sequence, read.jobs[0]!.styleBible]).toEqual([ref, bible]);
  const other = styleBible({...bible, look: "Another look."});
  const mismatched = withBible(bible); Object.assign(mismatched.jobs[0]!, {sequence: ref, styleBible: other});
  expect(() => validateSnapshot(mismatched)).toThrow("A render's style bible is not the one its sequence names.");
  const unread = withBible(bible); Object.assign(unread.jobs[0]!, {sequence: ref});
  expect(() => validateSnapshot(unread)).toThrow("Only a feature's sequence render reads a style bible.");
  const loose = withBible(bible); Object.assign(loose.jobs[0]!, {styleBible: bible});
  expect(() => validateSnapshot(loose)).toThrow("Only a feature's sequence render reads a style bible.");
  const tampered = withBible(bible); Object.assign(tampered.jobs[0]!, {sequence: ref, styleBible: {...bible, tone: "Edited in the snapshot."}});
  expect(() => validateSnapshot(tampered)).toThrow("changed after it was written");
});
