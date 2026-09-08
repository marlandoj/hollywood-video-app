import {beforeAll,afterAll,expect,test} from "bun:test";
import type {ScriptVersion} from "../../parser/src/index";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {castingSnapshot} from "../src/casting";
import {directionSnapshot,type DirectionSnapshot,type DirectionEntry} from "../src/direction";
import {createEditSequence,emptyEditLibrary,changeEditSequence,type EditLibrary} from "../src/edit-library";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {compileLivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../src/living-script-generation";
import {compileLivingScriptSourceMap} from "../src/living-script-source-map";
import {compileLivingScriptRecut,type LivingScriptRecutInput} from "../src/living-script-recut";
import {compileLivingScriptAcceptance,type LivingScriptAcceptanceContext,type LivingScriptAcceptanceRequest,type LivingScriptAcceptanceBundle} from "../src/living-script-acceptance";
import {createLivingScriptProposal,emptyLivingScriptProposals,type LivingScriptProposals,type LivingScriptProposal} from "../src/living-script-proposals";
import {emptyLivingScriptAcceptances,acceptLivingScriptProposal,validateLivingScriptAcceptances,validateProjectLivingScriptAcceptances,LIVING_SCRIPT_ACCEPTANCES_LIMITS,type LivingScriptAcceptances,type LivingScriptAcceptanceRecord} from "../src/living-script-acceptance-library";

let fixture:Awaited<ReturnType<typeof dubStudio>>,context:LivingScriptAcceptanceContext,request:LivingScriptAcceptanceRequest,proposals:LivingScriptProposals,proposal:LivingScriptProposal,ledger:LivingScriptAcceptances,record:LivingScriptAcceptanceRecord,bundle:LivingScriptAcceptanceBundle,versions:ScriptVersion[],acceptedAt:number;
beforeAll(async()=>{
  fixture=await dubStudio();const projectId=fixture.owner.projectId,baselineDirection=await pinDuration();
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const film=(await fixture.worker())!;expect(film.failureReason??film.cancelReason).toBeUndefined();expect(film.status).toBe("done");
  versions=fixture.projects.snapshot().projects.find(project=>project.id===projectId)!.versions;
  const before=await inspectEditSource(film,"Retained original",fixture.paths.artifactRoot,async()=>{}),index=compileEditScriptSource(before),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(before,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:film.scriptVersion,text:film.scriptText},replacement:"Welcome back to the garden.",protectedLines:[1]});
  const library=createEditSequence(emptyEditLibrary(),projectId,[before],"parent-cut","Original cut",before.facts.id,320,180,0,Date.parse(film.completedAt!)),parent=deriveEditAssemblyParent(projectId,library,"parent-cut"),navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]);
  // Existing HTTP generation produces real directed media. The pure acceptance context remains
  // the actual pre-patch state; saving this immutable proposal does not grant generation authority.
  context={projectId,editorial:library,currentScript:{version:film.scriptVersion,text:film.scriptText},currentCasting:film.casting??castingSnapshot(projectId,0,[],0),currentDirection:baselineDirection};
  expect((await fixture.call(fixture.base+"/script","PUT",{text:patch.after.text},fixture.owner.token)).status).toBe(200);
  const candidateDirection=await pinDuration(),impact=compileLivingScriptGenerationImpact(before,patch,{...film,scriptVersion:patch.after.version,scriptText:patch.after.text,direction:candidateDirection}),baseline={casting:context.currentCasting,direction:baselineDirection};
  const saved=createLivingScriptProposal(emptyLivingScriptProposals(projectId),projectId,library,{id:"proposal-1",label:"Change the first spoken line",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,editorialRevision:library.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline},0,Date.now());proposals=saved.library;proposal=saved.proposal;
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const generatedJob=(await fixture.worker())!;expect(generatedJob.failureReason??generatedJob.cancelReason).toBeUndefined();expect(generatedJob.status).toBe("done");
  const generated=await inspectEditSource(generatedJob,"Reviewed revised screenplay",fixture.paths.artifactRoot,async()=>{}),sourceMap=compileLivingScriptSourceMap(before,patch,impact,generated),reviewedAt=Date.parse(generatedJob.completedAt!)+1;
  const recutInput:LivingScriptRecutInput={projectId,library,sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,generated,sourceMap,operations:[{kind:"replace",clipId:"initial-0",linked:true,sourceId:generated.facts.id,from:0,frames:Math.min(before.facts.frames,generated.facts.frames),timing:"normal",ripple:false}],newSequenceId:"accepted-cut"},recut=compileLivingScriptRecut(recutInput,reviewedAt);
  request={id:"accept-1",name:"Revised saved cut",baseline,reviewRevision:recut.revision,recutInput,recut};acceptedAt=reviewedAt+1;
  const accepted=acceptLivingScriptProposal(emptyLivingScriptAcceptances(projectId),proposals,context,proposal.request.id,proposal.revision,request,0,acceptedAt);if(accepted.replayed)throw new Error("Fresh acceptance unexpectedly replayed.");ledger=accepted.library;record=accepted.record;bundle=accepted.bundle;
},120000);
afterAll(async()=>{await fixture?.close();});

