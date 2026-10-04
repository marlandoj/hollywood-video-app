/**
 * HV-021-11 — continuity across a feature's sequences (Release 3 build order step 5).
 *
 * A feature is made as sequences, each rendered and approved on its own (HV-030-29). The Supervisor
 * compares each sequence's last scene with the next one's first, as it does across a CONTINUOUS
 * heading: the scene opening a sequence gets the CONTINUOUS check every scene gets, its findings are
 * labelled with the boundary, and a CONTINUOUS scene in the same place as the scene before it -- one
 * moment in one place, split between two renders -- is held to the same light. Every boundary of the
 * plan is in the report, including the ones it could compare nothing across.
 *
 * The feature here is six scenes of nine beats, which the stand-in Showrunner splits into three
 * sequences of two scenes: scene 2 closes sequence 1 and scene 3 opens sequence 2; scene 4 closes
 * sequence 2 and scene 5 opens sequence 3.
 */
import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {castingSnapshot,characterRecord} from "../src/casting";
import {directionEntry,directionSnapshot,type DirectionEntry} from "../src/direction";
import {continuityHeadingLocation,continuityReport,type ContinuityReport} from "../src/continuity";
import {continuityRepair,continuityRepairRemakes,continuityRepairSummary} from "../src/continuity-repair";
import {sourcePlan} from "../src/scene-cuts";
import {continuityShotPlan,countedSequences,featureShots,greedySequences,sceneShotCounts,sequencePlan} from "../src/sequences";

