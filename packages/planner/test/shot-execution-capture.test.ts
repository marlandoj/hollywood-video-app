import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {baseCapability,capability,contentHash,type RoutingStrategy} from "../../generator/src/capabilities";
import {createProviderPlan,instantiateProviderPlan} from "../../generator/src/catalog";
import type {RoutingQuality} from "../../generator/src/quality-routing";
import {routingQualityFrom} from "../../benchmarks/src/routing-results";
import {measuredRecord} from "../../benchmarks/test/measured-records";
import {ProviderHealth,RoutedGenerator,type RouteDecision,type RouteRanking,type RouterOptions} from "../../generator/src/router";
import {RichAnimaticProvider} from "../../generator/src/animatic";
import {DeterministicMockProvider,type GenParams,type ProviderAdapter} from "../../generator/src/index";
import {parseFountain} from "../../parser/src/index";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {renderRecord,renderShots} from "../src/shot-reuse";
import {compileShotRenderRecipe,resolveShotRenderAttempt,type ShotDispatchParams} from "../src/shot-render-recipe";
import {directionSettings} from "../src/direction";
import type {Shot} from "../src/index";
import type {ReferenceAsset} from "../src/references";
import type {ShotExecutionEmission} from "../src/shot-execution-equivalence";
import {createShotExecutionCapture,validateShotExecutionCapture,SHOT_EXECUTION_CAPTURE_LIMITS,type ShotExecutionCapture} from "../src/shot-execution-capture";

const scratch=mkdtempSync(join(tmpdir(),"hv-execution-capture-")),projectId="private-execution-capture",at=Date.now(),script="INT. FIRST - DAY\nA lamp glows.\n\nINT. SECOND - NIGHT\nA door opens.";
let done:Job,captures:ShotExecutionCapture[];
const emissions:ShotExecutionEmission[]=[],rankings:RouteRanking[]=[];
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};
/** Test-only interception at actual adapter invocation, not production persistence. */
function emission(prompt:string,seed:number,params:GenParams):ShotExecutionEmission {
  const callbacks=["signal","beforeAttempt","onAttemptCost","afterAttempt","onProviderRequest"],{signal:_signal,beforeAttempt:_before,onAttemptCost:_cost,afterAttempt:_after,onProviderRequest:_request,referenceFrames,frameAnchors,...scalars}=params;
  const identity=(image:string)=>{const bytes=Buffer.from(image.split(",")[1]!,"base64");return {sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};};
  return {prompt,seed,params:Object.fromEntries(Object.entries(scalars).filter(([,value])=>value!==undefined)) as ShotDispatchParams,undefinedKeys:Object.keys(params).filter(key=>!callbacks.includes(key)&&params[key as keyof GenParams]===undefined).sort(),
    referenceFrames:referenceFrames?.map(identity)??null,frameAnchors:frameAnchors?{mode:frameAnchors.mode,frames:frameAnchors.frames.map(frame=>({at:frame.at,...identity(frame.image)}))}:null};
}
beforeAll(async()=>{
  const prior={pool:process.env.HV_ANIMATIC_PROVIDER_POOL,narration:process.env.HV_NARRATION,captions:process.env.HV_ANIMATIC_CAPTIONS};
  process.env.HV_ANIMATIC_PROVIDER_POOL='["legacy-mock","mock"]';process.env.HV_NARRATION="0";process.env.HV_ANIMATIC_CAPTIONS="0";
  const route=RoutedGenerator.prototype.generate,render=RichAnimaticProvider.prototype.generate;
  // Observe the production callback independently while preserving worker persistence.
  const routing=spyOn(RoutedGenerator.prototype,"generate").mockImplementation(async function(this:RoutedGenerator,prompt,seed,params,path){
    const options=(this as unknown as {options:RouterOptions}).options,previous=options.onRanking;options.onRanking=value=>{rankings.push(value);previous?.(value);};
    try{return await route.call(this,prompt,seed,params,path);}finally{if(previous)options.onRanking=previous;else delete options.onRanking;}
  }),primary=spyOn(DeterministicMockProvider.prototype,"generate").mockRejectedValue(new Error("Controlled first-provider outage")),success=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(async function(this:RichAnimaticProvider,prompt,seed,params,path){
    emissions.push(emission(prompt,seed,params));const clip=await render.call(this,prompt,seed,params,path);return {...clip,fingerprint:(params.shotId==="shot-1-1"?"0":"f").repeat(64)};
  });
  try{
    const providerPlan=createProviderPlan("animatic",5),runtime=instantiateProviderPlan(providerPlan),store=new DurableJobStore(join(scratch,"jobs.json")),job:JobInput={id:"actual-worker",projectId,idempotencyKey:"actual-worker",tier:"free",stage:"animatic",scriptVersion:1,scriptText:script,providerPlan,totalFrames:120,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,costCapUsd:5,rightsAttestedAt:new Date(at).toISOString(),animaticJobId:null,animaticApprovedAt:null};
    store.enqueue(job);const completed=await processNextJob(store,join(scratch,"media"),{ledger:new CostLedger(join(scratch,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(scratch,"reviews.json"))});
    if(completed?.status!=="done")throw new Error("Actual capture worker failed: "+completed?.failureReason);done=completed;
    const shots=renderShots(done,Date.parse(done.startedAt!));captures=done.output!.shotRenders!.map((record,index)=>{
      const shot=shots[index]!,recipe=compileShotRenderRecipe({projectId,stage:"animatic",shot,sceneHeading:parseFountain(script).scenes[shot.sceneIndex]!.heading,outputSize:"640x360",providerPlan,richAnimaticProviders:runtime.map(value=>value.adapter instanceof RichAnimaticProvider)}),observed=emissions.find(value=>value.params.shotId===shot.id&&value.seed===record.clip.seed)!,ranking=rankings.find(value=>value.shotId===shot.id&&value.seed===record.clip.seed)!;
      return createShotExecutionCapture(record,{observation:{recipe,attempt:(record.clip.seed-shot.seed)/10000,providerIndex:1,fallbackIndex:record.clip.routing!.decisionIds.length-1,emission:observed},ranking,routes:record.clip.routing!.decisionIds.map(id=>done.routeDecisions!.find(value=>value.id===id)!)});
    });
  }finally{routing.mockRestore();primary.mockRestore();success.mockRestore();for(const [key,value]of [["HV_ANIMATIC_PROVIDER_POOL",prior.pool],["HV_NARRATION",prior.narration],["HV_ANIMATIC_CAPTIONS",prior.captions]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}}
},60000);
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));

