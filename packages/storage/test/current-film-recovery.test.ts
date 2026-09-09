import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {cpSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {ProjectService,type AnimaticApproval} from "../../api/src/index";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {createProviderPlan} from "../../generator/src/catalog";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {compileCurrentFilmJob,type CurrentFilmJobV2} from "../../planner/src/current-film-jobs";
import {currentFilmV2Job,type CurrentFilmV2Job,createCurrentFilmPreviewReview,createCurrentFilmCheckpoint,currentFilmRecordedFiles} from "../../planner/src/current-film-job-context";
import {currentFilmAuthorityFixture,currentFilmAuthorityProposal} from "../../planner/test/current-film-authority.fixture";
import {readStateSnapshot,writeStateSnapshot,stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../src/snapshots";

let fixture:Awaited<ReturnType<typeof currentFilmAuthorityFixture>>,preview:CurrentFilmV2Job,final:CurrentFilmV2Job,snapshot:StateSnapshot,approval:AnimaticApproval,previousPool:string|undefined;
beforeAll(async()=>{
  previousPool=process.env.HV_PROVIDER_POOL;process.env.HV_PROVIDER_POOL='["mock"]';
  fixture=await currentFilmAuthorityFixture();const pending=currentFilmAuthorityProposal(fixture.project,"recovery-proposal",fixture.at+10),queue=new DurableJobStore(join(fixture.studio.root,"current-recovery-queue.json"));
  const state={...fixture.studio.projects.snapshot(),projects:[pending.project]},projects=ProjectService.fromState(state),ledger=new CostLedger(join(fixture.studio.root,"current-recovery-costs.json")),reviewQueue=new OperatorReviewQueue(join(fixture.studio.root,"current-recovery-reviews.json"));
  const input=(plan:CurrentFilmJobV2,id:string):JobInput=>({id,projectId:plan.projectId,idempotencyKey:id,currentFilm:plan,stage:plan.render.stage,tier:plan.render.tier,scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,
    casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,rightsAttestedAt:pending.project.rightsAttestedAt!,animaticJobId:plan.render.role==="render"?preview.id:null,animaticApprovedAt:plan.render.role==="render"?approval.at:null,
    totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000});
  const previewPlan=compileCurrentFilmJob(pending.saved.library,pending.plan.selector,{role:"preview",tier:"free",providerPlan:createProviderPlan("animatic",5)});
  queue.enqueue(input(previewPlan,"current-recovery-preview"));preview=currentFilmV2Job((await processNextJob(queue,fixture.studio.paths.artifactRoot,{projects,ledger,reviewQueue}))!);
  if(preview.status!=="done")throw new Error("Actual V2 recovery preview failed: "+(preview.failureReason??preview.cancelReason));
  const review=createCurrentFilmPreviewReview(preview),casting=pending.plan.target.state.casting.candidate!,direction=pending.plan.library.origin!.request.baseline.direction;
  approval={animaticJobId:preview.id,scriptVersion:preview.scriptVersion,decision:"approved",note:"Actual preview reviewed for recovery fixture",at:new Date().toISOString(),castingVersion:casting.version,castingRevision:casting.revision,directionVersion:direction.version,directionRevision:direction.revision,currentFilmReview:review};
  const approved=projects.snapshot();approved.projects[0]!.animaticApprovals.push(approval);const reviewed=ProjectService.fromState(approved);
  const finalPlan=compileCurrentFilmJob(pending.saved.library,pending.plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5)});
  queue.enqueue(input(finalPlan,"current-recovery-final"));final=currentFilmV2Job((await processNextJob(queue,fixture.studio.paths.artifactRoot,{projects:reviewed,ledger,reviewQueue}))!);
  if(final.status!=="done")throw new Error("Actual V2 recovery final failed: "+(final.failureReason??final.cancelReason));
  expect(reviewed.snapshot().projects[0]!.versions).toEqual(fixture.project.versions);
  const accepted=pending.accept(Date.now());accepted.animaticApprovals=[approval,{...approval,decision:"changes_requested",note:"Later decision retained without rewriting earlier approval",at:new Date(Date.now()+1).toISOString()}];
  snapshot=JSON.parse(JSON.stringify({schema:"hv-state/12",projects:{...approved,projects:[accepted]},jobs:[fixture.studio.film,preview,final],ledger:{events:[],reservations:[]},reviews:[]})) as StateSnapshot;
},300000);
afterAll(async()=>{await fixture?.studio.close();if(previousPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=previousPool;});

test("actual pending V2 preview/final recover after later canonical acceptance and later review decisions",()=>{
  expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/12");expect(validateSnapshot(snapshot)).toBe(snapshot);
  expect(snapshot.projects.projects[0]!.versions.at(-1)!.text).toContain("Stay for a while.");
  expect(preview.output!.shotRenders).toBeUndefined();expect(final.output!.currentFilm!.records).toHaveLength(final.currentFilm!.materialization.slots.length);
  expect(final.output!.currentFilm!.assembly.probe.video.frames).toBe(final.output!.currentFilm!.assembly.frames);
  const future=spyOn(Date,"now").mockReturnValue(Date.parse(preview.linkExpiresAt!)+86400000);
  try{expect(validateSnapshot(snapshot)).toBe(snapshot);}finally{future.mockRestore();}
},90000);

test("old schemas, orphan nested markers, missing saved history and changed review/output fail closed",()=>{
  for(const schema of ["hv-state/1","hv-state/10","hv-state/11"] as const)expect(()=>validateSnapshot({...snapshot,schema})).toThrow(/schema 12/);
  const mutate:((s:StateSnapshot)=>void)[]=[s=>{delete s.jobs[1]!.currentFilm;},s=>{s.jobs[1]!.currentFilmCheckpoint!.rows[0]!.inputRevision="f".repeat(64);},
    s=>{Object.assign(s.projects.projects[0]!,{extra:{currentFilmCheckpoint:s.jobs[1]!.currentFilmCheckpoint}});},s=>{Object.assign(s.projects.projects[0]!,{retained:{job:s.jobs[1]}});},
    s=>{s.projects.projects[0]!.versions.shift();},s=>{s.projects.projects[0]!.currentScreenplay!.proposals=[];},s=>{s.projects.projects[0]!.animaticApprovals[0]!.currentFilmReview!.outputRevision="f".repeat(64);},
    s=>{s.projects.projects[0]!.animaticApprovals.splice(0,1);},s=>{s.jobs[2]!.output!.currentFilm!.assembly.frames++;},s=>{s.jobs[1]!.currentFilmCheckpoint=undefined;},
    s=>{Object.assign(s.jobs[1]!,{orphanCapture:currentFilmV2Job(s.jobs[1]!).currentFilmCheckpoint!.rows[0]!.capture});}];
  for(const change of mutate){const changed=structuredClone(snapshot);change(changed);expect(()=>validateSnapshot(changed)).toThrow();}
},120000);

test("drained prefix snapshots retain exact actual records and journal while missing prefixes cannot be inferred",()=>{
  // A recovery-boundary fixture made from one genuinely rendered row. Actual interrupted
  // dispatch/resume behavior has separate worker tests; this test covers snapshot semantics.
  const job=structuredClone(preview);job.status="failed";job.output=undefined;job.completedAt=null;job.linkExpiresAt=null;job.checkpointShots=1;job.checkpointFrame=Math.round(job.currentFilmCheckpoint!.rows[0]!.record.clip.durationSec*30);
  job.currentFilmCheckpoint=createCurrentFilmCheckpoint(job,job.currentFilmCheckpoint!.rows.slice(0,1));
  const state=structuredClone(snapshot);state.jobs=[fixture.studio.film,job];state.projects.projects[0]!.animaticApprovals=[];
  expect(validateSnapshot(state)).toBe(state);const before=structuredClone(state);state.jobs[1]!.currentFilmCheckpoint=undefined;expect(()=>validateSnapshot(state)).toThrow(/prefix/);
  const noDispatch=structuredClone(before);noDispatch.jobs[1]!.routeDecisions=[];expect(()=>validateSnapshot(noDispatch)).toThrow(/journal/);
},60000);

async function python(args:string[]){const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};}
function archiveSource(name:string){const root=join(fixture.studio.root,name);writeStateSnapshot(root,snapshot);
  for(const job of snapshot.jobs){const target=join(root,"artifacts",job.projectId,job.id);mkdirSync(join(root,"artifacts",job.projectId),{recursive:true});cpSync(join(fixture.studio.paths.artifactRoot,job.projectId,job.id),target,{recursive:true});}return root;
}

