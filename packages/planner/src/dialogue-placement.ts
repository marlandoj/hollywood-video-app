import {cueNames, type Scene} from "../../parser/src/index";
import {mentioned} from "./casting";
import type {Shot} from "./index";
import {lineSources} from "./performances";

/**
 * HV-030-43: in a feature, each speech goes on a shot near the action it follows, preferably one whose
 * action names its speaker, and that shot's prompt says who speaks on camera.
 *
 * The planner gives a scene one shot per action beat (grouped into 24 past 24 beats) and, as a short always
 * has, put the scene's whole dialogue on its first shot. Release 3's feature "The Tide Clock" was 202 shots:
 * 27 carried all 46 lines and 16 of those held two or three speakers, while their prompts said only the
 * scene's action ("coils a rope"). The final is silent picture with the approved voices laid under it, so
 * the reviewers saw "a voice over": nobody on screen was speaking.
 *
 * This is the Director's coverage rule for a feature (the stand-in crew's; no setting for the creator). It
 * never adds or removes a shot, so a feature's shot ids, seeds, shot counts and sequence plan are as they
 * were; only which shot carries which line, and those shots' prompts, change:
 *
 * - **Where a line goes.** The units placed are the scene's speeches, one a shot, while the scene has the
 *   shots; else each speaker's run of consecutive speeches, one a shot; and only when the scene has fewer
 *   shots than runs are runs shared, in balanced contiguous groups. Units go in screenplay order on distinct
 *   shots. Each unit's window runs from its anchor (the shot holding the action beat before it), moved later
 *   past the previous unit's shot and, when the scene has a shot to spare, past the scene's first (wide,
 *   establishing) shot, to the last shot that still leaves one shot for every later unit. When the anchor
 *   is beyond that last shot the unit goes on the last shot, which can be earlier than its anchor. In the
 *   window the unit takes the first shot whose action names its speaker (the cue name, or the cue name
 *   without a leading title such as DR.), and otherwise the window's first shot. A speech is never split.
 * - **What the shot says.** A shot with spoken lines opens its action with {@link speakingDirection}: who
 *   speaks on camera, face visible, mouth moving, framed for dialogue. A speech whose speaker is not seen
 *   (V.O., O.S., O.C.; a voice over a radio or phone, or through a door, whose speaker the scene's action
 *   never names: `Scene.offCameraDialogue`), or whose
 *   lines are all parentheticals, names nobody. Prompt fitting never cuts the sentence (prompt-fit.ts). A
 *   shot with no line is unchanged.
 * - **What it leaves alone.** A scene with accepted coverage (`sceneCuts`) keeps its cut's shots and lines
 *   exactly. A feature placed this way says so on its sequence plan and every render's sequence
 *   (`dialoguePlacement: "speaker"`, sequences.ts); a plan or render without it, made before this
 *   increment or for a project whose saved directions hold the old placement, plans every line on its
 *   scene's first shot as before.
 *
 * Deterministic: the same scene and shots always place the same way, so a rough cut and a final that read
 * the same sequence carry the same lines on the same shots, which the final's reuse of the rough cut's
 * voices needs.
 */

/** The value a sequence plan and its renders carry for this placement. Absent means every line on its scene's first shot. */
export type DialoguePlacement = "speaker";
export const DIALOGUE_PLACEMENTS: readonly DialoguePlacement[] = ["speaker"];
/** At most this many names in a speaking sentence; past it, "and others" (a scene may have any number of speakers). */
export const SPEAKING_NAMES_SHOWN = 3;

/** The names a shot's action may call a speaker by: the cue's name, and that name without a leading title (the parser's `cueNames`). */
export const speakerNames = cueNames;

/**
 * The sentence a shot's prompt opens its action with when it carries spoken dialogue, or "" when no one on
 * camera speaks. `offCamera[i]` marks `dialogue[i]` as a voice not on screen. Names are compared without
 * case, as casting compares them, and the first spelling is shown; past three, "and others".
 */
