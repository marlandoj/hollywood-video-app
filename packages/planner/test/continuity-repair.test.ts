import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord} from "../src/casting";
import {directionEntry,directionSnapshot} from "../src/direction";
import {continuityReport} from "../src/continuity";
import {continuityRepair,continuityRepairSummary} from "../src/continuity-repair";

const now=Date.UTC(2026,8,22);
const SCRIPT="INT. LIGHTHOUSE - DAY\n\nMarguerite winds the lamp.\n\nTomas climbs the stair.\n\nMarguerite watches the sea.\n\nMARGUERITE\nThe light has to hold.\n\nTOMAS\nIt will hold.\n\nEXT. CLIFF - NIGHT\n\nTomas walks the path.";
const parsed=parseFountain(SCRIPT),shots=planShots(parsed,7000,24);
const permission={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
const actor=(name:string,extra:Record<string,unknown>={})=>characterRecord({name,aliases:[],kind:"original-fictional",appearance:"A keeper of the light.",
  ageRange:"adult",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",wardrobe:[],sceneBindings:[],permission,...extra},
  name==="MARGUERITE"?"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa":"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",now,true);
const cast=castingSnapshot("project-1",1,[actor("MARGUERITE"),actor("TOMAS")],now);
const report=(entries:ReturnType<typeof directionEntry>[],plan=shots,script=parsed)=>continuityReport(plan,cast,directionSnapshot("project-1",1,entries,now),script);

test("the value a scene holds is the one its first declaring shot states",()=>{
  const proposal=continuityRepair(report([
    directionEntry(shots[0]!,{timeOfDay:"day",keyLight:"The lamp above"}),
    directionEntry(shots[1]!,{timeOfDay:"day",keyLight:"Moon through glass"}),
    directionEntry(shots[2]!,{keyLight:"A hurricane lamp"}),
  ]));
  expect(proposal.schema).toBe("hv-continuity-repair/1");
  expect(proposal.edits).toEqual([
    {shotId:"shot-1-2",sceneIndex:0,field:"keyLight",from:"Moon through glass",to:"The lamp above"},
    {shotId:"shot-1-3",sceneIndex:0,field:"keyLight",from:"A hurricane lamp",to:"The lamp above"},
  ]);
  // The shot that states the value first is never edited, and an agreeing shot is left alone.
  expect(proposal.edits.some(edit=>edit.shotId==="shot-1-1")).toBe(false);
  expect(proposal.edits.some(edit=>edit.field==="timeOfDay")).toBe(false);
  expect(continuityRepairSummary(proposal)).toBe("Hold key light across 2 shots, matching the first shot that states each.");
  // It is bound to the report it was read from and to that report's own three inputs.
  const source=report([directionEntry(shots[0]!,{timeOfDay:"day",keyLight:"The lamp above"}),directionEntry(shots[1]!,{timeOfDay:"day",keyLight:"Moon through glass"}),directionEntry(shots[2]!,{keyLight:"A hurricane lamp"})]);
  expect(proposal.reportRevision).toBe(source.revision);
  expect(proposal.castingRevision).toBe(source.castingRevision);
  expect(proposal.sourcePlanHash).toBe(source.sourcePlanHash);
});

test("a film whose declared look agrees with itself is left alone",()=>{
  const proposal=continuityRepair(report([
    directionEntry(shots[0]!,{timeOfDay:"day",keyLight:"The lamp above"}),
    directionEntry(shots[1]!,{timeOfDay:"Day",keyLight:"the lamp above"}),
  ]));
  // Case and spacing are not drift.
  expect(proposal.edits).toEqual([]);
  expect(continuityRepairSummary(proposal)).toBe("Nothing in this film's declared look contradicts itself.");
});

test("what the Supervisor sees and will not repair is said, not left out",()=>{
  const proposal=continuityRepair(report([
    directionEntry(shots[0]!,{timeOfDay:"day"}),
    directionEntry(shots[1]!,{timeOfDay:"night"}),
  ]));
  const notes=proposal.notes.join("\n");
  // The one it could "fix" by guessing, and deliberately does not.
  expect(notes).toContain("directed against its own heading's time");
  expect(notes).toContain("only you can say which");
  expect(proposal.edits.every(edit=>edit.field!=="timeOfDay"||edit.to!=="day"||edit.shotId!=="shot-1-1")).toBe(true);
  // And the ones no direction edit could reach.
  expect(notes).toContain("no wardrobe stated");
  expect(notes).toContain("no retained reference image");
  expect(notes).toContain("do not start from the frame before them");
  expect(proposal.notes.length).toBe(new Set(proposal.notes).size);
});

test("a shot whose source changed is out of the repair, as it is out of the report",()=>{
  const entries=[directionEntry(shots[0]!,{keyLight:"The lamp above"}),directionEntry(shots[1]!,{keyLight:"Moon through glass"})];
  const changedParse=parseFountain(SCRIPT.replace("winds the lamp","winds the great lamp")),changed=planShots(changedParse,7000,24);
  const proposal=continuityRepair(report(entries,changed,changedParse));
  // shot-1-1 held the value the scene would have been made to match; with it stale, there is nothing
  // left to disagree with, and the note says to review it first.
  expect(proposal.edits).toEqual([]);
  expect(proposal.notes.join("\n")).toContain("saved direction whose shot changed");
});

/**
 * HV-021-03: a report's packets are the shots it compared, so a stale shot cannot be among them.
 * The repair used to filter them out, which meant a report that contradicted itself still produced
 * a proposal — one built by quietly skipping a shot nobody was told about.
 */
test("a report that lists a shot as both compared and stale is refused, not filtered",()=>{
  const entries=[directionEntry(shots[0]!,{keyLight:"The lamp above"}),directionEntry(shots[1]!,{keyLight:"Moon through glass"})];
  const sound=report(entries,shots,parsed);
  expect(continuityRepair(sound).edits.length).toBeGreaterThan(0);
  const contradictory={...sound,staleShotIds:[sound.scenes[0]!.packets[0]!.shotId]};
  expect(()=>continuityRepair(contradictory)).toThrow("both compared and stale");
});