/** Policy-only adapter stubs exercise the real router. Their sealed metadata does not
 * assert that these fictional file handles contain independently verified media. */
async function policyCapture(strategy:RoutingStrategy,entries:{price:number;mode?:"native"|"storyboard"}[],anchors=false,changeHealth=false,options:{changeIdentity?:"provider"|"model";recoverCircuit?:boolean;ninthAnchor?:boolean;quality?:(pool:{spec:string;snapshot:ReturnType<typeof capability>}[])=>RoutingQuality}={}) {
  let time=100000;const image=Buffer.alloc(24,1),sha=createHash("sha256").update(image).digest("hex"),asset:ReferenceAsset={schema:"hv-reference/1",id:"dce4b051-9e2a-4026-aa03-9c0621f866e8",projectId,sha256:sha,originalSha256:sha,bytes:image.length,width:32,height:24,contentType:"image/png",createdAt:new Date(time).toISOString(),attestedAt:new Date(time).toISOString()};
  const pool=entries.map((entry,index)=>{const name="policy-"+index,definition=baseCapability(name,name+"-model","video");definition.output.nativeResolution="requested";definition.price={...definition.price,unit:entry.price?"request":"free",usd:entry.price};if(entry.mode){definition.frameControls={first:true,last:true,intermediate:true};definition.frameControlMode=entry.mode;}return {spec:options.ninthAnchor&&index===8?"anchor-storyboard":name,snapshot:capability(definition)};});
  const quality=options.quality?.(pool),data={stage:"final" as const,strategy,maxShotUsd:5,requirements:createProviderPlan("final",5,undefined,{}).requirements,pool,...(quality?{quality}:{})},plan={...data,schema:"hv-provider-plan/1" as const,revision:contentHash(data)},shot:Shot={id:"policy-shot",sceneIndex:0,prompt:"A quiet room.",dialogue:[],seed:42,durationSec:2,...(anchors?{direction:directionSettings({frameAnchors:{frames:[{at:0,asset}],fallback:"storyboard"}})}:{})};
  const recipe=compileShotRenderRecipe({projectId,stage:"final",shot,sceneHeading:"INT. ROOM - DAY",outputSize:"640x360",providerPlan:plan,richAnimaticProviders:pool.map(()=>false)}),attempt=resolveShotRenderAttempt(recipe,2),health=new ProviderHealth(()=>time),routes:RouteDecision[]=[];
  if(strategy==="latency")for(const [i,entry]of pool.entries())for(let n=0;n<3;n++)health.record(entry.snapshot.revision,true,10+i*90);
  if(options.recoverCircuit){for(let n=0;n<3;n++)health.record(pool[0]!.snapshot.revision,false,10);time+=30001;}
  let ranking:RouteRanking|undefined,observed:ShotExecutionEmission|undefined,refreshes=0;const calls:string[]=[];
  const candidates=pool.map(entry=>({id:entry.spec,adapter:{name:entry.snapshot.adapter,model:entry.snapshot.model,capabilities:entry.snapshot,generate:async(prompt,seed,params,path)=>{
    calls.push(entry.spec);if(options.ninthAnchor&&entry.spec!=="anchor-storyboard")throw new Error("Controlled prior candidate failure");observed=emission(prompt,seed,params);return {path,seed,provider:entry.snapshot.adapter,model:entry.snapshot.model,durationSec:2,fingerprint:"a".repeat(64),cost:{provider:entry.snapshot.adapter,model:entry.snapshot.model,prompt_tokens:0,output_frames:60,gpu_seconds:0,total_cost_usd:0}};
  }}} satisfies {id:string;adapter:ProviderAdapter}));
  const result=await new RoutedGenerator({candidates,strategy,...(quality?{quality}:{}),maxAttemptUsd:5,planRevision:plan.revision,now:()=>time,health,onRanking:value=>{ranking=value;},onDecision:async value=>{routes.push(value);},availableUsd:async()=>{
    if(++refreshes===2){if(changeHealth)health.record(pool[0]!.snapshot.revision,true,10000);if(options.changeIdentity)candidates[0]!.adapter[options.changeIdentity==="provider"?"name":"model"]="observed-identity-drift";}return 5;
  }})
    .generate(attempt.prompt,attempt.seed,{...attempt.params,referenceFrames:undefined,frameAnchors:recipe.anchors?{mode:recipe.anchors.mode,frames:[{at:0,image:"data:image/png;base64,"+image.toString("base64")}]}:undefined},"unused");
  const {path:_path,cost:_cost,...clip}=result,record=renderRecord({projectId,jobId:"policy-job",shotId:shot.id,inputHash:contentHash({plan,shot}),origin:{jobId:"policy-job",shotId:shot.id},files:{video:{path:projectId+"/policy-job/clips/shot.mp4",sha256:"a".repeat(64),bytes:24}},clip});
  const capture=createShotExecutionCapture(record,{observation:{recipe,attempt:2,providerIndex:pool.findIndex(entry=>entry.spec===routes.at(-1)!.selectedId),fallbackIndex:routes.length-1,emission:observed!},ranking:ranking!,routes});return {record,capture,calls};
}

