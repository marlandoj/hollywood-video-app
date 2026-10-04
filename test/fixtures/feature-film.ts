/**
 * HV-030-30: a synthetic three-sequence feature, its finished sequence films and a joined film's plan
 * and export, for the feature-film validators' tests. Nothing here is rendered; the jobs carry exactly
 * what the validators read. `featureFixture(projectId)` makes them for one project; the named exports
 * are the fixture for `PROJECT`.
 */
import type {Job} from "../../packages/queue/src/index";
import {contentHash} from "../../packages/generator/src/capabilities";
import {parseFountain} from "../../packages/parser/src/index";
import {currentCasting} from "../../packages/planner/src/casting";
import {currentDirection} from "../../packages/planner/src/direction";
import {greedySequences,sceneShotCounts,sequencePlan,sequenceRef} from "../../packages/planner/src/sequences";
import {createFeatureFilmPlan,featureFilmSources,FEATURE_FILM_OUTPUT_SCHEMA,type FeatureFilmOutput,type FeatureFilmPlan,type FeatureFilmProject} from "../../packages/planner/src/feature-film";
import {provenanceCredentials} from "../../packages/planner/src/provenance";
import {evenFeature} from "./feature-script";

export const PROJECT = "feature-project";
export const SCRIPT = evenFeature(3, 13);
export const parsed = parseFountain(SCRIPT);
export const split = sequencePlan(1, greedySequences(sceneShotCounts(parsed)));
const hex = (seed: string) => contentHash(seed);

export function featureFixture(projectId = PROJECT) {
  const output = (jobId: string) => ({mp4Path: `${projectId}/${jobId}/export.mp4`, hlsPlaylistPath: `${projectId}/${jobId}/hls/index.m3u8`, captionsPath: `${projectId}/${jobId}/captions.vtt`, manifestPath: `${projectId}/${jobId}/provenance.json`});
  const base = (id: string, stage: string, extra: Partial<Job> = {}): Job => ({id, idempotencyKey: id, projectId, tier: "free", stage, scriptVersion: 1, status: "done", queueAction: "run",
    queueReason: "capacity_available", queuedBehind: [], checkpointFrame: 0, checkpointShots: 0, totalFrames: 600, retryPolicy: {maxRetries: 0, backoffMs: 0}, retriesUsed: 0, timeoutMs: 1000,
    costCapUsd: 0, costUsd: 0, scriptText: SCRIPT, rightsAttestedAt: "2026-10-01T00:00:00.000Z", animaticJobId: null, animaticApprovedAt: null, nextEligibleAt: null, startedAt: null,
    leaseExpiresAt: null, claimedBy: null, resumedCount: 0, completedAt: "2026-10-02T00:00:00.000Z", linkExpiresAt: "2099-01-01T00:00:00.000Z", notifications: [], output: output(id), ...extra} as Job);
  /** Sequence `number`'s final, made from its approved rough cut `animatic-<number>`. */
  const final = (number: number, extra: Partial<Job> = {}) => base(`final-${number}`, "final", {sequence: sequenceRef(split, number), animaticJobId: `animatic-${number}`,
    completedAt: `2026-10-0${number}T00:00:00.000Z`, ...extra});
  /** The sound mix that finishes sequence `number`'s final (voiced and scored, as the front door does). */
  const mix = (number: number, of: Job = final(number)) => base(`mix-${number}`, "sound-mix", {soundMix: {source: {base: of}} as never});
  const rough = (number: number) => base(`animatic-${number}`, "animatic", {sequence: sequenceRef(split, number)});
  const graphic = (id: string, kind: "title" | "credits") => base(id, "motion-graphic", {output: undefined, graphicRender: {spec: {id, plan: {kind, frames: kind === "title" ? 120 : 180, width: 1280, height: 720}}} as never,
    graphicOutput: {masterPath: `${projectId}/${id}/graphic.mkv`, manifestPath: `${projectId}/${id}/graphic.json`} as never});
  const featureProject = (extra: Partial<FeatureFilmProject> = {}): FeatureFilmProject => ({id: projectId, format: "feature", sequences: split, scriptVersion: 1, parsed,
    casting: currentCasting(projectId, []), direction: currentDirection(projectId, []), approvals: [1, 2, 3].map(number => ({animaticJobId: `animatic-${number}`, decision: "approved"})), ...extra});
  const featureJobs = (): Job[] => [1, 2, 3].flatMap(number => [rough(number), final(number), mix(number)]);
  /** The plan for joining the three sound mixes (or the three finals), with or without the Editor's graphics. */
  const featurePlan = (titled = false, films: "mix" | "final" = "mix"): FeatureFilmPlan => {
    const jobs = [...featureJobs(), graphic("g-title", "title"), graphic("g-credits", "credits")];
    const chosen = featureFilmSources(featureProject(), {sequences: [1, 2, 3].map(number => ({number, jobId: `${films}-${number}`})), title: null, credits: null}, jobs);
    const graphicOf = (id: string, frames: number) => ({jobId: id, outputRevision: contentHash(jobs.find(job => job.id === id)!.graphicOutput), masterPath: `${projectId}/${id}/graphic.mkv`, frames, width: 1280, height: 720});
    return createFeatureFilmPlan({planRevision: split.revision, scriptVersion: 1, sequences: chosen.sequences, films: chosen.films, title: titled ? graphicOf("g-title", 120) : null,
      credits: titled ? graphicOf("g-credits", 180) : null, width: 1280, height: 720, storage: "local", requestHash: hex("request")});
  };
  /** The export a feature-film job made, signed (a sidecar beside the record) or not. */
  const featureFilmOutput = (plan: FeatureFilmPlan, id: string, signed = true): NonNullable<Job["output"]> => {
    const prefix = `${projectId}/${id}/feature-1/`, mp4 = hex("mp4"), sidecar = hex("sidecar");
    const files = ["captions.srt", "captions.vtt", "export.mp4", "hls/index.m3u8", "hls/segment-000.ts", "provenance.json", ...(signed ? ["provenance.c2pa"] : [])]
      .map(name => ({path: prefix + name, bytes: 10, sha256: name === "export.mp4" ? mp4 : name === "provenance.c2pa" ? sidecar : hex(name)}));
    const data = {schema: FEATURE_FILM_OUTPUT_SCHEMA, planRevision: plan.revision, sha256: mp4, durationSec: 60.2,
      credentials: provenanceCredentials(mp4, signed ? {name: "provenance.c2pa", sha256: sidecar} : undefined), files};
    const featureFilm: FeatureFilmOutput = {...data, revision: contentHash(data)};
    return {mp4Path: prefix + "export.mp4", hlsPlaylistPath: prefix + "hls/index.m3u8", captionsPath: prefix + "captions.vtt", manifestPath: prefix + "provenance.json",
      ...(signed ? {c2paPath: prefix + "provenance.c2pa"} : {}), featureFilm};
  };
  /** A finished feature-film job and its export. */
  const featureFilmJob = (plan = featurePlan(), signed = true): Job =>
    base("feature-film-1", "feature-film", {featureFilm: plan, budgetReservedUsd: 0, output: featureFilmOutput(plan, "feature-film-1", signed)});
  return {final, mix, rough, graphic, featureProject, featureJobs, featurePlan, featureFilmOutput, featureFilmJob};
}

export const {final, mix, rough, graphic, featureProject, featureJobs, featurePlan, featureFilmOutput, featureFilmJob} = featureFixture();
