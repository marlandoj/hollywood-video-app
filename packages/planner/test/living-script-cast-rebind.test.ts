import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {parseFountain} from "../../parser/src/index";
import {characterRecord,castingSnapshot,assertCharacterPermission,type CastingSnapshot} from "../src/casting";
import {createScenePerformance,assertPerformanceScene} from "../src/performance-memory";
import {compileLivingScriptDocument} from "../src/living-script-document";
import {compileLivingScriptCastRebind as compileAnchored,proposeLivingScriptCastOrigin,advanceLivingScriptCastOrigin,validateLivingScriptCastRebind,assertLivingScriptCastRebindCurrent,type LivingScriptCastRebindInput} from "../src/living-script-cast-rebind";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBlock as block,livingScriptStructureBoundary as boundary,type LivingScriptStructureOperation} from "../src/living-script-structure";

const NOW=Date.parse("2026-01-01T00:00:00.000Z"),PROJECT="cast-ancestry",ACTOR="11111111-1111-4111-8111-111111111111";
const TEXT="INT. SAME - DAY\r\n\r\nALICE\r\nFirst.\r\n\r\nINT. SAME - DAY\r\n\r\nALICE\r\nSecond.\r\n";
const base=createLivingScriptStructureBase({projectId:PROJECT,version:1,text:TEXT,locks:[]}),before=compileLivingScriptDocument({base,ancestry:[]});
const compileLivingScriptCastRebind=(input:Omit<LivingScriptCastRebindInput,"origin">,now:number)=>compileAnchored({...input,origin:proposeLivingScriptCastOrigin(input.before,input.casting)},now);
function cast(scoped=true):CastingSnapshot {
  const actor=characterRecord({kind:"original-fictional",name:"ALICE",aliases:[],wardrobe:[{sceneNumber:1,description:"Red coat"},{sceneNumber:2,description:"Blue coat"},{sceneNumber:null,description:"Black shoes"}],permission:{status:"permitted",scope:scoped?"scenes":"project",sceneNumbers:scoped?[1]:[],expiresAt:"2027-01-01T00:00:00.000Z",attested:true}},ACTOR,NOW);
  actor.sceneBindings=[{sceneNumber:1,heading:"INT. SAME - DAY"},{sceneNumber:2,heading:"INT. SAME - DAY"}];
  actor.scenePerformances=[createScenePerformance(ACTOR,parseFountain(TEXT).scenes[0]!,{notes:"Quietly",controls:{speed:.9,volume:1.1}})];
  return castingSnapshot(PROJECT,4,[actor],NOW);
}
function review(operations:LivingScriptStructureOperation[],casting=cast()) {
  const patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations}),after=compileLivingScriptDocument({base:patch.after,ancestry:[patch]});
  return compileLivingScriptCastRebind({before,after,casting},NOW+1000);
}
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};

test("equal-heading scene reorder carries exact original permissions, wardrobe and performance without authorizing the new numbered slot",()=>{
  const saved=cast(),fingerprint=contentHash(saved),result=review([{id:"move",kind:"move",block:block(base,1,6),to:boundary(base,10)}],saved),next=result.candidate!;
  expect(result.conflicts).toEqual([]);expect(next.version).toBe(5);expect(next.characters[0]!.permission).toEqual({...saved.characters[0]!.permission,sceneNumbers:[2]});
  expect(()=>assertCharacterPermission(next.characters[0]!,1,NOW+1000)).toThrow(/not permitted/);expect(()=>assertCharacterPermission(next.characters[0]!,2,NOW+1000)).not.toThrow();
  expect(next.characters[0]!.wardrobe).toEqual([{sceneNumber:2,description:"Red coat"},{sceneNumber:1,description:"Blue coat"},{sceneNumber:null,description:"Black shoes"}]);
  const performance=next.characters[0]!.scenePerformances![0]!;expect(performance.sceneNumber).toBe(2);expect(performance.notes).toBe("Quietly");expect(performance.controls).toEqual({speed:.9,volume:1.1});
  expect(()=>assertPerformanceScene(performance,parseFountain(result.input.after.context.base.text).scenes[1])).not.toThrow();
  expect(result.scenes.map(scene=>scene.afterSceneNumber)).toEqual([2,1]);expect(result.changes.every(change=>!change.contentChanged)).toBe(true);expect(contentHash(saved)).toBe(fingerprint);
  expect(validateLivingScriptCastRebind(JSON.parse(JSON.stringify(result)))).toEqual(result);
});

