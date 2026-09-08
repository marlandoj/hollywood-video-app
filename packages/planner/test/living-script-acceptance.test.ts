import {beforeAll,afterAll,expect,test} from "bun:test";
import type {ScriptVersion} from "../../parser/src/index";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {castingSnapshot} from "../src/casting";
import {directionSnapshot,type DirectionSnapshot,type DirectionEntry} from "../src/direction";
import {createEditSequence,emptyEditLibrary,changeEditSequence,validateEditLibrary,type EditLibrary} from "../src/edit-library";
import {appendEdit,createEditHistory,editHistoryReplay} from "../src/edit-history";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {compileLivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../src/living-script-generation";
import {compileLivingScriptSourceMap} from "../src/living-script-source-map";
import {compileLivingScriptRecut,type LivingScriptRecutInput} from "../src/living-script-recut";
import {compileLivingScriptAcceptance,validateLivingScriptAcceptance,LIVING_SCRIPT_ACCEPTANCE_LIMITS,type LivingScriptAcceptance,type LivingScriptAcceptanceBundle,type LivingScriptAcceptanceContext,type LivingScriptAcceptanceRequest} from "../src/living-script-acceptance";

let fixture:Awaited<ReturnType<typeof dubStudio>>,context:LivingScriptAcceptanceContext,request:LivingScriptAcceptanceRequest,bundle:LivingScriptAcceptanceBundle,versions:ScriptVersion[],reviewTime:number,acceptedTime:number;
beforeAll(async()=>{
  fixture=await dubStudio();const projectId=fixture.owner.projectId,baselineDirection=await pinDuration();
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const film=(await fixture.worker())!;expect(film.failureReason??film.cancelReason).toBeUndefined();expect(film.status).toBe("done");
  versions=fixture.projects.snapshot().projects.find(project=>project.id===projectId)!.versions;
  const before=await inspectEditSource(film,"Retained original screenplay",fixture.paths.artifactRoot,async()=>{}),index=compileEditScriptSource(before),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(before,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:film.scriptVersion,text:film.scriptText},replacement:"Welcome back to the garden.",protectedLines:[1]});
  expect((await fixture.call(fixture.base+"/script","PUT",{text:patch.after.text},fixture.owner.token)).status).toBe(200);
  const candidateDirection=await pinDuration(),impact=compileLivingScriptGenerationImpact(before,patch,{...film,scriptVersion:patch.after.version,scriptText:patch.after.text,direction:candidateDirection});
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const completed=(await fixture.worker())!;expect(completed.failureReason??completed.cancelReason).toBeUndefined();expect(completed.status).toBe("done");
  const generated=await inspectEditSource(completed,"Reviewed actual revised screenplay",fixture.paths.artifactRoot,async()=>{}),sourceMap=compileLivingScriptSourceMap(before,patch,impact,generated);
  reviewTime=Date.parse(completed.completedAt!);acceptedTime=reviewTime+1000;
  let library=createEditSequence(emptyEditLibrary(),projectId,[before],"parent-cut","Original saved cut",before.facts.id,320,180,0,reviewTime);
  library=createEditSequence(library,projectId,[before],"other-cut","Other saved cut",before.facts.id,320,180,library.version,reviewTime);
  library=changeEditSequence(library,projectId,"parent-cut",{kind:"edit",operation:{kind:"marker",marker:{id:"parent-note",frame:1,label:"Keep this original note"}},label:"Original note"},library.version,library.sequences[0]!.history.revision,reviewTime);
  const parent=deriveEditAssemblyParent(projectId,library,"parent-cut"),indexes=parent.sourceReceipts.map(binding=>compileEditScriptSource(library.sources.find(source=>source.revision===binding.receiptRevision)!)),navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,indexes);
  const recutInput:LivingScriptRecutInput={projectId,library,sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,patch,candidate:impact.candidateInputs,navigationRevision:navigation.revision,generated,sourceMap,operations:[{kind:"replace",clipId:"initial-0",linked:true,sourceId:generated.facts.id,from:0,frames:Math.min(before.facts.frames,generated.facts.frames),timing:"normal",ripple:false}],newSequenceId:"accepted-cut"};
  const recut=compileLivingScriptRecut(recutInput,reviewTime);
  // The fixture uses existing generation APIs to obtain real media. This detached acceptance
  // context deliberately remains the actual pre-patch script and direction snapshot.
  context={projectId,editorial:library,currentScript:{version:film.scriptVersion,text:film.scriptText},currentCasting:film.casting??castingSnapshot(projectId,0,[],0),currentDirection:baselineDirection};
  request={id:"linked-acceptance",name:"Revised screenplay and cut",reviewRevision:recut.revision,baseline:{casting:context.currentCasting,direction:baselineDirection},recutInput,recut};bundle=compileLivingScriptAcceptance(context,request,acceptedTime);
},120000);
afterAll(async()=>{await fixture?.close();});

