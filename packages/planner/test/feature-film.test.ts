/**
 * HV-030-30 — what a feature's join may be made of, and what its job and export must be.
 *
 * On a synthetic three-sequence feature (`test/fixtures/feature-film.ts`): the join is made of each
 * sequence's finished film, traced through its sound mix to that sequence's own current final, and is
 * refused for a missing, crossed, stale, superseded, older-split, unfinished or foreign film. A plan,
 * a job and an export that were changed after admission are refused wherever they are read.
 */
import {expect, test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {sequencePlan} from "../src/sequences";
import {FeatureFilmConflict, assertFeatureFilmSourcesAvailable, featureFilmClaim, featureFilmGraphic, featureFilmSources, finalOf, validateFeatureFilmJob, validateFeatureFilmOutput, validateFeatureFilmPlan} from "../src/feature-film";
import type {Job} from "../../queue/src/index";
import {PROJECT, featureFilmJob, featureJobs, featurePlan, featureProject, final, graphic, mix, split} from "../../../test/fixtures/feature-film";

const claim = (ids: string[]) => ({sequences: ids.map((jobId, number) => ({number: number + 1, jobId})), title: null, credits: null});
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return [(error as Error).name, (error as Error).message]; } return null; };

test("each sequence's film is traced to its own current final, in order, and recorded", () => {
  expect(finalOf(mix(2))!.id).toBe("final-2");
  expect(finalOf(final(1))!.id).toBe("final-1");
  expect(finalOf(featureJobs()[0]!)).toBeNull();
  const {plan, sequences, films} = featureFilmSources(featureProject(), claim(["mix-1", "mix-2", "mix-3"]), featureJobs());
  expect(plan.revision).toBe(split.revision);
  expect(sequences).toEqual([1, 2, 3].map(number => ({number, firstScene: number, lastScene: number, finalJobId: `final-${number}`, filmJobId: `mix-${number}`})));
  expect(films.map(film => [film.number, film.job.id, film.outputRevision])).toEqual([1, 2, 3].map(number => [number, `mix-${number}`, contentHash(mix(number).output)]));
  // A final is a film too, when nothing finished it further.
  expect(featureFilmSources(featureProject(), claim(["final-1", "mix-2", "final-3"]), featureJobs()).sequences.map(value => value.finalJobId)).toEqual(["final-1", "final-2", "final-3"]);
});

