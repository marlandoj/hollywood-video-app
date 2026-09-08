import {beforeAll,afterAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {compileLivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../src/living-script-generation";
import {currentCasting,castingSnapshot} from "../src/casting";
import {currentDirection} from "../src/direction";
import {createEditSequence,emptyEditLibrary} from "../src/edit-library";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import {emptyLivingScriptProposals,createLivingScriptProposal} from "../src/living-script-proposals";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {createLivingScriptJobPlan,validateLivingScriptJobPlan,assertLivingScriptGenerationCurrent,assertLivingScriptJobInputs,type LivingScriptJobPlan} from "../src/living-script-jobs";
import type {Job} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";

let fixture:Awaited<ReturnType<typeof dubStudio>>,preview:Awaited<ReturnType<typeof proposalFor>>,final:Awaited<ReturnType<typeof proposalFor>>,now:number;
const oldPool=process.env.HV_PROVIDER_POOL;
async function proposalFor(film:Job,id:string){
  const source=await inspectEditSource(film,"Original film",fixture.paths.artifactRoot,async()=>{}),project=structuredClone(fixture.projects.snapshot().projects[0]!);
  const editorial=createEditSequence(emptyEditLibrary(),project.id,[source],id,"Saved cut",source.facts.id,320,180,0,now),index=compileEditScriptSource(source),entry=index.entries.find(value=>value.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:film.scriptVersion,text:film.scriptText},replacement:"Welcome back to the garden."});
  const candidate=compileLivingScriptGenerationImpact(source,patch,{...film,scriptVersion:patch.after.version,scriptText:patch.after.text},now).candidateInputs;
  const parent=deriveEditAssemblyParent(project.id,editorial,id),navigation=projectEditScriptNavigation(id,parent.historyRevision,parent.timeline,[index]);
  const input={id:"proposal-"+id,label:"Revised greeting",sequenceId:id,historyRevision:parent.historyRevision,editorialRevision:editorial.revision,navigationRevision:navigation.revision,patch,candidate,
    baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}};
  const saved=createLivingScriptProposal(emptyLivingScriptProposals(project.id),project.id,editorial,input,0,now);
  project.editLibrary=editorial;project.livingScriptProposals=saved.library;
  const binding=bindOriginalEditSource(source),plan=createLivingScriptJobPlan(saved.proposal,binding,{role:"render"},now+1);
  return {source,project,proposal:saved.proposal,binding,plan,film};
}
beforeAll(async()=>{
  process.env.HV_PROVIDER_POOL='["mock"]';fixture=await dubStudio();now=Date.now();preview=await proposalFor(fixture.film,"preview-cut");
  const approved=await fixture.call(fixture.base+"/animatic/decision","POST",{animaticJobId:fixture.film.id,decision:"approved"},fixture.owner.token);expect(approved.status).toBe(201);
  const admitted=await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:"final-original",stage:"final",animaticJobId:fixture.film.id},fixture.owner.token);expect(admitted.status).toBe(202);
  const film=await fixture.worker();expect(film?.status).toBe("done");now=Date.now();final=await proposalFor(film!,"final-cut");
},180000);
afterAll(async()=>{await fixture?.close();if(oldPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=oldPool;});
const reseal=<T extends {revision:string}>(value:T):T=>{const{revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};
test("pending generation retains exact changed and unchanged shots without saving the proposed screenplay",()=>{
  for(const f of [preview,final]){const before=structuredClone(f.project),plan=createLivingScriptJobPlan(f.proposal,f.binding,{role:"render"},now+1);
    expect(plan.inputs.scriptText).toBe(f.proposal.request.patch.after.text);expect(plan.inputs.scriptVersion).toBe(f.project.versions.at(-1)!.version+1);
    expect(plan.shotReuse.forceShotIds).toEqual(["shot-1-1"]);expect(plan.shotReuse.shots).toEqual(f.proposal.impact.generation.reusableRecords);expect(plan.shotReuse.shots.length).toBeGreaterThan(0);
    expect(validateLivingScriptJobPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);expect(()=>assertLivingScriptGenerationCurrent(plan,f.project,f.film,now+2)).not.toThrow();
    expect(()=>assertLivingScriptJobInputs(plan,{...plan.inputs,shotReuse:plan.shotReuse})).not.toThrow();expect(f.project).toEqual(before);
    plan.proposal.request.label="Caller edit";expect(f.proposal.request.label).toBe("Revised greeting");
  }
});
test("a final proposal has a distinct explicitly pinned preview and never reuses final-stage media for it",()=>{
  const providerPlan=createProviderPlan("animatic",preview.plan.inputs.providerPlan!.maxShotUsd,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["mock"]'}),plan=createLivingScriptJobPlan(final.proposal,final.binding,{role:"preview",providerPlan},now+2);
  expect(plan.inputs.stage).toBe("animatic");expect(plan.inputs.scriptText).toBe(final.plan.inputs.scriptText);expect(plan.inputs.casting).toEqual(final.plan.inputs.casting);expect(plan.inputs.direction).toEqual(final.plan.inputs.direction);
  expect(plan.shotReuse.shots).toEqual([]);expect(plan.shotReuse.forceShotIds.length).toBe(final.proposal.impact.generation.shots.filter(value=>value.treatment!=="removed").length);
  expect(plan.revision).not.toBe(final.plan.revision);expect(validateLivingScriptJobPlan(plan)).toEqual(plan);
  expect(()=>createLivingScriptJobPlan(preview.proposal,preview.binding,{role:"preview",providerPlan},now+2)).toThrow("pending final film");
  expect(()=>createLivingScriptJobPlan(final.proposal,final.binding,{role:"preview",providerPlan:final.plan.inputs.providerPlan!},now+2)).toThrow("animatic provider");
});
test("resealing does not hide changed proposal identity, screenplay, provider or selective generation",()=>{
  for(const mutate of [(p:LivingScriptJobPlan)=>{p.inputs.scriptText+="!";},(p:LivingScriptJobPlan)=>{p.inputs.scriptVersion++;},(p:LivingScriptJobPlan)=>{p.shotReuse.shots=[];},(p:LivingScriptJobPlan)=>{p.shotReuse.forceShotIds=[];},(p:LivingScriptJobPlan)=>{p.proposal.request.label="Changed";},(p:LivingScriptJobPlan)=>{p.inputs.providerPlan!.maxShotUsd++;}]){
    const plan=structuredClone(preview.plan);mutate(plan);expect(()=>validateLivingScriptJobPlan(reseal(plan))).toThrow();
  }
  for(const change of [{scriptText:preview.plan.inputs.scriptText+"!"},{scriptVersion:preview.plan.inputs.scriptVersion+1},{shotReuse:undefined},{stage:"final" as const}])expect(()=>assertLivingScriptJobInputs(preview.plan,{...preview.plan.inputs,shotReuse:preview.plan.shotReuse,...change})).toThrow();
});
test("current project fences reject stale script, cut, proposal, settings, rights and carrier while leaving history unchanged",()=>{
  for(const mutate of [(p:PersistedProject)=>{p.versions.at(-1)!.text+="!";},(p:PersistedProject)=>{p.editLibrary!.revision="0".repeat(64);},(p:PersistedProject)=>{p.livingScriptProposals!.proposals=[];},(p:PersistedProject)=>{p.rightsAttestedAt=null;},(p:PersistedProject)=>{p.deleteAfter=new Date(0).toISOString();},(p:PersistedProject)=>{const c=currentCasting(p.id,p.castingHistory);p.castingHistory!.push(castingSnapshot(p.id,c.version+1,c.characters,now));}]){
    const project=structuredClone(preview.project);mutate(project);const before=structuredClone(project);expect(()=>assertLivingScriptGenerationCurrent(preview.plan,project,preview.film,now+2)).toThrow();expect(project).toEqual(before);
  }
  expect(()=>assertLivingScriptGenerationCurrent(preview.plan,null,preview.film,now+2)).toThrow();
  for(const carrier of [undefined,{...preview.film,status:"cancelled" as const},{...preview.film,linkExpiresAt:new Date(0).toISOString()},{...preview.film,output:{...preview.film.output!,mp4Path:"changed.mp4"}}])expect(()=>assertLivingScriptGenerationCurrent(preview.plan,preview.project,carrier,now+2)).toThrow();
  expect(validateLivingScriptJobPlan(preview.plan)).toEqual(preview.plan);
});
test("a prospective artistic snapshot cannot attest a new actor during pending generation",()=>{
  const p=structuredClone(preview.proposal),baseline=p.request.baseline.casting;
  p.request.candidate.casting=castingSnapshot(p.projectId,baseline.version+1,[...baseline.characters,{...baseline.characters[0]!,id:crypto.randomUUID(),name:"NEW CHARACTER",aliases:[]}],now);
  const r=p.request,saved=createLivingScriptProposal(emptyLivingScriptProposals(p.projectId),p.projectId,p.editorial,r,0,now);
  const plan=createLivingScriptJobPlan(saved.proposal,preview.binding,{role:"render"},now+1),project={...structuredClone(preview.project),livingScriptProposals:saved.library};
  expect(()=>assertLivingScriptGenerationCurrent(plan,project,preview.film,now+2)).toThrow("new character permissions");
});
test("nonportable fields, hidden mutations, invalid time and unknown request fields fail before getters run",()=>{
  let reads=0;const getter={...preview.plan};Object.defineProperty(getter,"inputs",{enumerable:true,get(){reads++;return preview.plan.inputs;}});expect(()=>validateLivingScriptJobPlan(getter)).toThrow("accessors");expect(reads).toBe(0);
  expect(()=>createLivingScriptJobPlan(preview.proposal,preview.binding,{role:"render",unexpected:true} as any,now)).toThrow("exact");
  expect(()=>createLivingScriptJobPlan(preview.proposal,preview.binding,null as any,now)).toThrow("pending generation request");
  expect(()=>createLivingScriptJobPlan(preview.proposal,preview.binding,{role:"render"},Date.parse(preview.proposal.createdAt)-1)).toThrow("after its saved proposal");
  expect(()=>validateLivingScriptJobPlan({...preview.plan,createdAt:"2026-09-08"})).toThrow("exact creation time");
  const sparse=structuredClone(preview.plan);delete sparse.shotReuse.forceShotIds[0];expect(()=>validateLivingScriptJobPlan(sparse)).toThrow("dense");
});

test("an otherwise valid proposal cannot expand an existing permission or import an uncatalogued character reference",()=>{
  for(const kind of ["permission","reference"] as const){
    const project=structuredClone(preview.project),request=structuredClone(preview.proposal.request),old=request.baseline.casting;
    if(kind==="permission"){
      const restricted=castingSnapshot(project.id,old.version+1,old.characters.map(character=>({...character,permission:{...character.permission,expiresAt:new Date(now+3600000).toISOString()}})),now);
      project.castingHistory!.push(restricted);request.baseline.casting=restricted;
      request.candidate.casting=castingSnapshot(project.id,restricted.version+1,restricted.characters.map(character=>({...character,permission:{...character.permission,expiresAt:null}})),now);
    }else{
      const reference={schema:"hv-reference/1" as const,id:crypto.randomUUID(),projectId:project.id,sha256:"1".repeat(64),originalSha256:"1".repeat(64),bytes:128,width:16,height:16,contentType:"image/png" as const,createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()};
      request.candidate.casting=castingSnapshot(project.id,old.version+1,old.characters.map(character=>({...character,references:[reference]})),now);
    }
    const saved=createLivingScriptProposal(emptyLivingScriptProposals(project.id),project.id,preview.proposal.editorial,request,0,now);project.livingScriptProposals=saved.library;
    const plan=createLivingScriptJobPlan(saved.proposal,preview.binding,{role:"render"},now+1),before=structuredClone(project);
    expect(()=>assertLivingScriptGenerationCurrent(plan,project,preview.film,now+2)).toThrow(kind==="permission"?"new character permissions":"current asset catalog");expect(project).toEqual(before);
  }
});
