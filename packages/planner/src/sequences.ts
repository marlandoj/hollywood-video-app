import {contentHash} from "../../generator/src/capabilities";
import type {ParseResult} from "../../parser/src/index";
import {staleDirections,type DirectionSnapshot} from "./direction";
import {DIALOGUE_PLACEMENTS,placeSceneDialogue,type DialoguePlacement} from "./dialogue-placement";
import type {Shot} from "./index";
import {SceneCutConflict,sourcePlan,staleSceneCuts,validateSceneCuts} from "./scene-cuts";
import {validateStyleBibleJob} from "./style-bible";

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
 * HV-030-43: a feature whose plan says `dialoguePlacement: "speaker"` spreads each scene's lines over its
 * shots and says in each such shot's prompt who speaks on camera (dialogue-placement.ts). The plan step
 * stamps that on every plan it makes, unless the project's saved directions hold the old placement
 * (`nextDialoguePlacement`); every render's sequence carries it from the plan. A plan or a sequence without
 * it (any made before HV-030-43) keeps every line on its scene's first shot, so its rough cuts and finals
 * plan exactly as they did. A short still carries a scene's lines on its first shot.
 *
 * Scene numbers here are one-based, as the desk and the continuity report number scenes.
 */
export const SEQUENCE_SHOT_LIMIT = 24;
/** At most this many sequences in a plan: far past a 20-minute feature (about ten), and a bound for stored state. */
export const SEQUENCE_LIMIT = 100;
export interface FilmSequence { firstScene: number; lastScene: number; shots: number }
/** HV-030-43: `dialoguePlacement` is absent on a plan made before the speaker placement, which keeps the old one. */
export interface SequencePlan { schema: "hv-sequence-plan/1"; scriptVersion: number; sequences: FilmSequence[]; dialoguePlacement?: DialoguePlacement; revision: string }
/**
 * What a render job carries: which sequence of which plan it renders. HV-034-02: and, for a feature
 * with a style bible, which revision of the bible its renders read. Absent for a feature planned
 * before the bible existed, which renders as it did. HV-030-43: and its plan's dialogue placement,
 * absent (every line on its scene's first shot) for a plan without one.
 */
export interface SequenceRef { number: number; of: number; firstScene: number; lastScene: number; planRevision: string; bibleRevision?: string; dialoguePlacement?: DialoguePlacement }
export class SequenceSplitError extends Error { override name = "SequenceSplitError"; }

const positive = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value as object).sort().join(",") === [...keys].sort().join(",");

const placement = (value: unknown): value is DialoguePlacement => DIALOGUE_PLACEMENTS.includes(value as DialoguePlacement);

/**
 * The feature's shots, scene by scene, independent of how it is split (see above). A stale accepted
 * cut is refused as `sourcePlan` refuses it, unless `review` is set (then it is left out, as there).
 * HV-030-43: with `dialoguePlacement` "speaker", each scene without accepted coverage has its lines
 * placed (dialogue-placement.ts); without it, every line is on its scene's first shot, as before.
 */
export function featureShots(parsed: ParseResult, direction?: DirectionSnapshot, review = false, dialoguePlacement?: DialoguePlacement): Shot[] {
  const cuts = validateSceneCuts(direction?.sceneCuts ?? []), stale = staleSceneCuts(parsed, direction);
  if (stale.length && !review) throw new SceneCutConflict("Scene " + (stale[0]!.source.sceneIndex + 1) + " changed. Review, replace or remove its accepted coverage before rendering.");
  const shots: Shot[] = [];
  for (const scene of parsed.scenes) {
    const own = cuts.filter(cut => cut.source.sceneIndex === scene.index);
    // One scene in a 24-shot render, at the seed the uncapped plan would give its first shot.
    const planned = sourcePlan({...parsed, scenes: [scene]}, direction ? {...direction, sceneCuts: own} : undefined, 7000 + shots.length, SEQUENCE_SHOT_LIMIT, true);
    // HV-030-43: the lines placed when the plan says so, unless the creator's accepted coverage places them.
    const accepted = own.some(cut => !stale.some(value => value.revision === cut.revision));
    shots.push(...(accepted || dialoguePlacement !== "speaker" ? planned : placeSceneDialogue(scene, planned)));
  }
  return shots;
}

/**
 * HV-030-43: the dialogue placement the plan step gives a feature it plans now: "speaker", unless that would
 * make a saved shot direction stale that is current under the old placement (a project whose directions
 * were saved against every line on its scene's first shot, by the crew or the creator). Then none, and the
 * feature keeps the old placement until those directions are removed. Decided once, at the plan step, and
 * kept on the plan, so nothing after it infers a placement from saved hashes.
 */