async function pinDuration():Promise<DirectionSnapshot>{const review=await(await fixture.call(fixture.base+"/direction","GET",undefined,fixture.owner.token)).json() as {direction:DirectionSnapshot;scriptVersion:number;plan:DirectionEntry[]},entry=review.plan.find(entry=>entry.source.id==="shot-1-1")!;const saved=await fixture.call(fixture.base+"/direction/shot-1-1","PUT",{settings:{durationFrames:180},expectedVersion:review.direction.version,expectedScriptVersion:review.scriptVersion,sourceHash:entry.sourceHash},fixture.owner.token);expect(saved.status).toBe(200);return (await saved.json() as {direction:DirectionSnapshot}).direction;}
function seal<T extends {revision:string}>(input:T):T{const {revision:_revision,...data}=input;return {...data,revision:contentHash(data)} as T;}
function restore(editorial=bundle.nextEditLibrary,history=[...versions,bundle.nextScript]){return {projectId:context.projectId,versions:history,editorial};}
function changed(library:EditLibrary,id:string){const sequence=library.sequences.find(sequence=>sequence.id===id)!;return changeEditSequence(library,context.projectId,id,{kind:"edit",operation:{kind:"marker",marker:{id:"later",frame:1,label:"Later edit"}},label:"Later edit"},library.version,sequence.history.revision,acceptedAt+1000);}
function alterLedger(change:(value:LivingScriptAcceptanceRecord)=>void):LivingScriptAcceptances{const value=structuredClone(ledger);change(value.records[0]!);value.records[0]=seal(value.records[0]!);return seal(value);}

test("directed selective output is durably bound to its immutable proposal and full historical request",()=>{
  const beforeHash=contentHash({context,request,proposals}),empty=emptyLivingScriptAcceptances(context.projectId),result=acceptLivingScriptProposal(empty,proposals,context,proposal.request.id,proposal.revision,request,0,acceptedAt);
  expect(result.replayed).toBe(false);expect(result.library).toEqual(ledger);expect(result.record).toEqual(record);expect(result.bundle).toEqual(bundle);expect(empty.version).toBe(0);expect(empty.records).toEqual([]);
  expect(ledger.version).toBe(ledger.records.length);expect(record.request).toEqual(request);expect(record.proposalRevision).toBe(proposal.revision);expect(record.acceptance).toEqual(compileLivingScriptAcceptance(context,request,acceptedAt).acceptance);
  expect(bundle.nextDirection.version).toBe(context.currentDirection.version+1);expect(request.recutInput.sourceMap.shots.some(shot=>shot.treatment==="unchanged")).toBe(true);
  expect(validateLivingScriptAcceptances(ledger,proposals,context.projectId)).toEqual(ledger);expect(validateProjectLivingScriptAcceptances(ledger,proposals,restore())).toEqual(ledger);
  result.library.records[0]!.request.name="Changed detached result";result.record.acceptance.name="Changed detached record";if(result.bundle)result.bundle.nextScript.text="Changed detached bundle";
  expect(contentHash({context,request,proposals})).toBe(beforeHash);expect(record.request.name).toBe(request.name);
});

test("an exact retry replays before stale ledger, screenplay, cut and settings checks without a new mutation bundle",()=>{
  let editorial=changed(bundle.nextEditLibrary,"parent-cut");editorial=changed(editorial,"accepted-cut");
  const current={...context,editorial,currentScript:{version:bundle.nextScript.version,text:bundle.nextScript.text},currentCasting:bundle.nextCasting,currentDirection:bundle.nextDirection},result=acceptLivingScriptProposal(ledger,proposals,current,proposal.request.id,proposal.revision,request,0,acceptedAt+10000);
  expect(result.replayed).toBe(true);expect(Object.hasOwn(result,"bundle")).toBe(false);expect(result.library).toEqual(ledger);expect(result.record).toEqual(record);expect(result.record.acceptance.acceptedAt).toBe(new Date(acceptedAt).toISOString());
  const history=[...versions,bundle.nextScript,{version:bundle.nextScript.version+1,text:bundle.nextScript.text+"\n",createdAt:new Date(acceptedAt+20000).toISOString(),parentVersion:bundle.nextScript.version}];
  expect(validateProjectLivingScriptAcceptances(ledger,proposals,restore(editorial,history))).toEqual(ledger);
});

