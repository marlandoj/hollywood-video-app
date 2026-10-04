import {contentHash} from "../../generator/src/capabilities";
import type {ParseResult} from "../../parser/src/index";
import type {DirectionSnapshot} from "./direction";
import type {Shot} from "./index";
import {SceneCutConflict,sourcePlan,staleSceneCuts,validateSceneCuts} from "./scene-cuts";

/**
 * A feature's sequences (HV-030-29, Release 3 step 2, G20-202610031349).
 *
 * A feature is longer than one render: the free tier renders at most 24 shots (`TIERS.free.maxShots`
 * in packages/queue), and a 15-20 minute feature is about 200-240 shots. The Showrunner splits it into
 * sequences, runs of consecutive scenes of at most 24 shots each, and each sequence is rendered as its
 * own rough cut and final through the same film pipeline a short uses. The sequence is the render unit.
 *
 * **The feature's shots don't depend on the split.** Each scene is planned on its own: one shot per
 * beat, as a short of up to 24 beats is; a scene of more than 24 beats is grouped into 24 shots, as a
 * short of one such scene would be; a scene with accepted coverage keeps its coverage's shots. A
 * sequence of at most 24 such shots plans exactly those shots in a 24-shot render, so whatever valid
 * split is chosen, the feature's shot ids, prompts and seeds are the same. The crew directs these shots
 * once, at the plan step, and every sequence render reads its own scenes' shots from them.
 *
 * Scene numbers here are one-based, as the desk and the continuity report number scenes.
 */
export const SEQUENCE_SHOT_LIMIT = 24;
/** At most this many sequences in a plan: far past a 20-minute feature (about ten), and a bound for stored state. */
export const SEQUENCE_LIMIT = 100;
export interface FilmSequence { firstScene: number; lastScene: number; shots: number }
export interface SequencePlan { schema: "hv-sequence-plan/1"; scriptVersion: number; sequences: FilmSequence[]; revision: string }
/** What a render job carries: which sequence of which plan it renders. */
export interface SequenceRef { number: number; of: number; firstScene: number; lastScene: number; planRevision: string }
export class SequenceSplitError extends Error { override name = "SequenceSplitError"; }

const positive = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value as object).sort().join(",") === [...keys].sort().join(",");

/**
 * The feature's shots, scene by scene, independent of how it is split (see above). A stale accepted
 * cut is refused as `sourcePlan` refuses it, unless `review` is set (then it is left out, as there).
 */
export function featureShots(parsed: ParseResult, direction?: DirectionSnapshot, review = false): Shot[] {
  const cuts = validateSceneCuts(direction?.sceneCuts ?? []), stale = staleSceneCuts(parsed, direction);
  if (stale.length && !review) throw new SceneCutConflict("Scene " + (stale[0]!.source.sceneIndex + 1) + " changed. Review, replace or remove its accepted coverage before rendering.");
  const shots: Shot[] = [];
  for (const scene of parsed.scenes) {
    const own = cuts.filter(cut => cut.source.sceneIndex === scene.index);
    // One scene in a 24-shot render, at the seed the uncapped plan would give its first shot.
    shots.push(...sourcePlan({...parsed, scenes: [scene]}, direction ? {...direction, sceneCuts: own} : undefined, 7000 + shots.length, SEQUENCE_SHOT_LIMIT, true));
  }
  return shots;
}

/** How many shots each scene is, in scene order. */
export function sceneShotCounts(parsed: ParseResult, direction?: DirectionSnapshot): number[] {
  const shots = featureShots(parsed, direction, true);
  return parsed.scenes.map(scene => shots.filter(shot => shot.sceneIndex === scene.index).length);
}

/** The scenes no sequence can hold: accepted coverage of more than 24 shots. One-based. */
export function oversizedScenes(counts: number[]): number[] {
  return counts.flatMap((count, index) => count > SEQUENCE_SHOT_LIMIT ? [index + 1] : []);
}

/**
 * The stand-in Showrunner's split: deterministic and greedy. Scenes are taken in order and a sequence
 * is closed when the next scene would take it past 24 shots.
 */