async function pinDuration():Promise<DirectionSnapshot>{
  const review=await(await fixture.call(fixture.base+"/direction","GET",undefined,fixture.owner.token)).json() as {direction:DirectionSnapshot;scriptVersion:number;plan:DirectionEntry[]},entry=review.plan.find(entry=>entry.source.id==="shot-1-1")!;
  const saved=await fixture.call(fixture.base+"/direction/shot-1-1","PUT",{settings:{durationFrames:180},expectedVersion:review.direction.version,expectedScriptVersion:review.scriptVersion,sourceHash:entry.sourceHash},fixture.owner.token);expect(saved.status).toBe(200);return (await saved.json() as {direction:DirectionSnapshot}).direction;
}

function retained(editorial=bundle.nextEditLibrary,history=[...versions,bundle.nextScript]){return {projectId:context.projectId,versions:history,editorial};}
function seal<T extends {revision:string}>(input:T):T{const {revision:_revision,...data}=input;return {...data,revision:contentHash(data)} as T;}
function later(value:EditLibrary,id:string,label:string){const sequence=value.sequences.find(sequence=>sequence.id===id)!;return changeEditSequence(value,context.projectId,id,{kind:"edit",operation:{kind:"marker",marker:{id:label,frame:2,label}},label},value.version,sequence.history.revision,acceptedTime+1000);}