const now=Date.UTC(2026,9,4);
const HEADINGS=["INT. LIGHTHOUSE - NIGHT","INT. LANTERN ROOM - NIGHT","INT. STAIRWELL - CONTINUOUS","INT. STAIRWELL - NIGHT","INT. STAIRWELL - CONTINUOUS","EXT. CLIFF - DAY"];
const script=(headings=HEADINGS)=>headings.map((heading,i)=>heading+"\n\n"+Array.from({length:9},(_,b)=>`Marguerite moves through scene ${i+1}, step ${b+1}.`).join("\n\n")).join("\n\n");
const film=(headings=HEADINGS)=>{const parsed=parseFountain(script(headings));return {parsed,shots:featureShots(parsed),plan:sequencePlan(1,greedySequences(sceneShotCounts(parsed)))};};
const {parsed,shots,plan}=film();
const permission={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
const marguerite=(wardrobe:{sceneNumber:number|null;description:string}[])=>castingSnapshot("project-1",1,[characterRecord({name:"MARGUERITE",aliases:[],kind:"original-fictional",
  appearance:"A keeper of the light.",ageRange:"adult",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",wardrobe,sceneBindings:[],permission},
  "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",now,true)],now);
/** The coat is on at the end of sequence 1 (scene 2, the default) and off at the start of sequence 2 (scene 3), with no time cut. */
const coatOff=marguerite([{sceneNumber:null,description:"An oilskin coat"},{sceneNumber:3,description:"No coat, a wet jumper"}]);
const coatOn=marguerite([{sceneNumber:null,description:"An oilskin coat"}]);
const shot=(id:string,plans=shots)=>plans.find(value=>value.id===id)!;
const lit=(entries:[string,Record<string,string>][],plans=shots)=>entries.map(([id,settings])=>directionEntry(shot(id,plans),settings));
/** Sequence 2 closes in the stairwell by lamp light; sequence 3 opens there, CONTINUOUS, in daylight. */
const relit=lit([["shot-4-1",{keyLight:"Low lamp light"}],["shot-4-2",{keyLight:"Low lamp light"}],["shot-5-1",{keyLight:"Bright daylight"}],["shot-5-2",{keyLight:"Low lamp light"}]]);
const held=lit([["shot-4-1",{keyLight:"Low lamp light"}],["shot-5-1",{keyLight:"low  lamp light"}],["shot-5-2",{keyLight:"LOW LAMP LIGHT"}]]);
const report=(cast=coatOff,entries:DirectionEntry[]=relit,sequences:Parameters<typeof continuityReport>[4]|null=plan,value=film())=>
  continuityReport(value.shots,cast,directionSnapshot("project-1",1,entries,now),value.parsed,sequences??undefined);
const at=(value:ContinuityReport,sceneNumber:number)=>value.scenes.find(scene=>scene.sceneNumber===sceneNumber)!;
const boundaryFindings=(value:ContinuityReport)=>value.scenes.flatMap(scene=>scene.findings.filter(finding=>finding.sequenceBoundary).map(finding=>({scene:scene.sceneNumber,code:finding.code,boundary:finding.sequenceBoundary})));

test("the stand-in splits this feature into three sequences of two scenes",()=>{
  expect(plan.sequences.map(({firstScene,lastScene})=>[firstScene,lastScene])).toEqual([[1,2],[3,4],[5,6]]);
});

test("every sequence boundary is in the report, saying what was compared across it",()=>{
  expect(report().boundaries).toEqual([
    {from:1,to:2,lastScene:2,firstScene:3,continuous:true,sameLocation:false,comparisons:1,findings:1},
    {from:2,to:3,lastScene:4,firstScene:5,continuous:true,sameLocation:true,comparisons:3,findings:1},
  ]);
});

test("a three-sequence feature whose boundary scenes contradict has a finding at each boundary, labelled with it",()=>{
  const value=report();
  expect(boundaryFindings(value)).toEqual([
    {scene:3,code:"wardrobe-contradicts-previous",boundary:{from:1,to:2}},
    {scene:5,code:"boundary-look-changed",boundary:{from:2,to:3}},
  ]);
  const wardrobe=at(value,3).findings.find(finding=>finding.code==="wardrobe-contradicts-previous")!;
  expect(wardrobe.severity).toBe("warning");
  expect(wardrobe.message).toContain("MARGUERITE wears “An oilskin coat” (the project default) in scene 2 and “No coat, a wet jumper” in scene 3");
  const light=at(value,5).findings.find(finding=>finding.code==="boundary-look-changed")!;
  // The shot it is held to, in the sequence before, and the shot that differs; the agreeing shot is not named.
  expect(light).toMatchObject({severity:"warning",shotIds:["shot-4-1","shot-5-1"]});
  expect(light.message).toStartWith("Sequence 3 opens in the place and moment sequence 2 closes (scene 5 is CONTINUOUS from scene 4, in the same place), and the key light changes across them: “Low lamp light”, then “Bright daylight”.");
  // Warnings first, as in every scene; and the light comparisons are counted with the scene's own.
  expect(at(value,5).findings[0]!.severity).toBe("warning");
  // Scene 5 also drifts within itself (daylight, then lamp light): that is its own look-changed.
  expect(at(value,5).findings.map(finding=>finding.code)).toEqual(["look-changed","boundary-look-changed","identity-unanchored","handoff-absent"]);
  expect(value.totals.warnings).toBe(3);
  expect(at(value,5).lookComparisons).toBe(1+2);
});

test("a consistent boundary yields no finding, and its comparisons are still counted",()=>{
  const value=report(coatOn,held);
  expect(boundaryFindings(value)).toEqual([]);
  expect(value.totals.warnings).toBe(0);
  // MARGUERITE's coat across the first; her coat and two light settings across the second.
  expect(value.boundaries!.map(boundary=>[boundary.comparisons,boundary.findings])).toEqual([[1,0],[3,0]]);
});

test("a boundary that lets story time pass compares nothing across it, and says so",()=>{
  const later=film(["INT. LIGHTHOUSE - NIGHT","INT. LANTERN ROOM - NIGHT","INT. STAIRWELL - NIGHT","INT. STAIRWELL - NIGHT","INT. STAIRWELL - LATER","EXT. CLIFF - DAY"]);
  const value=report(coatOff,lit([["shot-4-1",{keyLight:"Low lamp light"}],["shot-5-1",{keyLight:"Bright daylight"}]],later.shots),later.plan,later);
  expect(value.boundaries!.map(({continuous,comparisons,findings})=>({continuous,comparisons,findings}))).toEqual([{continuous:false,comparisons:0,findings:0},{continuous:false,comparisons:0,findings:0}]);
  expect(boundaryFindings(value)).toEqual([]);
});

test("time of day across a boundary is the CONTINUOUS check's own finding, labelled with the boundary",()=>{
  const value=report(coatOn,lit([["shot-3-1",{timeOfDay:"day"}]]));
  expect(boundaryFindings(value)).toEqual([{scene:3,code:"time-contradicts-previous",boundary:{from:1,to:2}}]);
  expect(at(value,3).findings.find(finding=>finding.code==="time-contradicts-previous")!.message).toContain("CONTINUOUS from scene 2, which is headed “INT. LANTERN ROOM - NIGHT”");
});

test("the light is held across a chain of same-place CONTINUOUS boundaries to the first shot that states it",()=>{
  const hall=film(["INT. HALL - NIGHT","INT. HALL - CONTINUOUS","INT. HALL (CONTINUOUS)"]);
  const split=sequencePlan(1,countedSequences([{firstScene:1,lastScene:1},{firstScene:2,lastScene:2},{firstScene:3,lastScene:3}],sceneShotCounts(hall.parsed)));
  // Scene 2 states no key light; scene 3 is still held to scene 1's, across both boundaries.
  const value=report(coatOn,lit([["shot-1-1",{keyLight:"Low lamp light"}],["shot-3-1",{keyLight:"Bright daylight"}]],hall.shots),split,hall);
  expect(boundaryFindings(value)).toEqual([{scene:3,code:"boundary-look-changed",boundary:{from:2,to:3}}]);
  expect(at(value,3).findings[0]!.shotIds).toEqual(["shot-1-1","shot-3-1"]);
  const proposal=continuityRepair(value);
  expect(proposal.edits).toEqual([{shotId:"shot-3-1",sceneIndex:2,field:"keyLight",from:"Bright daylight",to:"Low lamp light",sequenceBoundary:{from:2,to:3}}]);
});

test("a heading's place is its first segment, without its time, a CONTINUOUS marker or a scene number",()=>{
  for(const heading of ["INT. STAIRWELL - NIGHT","INT. STAIRWELL - CONTINUOUS","int.  stairwell (CONTINUOUS)","INT. STAIRWELL-CONTINUOUS","INT. STAIRWELL - DAY - CONTINUOUS #5#"])
    expect({heading,place:continuityHeadingLocation(heading)}).toEqual({heading,place:"int. stairwell"});
  expect(continuityHeadingLocation("EXT. STAIRWELL - NIGHT")).not.toBe(continuityHeadingLocation("INT. STAIRWELL - NIGHT"));
  expect(continuityHeadingLocation("INT. LANTERN ROOM - NIGHT")).toBe("int. lantern room");
});

test("reels and shorts are unchanged: without a sequence plan there are no boundaries, labels or boundary findings, and the plan only adds",()=>{
  const without=report(coatOff,relit,null),value=report();
  expect("boundaries" in without).toBe(false);
  expect(boundaryFindings(without)).toEqual([]);
  expect(without.scenes.flatMap(scene=>scene.findings.map(finding=>finding.code))).not.toContain("boundary-look-changed");
  // Take away what the plan added -- the labels, the light finding and its comparisons -- and it is the same report.
  const stripped=value.scenes.map(scene=>({...scene,lookComparisons:scene.lookComparisons-(scene.sceneNumber===5?2:0),
    findings:scene.findings.filter(finding=>finding.code!=="boundary-look-changed").map(finding=>{const copy={...finding};delete copy.sequenceBoundary;return copy;})}));
  expect(stripped).toEqual(without.scenes);
  // The repair of the same film without a plan holds nothing across a boundary.
  expect(continuityRepair(without).edits.some(edit=>"sequenceBoundary" in edit)).toBe(false);
  // A short is planned at the desk's tier, as before; a feature reads its own shots and its current split.
  const short=parseFountain("INT. HALL - DAY\n\nMarguerite waits.\n\nINT. HALL - CONTINUOUS\n\nMarguerite leaves.");
  expect(continuityShotPlan(short,directionSnapshot("project-1",0,[],now),{format:"short",scriptVersion:1},24)).toEqual({shots:sourcePlan(short,directionSnapshot("project-1",0,[],now),7000,24,true)});
  expect("sequences" in continuityShotPlan(short,directionSnapshot("project-1",0,[],now),{format:"short",scriptVersion:1,sequences:plan},24)).toBe(false);
  const feature=continuityShotPlan(parsed,directionSnapshot("project-1",0,[],now),{format:"feature",scriptVersion:1,sequences:plan},24);
  expect(feature.shots.map(value=>value.id)).toEqual(shots.map(value=>value.id));
  expect(feature.sequences).toEqual(plan);
  // A plan made for another screenplay version is not this film's split, so no boundaries are drawn from it.
  expect("sequences" in continuityShotPlan(parsed,directionSnapshot("project-1",0,[],now),{format:"feature",scriptVersion:2,sequences:plan},24)).toBe(false);
});

/** What the accept route does with a proposal: replace exactly the listed settings, then read the report again. */
const applied=(entries:DirectionEntry[],edits:ReturnType<typeof continuityRepair>["edits"])=>entries.map(entry=>{
  const mine=edits.filter(edit=>edit.shotId===entry.source.id);
  return mine.length?{...entry,settings:{...entry.settings,...Object.fromEntries(mine.map(edit=>[edit.field,edit.to]))}}:entry;
});

test("the repair holds the light across the boundary, names what it leaves at the other, and says so in its summary",()=>{
  const proposal=continuityRepair(report());
  // One edit for the shot that differs from the sequence before; scene 5's own drift is settled by the same hold.
  expect(proposal.edits).toEqual([{shotId:"shot-5-1",sceneIndex:4,field:"keyLight",from:"Bright daylight",to:"Low lamp light",sequenceBoundary:{from:2,to:3}}]);
  expect(proposal.refused).toContain("wardrobe-contradicts-previous");
  expect(proposal.refused).not.toContain("boundary-look-changed");
  expect(proposal.notes).toContain("Scene 3 opens sequence 2 and is CONTINUOUS from Scene 2, the last scene of sequence 1, and a character's wardrobe changes between them. Wardrobe belongs to the cast record, not to a shot's direction, so it is not repaired from here.");
  expect(continuityRepairSummary(proposal)).toBe("Hold key light across 1 shot, matching the first shot that states each. Sequence 3 opens in the place and moment the sequence before it closes, so its light is held to that sequence's."
    +" What is left cannot be repaired automatically: a character's wardrobe changes across a CONTINUOUS heading. Read the notes.");
});

test("applying the reviewed repair clears the boundary's light finding and leaves the wardrobe for the creator",()=>{
  const proposal=continuityRepair(report()),after=report(coatOff,applied(relit,proposal.edits));
  expect(boundaryFindings(after)).toEqual([{scene:3,code:"wardrobe-contradicts-previous",boundary:{from:1,to:2}}]);
  expect(at(after,5).findings.map(finding=>finding.code)).not.toContain("look-changed");
  expect(after.boundaries![1]).toMatchObject({comparisons:3,findings:0});
  // Nothing more to hold: the second review proposes nothing.
  expect(continuityRepair(after).edits).toEqual([]);
});

test("a scene opening a sequence that also drifts within itself gets one edit per shot, every one to the sequence before",()=>{
  const drifting=lit([["shot-4-1",{keyLight:"Low lamp light"}],["shot-5-1",{keyLight:"Bright daylight"}],["shot-5-2",{keyLight:"Cold moonlight"}],["shot-5-3",{fillLight:"Bounce"}],["shot-5-4",{fillLight:"None"}]]);
  const proposal=continuityRepair(report(coatOn,drifting));
  expect(proposal.edits.map(({shotId,field,to,sequenceBoundary})=>({shotId,field,to,boundary:Boolean(sequenceBoundary)}))).toEqual([
    {shotId:"shot-5-1",field:"keyLight",to:"Low lamp light",boundary:true},
    {shotId:"shot-5-2",field:"keyLight",to:"Low lamp light",boundary:true},
    // Scene 4 states no fill light, so scene 5's fill is held within itself, as in any scene.
    {shotId:"shot-5-4",field:"fillLight",to:"Bounce",boundary:false},
  ]);
  const after=report(coatOn,applied(drifting,proposal.edits));
  expect(after.totals.warnings).toBe(0);
});

test("applying a repair names every sequence made under the direction it replaces, and marks the ones it changes",()=>{
  const replaced=directionSnapshot("project-1",4,relit,now),older=directionSnapshot("project-1",3,[],now);
  const ref=(number:number,revision=plan.revision)=>({number,of:3,firstScene:plan.sequences[number-1]!.firstScene,lastScene:plan.sequences[number-1]!.lastScene,planRevision:revision});
  const jobs=[
    {id:"j1",stage:"animatic",status:"done",sequence:ref(1),direction:replaced},
    {id:"j2",stage:"final",status:"running",sequence:ref(1),direction:replaced},
    {id:"j3",stage:"animatic",status:"queued",sequence:ref(3),direction:replaced},
    // Made nothing, already stale, of another split, or not a sequence render: none needs this repair's remake.
    {id:"j4",stage:"animatic",status:"failed",sequence:ref(2),direction:replaced},
    {id:"j5",stage:"animatic",status:"done",sequence:ref(2),direction:older},
    {id:"j6",stage:"animatic",status:"done",sequence:ref(2,"f".repeat(64)),direction:replaced},
    {id:"j7",stage:"feature-film",status:"done",direction:replaced},
  ];
  const edits=continuityRepair(report()).edits;
  expect(continuityRepairRemakes(plan,edits,jobs,replaced)).toEqual([
    {sequence:1,touched:false,stages:["animatic","final"],jobIds:["j1","j2"]},
    {sequence:3,touched:true,stages:["animatic"],jobIds:["j3"]},
  ]);
  // Nothing applied, or no feature: nothing to make again.
  expect(continuityRepairRemakes(plan,[],jobs,replaced)).toEqual([]);
  expect(continuityRepairRemakes(undefined,edits,jobs,replaced)).toEqual([]);
});
