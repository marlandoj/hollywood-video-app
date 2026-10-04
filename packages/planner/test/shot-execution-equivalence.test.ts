import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {baseCapability,capability,contentHash,type RoutingStrategy} from "../../generator/src/capabilities";
import {createProviderPlan,instantiateProviderPlan} from "../../generator/src/catalog";
import {RichAnimaticProvider} from "../../generator/src/animatic";
import {DeterministicMockImageProvider} from "../../generator/src/image";
import {DeterministicMockProvider,type GenParams,type ProviderAdapter} from "../../generator/src/index";
import {ProviderHealth,RoutedGenerator,type RouteDecision} from "../../generator/src/router";
import type {RoutingQuality} from "../../generator/src/quality-routing";
import {routingQualityFrom} from "../../benchmarks/src/routing-results";
import {measuredRecord} from "../../benchmarks/test/measured-records";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {parseFountain} from "../../parser/src/index";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {compileRetainedShotReuse,type RetainedShotReuse} from "../src/retained-shot-reuse";
import {renderInputHash,renderRecord,renderShots} from "../src/shot-reuse";
import {editFactsRevision} from "../src/edit-sources";
import {directionEntry,directionSnapshot} from "../src/direction";
import type {ReferenceAsset} from "../src/references";
import {compileShotRenderRecipe,resolveShotRenderAttempt,type ShotRenderRecipe,type ShotDispatchParams} from "../src/shot-render-recipe";
import {createShotExecutionWitness,validateShotExecutionWitness,reviewShotExecutionEquivalence,validateShotExecutionEquivalence,verifyShotExecutionEquivalenceMedia,SHOT_EXECUTION_EQUIVALENCE_LIMITS,type ShotExecutionEmission,type ShotExecutionWitness,type ShotExecutionTarget} from "../src/shot-execution-equivalence";

const scratch=mkdtempSync(join(tmpdir(),"hv-execution-equivalence-")),projectId="execution-equivalence",at=Date.now(),script="INT. FIRST - DAY\nA lamp glows.\n\nINT. SECOND - NIGHT\nA door opens.";
let retained:RetainedShotReuse,witness:ShotExecutionWitness,target:ShotExecutionTarget,recipe:ShotRenderRecipe,readRoot:string;
const calls:{shotId:string;emission:ShotExecutionEmission}[]=[];
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};
const sha=(value:Uint8Array)=>createHash("sha256").update(value).digest("hex");
const stream=(bytes:Uint8Array)=>new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}});
function frameDigest(path:string):string{const run=Bun.spawnSync(["ffmpeg","-v","error","-i",path,"-map","0:v:0","-f","framemd5","-"],{stdout:"pipe",stderr:"pipe"});if(run.exitCode)throw new Error(run.stderr.toString());return run.stdout.toString();}
/** Independent test observation at the actual provider invocation. */
function capture(prompt:string,seed:number,params:GenParams):ShotExecutionEmission {
  const {signal:_signal,beforeAttempt:_before,onAttemptCost:_cost,afterAttempt:_after,onProviderRequest:_request,referenceFrames,frameAnchors,...scalars}=params;
  const identity=(image:string)=>{const bytes=Buffer.from(image.split(",")[1]!,"base64");return {sha256:sha(bytes),bytes:bytes.length};};
  return {prompt,seed,params:Object.fromEntries(Object.entries(scalars).filter(([,value])=>value!==undefined)) as ShotDispatchParams,undefinedKeys:Object.keys(params).filter(key=>!["signal","beforeAttempt","onAttemptCost","afterAttempt","onProviderRequest"].includes(key)&&params[key as keyof GenParams]===undefined).sort(),referenceFrames:referenceFrames?.map(identity)??null,frameAnchors:frameAnchors?{mode:frameAnchors.mode,frames:frameAnchors.frames.map(frame=>({at:frame.at,...identity(frame.image)}))}:null};
}
/** Synthetic standalone-witness fixtures model historical absence of private captures.
 * Substituted policy metadata must never inherit the actual worker's capture custody. */