test("inserting a new equal scene never inherits an old scene-scoped grant",()=>{
  const result=review([{id:"insert",kind:"insert",at:boundary(base,1),text:"INT. SAME - DAY\n\nALICE\nNew words.\n\n"}]);
  expect(result.conflicts).toEqual([]);expect(result.candidate!.characters[0]!.permission.sceneNumbers).toEqual([2]);
  expect(()=>assertCharacterPermission(result.candidate!.characters[0]!,1,NOW+1000)).toThrow(/not permitted/);
  expect(result.scenes).toHaveLength(2);expect(result.scenes.some(scene=>scene.afterSceneNumber===1)).toBe(false);
});

test("deleted and same-text-replaced scene settings remain explicit conflicts instead of silently dropping or transferring scope",()=>{
  for(const operation of [{id:"delete",kind:"delete",block:block(base,1,6)},{id:"replace",kind:"replace",block:block(base,1,2),text:"INT. SAME - DAY\r\n"}] as LivingScriptStructureOperation[]){
    const result=review([operation]);expect(result.candidate).toBeNull();
    expect(new Set(result.conflicts.map(conflict=>conflict.field))).toEqual(new Set(["permission","wardrobe","scene-binding","performance"]));
    expect(result.conflicts.every(conflict=>conflict.beforeSceneNumber===1)).toBe(true);expect(result.input.casting).toEqual(cast());
  }
});

test("changed dialogue in the same physical scene rebinds source hashes and exposes content change while retaining artistic intent",()=>{
  const saved=cast(),result=review([{id:"words",kind:"replace",block:block(base,4,5),text:"Something new.\r\n"}],saved),next=result.candidate!;
  expect(result.conflicts).toEqual([]);expect(result.changes.some(change=>change.field==="performance"&&change.contentChanged)).toBe(true);
  const old=saved.characters[0]!.scenePerformances![0]!,current=next.characters[0]!.scenePerformances![0]!;
  expect(current.sourceHash).not.toBe(old.sourceHash);expect(current.notes).toBe(old.notes);expect(current.controls).toEqual(old.controls);
  expect(next.characters[0]!.permission).toEqual(saved.characters[0]!.permission);expect(next.characters[0]!.wardrobe).toEqual(saved.characters[0]!.wardrobe);
});

test("scope kind, revocation and expiration are preserved; a mapping review never grants current use",()=>{
  for(const state of ["project","revoked","expired"]){
    const value=cast(state!=="project"),actor=value.characters[0]!;
    if(state==="revoked")actor.permission.status="revoked";if(state==="expired")actor.permission.expiresAt=new Date(NOW-1).toISOString();
    const saved=castingSnapshot(PROJECT,4,[actor],NOW),result=review([{id:"move",kind:"move",block:block(base,1,6),to:boundary(base,10)}],saved),next=result.candidate!.characters[0]!;
    const {sceneNumbers:_a,...old}=saved.characters[0]!.permission,{sceneNumbers:_b,...current}=next.permission;expect(current).toEqual(old);
    if(state==="project")expect(next.permission.sceneNumbers).toEqual([]);else expect(()=>assertCharacterPermission(next,2,NOW+1000)).toThrow(/not permitted/);
  }
});

test("unchanged document and settings retain the exact snapshot without artificial version increments",()=>{
  const original=cast();original.characters[0]!.sceneBindings.reverse();const saved=castingSnapshot(PROJECT,4,original.characters,NOW),result=compileLivingScriptCastRebind({before,after:before,casting:saved},NOW+1000);
  expect(result.candidate).toEqual(saved);expect(result.changes).toEqual([]);expect(result.conflicts).toEqual([]);
});

