import {afterAll,beforeAll,expect,test} from "bun:test";
import {cpSync,existsSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {ProjectService} from "../../api/src/index";
import {createEditSequence} from "../../planner/src/edit-library";
import {bindOriginalEditSource,bindRetainedEditSource,createEditPlan,editRenderReview} from "../../planner/src/edit-jobs";
import {editHistoryState} from "../../planner/src/edit-history";
import {contentHash as hash} from "../../generator/src/capabilities";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {readStateSnapshot,writeStateSnapshot,stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../src/snapshots";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,carrier:Job,base:StateSnapshot,final:Awaited<ReturnType<typeof f.renderFinal>>;
beforeAll(async()=>{
  f=await currentFilmSourceFixture();const origin=f.project.currentScreenplay!.origin!.request.source;
  const bindings=[bindOriginalEditSource(f.receipt),bindOriginalEditSource(origin)];
  let library=f.projects.createEditSequence(f.studio.owner.token,[f.receipt,origin],"current-retained","Canonical source carrier",f.job.id,320,180,0,Date.now(),bindings)!;
  library=f.projects.changeEditSequence(f.studio.owner.token,"current-retained",{kind:"edit",label:"One second with full retained handles",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-f.receipt.facts.frames,ripple:true}},library.version,library.sequences[0]!.history.revision)!;
  const sequence=library.sequences[0]!,timeline=editHistoryState(sequence.history).timeline;
  const pictureEdit=createEditPlan(sequence,sequence.sourceRevisions.map(revision=>bindings.find(value=>value.source.revision===revision)!),soundRuntimeRevision(),"local",hash("current-source-recovery"),editRenderReview(timeline));
  // Real completed jobs are seeded into a detached queue; no metadata is fabricated and
  // the normal worker checks both original carriers before creating its independent export.
  const queuePath=join(f.studio.root,"current-retained-jobs.json");writeFileSync(queuePath,JSON.stringify([f.studio.film,f.job]));const store=new DurableJobStore(queuePath);
  const sourceJob=pictureEdit.bindings[0]!.source.job,input:JobInput={id:"current-retained-export",projectId:f.job.projectId,idempotencyKey:"current-retained-export",tier:"free",stage:"picture-edit",scriptVersion:sourceJob.scriptVersion,scriptText:sourceJob.scriptText,rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:30,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000,pictureEdit};
  store.enqueue(input);const renderStarted=performance.now();carrier=(await processNextJob(store,f.studio.paths.artifactRoot,f.context))!;
  if(carrier.status!=="done")throw new Error("Actual current-source carrier failed: "+(carrier.failureReason??carrier.cancelReason));
  console.info(JSON.stringify({milestone:"current-film-retained-source",renderMs:Math.round(performance.now()-renderStarted),timeoutMs:input.timeoutMs,status:carrier.status}));
  final=await f.renderFinal();
  const accepted=f.accept();accepted.editLibrary=library;accepted.animaticApprovals=f.projects.snapshot().projects[0]!.animaticApprovals;
  base=JSON.parse(JSON.stringify({schema:"hv-state/13",projects:{...f.projects.snapshot(),projects:[{...accepted,animaticApprovals:[]}]},jobs:[carrier],ledger:{events:[],reservations:[]},reviews:[]})) as StateSnapshot;
},360000);
afterAll(async()=>{await f?.close();});

test("schema thirteen preserves actual retained canonical source and private custody after its original job and head advance",()=>{
  expect(stateSnapshotSchema(base.projects,base.jobs)).toBe("hv-state/13");expect(validateSnapshot(base)).toBe(base);
  const receipt=bindRetainedEditSource(carrier,f.receipt.revision).source;
  expect(receipt).toEqual(f.receipt);expect(base.jobs.some(job=>job.id===receipt.job.id)).toBe(false);
  expect(base.projects.projects[0]!.currentScreenplay!.headRevision).not.toBe(receipt.job.currentFilm!.library.headRevision);
  expect(compileEditScriptSource(receipt)).toEqual(compileEditScriptSource(f.receipt));
  const before=hash(base),now=Date.now;Date.now=()=>Date.parse(receipt.job.linkExpiresAt!)+86400000;
  try{expect(validateSnapshot(base)).toBe(base);}finally{Date.now=now;}expect(hash(base)).toBe(before);
  expect(ProjectService.fromState(base.projects).snapshot()).toEqual(base.projects);
  const notification=structuredClone(base),later=structuredClone(f.job);later.notifications.push("Later delivery reminder");notification.jobs.push(later);
  expect(validateSnapshot(notification)).toBe(notification);
},90000);

test("old schemas and unrelated markers cannot discard source originals, history or exact prepared copy ownership",()=>{
  for(const schema of ["hv-state/4","hv-state/11","hv-state/12"] as const)expect(()=>validateSnapshot({...base,schema})).toThrow(/schema 13/);
  const mutate:((value:StateSnapshot)=>void)[]=[value=>{Object.assign(value.projects.projects[0]!,{hidden:f.receipt});},
    value=>{value.projects.projects[0]!.currentScreenplay!.proposals=[];},
    value=>{value.jobs[0]!.output!.editorial!.prepared.sources.find(source=>source.receipt.job.currentFilm)!.receipt.job.currentFilmCheckpoint!.rows[0]!.record.clip.durationSec++;},
    value=>{Object.assign(value.jobs[0]!,{unowned:structuredClone(f.job.currentFilmCheckpoint!.rows[0]!.capture)});},
    value=>{value.jobs[0]!.output!.editorial!.prepared.sources[0]!.copies[0]!.copy.path="foreign/owner/file.mp4";},
    value=>{value.jobs.push({...structuredClone(f.job),linkExpiresAt:new Date(Date.parse(f.job.linkExpiresAt!)+1000).toISOString()});}];
  for(const change of mutate){const value=structuredClone(base);change(value);expect(()=>validateSnapshot(value)).toThrow();}
  let reads=0;const accessor=structuredClone(base);Object.defineProperty(accessor.projects.projects[0]!,"hidden",{enumerable:true,get(){reads++;return f.receipt;}});
  expect(()=>validateSnapshot(accessor)).toThrow(/accessor/);expect(reads).toBe(0);
  const topOnly:StateSnapshot={...structuredClone(base),projects:structuredClone(f.projects.snapshot()),jobs:[f.studio.film,f.job,final.job]};delete topOnly.projects.projects[0]!.editLibrary;
  expect(stateSnapshotSchema(topOnly.projects,topOnly.jobs)).toBe("hv-state/12");
},120000);

test("retained final validates its actual owning preview decision and refuses a review hash without that job",()=>{
  const state=structuredClone(base),project=state.projects.projects[0]!;
  project.editLibrary=createEditSequence(project.editLibrary!,project.id,[final.receipt],"retained-final","Overlapping final",final.job.id,320,180,project.editLibrary!.version);
  project.animaticApprovals=f.projects.snapshot().projects[0]!.animaticApprovals;state.jobs.push(f.job);
  expect(validateSnapshot(state)).toBe(state);
  // The preview is also retained inside the carrier. Removing that carrier and the
  // preview receipt shows the remaining self-contained final-source dependency explicitly.
  const finalOnly=structuredClone(state);finalOnly.jobs=[];
  const only=finalOnly.projects.projects[0]!;only.editLibrary=createEditSequence({schema:"hv-edit-library/1",version:0,sources:[],sequences:[],revision:hash({schema:"hv-edit-library/1",version:0,sources:[],sequences:[]})},only.id,[final.receipt],"only-final","Only final",final.job.id,320,180,0);
  expect(()=>validateSnapshot(finalOnly)).toThrow(/owning preview job/);
},90000);

async function python(args:string[]){const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};}
function copied(name:string){const root=join(f.studio.root,name);writeStateSnapshot(root,base);mkdirSync(join(root,"artifacts",carrier.projectId),{recursive:true});cpSync(join(f.studio.paths.artifactRoot,carrier.projectId,carrier.id),join(root,"artifacts",carrier.projectId,carrier.id),{recursive:true});return root;}

