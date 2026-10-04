/**
 * HV-034-02 with HV-030-30 — the joined feature keeps one look.
 *
 * Every sequence's final names the style bible revision its renders read. The join is made only of
 * finals that read the bible the feature has now, and its plan records that revision. A feature with
 * no bible joins as before, and its plan records none.
 */
import {expect, test} from "bun:test";
import {sequenceRef} from "../src/sequences";
import {createFeatureFilmPlan, featureFilmSources, validateFeatureFilmPlan} from "../src/feature-film";
import type {Job} from "../../queue/src/index";
import {PROJECT, featureJobs, featurePlan, featureProject, final, mix, split} from "../../../test/fixtures/feature-film";

const BIBLE = "b".repeat(64), OLDER = "c".repeat(64);
const claim = {sequences: [1, 2, 3].map(number => ({number, jobId: `mix-${number}`})), title: null, credits: null};
/** The fixture's finals and films, each final having read `revision` (or `revisions[n-1]`). */
const read = (revisions: (string | undefined)[]): Job[] => featureJobs().map(job => {
  const number = Number(job.id.split("-")[1]), revision = revisions[number - 1];
  if (job.stage === "final") return final(number, {sequence: sequenceRef(split, number, revision)});
  if (job.stage === "sound-mix") return mix(number, final(number, {sequence: sequenceRef(split, number, revision)}));
  return job;
});

test("the join is made of finals that read the feature's current bible", () => {
  const sources = featureFilmSources(featureProject({styleBible: {revision: BIBLE}}), claim, read([BIBLE, BIBLE, BIBLE]));
  expect(sources.sequences.map(sequence => sequence.finalJobId)).toEqual(["final-1", "final-2", "final-3"]);
});

test("a final made with an older bible, or none, is refused, naming its sequence", () => {
  expect(() => featureFilmSources(featureProject({styleBible: {revision: BIBLE}}), claim, read([BIBLE, OLDER, BIBLE])))
    .toThrow("Sequence 2's final was made with an older style bible. Make its rough cut and final again, so the feature keeps one look.");
  expect(() => featureFilmSources(featureProject({styleBible: {revision: BIBLE}}), claim, read([undefined, BIBLE, BIBLE])))
    .toThrow("Sequence 1's final was made with no style bible.");
  // A feature with no bible refuses a final that read one, and joins finals that read none, as before.
  expect(() => featureFilmSources(featureProject(), claim, read([BIBLE, undefined, undefined]))).toThrow("Sequence 1's final was made with an older style bible.");
  expect(featureFilmSources(featureProject(), claim, read([undefined, undefined, undefined])).sequences).toHaveLength(3);
});

test("the join's plan records the bible revision; a plan without a bible is unchanged", () => {
  const plain = featurePlan();
  expect(plain).not.toHaveProperty("bibleRevision");
  const {revision: _revision, schema: _schema, crossfadeFrames: _frames, ...input} = plain;
  const recorded = createFeatureFilmPlan({...input, bibleRevision: BIBLE});
  expect(recorded.bibleRevision).toBe(BIBLE);
  expect(recorded.revision).not.toBe(plain.revision);
  expect(validateFeatureFilmPlan(structuredClone(recorded), PROJECT)).toEqual(recorded);
  expect(() => validateFeatureFilmPlan({...recorded, bibleRevision: OLDER}, PROJECT)).toThrow("The feature's film plan changed after admission.");
  expect(() => validateFeatureFilmPlan({...recorded, bibleRevision: "x"}, PROJECT)).toThrow();
});