function historicalWitnessOnly(job:Job):void {delete job.executionCheckpoints;delete job.output!.shotExecutions;}
/** Synthetic receipt metadata around actual RoutedGenerator dispatch. These policy fixtures
 * never assert that their retained media was generated under the substituted policy. */
async function policyFixture(strategy:RoutingStrategy,entries:{price:number;mode?:"native"|"storyboard"}[],anchors=false,changeHealth=false,qualityOf?:(pool:{spec:string;snapshot:ReturnType<typeof capability>}[])=>RoutingQuality) {
  const source=structuredClone(retained.binding.source),job=source.job,time=Date.parse(job.startedAt!)+1;
  historicalWitnessOnly(job);
  job.stage="final";const base=renderShots(job,Date.parse(job.startedAt!))[1]!,poster=retained.record.files.poster!,image=readFileSync(resolve(readRoot,poster.path));
  const asset:ReferenceAsset={schema:"hv-reference/1",id:"dce4b051-9e2a-4026-aa03-9c0621f866e8",projectId,sha256:sha(image),originalSha256:sha(image),bytes:image.length,width:640,height:360,contentType:"image/png",createdAt:job.startedAt!,attestedAt:job.startedAt!};
  if(anchors)job.direction=directionSnapshot(projectId,1,[directionEntry(base,{frameAnchors:{frames:[{at:0,asset}],fallback:"storyboard"}})],time);
  const pool=entries.map((entry,index)=>{const name="policy-"+index,definition=baseCapability(name,name+"-model","video");definition.output.nativeResolution="requested";
    definition.price={...definition.price,unit:entry.price?"request":"free",usd:entry.price};if(entry.mode){definition.frameControls={first:true,last:true,intermediate:true};definition.frameControlMode=entry.mode;}return {spec:name,snapshot:capability(definition)};});
  const quality=qualityOf?.(pool),data={stage:"final" as const,strategy,maxShotUsd:5,requirements:job.providerPlan!.requirements,pool,...(quality?{quality}:{})};job.providerPlan={...data,schema:"hv-provider-plan/1",revision:contentHash(data)};
  const shot=renderShots(job,Date.parse(job.startedAt!))[1]!,recipe=compileShotRenderRecipe({projectId,stage:"final",shot,sceneHeading:"INT. SECOND - NIGHT",outputSize:"640x360",providerPlan:job.providerPlan,richAnimaticProviders:pool.map(()=>false)}),attempt=resolveShotRenderAttempt(recipe,0),decisions:RouteDecision[]=[],health=new ProviderHealth(()=>time);
  if(strategy==="latency")for(const [i,entry]of pool.entries())for(let n=0;n<3;n++)health.record(entry.snapshot.revision,true,10+i*90);
  let emission:ShotExecutionEmission|undefined,refreshes=0;
  const candidates=pool.map(entry=>({id:entry.spec,adapter:{name:entry.snapshot.adapter,model:entry.snapshot.model,capabilities:entry.snapshot,generate:async(prompt,seed,params,path)=>{
    emission=capture(prompt,seed,params);return {...retained.record.clip,path,seed,provider:entry.snapshot.adapter,model:entry.snapshot.model,cost:{provider:entry.snapshot.adapter,model:entry.snapshot.model,prompt_tokens:0,output_frames:60,gpu_seconds:0,total_cost_usd:0}};
  }}} satisfies {id:string;adapter:ProviderAdapter}));
  const router=new RoutedGenerator({candidates,strategy,...(quality?{quality}:{}),maxAttemptUsd:5,planRevision:job.providerPlan.revision,now:()=>time,health,onDecision:async decision=>{decisions.push(decision);},availableUsd:async()=>{
    if(++refreshes===2&&changeHealth)health.record(pool[0]!.snapshot.revision,true,10000);return 5;
  }}),result=await router.generate(attempt.prompt,attempt.seed,{...attempt.params,referenceFrames:undefined,frameAnchors:recipe.anchors?{mode:recipe.anchors.mode,frames:[{at:0,image:"data:image/png;base64,"+image.toString("base64") }]}:undefined},"unused-policy-output");
  job.routeDecisions=decisions;
  const {path:_path,cost:_cost,...clip}=result,shots=renderShots(job,Date.parse(job.startedAt!));
  job.output!.shotRenders=job.output!.shotRenders!.map((record,index)=>{const {schema:_schema,revision:_revision,...data}=record;return renderRecord({...data,inputHash:renderInputHash(job,shots[index]!),...(index===1?{clip}:{})});});
  source.facts.revision=editFactsRevision(job,source.facts.frames,source.facts.width,source.facts.height,source.facts.captions);
  const saved=compileRetainedShotReuse(job.output!.shotRenders[1]!,bindOriginalEditSource(reseal(source))),providerIndex=pool.findIndex(entry=>entry.spec===decisions.at(-1)!.selectedId),observation={recipe,attempt:0,providerIndex,fallbackIndex:0,emission:emission!};
  const target:ShotExecutionTarget={inputRevision:contentHash({policy:strategy,shot}),recipe,attempt:0,providerIndex,fallbackIndex:0};
  return {retained:saved,observation,target};
}
beforeAll(async()=>{
  const prior={pool:process.env.HV_ANIMATIC_PROVIDER_POOL,narration:process.env.HV_NARRATION,captions:process.env.HV_ANIMATIC_CAPTIONS};
  process.env.HV_ANIMATIC_PROVIDER_POOL='["legacy-mock","mock"]';process.env.HV_NARRATION="0";process.env.HV_ANIMATIC_CAPTIONS="0";
  const render=RichAnimaticProvider.prototype.generate,primary=spyOn(DeterministicMockProvider.prototype,"generate").mockRejectedValue(new Error("Controlled first-provider outage")),successful=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(async function(this:RichAnimaticProvider,prompt,seed,params,path){calls.push({shotId:params.shotId!,emission:capture(prompt,seed,params)});const clip=await render.call(this,prompt,seed,params,path);return {...clip,fingerprint:(params.shotId==="shot-1-1"?"0":"f").repeat(64)};});
  try{
    const providerPlan=createProviderPlan("animatic",5),runtime=instantiateProviderPlan(providerPlan),store=new DurableJobStore(join(scratch,"jobs.json")),job:JobInput={id:"original-worker",projectId,idempotencyKey:"original-worker",tier:"free",stage:"animatic",scriptVersion:1,scriptText:script,providerPlan,totalFrames:120,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,costCapUsd:5,rightsAttestedAt:new Date(at).toISOString(),animaticJobId:null,animaticApprovedAt:null};
    store.enqueue(job);readRoot=join(scratch,"media");const done=await processNextJob(store,readRoot,{ledger:new CostLedger(join(scratch,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(scratch,"reviews.json"))});
    if(done?.status!=="done")throw new Error("Worker fixture failed: "+done?.failureReason);
    const source=await inspectEditSource(done,"Actual worker original",readRoot,async()=>{}),record=done.output!.shotRenders![1]!,shot=renderShots(done,Date.parse(done.startedAt!))[1]!;
    retained=compileRetainedShotReuse(record,bindOriginalEditSource(source));recipe=compileShotRenderRecipe({projectId,stage:"animatic",shot,sceneHeading:parseFountain(script).scenes[shot.sceneIndex]!.heading,outputSize:"640x360",providerPlan,richAnimaticProviders:runtime.map(value=>value.adapter instanceof RichAnimaticProvider)});
    const observed=calls.slice().reverse().find(value=>value.shotId===record.shotId)!;
    witness=createShotExecutionWitness(retained,{recipe,attempt:2,providerIndex:1,fallbackIndex:record.clip.routing!.decisionIds.length-1,emission:observed.emission});
    target={inputRevision:contentHash({schema:"private-current-input/2",shot:{...shot,sceneIndex:0}}),recipe,attempt:2,providerIndex:1,fallbackIndex:witness.observation.fallbackIndex};
  }finally{primary.mockRestore();successful.mockRestore();for(const [key,value]of [["HV_ANIMATIC_PROVIDER_POOL",prior.pool],["HV_NARRATION",prior.narration],["HV_ANIMATIC_CAPTIONS",prior.captions]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}}
},60000);
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));

