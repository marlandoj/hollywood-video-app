import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ProjectService} from "../../api/src/index";
import {DeterministicMockProvider,RichAnimaticProvider,type VideoClip} from "../../generator/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {createReusePlan,renderInputHash,renderShots,validateRenderRecord} from "../../planner/src/shot-reuse";
import {validateShotExecutionCapture} from "../../planner/src/shot-execution-capture";
import {validateShotExecutionOutput} from "../../planner/src/shot-execution-inventory";
import {DurableJobStore,type Job,type JobInput} from "../src/index";
import {processNextJob,type WorkerContext} from "../src/worker";

const root=mkdtempSync(join(tmpdir(),"hv-worker-execution-")),media=join(root,"media"),script="INT. FIRST - DAY\nA lamp glows.\n\nINT. SECOND - NIGHT\nA door opens.";
const settings={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0",HV_TOKEN_SECRET:"private-execution-test-secret-at-least-thirty-two-characters"};
const prior=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
let original:Job,projects:ProjectService,projectId:string;
function fixture(id:string,changes:Partial<JobInput>={}){
  const store=new DurableJobStore(join(root,id+"-jobs.json"));
  const input:JobInput={id,projectId,idempotencyKey:id,tier:"free",stage:"animatic",scriptVersion:1,scriptText:script,providerPlan:createProviderPlan("animatic",5),totalFrames:120,
    retryPolicy:{maxRetries:1,backoffMs:0},timeoutMs:60000,costCapUsd:5,rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null,...changes};
  const context:WorkerContext={projects,ledger:new CostLedger(join(root,id+"-ledger.json")),reviewQueue:new OperatorReviewQueue(join(root,id+"-reviews.json"))};
  const manifest=join(media,projectId,id,"clips/manifest.json");return {store,input,context,manifest};
}
async function interrupt(id:string){
  const value=fixture(id);value.store.enqueue(value.input);const checkpoint=value.store.checkpoint.bind(value.store);let injected=false;
  const stop=spyOn(value.store,"checkpoint").mockImplementation((...args:Parameters<typeof checkpoint>)=>{checkpoint(...args);if(!injected){injected=true;throw new Error("Interruption after committed capture");}});
  let job:Job;try{job=(await processNextJob(value.store,media,value.context))!;}finally{stop.mockRestore();}
  expect(injected).toBe(true);expect(job!.status).toBe("queued");expect(job!.checkpointShots).toBe(1);expect(job!.executionCheckpoints).toHaveLength(1);
  return {...value,job:job!,clips:JSON.parse(readFileSync(value.manifest,"utf8")) as VideoClip[]};
}
beforeAll(async()=>{
  Object.assign(process.env,settings);projects=new ProjectService(join(root,"projects.json"));projectId=projects.createAnonymousProject().projectId;
  const value=fixture("normal");value.store.enqueue(value.input);original=(await processNextJob(value.store,media,value.context))!;
  if(original.status!=="done")throw new Error("Worker capture fixture failed: "+(original.failureReason??original.cancelReason));
},60000);
afterAll(()=>{for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(root,{recursive:true,force:true});});

test("actual pinned worker persists exact normal dispatch separately from unchanged shot and public media records",()=>{
  const reloaded=new DurableJobStore(join(root,"normal-jobs.json")).get(original.id)!;expect(reloaded).toEqual(original);
  expect(original.executionCheckpoints).toEqual(original.output!.shotExecutions);expect(original.executionCheckpoints).toHaveLength(2);
  validateShotExecutionOutput(original,original.output!);
  const shots=renderShots(original),manifest=JSON.parse(readFileSync(join(media,projectId,original.id,"clips/manifest.json"),"utf8")) as VideoClip[];
  for(const [index,row]of original.executionCheckpoints!.entries()){
    const record=original.output!.shotRenders![index]!,capture=row.capture!,before=contentHash(record);
    expect(row.unavailableReason).toBeNull();expect(capture.observation).toMatchObject({attempt:0,providerIndex:0,fallbackIndex:0});
    expect(capture.observation.emission.seed).toBe(shots[index]!.seed);expect(capture.observation.emission.params.seed).toBe(shots[index]!.seed);
    expect(capture.observation.emission.undefinedKeys).toContain("referenceFrames");expect(capture.observation.emission.referenceFrames).toBeNull();
    expect(capture.routes).toEqual(capture.routeDecisionIds.map(id=>original.routeDecisions!.find(route=>route.id===id)!));
    expect(validateShotExecutionCapture(capture,record)).toEqual(capture);expect(validateRenderRecord(record,original)).toEqual(record);expect(contentHash(record)).toBe(before);
    expect(record.inputHash).toBe(renderInputHash(original,shots[index]!));expect(record.schema).toBe("hv-shot-render/1");
    expect(Object.hasOwn(manifest[index]!,"capture")).toBe(false);expect(Object.hasOwn(record.clip,"shotExecutions")).toBe(false);
  }
  for(const path of [join(media,projectId,original.id,"clips/manifest.json"),join(media,original.output!.manifestPath)])expect(readFileSync(path,"utf8")).not.toContain("hv-shot-execution-capture/1");
});

test("actual fallback and continuity repairs retain only each final successful original dispatch",async()=>{
  process.env.HV_ANIMATIC_PROVIDER_POOL='["legacy-mock","mock"]';
  const value=fixture("fallback-repair"),generate=RichAnimaticProvider.prototype.generate,calls:number[]=[];
  const failed=spyOn(DeterministicMockProvider.prototype,"generate").mockRejectedValue(new Error("Controlled outage"));
  const success=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(async function(this:RichAnimaticProvider,...args:Parameters<typeof generate>){calls.push(args[1]);const clip=await generate.apply(this,args);return {...clip,fingerprint:(args[2].shotId==="shot-1-1"?"0":"f").repeat(64)};});
  let done:Job;try{value.store.enqueue(value.input);done=(await processNextJob(value.store,media,value.context))!;}finally{failed.mockRestore();success.mockRestore();process.env.HV_ANIMATIC_PROVIDER_POOL=settings.HV_ANIMATIC_PROVIDER_POOL;}
  expect(done!.status).toBe("done");expect(calls).toEqual([7000,7001,17001,27001]);
  const captures=done!.output!.shotExecutions!.map(row=>row.capture!);expect(captures.map(c=>[c.observation.attempt,c.observation.providerIndex,c.observation.fallbackIndex])).toEqual([[0,1,1],[2,1,0]]);
  expect(captures[0]!.routes.map(route=>route.selectedId)).toEqual(["legacy-mock","mock"]);expect(captures[1]!.observation.emission.seed).toBe(27001);expect(captures[1]!.observation.emission.params.seed).toBe(7001);
  validateShotExecutionOutput(done!,done!.output!);expect(done!.costUsd).toBe(0);
},60000);

test("local durable interruption and reload preserve the exact first capture and bytes without redispatch",async()=>{
  const value=await interrupt("resume"),prefix=structuredClone(value.job.executionCheckpoints![0]!),bytes=readFileSync(value.clips[0]!.path),generate=RichAnimaticProvider.prototype.generate,calls:string[]=[];
  const spy=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(function(this:RichAnimaticProvider,...args:Parameters<typeof generate>){calls.push(args[2].shotId!);return generate.apply(this,args);});
  let done:Job;try{done=(await processNextJob(new DurableJobStore(join(root,"resume-jobs.json")),media,value.context))!;}finally{spy.mockRestore();}
  expect(done!.status).toBe("done");expect(calls).toEqual(["shot-2-1"]);expect(done!.executionCheckpoints![0]).toEqual(prefix);expect(readFileSync(value.clips[0]!.path)).toEqual(bytes);validateShotExecutionOutput(done!,done!.output!);
},60000);

test("exact admitted reuse copies bytes but never fabricates a new original execution capture",async()=>{
  const value=fixture("reuse");value.input.shotReuse=createReusePlan(value.input,[original],["shot-2-1"]);expect(value.input.shotReuse.shots).toHaveLength(1);
  const store=DurableJobStore.fromJobs([original]);store.enqueue(value.input);const generate=RichAnimaticProvider.prototype.generate,calls:string[]=[];
  const spy=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(function(this:RichAnimaticProvider,...args:Parameters<typeof generate>){calls.push(args[2].shotId!);return generate.apply(this,args);});
  let done:Job;try{done=(await processNextJob(store,media,value.context))!;}finally{spy.mockRestore();}
  expect(done!.status).toBe("done");expect(calls).toEqual(["shot-2-1"]);expect(done!.executionCheckpoints![0]).toMatchObject({capture:null,unavailableReason:"reused-source"});expect(done!.executionCheckpoints![1]!.capture).not.toBeNull();
  const copied=done!.output!.shotRenders![0]!,source=original.output!.shotRenders![0]!;expect(copied.reusedFrom!.revision).toBe(source.revision);expect(copied.origin).toEqual(source.origin);
  for(const [role,file]of Object.entries(copied.files))expect(readFileSync(join(media,file.path))).toEqual(readFileSync(join(media,source.files[role as keyof typeof source.files]!.path)));
  validateShotExecutionOutput(done!,done!.output!);
},60000);

test("historical sealed prefixes migrate explicitly while an unsealed prefix keeps the whole job historical",async()=>{
  const value=await interrupt("legacy"),originalPrefix=structuredClone(value.clips[0]!);
  for(const sealed of [true,false]){
    const historical=structuredClone(value.job);delete historical.executionCheckpoints;
    const prefix=structuredClone(originalPrefix);if(!sealed)delete prefix.renderRecord;writeFileSync(value.manifest,JSON.stringify([prefix]));
    const done=(await processNextJob(DurableJobStore.fromJobs([historical]),media,value.context))!;expect(done.status).toBe("done");
    if(sealed){expect(done.executionCheckpoints![0]).toMatchObject({capture:null,unavailableReason:"legacy-checkpoint"});expect(done.executionCheckpoints![1]!.capture).not.toBeNull();validateShotExecutionOutput(done,done.output!);}
    else{expect(done.executionCheckpoints).toBeUndefined();expect(done.output!.shotExecutions).toBeUndefined();expect(done.output!.shotRenders).toBeUndefined();const completed=JSON.parse(readFileSync(value.manifest,"utf8"));expect(completed[0].renderRecord).toBeUndefined();expect(completed[1].renderRecord.schema).toBe("hv-shot-render/1");}
  }
},60000);

test("capture-bearing resumes reject missing rows, changed seals, counts and original bytes before inference",async()=>{
  const value=await interrupt("corruption"),prefixBytes=readFileSync(value.clips[0]!.path),manifestBytes=readFileSync(value.manifest);
  const cases:((job:Job)=>void)[]=[job=>{job.executionCheckpoints=[];},job=>{job.executionCheckpoints![0]!.capture!.observation.emission.seed++;},job=>{job.checkpointShots=3;},job=>{job.checkpointFrame++;},job=>{job.routeDecisions=[];},job=>{job.routeDecisions![0]!.candidates[0]!.health.samples++;}];
  const spy=spyOn(RichAnimaticProvider.prototype,"generate");try{
    for(const change of cases){const bad=structuredClone(value.job);change(bad);bad.retryPolicy.maxRetries=0;const rows=structuredClone(bad.executionCheckpoints),done=(await processNextJob(DurableJobStore.fromJobs([bad]),media,value.context))!;
      expect(done.status).not.toBe("done");expect(done.executionCheckpoints).toEqual(rows);expect(readFileSync(value.manifest)).toEqual(manifestBytes);expect(readFileSync(value.clips[0]!.path)).toEqual(prefixBytes);}
    const changed=Buffer.from(prefixBytes);changed[changed.length-1]^=1;writeFileSync(value.clips[0]!.path,changed);
    const done=(await processNextJob(DurableJobStore.fromJobs([value.job]),media,value.context))!;expect(done.status).not.toBe("done");expect(done.executionCheckpoints).toEqual(value.job.executionCheckpoints);expect(readFileSync(value.manifest)).toEqual(manifestBytes);
    expect(spy).not.toHaveBeenCalled();expect(value.context.ledger.monthSpend()).toBe(0);
  }finally{spy.mockRestore();writeFileSync(value.clips[0]!.path,prefixBytes);}
},60000);

test("a sealed historical checkpoint after the final shot can finish without redispatch or invented captures",async()=>{
  const historical=structuredClone(original);delete historical.executionCheckpoints;delete historical.output;historical.status="queued";historical.claimedBy=null;historical.leaseExpiresAt=null;historical.completedAt=null;
  const spy=spyOn(RichAnimaticProvider.prototype,"generate");let done:Job;try{done=(await processNextJob(DurableJobStore.fromJobs([historical]),media,fixture("legacy-complete").context))!;}finally{spy.mockRestore();}
  expect(spy).not.toHaveBeenCalled();expect(done!.status).toBe("done");expect(done!.executionCheckpoints!.map(row=>[row.capture,row.unavailableReason])).toEqual([[null,"legacy-checkpoint"],[null,"legacy-checkpoint"]]);validateShotExecutionOutput(done!,done!.output!);
},60000);
