import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../src/edit-source-media";
import {soundRuntimeRevision} from "../src/sound-audio";
import {contentHash} from "../src/capabilities";
import {audioCapability} from "../src/audio-capabilities";
import {cartesiaLineRequest,type AudioDispatchIntent} from "../src/cartesia-audio";
import {bindOriginalEditSource,createEditPlan,editPerformanceReceipts,editRenderReview} from "../../planner/src/edit-jobs";
import {editHistoryState} from "../../planner/src/edit-history";
import {DurableJobStore} from "../../queue/src/index";
import {validateSnapshot,snapshotSummary,type StateSnapshot} from "../../storage/src/snapshots";
import type {StoredAudioAttempt,AudioAllocation} from "../../storage/src/audio-ledger";
test("editorial snapshots conserve original synthetic audition holds and invoice allocations after source jobs are removed",async()=>{
  const f=await dubStudio();try{
    const quote=await f.quote(),submitted=await f.call(f.base+"/dialogue/"+f.film.id,"POST",f.requestBody(quote),f.owner.token);expect(submitted.status).toBe(202);const dubbed=(await f.worker())!;expect(dubbed.status).toBe("done");
    const receipt=await inspectEditSource(dubbed,"Synthetic dubbed fixture",f.paths.artifactRoot,async()=>{}),library=f.projects.createEditSequence(f.owner.token,[receipt],crypto.randomUUID(),"Accounting fixture",dubbed.id,640,360,0)!,sequence=library.sequences[0]!,timeline=editHistoryState(sequence.history).timeline,plan=createEditPlan(sequence,[bindOriginalEditSource(receipt)],soundRuntimeRevision(),"local",contentHash("accounting fixture"),editRenderReview(timeline));
    const queued=DurableJobStore.fromJobs([]).enqueue({id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),projectId:dubbed.projectId,tier:"free",stage:"picture-edit",scriptVersion:dubbed.scriptVersion,scriptText:dubbed.scriptText,rightsAttestedAt:dubbed.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:timeline.frames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,pictureEdit:plan});
    const sources=editPerformanceReceipts(plan).auditions;expect(sources).toHaveLength(2);
    const attempts:StoredAudioAttempt[]=sources.map(source=>{const line=source.take.line,capability=audioCapability(line.capabilityRevision)!,id=source.output.report.attemptId,intent:AudioDispatchIntent={schema:"hv-audio-dispatch/1",attemptId:id,contextId:id,planRevision:line.revision,capabilityRevision:line.capabilityRevision,requestSha256:contentHash(cartesiaLineRequest(line,id)),provider:"cartesia",model:capability.model,apiVersion:capability.apiVersion},reservation={id:source.jobId,priceRevision:source.take.policy.priceRevision,heldUsd:source.take.policy.heldUsd};
      return {id,projectId:source.projectId,jobId:source.jobId,workerId:"synthetic-fixture",leaseVersion:1,status:"unknown",estimatedUsd:reservation.heldUsd,actualUsd:null,createdAt:source.completedAt,updatedAt:source.completedAt,audio:{schema:"hv-audio-attempt/1",intent,reservation,accountRevision:source.take.policy.accountRevision,policyRevision:source.take.policy.revision,outcome:{schema:"hv-audio-attempt-outcome/1",intent,reservation,dispatched:true,providerState:"completed",deliveryState:"ready",httpStatus:200,providerRequestId:null,billing:{state:"unreconciled",actualUsd:null},deliveryRevision:source.output.report.revision}}};});
    const snapshot:StateSnapshot={schema:"hv-state/4",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:[{...queued,status:"failed"}],ledger:{events:[],audioAttempts:attempts,reservations:attempts.map(a=>({jobId:a.jobId,stage:"audio-take",amountUsd:a.estimatedUsd,remainingUsd:a.estimatedUsd,createdAt:a.createdAt}))},reviews:[]};
    expect(validateSnapshot(snapshot).ledger.audioAttempts).toEqual(attempts);expect(()=>validateSnapshot({...snapshot,ledger:{events:[],reservations:[]}})).toThrow("original accounting provenance");
    const settled=structuredClone(snapshot);settled.ledger.reservations=[];
    for(const a of settled.ledger.audioAttempts!){const data={schema:"hv-audio-allocation/1" as const,documentSha256:contentHash("SYNTHETIC FIXTURE INVOICE"),accountRevision:a.audio.accountRevision,invoiceRevision:contentHash("SYNTHETIC FIXTURE ALLOCATION"),attemptId:a.id,usd:.1,at:a.createdAt},invoice:AudioAllocation={...data,revision:contentHash(data)};a.audio.invoice=invoice;a.status="succeeded";a.actualUsd=invoice.usd;
      settled.ledger.events.push({eventId:"audio:"+invoice.documentSha256+":"+a.id,projectId:a.projectId,jobId:a.jobId,attemptId:a.id,shotId:"audio-line",stage:"audio-take",provider:a.audio.intent.provider,model:a.audio.intent.model,prompt_tokens:0,gpu_seconds:0,output_frames:0,total_cost_usd:invoice.usd,audioBilling:invoice,at:a.createdAt} as StateSnapshot["ledger"]["events"][number]);
    }
    expect(snapshotSummary(validateSnapshot(settled)).totalUsd).toBe(.2);expect(settled.jobs[0]!.costUsd).toBe(0);expect(settled.jobs).toHaveLength(1);const missing=structuredClone(settled);missing.ledger.events.pop();expect(()=>validateSnapshot(missing)).toThrow("invoice allocation");
  }finally{await f.close();}
},90000);
