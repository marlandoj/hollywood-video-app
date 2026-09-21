import { describe, expect, test } from "bun:test";
import { falVideoCapability } from "../../generator/src/fal";
import { mockVideoCapability } from "../../generator/src/index";
import { parseFountain } from "../../parser/src/index";
import { checkPrompt } from "../../safety/src/index";
import { castingSnapshot, characterRecord, describeCharacter } from "../src/casting";
import { introductionAppearance, scriptIntroductions, UNSTATED_AGE } from "../src/crew/introductions";
import { billedShotTiming, crewChanges, dialogueSeconds, standInCast, standInPlan } from "../src/crew/production-plan";
import { readThroughFacts } from "../src/crew/read-through";
import { directionSnapshot } from "../src/direction";
import { sourcePlan } from "../src/scene-cuts";

// HV-017-05: the live reel of 2026-09-19 drew NORA as a bearded man, because the stand-in cast
// every character as "As the script describes NORA." with age "adult".
const LIGHTHOUSE = "INT. LIGHTHOUSE - NIGHT\n\nWind rattles the glass. NORA, the old keeper, trims the wick by lamplight.\n\nNORA\nOne more night, old friend.\n\n"
  + "EXT. CLIFF PATH - DAWN\n\nHer grandson TEO climbs toward the light with a thermos.\n\nTEO\nGrandma! You kept it burning!\n\nNORA\nAlways.";
/** One line no clip Kling bills is long enough to hold: the engine speaks it in about eleven seconds. */
const OVERLONG = "Listen to me. The harbour master signed the order at noon, and by the time the tide turns there will be "
  + "nothing left of this place but the rocks and the gulls and whatever we manage to carry down the path.";
/** Shorter: past the ten seconds Kling's turbo model bills, inside the fifteen its keyframe model does. */
const LONG = "The harbour master signed the order at noon, and by the time the tide turns there will be nothing left "
  + "of this place but the rocks and the gulls.";
const intro = (script: string, names: string[]) => scriptIntroductions(parseFountain(script), names);
const now = Date.parse("2026-09-19T23:40:00.000Z");