test("actual selective generation accepts an independent recut and explicit screenplay version without changing originals",()=>{
  const beforeHash=contentHash({context,request}),result=compileLivingScriptAcceptance(context,request,acceptedTime),receipt=result.acceptance;
  expect(result).toEqual(bundle);expect(contentHash({context,request})).toBe(beforeHash);
  expect(request.recutInput.sourceMap.shots.some(shot=>shot.treatment==="unchanged")).toBe(true);expect(request.recutInput.sourceMap.shots.some(shot=>shot.treatment==="regenerate")).toBe(true);
  expect(result.nextEditLibrary.version).toBe(context.editorial.version+1);expect(result.nextEditLibrary.sequences.slice(0,2)).toEqual(context.editorial.sequences);expect(result.nextEditLibrary.sources.slice(0,context.editorial.sources.length)).toEqual(context.editorial.sources);
  expect(result.nextEditLibrary.sources.filter(source=>source.revision===request.recutInput.generated.revision)).toHaveLength(1);
  const adopted=result.nextEditLibrary.sequences.at(-1)!;expect(adopted.id).toBe(request.recutInput.newSequenceId);expect(adopted.history).toEqual(request.recut.history);expect(editHistoryReplay(adopted.history).state.timeline).toEqual(request.recut.afterTimeline);
  expect(result.nextScript).toEqual({version:request.recutInput.patch.after.version,text:request.recutInput.patch.after.text,createdAt:new Date(acceptedTime).toISOString(),parentVersion:context.currentScript.version});
  expect(result.nextCasting).toEqual(context.currentCasting);expect(result.nextDirection).toEqual(request.recutInput.candidate.direction!);expect(result.nextDirection.version).toBe(context.currentDirection.version+1);expect(result.nextDirection.entries[0]!.sourceHash).not.toBe(context.currentDirection.entries[0]!.sourceHash);
  expect(receipt.castingRevision).toBe(context.currentCasting.revision);expect(receipt.directionRevision).toBe(context.currentDirection.revision);expect(receipt.afterCastingRevision).toBe(result.nextCasting.revision);expect(receipt.afterDirectionRevision).toBe(result.nextDirection.revision);
  expect(receipt.requestHash).toBe(contentHash({schema:"hv-living-script-accept-request/1",...request}));expect(receipt.beforeEditorialRevision).toBe(context.editorial.revision);expect(receipt.afterEditorialRevision).toBe(result.nextEditLibrary.revision);
  expect(receipt.parent.eventCount).toBe(1);expect(receipt.parent.rootRevision).toBe(context.editorial.sequences[0]!.history.root.revision);expect(receipt.sequence.eventCount).toBe(adopted.history.events.length);
  expect(receipt.sequence.sourceReceipts).toEqual(request.recut.sourceReceipts);expect(receipt.line.protectedLines).toEqual([1]);expect(validateLivingScriptAcceptance(receipt,retained())).toEqual(receipt);
  result.nextEditLibrary.sequences[0]!.label="Mutation";result.nextEditLibrary.sources[0]!.facts.label="Mutation";result.acceptance.line.protectedLines.push(2);result.nextScript.text="Mutation";result.nextDirection.entries[0]!.settings.durationFrames=30;result.nextCasting.characters[0]!.name="Mutation";
  expect(contentHash({context,request})).toBe(beforeHash);expect(bundle.acceptance.line.protectedLines).toEqual([1]);
});

test("restoration preserves acceptance through later parent and child edits, undo branches, renames and screenplay versions",()=>{
  let library=later(bundle.nextEditLibrary,"parent-cut","Later-parent");library=later(library,"accepted-cut","Later-child");
  let child=library.sequences.find(sequence=>sequence.id==="accepted-cut")!;
  library=changeEditSequence(library,context.projectId,child.id,{kind:"cursor",target:bundle.acceptance.sequence.eventCount,reason:"undo",label:"Undo later child note"},library.version,child.history.revision,acceptedTime+2000);
  child=library.sequences.find(sequence=>sequence.id==="accepted-cut")!;library=changeEditSequence(library,context.projectId,child.id,{kind:"rename",label:"Renamed later"},library.version,child.history.revision,acceptedTime+3000);
  const history=[...versions,bundle.nextScript,{version:bundle.nextScript.version+1,parentVersion:bundle.nextScript.version,text:bundle.nextScript.text+"\n",createdAt:new Date(acceptedTime+4000).toISOString()}];
  expect(library.revision).not.toBe(bundle.acceptance.afterEditorialRevision);expect(validateLivingScriptAcceptance(bundle.acceptance,retained(library,history))).toEqual(bundle.acceptance);
  const copy=validateLivingScriptAcceptance(bundle.acceptance,retained());copy.sequence.sourceReceipts[0]!.receiptRevision="a".repeat(64);expect(bundle.acceptance.sequence.sourceReceipts).toEqual(request.recut.sourceReceipts);
});