export function greedySequences(counts: number[]): FilmSequence[] {
  const oversized = oversizedScenes(counts);
  if (oversized.length) throw new SequenceSplitError("Scene " + oversized[0] + "'s accepted coverage needs " + counts[oversized[0]! - 1] + " shots, and a sequence renders at most "
    + SEQUENCE_SHOT_LIMIT + ". Edit its coverage before planning the feature.");
  const sequences: FilmSequence[] = [];
  counts.forEach((count, index) => {
    const last = sequences.at(-1);
    if (last && last.shots + count <= SEQUENCE_SHOT_LIMIT) { last.lastScene = index + 1; last.shots += count; }
    else sequences.push({firstScene: index + 1, lastScene: index + 1, shots: count});
  });
  return sequences;
}

/**
 * Why these boundaries are not a split of the feature, or null when they are: the sequences cover
 * every scene exactly once and in order (no gap, no overlap, nothing out of order), each holds at
 * least one scene, and each is at most 24 shots. `shots` is recomputed from the script, never read
 * from whoever proposed the boundaries.
 */
export function splitProblem(boundaries: readonly {firstScene: number; lastScene: number}[], counts: number[]): string | null {
  if (!counts.length) return "the script has no scenes";
  if (!boundaries.length) return "no sequences";
  if (boundaries.length > SEQUENCE_LIMIT) return "more than " + SEQUENCE_LIMIT + " sequences";
  let next = 1;
  for (const [index, sequence] of boundaries.entries()) {
    if (!positive(sequence.firstScene, counts.length) || !positive(sequence.lastScene, counts.length)) return "sequence " + (index + 1) + " names a scene the script doesn't have";
    if (sequence.lastScene < sequence.firstScene) return "sequence " + (index + 1) + " holds no scene";
    if (sequence.firstScene < next) return "sequence " + (index + 1) + " overlaps or goes back";
    if (sequence.firstScene > next) return "scene " + next + " is in no sequence";
    const shots = counts.slice(sequence.firstScene - 1, sequence.lastScene).reduce((sum, count) => sum + count, 0);
    if (shots > SEQUENCE_SHOT_LIMIT) return "sequence " + (index + 1) + " is " + shots + " shots, past " + SEQUENCE_SHOT_LIMIT;
    next = sequence.lastScene + 1;
  }
  return next === counts.length + 1 ? null : "scene " + next + " is in no sequence";
}

/** The sequences with their shots counted from the script; throws when the boundaries are not a split. */
export function countedSequences(boundaries: readonly {firstScene: number; lastScene: number}[], counts: number[]): FilmSequence[] {
  const problem = splitProblem(boundaries, counts);
  if (problem) throw new SequenceSplitError("Not a split of the feature: " + problem + ".");
  return boundaries.map(({firstScene, lastScene}) => ({firstScene, lastScene, shots: counts.slice(firstScene - 1, lastScene).reduce((sum, count) => sum + count, 0)}));
}

export function sequencePlan(scriptVersion: number, sequences: FilmSequence[]): SequencePlan {
  const body = {schema: "hv-sequence-plan/1" as const, scriptVersion, sequences: sequences.map(({firstScene, lastScene, shots}) => ({firstScene, lastScene, shots}))};
  return {...body, revision: contentHash(body)};
}

/** A stored plan's own shape: what a project load and a state snapshot accept. */
export function validateSequencePlan(value: unknown): SequencePlan {
  if (!exact(value, ["schema", "scriptVersion", "sequences", "revision"]) || value.schema !== "hv-sequence-plan/1" || !positive(value.scriptVersion, Number.MAX_SAFE_INTEGER)
    || !Array.isArray(value.sequences) || !value.sequences.length || value.sequences.length > SEQUENCE_LIMIT || !hash(value.revision))
    throw new Error("A project's sequence plan is not one the Showrunner made.");
  let next = 1;
  for (const sequence of value.sequences as unknown[]) {
    if (!exact(sequence, ["firstScene", "lastScene", "shots"]) || sequence.firstScene !== next || !positive(sequence.lastScene, 100_000)
      || (sequence.lastScene as number) < next || !positive(sequence.shots, SEQUENCE_SHOT_LIMIT)) throw new Error("A project's sequence plan is not one the Showrunner made.");
    next = (sequence.lastScene as number) + 1;
  }
  const plan = sequencePlan(value.scriptVersion as number, value.sequences as FilmSequence[]);
  if (plan.revision !== value.revision) throw new Error("A project's sequence plan changed after the Showrunner made it.");
  return plan;
}

