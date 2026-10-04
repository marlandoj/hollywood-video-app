import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {HERO_ENGINES,HERO_LIMITS,assertHeroSourceProbe,assertHeroStageProbe,heroChainPlan,heroChainRequests,heroJobPlan,heroShotBinding,heroStagePlan,
  heroUpscaleSize,validateHeroJob,validateHeroJobPlan,heroTotalFrames,type HeroProbe,type HeroStageEngine,type HeroStageRequest} from "../src/hero-chain";
import {validateDeliveryJob} from "../src/delivery-jobs";

/**
 * HV-019-15: the hero chain's plan -- the stage interface a paid stage must declare itself through,
 * and the limits a chain runs inside -- without rendering anything.
 */
const projectId=crypto.randomUUID(),filmId=crypto.randomUUID();
const binding=(durationSec=5)=>heroShotBinding({storage:"local",source:{projectId,jobId:filmId,stage:"final",outputRevision:"a".repeat(64),shotId:"shot-1-1"},
  shot:{renderRevision:"b".repeat(64),inputHash:"c".repeat(64),provider:"mock",model:"mock-deterministic-v1",durationSec,
    video:{path:projectId+"/"+filmId+"/clips/shot-1-1.mp4",sha256:"d".repeat(64),bytes:1024}}});
const probe=(value:Partial<HeroProbe>={}):HeroProbe=>({width:1280,height:720,fps:"30/1",frames:150,durationSec:5,codec:"h264",pixFmt:"yuv420p",...value});
/** A fake vendor upscaler: the shape a later paid stage takes. Nothing here can dispatch it. */
const PAID:Record<string,HeroStageEngine>={...HERO_ENGINES,"acme-upscaler":{id:"acme-upscaler",stage:"upscale",provider:"acme",paid:true,description:"A test-only paid upscaler"}};
const paidUpscale=(declared?:HeroStageRequest["declared"]):HeroStageRequest=>({stage:"upscale",engine:"acme-upscaler",params:{height:2160},...(declared?{declared}:{})});

test("a paid stage that does not declare its provider and spend is refused, and a declared one is still never admitted at zero cost",()=>{
  // Undeclared: refused by the stage interface, by name.
  expect(()=>heroStagePlan(paidUpscale(),3,PAID)).toThrow("A paid stage must declare its provider and its spend before it is planned");
  const local=heroChainRequests();
  expect(()=>heroChainPlan([local[0]!,local[1]!,paidUpscale()],PAID)).toThrow("must declare its provider and its spend");
  // Declared wrongly: another provider, no spend, or past the single-evaluation gate.
  expect(()=>heroStagePlan(paidUpscale({provider:"other",spendUsd:1}),3,PAID)).toThrow("this stage declares other");
  expect(()=>heroStagePlan(paidUpscale({provider:"acme",spendUsd:0}),3,PAID)).toThrow("above zero");
  expect(()=>heroStagePlan(paidUpscale({provider:"acme",spendUsd:51}),3,PAID)).toThrow("at most $50");
  // A local stage declares nothing.
  expect(()=>heroStagePlan({...local[0]!,declared:{provider:"local",spendUsd:0}},1,PAID)).toThrow("declares no provider or spend");
  // Declared: planned, and the chain carries the provider and the spend into its record.
  const chain=heroChainPlan([local[0]!,local[1]!,paidUpscale({provider:"acme",spendUsd:0.42})],PAID);
  expect(chain.stages[2]).toEqual({index:3,stage:"upscale",engine:"acme-upscaler",provider:"acme",paid:true,spendUsd:0.42,params:{height:2160}});
  expect(chain.spendUsd).toBe(0.42);
  // But a hero render is a deliverable, and a deliverable is admitted only at zero cost.
  expect(()=>heroJobPlan(binding(),[local[0]!,local[1]!,paidUpscale({provider:"acme",spendUsd:0.42})],PAID)).toThrow("admitted only at zero cost");
  // The shipped engines are all local and free, and an engine this build does not know is refused.
  expect(Object.values(HERO_ENGINES).map(engine=>[engine.provider,engine.paid])).toEqual([["local",false],["local",false],["local",false]]);
  expect(()=>heroChainPlan([local[0]!,local[1]!,paidUpscale({provider:"acme",spendUsd:0.42})])).toThrow("no hero engine called acme-upscaler");
  // A stored plan whose stage was edited to claim spend is refused on re-derivation.
  const plan=heroJobPlan(binding(),local);
  const edited=structuredClone(plan);edited.chain.stages[2]!.spendUsd=0.42;const {revision:_r,...data}=edited.chain;edited.chain.revision=contentHash(data);
  expect(()=>validateHeroJobPlan(edited)).toThrow();
});