test("actual worker fallback and repair evidence bind exact emission without claiming historical witness custody",()=>{
  expect(calls.map(value=>[value.shotId,value.emission.seed])).toEqual([["shot-1-1",7000],["shot-2-1",7001],["shot-2-1",17001],["shot-2-1",27001]]);
  expect(witness.source.recordRevision).toBe(retained.record.revision);expect(witness.observation.attempt).toBe(2);expect(witness.observation.providerIndex).toBe(1);expect(witness.observation.emission.params.seed).toBe(7001);expect(witness.observation.emission.seed).toBe(27001);
  expect(witness.routes.at(-1)!.selectedId).toBe("mock");expect(witness.renderRoute.selectedCapability.adapter).toBe("rich-animatic");expect(witness.observation.emission.undefinedKeys).toContain("referenceFrames");
  expect(witness.witnessCustody).toBe("unverified");expect(witness.currentAuthority).toBe(false);expect(validateShotExecutionWitness(retained,JSON.parse(JSON.stringify(witness)))).toEqual(witness);
  const review=reviewShotExecutionEquivalence(retained,witness,target);expect(review.status).toBe("consistent");expect(review.target.inputRevision).not.toBe(retained.record.inputHash);expect(review.mediaVerified).toBe(false);expect(review.retained.record).toEqual(retained.record);expect(validateShotExecutionEquivalence(review)).toEqual(review);
  const job=retained.binding.source.job,record=job.output!.shotRenders![0]!,first=compileRetainedShotReuse(record,retained.binding),shot=renderShots(job,Date.parse(job.startedAt!))[0]!,firstRecipe=compileShotRenderRecipe({projectId,stage:"animatic",shot,sceneHeading:"INT. FIRST - DAY",outputSize:"640x360",providerPlan:job.providerPlan!,richAnimaticProviders:[false,true]}),fallback=createShotExecutionWitness(first,{recipe:firstRecipe,attempt:0,providerIndex:1,fallbackIndex:1,emission:calls[0]!.emission});
  expect(fallback.routes.map(route=>route.selectedId)).toEqual(["legacy-mock","mock"]);expect(fallback.observation.fallbackIndex).toBe(1);expect(fallback.renderRoute.decisionIds).toEqual(record.clip.routing!.decisionIds);
});

