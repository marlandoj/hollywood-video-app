import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {ProjectService} from "../../api/src/index";
import {currentScreenplayHead,saveCurrentScreenplayProposal,acceptCurrentScreenplayProposal} from "../src/current-screenplay-library";
import {compileLivingScriptStructure,livingScriptStructureBlock,livingScriptStructureBoundary} from "../src/living-script-structure";
import {compileLivingScriptDocument} from "../src/living-script-document";
import {proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";
import {directionSettings} from "../src/direction";
import {compileCurrentFilmJob} from "../src/current-film-jobs";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {compileCurrentFilmMixedJob} from "../src/current-film-mixed-jobs";
import {currentFilmV3Job} from "../src/current-film-runtime-context";
import type {CurrentFilmMixedJob} from "../src/current-film-mixed-job-context";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";

/** Actual V2/bootstrap setup and a separately invoked V3 worker. Callers give
 * setup and run() their own settled test phases; no completed owner is invented.
 * close() refuses while the signalless worker still owns the fixture. */
export async function prepareCurrentFilmMixedSourceFixture(options:{longDelivery?:boolean}={}){
  const f=await currentFilmSourceFixture({terminateFinalLine:true});
  try{
    const sourceOrdinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.files.audio));
    if(sourceOrdinal<0)throw new Error("The mixed source fixture requires an actual native-speech source.");
    const accepted=f.accept(),library=accepted.currentScreenplay!,head=currentScreenplayHead(library)!,state=head.state,document=state.context.plan.document,base=document.context.base;
    const last=document.scenes.at(-1)!;
    const patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"mixed-source-move",kind:"move",
      block:livingScriptStructureBlock(base,last.startLine,last.endLine),to:livingScriptStructureBoundary(base,document.scenes[0]!.startLine)}]}),
      afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]}),capacity={tier:"free" as const,maxShots:24 as const};
    const evolution=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument,capacity,requestId:"mixed-source-move-plan"});
    if(!evolution.review.candidate||evolution.review.conflicts.length)throw new Error("The mixed source fixture requires exact moved-scene correspondence.");
    // Only the native delivery-order suite requests a longer fresh silent
    // shot. This is a saved owner direction before planning/admission, not a
    // rewrite of completed media. Other fixture callers keep identical inputs.
    const deliverySlot=options.longDelivery?f.plan.materialization.slots.find(slot=>slot.ordinal!==sourceOrdinal&&slot.physical.spoken.length===0):undefined;
    if(options.longDelivery&&!deliverySlot)throw new Error("Delivery order qualification requires a separate silent target shot.");
    const deliverySettings=deliverySlot?[{shotId:deliverySlot.logicalShotId,settings:directionSettings({...state.direction.entries.find(entry=>entry.shotId===deliverySlot.logicalShotId)!.settings,durationFrames:90})}]:[];
    const saved=saveCurrentScreenplayProposal(library,{id:"mixed-source-moved",label:"Move retained repeated speech",expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,capacity,
      planRequest:evolution.request,directionRequest:createCurrentDirectionRequest(state.direction,evolution.review.candidate,{id:"mixed-source-move-direction",settings:deliverySettings,lines:[],retired:[]})},library.version);
    const target=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},f.plan.request),original=f.job.currentFilmCheckpoint!.rows[sourceOrdinal]!;
    const ordinal=target.materialization.slots.findIndex(slot=>slot.logicalShotId===f.plan.materialization.slots[sourceOrdinal]!.logicalShotId),slot=target.materialization.slots[ordinal]!;
    if(ordinal<0||ordinal===sourceOrdinal)throw new Error("The mixed source fixture must change the retained speech's physical address.");
    const plan=compileCurrentFilmMixedJob(target,{origins:[bindOriginalEditSource(f.receipt)],choices:[{
      ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,source:{receiptRevision:f.receipt.revision,ordinal:sourceOrdinal,
        logicalShotId:original.logicalShotId,renderId:original.renderId,inputRevision:original.inputRevision,recordRevision:original.record.revision},
    }]});
    if(!plan.selection.some(row=>row.kind==="generate"))throw new Error("The mixed source fixture requires fresh and adopted slots.");
    if(deliverySlot){
      const target=plan.materialization.slots.find(slot=>slot.logicalShotId===deliverySlot.logicalShotId);
      if(!target||target.ordinal===ordinal||target.physical.spoken.length||target.shot.dialogue.length||target.recipe.dispatch.params.durationSec!==3||target.recipe.dispatch.params.exactDuration!==true||plan.selection[target.ordinal]?.kind!=="generate")throw new Error("Delivery order qualification must change only a fresh silent target to three seconds.");
    }
    const id="mixed-source-preview",store=DurableJobStore.fromJobs(f.store.all()),project={...accepted,currentScreenplay:saved.library};
    const request:JobInput={id,projectId:plan.projectId,idempotencyKey:id,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,
      scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
      rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,
      costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:600000};
    const root=f.studio.paths.artifactRoot,projects=ProjectService.fromState({...f.projects.snapshot(),projects:[project]}),context={...f.context,projects};
    const accept=(at=Date.now())=>{const result=acceptCurrentScreenplayProposal(saved.library,{id:"accept-mixed-source-move",proposalRevision:saved.proposal.revision,expectedHeadRevision:head.revision},saved.library.version,at);
      return {...structuredClone(project),currentScreenplay:result.library,versions:[...project.versions,...result.versions],castingHistory:[...(project.castingHistory??[]),result.acceptance.state.casting.candidate!]};};
    let admitted=false,started=false,settled=false,active=false,closed=false;
    let executionResult:Awaited<ReturnType<typeof processNextJob>>|undefined;
    const admit=()=>{
      if(admitted||started||closed)throw new Error("The mixed source request may be admitted only once.");
      const queued=store.enqueue(request);admitted=true;return structuredClone(queued);
    };
    // The caller measures claim/telemetry prelude and finalization separately:
    // processNextJob's own 600s deadline starts after its actual claim succeeds.
    const execute=async():Promise<Awaited<ReturnType<typeof processNextJob>>>=>{
      if(!admitted||started||closed)throw new Error("Admit the exact source request before its single worker invocation.");
      started=true;active=true;
      try{return executionResult=await processNextJob(store,root,{...context,workerId:"mixed-source-fixture"});}
      finally{active=false;settled=true;}
    };
    const read=():CurrentFilmMixedJob=>{
      if(!settled||active||closed)throw new Error("The actual source worker must settle before validating its completion.");
      const result=executionResult;
      if(!result||result.id!==request.id||result.projectId!==request.projectId||result.status!=="done")throw new Error("The actual mixed source worker did not complete: "+(result?.failureReason??result?.cancelReason??"no job"));
      const job=currentFilmV3Job(structuredClone(result));
      if(!job.currentFilmProof||!job.currentFilmCheckpoint?.rows.some(row=>row.kind==="reused")||!job.currentFilmCheckpoint.rows.some(row=>row.kind==="generated"))throw new Error("The mixed source fixture lost actual proof or execution custody.");
      return job;
    };
    // Compatibility for callers not yet migrated to separate settled phases.
    const run=async():Promise<CurrentFilmMixedJob>=>{admit();await execute();return read();};
    const close=async()=>{if(active)throw new Error("Preserving the mixed source fixture while its worker is active.");if(!closed){closed=true;await f.close();}};
    return {f,plan,request,store,context,project,root,ordinal,sourceOrdinal,saved,accept,admit,execute,read,run,close,get active(){return active;}};
  }catch(error){await f.close();throw error;}
}
