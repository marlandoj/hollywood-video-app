import {expect,test} from "bun:test";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {DurableJobStore,type JobInput} from "../src/index";
import {DeterministicMockProvider} from "../../generator/src/index";
import {RoutedGenerator} from "../../generator/src/router";
import {baseCapability,capability,contentHash} from "../../generator/src/capabilities";
import {readRoutingResults} from "../../benchmarks/src/routing-results";
import {measuredRecord,resultsFile} from "../../benchmarks/test/measured-records";
import {validateProviderPlan} from "../../generator/src/catalog";

function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-route-custody-")||realpathSync(root)!==root)throw new Error("Unsafe route fixture cleanup");rmSync(root,{recursive:true,force:true});}
test("held route journal records an actual fallback past changed unselected identity, but refuses changed selected identity",async()=>{
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-route-custody-"))),first=new DeterministicMockProvider(),second=new DeterministicMockProvider();
  try{
    // Explicit two-entry registry fixture. This checks router→queue custody, not API provider admission.
    const policy={stage:"animatic" as const,strategy:"configured" as const,maxShotUsd:1,requirements:{audio:"any" as const,deterministic:false,nativeResolution:false,allowSynthetic:true,region:"any" as const},pool:[{spec:"first",snapshot:first.capabilities},{spec:"second",snapshot:second.capabilities}]};
    const providerPlan=validateProviderPlan({schema:"hv-provider-plan/1",...policy,revision:contentHash(policy)}),now=Date.now(),input:JobInput={id:"film",projectId:"route-custody",idempotencyKey:"film",stage:"animatic",tier:"free",scriptVersion:1,scriptText:"INT. ROOM - DAY\nA lamp glows.",providerPlan,totalFrames:60,costCapUsd:1,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,rightsAttestedAt:new Date(now).toISOString(),animaticJobId:null,animaticApprovedAt:null};
    const store=DurableJobStore.fromJobs([]);store.enqueue(input);store.claimNext(now,{},{workerId:"router"});let budgetReads=0;
    const generator=new RoutedGenerator({candidates:[{id:"first",adapter:first},{id:"second",adapter:second}],maxAttemptUsd:1,planRevision:providerPlan.revision,
      availableUsd:async()=>{if(++budgetReads===2)Object.assign(first,{model:"changed-after-ranking"});return 1;},onDecision:async decision=>{store.recordRouteDecision(input.id,"router",decision);}});
    const clip=await generator.generate("A lamp glows.",7000,{seed:7000,shotId:"shot-1-1",durationSec:2,widthxheight:"640x360",fps:30,routingRequirements:providerPlan.requirements},join(root,"fallback.mp4"));
    const job=store.get(input.id)!,decision=job.routeDecisions!.at(-1)!;
    expect(clip.provider).toBe(second.name);expect(clip.model).toBe(second.model);expect(decision.selectedId).toBe("second");
    expect(decision.candidates[0]!.eligible).toBe(false);expect(decision.candidates[0]!.reasons).toContain("capability-changed");expect(decision.candidates[0]!.model).toBe("changed-after-ranking");
    const before=contentHash(job),forged=structuredClone(decision);forged.id=crypto.randomUUID();forged.candidates[1]!.model="forged-selected";
    expect(()=>store.recordRouteDecision(input.id,"router",forged)).toThrow(/admitted capability/);expect(contentHash(store.get(input.id))).toBe(before);
    const changed=structuredClone(decision);changed.candidates[0]!.model="rewritten-history";expect(()=>store.recordRouteDecision(input.id,"router",changed)).toThrow(/decision changed/);expect(contentHash(store.get(input.id))).toBe(before);
  }finally{cleanup(root);}
},30000);

test("the held journal records a quality decision only with the scores its admitted plan derives",async()=>{
  const adapter=(name:string)=>{const definition=baseCapability(name,name+"-model","video");definition.output.nativeResolution="requested";const caps=capability(definition);
    return {name,model:caps.model,capabilities:caps,generate:async(_prompt:string,seed:number,_params:unknown,path:string)=>({path,seed,provider:name,model:caps.model,fingerprint:"a".repeat(64),durationSec:2,cost:{provider:name,model:caps.model,prompt_tokens:0,output_frames:60,gpu_seconds:0,total_cost_usd:0}})};};
  const plain=adapter("plain"),measured=adapter("measured"),quality=readRoutingResults({HV_ROUTING_QUALITY_RESULTS_PATH:resultsFile([measuredRecord({spec:"measured",provider:"measured",model:measured.model,capabilityRevision:measured.capabilities.revision},8)]).path});
  const requirements={audio:"any" as const,deterministic:false,nativeResolution:false,allowSynthetic:true,region:"any" as const};
  const journal=(strategy:"quality"|"configured")=>{
    const policy={stage:"final" as const,strategy,maxShotUsd:1,requirements,pool:[{spec:"plain",snapshot:plain.capabilities},{spec:"measured",snapshot:measured.capabilities}],...(strategy==="quality"?{quality}:{})};
    const providerPlan=validateProviderPlan({schema:"hv-provider-plan/1",...policy,revision:contentHash(policy)}),now=Date.now(),input:JobInput={id:"film-"+strategy,projectId:"route-custody",idempotencyKey:"film-"+strategy,stage:"final",tier:"free",scriptVersion:1,scriptText:"INT. ROOM - DAY\nA lamp glows.",providerPlan,totalFrames:60,costCapUsd:1,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,rightsAttestedAt:new Date(now).toISOString(),animaticJobId:null,animaticApprovedAt:null};
    const store=DurableJobStore.fromJobs([]);store.enqueue(input);store.claimNext(now,{},{workerId:"router"});return {store,input,providerPlan};
  };
  const {store,input,providerPlan}=journal("quality");
  await new RoutedGenerator({candidates:[{id:"plain",adapter:plain},{id:"measured",adapter:measured}],strategy:"quality",quality:providerPlan.quality,maxAttemptUsd:1,planRevision:providerPlan.revision,
    onDecision:async decision=>{store.recordRouteDecision(input.id,"router",decision);}}).generate("A lamp glows.",7000,{seed:7000,shotId:"shot-1-1",durationSec:2,widthxheight:"640x360",fps:30,routingRequirements:requirements},"unused");
  const decision=store.get(input.id)!.routeDecisions!.at(-1)!,before=contentHash(store.get(input.id));
  expect(decision.selectedId).toBe("measured");expect(decision.quality!.selectedScore).toBe(1-8/256);expect(decision.quality!.resultsSha256).toBe(quality.resultsSha256);
  expect(decision.quality!.candidates.find(value=>value.id==="plain")).toEqual({id:"plain",score:null,reason:"not measured: the results file has no record for plain"});
  const invented=structuredClone(decision);invented.id=crypto.randomUUID();invented.quality!.candidates.find(value=>value.id==="plain")!.score=.5;
  const digest=structuredClone(decision);digest.id=crypto.randomUUID();digest.quality!.resultsSha256="f".repeat(64);
  const missing=structuredClone(decision);missing.id=crypto.randomUUID();delete missing.quality;
  for(const forged of [invented,digest,missing])expect(()=>store.recordRouteDecision(input.id,"router",forged)).toThrow(/admitted quality scores/);
  expect(contentHash(store.get(input.id))).toBe(before);
  const other=journal("configured"),stray=structuredClone(decision);stray.id=crypto.randomUUID();stray.strategy="configured";stray.planRevision=other.providerPlan.revision;
  expect(()=>other.store.recordRouteDecision(other.input.id,"router",stray)).toThrow(/admitted quality scores/);
},30000);
