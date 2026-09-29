/**
 * HV-030-16 — the stand-in crew wrote a time of day that its own continuity report then flagged.
 *
 * `standInPlan` decided a shot was at night with
 *
 *     const night = /\bNIGHT\b/i.test(heading)
 *
 * over the whole heading. The continuity report reads a heading's time with `continuityHeadingTime`,
 * which looks only at the segments after " - " and knows MIDNIGHT and NIGHTTIME are night. The two
 * disagreed:
 *
 * - `EXT. HARBOR - MIDNIGHT` and `INT. APARTMENT - NIGHTTIME` were planned in soft daylight, "day";
 * - `EXT. NIGHT MARKET - DAY` -- a place called the night market, by day -- was planned at night.
 *
 * So the moment the creator pressed "Plan the film", every shot in those scenes carried a
 * `time-contradicts-heading` warning asking them to fix directions the crew had just written, and
 * the shots rendered in the wrong light. The stand-in now reads the heading's time the way the
 * report does.
 */
import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {crewChanges,standInPlan} from "../src/crew/production-plan";
import {readThroughFacts} from "../src/crew/read-through";
import {sourcePlan} from "../src/scene-cuts";
import {castingSnapshot} from "../src/casting";
import {directionEntry,directionSnapshot} from "../src/direction";
import {continuityReport} from "../src/continuity";

const now=Date.parse("2026-09-28T00:00:00.000Z");

/** The stand-in's plan for a one-scene script, and the continuity findings once its directions are applied. */
function planned(heading:string){
  const script=heading+"\n\nMaya waits by the water.\n\nMAYA\nYou came back.\n";
  const parsed=parseFountain(script),shots=sourcePlan(parsed,undefined,7000,24),plan=standInPlan(parsed,readThroughFacts(script,parsed,{format:"reel",tone:""}),shots);
  let n=0;const changes=crewChanges(plan,castingSnapshot("p1",0,[],now),directionSnapshot("p1",0,[],now),()=>`00000000-0000-4000-8000-${String(++n).padStart(12,"0")}`,now);
  const direction=directionSnapshot("p1",1,changes.directions.map(entry=>directionEntry(shots.find(shot=>shot.id===entry.shotId)!,entry.input)),now);
  const findings=continuityReport(shots,castingSnapshot("p1",0,[],now),direction,parsed).scenes.flatMap(scene=>scene.findings.map(finding=>finding.code));
  return {times:[...new Set(plan.shots.map(shot=>shot.timeOfDay))],light:[...new Set(plan.shots.map(shot=>shot.keyLight))],findings};
}

test("MIDNIGHT and NIGHTTIME are planned at night, in night light, and the report has nothing to say about it",()=>{
  for(const heading of ["EXT. HARBOR - MIDNIGHT","INT. APARTMENT - NIGHTTIME"]){
    const p=planned(heading);
    expect({heading,times:p.times,light:p.light}).toEqual({heading,times:["night"],light:["Low, motivated practical light"]});
    expect({heading,contradicts:p.findings.includes("time-contradicts-heading")}).toEqual({heading,contradicts:false});
  }
});

test("a place called the night market, by day, is planned by day",()=>{
  const p=planned("EXT. NIGHT MARKET - DAY");
  expect({times:p.times,light:p.light,contradicts:p.findings.includes("time-contradicts-heading")}).toEqual({times:["day"],light:["Soft natural daylight"],contradicts:false});
});

test("plain DAY and NIGHT headings are planned as before",()=>{
  expect(planned("INT. LIGHTHOUSE - NIGHT").times).toEqual(["night"]);
  expect(planned("EXT. CLIFF - DAY").times).toEqual(["day"]);
  expect(planned("INT. KITCHEN - DAY").light).toEqual(["Soft window light"]);
});
