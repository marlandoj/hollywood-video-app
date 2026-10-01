/**
 * HV-021-08 — the continuity repair, run on a film whose CONTINUOUS scene contradicts the scene before.
 *
 * The repair holds each look field to the first shot in its scene that states it. Across a CONTINUOUS
 * heading that is not safe for the time of day: take a scene directed "morning" then "afternoon",
 * continued by a scene directed "night" then "day". Holding the second scene to its first shot turns
 * its "day" shot to "night", and the scene that contradicted the one before it in one shot now does
 * in two — the HV-021-06 defect, one scene boundary over.
 *
 * So neither scene of a pair whose times contradict gets a time-of-day edit, the note says so, and
 * the summary names both new contradictions, which this repair does not resolve (HV-021-05). Wardrobe
 * is a cast record and was never in the repair; the note says that too.
 */
import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord} from "../src/casting";
import {directionEntry,directionSnapshot,type DirectionEntry} from "../src/direction";
import {continuityReport,type ContinuityReport} from "../src/continuity";
import {CONTINUITY_REPAIR_CONTRADICTIONS,continuityRepair,continuityRepairSummary,type ContinuityRepairProposal} from "../src/continuity-repair";

const now=Date.UTC(2026,9,1);
const SCRIPT="INT. LIGHTHOUSE\n\nMarguerite winds the lamp.\n\nMarguerite climbs the stair.\n\nINT. STAIRWELL - CONTINUOUS\n\nMarguerite follows the stair down.\n\nMarguerite stops at the door.";
const parsed=parseFountain(SCRIPT),shots=planShots(parsed,7000,24);
const permission={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
const cast=castingSnapshot("project-1",1,[characterRecord({name:"MARGUERITE",aliases:[],kind:"original-fictional",appearance:"A keeper of the light.",
  ageRange:"adult",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",
  wardrobe:[{sceneNumber:1,description:"An oilskin coat"},{sceneNumber:2,description:"A wet jumper"}],sceneBindings:[],permission},"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",now,true)],now);
const shot=(id:string)=>shots.find(value=>value.id===id)!;
const report=(entries:DirectionEntry[])=>continuityReport(shots,cast,directionSnapshot("project-1",1,entries,now),parsed);
/** What accepting the repair writes: each edit moves one setting of one saved entry. */
const apply=(entries:DirectionEntry[],proposal:ContinuityRepairProposal)=>entries.map(entry=>{
  const edits=proposal.edits.filter(edit=>edit.shotId===entry.source.id);
  return edits.length?directionEntry(shot(entry.source.id),{...entry.settings,...Object.fromEntries(edits.map(edit=>[edit.field,edit.to]))}):entry;});
const crossScene=(value:ContinuityReport)=>value.scenes.flatMap(scene=>scene.findings.filter(finding=>finding.code.endsWith("-previous")));
const drifting=[
  directionEntry(shot("shot-1-1"),{timeOfDay:"morning",keyLight:"The lamp above"}),directionEntry(shot("shot-1-2"),{timeOfDay:"afternoon",keyLight:"Sun through glass"}),
  directionEntry(shot("shot-2-1"),{timeOfDay:"night"}),directionEntry(shot("shot-2-2"),{timeOfDay:"day"}),
];

test("a CONTINUOUS pair whose times contradict gets no time-of-day edit in either scene, so accepting the repair cannot spread it",()=>{
  const before=report(drifting);
  expect(crossScene(before).map(finding=>[finding.code,finding.shotIds])).toEqual([["time-contradicts-previous",["shot-2-1"]],["wardrobe-contradicts-previous",["shot-2-1","shot-2-2"]]]);
  const repair=continuityRepair(before);
  expect(repair.edits.filter(edit=>edit.field==="timeOfDay")).toEqual([]);
  // The rest of the look is still held: the first scene's key light.
  expect(repair.edits.map(edit=>[edit.shotId,edit.field,edit.to])).toEqual([["shot-1-2","keyLight","The lamp above"]]);
  // Applying what was proposed leaves both cross-scene findings exactly as they were.
  const after=report(apply(drifting,repair));
  expect(crossScene(after)).toEqual(crossScene(before));
  expect(after.totals.warnings).toBe(before.totals.warnings-1);
});

test("the repair says what it leaves across a CONTINUOUS heading, and the summary names both contradictions",()=>{
  const repair=continuityRepair(report(drifting));
  expect(repair.refused).toContain("time-contradicts-previous");expect(repair.refused).toContain("wardrobe-contradicts-previous");
  expect(repair.notes).toContain("Scene 2 is CONTINUOUS from Scene 1 and the two declare opposite times of day. Only you can say which is right, so no time-of-day edit is proposed for either scene.");
  expect(repair.notes.some(note=>note.startsWith("Scene 2 is CONTINUOUS from Scene 1 and a character's wardrobe changes between them.")&&note.includes("not repaired from here"))).toBe(true);
  for(const code of ["time-contradicts-previous","wardrobe-contradicts-previous"])expect(CONTINUITY_REPAIR_CONTRADICTIONS).toContain(code);
  const summary=continuityRepairSummary(repair);
  expect(summary).toStartWith("Hold key light across 1 shot, matching the first shot that states each. What is left cannot be repaired automatically: ");
  expect(summary).toContain("time-contradicts-previous");expect(summary).toContain("wardrobe-contradicts-previous");
  // With nothing to repair, the headline still does not claim the look agrees.
  const only=continuityRepair(report([directionEntry(shot("shot-1-1"),{timeOfDay:"day"}),directionEntry(shot("shot-2-1"),{timeOfDay:"night"})]));
  expect(only.edits).toEqual([]);
  expect(continuityRepairSummary(only)).toStartWith("Nothing here can be repaired automatically: ");
});

test("a CONTINUOUS pair that agrees is still repaired as before, and the repair does not create a contradiction across it",()=>{
  const agreeing=[directionEntry(shot("shot-1-1"),{timeOfDay:"morning"}),directionEntry(shot("shot-1-2"),{timeOfDay:"afternoon"}),directionEntry(shot("shot-2-1"),{timeOfDay:"day"})];
  const before=report(agreeing);
  expect(crossScene(before).filter(finding=>finding.code==="time-contradicts-previous")).toEqual([]);
  const repair=continuityRepair(before);
  expect(repair.edits.map(edit=>[edit.shotId,edit.field,edit.from,edit.to])).toEqual([["shot-1-2","timeOfDay","afternoon","morning"]]);
  expect(crossScene(report(apply(agreeing,repair))).filter(finding=>finding.code==="time-contradicts-previous")).toEqual([]);
});