describe("casting from the script's own introductions", () => {
  test("the lighthouse: NORA is an older woman, TEO a male character of unstated age", () => {
    const [nora, teo] = intro(LIGHTHOUSE, ["NORA", "TEO"]);
    expect(nora).toMatchObject({sentence: "NORA, the old keeper, trims the wick by lamplight.", sex: "female", age: "older adult", addressedAs: "Grandma", addressedBy: "TEO"});
    expect(introductionAppearance(nora!).full).toBe("An older woman. As the script introduces her: “NORA, the old keeper, trims the wick by lamplight.” TEO calls her Grandma.");
    expect(introductionAppearance(nora!).ageRange).toBe("older adult");
    // "Her" before TEO is NORA's, not his; "grandson" says male and nothing about age.
    expect(teo).toMatchObject({sex: "male", age: null, addressedAs: null});
    expect(introductionAppearance(teo!)).toMatchObject({lead: "A male character.", ageRange: UNSTATED_AGE});
  });

  test("cues are read only beside the name, and conflicts leave the attribute unknown", () => {
    expect(intro("INT. ROOM - DAY\n\nA young woman, SAM, waits. The old man sleeps.", ["SAM"])[0]).toMatchObject({sex: "female", age: "young adult"});
    expect(intro("INT. ROOM - DAY\n\nThe girl's father, ALEX, the old man, waits.", ["ALEX"])[0]).toMatchObject({sex: "male", age: "older adult"});
    expect(intro("INT. ROOM - DAY\n\nThe woman and man KIM waits.", ["KIM"])[0]).toMatchObject({sex: null});
    expect(intro("INT. ROOM - DAY\n\nJO checks her phone.", ["JO"])[0]).toMatchObject({sex: "female", age: null});
    // A pronoun in a sentence that names another character could be theirs.
    expect(intro("INT. ROOM - DAY\n\nJO hands PAT her phone.", ["JO", "PAT"])[0]).toMatchObject({sex: null});
    expect(intro("INT. ROOM - DAY\n\nRiver flows past.\n\nRIVER\nHello.", ["RIVER"])[0]!.sentence).toBe("River flows past.");
    // The screenplay's capitals win over a capitalised word that only looks like the name.
    expect(intro("INT. ROOM - DAY\n\nMay I come in, asks the stranger. MAY, a young woman, smiles.\n\nMAY\nHello.", ["MAY"])[0])
      .toMatchObject({sentence: "MAY, a young woman, smiles.", sex: "female", age: "young adult"});
  });

  test("'an older woman' is older; 'a middle-aged man' is a man of unstated age (HV-017-08)", () => {
    expect(intro("EXT. STOP - NIGHT\n\nRUTH, an older woman in a yellow raincoat, waits.", ["RUTH"])[0]).toMatchObject({sex: "female", age: "older adult"});
    expect(intro("EXT. PIER - DAY\n\nA fisherman, TOMAS, a middle-aged man in a blue cap, lifts a net.", ["TOMAS"])[0]).toMatchObject({sex: "male", age: null});
    expect(intro("EXT. PIER - DAY\n\nTOMAS, an aged sailor, lifts a net.", ["TOMAS"])[0]).toMatchObject({age: "older adult"});
  });

  test("a kinship word counts only when exactly two characters speak in the scene", () => {
    const three = "INT. ROOM - DAY\n\nAVA, BEN and CY sit.\n\nBEN\nGrandma, sit down.\n\nAVA\nNo.\n\nCY\nYes.";
    expect(intro(three, ["AVA"])[0]).toMatchObject({addressedAs: null, sex: null});
  });

  test("the stand-in's cast passes the validators, reaches the prompt, and falls back when the gate would refuse it", () => {
    const parsed = parseFountain(LIGHTHOUSE);
    const plan = standInPlan(parsed, readThroughFacts(LIGHTHOUSE, parsed, {format: "reel", tone: ""}), sourcePlan(parsed, undefined, 7000, 24));
    const nora = plan.cast.find(entry => entry.name === "NORA")!;
    expect(nora.appearance.startsWith("An older woman.")).toBe(true);
    const changes = crewChanges(plan, castingSnapshot("p1", 0, [], now), directionSnapshot("p1", 0, [], now), () => crypto.randomUUID(), now);
    const record = characterRecord(changes.characters[0]!.input, changes.characters[0]!.id, now);
    expect(describeCharacter(record, 1)).toContain("Appearance: An older woman.");
    expect(describeCharacter(record, 1)).toContain("Age range: older adult.");
    expect(checkPrompt(describeCharacter(record, 1)).allowed).toBe(true);
    // A public figure in the introducing sentence is never quoted into the cast.
    const famous = "INT. ROOM - DAY\n\nThe old woman, IDA, reads a book about Taylor Swift.\n\nIDA\nHm.";
    expect(standInCast(parseFountain(famous), ["IDA"])[0]).toMatchObject({appearance: "An older woman.", ageRange: "older adult"});
  });

  test("the stand-in never becomes what makes a script refused", () => {
    // The script alone passes; the cast's "child" beside it would trip the minor-content rule, so the stand-in states neither look nor age.
    const script = "INT. ROOM - DAY\n\nThe little girl, EVE, reads an explicit warning label.\n\nEVE\nHm.";
    expect(checkPrompt(parseFountain(script).scenes.flatMap(scene => scene.action).join(" ")).allowed).toBe(true);
    const [eve] = standInCast(parseFountain(script), ["EVE"]);
    expect(eve!.appearance).toBe("As the script describes EVE.");
    expect(eve!.ageRange).toBe(UNSTATED_AGE);
  });
});