export function nextDialoguePlacement(parsed: ParseResult, direction?: DirectionSnapshot): DialoguePlacement | undefined {
  if (!direction?.entries.length) return "speaker";
  const stale = (value?: DialoguePlacement) => new Set(staleDirections(featureShots(parsed, direction, true, value), direction).map(entry => entry.source.id));
  const before = stale(), after = stale("speaker");
  return [...after].every(id => before.has(id)) ? "speaker" : undefined;
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

/** HV-030-43: `dialoguePlacement` is kept, and hashed into the revision, only when given; a plan without it hashes as before. */
export function sequencePlan(scriptVersion: number, sequences: FilmSequence[], dialoguePlacement?: DialoguePlacement): SequencePlan {
  const body = {schema: "hv-sequence-plan/1" as const, scriptVersion, sequences: sequences.map(({firstScene, lastScene, shots}) => ({firstScene, lastScene, shots})),
    ...(dialoguePlacement === undefined ? {} : {dialoguePlacement})};
  return {...body, revision: contentHash(body)};
}

/** A stored plan's own shape: what a project load and a state snapshot accept. */
export function validateSequencePlan(value: unknown): SequencePlan {
  const placed = Boolean(value) && typeof value === "object" && Object.hasOwn(value as object, "dialoguePlacement");
  if (!exact(value, ["schema", "scriptVersion", "sequences", "revision", ...(placed ? ["dialoguePlacement"] : [])]) || value.schema !== "hv-sequence-plan/1"
    || (placed && !placement(value.dialoguePlacement)) || !positive(value.scriptVersion, Number.MAX_SAFE_INTEGER)
    || !Array.isArray(value.sequences) || !value.sequences.length || value.sequences.length > SEQUENCE_LIMIT || !hash(value.revision))
    throw new Error("A project's sequence plan is not one the Showrunner made.");
  let next = 1;
  for (const sequence of value.sequences as unknown[]) {
    if (!exact(sequence, ["firstScene", "lastScene", "shots"]) || sequence.firstScene !== next || !positive(sequence.lastScene, 100_000)
      || (sequence.lastScene as number) < next || !positive(sequence.shots, SEQUENCE_SHOT_LIMIT)) throw new Error("A project's sequence plan is not one the Showrunner made.");
    next = (sequence.lastScene as number) + 1;
  }
  const plan = sequencePlan(value.scriptVersion as number, value.sequences as FilmSequence[], placed ? value.dialoguePlacement as DialoguePlacement : undefined);
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

export function sequenceRef(plan: SequencePlan, number: number, bibleRevision?: string): SequenceRef {
  const sequence = plan.sequences[number - 1];
  if (!Number.isSafeInteger(number) || !sequence) throw new SequenceSplitError("This feature has sequences 1 to " + plan.sequences.length + ".");
  return {number, of: plan.sequences.length, firstScene: sequence.firstScene, lastScene: sequence.lastScene, planRevision: plan.revision,
    ...(bibleRevision === undefined ? {} : {bibleRevision}), ...(plan.dialoguePlacement === undefined ? {} : {dialoguePlacement: plan.dialoguePlacement})};
}

const REF_KEYS = ["number", "of", "firstScene", "lastScene", "planRevision"];
export function validateSequenceRef(value: unknown): SequenceRef {
  const has = (key: string) => Boolean(value) && typeof value === "object" && Object.hasOwn(value as object, key);
  const withBible = has("bibleRevision"), placed = has("dialoguePlacement");
  if (!exact(value, [...REF_KEYS, ...(withBible ? ["bibleRevision"] : []), ...(placed ? ["dialoguePlacement"] : [])]) || !positive(value.of, SEQUENCE_LIMIT) || !positive(value.number, value.of as number)
    || !positive(value.firstScene, 100_000) || !positive(value.lastScene, 100_000) || (value.lastScene as number) < (value.firstScene as number) || !hash(value.planRevision)
    || (withBible && !hash(value.bibleRevision)) || (placed && !placement(value.dialoguePlacement)))
    throw new Error("A render's sequence is not one of a Showrunner's plan.");
  return value as unknown as SequenceRef;
}

export const sameSequence = (a?: SequenceRef, b?: SequenceRef) => (!a && !b) || Boolean(a && b && contentHash(a) === contentHash(b));

/**
 * The plan a film render's directions are checked against: the feature's shots for a sequence render,
 * otherwise the render's own `sourcePlan`, exactly as before. Every film render's shots come from here
 * and `inSequence`, so a reel or a short is planned as it always was. HV-030-43: a sequence's shots are
 * placed as its own `dialoguePlacement` says, so a rough cut and the final made from it agree.
 */
export function filmPlan(parsed: ParseResult, direction: DirectionSnapshot | undefined, maxShots: number, sequence?: SequenceRef, review = false): Shot[] {
  return sequence ? featureShots(parsed, direction, review, sequence.dialoguePlacement) : sourcePlan(parsed, direction, 7000, maxShots, review);
}

/**
 * HV-030-43: which shot plan a project's Director's desk, takes and movement plans read, so they direct the
 * shots its renders make: "feature" for a feature (its `featureShots`, every line on its scene's first
 * shot), "feature-speaker" for a feature whose plan places its lines, and none for a reel or a short
 * (one render's `sourcePlan`, as before). A take group keeps the kind it was made from (takes.ts).
 */
export type ShotPlanKind = "feature" | "feature-speaker";
export const SHOT_PLAN_KINDS: readonly ShotPlanKind[] = ["feature", "feature-speaker"];
export function projectShotPlan(project: {format?: string; sequences?: SequencePlan}): ShotPlanKind | undefined {
  if (project.format !== "feature") return undefined;
  return project.sequences?.dialoguePlacement === "speaker" ? "feature-speaker" : "feature";
}
/** The shots a project's desk reads (see above): `sourcePlan` at `maxShots` without a kind, the feature's own shots with one. */
export function projectShots(parsed: ParseResult, direction: DirectionSnapshot | undefined, maxShots: number, kind?: ShotPlanKind, review = false): Shot[] {
  return kind ? featureShots(parsed, direction, review, kind === "feature-speaker" ? "speaker" : undefined) : sourcePlan(parsed, direction, 7000, maxShots, review);
}

/** The shots one sequence renders: its own scenes' shots, in order. Without a sequence, every shot. */
export function inSequence<T extends {sceneIndex: number}>(shots: T[], sequence?: SequenceRef): T[] {
  return sequence ? shots.filter(shot => shot.sceneIndex + 1 >= sequence.firstScene && shot.sceneIndex + 1 <= sequence.lastScene) : shots;
}

/**
 * A job may carry a sequence only as a film's rough cut or final: never a take group, a character
 * sheet, a screenplay proposal, a current-film render or a selective re-render. HV-030-37: a sequence's
 * final may reuse the shots it already rendered, but never chooses shots to render fresh.
 */
export function validateSequenceJob(job: {sequence?: unknown; styleBible?: unknown; stage: string; shotTakes?: unknown; characterSheet?: unknown; livingScript?: unknown; currentFilm?: unknown; shotReuse?: unknown}): void {
  // HV-034-02: a style bible rides only on a sequence render that names its revision.
  if (job.sequence === undefined) { if (job.styleBible !== undefined) throw new Error("Only a feature's sequence render reads a style bible."); return; }
  validateStyleBibleJob({styleBible: job.styleBible, sequence: validateSequenceRef(job.sequence)});
  const reuse = job.shotReuse as {forceShotIds?: unknown[]} | undefined;
  if (!["animatic", "final"].includes(job.stage) || job.shotTakes || job.characterSheet || job.livingScript || job.currentFilm
    || (reuse !== undefined && (job.stage !== "final" || !Array.isArray(reuse?.forceShotIds) || reuse.forceShotIds.length > 0)))
    throw new Error("Only a film's rough cut or final renders a feature's sequence.");
}

/**
 * HV-021-11: the shots the continuity report reads, and the sequence plan it covers the boundaries of.
 *
 * A feature's shots are its own (`featureShots`), the ones the crew directs at the plan step, so the
 * desk's report, its repair and the Supervisor's notes all read the same shots for a feature; a reel
 * or a short is planned at the desk's tier, exactly as before. The plan is passed only while it still
 * splits this screenplay and direction: a stale plan's boundaries are not the film's.
 */
export function continuityShotPlan(parsed: ParseResult, direction: DirectionSnapshot, project: {format?: string; sequences?: SequencePlan; scriptVersion: number}, maxShots: number): {shots: Shot[]; sequences?: SequencePlan} {
  if (project.format !== "feature") return {shots: sourcePlan(parsed, direction, 7000, maxShots, true)};
  const shots = featureShots(parsed, direction, true, project.sequences?.dialoguePlacement);
  return project.sequences && !stalePlanReason(project.sequences, project.scriptVersion, parsed, direction) ? {shots, sequences: project.sequences} : {shots};
}