test("independent Python archive preserves actual V2 MP4/captions/clips and canonical JSON after source copy is removed",async()=>{
  const source=archiveSource("current-film-pack"),archive=join(fixture.studio.root,"current-film.zip"),restored=join(fixture.studio.root,"current-film-restored"),expected=new Map(currentFilmRecordedFiles(final).map(file=>[file.path,readFileSync(join(source,"artifacts",file.path))]));
  const packed=await python(["pack","--source",source,"--output",archive,"--project",final.projectId]);expect(packed.stderr).toBe("");expect(packed.code).toBe(0);
  // Only this fixture's copied artifact tree is removed. The archive must provide every byte.
  rmSync(join(source,"artifacts"),{recursive:true,force:true});
  const unpacked=await python(["unpack","--source",archive,"--output",restored]);expect(unpacked.stderr).toBe("");expect(unpacked.code).toBe(0);
  expect(readStateSnapshot(restored)).toEqual(snapshot);
  for(const [path,bytes]of expected)expect(readFileSync(join(restored,"artifacts",path)).equals(bytes)).toBe(true);
  expect(readFileSync(join(restored,"queue/jobs.json"))).toEqual(readFileSync(join(source,"queue/jobs.json")));
},180000);

test("archive checks final caption bytes as well as source clips before publishing",async()=>{
  const root=archiveSource("current-film-corrupt"),caption=join(root,"artifacts",final.output!.captionsPath),bytes=readFileSync(caption);writeFileSync(caption,Buffer.alloc(bytes.length,88));
  const result=await python(["pack","--source",root,"--output",join(fixture.studio.root,"bad-current-film.zip"),"--project",final.projectId]);expect(result.code).not.toBe(0);expect(result.stderr).toContain("current-film");
},120000);