test("actual worker captures successful fallback and repair attempts beside unchanged legacy render records",()=>{
  expect(captures.map(value=>[value.shotId,value.observation.attempt,value.observation.fallbackIndex])).toEqual([["shot-1-1",0,1],["shot-2-1",2,0]]);
  expect(rankings.map(value=>[value.shotId,value.seed])).toEqual([["shot-1-1",7000],["shot-2-1",7001],["shot-2-1",17001],["shot-2-1",27001]]);
  for(const [index,capture]of captures.entries()){
    const record=done.output!.shotRenders![index]!,before=contentHash(record);expect(validateShotExecutionCapture(JSON.parse(JSON.stringify(capture)),record)).toEqual(capture);expect(contentHash(record)).toBe(before);expect(record.schema).toBe("hv-shot-render/1");
    expect(capture.recordRevision).toBe(record.revision);expect(capture.inputHash).toBe(record.inputHash);expect(capture.routeDecisionIds).toEqual(record.clip.routing!.decisionIds);expect(capture.custody).toBe("unverified");expect(capture.currentAuthority).toBe(false);
    expect(Object.hasOwn(capture,"job")).toBe(false);expect(Object.hasOwn(capture,"record")).toBe(false);expect(JSON.stringify(capture)).not.toContain(record.files.video.path);expect(Object.hasOwn(record.clip,"capture")).toBe(false);
  }
  expect(captures[0]!.routes.map(route=>route.selectedId)).toEqual(["legacy-mock","mock"]);expect(captures[1]!.observation.emission.seed).toBe(27001);expect(captures[1]!.observation.emission.params.seed).toBe(7001);
});

