/**
 * HV-021-09 — the Continuity Supervisor joins the crew.
 *
 * HV-021-02 left the repair without the crew member who offers it. The Supervisor is on the roster now,
 * and speaks in the production plan's notes: one sentence per kind of finding in the continuity report
 * the Director's desk serves, naming the scenes. Its notes come from that report alone -- no model, no
 * spend, nothing detected here -- and a report with nothing to compare says so instead of reading as a
 * pass.
 */
import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord} from "../src/casting";
import {directionEntry,directionSnapshot} from "../src/direction";
import {continuityReport,type ContinuityReport} from "../src/continuity";
import {CONTINUITY_SUPERVISOR,CREW,PERSONA_IDS} from "../src/crew/personas";
import {continuityComparisons,continuitySupervisorNotes,SUPERVISOR_NOTE_LIMIT} from "../src/crew/continuity-supervisor";
import {planInput} from "../src/crew/production-plan";
import {readThroughFacts,readThroughPrompt,validateCrewVoice} from "../src/crew/read-through";

const now=Date.UTC(2026,9,1);
const SCRIPT="INT. LIGHTHOUSE - DAY\n\nMarguerite winds the lamp.\n\nTomas climbs the stair.\n\nMarguerite watches the sea.\n\nMARGUERITE\nThe light has to hold.\n\nTOMAS\nIt will hold.\n\nEXT. CLIFF - NIGHT\n\nTomas walks the path.";
const parsed=parseFountain(SCRIPT),shots=planShots(parsed,7000,24);
const permission={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
const actor=(name:string,id:string,extra:Record<string,unknown>={})=>characterRecord({name,aliases:[],kind:"original-fictional",appearance:"A keeper of the light.",
  ageRange:"adult",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",wardrobe:[],sceneBindings:[],permission,...extra},id,now,true);
/** MARGUERITE has a default wardrobe and no reference; TOMAS has neither. */
const cast=castingSnapshot("project-1",1,[
  actor("MARGUERITE","aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",{wardrobe:[{sceneNumber:null,description:"An oilskin coat"}]}),
  actor("TOMAS","bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"),
],now);
const noCast=castingSnapshot("project-1",1,[],now);
const codes=(report:ContinuityReport)=>[...new Set(report.scenes.flatMap(scene=>scene.findings.map(finding=>finding.code)))].sort();

test("the Continuity Supervisor is on the crew roster, and stays out of the crew the model speaks for",()=>{
  expect(CREW.map(member=>member.id)).toEqual([...PERSONA_IDS,"continuity"]);
  expect(CONTINUITY_SUPERVISOR).toMatchObject({id:"continuity",title:"Continuity Supervisor",speaks:"continuity-report"});
  expect(CONTINUITY_SUPERVISOR.department.length).toBeGreaterThan(10);
  expect(CREW.filter(member=>member.speaks==="questions").map(member=>member.id)).toEqual([...PERSONA_IDS]);
  // The read-through never tells a model about it, and nothing a model or a creator sends may speak in its name.
  const facts=readThroughFacts(SCRIPT,parsed,{format:"reel",tone:""});
  expect(JSON.stringify(readThroughPrompt(SCRIPT,facts,{format:"reel",tone:""}))).not.toMatch(/continuity/i);
  expect(()=>validateCrewVoice(JSON.stringify({logline:"A keeper.",summary:"A night.",questions:[{persona:"continuity",question:"Hold the coat?",proposal:"Yes."}]}))).toThrow("unknown persona");
  expect(()=>planInput({format:"reel",tone:"",answers:[{id:"q1",persona:"continuity",question:"Hold the coat?",proposal:"Yes.",accepted:true}]})).toThrow();
});

test("its notes are the report's findings, one per kind, naming exactly the scenes and cast the report names",()=>{
  const direction=directionSnapshot("project-1",1,[
    directionEntry(shots[0]!,{timeOfDay:"day",keyLight:"The lamp above"}),
    directionEntry(shots[1]!,{timeOfDay:"night",keyLight:"Moon through glass"}),
  ],now);
  const report=continuityReport(shots,cast,direction,parsed);
  expect(codes(report)).toEqual(["handoff-absent","identity-unanchored","look-changed","time-contradicts-heading","wardrobe-unstated"]);
  const notes=continuitySupervisorNotes(report);
  expect(notes).toEqual([
    "Found shots directed against their own heading's time of day in scene 1. Either the heading or the direction is wrong and only you can say which, so it is left for you.",
    "Found 2 look settings declared more than one way within a scene in scene 1. Under Continuity at the Director's desk, \"Review continuity repair\" offers to hold each scene to the first shot that states it.",
    "No wardrobe is stated for TOMAS in scenes 1 and 2, so nothing holds what they wear from shot to shot.",
    "No reference image is kept yet for MARGUERITE and TOMAS (scenes 1 and 2), so how they look from shot to shot rests on the written description alone.",
    "2 shots in scene 1 do not start from the frame before them, so each is generated on its own.",
  ].map(change=>({persona:"continuity",change,source:"continuity-report"})));
  // The same report gives the same notes, and a finding the report drops leaves the notes with it.
  expect(continuitySupervisorNotes(report)).toEqual(notes);
  const agreed=continuityReport(shots,cast,directionSnapshot("project-1",2,[directionEntry(shots[0]!,{timeOfDay:"day",keyLight:"The lamp above"}),directionEntry(shots[1]!,{timeOfDay:"day",keyLight:"The lamp above"})],now),parsed);
  expect(codes(agreed)).toEqual(["handoff-absent","identity-unanchored","wardrobe-unstated"]);
  expect(continuitySupervisorNotes(agreed).map(note=>note.change.split(" ").slice(0,3).join(" "))).toEqual(["No wardrobe is","No reference image","2 shots in"]);
});

test("many findings of one kind are one note, and the scenes and kinds it lists are capped and counted",()=>{
  // Ten scenes, each with two shots that disagree on key light: ten findings, one sentence.
  const many=parseFountain(Array.from({length:10},(_,index)=>"INT. ROOM "+(index+1)+"\n\nA lamp burns.\n\nThe lamp gutters.").join("\n\n"));
  const planned=planShots(many,7000,24);
  const entries=many.scenes.flatMap(scene=>planned.filter(shot=>shot.sceneIndex===scene.index).slice(0,2).map((shot,index)=>directionEntry(shot,{keyLight:index?"Moonlight":"Lamplight"})));
  const report=continuityReport(planned,noCast,directionSnapshot("project-1",1,entries,now),many);
  const looks=continuitySupervisorNotes(report).filter(note=>note.change.startsWith("Found"));
  expect(looks.map(note=>note.change)).toEqual(["Found 10 look settings declared more than one way within a scene in scenes 1, 2, 3, 4, 5, 6 and 4 more. Under Continuity at the Director's desk, \"Review continuity repair\" offers to hold each scene to the first shot that states it."]);
  // A report with more kinds than the limit -- kinds this file does not know are said in the report's own words.
  const finding=(code:string)=>({code,severity:"note" as const,shotIds:["s1"],message:"Report says "+code+"."});
  const wide={...report,scenes:[{...report.scenes[0]!,findings:["look-changed","handoff-absent","source-stale","x-one","x-two","x-three","x-four"].map(finding)}]} as ContinuityReport;
  const notes=continuitySupervisorNotes(wide);
  expect(notes).toHaveLength(SUPERVISOR_NOTE_LIMIT);
  expect(notes[3]!.change).toBe("In scene 1: Report says x-one.");
  expect(notes.at(-1)!.change).toBe("And 2 more kinds of finding, listed under Continuity at the Director's desk.");
});

test("with no findings it says honestly whether there was nothing to compare or nothing contradicted",()=>{
  const note=(report:ContinuityReport)=>continuitySupervisorNotes(report).map(value=>value.change);
  // No scenes at all.
  const empty=parseFountain("");
  expect(note(continuityReport([],noCast,directionSnapshot("project-1",0,[],now),empty))).toEqual(["Nothing to compare yet: the film has no planned shots."]);
  // One shot, no cast: nothing is stated twice, so there is nothing to check -- which is not a pass.
  const single=parseFountain("INT. ROOM - DAY\n\nA lamp burns.");
  expect(note(continuityReport(planShots(single,7000,24),noCast,directionSnapshot("project-1",0,[],now),single)))
    .toEqual(["Nothing to compare yet: no scene states its look, a wardrobe or a frame handoff more than once, so there is no continuity to check."]);
  expect(continuityComparisons(continuityReport(planShots(single,7000,24),noCast,directionSnapshot("project-1",0,[],now),single))).toBe(0);
  // One shot directed "day" under a DAY heading: one comparison, nothing contradicts.
  const lit=planShots(single,7000,24),checked=continuityReport(lit,noCast,directionSnapshot("project-1",1,[directionEntry(lit[0]!,{timeOfDay:"day"})],now),single);
  expect(continuityComparisons(checked)).toBe(1);
  expect(note(checked)).toEqual(["Compared 1 declaration across 1 scene and found nothing that contradicts. This reads what the film states, not its pictures."]);
});
