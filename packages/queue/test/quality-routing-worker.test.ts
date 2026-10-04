import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {configuredPool,createProviderPlan} from "../../generator/src/catalog";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {DurableJobStore,type JobInput} from "../src/index";
import {processNextJob} from "../src/worker";
import {measuredRecord,resultsFile} from "../../benchmarks/test/measured-records";

const scratch=mkdtempSync(join(tmpdir(),"hv-quality-worker-"));
afterAll(()=>rmSync(scratch,{recursive:true,force:true}));

/** HV-019-14: `HV_ROUTING_STRATEGY=quality` is selectable end to end, the same way the other strategies are. */
test("a quality job runs through admission, the worker, the journal and execution capture, and never scores a stand-in",async()=>{
  const keys=["HV_ANIMATIC_PROVIDER_POOL","HV_NARRATION","HV_ANIMATIC_CAPTIONS"] as const,prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{HV_ANIMATIC_PROVIDER_POOL:'["legacy-mock","mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"});
  try{
    // Records claiming scores for the two local adapters, at their exact revisions. Both adapters are synthetic,
    // so neither score may rank them: the order stays configured and each decision says why.
    const pool=configuredPool("animatic"),file=resultsFile(pool.map((entry,index)=>measuredRecord({spec:entry.spec,provider:entry.snapshot.adapter,model:entry.snapshot.model,capabilityRevision:entry.snapshot.revision},index?8:64)));
    const providerPlan=createProviderPlan("animatic",5,undefined,{...process.env,HV_ROUTING_STRATEGY:"quality",HV_ROUTING_QUALITY_RESULTS_PATH:file.path});
    expect(providerPlan.quality).toMatchObject({resultsSha256:file.sha256,fallback:null});
    const store=new DurableJobStore(join(scratch,"jobs.json")),at=Date.now(),job:JobInput={id:"quality-film",projectId:"quality-routing",idempotencyKey:"quality-film",tier:"free",stage:"animatic",scriptVersion:1,
      scriptText:"INT. FIRST - DAY\nA lamp glows.\n\nINT. SECOND - NIGHT\nA door opens.",providerPlan,totalFrames:120,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,costCapUsd:5,
      rightsAttestedAt:new Date(at).toISOString(),animaticJobId:null,animaticApprovedAt:null};
    store.enqueue(job);
    const done=await processNextJob(store,join(scratch,"media"),{ledger:new CostLedger(join(scratch,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(scratch,"reviews.json"))});
    expect(done?.status).toBe("done");
    const decisions=done!.routeDecisions!;
    expect(decisions.length).toBeGreaterThan(0);
    for(const decision of decisions){
      expect(decision.strategy).toBe("quality");
      expect(decision.candidates.map(candidate=>candidate.id)).toEqual(["legacy-mock","mock"]);
      expect(decision.quality).toMatchObject({resultsSha256:file.sha256,fallback:null,selectedScore:null});
      for(const candidate of decision.quality!.candidates)expect(candidate).toMatchObject({score:null,reason:"not measured: a synthetic stand-in's picture is not routing evidence"});
    }
    // The worker sealed an execution capture per shot, which re-derives this order from the plan.
    expect(done!.output!.shotExecutions!.filter(row=>row.capture!==null).length).toBe(done!.output!.shotRenders!.length);
  }finally{for(const key of keys){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}}
},60000);