test("independent schema thirteen pack/unpack restores every canonical source role with no original directories",async()=>{
  const root=copied("source-pack"),archive=join(f.studio.root,"current-source.zip"),output=join(f.studio.root,"source-unpacked"),expected=bindRetainedEditSource(carrier,f.receipt.revision);
  expect(existsSync(join(root,"artifacts",f.job.projectId,f.job.id))).toBe(false);expect(existsSync(join(root,"artifacts",f.studio.film.projectId,f.studio.film.id))).toBe(false);
  const packed=await python(["pack","--source",root,"--output",archive,"--project",carrier.projectId]);expect(packed.stderr).toBe("");expect(packed.code).toBe(0);
  const artifacts=realpathSync(join(root,"artifacts"));if(!artifacts.startsWith(realpathSync(f.studio.root)+sep))throw new Error("Unsafe source archive fixture cleanup");rmSync(artifacts,{recursive:true,force:true});
  const unpacked=await python(["unpack","--source",archive,"--output",output]);expect(unpacked.stderr).toBe("");expect(unpacked.code).toBe(0);
  const restored=readStateSnapshot(output);expect(restored).toEqual(base);expect(readFileSync(join(output,"state/projects.json"))).toEqual(readFileSync(join(root,"state/projects.json")));
  const binding=bindRetainedEditSource(restored.jobs[0]!,f.receipt.revision);expect(binding).toEqual(expected);
  for(const file of binding.files)expect(readFileSync(join(output,"artifacts",file.path)).equals(readFileSync(join(f.studio.paths.artifactRoot,file.path)))).toBe(true);
  expect(compileEditScriptSource(binding.source)).toEqual(compileEditScriptSource(f.receipt));
},240000);

test("changed retained native speech bytes cannot publish an archive",async()=>{
  const root=copied("source-corrupt"),binding=bindRetainedEditSource(carrier,f.receipt.revision),audio=f.job.output!.currentFilm!.records.find(row=>row.record.files.audio)!.record.files.audio!,index=f.receipt.files.findIndex(file=>file.path===audio.path),path=join(root,"artifacts",binding.files[index]!.path),bytes=readFileSync(path);
  bytes[48]^=1;writeFileSync(path,bytes);const archive=join(f.studio.root,"current-source-corrupt.zip"),result=await python(["pack","--source",root,"--output",archive,"--project",carrier.projectId]);
  expect(result.code).not.toBe(0);expect(result.stderr).toContain("missing or corrupt");expect(existsSync(archive)).toBe(false);
},120000);