test("current screenplay, full editorial library, cast and direction must still match the complete reviewed generation",()=>{
  expect(()=>compileLivingScriptAcceptance({...context,currentScript:{...context.currentScript,text:context.currentScript.text+"\n"}},request,acceptedTime)).toThrow("current screenplay changed");
  expect(()=>compileLivingScriptAcceptance({...context,currentScript:{...context.currentScript,version:context.currentScript.version+1}},request,acceptedTime)).toThrow("current screenplay changed");
  expect(()=>compileLivingScriptAcceptance({...context,editorial:later(context.editorial,"other-cut","Unrelated-edit")},request,acceptedTime)).toThrow("editorial library changed");
  const casting=castingSnapshot(context.projectId,context.currentCasting.version+1,context.currentCasting.characters,acceptedTime),direction=directionSnapshot(context.projectId,context.currentDirection.version+1,context.currentDirection.entries,acceptedTime,context.currentDirection.sceneCuts);
  expect(()=>compileLivingScriptAcceptance({...context,currentCasting:casting},request,acceptedTime)).toThrow("Current cast or direction");
  expect(()=>compileLivingScriptAcceptance({...context,currentDirection:direction},request,acceptedTime)).toThrow("Current cast or direction");
  expect(()=>compileLivingScriptAcceptance({...context,currentDirection:bundle.nextDirection},request,acceptedTime)).toThrow("Current cast or direction");
  expect(()=>compileLivingScriptAcceptance({...context,projectId:"other-project"},request,acceptedTime)).toThrow();
});

test("candidate settings may rebind directed lines only as the reviewed next snapshot without resetting current settings",()=>{
  const sameVersion=structuredClone(request),direction=sameVersion.recutInput.candidate.direction!;
  sameVersion.recutInput.candidate.direction=directionSnapshot(context.projectId,context.currentDirection.version,direction.entries,Date.parse(direction.createdAt),direction.sceneCuts);
  expect(()=>compileLivingScriptAcceptance(context,sameVersion,acceptedTime)).toThrow("next explicit snapshot");
  const skipped=structuredClone(request);skipped.recutInput.candidate.direction=directionSnapshot(context.projectId,context.currentDirection.version+2,direction.entries,Date.parse(direction.createdAt),direction.sceneCuts);
  expect(()=>compileLivingScriptAcceptance(context,skipped,acceptedTime)).toThrow("next explicit snapshot");
  const omitted=structuredClone(request);delete omitted.recutInput.candidate.direction;expect(()=>compileLivingScriptAcceptance(context,omitted,acceptedTime)).toThrow("next explicit snapshot");
  const missing=structuredClone(request) as Partial<LivingScriptAcceptanceRequest>;delete missing.baseline;expect(()=>compileLivingScriptAcceptance(context,missing as LivingScriptAcceptanceRequest,acceptedTime)).toThrow("exact linked acceptance fields");
  for(const field of ["afterCastingRevision","afterDirectionRevision"] as const){const receipt=structuredClone(bundle.acceptance);receipt[field]="a".repeat(64);expect(()=>validateLivingScriptAcceptance(seal(receipt),retained())).toThrow("retained generated film");}
});

test("reviewed operations, candidate inputs and actual generated correspondence are independently recompiled",()=>{
  const changed=structuredClone(request);changed.recut.warnings.push("Unreviewed change");changed.recut=seal(changed.recut);changed.reviewRevision=changed.recut.revision;
  expect(()=>compileLivingScriptAcceptance(context,changed,acceptedTime)).toThrow("reviewed linked recut changed");
  const operation=structuredClone(request);operation.recutInput.operations.push({kind:"marker",marker:{id:"late",frame:2,label:"Late change"}});expect(()=>compileLivingScriptAcceptance(context,operation,acceptedTime)).toThrow("reviewed linked recut changed");
  const wrong=structuredClone(request);wrong.recutInput.sourceMap.durationDeltaFrames++;wrong.recutInput.sourceMap=seal(wrong.recutInput.sourceMap);expect(()=>compileLivingScriptAcceptance(context,wrong,acceptedTime)).toThrow("correspondence changed");
  const candidate=structuredClone(request);candidate.recutInput.candidate.scriptText=context.currentScript.text;expect(()=>compileLivingScriptAcceptance(context,candidate,acceptedTime)).toThrow();
  expect(()=>compileLivingScriptAcceptance(context,{...request,reviewRevision:"a".repeat(64)},acceptedTime)).toThrow("reviewed linked recut changed");
});

