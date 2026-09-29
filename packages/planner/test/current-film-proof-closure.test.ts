import {afterAll,beforeAll,expect,test} from "bun:test";
import {join} from "node:path";
import {writeFileSync} from "node:fs";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../src/current-film-mixed-jobs";
import {compileCurrentFilmJob,type CurrentFilmJobV2} from "../src/current-film-jobs";
import {currentFilmV2Job} from "../src/current-film-job-context";
import {bindOriginalEditSource,createEditPlan,editRenderReview} from "../src/edit-jobs";
import {editHistoryState} from "../src/edit-history";
import {contentHash as hash} from "../../generator/src/capabilities";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {compileCurrentFilmProofClosure,validateCurrentFilmProofClosure,CURRENT_FILM_PROOF_LIMITS,type CurrentFilmProofClosure,type CurrentFilmProofContext} from "../src/current-film-proof-closure";
import type {EditSourceReceipt} from "../src/edit-sources";
import {castingSnapshot,currentCasting} from "../src/casting";
import {currentDirection} from "../src/direction";
import {bootstrapCurrentScreenplayLibrary,emptyCurrentScreenplayLibrary} from "../src/current-screenplay-library";
import type {ReferenceAsset} from "../src/references";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {compileLivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../src/living-script-generation";
import {createLivingScriptJobPlan} from "../src/living-script-jobs";
import {createLivingScriptProposal,emptyLivingScriptProposals} from "../src/living-script-proposals";
import {renderShots} from "../src/shot-reuse";
import {createLivingScriptStructureBase} from "../src/living-script-structure";
import {bootstrapLivingScriptDocument} from "../src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../src/living-script-shot-plan";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,final:Awaited<ReturnType<typeof f.renderFinal>>;
let plan:CurrentFilmJobV3,bootstrap:EditSourceReceipt,carrier:Job,context:CurrentFilmProofContext,closure:CurrentFilmProofClosure;
function mixed(target:CurrentFilmJobV2,receipt:EditSourceReceipt):CurrentFilmJobV3 {
  const slot=target.materialization.slots[0]!,record=currentFilmV2Job(receipt.job).currentFilmCheckpoint!.rows[0]!;
  return compileCurrentFilmMixedJob(target,{origins:[bindOriginalEditSource(receipt)],choices:[{ordinal:0,inputRevision:slot.inputRevision,originId:receipt.revision,
    source:{receiptRevision:receipt.revision,ordinal:0,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.record.revision}}]});
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();final=await f.renderFinal();bootstrap=f.project.currentScreenplay!.origin!.request.source;
  const completed=currentFilmV2Job(final.job),finalPlan=completed.currentFilm;
  if(!finalPlan)throw new Error("The actual final fixture requires its checked V2 plan.");plan=mixed(finalPlan,final.receipt);
  // Produce a real small editorial carrier for the bootstrap. This remains a
  // metadata compiler test; the worker supplies authentic copy/media evidence.
  const bindings=[bindOriginalEditSource(bootstrap)];
  let library=f.projects.createEditSequence(f.studio.owner.token,[bootstrap],"proof-bootstrap","Retained bootstrap",bootstrap.job.id,64,64,0,Date.now(),bindings)!;
  library=f.projects.changeEditSequence(f.studio.owner.token,"proof-bootstrap",{kind:"edit",label:"One second",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-bootstrap.facts.frames,ripple:true}},library.version,library.sequences[0]!.history.revision)!;
  const sequence=library.sequences[0]!,timeline=editHistoryState(sequence.history).timeline,pictureEdit=createEditPlan(sequence,bindings,soundRuntimeRevision(),"local",hash("proof-bootstrap"),editRenderReview(timeline));
  const path=join(f.studio.root,"proof-carrier-queue.json");writeFileSync(path,JSON.stringify([f.studio.film]));const store=new DurableJobStore(path);
  const request:JobInput={id:"proof-bootstrap-export",projectId:f.job.projectId,idempotencyKey:"proof-bootstrap-export",tier:"free",stage:"picture-edit",scriptVersion:bootstrap.job.scriptVersion,scriptText:bootstrap.job.scriptText,rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:30,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000,pictureEdit};
  store.enqueue(request);const done=await processNextJob(store,f.studio.paths.artifactRoot,f.context);
  if(!done||done.status!=="done")throw new Error("Proof carrier fixture failed: "+(done?.failureReason??done?.cancelReason));carrier=done;
  context={project:f.projects.snapshot().projects[0]!,jobs:[f.studio.film,f.job,final.job,carrier]};closure=compileCurrentFilmProofClosure(plan,context);
},360000);
afterAll(async()=>{await f?.close();});

