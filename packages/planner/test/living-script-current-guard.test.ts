import {afterAll,beforeAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {parseFountain} from "../../parser/src/index";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {compileLivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact,type LivingScriptRenderInputs} from "../src/living-script-generation";
import {currentCasting,castingSnapshot} from "../src/casting";
import {currentDirection,directionEntry,directionSnapshot,sourceDirection} from "../src/direction";
import {sourcePlan} from "../src/scene-cuts";
import {createEditSequence,emptyEditLibrary} from "../src/edit-library";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import {createLivingScriptProposal,emptyLivingScriptProposals} from "../src/living-script-proposals";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {assertLivingScriptGenerationCurrent,createLivingScriptCurrentGuard,createLivingScriptJobPlan,type LivingScriptJobPlan} from "../src/living-script-jobs";
import type {PersistedProject} from "../../api/src/index";
import type {ReferenceAsset} from "../src/references";

let fixture:Awaited<ReturnType<typeof dubStudio>>,base:Awaited<ReturnType<typeof prepare>>,now:number;
async function prepare(){
  const source=await inspectEditSource(fixture.film,"Retained directed source",fixture.paths.artifactRoot,async()=>{}),project=structuredClone(fixture.projects.snapshot().projects[0]!);
  const library=createEditSequence(emptyEditLibrary(),project.id,[source],"guard-cut","Saved cut",source.facts.id,320,180,0,now),index=compileEditScriptSource(source),entry=index.entries.find(value=>value.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:fixture.film.scriptVersion,text:fixture.film.scriptText},replacement:"Welcome back to the garden."});
  const parent=deriveEditAssemblyParent(project.id,library,"guard-cut"),navigation=projectEditScriptNavigation("guard-cut",parent.historyRevision,parent.timeline,[index]);
  project.editLibrary=library;return {source,project,patch,parent,navigation,binding:bindOriginalEditSource(source)};
}
function planned(project=structuredClone(base.project),change?:(candidate:LivingScriptRenderInputs)=>void){
  const candidate={...fixture.film,scriptVersion:base.patch.after.version,scriptText:base.patch.after.text,casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)};change?.(candidate);
  const inputs=compileLivingScriptGenerationImpact(base.source,base.patch,candidate,now).candidateInputs;
  const request={id:"guard-proposal",label:"Changed greeting",sequenceId:"guard-cut",historyRevision:base.parent.historyRevision,editorialRevision:base.project.editLibrary!.revision,navigationRevision:base.navigation.revision,patch:base.patch,candidate:inputs,baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}};
  const saved=createLivingScriptProposal(emptyLivingScriptProposals(project.id),project.id,base.project.editLibrary!,request,0,now);project.livingScriptProposals=saved.library;
  return {project,plan:createLivingScriptJobPlan(saved.proposal,base.binding,{role:"render"},now+1)};
}
beforeAll(async()=>{fixture=await dubStudio();now=Date.now();base=await prepare();},120000);
afterAll(async()=>{await fixture?.close();});

test("a guard retains independently validated immutable evidence and matches the whole portable plan",()=>{
  const {plan,project}=planned(),saved=structuredClone(plan),guard=createLivingScriptCurrentGuard(plan);
  expect(Object.isFrozen(guard)).toBe(true);expect(guard.bytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(plan)));
  expect(guard.matches(plan)).toBe(true);expect(guard.matches(JSON.parse(JSON.stringify(plan)))).toBe(true);
  const reorder=(value:any):any=>Array.isArray(value)?value.map(reorder):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
  expect(guard.matches(reorder(plan))).toBe(true);
  plan.inputs.scriptText+="!";plan.proposal.request.label="Changed by caller";
  expect(guard.matches(plan)).toBe(false);expect(guard.matches(saved)).toBe(true);
  expect(()=>guard.assert(project,fixture.film,now+2)).not.toThrow();expect(()=>assertLivingScriptGenerationCurrent(saved,project,fixture.film,now+2)).not.toThrow();
  for(const mutate of [(p:LivingScriptJobPlan)=>{p.inputs.scriptVersion++;},(p:LivingScriptJobPlan)=>{p.binding.files[0]!.bytes++;},(p:LivingScriptJobPlan)=>{p.proposal.request.label="Unsealed mutation";},(p:LivingScriptJobPlan)=>{p.createdAt=new Date(now+2).toISOString();}]){
    const changed=structuredClone(saved);mutate(changed);expect(changed.revision).toBe(saved.revision);expect(guard.matches(changed)).toBe(false);
  }
});

test("unknown, nonportable and accessor plans fail closed before getters run",()=>{
  const {plan}=planned(),guard=createLivingScriptCurrentGuard(plan);let reads=0;
  const getter={...plan};Object.defineProperty(getter,"inputs",{enumerable:true,get(){reads++;return plan.inputs;}});
  expect(guard.matches(getter)).toBe(false);expect(reads).toBe(0);expect(()=>createLivingScriptCurrentGuard(getter)).toThrow();expect(reads).toBe(0);
  const hidden={...plan};Object.defineProperty(hidden,"hidden",{value:1});const symbol={...plan,[Symbol("hidden")]:1},sparse=structuredClone(plan);delete sparse.shotReuse.forceShotIds[0];
  for(const value of [null,undefined,{...plan,extra:true},{...plan,inputs:{...plan.inputs,unknown:NaN}},hidden,symbol,sparse])expect(guard.matches(value)).toBe(false);
  const forged=structuredClone(plan);forged.inputs.scriptText+="!";const {revision:_revision,...data}=forged;forged.revision=contentHash(data);expect(()=>createLivingScriptCurrentGuard(forged)).toThrow();
});