test("a missing, crossed, stale, superseded, older-split, unfinished or foreign film is refused, naming its sequence", () => {
  const jobs = featureJobs(), project = featureProject(), sources = (ids: string[], extra: Job[] = [], over = project) => refusal(() => featureFilmSources(over, claim(ids), [...jobs, ...extra]));
  const conflict = (message: string) => ["FeatureFilmConflict", message];
  expect(sources(["mix-1", "mix-2"])).toEqual(conflict("Sequence 3 has no film to join. Make its final before joining the feature."));
  expect(sources(["mix-2", "mix-1", "mix-3"])).toEqual(conflict("The film named as sequence 1 is sequence 2's."));
  expect(sources(["mix-1", "mix-1", "mix-3"])).toEqual(conflict("Each sequence is joined from its own film; one film was named twice."));
  expect(sources(["animatic-1", "mix-2", "mix-3"])).toEqual(conflict("Sequence 1's film isn't made from one of this feature's sequence finals."));
  expect(sources(["elsewhere", "mix-2", "mix-3"], [{...mix(1), id: "elsewhere", projectId: "another-project"}])).toEqual(conflict("Sequence 1's film isn't one of this project's films."));
  expect(sources(["running", "mix-2", "mix-3"], [{...mix(1), id: "running", status: "running"}])).toEqual(conflict("Sequence 1's film isn't finished."));
  // Stale: the rough cut it followed was sent back, the cast moved on, or the screenplay changed.
  const stale = conflict("Sequence 2's final is stale: the screenplay, the cast, the shot directions or its rough cut's approval changed after it was made. Make its rough cut and final again.");
  expect(sources(["mix-1", "mix-2", "mix-3"], [], {...project, approvals: project.approvals.map(value => value.animaticJobId === "animatic-2" ? {...value, decision: "changes_requested"} : value)})).toEqual(stale);
  const recast = featureJobs().map(job => job.id === "final-2" ? {...job, casting: {...project.casting, version: 3}} as Job : job);
  expect(refusal(() => featureFilmSources(project, claim(["mix-1", "mix-2", "mix-3"]), recast))).toEqual(stale);
  // Superseded: sequence 2 was finished again later, so its older film isn't its final any more.
  expect(sources(["mix-1", "mix-2", "mix-3"], [final(2, {id: "final-2b", completedAt: "2026-10-09T00:00:00.000Z"})])).toEqual(conflict("Sequence 2's film isn't from its latest final. Join the film made from that final."));
  // An older split: the film was made for another plan of the feature.
  const older = sequencePlan(7, split.sequences);
  expect(older.revision).not.toBe(split.revision);
  const oldFinal = final(1, {id: "final-old", sequence: {...final(1).sequence!, planRevision: older.revision}});
  expect(sources(["old-mix", "mix-2", "mix-3"], [oldFinal, {...mix(1, oldFinal), id: "old-mix"}])).toEqual(conflict("Sequence 1's film is from an older split of the feature. Make its rough cut and final again."));
  // Not a feature, or a screenplay changed after the split.
  expect(sources(["mix-1", "mix-2", "mix-3"], [], {...project, format: "short"})).toEqual(conflict("Only a feature the Showrunner split into sequences is joined into one film."));
  expect(sources(["mix-1", "mix-2", "mix-3"], [], {...project, scriptVersion: 2})).toEqual(conflict("The screenplay changed after the Showrunner split the feature. Plan the film again."));
});

test("the request's shape and its graphics are checked before any job is read", () => {
  for (const bad of [{}, {sequences: [], title: null, credits: null}, {sequences: [{number: 1}], title: null, credits: null}, {sequences: [{number: 0, jobId: "a"}], title: null, credits: null},
    {sequences: [{number: 1, jobId: "a/b"}], title: null, credits: null}, {sequences: [{number: 1, jobId: "a"}], title: 3, credits: null}, {sequences: [{number: 1, jobId: "a"}], title: null}])
    expect(() => featureFilmClaim(bad)).toThrow(FeatureFilmConflict);
  const jobs = [...featureJobs(), graphic("g-title", "title"), graphic("g-credits", "credits")];
  expect(featureFilmGraphic("title", "g-title", jobs, PROJECT)).toMatchObject({jobId: "g-title", frames: 120, width: 1280, height: 720, masterPath: `${PROJECT}/g-title/graphic.mkv`});
  expect(featureFilmGraphic("credits", null, jobs, PROJECT)).toBeNull();
  expect(() => featureFilmGraphic("credits", "g-title", jobs, PROJECT)).toThrow("The feature's end credits must be a finished credits graphic of this project.");
  expect(() => featureFilmGraphic("title", "mix-1", jobs, PROJECT)).toThrow("The feature's opening title must be a finished title graphic of this project.");
});