test("moved current input reproduces original decoded media at its actual successful repair seed",async()=>{
  const original=renderShots(retained.binding.source.job,Date.parse(retained.binding.source.job.startedAt!))[1]!,moved={...original,sceneIndex:0},current=compileShotRenderRecipe({projectId,stage:"animatic",shot:moved,sceneHeading:"INT. SECOND - NIGHT",outputSize:"640x360",providerPlan:retained.binding.source.job.providerPlan!,richAnimaticProviders:[false,true]});
  expect(current).toEqual(recipe);const dispatch=resolveShotRenderAttempt(current,2),rendered=await new RichAnimaticProvider(new DeterministicMockImageProvider(),{narration:false,captions:false}).generate(dispatch.prompt,dispatch.seed,dispatch.params,join(scratch,"independent-current.mp4"));
  expect(frameDigest(rendered.path)).toBe(frameDigest(resolve(readRoot,retained.record.files.video.path)));expect(sha(readFileSync(rendered.posterPath!))).toBe(retained.record.files.poster!.sha256);
  const review=reviewShotExecutionEquivalence(retained,witness,{...target,recipe:current}),verification=await verifyShotExecutionEquivalenceMedia(review,file=>Bun.file(resolve(readRoot,file.path)).stream());
  expect(verification.files.map(value=>value.role)).toEqual(Object.keys(retained.record.files));expect(verification.bytes).toBe(Object.values(retained.record.files).reduce((sum,file)=>sum+file.bytes,0));expect(verification.currentAuthority).toBe(false);expect(verification.witnessCustody).toBe("unverified");
},10000);

test("missing witness remains unavailable and cannot turn recipe equality into verified reusable media",async()=>{
  const review=reviewShotExecutionEquivalence(retained,null,target);expect(review.status).toBe("unavailable");expect(review.differences[0]).toContain("no separately retained");let reads=0;
  await expect(verifyShotExecutionEquivalenceMedia(review,()=>{reads++;return stream(new Uint8Array());})).rejects.toThrow(/complete execution/);expect(reads).toBe(0);
});

