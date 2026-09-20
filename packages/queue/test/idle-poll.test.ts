import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DurableJobStore} from "../src/index";
import {runWorker} from "../src/worker";

/**
 * HV-032-08: the worker's poll loop asked the store for every job, then filtered the queued and
 * running ones to reconcile reservations. On staging that meant parsing 8.6 MB of job bodies about
 * once a second, per worker: three idle workers burned five cores of an eight-core host and starved
 * the one worker that had a film to render. The loop now asks for the active ids alone.
 */
const keys=["HV_QUEUE_PATH","HV_ARTIFACT_ROOT","HV_COST_LEDGER_PATH","HV_REVIEW_QUEUE_PATH","HV_PROJECT_STATE_PATH","HV_ANIMATIC_PROVIDER_POOL","HV_PROVIDER_POOL","HV_STORAGE","HV_ARTIFACT_STORAGE","HV_WORKER_ID"];
const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const root=mkdtempSync(join(tmpdir(),"hv-idle-poll-"));
afterAll(()=>{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(root,{recursive:true,force:true});});

test("an idle worker reconciles from the active ids and never reads every job body",async()=>{
  Object.assign(process.env,{HV_QUEUE_PATH:join(root,"jobs.json"),HV_ARTIFACT_ROOT:join(root,"artifacts"),
    HV_COST_LEDGER_PATH:join(root,"ledger.json"),HV_REVIEW_QUEUE_PATH:join(root,"reviews.json"),HV_PROJECT_STATE_PATH:join(root,"projects.json"),
    HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["image:mock"]',HV_WORKER_ID:"idle-poll-worker"});
  delete process.env.HV_STORAGE;delete process.env.HV_ARTIFACT_STORAGE;
  const store=new DurableJobStore(join(root,"jobs.json"));
  const finished=store.enqueue({id:crypto.randomUUID(),projectId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),tier:"free",stage:"animatic",
    scriptVersion:1,scriptText:"EXT. GARDEN - DAY\n\nA leaf falls.",rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null,
    totalFrames:240,retryPolicy:{maxRetries:1,backoffMs:10},timeoutMs:60_000,costCapUsd:1});
  store.setStatus(finished.id,"done");
  expect(store.activeJobIds().size).toBe(0);

  const all=DurableJobStore.prototype.all,active=DurableJobStore.prototype.activeJobIds;
  let bodyReads=0,idReads=0;
  DurableJobStore.prototype.all=function(this:DurableJobStore){bodyReads++;return all.call(this);};
  DurableJobStore.prototype.activeJobIds=function(this:DurableJobStore){idReads++;return active.call(this);};
  const stop=new AbortController();
  try{
    const worker=runWorker({signal:stop.signal,pollMs:10,queuePath:join(root,"jobs.json"),artifactRoot:join(root,"artifacts")});
    await Bun.sleep(300);stop.abort();await worker;
  }finally{DurableJobStore.prototype.all=all;DurableJobStore.prototype.activeJobIds=active;}
  expect(idReads).toBeGreaterThan(1);
  expect(bodyReads).toBe(0);
},20_000);
