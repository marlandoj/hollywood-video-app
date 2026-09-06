import { expect, test } from "bun:test";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import { ProjectService } from "../../api/src/index";
import { parseFountain } from "../../parser/src/index";
import { castingSnapshot, characterRecord } from "../src/casting";
import { assertSheetDispatch, characterSheetShots, createCharacterSheet, validateCharacterSheet, type SheetKind } from "../src/sheets";
const now=Date.now(), parsed=parseFountain(CAST_SCRIPT);
const actor=characterRecord(CAST_INPUT,crypto.randomUUID(),now), cast=castingSnapshot("project-1",1,[actor],now);
const plan=(kind:SheetKind="turnaround")=>createCharacterSheet(cast,parsed,actor.id,{kind,seed:123,sceneNumber:null});

test("five sheet recipes have deterministic, bounded views with one pinned seed and cast",()=>{
  for(const [kind,count]of [["turnaround",4],["expressions",6],["wardrobe",1],["lighting",4],["adult-ages",3]] as const) {
    const saved=plan(kind),shots=characterSheetShots(saved,cast,parsed,now);
    expect(validateCharacterSheet(saved)).toEqual(saved);expect(plan(kind)).toEqual(saved);expect(shots).toHaveLength(count);
    expect(shots.every(shot=>shot.seed===123 && shot.durationSec===1 && shot.castingRevision===cast.revision)).toBe(true);
    expect(new Set(shots.map(shot=>shot.prompt)).size).toBe(count);
    expect(shots.every(shot=>shot.characterIds?.join()===actor.id && shot.dialogue?.length===0)).toBe(true);
    if(kind==="adult-ages")expect(shots.every(shot=>shot.prompt.includes("clearly adult") && shot.prompt.includes("intentionally varies adult age"))).toBe(true);
  }
  expect(()=>validateCharacterSheet({...plan(),seed:124})).toThrow("changed");
  expect(()=>characterSheetShots(plan(),castingSnapshot(cast.projectId,2,[{...actor,appearance:"A new coat"}],now),parsed,now)).toThrow("no longer matches");
  for(const settings of [{kind:"unknown",seed:123,sceneNumber:null},{kind:"turnaround",seed:-1,sceneNumber:null},
    {kind:"turnaround",seed:2147483648,sceneNumber:null},{kind:"turnaround",seed:1,sceneNumber:3},
    {kind:"turnaround",seed:1,sceneNumber:null,prompt:"override"}])expect(()=>createCharacterSheet(cast,parsed,actor.id,settings)).toThrow();
});

test("wardrobe cells separate the default costume from scene overrides and detect changed headings",()=>{
  process.env.HV_TOKEN_SECRET="sheet-planner-test-secret-at-least-thirty-two-characters";
  const service=new ProjectService(),owner=service.createAnonymousProject(now),id=crypto.randomUUID();service.editScript(owner.token,CAST_SCRIPT,now);
  const saved=service.saveCharacter(owner.token,id,{...CAST_INPUT,wardrobe:[...CAST_INPUT.wardrobe,{sceneNumber:1,description:"A yellow raincoat"},{sceneNumber:2,description:"A blue jacket"}]},0,now)!;
  const sheet=createCharacterSheet(saved,parsed,id,{kind:"wardrobe",seed:0,sceneNumber:null}),shots=characterSheetShots(sheet,saved,parsed,now);
  expect(shots).toHaveLength(3);expect(shots[0]!.prompt).toContain("A navy scarf");expect(shots[0]!.prompt).not.toContain("A yellow raincoat");
  expect(shots[1]!.prompt).toContain("A yellow raincoat");expect(shots[2]!.prompt).toContain("A blue jacket");
  const selected=createCharacterSheet(saved,parsed,id,{kind:"wardrobe",seed:0,sceneNumber:2});expect(selected.views.map(view=>view.label)).toEqual(["Default wardrobe","Scene 2 wardrobe"]);
  expect(()=>characterSheetShots(sheet,saved,parseFountain(CAST_SCRIPT.replace("INT. KITCHEN - NIGHT","EXT. PARK - DAY")),now)).toThrow("Scene 2 changed");
});

test("sheet admission and each view dispatch obey current scoped and expiring permissions",()=>{
  const restricted=castingSnapshot(cast.projectId,2,[{...actor,permission:{...actor.permission,scope:"scenes",sceneNumbers:[1]}}],now);
  const projectPlan=createCharacterSheet(restricted,parsed,actor.id,{kind:"turnaround",seed:1,sceneNumber:null});
  expect(()=>characterSheetShots(projectPlan,restricted,parsed,now)).toThrow("Select a permitted scene");
  const scoped=createCharacterSheet(restricted,parsed,actor.id,{kind:"turnaround",seed:1,sceneNumber:1});expect(characterSheetShots(scoped,restricted,parsed,now)).toHaveLength(4);
  expect(()=>assertSheetDispatch(plan(),cast,restricted,"sheet-1",parsed,now)).toThrow("project-wide");
  const revoked=castingSnapshot(cast.projectId,3,[{...actor,permission:{...actor.permission,status:"revoked"}}],now);
  expect(()=>assertSheetDispatch(plan(),cast,revoked,"sheet-2",parsed,now)).toThrow("not permitted");
  const expires=castingSnapshot(cast.projectId,4,[{...actor,permission:{...actor.permission,expiresAt:new Date(now+1000).toISOString()}}],now);
  expect(()=>assertSheetDispatch(plan(),cast,expires,"sheet-3",parsed,now+1001)).toThrow("not permitted");
  expect(()=>assertSheetDispatch(plan(),cast,cast,"sheet-9",parsed,now)).toThrow("planned view");
});