test("a scoped permission or wardrobe without its saved scene binding cannot become a rebound candidate",()=>{
  const saved=cast();saved.characters[0]!.sceneBindings=[];
  const result=review([{id:"move",kind:"move",block:block(base,1,6),to:boundary(base,10)}],castingSnapshot(PROJECT,4,saved.characters,NOW));
  expect(result.candidate).toBeNull();expect(result.conflicts.map(conflict=>conflict.field)).toEqual(["permission","wardrobe","wardrobe"]);
  expect(result.conflicts.every(conflict=>conflict.reason.includes("saved scene binding"))).toBe(true);
});

test("foreign, noncontiguous and altered-lock contexts cannot establish casting ancestry",()=>{
  for(const context of [{projectId:PROJECT,version:2,text:TEXT,locks:[]},{projectId:"foreign",version:1,text:TEXT,locks:[]},{projectId:PROJECT,version:1,text:TEXT,locks:[{startLine:1,endLine:2}]}]){
    const after=compileLivingScriptDocument({base:createLivingScriptStructureBase(context),ancestry:[]});
    expect(()=>compileLivingScriptCastRebind({before,after,casting:cast()},NOW+1000)).toThrow(/ancestry|ancestor/);
  }
  const one=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"one",kind:"insert",at:boundary(base,10),text:"Third.\n"}]}),middle=compileLivingScriptDocument({base:one.after,ancestry:[one]});
  expect(()=>compileLivingScriptCastRebind({before:middle,after:before,casting:cast()},NOW+1000)).toThrow(/previously accepted cast origin/);
});

test("stale settings and resealed tampering reject; portable accessors are never invoked",()=>{
  const saved=cast();saved.characters[0]!.sceneBindings[0]!.heading="INT. WRONG - DAY";
  expect(()=>compileLivingScriptCastRebind({before,after:before,casting:castingSnapshot(PROJECT,4,saved.characters,NOW)},NOW+1000)).toThrow(/stale/);
  const result=review([{id:"move",kind:"move",block:block(base,1,6),to:boundary(base,10)}]),changed=structuredClone(result);changed.candidate!.characters[0]!.permission.sceneNumbers=[1,2];
  expect(()=>validateLivingScriptCastRebind(reseal(changed))).toThrow(/correspondence/);
  let calls=0;const accessor={before,after:before,origin:proposeLivingScriptCastOrigin(before,cast()),get casting(){calls++;return cast();}};expect(()=>compileAnchored(accessor,NOW)).toThrow(/accessors/);expect(calls).toBe(0);
  expect(()=>compileLivingScriptCastRebind({before,after:before,casting:cast(),ignored:true} as Omit<LivingScriptCastRebindInput,"origin">,NOW)).toThrow(/exact/);
  expect(()=>compileLivingScriptCastRebind({before,after:before,casting:cast()},NOW-1)).toThrow(/review time/);
});

test("unsupported physical constructs produce a blocked review without an executable cast candidate",()=>{
  const badBase=createLivingScriptStructureBase({projectId:PROJECT,version:1,text:"Unknown preamble\nINT. A - DAY\nAction.\n",locks:[]}),document=compileLivingScriptDocument({base:badBase,ancestry:[]}),result=compileLivingScriptCastRebind({before:document,after:document,casting:castingSnapshot(PROJECT,0,[],NOW)},NOW);
  expect(result.candidate).toBeNull();expect(result.conflicts).toHaveLength(1);expect(result.conflicts[0]!.field).toBe("document");
});