test("actual final and target share one bootstrap while exact preview/approval and direct source retain their original identities",()=>{
  const before=hash({plan,context});expect(closure.receipts).toHaveLength(2);
  const root=closure.receipts.find(value=>value.receipt.revision===bootstrap.revision)!;
  expect(root.requiredBy.map(value=>value.kind)).toContain("target-bootstrap");expect(root.requiredBy.map(value=>value.kind)).toContain("source-bootstrap");
  expect(root.requiredBy.map(value=>value.kind)).toContain("preview-bootstrap");expect(root.candidates.map(value=>value.kind).sort()).toEqual(["editorial","original"]);
  expect(closure.previews.map(value=>value.job.id)).toEqual([f.job.id]);expect(closure.previews[0]!.job.output).toEqual(f.job.output);
  expect(closure.approvals[0]!.finalJobId).toBe(final.job.id);expect(closure.approvals[0]!.approval.at).toBe(final.job.animaticApprovedAt!);
  expect(closure.receipts.find(value=>value.receipt.revision===final.receipt.revision)!.receipt).toEqual(final.receipt);
  expect(closure.historicalOnly).toBe(true);expect(closure.mediaVerified).toBe(false);expect(closure.currentAuthority).toBe(false);
  expect(validateCurrentFilmProofClosure(closure,plan,context)).toEqual(closure);expect(hash({plan,context})).toBe(before);
},90000);

test("historical original expiry and later accepted heads retain recovery evidence; missing original can use an actual retained carrier",()=>{
  const next:CurrentFilmProofContext={project:{...f.accept(),animaticApprovals:context.project.animaticApprovals,rightsAttestedAt:null} as CurrentFilmProofContext["project"],jobs:context.jobs.filter(job=>job.id!==bootstrap.job.id)};
  const now=Date.now;Date.now=()=>Date.parse(final.job.linkExpiresAt!)+86400000;
  let restored:CurrentFilmProofClosure;try{restored=compileCurrentFilmProofClosure(plan,next);}finally{Date.now=now;}
  expect(restored.receipts.find(value=>value.receipt.revision===bootstrap.revision)!.candidates.map(value=>value.jobId)).toEqual([carrier.id]);
  expect(restored.savedLibraryRevision).not.toBe(plan.library.revision);expect(restored.approvals).toEqual(closure.approvals);
  expect(()=>compileCurrentFilmProofClosure(plan,{...next,jobs:next.jobs.filter(job=>job.id!==carrier.id)})).toThrow("carrier metadata");
  const operational=structuredClone(context);operational.jobs[0]!.notifications.push("Historical delivery reminder");operational.jobs[0]!.leaseVersion=0;
  expect(compileCurrentFilmProofClosure(plan,operational).receipts).toHaveLength(2);
},90000);

test("a review hash does not substitute for the actual preview, exact historical approval or saved prefix",()=>{
  expect(()=>compileCurrentFilmProofClosure(plan,{...context,jobs:context.jobs.filter(job=>job.id!==f.job.id)})).toThrow("actual saved preview");
  const bad=structuredClone(context);bad.project.animaticApprovals=[];
  expect(()=>compileCurrentFilmProofClosure(plan,bad)).toThrow("historical approval");
  const duplicate=structuredClone(context);duplicate.project.animaticApprovals.push(structuredClone(duplicate.project.animaticApprovals.find(row=>row.at===final.job.animaticApprovedAt)!));
  expect(()=>compileCurrentFilmProofClosure(plan,duplicate)).toThrow("one exact");
  const decision=structuredClone(context);decision.project.animaticApprovals.find(row=>row.at===final.job.animaticApprovedAt)!.decision="changes_requested";
  expect(()=>compileCurrentFilmProofClosure(plan,decision)).toThrow("preview decision");
  const changed=structuredClone(context);changed.jobs.find(job=>job.id===f.job.id)!.output!.currentFilm!.assembly.frames++;
  expect(()=>compileCurrentFilmProofClosure(plan,changed)).toThrow();
  const lost=structuredClone(context);lost.project.currentScreenplay!.proposals=[];
  expect(()=>compileCurrentFilmProofClosure(plan,lost)).toThrow();
},90000);

