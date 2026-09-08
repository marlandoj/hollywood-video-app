import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import * as fs from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {ProjectService,type PersistedState} from "../src/index";
import {PROJECT_TOKEN_TTL_MS} from "../src/tokens";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {deriveEditAssemblyParent,type EditAssemblyCarrier} from "../../planner/src/edit-assembly-parent";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {castingSnapshot,currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import type {LivingScriptProposalRequest} from "../../planner/src/living-script-proposals";

let fixture:Awaited<ReturnType<typeof dubStudio>>,baseline:PersistedState,input:LivingScriptProposalRequest,retained:EditAssemblyCarrier[],now:number;
beforeAll(async()=>{
  fixture=await dubStudio();now=Date.now();
  const source=await inspectEditSource(fixture.film,"Cache original",fixture.paths.artifactRoot,async()=>{}),binding=bindOriginalEditSource(source);
  const library=fixture.projects.createEditSequence(fixture.owner.token,[source],"cache-cut","Original cut",source.facts.id,320,180,0,now,[binding])!;
  const parent=deriveEditAssemblyParent(fixture.owner.projectId,library,"cache-cut"),index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:fixture.film.scriptVersion,text:fixture.film.scriptText},replacement:"Welcome back to the garden."});
  const candidate=compileLivingScriptGenerationImpact(source,patch,{...fixture.film,scriptVersion:patch.after.version,scriptText:patch.after.text},now).candidateInputs;
  const current=fixture.projects.peekProject(fixture.owner.projectId)!,navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]);
  input={id:"cache-review",label:"Cache review",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,editorialRevision:library.revision,navigationRevision:navigation.revision,patch,candidate,baseline:{casting:currentCasting(current.id,current.castingHistory),direction:currentDirection(current.id,current.directionHistory)}};
  retained=[{binding,current:fixture.film}];fixture.projects.createLivingScriptProposal(fixture.owner.token,input,0,retained,now);baseline=fixture.projects.snapshot();
},180000);
afterAll(async()=>{await fixture?.close();});
const project=(state:PersistedState)=>state.projects.find(value=>value.id===fixture.owner.projectId)!;
function saved(name:string,state=baseline){const path=join(fixture.root,name+".json");fs.writeFileSync(path,JSON.stringify(state));return {path,service:new ProjectService(path)};}
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};

test("unchanged disk rebuilds mutable projects, histories and VersionStore without exposing cache references",()=>{
  const {service}=saved("memo-mutations"),expected=structuredClone(service.snapshot()),first=service.authorize(fixture.owner.token)!;
  first.editLibrary.sequences[0]!.label="Mutated cut";first.livingScriptProposals.proposals[0]!.impact.parent.timeline.clips[0]!.from++;
  first.versions.history()[0]!.text="Mutated retained script";first.versions.commit("Later in-memory script");
  const second=service.authorize(fixture.owner.token)!;expect(second).not.toBe(first);expect(second.versions).not.toBe(first.versions);expect(service.snapshot()).toEqual(expected);
  second.livingScriptProposals.proposals.length=0;expect(ProjectService.fromState(expected).snapshot()).toEqual(expected);expect(service.authorize(fixture.owner.token)!.livingScriptProposals.proposals).toHaveLength(1);
});

test("external same-size and same-mtime writes, current rights and takedowns are observed immediately",()=>{
  const {path,service}=saved("memo-external"),before=fs.statSync(path),changed=structuredClone(baseline),p=project(changed);
  const original=p.versions.at(-1)!.text;p.versions.push({...p.versions.at(-1)!,version:p.versions.at(-1)!.version+1,text:original+"\n\nA warm day."});fs.writeFileSync(path,JSON.stringify(changed));
  expect(service.authorize(fixture.owner.token)!.versions.latest()!.text).toEndWith("A warm day.");
  const bytes=fs.readFileSync(path,"utf8"),cold=bytes.replace("A warm day.","A cold day.");expect(cold.length).toBe(bytes.length);fs.writeFileSync(path,cold);fs.utimesSync(path,before.atime,before.mtime);
  expect(service.authorize(fixture.owner.token)!.versions.latest()!.text).toEndWith("A cold day.");
  const rights=JSON.parse(cold) as PersistedState;project(rights).rightsAttestedAt=null;fs.writeFileSync(path,JSON.stringify(rights));
  expect(service.authorize(fixture.owner.token)!.rightsAttestedAt).toBeNull();expect(()=>service.createLivingScriptProposal(fixture.owner.token,input,0,retained,now)).toThrow();
  const removed={...baseline,takenDown:[fixture.owner.projectId]};fs.writeFileSync(path,JSON.stringify(removed));expect(service.authorize(fixture.owner.token)).toBeNull();
  fs.writeFileSync(path,JSON.stringify(baseline));expect(service.authorize(fixture.owner.token)).not.toBeNull();
});