test("exact request identity is stable across attempted times and distinct from the accepted timestamp",()=>{
  const laterResult=compileLivingScriptAcceptance(context,request,acceptedTime+1000),renamed=compileLivingScriptAcceptance(context,{...request,id:"another-request",name:"Another reviewed cut"},acceptedTime);
  expect(laterResult.acceptance.requestHash).toBe(bundle.acceptance.requestHash);expect(laterResult.acceptance.revision).not.toBe(bundle.acceptance.revision);expect(laterResult.nextScript.createdAt).not.toBe(bundle.nextScript.createdAt);
  expect(renamed.acceptance.requestHash).not.toBe(bundle.acceptance.requestHash);expect(renamed.acceptance.id).toBe("another-request");expect(renamed.nextEditLibrary.sequences.at(-1)!.label).toBe("Another reviewed cut");
  // The service must resolve an exact ledger replay before asking this stale-state transform again.
  expect(()=>compileLivingScriptAcceptance({...context,editorial:bundle.nextEditLibrary,currentScript:{version:bundle.nextScript.version,text:bundle.nextScript.text}},request,acceptedTime+1000)).toThrow("editorial library changed");
});

test("resealed parent and child history identities cannot substitute for the retained acceptance prefixes",()=>{
  const alterations:Array<(receipt:LivingScriptAcceptance)=>void>=[
    receipt=>{receipt.parent.sequenceId="other-cut";},receipt=>{receipt.parent.historyRevision="a".repeat(64);},receipt=>{receipt.parent.rootRevision="a".repeat(64);},receipt=>{receipt.parent.eventCount=0;},
    receipt=>{receipt.parent.timelineRevision="a".repeat(64);},receipt=>{receipt.sequence.historyRevision="a".repeat(64);},receipt=>{receipt.sequence.eventCount--;},receipt=>{receipt.sequence.rootRevision="a".repeat(64);},receipt=>{receipt.sequence.id="missing-cut";},
  ];
  for(const alter of alterations){const receipt=structuredClone(bundle.acceptance);alter(receipt);expect(()=>validateLivingScriptAcceptance(seal(receipt),retained())).toThrow();}
  const value=structuredClone(bundle.nextEditLibrary),parent=value.sequences.find(sequence=>sequence.id==="parent-cut")!;let history=createEditHistory(parent.id,parent.history.root);
  for(const event of parent.history.events){if(event.kind!=="edit")throw new Error("Unexpected fixture cursor.");history=appendEdit(history,event.operation,"Rewritten historical label",history.revision,Date.parse(event.at));}
  parent.history=history;const valid=validateEditLibrary(seal(value),context.projectId);expect(()=>validateLivingScriptAcceptance(bundle.acceptance,retained(valid))).toThrow("parent history prefix changed");
});

test("restoration rejects changed accepted script bytes, parent/version/time and missing independent originals",()=>{
  for(const change of [(script:ScriptVersion)=>{script.text+="\n";},(script:ScriptVersion)=>{script.parentVersion=null;},(script:ScriptVersion)=>{script.createdAt=new Date(acceptedTime+1).toISOString();}]){const next=structuredClone(bundle.nextScript);change(next);expect(()=>validateLivingScriptAcceptance(bundle.acceptance,retained(bundle.nextEditLibrary,[...versions,next]))).toThrow("accepted screenplay texts");}
  expect(()=>validateLivingScriptAcceptance(bundle.acceptance,retained(bundle.nextEditLibrary,[bundle.nextScript]))).toThrow("accepted screenplay texts");
  expect(()=>validateLivingScriptAcceptance(bundle.acceptance,retained(bundle.nextEditLibrary,versions))).toThrow("accepted screenplay texts");
  const changed=structuredClone(bundle.acceptance);changed.line.protectedLines=[];expect(()=>validateLivingScriptAcceptance(seal(changed),retained())).toThrow("physical screenplay line changed");
  const source=structuredClone(bundle.acceptance);source.afterSource.indexRevision="b".repeat(64);expect(()=>validateLivingScriptAcceptance(seal(source),retained())).toThrow("source identities");
  const library=structuredClone(bundle.nextEditLibrary);library.sources=library.sources.filter(source=>source.revision!==bundle.acceptance.beforeSource.receiptRevision);expect(()=>validateLivingScriptAcceptance(bundle.acceptance,retained(seal(library)))).toThrow();
});