test("captures reproduce configured, cost, native-anchor and initial latency ranks from actual router observations",async()=>{
  for(const value of [
    {strategy:"configured" as const,entries:[{price:3},{price:1},{price:1}],anchors:false,expected:["policy-0","policy-1","policy-2"]},
    {strategy:"cost" as const,entries:[{price:3},{price:1},{price:1}],anchors:false,expected:["policy-1","policy-2","policy-0"]},
    {strategy:"cost" as const,entries:[{price:0,mode:"storyboard" as const},{price:3,mode:"native" as const},{price:1,mode:"native" as const}],anchors:true,expected:["policy-2","policy-1","policy-0"]},
    {strategy:"latency" as const,entries:[{price:0},{price:0}],anchors:false,expected:["policy-0","policy-1"]}
  ]){
    const {record,capture}=await policyCapture(value.strategy,value.entries,value.anchors,value.strategy==="latency");expect(capture.ranking.orderedIds).toEqual(value.expected);expect(validateShotExecutionCapture(capture,record)).toEqual(capture);expect(JSON.stringify(capture)).not.toContain("data:image");
    if(value.strategy==="latency"){expect(capture.ranking.candidates[0]!.health.latencyMs).toBe(10);expect(capture.routes[0]!.candidates[0]!.health.latencyMs!).toBeGreaterThan(capture.routes[0]!.candidates[1]!.health.latencyMs!);}
    const bad=structuredClone(capture);bad.ranking.orderedIds.reverse();bad.ranking=reseal(bad.ranking);expect(()=>validateShotExecutionCapture(reseal(bad),record)).toThrow(/routing policy/);
  }
});

test("captures reproduce a quality rank from the plan's pinned measured scores, and refuse an edited score",async()=>{
  // policy-2 measured best, policy-1 next, policy-0 unmeasured: the configured order is reversed.
  const measured=(pool:{spec:string;snapshot:ReturnType<typeof capability>}[])=>routingQualityFrom(Buffer.from(JSON.stringify([2,1].map((index,rank)=>measuredRecord({spec:pool[index]!.spec,provider:pool[index]!.snapshot.adapter,model:pool[index]!.snapshot.model,capabilityRevision:pool[index]!.snapshot.revision},rank?64:8)))));
  const {record,capture,calls}=await policyCapture("quality",[{price:0},{price:0},{price:0}],false,false,{quality:measured});
  expect(calls).toEqual(["policy-2"]);expect(capture.ranking.orderedIds).toEqual(["policy-2","policy-1","policy-0"]);expect(capture.routes[0]!.quality!.selectedScore).toBe(1-8/256);
  expect(validateShotExecutionCapture(capture,record)).toEqual(capture);
  const reversed=structuredClone(capture);reversed.ranking.orderedIds.reverse();reversed.ranking=reseal(reversed.ranking);expect(()=>validateShotExecutionCapture(reseal(reversed),record)).toThrow(/routing policy/);
  const invented=structuredClone(capture);invented.routes[0]!.quality!.candidates[2]!.score=.5;expect(()=>validateShotExecutionCapture(reseal(invented),record)).toThrow(/quality scores/);
  const dropped=structuredClone(capture);delete dropped.routes[0]!.quality;expect(()=>validateShotExecutionCapture(reseal(dropped),record)).toThrow(/exact shot execution capture fields/);
});