test("provider-visible identity, requested seed, dialogue, scalar keys, routing order and pinned runtime forbid equality",()=>{
  const original=renderShots(retained.binding.source.job,Date.parse(retained.binding.source.job.startedAt!))[1]!;
  const changed=[{...original,id:"different-label"},{...original,seed:9000},{...original,prompt:original.prompt+" Soft light."},{...original,dialogue:[{character:"ALICE",lines:["Again."]}]},{...original,durationSec:3}];
  for(const shot of changed){const recipe=compileShotRenderRecipe({projectId,stage:"animatic",shot,sceneHeading:"INT. SECOND - NIGHT",outputSize:"640x360",providerPlan:retained.binding.source.job.providerPlan!,richAnimaticProviders:[false,true]});expect(reviewShotExecutionEquivalence(retained,witness,{...target,recipe}).status).toBe("different");}
  const plan=retained.binding.source.job.providerPlan!,{schema:_schema,revision:_revision,...policy}=plan,changedPolicy={...policy,pool:[...plan.pool].reverse()},reversed={schema:plan.schema,...changedPolicy,revision:contentHash(changedPolicy)},reordered=compileShotRenderRecipe({projectId,stage:"animatic",shot:original,sceneHeading:"INT. SECOND - NIGHT",outputSize:"640x360",providerPlan:reversed,richAnimaticProviders:[true,false]});
  expect(reviewShotExecutionEquivalence(retained,witness,{...target,recipe:reordered}).status).toBe("different");
  for(const change of [{attempt:0},{providerIndex:0},{fallbackIndex:target.fallbackIndex===0?1:0}])expect(reviewShotExecutionEquivalence(retained,witness,{...target,...change}).status).toBe("different");
  const noKey=structuredClone(witness);noKey.observation.emission.undefinedKeys=noKey.observation.emission.undefinedKeys.filter(key=>key!=="performances");expect(()=>validateShotExecutionWitness(retained,reseal(noKey))).toThrow(/Observed dispatch/);
});

test("witness tampering cannot substitute actual provider, routes, original record or historical input",()=>{
  const mutations=[(w:ShotExecutionWitness)=>{w.source.inputHash="a".repeat(64);},(w:ShotExecutionWitness)=>{w.source.recordRevision="b".repeat(64);},(w:ShotExecutionWitness)=>{w.observation.emission.seed++;},(w:ShotExecutionWitness)=>{w.observation.providerIndex=0;},(w:ShotExecutionWitness)=>{w.routes.at(-1)!.selectedId="legacy-mock";},(w:ShotExecutionWitness)=>{w.renderRoute.selectedCapability.model="forged";}];
  for(const mutate of mutations){const changed=structuredClone(witness);mutate(changed);expect(()=>validateShotExecutionWitness(retained,reseal(changed))).toThrow();}
  const unknown=structuredClone(witness);Object.assign(unknown,{workerAuthenticated:true});expect(()=>validateShotExecutionWitness(retained,reseal(unknown))).toThrow();
  const changed=structuredClone(retained);changed.record.clip.seed++;expect(()=>validateShotExecutionWitness(changed,witness)).toThrow();
});

test("resealing real worker route history cannot reverse the admitted configured candidate order",()=>{
  const source=structuredClone(retained.binding.source),wanted=new Set(retained.record.clip.routing!.decisionIds);
  expect(source.job.providerPlan!.strategy).toBe("configured");expect(source.job.providerPlan!.pool.map(entry=>entry.spec)).toEqual(["legacy-mock","mock"]);
  for(const decision of source.job.routeDecisions!)if(wanted.has(decision.id))decision.candidates.reverse();
  // Current captured sources now reject this at the earlier retained-source boundary.
  expect(()=>bindOriginalEditSource(reseal(source))).toThrow(/durable worker journal/);
  // Preserve the standalone policy regression for sources predating private captures.
  historicalWitnessOnly(source.job);
  source.facts.revision=editFactsRevision(source.job,source.facts.frames,source.facts.width,source.facts.height,source.facts.captions);
  const changed=compileRetainedShotReuse(retained.record,bindOriginalEditSource(reseal(source)));
  expect(changed.binding.source.job.executionCheckpoints).toBeUndefined();expect(changed.binding.source.job.output!.shotExecutions).toBeUndefined();
  expect(changed.binding.source.job.routeDecisions!.filter(decision=>wanted.has(decision.id))[0]!.candidates.map(candidate=>candidate.id)).toEqual(["mock","legacy-mock"]);
  expect(()=>createShotExecutionWitness(changed,witness.observation)).toThrow(/admitted routing policy/);
});

