import {expect,test} from "bun:test";
import {DurableJobStore,type JobInput} from "../src/index";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {renderInputHash,renderRecord,renderShots,validateReusePlan,type ShotRenderRecord} from "../../planner/src/shot-reuse";
import type {ShotExecutionCheckpointPayload,ShotExecutionInventoryRow} from "../../planner/src/shot-execution-inventory";
const now=Date.now(),worker="execution-worker";
const input:JobInput={id:"film",projectId:"execution-checkpoint",idempotencyKey:"film",tier:"free",stage:"animatic",scriptVersion:1,scriptText:"INT. ROOM - DAY\nA lamp glows.\n\nINT. HALL - NIGHT\nA door opens.",providerPlan:createProviderPlan("animatic",1,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"}),totalFrames:120,costCapUsd:1,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,rightsAttestedAt:new Date(now).toISOString(),animaticJobId:null,animaticApprovedAt:null};
const planned=renderShots(input,now);
function setup(reused:ShotRenderRecord[]=[]){const store=DurableJobStore.fromJobs([]),data={projectId:input.projectId,shots:reused,forceShotIds:[]};
  const shotReuse=validateReusePlan({schema:"hv-shot-reuse/1",...data,revision:contentHash(data)},input,now);store.enqueue(structuredClone({...input,...(reused.length?{shotReuse}:{})}));store.claimNext(now,{}, {workerId:worker});return store;}
/** Domain-state metadata cases; actual dispatch/capture/media custody is exercised by worker tests. */
function evidence(index:number,reused=false,sourceJobId="original"){
  const shot=planned[index-1]!,shotId=shot.id,jobId=reused?sourceJobId:input.id,provider=input.providerPlan!.pool[0]!.snapshot;
  const original=renderRecord({projectId:input.projectId,jobId,shotId,inputHash:renderInputHash(input,shot),clip:{provider:provider.adapter,model:provider.model,seed:shot.seed,durationSec:shot.durationSec,fingerprint:"b".repeat(64)},files:{video:{path:`${input.projectId}/${jobId}/clips/${shotId}.mp4`,sha256:"c".repeat(64),bytes:10}},origin:{jobId,shotId}});
  const {schema:_schema,revision:_revision,...body}=original,record=reused?renderRecord({...body,jobId:input.id,files:{video:{...original.files.video,path:`${input.projectId}/${input.id}/clips/${shotId}.mp4`}},reusedFrom:{jobId:original.jobId,shotId,revision:original.revision}}):original;
  const row:ShotExecutionInventoryRow={shotId,recordRevision:record.revision,capture:null,unavailableReason:reused?"reused-source":"legacy-checkpoint"};return {record,row,original};}
const completeOutput=(items:ReturnType<typeof evidence>[])=>({mp4Path:"film.mp4",hlsPlaylistPath:"film.m3u8",captionsPath:"film.vtt",manifestPath:"manifest.json",shotRenders:items.map(item=>item.record),shotExecutions:items.map(item=>item.row)});

test("admission cannot inject checkpoint or completed execution evidence, including idempotent retries",()=>{
  const store=setup(),before=structuredClone(store.get(input.id));
  expect(()=>store.enqueue({...input,executionCheckpoints:[]} as JobInput)).toThrow(/cannot supply/);
  expect(()=>store.enqueue({...input,output:completeOutput([])})).toThrow(/cannot supply/);
  expect(store.get(input.id)).toEqual(before);
});

test("held checkpoint atomically preserves the legacy prefix and complete explicit reuse inventory through completion",()=>{
  const one=evidence(1),two=evidence(2,true),store=setup([two.original]);expect(planned.map(shot=>shot.id)).toEqual(["shot-1-1","shot-2-1"]);store.checkpoint(input.id,worker,1,60,now);
  const payload=structuredClone({records:[one.record,two.record],inventory:[one.row,two.row]});store.checkpoint(input.id,worker,2,120,now,60000,payload);
  payload.inventory[0]!.shotId="mutated-caller";expect(store.get(input.id)!.executionCheckpoints![0]!.shotId).toBe(one.record.shotId);
  const output=completeOutput([one,two]),done=store.complete(input.id,worker,output,now);expect(done.status).toBe("done");expect(done.output!.shotExecutions).toEqual(done.executionCheckpoints);
  output.shotExecutions[0]!.shotId="mutated-output";expect(done.output!.shotExecutions![0]!.shotId).toBe(one.record.shotId);
});

test("wrong worker, invalid frame/record prefix and missing later evidence cannot change held state",()=>{
  const one=evidence(1),two=evidence(2,true),store=setup([two.original]);store.checkpoint(input.id,worker,1,60,now);const payload={records:[one.record,two.record],inventory:[one.row,two.row]},before=structuredClone(store.get(input.id));
  const {schema:_schema,revision:_revision,...body}=one.record,wrongInput=renderRecord({...body,inputHash:"f".repeat(64)});
  for(const act of [()=>store.checkpoint(input.id,"stale-worker",2,120,now,60000,payload),()=>store.checkpoint(input.id,worker,2,119,now,60000,payload),()=>store.checkpoint(input.id,worker,2,120,now,Infinity,payload),
    ()=>store.checkpoint(input.id,worker,2,120,now,60000,{records:[one.record],inventory:[one.row]}),()=>store.checkpoint(input.id,worker,2,120,now,60000,{records:[two.record,one.record],inventory:[two.row,one.row]}),
    ()=>store.checkpoint(input.id,worker,1,60,now,60000,{records:[wrongInput],inventory:[{...one.row,recordRevision:wrongInput.revision}]})]){expect(act).toThrow();expect(store.get(input.id)).toEqual(before);}
  store.checkpoint(input.id,worker,2,120,now,60000,payload);const captured=structuredClone(store.get(input.id));
  expect(()=>store.checkpoint(input.id,worker,2,120,now)).toThrow(/every subsequent/);expect(store.get(input.id)).toEqual(captured);
  expect(()=>store.checkpoint(input.id,worker,1,60,now,60000,{records:[one.record],inventory:[one.row]})).toThrow(/truncate/);expect(store.get(input.id)).toEqual(captured);
});

test("new generated absence cannot be appended and output cannot introduce, omit or alter execution custody",()=>{
  const store=setup(),one=evidence(1),two=evidence(2);expect(()=>store.checkpoint(input.id,worker,1,60,now,60000,{records:[one.record],inventory:[one.row]})).toThrow(/newly generated/);
  expect(store.get(input.id)!.checkpointShots).toBe(0);expect(()=>store.complete(input.id,worker,completeOutput([one]),now)).toThrow(/Checkpoint the complete/);
  store.checkpoint(input.id,worker,2,120,now);store.checkpoint(input.id,worker,2,120,now,60000,{records:[one.record,two.record],inventory:[one.row,two.row]});const before=structuredClone(store.get(input.id)),output=completeOutput([one,two]),{shotExecutions:_private,...omitted}=output;
  expect(()=>store.complete(input.id,worker,omitted,now)).toThrow(/Checkpoint the complete/);expect(store.get(input.id)).toEqual(before);
  output.shotExecutions[0]!.recordRevision="e".repeat(64);expect(()=>store.complete(input.id,worker,output,now)).toThrow(/immutable shot record/);expect(store.get(input.id)).toEqual(before);
});

test("missing or different admitted reuse cannot append a copied record or change durable state",()=>{
  const one=evidence(1),two=evidence(2,true),other=evidence(2,true,"different-original"),payload={records:[one.record,two.record],inventory:[one.row,two.row]};
  for(const originals of [[],[other.original]]){const store=setup(originals);store.checkpoint(input.id,worker,1,60,now);const before=structuredClone(store.get(input.id));
    expect(()=>store.checkpoint(input.id,worker,2,120,now,60000,payload)).toThrow(/admitted/);expect(store.get(input.id)).toEqual(before);
  }
});

test("hostile checkpoint payload accessors are rejected without reads or durable mutation",()=>{
  const one=evidence(1),two=evidence(2,true),store=setup([two.original]);store.checkpoint(input.id,worker,1,60,now);const before=structuredClone(store.get(input.id));let reads=0;
  const payload=():ShotExecutionCheckpointPayload=>structuredClone({records:[one.record,two.record],inventory:[one.row,two.row]}),top=payload(),inventory=payload(),record=payload(),row=payload();
  Object.defineProperty(top,"records",{enumerable:true,get(){reads++;return [one.record,two.record];}});Object.defineProperty(inventory,"inventory",{enumerable:true,get(){reads++;return [one.row,two.row];}});
  Object.defineProperty(record.records[0],"inputHash",{enumerable:true,get(){reads++;return one.record.inputHash;}});Object.defineProperty(row.inventory[0],"capture",{enumerable:true,get(){reads++;return null;}});
  for(const hostile of [top,inventory,record,row]){expect(()=>store.checkpoint(input.id,worker,2,120,now,60000,hostile)).toThrow(/accessors/);expect(reads).toBe(0);expect(store.get(input.id)).toEqual(before);}
});