test("request IDs and proposal revisions cannot be reused for different full bodies or second acceptances",()=>{
  expect(()=>acceptLivingScriptProposal(ledger,proposals,context,proposal.request.id,proposal.revision,{...request,name:"Different output label"},0,acceptedAt)).toThrow("different reviewed body");
  expect(()=>acceptLivingScriptProposal(ledger,proposals,context,proposal.request.id,proposal.revision,{...request,id:"accept-2"},0,acceptedAt)).toThrow("different acceptance request");
  const altered=structuredClone(request);altered.recutInput.operations.push({kind:"marker",marker:{id:"extra",frame:2,label:"Unreviewed retry operation"}});expect(()=>acceptLivingScriptProposal(ledger,proposals,context,proposal.request.id,proposal.revision,altered,0,acceptedAt)).toThrow("different reviewed body");
  const second=createLivingScriptProposal(proposals,context.projectId,context.editorial,{...proposal.request,id:"proposal-2",label:"Independent proposal identity"},proposals.version,Date.parse(proposal.createdAt));
  expect(()=>acceptLivingScriptProposal(ledger,second.library,context,second.proposal.request.id,second.proposal.revision,request,0,acceptedAt)).toThrow("different reviewed body or proposal");
  expect(()=>acceptLivingScriptProposal(emptyLivingScriptAcceptances(context.projectId),proposals,context,proposal.request.id,proposal.revision,request,1,acceptedAt)).toThrow("ledger changed");
});

test("frozen proposal bindings reject changed baseline, candidate, cut, navigation and exact physical patch",()=>{
  const changes:Array<(value:LivingScriptAcceptanceRequest)=>void>=[
    value=>{value.baseline.direction=directionSnapshot(context.projectId,context.currentDirection.version+1,context.currentDirection.entries,acceptedAt);},
    value=>{value.recutInput.candidate.scriptText+="\n";},value=>{value.recutInput.sequenceId="different-cut";},value=>{value.recutInput.historyRevision="a".repeat(64);},value=>{value.recutInput.navigationRevision="a".repeat(64);},
    value=>{value.recutInput.library=changed(context.editorial,"parent-cut");},value=>{value.recutInput.patch.protectedLines=[];},
  ];
  for(const change of changes){const value=structuredClone(request);change(value);expect(()=>acceptLivingScriptProposal(emptyLivingScriptAcceptances(context.projectId),proposals,context,proposal.request.id,proposal.revision,value,0,acceptedAt)).toThrow("saved proposal baseline");}
  expect(()=>acceptLivingScriptProposal(emptyLivingScriptAcceptances(context.projectId),proposals,context,proposal.request.id,"a".repeat(64),request,0,acceptedAt)).toThrow("exact immutable screenplay proposal");
  const impact=structuredClone(request);impact.recut.cutImpactRevision="b".repeat(64);impact.recut=seal(impact.recut);impact.reviewRevision=impact.recut.revision;expect(()=>acceptLivingScriptProposal(emptyLivingScriptAcceptances(context.projectId),proposals,context,proposal.request.id,proposal.revision,impact,0,acceptedAt)).toThrow("exact reviewed proposal impact");
});

test("resealing stored request hashes, IDs, baseline or generated impact cannot forge historical acceptance",()=>{
  for(const change of [(value:LivingScriptAcceptanceRecord)=>{value.acceptance.requestHash="a".repeat(64);value.acceptance=seal(value.acceptance);},(value:LivingScriptAcceptanceRecord)=>{value.acceptance.id="forged-id";value.acceptance=seal(value.acceptance);},(value:LivingScriptAcceptanceRecord)=>{value.request.name="Forged reviewed name";},(value:LivingScriptAcceptanceRecord)=>{value.acceptance.afterDirectionRevision="b".repeat(64);value.acceptance=seal(value.acceptance);}])expect(()=>validateLivingScriptAcceptances(alterLedger(change),proposals,context.projectId)).toThrow("complete historical reviewed request");
  expect(()=>validateLivingScriptAcceptances(alterLedger(value=>{value.request.baseline.direction=directionSnapshot(context.projectId,context.currentDirection.version+1,context.currentDirection.entries,acceptedAt);}),proposals,context.projectId)).toThrow("saved proposal baseline");
  const wrong=alterLedger(value=>{value.request.recutInput.sourceMap.durationDeltaFrames++;value.request.recutInput.sourceMap=seal(value.request.recutInput.sourceMap);});expect(()=>validateLivingScriptAcceptances(wrong,proposals,context.projectId)).toThrow("correspondence changed");
  const changedProposal=structuredClone(proposals);changedProposal.proposals[0]!.impact.warnings.push("Forged impact");changedProposal.proposals[0]!.impact=seal(changedProposal.proposals[0]!.impact);changedProposal.proposals[0]=seal(changedProposal.proposals[0]!);const forged=seal(changedProposal);expect(()=>validateLivingScriptAcceptances(ledger,forged,context.projectId)).toThrow("impact no longer matches");
});