/** Null when the plan still splits this script and direction exactly as it says; otherwise why not. */
export function stalePlanReason(plan: SequencePlan, scriptVersion: number, parsed: ParseResult, direction?: DirectionSnapshot): string | null {
  if (plan.scriptVersion !== scriptVersion) return "The screenplay changed after the Showrunner split the feature. Plan the film again.";
  const counts = sceneShotCounts(parsed, direction);
  let fresh: FilmSequence[];
  try { fresh = countedSequences(plan.sequences, counts); } catch { return "The feature's scenes or coverage changed, so its sequences no longer fit. Plan the film again."; }
  return fresh.every((sequence, index) => sequence.shots === plan.sequences[index]!.shots) ? null
    : "The feature's coverage changed, so its sequences no longer fit. Plan the film again.";
}

export function sequenceRef(plan: SequencePlan, number: number): SequenceRef {
  const sequence = plan.sequences[number - 1];
  if (!Number.isSafeInteger(number) || !sequence) throw new SequenceSplitError("This feature has sequences 1 to " + plan.sequences.length + ".");
  return {number, of: plan.sequences.length, firstScene: sequence.firstScene, lastScene: sequence.lastScene, planRevision: plan.revision};
}

export function validateSequenceRef(value: unknown): SequenceRef {
  if (!exact(value, ["number", "of", "firstScene", "lastScene", "planRevision"]) || !positive(value.of, SEQUENCE_LIMIT) || !positive(value.number, value.of as number)
    || !positive(value.firstScene, 100_000) || !positive(value.lastScene, 100_000) || (value.lastScene as number) < (value.firstScene as number) || !hash(value.planRevision))
    throw new Error("A render's sequence is not one of a Showrunner's plan.");
  return value as unknown as SequenceRef;
}

export const sameSequence = (a?: SequenceRef, b?: SequenceRef) => (!a && !b) || Boolean(a && b && contentHash(a) === contentHash(b));

/**
 * The plan a film render's directions are checked against: the feature's shots for a sequence render,
 * otherwise the render's own `sourcePlan`, exactly as before. Every film render's shots come from here
 * and `inSequence`, so a reel or a short is planned as it always was.
 */
export function filmPlan(parsed: ParseResult, direction: DirectionSnapshot | undefined, maxShots: number, sequence?: SequenceRef, review = false): Shot[] {
  return sequence ? featureShots(parsed, direction, review) : sourcePlan(parsed, direction, 7000, maxShots, review);
}

/** The shots one sequence renders: its own scenes' shots, in order. Without a sequence, every shot. */
export function inSequence<T extends {sceneIndex: number}>(shots: T[], sequence?: SequenceRef): T[] {
  return sequence ? shots.filter(shot => shot.sceneIndex + 1 >= sequence.firstScene && shot.sceneIndex + 1 <= sequence.lastScene) : shots;
}

/**
 * A job may carry a sequence only as a film's rough cut or final: never a take group, a character
 * sheet, a screenplay proposal, a current-film render or a selective re-render.
 */
export function validateSequenceJob(job: {sequence?: unknown; stage: string; shotTakes?: unknown; characterSheet?: unknown; livingScript?: unknown; currentFilm?: unknown; shotReuse?: unknown}): void {
  if (job.sequence === undefined) return;
  validateSequenceRef(job.sequence);
  if (!["animatic", "final"].includes(job.stage) || job.shotTakes || job.characterSheet || job.livingScript || job.currentFilm || job.shotReuse)
    throw new Error("Only a film's rough cut or final renders a feature's sequence.");
}