test("resealed capture tampering cannot replace original identity, emission, successful attempt or fallback history",()=>{
  const record=done.output!.shotRenders![0]!,capture=captures[0]!;
  const changes:((value:ShotExecutionCapture)=>void)[]=[value=>{value.projectId="foreign";},value=>{value.jobId="another";},value=>{value.shotId="other-shot";},value=>{value.inputHash="a".repeat(64);},value=>{value.recordRevision="b".repeat(64);},value=>{value.custody="trusted" as "unverified";},value=>{value.currentAuthority=true as false;},
    value=>{value.observation.attempt=1;},value=>{value.observation.providerIndex=0;},value=>{value.observation.fallbackIndex=0;},value=>{value.observation.emission.undefinedKeys=[];},value=>{value.routes.reverse();},value=>{value.routeDecisionIds.reverse();},value=>{value.routes[0]!.selectedId="mock";}];
  for(const change of changes){const changed=structuredClone(capture);change(changed);expect(()=>validateShotExecutionCapture(reseal(changed),record)).toThrow();}
  const copied=structuredClone(record);copied.clip.seed++;const {schema:_schema,revision:_revision,...body}=copied;expect(()=>validateShotExecutionCapture(capture,renderRecord(body))).toThrow();
  const reused=renderRecord({...body,clip:record.clip,origin:{jobId:"earlier",shotId:record.shotId},reusedFrom:{jobId:"earlier",shotId:record.shotId,revision:"c".repeat(64)}});expect(()=>createShotExecutionCapture(reused,{observation:capture.observation,ranking:capture.ranking,routes:capture.routes})).toThrow(/original fresh/);
});

test("rank snapshot checks all admitted candidates, budgets, initial health, order and own seals",async()=>{
  const {record,capture}=await policyCapture("latency",[{price:0},{price:0}],false,true);
  const changes:((value:RouteRanking)=>void)[]=[value=>{value.candidates[0]!.index=1;},value=>{value.candidates.reverse();},value=>{value.candidates[0]!.capabilityRevision="a".repeat(64);},value=>{value.candidates[0]!.estimateUsd=1;},value=>{value.candidates[0]!.health.latencyMs=1000;},value=>{value.candidates[0]!.health.observedAt="not-a-date";},value=>{value.candidates[0]!.health.samples=0;},value=>{value.budget=6;},value=>{value.at="1970-01-01T00:00:01.000Z";},value=>{value.planRevision="b".repeat(64);},value=>{value.seed++;}];
  for(const change of changes){const bad=structuredClone(capture);change(bad.ranking);bad.ranking=reseal(bad.ranking);expect(()=>validateShotExecutionCapture(reseal(bad),record)).toThrow();}
});

test("actual routing preserves skipped identity drift but the successful provider stays exactly pinned",async()=>{
  for(const changeIdentity of ["model","provider"] as const){
    const {record,capture,calls}=await policyCapture("configured",[{price:0},{price:0}],false,false,{changeIdentity});expect(calls).toEqual(["policy-1"]);
    const changed=capture.routes[0]!.candidates[0]!;expect(changed).toMatchObject({eligible:false,reasons:["capability-changed"],[changeIdentity]:"observed-identity-drift"});expect(capture.observation.providerIndex).toBe(1);expect(capture.observation.fallbackIndex).toBe(0);expect(validateShotExecutionCapture(capture,record)).toEqual(capture);
    const noReason=structuredClone(capture);noReason.routes[0]!.candidates[0]!.reasons=[];expect(()=>validateShotExecutionCapture(reseal(noReason),record)).toThrow(/pinned capabilities/);
    const selected=structuredClone(capture);selected.routes[0]!.candidates[1]!.model="different-success";expect(()=>validateShotExecutionCapture(reseal(selected),record)).toThrow(/pinned capabilities/);
    const {schema:_schema,revision:_revision,...body}=record,changedRecord=renderRecord({...body,clip:{...body.clip,model:"different-success"}});expect(()=>createShotExecutionCapture(changedRecord,{observation:capture.observation,ranking:capture.ranking,routes:capture.routes})).toThrow(/successful provider/);
  }
});