test("project restore requires actual accepted script versions and exact retained cut prefixes",()=>{
  expect(()=>validateProjectLivingScriptAcceptances(ledger,proposals,restore(bundle.nextEditLibrary,versions))).toThrow("accepted screenplay texts");
  expect(()=>validateProjectLivingScriptAcceptances(ledger,proposals,restore(context.editorial))).toThrow("independently retained original sources");
  const text=structuredClone(bundle.nextScript);text.text+="\n";expect(()=>validateProjectLivingScriptAcceptances(ledger,proposals,restore(bundle.nextEditLibrary,[...versions,text]))).toThrow("accepted screenplay texts");
  const acceptedTime=alterLedger(value=>{value.acceptance.acceptedAt=new Date(acceptedAt+500).toISOString();value.acceptance=seal(value.acceptance);});expect(()=>validateProjectLivingScriptAcceptances(acceptedTime,proposals,restore())).toThrow("complete historical reviewed request");
  expect(()=>validateLivingScriptAcceptances(ledger,emptyLivingScriptProposals(context.projectId),context.projectId)).toThrow("exact immutable screenplay proposal");
});

test("append-only version, record uniqueness, count and complete metadata capacity are enforced without truncation",()=>{
  const empty=emptyLivingScriptAcceptances(context.projectId);expect(validateLivingScriptAcceptances(empty,proposals,context.projectId)).toEqual(empty);
  expect(()=>validateLivingScriptAcceptances(seal({...ledger,version:0}),proposals,context.projectId)).toThrow("append-only");
  expect(()=>validateLivingScriptAcceptances(seal({...ledger,version:2,records:[record,record]}),proposals,context.projectId)).toThrow("only once");
  const duplicateProposal=structuredClone(record);duplicateProposal.request.id="different-id";expect(()=>validateLivingScriptAcceptances(seal({...ledger,version:2,records:[record,seal(duplicateProposal)]}),proposals,context.projectId)).toThrow("only once");
  expect(()=>validateLivingScriptAcceptances(seal({...ledger,version:16,records:Array.from({length:17},()=>record)}),proposals,context.projectId)).toThrow("up to sixteen");
  // An untrusted single string can exceed the byte budget even when the record count is small.
  const oversized={...empty,extra:"x".repeat(LIVING_SCRIPT_ACCEPTANCES_LIMITS.bytes)};expect(()=>validateLivingScriptAcceptances(oversized,proposals,context.projectId)).toThrow("metadata capacity");
});

test("schema, unknown fields, non-JSON values, getters and malformed time fail before hashing untrusted input",()=>{
  expect(()=>validateLivingScriptAcceptances(seal({...ledger,extra:true}),proposals,context.projectId)).toThrow("exact acceptance ledger fields");
  expect(()=>validateLivingScriptAcceptances(seal({...ledger,schema:"other" as LivingScriptAcceptances["schema"]}),proposals,context.projectId)).toThrow("append-only");
  expect(()=>validateLivingScriptAcceptances(alterLedger(value=>{Object.assign(value,{extra:true});}),proposals,context.projectId)).toThrow("exact acceptance ledger fields");
  let reads=0;const trap=Object.defineProperty({...request},"name",{enumerable:true,get(){reads++;return "Trap";}});expect(()=>acceptLivingScriptProposal(ledger,proposals,context,proposal.request.id,proposal.revision,trap,0,acceptedAt)).toThrow("without accessors");expect(reads).toBe(0);
  const sparse=structuredClone(ledger);sparse.records.length=2;expect(()=>validateLivingScriptAcceptances(sparse,proposals,context.projectId)).toThrow("dense");
  const hidden=structuredClone(ledger);Object.defineProperty(hidden,"hidden",{value:true});expect(()=>validateLivingScriptAcceptances(hidden,proposals,context.projectId)).toThrow("enumerable");
  for(const now of [NaN,Infinity,-1,acceptedAt+0.1])expect(()=>acceptLivingScriptProposal(ledger,proposals,context,proposal.request.id,proposal.revision,request,0,now)).toThrow();
  const date=alterLedger(value=>{value.acceptance.acceptedAt=new Date(acceptedAt).toUTCString();value.acceptance=seal(value.acceptance);});expect(()=>validateLivingScriptAcceptances(date,proposals,context.projectId)).toThrow("exact acceptance time");
});