test("live permission checks resolve pending versus accepted scene addresses and reject stale or revoked owner state",()=>{
  const saved=cast(),result=review([{id:"move",kind:"move",block:block(base,1,6),to:boundary(base,10)}],saved),pending={documentRevision:before.revision,casting:saved},accepted={documentRevision:result.input.after.revision,casting:result.candidate!};
  expect(()=>assertLivingScriptCastRebindCurrent(result,pending,[ACTOR],2,NOW+2000)).not.toThrow();
  expect(()=>assertLivingScriptCastRebindCurrent(result,accepted,[ACTOR],2,NOW+2000)).not.toThrow();
  expect(()=>assertLivingScriptCastRebindCurrent(result,pending,[ACTOR],1,NOW+2000)).toThrow(/not permitted/);
  expect(()=>assertLivingScriptCastRebindCurrent(result,{...pending,documentRevision:"a".repeat(64)},[ACTOR],2,NOW+2000)).toThrow(/screenplay changed/);
  const revoked=structuredClone(saved);revoked.characters[0]!.permission.status="revoked";
  expect(()=>assertLivingScriptCastRebindCurrent(result,{...pending,casting:castingSnapshot(PROJECT,5,revoked.characters,NOW+1001)},[ACTOR],2,NOW+2000)).toThrow(/Current casting changed/);
  expect(()=>assertLivingScriptCastRebindCurrent(result,{...pending,casting:result.candidate!},[ACTOR],2,NOW+2000)).toThrow(/Current casting changed/);
  expect(()=>assertLivingScriptCastRebindCurrent(result,pending,[ACTOR],2,Date.parse("2027-02-01"))).toThrow(/not permitted/);
  expect(()=>assertLivingScriptCastRebindCurrent(result,pending,[ACTOR,ACTOR],2,NOW+2000)).toThrow(/cast identities/);
  expect(()=>assertLivingScriptCastRebindCurrent(result,pending,[ACTOR],3,NOW+2000)).toThrow(/structural scene/);
});

test("project grants can cover a newly introduced scene while a scoped grant cannot",()=>{
  for(const scoped of [false,true]){
    const saved=cast(scoped),result=review([{id:"insert",kind:"insert",at:boundary(base,1),text:"INT. SAME - DAY\n\nALICE\nNew words.\n\n"}],saved),check=()=>assertLivingScriptCastRebindCurrent(result,{documentRevision:before.revision,casting:saved},[ACTOR],1,NOW+2000);
    if(scoped)expect(check).toThrow(/not permitted|scene-scoped/);else expect(check).not.toThrow();
  }
});

test("an old cast cannot be paired with a later equal-heading document; exact origin replay supports subsequent edits",()=>{
  const saved=cast(),first=review([{id:"move",kind:"move",block:block(base,1,6),to:boundary(base,10)}],saved),origin=advanceLivingScriptCastOrigin(first);
  expect(origin.steps).toHaveLength(1);expect(Object.keys(origin.steps[0]!).sort()).toEqual(["afterAncestryLength","afterDocumentRevision","castingRevision","createdAt"]);
  expect(()=>compileAnchored({before:first.input.after,after:first.input.after,casting:saved,origin:first.input.origin},NOW+2000)).toThrow(/not bound/);
  expect(()=>compileAnchored({before:first.input.after,after:first.input.after,casting:saved,origin},NOW+2000)).toThrow(/not bound/);
  expect(()=>proposeLivingScriptCastOrigin(first.input.after,saved)).toThrow(/previously accepted/);
  const noChange=compileAnchored({before:first.input.after,after:first.input.after,casting:first.candidate!,origin},NOW+2000);
  expect(noChange.candidate!.characters[0]!.permission.sceneNumbers).toEqual([2]);expect(advanceLivingScriptCastOrigin(noChange)).toEqual(origin);
  const current=first.input.after.context.base,patch=compileLivingScriptStructure(current,{baseRevision:current.revision,operations:[{id:"next-line",kind:"replace",block:block(current,8,9),text:"Revised first.\r\n"}]}),after=compileLivingScriptDocument({base:patch.after,ancestry:[...first.input.after.context.ancestry,patch]}),second=compileAnchored({before:first.input.after,after,casting:first.candidate!,origin},NOW+3000),advanced=advanceLivingScriptCastOrigin(second);
  expect(second.candidate!.characters[0]!.permission.sceneNumbers).toEqual([2]);expect(advanced.steps).toHaveLength(2);
  expect(compileAnchored({before:after,after,casting:second.candidate!,origin:advanced},NOW+4000).candidate).toEqual(second.candidate);
  const forged=structuredClone(advanced);forged.steps[0]!.afterAncestryLength=2;
  expect(()=>compileAnchored({before:after,after,casting:second.candidate!,origin:reseal(forged)},NOW+4000)).toThrow(/exact document revision/);
});
