import {expect,test} from "bun:test";
import {createShotTakes,shotTakeShots,validateShotTakes,assertShotTakeContext} from "../src/takes";
import {currentDirection,directionEntry,directionSettings,directShots} from "../src/direction";
import {currentCasting} from "../src/casting";
import {planShots} from "../src/index";
import {parseFountain} from "../../parser/src/index";
import {ProjectService} from "../../api/src/index";
import {CAST_INPUT} from "../../../test/fixtures/casting";
const SCRIPT="EXT. GARDEN - DAY\n\nSpud waves by the gate.\n\nSpud opens the letter.\n\nSpud smiles.";
function fixture(){
  process.env.HV_TOKEN_SECRET="shot-takes-domain-fixture-secret-at-least-thirty-two-characters";
  const projects=new ProjectService(),owner=projects.createAnonymousProject(),characterId=crypto.randomUUID();projects.editScript(owner.token,SCRIPT);projects.saveCharacter(owner.token,characterId,CAST_INPUT,0);
  const project=projects.authorize(owner.token)!,casting=currentCasting(owner.projectId,project.castingHistory),direction=currentDirection(owner.projectId,project.directionHistory),parsed=parseFountain(SCRIPT),source=directionEntry(planShots(parsed,7000,24)[0]!,{});
  const input={shotId:source.source.id,sourceHash:source.sourceHash,maxShots:24,takes:[35,50,85].map((lensMm,index)=>({label:String.fromCharCode(65+index),seed:101+index,settings:{lensMm,durationFrames:30*(index+1),previewMove:"static"}}))};
  return {projects,owner,characterId,project,casting,direction,parsed,source,input};
}
test("take groups pin independent seeds, source, cast and full normalized directions and render only their source shot",()=>{
  const f=fixture(),plan=createShotTakes(f.owner.projectId,1,f.casting,f.direction,f.parsed,f.input),shots=shotTakeShots(plan,f.casting,f.parsed,f.direction,1);
  expect(validateShotTakes(plan)).toEqual(plan);expect(shots.map(s=>s.id)).toEqual(["take-a","take-b","take-c"]);expect(shots.map(s=>s.seed)).toEqual([101,102,103]);expect(shots.map(s=>s.durationSec)).toEqual([1,2,3]);
  expect(shots.every(s=>s.sourcePrompt===f.source.source.prompt)).toBe(true);expect(shots[2]!.prompt).toContain("Focal length in mm: 85");expect(shots.every(s=>s.characterIds?.includes(f.characterId))).toBe(true);
  expect(()=>createShotTakes(f.owner.projectId,1,f.casting,f.direction,f.parsed,{...f.input,takes:f.input.takes.slice(0,1)})).toThrow("two or three");
  expect(()=>createShotTakes(f.owner.projectId,1,f.casting,f.direction,f.parsed,{...f.input,takes:[...f.input.takes,...f.input.takes]})).toThrow("two or three");
  const changed=structuredClone(plan);changed.takes[0]!.settings.lensMm=80;expect(()=>validateShotTakes(changed)).toThrow("changed");
});
test("source edits, base revisions and cast permission changes refuse stale take use",()=>{
  const f=fixture(),plan=createShotTakes(f.owner.projectId,1,f.casting,f.direction,f.parsed,f.input);
  expect(()=>assertShotTakeContext(plan,f.casting,parseFountain(SCRIPT.replace("waves","jumps")),f.direction,1)).toThrow("source shot changed");
  expect(()=>assertShotTakeContext(plan,f.casting,f.parsed,f.direction,2)).toThrow("changed");
  const saved=f.projects.saveShotDirection(f.owner.token,f.source.source.id,{lensMm:24},0,1,f.source.sourceHash)!;expect(()=>shotTakeShots(plan,f.casting,f.parsed,saved,1)).toThrow("base direction changed");
  f.projects.saveCharacter(f.owner.token,f.characterId,{...CAST_INPUT,permission:{...CAST_INPUT.permission,status:"revoked"}},1);
  expect(()=>f.projects.adoptShotTake(f.owner.token,plan,"take-b",1,1)).toThrow("changed");
});

test("removing an inherited camera path stays removed during take validation and adoption",()=>{
  const f=fixture(),cameraPath:import("../src/camera-path").ShotCameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:2500,size:5000,easing:"linear"},{at:10000,x:5000,y:2500,size:5000,easing:"linear"}]};
  const direction=f.projects.saveShotDirection(f.owner.token,f.source.source.id,{cameraPath},0,1,f.source.sourceHash)!;
  const plan=createShotTakes(f.owner.projectId,1,f.casting,direction,f.parsed,{...f.input,takes:f.input.takes.map((take,i)=>({...take,settings:{...take.settings,...(i===1?{cameraPath:null}:{})}}))});
  expect(assertShotTakeContext(plan,f.casting,f.parsed,direction,1)).toEqual(plan);
  const shots=shotTakeShots(plan,f.casting,f.parsed,direction,1);expect(shots[0]!.direction!.cameraPath).toEqual(cameraPath);expect(shots[1]!.direction).not.toHaveProperty("cameraPath");
  const adopted=f.projects.adoptShotTake(f.owner.token,plan,"take-b",1,1)!;expect(adopted.entries[0]!.settings).not.toHaveProperty("cameraPath");
});
test("adoption preserves unrelated shot directions, copies the chosen seed and permits an explicit later choice from the same retained group",()=>{
  const f=fixture(),plan=createShotTakes(f.owner.projectId,1,f.casting,f.direction,f.parsed,f.input),second=directionEntry(planShots(f.parsed,7000,24)[1]!,{});
  f.projects.saveShotDirection(f.owner.token,second.source.id,{lensMm:200},0,1,second.sourceHash);
  const adopted=f.projects.adoptShotTake(f.owner.token,plan,"take-b",1,1)!;expect(adopted.version).toBe(2);expect(adopted.entries.find(e=>e.source.id===second.source.id)!.settings.lensMm).toBe(200);
  const rendered=directShots(planShots(f.parsed,7000,24),adopted);expect(rendered[0]!.seed).toBe(102);expect(rendered[0]!.direction?.lensMm).toBe(50);
  expect(()=>f.projects.adoptShotTake(f.owner.token,plan,"take-c",1,1)).toThrow("directions changed");
  const chosen=f.projects.adoptShotTake(f.owner.token,plan,"take-c",2,1)!;expect(chosen.entries[0]!.settings.seed).toBe(103);expect(chosen.entries[1]!.settings.lensMm).toBe(200);
  expect(directionSettings({seed:null}).seed).toBeUndefined();for(const seed of [-1,.1,2147483648])expect(()=>directionSettings({seed})).toThrow("generation seed");
});
