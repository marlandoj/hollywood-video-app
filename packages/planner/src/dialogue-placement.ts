import {contentHash} from "../../generator/src/capabilities";
import type {Scene} from "../../parser/src/index";
import {directionSource,type DirectionSnapshot} from "./direction";
import type {Shot} from "./index";

/**
 * HV-030-43: in a feature, each line of dialogue is on a shot of the character who speaks it.
 *
 * The planner gives a scene one shot per action beat and, as a short always has, put the scene's whole
 * dialogue on its first shot. Release 3's feature "The Tide Clock" was 202 shots: 27 carried all 46 lines
 * and 16 of those held two or three speakers, while their prompts said only the scene's action ("coils a
 * rope"). The final is silent picture with the approved voices laid under it, so the reviewers saw
 * "a voice over": nobody on screen was speaking.
 *
 * This is the Director's coverage rule for a feature (the stand-in crew's; no setting for the creator).
 * It never adds or removes a shot, so a feature's shot ids, seeds, shot counts and sequence plan are as
 * they were; only which shot carries which line, and those shots' prompts, change:
 *
 * - **Where a line goes.** Each speech stays beside the action it follows in the screenplay: on the shot
 *   that holds the action beat before it, or later when that shot already carries a speech. Speeches are
 *   placed in order on distinct shots, one speech a shot, while the scene has the shots; then one
 *   speaker's consecutive speeches a shot; only when the scene has fewer shots than changes of speaker do
 *   two speakers share a shot. When there are shots to spare, the scene's first shot (the crew's wide
 *   establishing shot) keeps no line, so each speech lands on a shot the crew frames as a close-up.
 * - **What the shot says.** A shot with lines opens its action with {@link speakingDirection}: who speaks on
 *   camera, face visible, mouth moving, framed for dialogue. Prompt fitting never cuts it
 *   (prompt-fit.ts). A shot with no lines is unchanged.
 * - **What it leaves alone.** A scene with accepted coverage (`sceneCuts`) keeps its cut's shots and lines
 *   exactly: the creator's coverage wins. A scene whose saved shot directions were made against the old
 *   placement keeps the old placement (see {@link placedDialogueScene}), so a project planned before this
 *   renders exactly as it did. A speech is never split across shots.
 *
 * Deterministic: the same scene and shots always place the same way, so a sequence's rough cut and its
 * final carry the same lines on the same shots, which the final's reuse of the rough cut's voices needs.
 */

/** The line a shot's prompt opens its action with when it carries dialogue, or "" when it carries none. */
export function speakingDirection(dialogue: Shot["dialogue"]): string {
  const names = [...new Set(dialogue.filter(block => block.lines.some(line => line.trim())).map(block => block.character.trim()).filter(Boolean))];
  if (!names.length) return "";
  if (names.length === 1) return names[0] + " speaks on camera: face visible, mouth moving, framed for dialogue.";
  return names.slice(0, -1).join(", ") + " and " + names.at(-1) + " speak on camera: faces visible, mouths moving, framed for dialogue.";
}

/** How many of the scene's action beats each of `groups` shots holds, as `planShots` groups them. */
function groupSizes(beats: number, groups: number): number[] {
  const size = Math.floor(beats / groups), larger = beats % groups;
  return Array.from({length: groups}, (_, index) => size + (index < larger ? 1 : 0));
}

/** Contiguous, balanced groups of `items` into `count` groups, in order. */
function balanced<T>(items: T[], count: number): T[][] {
  let cursor = 0;
  return groupSizes(items.length, count).map(length => items.slice(cursor, cursor += length));
}

/**
 * The scene's planned shots with its dialogue placed by the rule above. `shots` are the scene's own shots
 * as `planShots` made them (every line on the first): anything else is returned as it is.
 */
export function placeSceneDialogue(scene: Scene, shots: Shot[]): Shot[] {
  const count = shots.length, beats = scene.action.length || 1;
  const blocks = scene.dialogue.map((block, index) => ({block, index}));
  if (!count || !blocks.length || count > beats || shots.some((shot, index) => shot.sceneIndex !== scene.index || (index > 0 && shot.dialogue.length))
    || JSON.stringify(shots[0]!.dialogue) !== JSON.stringify(scene.dialogue)) return shots;
  // Which shot holds each action beat, and so which shot each speech follows in the screenplay.
  const actionShot = groupSizes(beats, count).flatMap((size, shot) => Array<number>(size).fill(shot));
  const anchors: number[] = [];
  if (scene.beats?.filter(beat => beat.kind === "dialogue").length === blocks.length) {
    let actions = 0;
    for (const beat of scene.beats) {
      if (beat.kind === "action") actions += 1;
      else if (beat.kind === "dialogue") anchors.push(actions ? actionShot[Math.min(actions, beats) - 1]! : 0);
    }
  } else blocks.forEach(() => anchors.push(0));
  // The units placed on shots: each speech, else each speaker's run of consecutive speeches.
  type Unit = {blocks: number[]; anchor: number};
  const speeches: Unit[] = blocks.map(({index}) => ({blocks: [index], anchor: anchors[index]!}));
  const runs: Unit[] = [];
  for (const unit of speeches) {
    const last = runs.at(-1);
    if (last && scene.dialogue[last.blocks.at(-1)!]!.character === scene.dialogue[unit.blocks[0]!]!.character) last.blocks.push(...unit.blocks);
    else runs.push({...unit, blocks: [...unit.blocks]});
  }
  const placed: number[][] = Array.from({length: count}, () => []);
  const units = speeches.length <= count ? speeches : runs.length <= count ? runs : null;
  if (units) {
    // In order, on distinct shots, as near the action each follows as the shots allow.
    const low = units.length < count ? 1 : 0;
    let previous = -1;
    units.forEach((unit, index) => {
      const shot = Math.min(Math.max(unit.anchor, low, previous + 1), count - units.length + index);
      placed[shot]!.push(...unit.blocks);
      previous = shot;
    });
  } else balanced(runs, count).forEach((group, shot) => placed[shot]!.push(...group.flatMap(unit => unit.blocks)));
  return shots.map((shot, index) => {
    const dialogue = placed[index]!.map(block => structuredClone(scene.dialogue[block]!));
    const speaking = speakingDirection(dialogue), prefix = scene.heading + ". ";
    if (!speaking || !shot.prompt.startsWith(prefix)) return {...shot, dialogue};
    return {...shot, dialogue, prompt: prefix + speaking + " " + shot.prompt.slice(prefix.length)};
  });
}

/**
 * The scene's shots with its dialogue placed, unless a saved shot direction holds the scene to the old
 * placement: an entry whose source is one of the scene's shots as planned before HV-030-43 and not as
 * placed now. Then the scene is planned exactly as before, so its saved directions, its approved rough cut
 * and its final still agree. A creator who wants the new placement removes those directions.
 */
export function placedDialogueScene(scene: Scene, shots: Shot[], direction?: DirectionSnapshot): Shot[] {
  const placed = placeSceneDialogue(scene, shots);
  if (placed === shots || !direction?.entries.length) return placed;
  const legacy = shots.some((shot, index) => {
    const entry = direction.entries.find(value => value.source.id === shot.id);
    if (!entry) return false;
    const before = contentHash(directionSource(shot)), after = contentHash(directionSource(placed[index]!));
    return before !== after && entry.sourceHash === before;
  });
  return legacy ? shots : placed;
}