test("only an actual half-open recovery circuit may report an in-flight probe",async()=>{
  const {record,capture}=await policyCapture("configured",[{price:0}],false,false,{recoverCircuit:true});expect(capture.ranking.candidates[0]!.health).toMatchObject({state:"half-open",probeInFlight:false});expect(capture.routes[0]!.candidates[0]!.health).toMatchObject({state:"half-open",probeInFlight:true});expect(validateShotExecutionCapture(capture,record)).toEqual(capture);
  for(const where of ["ranking","route"] as const)for(const state of ["closed","open"] as const){
    const bad=structuredClone(capture),health={scope:"worker-process" as const,state,probeInFlight:true,samples:3,latencyMs:10,observedAt:bad.ranking.at};
    if(where==="ranking"){bad.ranking.candidates[0]!.health=health;bad.ranking=reseal(bad.ranking);}else bad.routes[0]!.candidates[0]!.health=health;
    expect(()=>validateShotExecutionCapture(reseal(bad),record)).toThrow(/half-open circuit/);
  }
});

test("the admitted ninth anchor fallback retains all nine actual routing attempts without truncation",async()=>{
  const {record,capture,calls}=await policyCapture("configured",Array.from({length:9},()=>({price:0})),false,false,{ninthAnchor:true});
  expect(calls).toEqual([...Array.from({length:8},(_,i)=>"policy-"+i),"anchor-storyboard"]);
  expect(capture.routes).toHaveLength(9);expect(capture.ranking.candidates).toHaveLength(9);expect(capture.observation).toMatchObject({providerIndex:8,fallbackIndex:8});
  expect(validateShotExecutionCapture(capture,record)).toEqual(capture);
  await expect(policyCapture("configured",Array.from({length:9},()=>({price:0})))).rejects.toThrow(/provider plan/);
  await expect(policyCapture("configured",Array.from({length:10},()=>({price:0})),false,false,{ninthAnchor:true})).rejects.toThrow(/provider plan/);
});

test("capture data uses independent bounded portable values and rejects accessors or image paths before hashing",()=>{
  const record=done.output!.shotRenders![0]!,capture=captures[0]!,input={observation:structuredClone(capture.observation),ranking:structuredClone(capture.ranking),routes:structuredClone(capture.routes)},copy=createShotExecutionCapture(record,input);input.ranking.orderedIds.reverse();input.observation.emission.params.shotId="changed";expect(copy).toEqual(capture);
  let reads=0;const hostile=Object.defineProperty({...capture},"ranking",{enumerable:true,get(){reads++;return capture.ranking;}});expect(()=>validateShotExecutionCapture(hostile,record)).toThrow(/accessors/);expect(reads).toBe(0);
  const sparse=structuredClone(capture);delete sparse.ranking.candidates[0];expect(()=>validateShotExecutionCapture(sparse,record)).toThrow(/dense/);
  for(const bad of [Object.assign(structuredClone(capture),{extra:"x".repeat(SHOT_EXECUTION_CAPTURE_LIMITS.bytes+1)}),Object.assign(structuredClone(capture),{extra:Array(SHOT_EXECUTION_CAPTURE_LIMITS.nodes).fill(null)})])expect(()=>validateShotExecutionCapture(bad,record)).toThrow(/capacity/);
  const raw=structuredClone(capture);(raw.observation.emission as unknown as {referenceFrames:unknown}).referenceFrames=[{path:"private/image.png",image:"data:image/png;base64,AA=="}];expect(()=>validateShotExecutionCapture(reseal(raw),record)).toThrow(/emission/);
  for(const bad of [NaN,Infinity,-0]){const invalid=structuredClone(capture);invalid.ranking.budget=bad;expect(()=>validateShotExecutionCapture(invalid,record)).toThrow(/portable/);}
});