test("identical measured facts cannot hide a changed parent original receipt binding",()=>{
  const library=structuredClone(bundle.nextEditLibrary),original=library.sources.find(source=>source.revision===bundle.acceptance.beforeSource.receiptRevision)!,alternate=structuredClone(original);
  alternate.job.linkExpiresAt=new Date(Date.parse(alternate.job.linkExpiresAt!)+1000).toISOString();const replacement=seal(alternate);expect(replacement.facts).toEqual(original.facts);expect(replacement.revision).not.toBe(original.revision);
  library.sources.push(replacement);const parent=library.sequences.find(sequence=>sequence.id==="parent-cut")!;parent.sourceRevisions=parent.sourceRevisions.map(revision=>revision===original.revision?replacement.revision:revision);
  const valid=validateEditLibrary(seal(library),context.projectId);expect(()=>validateLivingScriptAcceptance(bundle.acceptance,retained(valid))).toThrow("parent lost its exact original receipt bindings");
});

test("strict schema, dates, IDs, unknown fields and portable metadata are required before trusting seals",()=>{
  for(const now of [NaN,Infinity,-1,acceptedTime+0.5])expect(()=>compileLivingScriptAcceptance(context,request,now)).toThrow();
  expect(()=>compileLivingScriptAcceptance(context,request,reviewTime-1)).toThrow("after its retained review time");
  for(const change of [(receipt:LivingScriptAcceptance)=>{receipt.id="bad id";},(receipt:LivingScriptAcceptance)=>{receipt.schema="unsupported" as LivingScriptAcceptance["schema"];},(receipt:LivingScriptAcceptance)=>{receipt.acceptedAt=new Date(acceptedTime).toUTCString();},(receipt:LivingScriptAcceptance)=>{receipt.requestHash="bad";}]){const receipt=structuredClone(bundle.acceptance);change(receipt);expect(()=>validateLivingScriptAcceptance(seal(receipt),retained())).toThrow();}
  expect(()=>compileLivingScriptAcceptance(context,{...request,extra:true} as LivingScriptAcceptanceRequest,acceptedTime)).toThrow("exact linked acceptance fields");
  expect(()=>validateLivingScriptAcceptance(seal({...bundle.acceptance,extra:true}),retained())).toThrow("exact linked acceptance fields");
  let reads=0;const trap=Object.defineProperty({...request},"name",{enumerable:true,get(){reads++;return "trap";}});expect(()=>compileLivingScriptAcceptance(context,trap,acceptedTime)).toThrow("without accessors");expect(reads).toBe(0);
  const sparse=structuredClone(request);sparse.recutInput.operations.length++;expect(()=>compileLivingScriptAcceptance(context,sparse,acceptedTime)).toThrow("dense");
  const hidden=structuredClone(bundle.acceptance);Object.defineProperty(hidden,"hidden",{value:true});expect(()=>validateLivingScriptAcceptance(hidden,retained())).toThrow("enumerable");
  expect(()=>validateLivingScriptAcceptance({...bundle.acceptance,name:"a".repeat(LIVING_SCRIPT_ACCEPTANCE_LIMITS.receiptBytes)},retained())).toThrow("metadata capacity");
});
