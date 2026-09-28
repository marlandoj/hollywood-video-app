/**
 * HV-021-06 — the continuity repair spread a day/night contradiction while its note said nothing was
 * proposed.
 *
 * The Supervisor's repair holds each look field to the first shot in the scene that states it. It
 * also reports, in a note, that a scene directed against its own heading's time gets nothing
 * proposed, because only the creator can say whether the heading or the direction is wrong. The two
 * disagreed: in `INT. LIGHTHOUSE - DAY` with shot 1 directed "night" and shot 2 directed "day", the
 * repair proposed turning shot 2 to night -- the first shot's look -- and the note beneath said
 * nothing was proposed. Accepting it made the scene contradict its heading in two shots instead of one.
 *
 * A scene with that contradiction now gets no time-of-day edit at all, which is what its note says.
 * Its other look fields are still held, and a scene whose times all agree with the heading is still
 * repaired as before.
 */
import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot} from "../src/casting";
import {directionEntry,directionSnapshot} from "../src/direction";
import {continuityReport} from "../src/continuity";
import {continuityRepair} from "../src/continuity-repair";

const now=Date.UTC(2026,8,28);
const SCRIPT="INT. LIGHTHOUSE - DAY\n\nMarguerite winds the lamp.\n\nTomas climbs the stair.\n\nMarguerite watches the sea.\n\nEXT. CLIFF - DAY\n\nTomas walks the path.\n\nThe gulls wheel.";
const parsed=parseFountain(SCRIPT),shots=planShots(parsed,7000,24),cast=castingSnapshot("project-1",1,[],now);
const report=(entries:ReturnType<typeof directionEntry>[])=>continuityReport(shots,cast,directionSnapshot("project-1",1,entries,now),parsed);
const inScene=(index:number)=>shots.filter(shot=>shot.sceneIndex===index);
const opposed=(value:ReturnType<typeof report>)=>value.scenes.flatMap(scene=>scene.findings.filter(finding=>finding.code==="time-contradicts-heading").flatMap(finding=>finding.shotIds));

test("a scene directed against its heading's time gets no time-of-day edit, so accepting the repair cannot spread it",()=>{
  const [first,second]=inScene(0);
  const entries=[directionEntry(first!,{timeOfDay:"night"}),directionEntry(second!,{timeOfDay:"day"})];
  const before=report(entries);
  expect(opposed(before)).toEqual([first!.id]);
  const repair=continuityRepair(before);
  expect(repair.edits.filter(edit=>edit.field==="timeOfDay")).toEqual([]);
  // And the note it gives is now true of what it proposed.
  expect(repair.notes.some(note=>note.startsWith("Scene 1 is directed against its own heading's time")&&note.endsWith("so nothing is proposed for it."))).toBe(true);
  // Applying what was proposed leaves the scene no worse than it was.
  const applied=entries.map(entry=>{const edit=repair.edits.find(value=>value.shotId===entry.source.id&&value.field==="timeOfDay");return edit?directionEntry(shots.find(shot=>shot.id===entry.source.id)!,{timeOfDay:edit.to}):entry;});
  expect(opposed(report(applied))).toEqual([first!.id]);
});

test("the scene's other look fields are still held to its first shot",()=>{
  const [first,second]=inScene(0);
  const repair=continuityRepair(report([directionEntry(first!,{timeOfDay:"night",keyLight:"The lamp above"}),directionEntry(second!,{timeOfDay:"day",keyLight:"Sun through glass"})]));
  expect(repair.edits.map(edit=>[edit.shotId,edit.field,edit.to])).toEqual([[second!.id,"keyLight","The lamp above"]]);
});

test("a scene whose times all agree with its heading is still repaired as before",()=>{
  const [first,second]=inScene(1);
  const repair=continuityRepair(report([directionEntry(first!,{timeOfDay:"morning"}),directionEntry(second!,{timeOfDay:"afternoon"})]));
  expect(repair.edits.map(edit=>[edit.shotId,edit.field,edit.from,edit.to])).toEqual([[second!.id,"timeOfDay","afternoon","morning"]]);
});