describe("pacing shots to what the provider bills", () => {
  const parsed = parseFountain(LIGHTHOUSE), shots = sourcePlan(parsed, undefined, 7000, 24);
  const plan = standInPlan(parsed, readThroughFacts(LIGHTHOUSE, parsed, {format: "reel", tone: ""}), shots);
  const paced = (timing: ReturnType<typeof billedShotTiming>) => crewChanges(plan, castingSnapshot("p1", 0, [], now), directionSnapshot("p1", 0, [], now), () => crypto.randomUUID(), now, {timing, shots});

  test("the billed floor comes from paid pools only", () => {
    expect(billedShotTiming([{snapshot: falVideoCapability("kling-v2.5-turbo-pro")}])).toEqual({floorSec: 5, stepsSec: [5, 10]});
    expect(billedShotTiming([{snapshot: falVideoCapability("kling-o3-standard-keyframes")}])!.floorSec).toBe(3);
    expect(billedShotTiming([{snapshot: mockVideoCapability()}])).toBeNull();
  });

  test("Kling shots are held to 5 s, long lines to 10 s, and free pools keep today's timing", () => {
    const kling = paced(billedShotTiming([{snapshot: falVideoCapability("kling-v2.5-turbo-pro")}]));
    expect(kling.directions.map(entry => (entry.input as {durationFrames: number}).durationFrames)).toEqual(shots.map(() => 150));
    expect(kling.notes.some(note => note.persona === "editor" && note.change.includes("5 s"))).toBe(true);
    const long = [{character: "NORA", lines: ["I kept this light burning through forty winters and I will keep it burning through forty more, whatever the sea says."]}];
    expect(dialogueSeconds(long)).toBeGreaterThan(5);
    expect(dialogueSeconds([])).toBe(0);
    const talky = crewChanges(plan, castingSnapshot("p1", 0, [], now), directionSnapshot("p1", 0, [], now), () => crypto.randomUUID(), now,
      {timing: {floorSec: 5, stepsSec: [5, 10]}, shots: shots.map((shot, index) => index === 0 ? {...shot, dialogue: long} : shot)});
    expect((talky.directions[0]!.input as {durationFrames: number}).durationFrames).toBe(300);
    expect(paced(null).directions.every(entry => (entry.input as {durationFrames: number | null}).durationFrames === null)).toBe(true);
  });

  // HV-030-05: the live reel of 2026-09-21 cancelled a rough cut with "Temporary dialogue exceeds
  // the selected shot duration" on a shot the creator had never touched. The crew had pinned it to
  // the longest clip Kling bills because no clip was long enough, and the pin then became an exact
  // duration the speech could not fit — a refusal telling the creator to lengthen a shot the studio
  // had chosen for them, in a flow that offers no way to change it.
  const speech = (line: string) => ({...shots[0]!, dialogue: [{character: "NORA", lines: [line]}]});
  test("a shot no billed clip can hold is left automatic, and the Editor says why", () => {
    const changes = crewChanges(plan, castingSnapshot("p1", 0, [], now), directionSnapshot("p1", 0, [], now), () => crypto.randomUUID(), now,
      {timing: {floorSec: 5, stepsSec: [5, 10]}, shots: shots.map((shot, index) => index === 0 ? speech(OVERLONG) : shot)});
    expect(dialogueSeconds([{character: "NORA", lines: [OVERLONG]}])).toBeGreaterThan(10);
    expect((changes.directions[0]!.input as {durationFrames: number | null}).durationFrames).toBeNull();
    // Every other shot keeps its billed pin; only the one that cannot fit is left alone.
    expect(changes.directions.slice(1).every(entry => (entry.input as {durationFrames: number | null}).durationFrames === 150)).toBe(true);
    const note = changes.notes.find(value => value.change.includes("automatic duration"));
    expect(note?.persona).toBe("editor");
    expect(note?.change).toContain(shots[0]!.id);
    expect(note?.change).toContain("Split it into coverage");
  });

  test("a longer ladder holds the same shot, and the creator's own cut duration is still never touched", () => {
    const long = shots.map((shot, index) => index === 0 ? speech(LONG) : shot);
    // Ten seconds does not hold this line; the keyframe model bills every second up to fifteen, and
    // the crew takes the shortest of those that does — eleven, not the longest on the ladder.
    expect((crewChanges(plan, castingSnapshot("p1", 0, [], now), directionSnapshot("p1", 0, [], now), () => crypto.randomUUID(), now,
      {timing: {floorSec: 5, stepsSec: [5, 10]}, shots: long}).directions[0]!.input as {durationFrames: number | null}).durationFrames).toBeNull();
    const wider = crewChanges(plan, castingSnapshot("p1", 0, [], now), directionSnapshot("p1", 0, [], now), () => crypto.randomUUID(), now,
      {timing: billedShotTiming([{snapshot: falVideoCapability("kling-o3-standard-keyframes")}])!, shots: long});
    expect((wider.directions[0]!.input as {durationFrames: number}).durationFrames).toBe(330);
    expect(wider.notes.some(value => value.change.includes("automatic duration"))).toBe(false);
    // A duration the creator set in their own coverage cut is left exactly as it is, fit or not.
    const cut = crewChanges(plan, castingSnapshot("p1", 0, [], now), directionSnapshot("p1", 0, [], now), () => crypto.randomUUID(), now,
      {timing: {floorSec: 5, stepsSec: [5, 10]}, shots: long.map((shot, index) => index === 0 ? {...shot, cutDurationFrames: 150} : shot)});
    expect((cut.directions[0]!.input as {durationFrames: number | null}).durationFrames).toBeNull();
    expect(cut.notes.some(value => value.change.includes("automatic duration"))).toBe(false);
  });
});
