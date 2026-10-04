/**
 * HV-030-30 — a feature's film survives a state snapshot, and a changed one doesn't.
 *
 * A `feature-film` job is a stage of its own. A snapshot carries its plan (each sequence's final and
 * film) and its export, and reads them back unchanged; it refuses a plan or an export changed after
 * the join, a finished feature film with no export, and another job carrying a feature film's export.
 */
import {expect, test} from "bun:test";
import {readStateSnapshot, validateSnapshot} from "../src/snapshots";
import {GOLDEN_SOURCE} from "./fixtures/archive-golden/matrix";
import {featureFilmJob, featurePlan} from "../../../test/fixtures/feature-film";
import type {Job} from "../../queue/src/index";

const golden = readStateSnapshot(GOLDEN_SOURCE);
const withJob = (job: Job) => { const copy = structuredClone(golden); copy.jobs.push(JSON.parse(JSON.stringify(job))); return copy; };

test("a feature's film rides in the snapshot and reads back unchanged", () => {
  const job = featureFilmJob(featurePlan(true));
  const read = validateSnapshot(withJob(job)).jobs.find(value => value.id === job.id)!;
  expect([read.stage, read.featureFilm, read.output]).toEqual([job.stage, job.featureFilm, job.output]);
});

test("a changed plan or export, a finished film with no export, or a stray export is refused", () => {
  const job = featureFilmJob(featurePlan(true));
  const changedPlan = structuredClone(job); changedPlan.featureFilm!.sequences[0]!.finalJobId = "final-2";
  expect(() => validateSnapshot(withJob(changedPlan))).toThrow();
  const changedExport = structuredClone(job); changedExport.output!.featureFilm!.durationSec = 1;
  expect(() => validateSnapshot(withJob(changedExport))).toThrow("The feature's film export receipt changed.");
  const escaped = structuredClone(job); escaped.output!.mp4Path = "another-project/x/export.mp4";
  expect(() => validateSnapshot(withJob(escaped))).toThrow();
  const empty = structuredClone(job); delete empty.output;
  expect(() => validateSnapshot(withJob(empty))).toThrow("A finished feature film has no export.");
  const stray = structuredClone(golden); (stray.jobs[0]!.output as Record<string, unknown>).featureFilm = job.output!.featureFilm;
  expect(() => validateSnapshot(stray)).toThrow("A different job cannot carry a feature's film.");
  const wrongStage = structuredClone(job); (wrongStage as {stage: string}).stage = "feature";
  expect(() => validateSnapshot(withJob(wrongStage))).toThrow();
});