export function speakingDirection(dialogue: Shot["dialogue"], offCamera: readonly boolean[] = []): string {
  const shown = onCameraSpeakers(dialogue, offCamera);
  if (!shown.length) return "";
  if (shown.length === 1) return shown[0] + " speaks on camera: face visible, mouth moving, framed for dialogue.";
  const listed = shown.length > SPEAKING_NAMES_SHOWN ? shown.slice(0, SPEAKING_NAMES_SHOWN).join(", ") + " and others"
    : shown.slice(0, -1).join(", ") + " and " + shown.at(-1);
  return listed + " speak on camera: faces visible, mouths moving, framed for dialogue.";
}

/**
 * Who `speakingDirection` says speaks on camera in `dialogue`, in order, each name once (compared without
 * case, first spelling kept), before the three-name cap. HV-022-23: the studio's lip-sync work list reads
 * it to tell whether a line's speaker is someone the shot was asked to show speaking.
 */
export function onCameraSpeakers(dialogue: Shot["dialogue"], offCamera: readonly boolean[] = []): string[] {
  const names = new Map<string, string>();
  dialogue.forEach((block, index) => {
    const name = block.character.trim();
    if (!name || offCamera[index] || !lineSources([block]).length) return;
    const key = name.toLocaleUpperCase("en-US");
    if (!names.has(key)) names.set(key, name);
  });
  return [...names.values()];
}

/**
 * Every speaking sentence `placeSceneDialogue` could have given a shot carrying `dialogue` in `scene`: one
 * for each place the blocks sit, in order and together, among the scene's speeches (they differ only when
 * the scene flags some speeches off camera). prompt-fit.ts protects whichever one the prompt opens with.
 */
export function speakingDirections(scene: Scene | undefined, dialogue: Shot["dialogue"]): string[] {
  const flags = scene?.offCameraDialogue;
  if (!scene || !flags) return [speakingDirection(dialogue)];
  const same = (a: Shot["dialogue"][number], b: Shot["dialogue"][number] | undefined) => Boolean(b) && JSON.stringify(a) === JSON.stringify(b);
  const found = new Set<string>();
  for (let at = 0; at + dialogue.length <= scene.dialogue.length; at++)
    if (dialogue.every((block, index) => same(block, scene.dialogue[at + index]))) found.add(speakingDirection(dialogue, flags.slice(at, at + dialogue.length)));
  return [...found];
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
  // Which shot holds each action beat, and so which shot each speech follows in the screenplay; and each shot's action.
  const sizes = groupSizes(beats, count), actionShot = sizes.flatMap((size, shot) => Array<number>(size).fill(shot));
  let cursor = 0;
  const actions = sizes.map(size => scene.action.slice(cursor, cursor += size).join("\n"));
  const offCamera = (block: number) => scene.offCameraDialogue?.[block] === true;
  const anchors: number[] = [];
  if (scene.beats?.filter(beat => beat.kind === "dialogue").length === blocks.length) {
    let seen = 0;
    for (const beat of scene.beats) {
      if (beat.kind === "action") seen += 1;
      else if (beat.kind === "dialogue") anchors.push(seen ? actionShot[Math.min(seen, beats) - 1]! : 0);
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
    // In order, on distinct shots, within the window that leaves a shot for every later unit.
    const low = units.length < count ? 1 : 0;
    let previous = -1;
    units.forEach((unit, index) => {
      const from = Math.max(unit.anchor, low, previous + 1), last = count - units.length + index;
      let shot = Math.min(from, last);
      // The first shot in the window whose action names the speaker, when the unit has someone on camera to name.
      if (!unit.blocks.every(offCamera)) {
        const names = speakerNames(scene.dialogue[unit.blocks[0]!]!.character);
        for (let at = from; at <= last; at++) if (names.some(name => mentioned(name, actions[at]!))) { shot = at; break; }
      }
      placed[shot]!.push(...unit.blocks);
      previous = shot;
    });
  } else balanced(runs, count).forEach((group, shot) => placed[shot]!.push(...group.flatMap(unit => unit.blocks)));
  return shots.map((shot, index) => {
    const dialogue = placed[index]!.map(block => structuredClone(scene.dialogue[block]!));
    const speaking = speakingDirection(dialogue, placed[index]!.map(offCamera)), prefix = scene.heading + ". ";
    if (!speaking || !shot.prompt.startsWith(prefix)) return {...shot, dialogue};
    return {...shot, dialogue, prompt: prefix + speaking + " " + shot.prompt.slice(prefix.length)};
  });
}