test("failed persisted edits cannot replace the unchanged disk entry or survive its next reload",()=>{
  const {path,service}=saved("memo-failed-save"),before=structuredClone(service.snapshot()),bytes=fs.readFileSync(path,"utf8"),rename=fs.renameSync;
  service.authorize(fixture.owner.token);const spy=spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(to)===path)throw new Error("Synthetic cache rename failure");return rename(from,to);});
  try{expect(()=>service.editScript(fixture.owner.token,"INT. ROOM - DAY\n\nA failed edit.",now)).toThrow("Synthetic cache rename failure");expect(fs.readFileSync(path,"utf8")).toBe(bytes);}finally{spy.mockRestore();}
  service.authorize(fixture.owner.token);expect(service.snapshot()).toEqual(before);expect(new ProjectService(path).snapshot()).toEqual(before);
  expect(service.editScript(fixture.owner.token,"INT. ROOM - DAY\n\nA saved edit.",now)!.version).toBe(project(before).versions.at(-1)!.version+1);
});

test("warm validation cannot hide changed seals, rehashed forged impacts or missing companion screenplay versions",()=>{
  const {path,service}=saved("memo-invalid");service.authorize(fixture.owner.token);
  const seal=structuredClone(baseline);project(seal).livingScriptProposals!.proposals[0]!.request.label="Unsealed change";
  const impact=structuredClone(baseline),proposals=project(impact).livingScriptProposals!;proposals.proposals[0]!.impact.generation.generateShotIds=[];proposals.proposals[0]=reseal(proposals.proposals[0]!);project(impact).livingScriptProposals=reseal(proposals);
  const missing=structuredClone(baseline);project(missing).versions=project(missing).versions.filter(version=>version.version!==input.patch.before.version);
  const foreign=structuredClone(baseline);project(foreign).id="foreign-project";
  for(const invalid of [seal,impact,missing,foreign]){fs.writeFileSync(path,JSON.stringify(invalid));expect(()=>service.authorize(fixture.owner.token)).toThrow();fs.writeFileSync(path,JSON.stringify(baseline));expect(service.authorize(fixture.owner.token)!.livingScriptProposals).toEqual(project(baseline).livingScriptProposals!);}
  // JSONB key reordering is an ordinary cache miss, with identical validated content.
  const reordered=JSON.parse(JSON.stringify(baseline),(key,value)=>value&&typeof value==="object"&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value) as PersistedState;
  expect(ProjectService.fromState(reordered).snapshot()).toEqual(baseline);
});

test("warm historical metadata grants neither expired tokens nor time-expired character permissions",()=>{
  const state=structuredClone(baseline),p=project(state),cast=p.castingHistory!.at(-1)!,characters=structuredClone(cast.characters),expires=now+1000;
  characters.find(character=>character.id===fixture.id)!.permission.expiresAt=new Date(expires).toISOString();p.castingHistory!.push(castingSnapshot(p.id,cast.version+1,characters,now));
  const {path,service}=saved("memo-current-time",state),bytes=fs.readFileSync(path,"utf8");
  expect(service.createLivingScriptProposal(fixture.owner.token,input,0,retained,now)!.replayed).toBe(true);
  expect(()=>service.createLivingScriptProposal(fixture.owner.token,input,0,retained,expires)).toThrow("not permitted");expect(fs.readFileSync(path,"utf8")).toBe(bytes);
  expect(service.authorize(fixture.owner.token,now+PROJECT_TOKEN_TTL_MS+1000)).toBeNull();expect(service.authorize(fixture.owner.token,now)).not.toBeNull();
});