test("every invocation rechecks current project, exact proposal and settings without mutating callers",()=>{
  const {plan,project}=planned(),guard=createLivingScriptCurrentGuard(plan),before=structuredClone(project);
  const mutations=[(p:PersistedProject)=>{p.id="other-project";},(p:PersistedProject)=>{p.rightsAttestedAt=null;},(p:PersistedProject)=>{p.deleteAfter=new Date(now+2).toISOString();},(p:PersistedProject)=>{p.versions.at(-1)!.text+="!";},(p:PersistedProject)=>{p.editLibrary!.revision="0".repeat(64);},(p:PersistedProject)=>{p.livingScriptProposals!.proposals[0]!.request.label="Same revision, changed body";},(p:PersistedProject)=>{p.livingScriptProposals!.proposals=[];},(p:PersistedProject)=>{const cast=currentCasting(p.id,p.castingHistory);p.castingHistory!.push(castingSnapshot(p.id,cast.version+1,cast.characters,now));},(p:PersistedProject)=>{const direction=currentDirection(p.id,p.directionHistory);(p.directionHistory??=[]).push(directionSnapshot(p.id,direction.version+1,direction.entries,now));}];
  for(const mutate of mutations){expect(()=>guard.assert(project,fixture.film,now+2)).not.toThrow();const changed=structuredClone(project);mutate(changed);const frozen=structuredClone(changed);expect(()=>guard.assert(changed,fixture.film,now+2)).toThrow();expect(()=>assertLivingScriptGenerationCurrent(plan,changed,fixture.film,now+2)).toThrow();expect(changed).toEqual(frozen);}
  expect(()=>guard.assert(null,fixture.film,now+2)).toThrow();expect(project).toEqual(before);
});

test("carrier withdrawal, changed media and retention expiry remain live after a successful guard",()=>{
  const {plan,project}=planned(),guard=createLivingScriptCurrentGuard(plan);
  for(const carrier of [undefined,{...fixture.film,status:"cancelled" as const},{...fixture.film,output:{...fixture.film.output!,mp4Path:"changed.mp4"}},{...fixture.film,completedAt:new Date(0).toISOString()},{...fixture.film,linkExpiresAt:new Date(0).toISOString()}]){
    expect(()=>guard.assert(project,fixture.film,now+2)).not.toThrow();expect(()=>guard.assert(project,carrier,now+2)).toThrow();expect(()=>assertLivingScriptGenerationCurrent(plan,project,carrier,now+2)).toThrow();
  }
  const future=Date.parse(fixture.film.linkExpiresAt!);expect(()=>guard.assert({...project,deleteAfter:new Date(future+60000).toISOString()},fixture.film,future)).toThrow();
});

test("candidate cast expiry and scene permission use each invocation's current clock",()=>{
  const project=structuredClone(base.project),cast=currentCasting(project.id,project.castingHistory),expires=now+60000;
  project.castingHistory!.push(castingSnapshot(project.id,cast.version+1,cast.characters.map(character=>({...character,permission:{...character.permission,expiresAt:new Date(expires).toISOString()}})),now));
  const {plan,project:owner}=planned(project),guard=createLivingScriptCurrentGuard(plan);
  expect(()=>guard.assert(owner,fixture.film,expires-1)).not.toThrow();expect(()=>guard.assert(owner,fixture.film,expires)).toThrow();expect(()=>assertLivingScriptGenerationCurrent(plan,owner,fixture.film,expires)).toThrow();
  expect(()=>guard.assert(owner,fixture.film,now+2)).not.toThrow();
});

test("character references and frame anchors retain current exact catalog checks",()=>{
  for(const kind of ["reference","anchor"] as const){
    const project=structuredClone(base.project),asset:ReferenceAsset={schema:"hv-reference/1",id:crypto.randomUUID(),projectId:project.id,sha256:"1".repeat(64),originalSha256:"1".repeat(64),bytes:128,width:16,height:16,contentType:"image/png",createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()};project.referenceAssets=[asset];
    if(kind==="reference"){const cast=currentCasting(project.id,project.castingHistory);project.castingHistory!.push(castingSnapshot(project.id,cast.version+1,cast.characters.map(character=>({...character,references:[asset]})),now));}
    const {plan,project:owner}=planned(project,kind==="anchor"?candidate=>{const shot=sourcePlan(parseFountain(candidate.scriptText),undefined,7000,24)[0]!;candidate.direction=directionSnapshot(project.id,1,[directionEntry(shot,{...sourceDirection(shot),frameAnchors:{frames:[{at:0,asset}],fallback:"storyboard"}})],now);}:undefined),guard=createLivingScriptCurrentGuard(plan);
    expect(()=>guard.assert(owner,fixture.film,now+2)).not.toThrow();
    for(const catalog of [[],[{...asset,sha256:"2".repeat(64)}]]){const changed={...owner,referenceAssets:catalog};expect(()=>guard.assert(changed,fixture.film,now+2)).toThrow();expect(()=>assertLivingScriptGenerationCurrent(plan,changed,fixture.film,now+2)).toThrow();}
    expect(()=>guard.assert(owner,fixture.film,now+2)).not.toThrow();
  }
});