test("the chain runs denoise, then frame rate, then upscale, once each, with only the choices it offers",()=>{
  const [denoise,rate,upscale]=heroChainRequests();
  expect([denoise,rate,upscale].map(request=>request!.params)).toEqual([{strength:"medium"},{fps:60},{height:2160}]);
  expect(()=>heroChainPlan([rate!,denoise!,upscale!])).toThrow("in that order");
  expect(()=>heroChainPlan([denoise!,rate!])).toThrow("each once");
  expect(()=>heroChainRequests({denoise:"heavy"})).not.toThrow();
  expect(()=>heroChainPlan(heroChainRequests({denoise:"heavy"}))).toThrow("Choose a denoise strength");
  expect(()=>heroChainPlan(heroChainRequests({fps:120}))).toThrow("24, 25, 30, 48, 50, 60 fps");
  expect(()=>heroChainPlan(heroChainRequests({height:4320}))).toThrow("720, 1080, 1440, 2160 lines");
  expect(()=>heroChainPlan([{...denoise!,engine:"ffmpeg-lanczos"},rate!,upscale!])).toThrow("runs the upscale stage, not denoise");
  expect(()=>heroChainRequests({denoise:"medium",scale:4} as never)).toThrow("Use only supported");
});

test("limits: the shot, the frame size, the rate and the duration a chain may take and make",()=>{
  // The shot's duration, from its render record, is refused at planning.
  expect(()=>binding(HERO_LIMITS.source.maxDurationSec+1)).toThrow("at most 10 s");
  // The file's own reading is refused at render: too large, too fast, too long, or not the shot its record describes.
  const b=binding();
  expect(()=>assertHeroSourceProbe(probe({width:2560,height:1440}),b)).toThrow("at most 1920 by 1080");
  expect(()=>assertHeroSourceProbe(probe({fps:"120/1"}),b)).toThrow("at most 60 fps");
  expect(()=>assertHeroSourceProbe(probe({durationSec:11}),b)).toThrow("at most 10 s");
  expect(()=>assertHeroSourceProbe(probe({durationSec:2}),b)).toThrow("its render record says 5 s");
  expect(()=>assertHeroSourceProbe(probe(),b)).not.toThrow();
  // An upscale makes the shot larger and stays within UHD.
  expect(heroUpscaleSize({width:1920,height:1080},2160)).toEqual({width:3840,height:2160});
  expect(heroUpscaleSize({width:1280,height:720},1080)).toEqual({width:1920,height:1080});
  expect(()=>heroUpscaleSize({width:1280,height:720},720)).toThrow("An upscale makes the shot larger");
  expect(()=>heroUpscaleSize({width:1920,height:800},2160)).toThrow("over the 3840 by 2160 limit");
  // The gate on a stage's file: a frame-rate stage that kept the old rate, or an upscale of the wrong size, is refused.
  const [denoise,rate,upscale]=heroChainPlan(heroChainRequests({fps:60,height:1080})).stages;
  expect(()=>assertHeroStageProbe(rate!,probe(),probe())).toThrow("was asked for 60");
  expect(()=>assertHeroStageProbe(rate!,probe(),probe({fps:"60/1",frames:299,durationSec:4.983}))).not.toThrow();
  expect(()=>assertHeroStageProbe(upscale!,probe({fps:"60/1"}),probe({fps:"30/1",width:1920,height:1080}))).toThrow("changed the frame rate");
  expect(()=>assertHeroStageProbe(upscale!,probe({fps:"60/1",frames:299}),probe({fps:"60/1",frames:299,width:1916,height:1080}))).toThrow("asked for 1920 by 1080");
  expect(()=>assertHeroStageProbe(denoise!,probe(),probe({frames:149}))).toThrow("wrote 149 frames from 150");
  expect(()=>assertHeroStageProbe(denoise!,probe(),probe({codec:"hevc"}))).toThrow("every stage writes h264 yuv420p");
});

test("a hero render is a delivery job beside the film, at zero cost, counting its shot's frames at the converted rate",()=>{
  const plan=heroJobPlan(binding(),heroChainRequests({fps:48}));
  const job={id:crypto.randomUUID(),idempotencyKey:"hero",projectId,tier:"free" as const,stage:"delivery" as const,scriptVersion:0,scriptText:"",
    rightsAttestedAt:new Date(Date.now()-1000).toISOString(),animaticJobId:null,animaticApprovedAt:null,totalFrames:heroTotalFrames(plan),costCapUsd:0,budgetReservedUsd:0,
    retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:600000,delivery:plan};
  expect(job.totalFrames).toBe(240);
  expect(()=>validateDeliveryJob(job)).not.toThrow();
  expect(validateHeroJob(job,plan)).toEqual(plan);
  expect(()=>validateDeliveryJob({...job,costCapUsd:1})).toThrow("reserves and spends nothing");
  expect(()=>validateDeliveryJob({...job,id:filmId})).toThrow("never the film's own job");
  expect(()=>validateDeliveryJob({...job,projectId:crypto.randomUUID()})).toThrow("inside the project the film belongs to");
  expect(()=>validateDeliveryJob({...job,totalFrames:150})).toThrow("the rate the chain converts it to");
  // The same chain on the same shot of the same sealed film is one deliverable; another chain is another.
  expect(heroJobPlan(binding(),heroChainRequests({fps:48})).idempotencyKey).toBe(plan.idempotencyKey);
  expect(heroJobPlan(binding(),heroChainRequests({fps:50})).idempotencyKey).not.toBe(plan.idempotencyKey);
});
