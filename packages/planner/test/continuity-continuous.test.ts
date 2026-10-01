/**
 * HV-021-08 — a scene marked CONTINUOUS is checked against the scene it continues.
 *
 * The continuity report compared every scene only with itself. "INT. STAIRWELL - CONTINUOUS" picks up
 * in the same moment the scene before it ends, so a character in both is still wearing what they
 * wore, and the time of day has not moved. Both are declarations the project already makes — the cast
 * record's wardrobe per scene, the heading's time and each shot's directed time — and a contradiction
 * between them is drift the film will show.
 *
 * Only what both scenes declare is compared. An unstated wardrobe or an undirected time is not a
 * contradiction, and "LATER" or "MOMENTS LATER" is not CONTINUOUS.
 */
import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord} from "../src/casting";
import {directionEntry,directionSnapshot} from "../src/direction";
import {continuityHeadingContinuous,continuityReport,type ContinuityReport} from "../src/continuity";

const now=Date.UTC(2026,9,1);
const SCRIPT="INT. LIGHTHOUSE - DAY\n\nMarguerite winds the lamp.\n\nTomas climbs the stair.\n\nINT. STAIRWELL - CONTINUOUS\n\nMarguerite follows Tomas down.\n\nTomas stops at the door.\n\nEXT. CLIFF - NIGHT\n\nAnders walks the path.\n\nEXT. CLIFF EDGE - CONTINUOUS\n\nMarguerite reaches the edge.";
const plan=(script:string)=>{const parsed=parseFountain(script);return {parsed,shots:planShots(parsed,7000,24)};};
const {parsed,shots}=plan(SCRIPT);
const permission={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
const ids:Record<string,string>={MARGUERITE:"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",TOMAS:"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",ANDERS:"cccccccc-3333-4333-8333-cccccccccccc"};
const actor=(name:string,wardrobe:{sceneNumber:number|null;description:string}[])=>characterRecord({name,aliases:[],kind:"original-fictional",appearance:"A keeper of the light.",
  ageRange:"adult",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",wardrobe,sceneBindings:[],permission},ids[name]!,now,true);
const cast=(...characters:ReturnType<typeof actor>[])=>castingSnapshot("project-1",1,characters,now);
const report=(people:ReturnType<typeof cast>,entries:ReturnType<typeof directionEntry>[]=[],plans=shots,script=parsed)=>continuityReport(plans,people,directionSnapshot("project-1",1,entries,now),script);
const shot=(id:string,plans=shots)=>plans.find(value=>value.id===id)!;
const findings=(value:ContinuityReport,code:string)=>value.scenes.flatMap(scene=>scene.findings.filter(finding=>finding.code===code).map(finding=>({scene:scene.sceneNumber,...finding})));
/** Scene 1 and 2 each have their own wardrobe for MARGUERITE; TOMAS has one default for the film. */
const changing=cast(actor("MARGUERITE",[{sceneNumber:1,description:"An oilskin coat"},{sceneNumber:2,description:"A wet jumper"}]),actor("TOMAS",[{sceneNumber:null,description:"A fisherman's smock"}]));

test("a heading is CONTINUOUS when a segment or a parenthetical after the location says exactly that, and in no other form",()=>{
  for(const [heading,continuous] of [["INT. STAIRWELL - CONTINUOUS",true],["INT. HALL - DAY - CONTINUOUS",true],["int. hall -- continuous",true],["INT. HALL – CONTINUOUS",true],
    ["INT. HALL (CONTINUOUS)",true],["INT. HALL - DAY (CONTINUOUS)",true],["INT. HALL-CONTINUOUS",true],["INT. HALL - CONTINUOUS #2#",true],["INT. HALL - CONTINUOUS.",true],
    ["(CONTINUOUS)",false],["INT. HALL - CONT'D",false],["INT. HALL - SAME",false],["INT. HALL - DAY #CONTINUOUS#",false],
    ["INT. HALL - LATER",false],["INT. HALL - MOMENTS LATER",false],["INT. CONTINUOUS PRESS ROOM - DAY",false],["INT. HALL",false],["INT. HALL - DAY",false]] as const)
    expect({heading,continuous:continuityHeadingContinuous(heading)}).toEqual({heading,continuous});
});

test("a character in both scenes whose declared wardrobe changes across a CONTINUOUS heading is a warning naming both values and both scenes",()=>{
  const value=report(changing),found=findings(value,"wardrobe-contradicts-previous");
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({scene:2,severity:"warning",shotIds:["shot-2-1","shot-2-2"]});
  expect(found[0]!.message).toContain("CONTINUOUS from scene 1");
  expect(found[0]!.message).toContain("MARGUERITE wears “An oilskin coat” in scene 1 and “A wet jumper” in scene 2");
  // TOMAS wears the project default in both, which is the same wardrobe, so he is not named.
  expect(found[0]!.message).not.toContain("TOMAS");
  expect(value.scenes[1]!.continuousComparisons).toBe(2);
  // A default against a scene's own entry is compared too: both are what the scene declares.
  const defaulted=report(cast(actor("MARGUERITE",[{sceneNumber:null,description:"An oilskin coat"},{sceneNumber:2,description:"A wet jumper"}])));
  expect(findings(defaulted,"wardrobe-contradicts-previous")[0]!.message).toContain("“An oilskin coat” (the project default) in scene 1 and “A wet jumper” in scene 2");
});

test("the same wardrobe typed differently is not a change",()=>{
  const value=report(cast(actor("MARGUERITE",[{sceneNumber:1,description:"A fisherman's smock."},{sceneNumber:2,description:"a  FISHERMAN’S smock"}])));
  expect(findings(value,"wardrobe-contradicts-previous")).toEqual([]);
  // It was compared, and it agreed.
  expect(value.scenes[1]!.continuousComparisons).toBe(1);
});

test("an undeclared wardrobe is not a contradiction, and the scene that has none is still the unknown it was",()=>{
  // MARGUERITE states nothing for scene 1 and has no default: scene 2's coat contradicts nothing.
  const value=report(cast(actor("MARGUERITE",[{sceneNumber:2,description:"A wet jumper"}])));
  expect(findings(value,"wardrobe-contradicts-previous")).toEqual([]);
  expect(value.scenes[1]!.continuousComparisons).toBe(0);
  expect(findings(value,"wardrobe-unstated").map(finding=>finding.scene)).toContain(1);
});

test("a CONTINUOUS scene directed to the opposite time of day from the scene it continues is a warning naming its shots",()=>{
  const value=report(cast(),[directionEntry(shot("shot-2-1"),{timeOfDay:"morning"}),directionEntry(shot("shot-2-2"),{timeOfDay:"night"})]);
  const found=findings(value,"time-contradicts-previous");
  expect(found).toHaveLength(1);
  // Only the shot that opposes the scene before it is named; "morning" agrees with a DAY heading.
  expect(found[0]).toMatchObject({scene:2,severity:"warning",shotIds:["shot-2-2"]});
  expect(found[0]!.message).toContain("CONTINUOUS from scene 1, which is headed “INT. LIGHTHOUSE - DAY”, and this scene is directed “night”");
  expect(value.scenes[1]!.continuousComparisons).toBe(1);
  // Scene 2's own heading states no time, so nothing else names that shot.
  expect(findings(value,"time-contradicts-heading")).toEqual([]);
  // A time that is neither day nor night declares no family, and is compared with nothing.
  const dusk=report(cast(),[directionEntry(shot("shot-2-2"),{timeOfDay:"dusk"})]);
  expect(findings(dusk,"time-contradicts-previous")).toEqual([]);expect(dusk.scenes[1]!.continuousComparisons).toBe(0);
});

test("a heading that states the opposite time names the whole scene, and the earlier scene's directed time counts when its heading has none",()=>{
  const headed=plan(SCRIPT.replace("INT. STAIRWELL - CONTINUOUS","INT. STAIRWELL - NIGHT - CONTINUOUS"));
  const value=report(cast(),[],headed.shots,headed.parsed),found=findings(value,"time-contradicts-previous");
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({scene:2,shotIds:["shot-2-1","shot-2-2"]});
  expect(found[0]!.message).toContain("this scene is headed “INT. STAIRWELL - NIGHT - CONTINUOUS”");
  // Without a time in the first heading, the first scene's time is what its shots are directed.
  const untimed=plan(SCRIPT.replace("INT. LIGHTHOUSE - DAY","INT. LIGHTHOUSE"));
  const directed=report(cast(),[directionEntry(shot("shot-1-2",untimed.shots),{timeOfDay:"afternoon"}),directionEntry(shot("shot-2-1",untimed.shots),{timeOfDay:"midnight"})],untimed.shots,untimed.parsed);
  expect(findings(directed,"time-contradicts-previous")[0]).toMatchObject({scene:2,shotIds:["shot-2-1"]});
  expect(findings(directed,"time-contradicts-previous")[0]!.message).toContain("which is directed “afternoon”");
});

test("a shot that contradicts its own heading is reported once, by that heading, not again against the scene before",()=>{
  const headed=plan(SCRIPT.replace("INT. STAIRWELL - CONTINUOUS","INT. STAIRWELL - DAY - CONTINUOUS"));
  const value=report(cast(),[directionEntry(shot("shot-2-1",headed.shots),{timeOfDay:"night"})],headed.shots,headed.parsed);
  expect(findings(value,"time-contradicts-heading").map(finding=>finding.shotIds)).toEqual([["shot-2-1"]]);
  expect(findings(value,"time-contradicts-previous")).toEqual([]);
  // Both headings say day, and that comparison was made.
  expect(value.scenes[1]!.continuousComparisons).toBe(1);
});

test("the first scene, a CONTINUOUS scene with no character in common, and a LATER heading yield nothing",()=>{
  // Scene 4 continues scene 3, where only ANDERS appears: MARGUERITE's change has nothing to contradict.
  const people=cast(actor("MARGUERITE",[{sceneNumber:3,description:"An oilskin coat"},{sceneNumber:4,description:"A wet jumper"}]),actor("ANDERS",[{sceneNumber:null,description:"A grey coat"}]));
  const value=report(people,[directionEntry(shot("shot-4-1"),{timeOfDay:"night"})]);
  expect(value.scenes[3]!.findings.filter(finding=>finding.code.endsWith("-previous"))).toEqual([]);
  expect(value.scenes[3]!.continuousComparisons).toBe(1);
  // A CONTINUOUS first scene has nothing before it.
  const first=plan("INT. HALL - CONTINUOUS\n\nMarguerite runs.\n\nINT. KITCHEN - NIGHT\n\nMarguerite stops.");
  const alone=report(changing,[directionEntry(first.shots[0]!,{timeOfDay:"day"})],first.shots,first.parsed);
  expect(alone.scenes.flatMap(scene=>scene.findings).filter(finding=>finding.code.endsWith("-previous"))).toEqual([]);
  expect(alone.totals.continuousComparisons).toBe(0);
  // "MOMENTS LATER" is a jump in story time, so nothing carries across it.
  const later=plan(SCRIPT.replace("INT. STAIRWELL - CONTINUOUS","INT. STAIRWELL - MOMENTS LATER"));
  const jumped=report(changing,[directionEntry(shot("shot-2-2",later.shots),{timeOfDay:"night"})],later.shots,later.parsed);
  expect(jumped.scenes[1]!.findings.filter(finding=>finding.code.endsWith("-previous"))).toEqual([]);
  expect(jumped.scenes[1]!.continuousComparisons).toBe(0);
});

test("cross-scene findings are deterministic, one per kind per scene, counted in the totals, and move the revision",()=>{
  // Two characters change and two shots oppose the time: still one finding of each kind.
  const both=cast(actor("MARGUERITE",[{sceneNumber:1,description:"An oilskin coat"},{sceneNumber:2,description:"A wet jumper"}]),
    actor("TOMAS",[{sceneNumber:1,description:"A smock"},{sceneNumber:2,description:"Nothing but a towel"}]));
  const entries=[directionEntry(shot("shot-2-1"),{timeOfDay:"night"}),directionEntry(shot("shot-2-2"),{timeOfDay:"midnight"})];
  const value=report(both,entries),scene=value.scenes[1]!;
  expect(scene.findings.filter(finding=>finding.code==="wardrobe-contradicts-previous")).toHaveLength(1);
  expect(scene.findings.filter(finding=>finding.code==="time-contradicts-previous")).toHaveLength(1);
  expect(scene.findings.find(finding=>finding.code==="wardrobe-contradicts-previous")!.message).toContain("TOMAS wears “A smock” in scene 1 and “Nothing but a towel” in scene 2");
  expect(scene.findings.find(finding=>finding.code==="time-contradicts-previous")!.shotIds).toEqual(["shot-2-1","shot-2-2"]);
  expect(scene.findings.find(finding=>finding.code==="time-contradicts-previous")!.message).toContain("directed “night”, “midnight”");
  // Warnings still come first.
  expect(scene.findings.slice(0,3).every(finding=>finding.severity==="warning")).toBe(true);
  // The totals count every warning the scenes hold, the new ones included.
  const all=value.scenes.flatMap(entry=>entry.findings);
  expect(value.totals.warnings).toBe(all.filter(finding=>finding.severity==="warning").length);
  expect(value.totals.continuousComparisons).toBe(value.scenes.reduce((total,entry)=>total+entry.continuousComparisons,0));
  expect(value.totals.continuousComparisons).toBe(3);
  // The same inputs give the same report. Marking the scene MOMENTS LATER instead, with the same cast
  // and the same settings on the same shots, removes both cross-scene findings, and the totals and the
  // revision move with them. (The heading is part of each shot's source, so the screenplay change is
  // the only change; the cast is not touched.)
  expect(report(both,entries)).toEqual(value);
  const later=plan(SCRIPT.replace("INT. STAIRWELL - CONTINUOUS","INT. STAIRWELL - MOMENTS LATER"));
  const jumped=report(both,[directionEntry(shot("shot-2-1",later.shots),{timeOfDay:"night"}),directionEntry(shot("shot-2-2",later.shots),{timeOfDay:"midnight"})],later.shots,later.parsed);
  expect(jumped.castingRevision).toBe(value.castingRevision);
  expect(jumped.scenes[1]!.findings.filter(finding=>finding.code.endsWith("-previous"))).toEqual([]);
  expect(jumped.totals.warnings).toBe(value.totals.warnings-2);
  expect(jumped.revision).not.toBe(value.revision);
});