test("actual router cost rank and native anchor priority remain exact including admitted-order ties",async()=>{
  for(const value of [
    {strategy:"cost" as const,entries:[{price:3},{price:1},{price:1}],anchors:false,order:["policy-1","policy-2","policy-0"]},
    {strategy:"configured" as const,entries:[{price:0,mode:"storyboard" as const},{price:3,mode:"native" as const},{price:1,mode:"native" as const}],anchors:true,order:["policy-1","policy-2","policy-0"]},
    {strategy:"cost" as const,entries:[{price:0,mode:"storyboard" as const},{price:3,mode:"native" as const},{price:1,mode:"native" as const}],anchors:true,order:["policy-2","policy-1","policy-0"]}
  ]){
    const fixture=await policyFixture(value.strategy,value.entries,value.anchors),observed=createShotExecutionWitness(fixture.retained,fixture.observation);
    expect(observed.routes[0]!.candidates.map(candidate=>candidate.id)).toEqual(value.order);expect(reviewShotExecutionEquivalence(fixture.retained,observed,fixture.target).status).toBe("consistent");
    const source=structuredClone(fixture.retained.binding.source);source.job.routeDecisions![0]!.candidates.reverse();
    const reversed=compileRetainedShotReuse(fixture.retained.record,bindOriginalEditSource(reseal(source)));
    expect(()=>createShotExecutionWitness(reversed,fixture.observation)).toThrow(/admitted routing policy/);
  }
});

test("a quality rank is fully determined by the plan's pinned scores, so reuse can prove it",async()=>{
  const measured=(pool:{spec:string;snapshot:ReturnType<typeof capability>}[])=>routingQualityFrom(Buffer.from(JSON.stringify([2,1].map((index,rank)=>measuredRecord({spec:pool[index]!.spec,provider:pool[index]!.snapshot.adapter,model:pool[index]!.snapshot.model,capabilityRevision:pool[index]!.snapshot.revision},rank?64:8)))));
  const fixture=await policyFixture("quality",[{price:0},{price:0},{price:0}],false,false,measured),observed=createShotExecutionWitness(fixture.retained,fixture.observation);
  expect(observed.routes[0]!.candidates.map(candidate=>candidate.id)).toEqual(["policy-2","policy-1","policy-0"]);expect(observed.routes[0]!.quality!.selectedScore).toBe(1-8/256);
  expect(reviewShotExecutionEquivalence(fixture.retained,observed,fixture.target).status).toBe("consistent");
  const reversed=structuredClone(fixture.retained.binding.source);reversed.job.routeDecisions![0]!.candidates.reverse();
  expect(()=>createShotExecutionWitness(compileRetainedShotReuse(fixture.retained.record,bindOriginalEditSource(reseal(reversed))),fixture.observation)).toThrow(/admitted routing policy/);
  const invented=structuredClone(fixture.retained.binding.source);invented.job.routeDecisions![0]!.quality!.candidates[2]!.score=.5;
  expect(()=>createShotExecutionWitness(compileRetainedShotReuse(fixture.retained.record,bindOriginalEditSource(reseal(invented))),fixture.observation)).toThrow(/quality scores/);
});

