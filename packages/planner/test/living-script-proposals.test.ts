import {beforeAll,afterAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {compileLivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../src/living-script-generation";
import {castingSnapshot} from "../src/casting";
import {directionSnapshot} from "../src/direction";
import {createEditSequence,emptyEditLibrary,changeEditSequence,type EditLibrary} from "../src/edit-library";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import {emptyLivingScriptProposals,createLivingScriptProposal,validateLivingScriptProposals,validateProjectLivingScriptProposals,type LivingScriptProposalRequest,type LivingScriptProposals} from "../src/living-script-proposals";

let fixture:Awaited<ReturnType<typeof dubStudio>>,editorial:EditLibrary,input:LivingScriptProposalRequest,now:number;
beforeAll(async()=>{
  fixture=await dubStudio();const source=await inspectEditSource(fixture.film,"Original film",fixture.paths.artifactRoot,async()=>{});
  now=Date.now();editorial=createEditSequence(emptyEditLibrary(),fixture.owner.projectId,[source],"cut","Saved cut",source.facts.id,320,180,0,now);
  const index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:fixture.film.scriptVersion,text:fixture.film.scriptText},replacement:"Welcome back to the garden."});
  const candidate=compileLivingScriptGenerationImpact(source,patch,{...fixture.film,scriptVersion:patch.after.version,scriptText:patch.after.text},now).candidateInputs;
  const parent=deriveEditAssemblyParent(fixture.owner.projectId,editorial,"cut"),navigation=projectEditScriptNavigation("cut",parent.historyRevision,parent.timeline,[index]);
  const baseline={casting:candidate.casting??castingSnapshot(fixture.owner.projectId,0,[],0),direction:candidate.direction??directionSnapshot(fixture.owner.projectId,0,[],0)};
  input={id:"line-review",label:"Revised greeting",sequenceId:"cut",historyRevision:parent.historyRevision,editorialRevision:editorial.revision,navigationRevision:navigation.revision,patch,candidate,baseline};
},180000);
afterAll(async()=>{await fixture?.close();});
const empty=()=>emptyLivingScriptProposals(fixture.owner.projectId);
const create=(library=empty(),request=input,expectedVersion=0,value=editorial)=>createLivingScriptProposal(library,fixture.owner.projectId,value,request,expectedVersion,now);
const reseal=<T extends {revision:string}>(value:T):T=>{const{revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};

test("immutable review retains complete source context and survives independent JSON restoration",()=>{
  const before=contentHash({editorial,input}),result=create();expect(result.replayed).toBe(false);expect(result.library.version).toBe(1);
  expect(result.proposal.editorial).toEqual(editorial);expect(result.proposal.request).toEqual(input);expect(result.proposal.impact.generation.generateShotIds).toEqual(["shot-1-1"]);
  expect(validateLivingScriptProposals(JSON.parse(JSON.stringify(result.library)),fixture.owner.projectId)).toEqual(result.library);
  expect(contentHash({editorial,input})).toBe(before);result.proposal.request.label="Mutated return";expect(result.library.proposals[0]!.request.label).toBe(input.label);
});
test("exact lost-response replay preserves original time and ignores now-stale optimistic version",()=>{
  const first=create(),changed=changeEditSequence(editorial,fixture.owner.projectId,"cut",{kind:"edit",operation:{kind:"marker",marker:{id:"later",frame:0,label:"Later cut"}},label:"Later edit"},editorial.version,input.historyRevision,now+1);
  const retry=createLivingScriptProposal(first.library,fixture.owner.projectId,changed,input,0,now+60000);
  expect(retry.replayed).toBe(true);expect(retry.library).toEqual(first.library);expect(retry.proposal).toEqual(first.proposal);
  expect(retry.proposal.editorial.revision).not.toBe(changed.revision);
});
test("a request identity cannot be reused with changed review data",()=>{
  const first=create();for(const change of [{label:"Other"},{navigationRevision:"0".repeat(64)},{candidate:{...input.candidate,scriptText:input.candidate.scriptText+"!"}}])expect(()=>create(first.library,{...input,...change})).toThrow("different screenplay proposal");
  expect(first.library.proposals[0]!.request).toEqual(input);
});
test("new proposals enforce current library, history, navigation and patch bindings",()=>{
  const first=create();expect(()=>create(first.library,{...input,id:"other"})).toThrow("proposals changed");
  for(const change of [{editorialRevision:"0".repeat(64)},{historyRevision:"0".repeat(64)},{navigationRevision:"0".repeat(64)},{patch:{...input.patch,after:{...input.patch.after,text:"Altered"}}}])expect(()=>create(empty(),{...input,...change})).toThrow();
  expect(()=>validateLivingScriptProposals(first.library,"foreign-project")).toThrow();
});
test("resealing a forged impact or original does not bypass independent recompilation",()=>{
  const original=create().library;
  const impact=structuredClone(original);impact.proposals[0]!.impact.generation.generateShotIds=[];impact.proposals[0]=reseal(impact.proposals[0]!);
  expect(()=>validateLivingScriptProposals(reseal(impact),fixture.owner.projectId)).toThrow("impact no longer matches");
  const request=structuredClone(original);request.proposals[0]!.request.patch.after.text+="!";request.proposals[0]!.requestRevision=contentHash(request.proposals[0]!.request);request.proposals[0]=reseal(request.proposals[0]!);
  expect(()=>validateLivingScriptProposals(reseal(request),fixture.owner.projectId)).toThrow();
});
test("portable data guards reject accessors, sparse arrays, extra fields and invalid dates",()=>{
  let reads=0;const getter={...input};Object.defineProperty(getter,"label",{enumerable:true,get(){reads++;return input.label;}});expect(()=>create(empty(),getter)).toThrow("accessors");expect(reads).toBe(0);
  expect(()=>create(empty(),{...input,unexpected:true} as LivingScriptProposalRequest)).toThrow("exact screenplay");
  const sparse=create().library;delete sparse.proposals[0];expect(()=>validateLivingScriptProposals(sparse,fixture.owner.projectId)).toThrow("dense");
  const date=create().library;date.proposals[0]!.createdAt="2026-09-08";date.proposals[0]=reseal(date.proposals[0]!);expect(()=>validateLivingScriptProposals(reseal(date),fixture.owner.projectId)).toThrow("creation time");
});
test("history count and library seal cannot hide duplicate or excessive proposals",()=>{
  const result=create().library;const duplicate=reseal({...result,proposals:[result.proposals[0]!,result.proposals[0]!]});expect(()=>validateLivingScriptProposals(duplicate,fixture.owner.projectId)).toThrow("distinct");
  const excessive={...result,proposals:Array.from({length:17},()=>result.proposals[0]!)};expect(()=>validateLivingScriptProposals(excessive,fixture.owner.projectId)).toThrow("sixteen");
  expect(()=>validateLivingScriptProposals({...result,revision:"0".repeat(64)},fixture.owner.projectId)).toThrow("changed");
  expect(()=>validateLivingScriptProposals(reseal({...result,version:0}) as LivingScriptProposals,fixture.owner.projectId)).toThrow("initial");
});
test("project restoration requires the original screenplay but does not invent the proposed version",()=>{
  const library=create().library,original={version:input.patch.before.version,text:input.patch.before.text};
  expect(validateProjectLivingScriptProposals(library,fixture.owner.projectId,[original])).toEqual(library);
  expect(validateProjectLivingScriptProposals(library,fixture.owner.projectId,[original,{version:original.version+1,text:"Later independent draft"}])).toEqual(library);
  for(const history of [[],[{...original,text:"Replaced history"}],[original,original]])expect(()=>validateProjectLivingScriptProposals(library,fixture.owner.projectId,history)).toThrow("exact original project version");
});