test("carrier mappings, original inventory and full same-ID authoritative bodies cannot be substituted",()=>{
  const duplicate={...context,jobs:[...context.jobs,structuredClone(context.jobs[0]!)]};expect(compileCurrentFilmProofClosure(plan,duplicate)).toEqual(closure);
  duplicate.jobs.at(-1)!.notifications.push("Conflicting authoritative duplicate");expect(()=>compileCurrentFilmProofClosure(plan,duplicate)).toThrow("same-ID authoritative");
  const wrong=structuredClone(context);wrong.jobs.find(job=>job.id===final.job.id)!.linkExpiresAt=new Date(Date.parse(final.job.linkExpiresAt!)+1000).toISOString();
  expect(()=>compileCurrentFilmProofClosure(plan,wrong)).toThrow("historical proof identity");
  const corrupt=structuredClone(context);corrupt.jobs.find(job=>job.id===carrier.id)!.output!.editorial!.prepared.sources[0]!.copies[0]!.copy.sha256="e".repeat(64);
  expect(()=>compileCurrentFilmProofClosure(plan,corrupt)).toThrow();
  const foreign=structuredClone(context);foreign.jobs[0]!.projectId="another-project";
  expect(()=>compileCurrentFilmProofClosure(plan,foreign)).toThrow("another project");
  const detached=validateCurrentFilmProofClosure(closure,plan,context);detached.receipts[0]!.candidates[0]!.files[0]!.path="changed/file";
  expect(validateCurrentFilmProofClosure(closure,plan,context)).toEqual(closure);expect(()=>validateCurrentFilmProofClosure(detached,plan,context)).toThrow();
},90000);

test("portable checks precede getters, hashes and graph traversal; resealed omissions and excess jobs refuse",()=>{
  let reads=0;const getter=structuredClone(context);Object.defineProperty(getter.project,"id",{enumerable:true,get(){reads++;return f.job.projectId;}});
  expect(()=>compileCurrentFilmProofClosure(plan,getter)).toThrow("accessors");expect(reads).toBe(0);
  const hidden=structuredClone(context);Object.defineProperty(hidden.jobs[0]!,"hidden",{value:1,enumerable:false});expect(()=>compileCurrentFilmProofClosure(plan,hidden)).toThrow("hidden");
  const cycle=structuredClone(context);Object.assign(cycle,{cycle});expect(()=>compileCurrentFilmProofClosure(plan,cycle)).toThrow("cycles");
  expect(()=>compileCurrentFilmProofClosure(plan,{...context,jobs:Array.from({length:CURRENT_FILM_PROOF_LIMITS.jobs+1},()=>({id:"over-limit"}) as Job)})).toThrow("bounded proof jobs");
  const omitted=structuredClone(closure);omitted.receipts.pop();const {revision:_revision,...body}=omitted;omitted.revision=hash(body);
  expect(()=>validateCurrentFilmProofClosure(omitted,plan,context)).toThrow("exact saved dependencies");
  const reordered={...context,jobs:context.jobs.slice().reverse()};expect(compileCurrentFilmProofClosure(plan,reordered)).toEqual(closure);
},90000);

test("declared target references are exact recovery files, with no claim those metadata-only image bytes were verified",()=>{
  const original=f.originalProject.currentScreenplay!.origin!,at=Date.now(),baseline=original.request.baseline;
  const asset:ReferenceAsset={schema:"hv-reference/1",id:crypto.randomUUID(),projectId:f.job.projectId,sha256:"a".repeat(64),originalSha256:"b".repeat(64),bytes:24,width:1,height:1,contentType:"image/png",createdAt:new Date(at).toISOString(),attestedAt:new Date(at).toISOString()};
  const characters=structuredClone(baseline.casting.characters);characters[0]!.references=[asset];const casting=castingSnapshot(f.job.projectId,baseline.casting.version+1,characters,at);
  const saved=bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(f.job.projectId),{...original.request,id:"proof-reference-root",baseline:{...baseline,casting}},0,at).library;
  const fresh=compileCurrentFilmJob(saved,{kind:"accepted",revision:saved.headRevision!},{role:"preview",tier:"free",providerPlan:f.plan.render.providerPlan},at+1),target=compileCurrentFilmMixedJob(fresh,{origins:[],choices:[]});
  const projected:CurrentFilmProofContext={project:{...f.originalProject,currentScreenplay:saved,referenceAssets:[asset]},jobs:[f.studio.film]};
  const proof=compileCurrentFilmProofClosure(target,projected);expect(proof.references).toEqual([{asset,file:{path:`${asset.projectId}/references/${asset.id}/${asset.sha256}.png`,sha256:asset.sha256,bytes:asset.bytes}}]);expect(proof.mediaVerified).toBe(false);
  expect(()=>compileCurrentFilmProofClosure(target,{...projected,project:{...projected.project,referenceAssets:[]}})).toThrow("missing or changed");
  const altered=structuredClone(projected);altered.project.referenceAssets![0]!.bytes++;
  expect(()=>compileCurrentFilmProofClosure(target,altered)).toThrow("missing or changed");
},90000);