test("latency health can change before the first decision, so unavailable initial observations never prove reuse",async()=>{
  const fixture=await policyFixture("latency",[{price:0},{price:0}],false,true),observed=createShotExecutionWitness(fixture.retained,fixture.observation),candidates=observed.routes[0]!.candidates;
  expect(candidates.map(candidate=>candidate.id)).toEqual(["policy-0","policy-1"]);expect(candidates[0]!.health.latencyMs!).toBeGreaterThan(candidates[1]!.health.latencyMs!);
  const review=reviewShotExecutionEquivalence(fixture.retained,observed,fixture.target);expect(review.status).toBe("unavailable");expect(review.differences[0]).toContain("initial worker health");expect(validateShotExecutionEquivalence(review)).toEqual(review);
  let reads=0;await expect(verifyShotExecutionEquivalenceMedia(review,()=>{reads++;return stream(new Uint8Array());})).rejects.toThrow(/complete execution/);expect(reads).toBe(0);
  const source=structuredClone(fixture.retained.binding.source);source.job.routeDecisions![0]!.candidates.reverse();
  const reversed=compileRetainedShotReuse(fixture.retained.record,bindOriginalEditSource(reseal(source))),alternate=createShotExecutionWitness(reversed,fixture.observation);
  expect(reviewShotExecutionEquivalence(reversed,alternate,fixture.target).status).toBe("unavailable");
  // One candidate per native-priority group has no unresolved latency comparison.
  for(const entries of [[{price:0}],[{price:0,mode:"storyboard" as const},{price:1,mode:"native" as const}]]){
    const singleton=await policyFixture("latency",entries,entries.length>1),proof=createShotExecutionWitness(singleton.retained,singleton.observation);expect(reviewShotExecutionEquivalence(singleton.retained,proof,singleton.target).status).toBe("consistent");
    if(entries.length>1){const bad=structuredClone(singleton.retained.binding.source);bad.job.routeDecisions![0]!.candidates.reverse();expect(()=>createShotExecutionWitness(compileRetainedShotReuse(singleton.retained.record,bindOriginalEditSource(reseal(bad))),singleton.observation)).toThrow(/admitted routing policy/);}
  }
});

test("portable metadata rejects accessors, sparse values and excessive input before reads or hashing",()=>{
  let calls=0;const hostile=Object.defineProperty({...witness},"observation",{enumerable:true,get(){calls++;return witness.observation;}});expect(()=>validateShotExecutionWitness(retained,hostile)).toThrow(/accessors/);expect(calls).toBe(0);
  const sparse=structuredClone(witness);delete sparse.observation.emission.undefinedKeys[0];expect(()=>validateShotExecutionWitness(retained,sparse)).toThrow(/dense/);
  expect(()=>reviewShotExecutionEquivalence(retained,witness,{...target,attempt:NaN})).toThrow(/portable/);expect(()=>reviewShotExecutionEquivalence(retained,witness,{...target,inputRevision:"unknown"})).toThrow(/input revisions/);
  expect(()=>reviewShotExecutionEquivalence(retained,witness,{...target,recipe:{...recipe,projectId:"another"}})).toThrow();
  const excessive={...witness,extra:Array(SHOT_EXECUTION_EQUIVALENCE_LIMITS.nodes).fill(null)};expect(()=>validateShotExecutionWitness(retained,excessive)).toThrow(/metadata capacity/);
});

test("media verification rejects corruption, overflow, truncation and cancellation without accepting partial inventory",async()=>{
  const review=reviewShotExecutionEquivalence(retained,witness,target),fingerprint=contentHash(review),file=retained.record.files.video,original=readFileSync(resolve(readRoot,file.path));
  for(const bytes of [Buffer.from(original).fill(0,0,1),original.subarray(0,-1),Buffer.concat([original,Buffer.from([0])])])await expect(verifyShotExecutionEquivalenceMedia(review,()=>stream(bytes))).rejects.toThrow(/checksum|exceeds/);
  const abort=new AbortController();abort.abort(new Error("Current permission withdrawn"));let reads=0;await expect(verifyShotExecutionEquivalenceMedia(review,()=>{reads++;return stream(original);},abort.signal)).rejects.toThrow(/withdrawn/);expect(reads).toBe(0);
  const during=new AbortController();let canceled=false;
  const running=verifyShotExecutionEquivalenceMedia(review,()=>new ReadableStream<Uint8Array>({pull(){during.abort(new Error("Carrier withdrawn during read"));},cancel(){canceled=true;}}),during.signal);
  await expect(running).rejects.toThrow(/Carrier withdrawn/);expect(canceled).toBe(true);expect(contentHash(review)).toBe(fingerprint);
});