test("a plan changed after admission is refused, and so is a job carrying anything but its plan", () => {
  const plan = featurePlan(true);
  expect(validateFeatureFilmPlan(plan, PROJECT)).toBe(plan);
  const changed = (edit: (copy: typeof plan) => void) => { const copy = structuredClone(plan); edit(copy); return () => validateFeatureFilmPlan(copy, PROJECT); };
  expect(changed(copy => { copy.sequences[1]!.finalJobId = "final-3"; })).toThrow();
  expect(changed(copy => { copy.films.reverse(); })).toThrow();
  expect(changed(copy => { copy.films[0]!.job.output!.mp4Path = "elsewhere.mp4"; })).toThrow();
  expect(changed(copy => { copy.crossfadeFrames = 30; })).toThrow();
  expect(changed(copy => { copy.width = 1281; })).toThrow();
  expect(changed(copy => { copy.title!.masterPath = "another-project/g-title/graphic.mkv"; })).toThrow();
  expect(changed(copy => { copy.revision = "0".repeat(64); })).toThrow("The feature's film plan changed after admission.");
  expect(() => validateFeatureFilmPlan(plan, "another-project")).toThrow();
  const job = featureFilmJob(plan);
  expect(() => validateFeatureFilmJob(job)).not.toThrow();
  expect(() => validateFeatureFilmJob({...job, stage: "final"})).toThrow("A feature's film requires its own admitted plan.");
  expect(() => validateFeatureFilmJob({...job, featureFilm: undefined})).toThrow("A feature's film requires its own admitted plan.");
  expect(() => validateFeatureFilmJob({...job, costCapUsd: 1})).toThrow("Invalid isolated feature-film job context.");
  expect(() => validateFeatureFilmJob({...job, soundMix: mix(1).soundMix})).toThrow("Invalid isolated feature-film job context.");
  expect(() => validateFeatureFilmJob({...mix(1), output: job.output})).toThrow("A different job cannot carry a feature's film.");
});

test("the export is its own job's, names its MP4 and its sidecar, and its receipt can't be changed", () => {
  const job = featureFilmJob(), output = job.output!;
  expect(validateFeatureFilmOutput(job, output).durationSec).toBe(60.2);
  expect(() => validateFeatureFilmOutput(featureFilmJob(featurePlan(), false), featureFilmJob(featurePlan(), false).output!)).not.toThrow();
  const changed = (edit: (copy: typeof output) => void) => { const copy = structuredClone(output); edit(copy); return () => validateFeatureFilmOutput(job, copy); };
  expect(changed(copy => { copy.mp4Path = `${PROJECT}/another-job/feature-1/export.mp4`; })).toThrow("The feature's film export escaped its job.");
  expect(changed(copy => { delete copy.c2paPath; })).toThrow();
  expect(changed(copy => { copy.featureFilm!.sha256 = "0".repeat(64); })).toThrow();
  expect(changed(copy => { copy.featureFilm!.files = copy.featureFilm!.files.filter(file => !file.path.endsWith("provenance.c2pa")); })).toThrow();
  expect(changed(copy => { copy.featureFilm!.durationSec = 61; })).toThrow("The feature's film export receipt changed.");
  expect(changed(copy => { copy.featureFilm!.planRevision = "0".repeat(64); })).toThrow("The feature's film export differs from its plan.");
  expect(changed(copy => { (copy as Record<string, unknown>).editorial = {}; })).toThrow("The feature's film export carries other media.");
  expect(() => validateFeatureFilmOutput(mix(1), output)).toThrow("Only a feature's film carries a feature-film export.");
});

test("a film made again, expired or gone after admission stops the join", () => {
  const plan = featurePlan(true), jobs = new Map([...featureJobs(), graphic("g-title", "title"), graphic("g-credits", "credits")].map(job => [job.id, job] as const));
  const check = (over: Record<string, Job | undefined> = {}) => () => assertFeatureFilmSourcesAvailable(plan, id => (id in over ? over[id] : jobs.get(id)), Date.parse("2026-10-10T00:00:00.000Z"));
  expect(check()).not.toThrow();
  expect(check({"mix-2": undefined})).toThrow("Sequence 2's film changed or expired after the join was admitted. Join the feature again.");
  expect(check({"mix-2": {...mix(2), output: {...mix(2).output!, mp4Path: `${PROJECT}/mix-2/other.mp4`}}})).toThrow("Sequence 2's film changed");
  expect(check({"mix-3": {...mix(3), linkExpiresAt: "2026-10-05T00:00:00.000Z"}})).toThrow("Sequence 3's film changed or expired");
  expect(check({"g-credits": {...graphic("g-credits", "credits"), graphicOutput: {masterPath: "x"} as never}})).toThrow("The Editor's title or credits changed after the join was admitted. Join the feature again.");
});
