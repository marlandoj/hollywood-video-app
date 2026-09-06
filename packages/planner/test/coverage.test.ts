import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {coverageSettings,coverageReport} from "../src/coverage";
import {directionEntry,directionSnapshot,directShots,validateDirection} from "../src/direction";
const SCRIPT="INT. HALL - DAY\n\nSpud and Molly sit across the table.\n\nSpud opens a letter.\n\nMolly studies Spud.\n\nSpud folds the letter.\n\nSPUD\nWhat does it say?\n\nMOLLY\nWe are invited.\n\nEXT. GARDEN - DAY\n\nA gate swings open.";
const shots=planShots(parseFountain(SCRIPT),7000,24);
const pair=(subject:string,target:string,direction="left",side="a")=>({role:"single",subjects:[subject],axis:"table",cameraSide:side,gazeSubject:subject,gazeTarget:target,gazeDirection:direction});
test("coverage validates declarations and preserves legacy direction hashes without adding defaults",()=>{
  const legacy=directionSnapshot("project",1,[directionEntry(shots[0]!,{lensMm:85})],0),serialized=JSON.stringify(legacy);
  expect(JSON.stringify(validateDirection(JSON.parse(serialized),"project"))).toBe(serialized);expect(legacy.entries[0]!.settings).not.toHaveProperty("coverage");
  for(const value of [{role:"invented"},{cameraSide:"a"},{subjects:["SPUD"," spud "]},{subjects:["x".repeat(81)]},{gazeDirection:"left"},{...pair("SPUD","MOLLY"),subjects:[]},{reestablish:true,axis:"table"},{subjects:["SPUD"],gazeSubject:"SPUD",gazeTarget:"spud"},{extra:"secret"}])expect(()=>coverageSettings(value)).toThrow();
  const directed=directShots(shots,directionSnapshot("project",2,[directionEntry(shots[1]!,{coverage:{...pair("SPUD","MOLLY"),continuityNote:"Keep left-to-right blocking."}})]));
  expect(directed[1]!.prompt).toContain("Coverage role: single");expect(directed[1]!.prompt).toContain("Eyeline: SPUD looks toward MOLLY, screen left");expect(directed[1]!.prompt).toContain("Keep left-to-right blocking.");expect(directed[1]!.sourcePrompt).toBe(shots[1]!.prompt);
  expect(()=>directShots(shots,directionSnapshot("project",3,[directionEntry(shots[0]!,{coverage:{role:"single",subjects:["deepfake of a real celebrity"]}})]))).toThrow("content policy");
});
test("coverage distinguishes unknowns, inventory gaps, reciprocal eyelines and declared axis crossings by scene",()=>{
  const initial=coverageReport(shots,directionSnapshot("project",0,[],0));expect(initial.totals.warnings).toBe(0);expect(initial.totals.unknowns).toBeGreaterThan(0);expect(initial.totals.axisComparisons).toBe(0);
  const snapshot=directionSnapshot("project",1,[directionEntry(shots[0]!,{coverage:{role:"master",subjects:["SPUD","MOLLY"],axis:"table",cameraSide:"a"}}),directionEntry(shots[1]!,{coverage:pair("SPUD","MOLLY")}),directionEntry(shots[2]!,{coverage:pair("MOLLY","SPUD")}),directionEntry(shots[3]!,{coverage:{role:"reaction",subjects:["SPUD"],axis:"table",cameraSide:"b"}}),directionEntry(shots[4]!,{coverage:{role:"establishing",axis:"table",cameraSide:"a"}})]);
  const report=coverageReport(shots,snapshot),scene=report.scenes[0]!;
  expect(scene.inventory.master).toEqual(["shot-1-1"]);expect(scene.inventory.single).toEqual(["shot-1-2","shot-1-3"]);expect(scene.findings.some(f=>f.code==="speaker-coverage-missing")).toBe(false);
  expect(scene.findings.find(f=>f.code==="eyeline-conflict")!.shotIds).toEqual(["shot-1-2","shot-1-3"]);expect(scene.findings.find(f=>f.code==="axis-crossing")!.shotIds).toEqual(["shot-1-3","shot-1-4"]);
  expect(scene.axisComparisons).toBe(3);expect(scene.eyelineComparisons).toBe(1);expect(report.scenes[1]!.axisComparisons).toBe(0);expect(report.scenes[1]!.findings.some(f=>f.code==="master-missing")).toBe(true);
  const fixed=structuredClone(snapshot.entries);fixed[2]=directionEntry(shots[2]!,{coverage:pair("MOLLY","SPUD","right")});fixed[3]=directionEntry(shots[3]!,{coverage:{role:"reaction",subjects:["SPUD"],axis:"table",cameraSide:"b",reestablish:true,continuityNote:"The camera visibly travels around the table."}});
  const revised=coverageReport(shots,directionSnapshot("project",2,fixed));expect(revised.scenes[0]!.findings.some(f=>["axis-crossing","eyeline-conflict"].includes(f.code))).toBe(false);expect(revised.scenes[0]!.findings.find(f=>f.code==="axis-intent")!.severity).toBe("note");
});
test("coverage excludes stale source declarations and never pairs unrelated targets or axes",()=>{
  const snapshot=directionSnapshot("project",1,[directionEntry(shots[0]!,{coverage:pair("SPUD","MOLLY")}),directionEntry(shots[1]!,{coverage:{...pair("MOLLY","SPUD"),axis:"other"}}),directionEntry(shots[2]!,{coverage:pair("MOLLY","LAMP")})]);
  expect(coverageReport(shots,snapshot).totals.eyelineComparisons).toBe(0);
  const changed=planShots(parseFountain(SCRIPT.replace("Spud and Molly sit","Spud and Molly stand")),7000,24),report=coverageReport(changed,snapshot);
  expect(report.staleShotIds).toEqual(["shot-1-1"]);expect(report.scenes[0]!.inventory.single).not.toContain("shot-1-1");expect(report.scenes[0]!.findings.some(f=>f.code==="source-stale")).toBe(true);
  expect(coverageReport(shots.slice(4),snapshot).scenes.find(s=>s.sceneIndex===0)!.findings.filter(f=>f.code==="source-stale")).toHaveLength(3);
});
