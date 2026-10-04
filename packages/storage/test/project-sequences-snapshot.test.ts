/**
 * HV-030-29 — a feature's sequence plan and its sequence renders survive a state snapshot.
 *
 * The Showrunner's plan is kept on the project beside its format, and each rough cut or final of a
 * feature names its sequence. A snapshot carries both and reads them back; it refuses a plan that isn't
 * the Showrunner's shape, a plan on anything but a feature, a plan for a screenplay version the project
 * doesn't have, and a render whose sequence is malformed or sits on a job that can't render one.
 */
import { expect, test } from "bun:test";
import { parseFountain } from "../../parser/src/index";
import { greedySequences, sceneShotCounts, sequencePlan, sequenceRef } from "../../planner/src/sequences";
import { readStateSnapshot, validateSnapshot } from "../src/snapshots";
import { GOLDEN_SOURCE } from "./fixtures/archive-golden/matrix";

const golden = readStateSnapshot(GOLDEN_SOURCE);
const project = golden.projects.projects[0]!;
const plan = sequencePlan(project.versions[0]!.version, greedySequences(sceneShotCounts(parseFountain(project.versions[0]!.text))));
const withPlan = (sequences: unknown, format: unknown = "feature") => {
  const copy = structuredClone(golden);
  Object.assign(copy.projects.projects[0]!, {format, sequences});
  return copy;
};

test("a feature's plan rides in the snapshot and reads back unchanged", () => {
  expect(project.sequences).toBeUndefined();
  expect(validateSnapshot(structuredClone(golden)).projects.projects[0]).not.toHaveProperty("sequences");
  const read = validateSnapshot(JSON.parse(JSON.stringify(withPlan(plan))));
  expect(read.projects.projects[0]!.sequences).toEqual(plan);
  expect(read.projects.projects[0]!.format).toBe("feature");
});

test("anything but the Showrunner's plan of a feature's own screenplay is refused", () => {
  const tampered = structuredClone(plan); tampered.sequences[0]!.shots += 1;
  for (const bad of [tampered, {...plan, revision: "0".repeat(64)}, {...plan, sequences: []}, {...plan, extra: true}, "1-3", null])
    expect(() => validateSnapshot(withPlan(bad))).toThrow("invalid project sequences");
  for (const format of ["short", "reel"]) expect(() => validateSnapshot(withPlan(plan, format))).toThrow("invalid project sequences");
  const unplanned = withPlan(plan); delete (unplanned.projects.projects[0] as {format?: unknown}).format;
  expect(() => validateSnapshot(unplanned)).toThrow("invalid project sequences");
  expect(() => validateSnapshot(withPlan(sequencePlan(99, plan.sequences)))).toThrow("invalid project sequences");
});

test("a render of one sequence rides in the snapshot; a malformed or misplaced sequence is refused", () => {
  const job = golden.jobs[0]!;
  expect([job.stage, job.status, job.sequence]).toEqual(["animatic", "done", undefined]);
  const ref = sequenceRef(plan, 1);
  // The golden script fits one render, so its one sequence plans exactly the shots this rough cut rendered.
  expect(plan.sequences).toHaveLength(1);
  const carried = withPlan(plan); carried.jobs[0]!.sequence = ref;
  expect(validateSnapshot(JSON.parse(JSON.stringify(carried))).jobs[0]!.sequence).toEqual(ref);
  for (const bad of [{...ref, number: 2}, {...ref, planRevision: "x"}, {...ref, extra: 1}]) {
    const copy = withPlan(plan); (copy.jobs[0] as {sequence?: unknown}).sequence = bad;
    expect(() => validateSnapshot(copy)).toThrow("A render's sequence is not one of a Showrunner's plan.");
  }
  const sheet = withPlan(plan); Object.assign(sheet.jobs[0]!, {sequence: ref, stage: "sound-mix"});
  expect(() => validateSnapshot(sheet)).toThrow();
});