test("actual forward-dialogue film can bootstrap canonical generation while retaining every frozen proposal original and saved history",async()=>{
  // A distinct real legacy film is deliberately unused by the selected patch.
  // It remains in the frozen editorial library and must survive proof closure.
  const response=await f.studio.call(f.studio.base+"/jobs","POST",{idempotencyKey:"proof-extra-original"},f.studio.owner.token);
  expect(response.status).toBe(202);const extraJob=await f.studio.worker();if(!extraJob||extraJob.status!=="done")throw new Error("Additional proof original did not render.");
  const extra=await inspectEditSource(extraJob,"Unselected frozen original",f.studio.paths.artifactRoot,async()=>{}),bindings=[bindOriginalEditSource(bootstrap),bindOriginalEditSource(extra)];
  const before=f.projects.snapshot().projects[0]!,baseline={casting:currentCasting(before.id,before.castingHistory),direction:currentDirection(before.id,before.directionHistory)};
  const editorial=f.projects.createEditSequence(f.studio.owner.token,[bootstrap,extra],"proof-pending-parent","Forward proof cut",bootstrap.job.id,64,64,before.editLibrary!.version,Date.now(),bindings)!;
  const parent=deriveEditAssemblyParent(before.id,editorial,"proof-pending-parent"),index=compileEditScriptSource(bootstrap),entry=index.entries.find(value=>value.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(bootstrap,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:bootstrap.job.scriptVersion,text:bootstrap.job.scriptText},replacement:"Welcome back to this quiet garden."});
  const generation=compileLivingScriptGenerationImpact(bootstrap,patch,{...bootstrap.job,casting:baseline.casting,direction:baseline.direction,scriptVersion:patch.after.version,scriptText:patch.after.text});
  const navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index,compileEditScriptSource(extra)]);
  const request={id:"proof-forward-dialogue",label:"Forward dialogue proof",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,editorialRevision:editorial.revision,navigationRevision:navigation.revision,patch,candidate:generation.candidateInputs,baseline};
  const saved=f.projects.createLivingScriptProposal(f.studio.owner.token,request,0,[{binding:bindings[0]!,current:f.studio.film},{binding:bindings[1]!,current:extraJob}])!;
  const pending=createLivingScriptJobPlan(saved.proposal,bindings[0]!,{role:"render"}),queuePath=join(f.studio.root,"proof-forward-jobs.json");
  writeFileSync(queuePath,JSON.stringify([f.studio.film,extraJob]));const queue=new DurableJobStore(queuePath);
  const input:JobInput={id:"proof-forward-film",idempotencyKey:"proof-forward-film",...pending.inputs,livingScript:pending,shotReuse:pending.shotReuse,
    providerSpec:pending.inputs.providerPlan!.pool[0]!.spec,totalFrames:renderShots(pending.inputs).reduce((sum,shot)=>sum+Math.round(shot.durationSec*30),0),
    retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000,costCapUsd:5,budgetReservedUsd:0,rightsAttestedAt:before.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null};
  queue.enqueue(input);const done=await processNextJob(queue,f.studio.paths.artifactRoot,f.context);
  if(!done||done.status!=="done")throw new Error("Actual forward proof source failed: "+(done?.failureReason??done?.cancelReason));
  const source=await inspectEditSource(done,"Forward dialogue bootstrap",f.studio.paths.artifactRoot,async()=>{});
  expect(source.job.livingScript!.proposal).toEqual(saved.proposal);
  // This tests the supported pure bootstrap boundary after an actual persisted
  // script update. It does not claim atomic linked-cut acceptance or publication.
  expect(f.projects.editScript(f.studio.owner.token,done.scriptText)!.version).toBe(done.scriptVersion);
  const project=f.projects.snapshot().projects[0]!,script=project.versions.at(-1)!,base=createLivingScriptStructureBase({projectId:project.id,version:script.version,text:script.text,locks:[]});
  const documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]}),originalPlan=bootstrapLivingScriptShotPlan(source,documentSource);
  const library=bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(project.id),{id:"forward-proof-canonical-root",label:"Actual forward source",script,source,documentSource,originalPlan,baseline:{casting:done.casting!,direction:baseline.direction}},0).library;
  const canonical=compileCurrentFilmJob(library,{kind:"accepted",revision:library.headRevision!},{role:"preview",tier:"free",providerPlan:f.plan.render.providerPlan}),target=compileCurrentFilmMixedJob(canonical,{origins:[],choices:[]});
  const authority:CurrentFilmProofContext={project:{...project,currentScreenplay:library},jobs:[done,f.studio.film,extraJob]};
  const proof=compileCurrentFilmProofClosure(target,authority);
  expect(proof.receipts.map(value=>value.receipt.job.id).sort()).toEqual([done.id,f.studio.film.id,extraJob.id].sort());
  expect(proof.receipts.find(value=>value.receipt.job.id===extraJob.id)!.requiredBy.map(value=>value.kind)).toContain("pending-proposal-source");
  expect(proof.proposalHistory[0]!.proposalRevision).toBe(saved.proposal.revision);expect(proof.savedProposalsRevision).toBe(saved.library.revision);
  // This declared image exists only in a later saved proposal's candidate cast,
  // never in a rendered source or the current canonical target. No image is read.
  const referenceAt=Date.now(),candidateAsset:ReferenceAsset={schema:"hv-reference/1",id:crypto.randomUUID(),projectId:project.id,sha256:"c".repeat(64),originalSha256:"d".repeat(64),bytes:24,width:1,height:1,contentType:"image/png",createdAt:new Date(referenceAt).toISOString(),attestedAt:new Date(referenceAt).toISOString()};
  const characters=structuredClone(baseline.casting.characters);characters[0]!.references=[candidateAsset];
  const candidate=compileLivingScriptGenerationImpact(bootstrap,patch,{...request.candidate,casting:castingSnapshot(project.id,baseline.casting.version+1,characters,referenceAt)}).candidateInputs;
  const later=createLivingScriptProposal(saved.library,project.id,editorial,{...request,id:"later-frozen-review",label:"Later frozen review",candidate},saved.library.version);
  const continuedContext={...authority,project:{...authority.project,livingScriptProposals:later.library,referenceAssets:[candidateAsset]}};
  const continued=compileCurrentFilmProofClosure(target,continuedContext);
  expect(continued.proposalHistory[0]).toEqual(proof.proposalHistory[0]);expect(continued.proposalHistory).toHaveLength(2);
  expect(proof.references).toEqual([]);expect(continued.references.map(value=>value.asset)).toEqual([candidateAsset]);
  expect(()=>compileCurrentFilmProofClosure(target,{...continuedContext,project:{...continuedContext.project,referenceAssets:[]}})).toThrow("missing or changed");
  expect(()=>compileCurrentFilmProofClosure(target,{...authority,jobs:authority.jobs.filter(job=>job.id!==extraJob.id)})).toThrow("carrier metadata");
  expect(()=>compileCurrentFilmProofClosure(target,{...authority,project:{...authority.project,livingScriptProposals:emptyLivingScriptProposals(project.id)}})).toThrow("exact authoritative saved");
  const lost=structuredClone(authority);lost.project.versions=lost.project.versions.filter(version=>version.version!==patch.before.version);
  expect(()=>compileCurrentFilmProofClosure(target,lost)).toThrow("exact original project version");
  const forged=structuredClone(authority);forged.project.livingScriptProposals!.proposals[0]!.impact.generation.generateShotIds=[];
  expect(()=>compileCurrentFilmProofClosure(target,forged)).toThrow();expect(proof.mediaVerified).toBe(false);
},300000);
