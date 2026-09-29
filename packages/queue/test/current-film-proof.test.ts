import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {contentHash as hash} from "../../generator/src/capabilities";
import {DurableJobStore,type JobInput} from "../src/index";
import {heldCurrentFilmV3} from "./current-film-v3-held.fixture";
import {ProjectService} from "../../api/src/index";
import {assertLocalCurrentFilmProofCurrent} from "../src/current-film-proof";
import {compileCurrentFilmMixedJob} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmProofTarget} from "../../planner/src/current-film-proof-target";
import {compileCurrentFilmProofClosure} from "../../planner/src/current-film-proof-closure";
import {compileCurrentFilmProofCopies,freezeCurrentFilmProofContext} from "../../planner/src/current-film-proof-copies";
import {createCurrentFilmPreparedProof,currentFilmPreparedProofFiles,type CurrentFilmPreparedProof} from "../../planner/src/current-film-prepared-proof";
import {currentFilmV3Job,currentFilmRuntimeMode} from "../../planner/src/current-film-runtime-context";
import {validateCurrentFilmMixedJob,currentFilmMixedRecordedFiles,createCurrentFilmMixedOutput,validateCurrentFilmMixedOutput,type CurrentFilmMixedJob,type CurrentFilmMixedJobInput} from "../../planner/src/current-film-mixed-job-context";
import {compileCurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {createCurrentFilmMixedCheckpoint} from "../../planner/src/current-film-mixed-context";
import {createCurrentFilmMixedAssemblyClock} from "../../planner/src/current-film-mixed-clock";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,input:CurrentFilmMixedJobInput,started:CurrentFilmMixedJob,proof:CurrentFilmPreparedProof,at:number;
const holder="proof-domain-holder",lease=300000;
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
beforeAll(async()=>{
  f=await currentFilmSourceFixture();const plan=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]});
  input={id:f.job.id,projectId:plan.projectId,idempotencyKey:"proof-domain",currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,
    scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
    rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,
    costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:2,backoffMs:0},timeoutMs:300000};
  // Admission and claiming still refuse V3 (HV-016-27); the fixture builds the exact held record.
  at=Date.parse(f.job.startedAt!);started=heldCurrentFilmV3(input as unknown as JobInput,at,holder,lease);
  const target=compileCurrentFilmProofTarget(started),frozenContext=freezeCurrentFilmProofContext({project:f.projects.snapshot().projects[0]!,jobs:[f.studio.film,f.job]});
  const closure=compileCurrentFilmProofClosure(plan,frozenContext,target);
  if(closure.previews.length)throw new Error("This animatic fixture has no required final-preview dependency.");
  const specification=compileCurrentFilmProofCopies(plan,started.id,{target,frozenContext,previews:[],carriers:closure.receipts.map(({receipt,candidates})=>{
    const {files:_files,...candidate}=candidates[0]!;return {...candidate,receiptRevision:receipt.revision};
  })});
  proof=createCurrentFilmPreparedProof(started,specification,at+1);
},180000);
afterAll(async()=>{await f?.close();});

/** The real source supplies historical records. These domain tests do not claim
 * proof files were copied or indexed; the artifact transaction supplies custody. */
function held(){return DurableJobStore.fromJobs([started]);}
function prepared(){const store=held();store.checkpointCurrentFilmProof(started.id,holder,proof,at+2,lease);return store;}

test("synchronous local guard accepts exact selected originals and a live VersionStore before checkpoint",()=>{
  const store=DurableJobStore.fromJobs([...proof.specification.frozenContext.jobs,started]),project=f.projects.peekProject(started.projectId);
  expect(project).not.toBeNull();expect(proof.specification.frozenContext.jobs.length).toBeGreaterThan(0);
  const before=hash(store.all());assertLocalCurrentFilmProofCurrent(proof,store,project);expect(hash(store.all())).toBe(before);
  // Same synchronous sequence as local worker publication; no awaited gap.
  assertLocalCurrentFilmProofCurrent(proof,store,project);store.checkpointCurrentFilmProof(started.id,holder,proof,at+2,lease);
  expect(store.get(started.id)!.currentFilmProof).toEqual(proof);
},90000);

test("a selected original record changed after preparation refuses before the local checkpoint",()=>{
  const store=DurableJobStore.fromJobs([...proof.specification.frozenContext.jobs,started]),project=f.projects.peekProject(started.projectId);
  const selected=proof.specification.frozenContext.jobs.find(job=>Boolean(job.output?.shotRenders?.length));
  if(!selected)throw new Error("Require the authentic selected legacy original for this regression.");
  const actual=store.get(selected.id)!,record=actual.output!.shotRenders![0]!;record.revision="f".repeat(64);
  const targetBefore=hash(store.get(started.id)),sourceBefore=hash(actual);
  expect(()=>{assertLocalCurrentFilmProofCurrent(proof,store,project);store.checkpointCurrentFilmProof(started.id,holder,proof,at+2,lease);}).toThrow("selected local proof job changed");
  expect(hash(store.get(started.id))).toBe(targetBefore);expect(store.get(started.id)!.currentFilmProof).toBeUndefined();
  expect(hash(store.get(selected.id))).toBe(sourceBefore);
},90000);

test("rewritten current project history refuses without checkpointing or altering the saved target",()=>{
  const store=DurableJobStore.fromJobs([...proof.specification.frozenContext.jobs,started]);
  const project=ProjectService.fromState(f.projects.snapshot()).peekProject(started.projectId);
  if(!project?.currentScreenplay?.origin)throw new Error("Require the authentic saved screenplay origin.");
  const originalProject=hash(f.projects.snapshot()),targetBefore=hash(store.get(started.id));
  project.currentScreenplay.origin.request.script.text+="\nRewritten historical screenplay.";
  expect(()=>{assertLocalCurrentFilmProofCurrent(proof,store,project);store.checkpointCurrentFilmProof(started.id,holder,proof,at+2,lease);}).toThrow();
  expect(hash(store.get(started.id))).toBe(targetBefore);expect(store.get(started.id)!.currentFilmProof).toBeUndefined();
  expect(hash(f.projects.snapshot())).toBe(originalProject);
},90000);

test("revoked live project rights refuse the final local guard without checkpoint or state changes",()=>{
  const store=DurableJobStore.fromJobs([...proof.specification.frozenContext.jobs,started]);
  const project=ProjectService.fromState(f.projects.snapshot()).peekProject(started.projectId);
  if(!project)throw new Error("Require the authentic current project.");
  const now=Date.now();assertLocalCurrentFilmProofCurrent(proof,store,project,now);
  const before=hash(store.all()),originalProject=hash(f.projects.snapshot());project.rightsAttestedAt=null;
  expect(()=>{assertLocalCurrentFilmProofCurrent(proof,store,project,now);store.checkpointCurrentFilmProof(started.id,holder,proof,at+2,lease);}).toThrow("rights");
  expect(hash(store.all())).toBe(before);expect(store.get(started.id)!.currentFilmProof).toBeUndefined();
  expect(hash(f.projects.snapshot())).toBe(originalProject);
},90000);

test("proof-only checkpoint is immutable, detached and restorable with zero selected shots or origins",()=>{
  const store=prepared(),job=currentFilmV3Job(store.get(started.id)!);
  expect(job.currentFilmProof).toEqual(proof);expect(job.currentFilmOrigins).toBeUndefined();expect(job.currentFilmCheckpoint).toBeUndefined();
  expect(job.checkpointShots).toBe(0);expect(job.checkpointFrame).toBe(0);expect(job.startedAt).toBe(started.startedAt);
  expect(currentFilmMixedRecordedFiles(job)).toEqual(currentFilmPreparedProofFiles(proof,job));
  expect(currentFilmMixedRecordedFiles(job).every(file=>file.path.startsWith(`${job.projectId}/${job.id}/proof/`))).toBe(true);
  store.checkpointCurrentFilmProof(job.id,holder,structuredClone(proof),at+3,lease);
  const changed=reseal({...proof,preparedAt:new Date(at+2).toISOString()}),before=hash(store.get(job.id));
  expect(()=>store.checkpointCurrentFilmProof(job.id,holder,changed,at+4,lease)).toThrow("immutable");expect(hash(store.get(job.id))).toBe(before);
  const restore=DurableJobStore.fromJobs(JSON.parse(JSON.stringify([store.get(job.id)])));
  expect(currentFilmMixedRecordedFiles(currentFilmV3Job(restore.get(job.id)!))).toEqual(currentFilmMixedRecordedFiles(job));
},90000);

test("holder, preparation time and malformed checkpoint refusal preserve unchanged in-memory state",()=>{
  const store=held(),before=hash(store.get(started.id));
  expect(()=>store.checkpointCurrentFilmProof(started.id,"other-worker",proof,at+2,lease)).toThrow("wrong_worker");
  expect(()=>store.checkpointCurrentFilmProof(started.id,holder,proof,at+lease,lease)).toThrow("lease_expired");
  expect(()=>store.checkpointCurrentFilmProof(started.id,holder,proof,at,lease)).toThrow("before preparation");
  expect(()=>store.checkpointCurrentFilmProof(started.id,holder,{...proof,revision:"0".repeat(64)},at+2,lease)).toThrow("changed");
  expect(()=>store.checkpointCurrentFilmProof(started.id,holder,proof,at+2,Infinity)).toThrow();
  expect(hash(store.get(started.id))).toBe(before);
},90000);

test("retry, terminal refusal and cancellation preserve original proof-only startedAt; claiming V3 is still refused",()=>{
  // Reclaiming a prepared V3 job waits for V3 claiming in the worker increment.
  // The expired lease is still recovered before the V3 refusal; the proof and startedAt survive it.
  const crash=prepared(),later=at+lease+3;
  expect(()=>crash.claimNext(later,{},{workerId:"replacement-holder",leaseMs:lease})).toThrow();
  expect(crash.get(started.id)!.claimedBy).not.toBe("replacement-holder");expect(crash.get(started.id)!.startedAt).toBe(started.startedAt);expect(crash.get(started.id)!.currentFilmProof).toEqual(proof);
  expect(()=>crash.checkpointCurrentFilmProof(started.id,holder,proof,later+1,lease)).toThrow();
  const retry=prepared();retry.fail(started.id,holder,"interrupted after proof",at+4);
  expect(retry.get(started.id)!.startedAt).toBe(started.startedAt);expect(retry.get(started.id)!.currentFilmProof).toEqual(proof);
  expect(()=>retry.claimNext(at+5,{},{workerId:holder,leaseMs:lease})).toThrow();
  const refused=prepared();expect(refused.refuse(started.id,holder,"operator refusal",at+4).startedAt).toBe(started.startedAt);
  const cancelled=prepared();expect(cancelled.cancel(started.id,holder,"owner cancellation",at+4).startedAt).toBe(started.startedAt);
  for(const store of [crash,retry,refused,cancelled])expect(validateCurrentFilmMixedJob(currentFilmV3Job(store.get(started.id)!))).toEqual(input.currentFilm);
},90000);

test("private proof admission rejects before exact-key replay and cannot downgrade into V2 or ordinary jobs",()=>{
  const store=prepared(),before=hash(store.get(started.id));
  for(const marker of [proof,null,undefined]){
    expect(()=>store.enqueue({...input,currentFilmProof:marker} as unknown as JobInput)).toThrow();
    expect(()=>currentFilmRuntimeMode({...f.job,currentFilmProof:marker} as unknown as CurrentFilmMixedJob)).toThrow("prepared proof");
    expect(()=>currentFilmRuntimeMode({...f.studio.film,currentFilmProof:marker} as unknown as CurrentFilmMixedJob)).toThrow("prepared proof");
  }
  expect(hash(store.get(started.id))).toBe(before);
  let reads=0;const hostile={...input};Object.defineProperty(hostile,"currentFilmProof",{enumerable:true,get(){reads++;return proof;}});
  expect(()=>store.enqueue(hostile)).toThrow(/accessors|prepared proof/);expect(reads).toBe(0);
  expect(()=>validateCurrentFilmMixedJob({...started,currentFilmProof:{...proof,jobId:"foreign"}})).toThrow();
  expect(()=>validateCurrentFilmMixedJob({...started,currentFilmProof:proof,startedAt:new Date(at+1).toISOString()})).toThrow();
  expect(validateCurrentFilmMixedJob(started)).toEqual(input.currentFilm); // Historical absence remains supported.
},90000);

test("mixed output binds exact prepared proof without adding it to historical absent-marker output",()=>{
  // As in the existing mixed-context fixture, authentic V2 records and probe
  // qualify format consistency only, not a new worker or publication receipt.
  const job=currentFilmV3Job(prepared().get(started.id)!);job.currentFilmOrigins=compileCurrentFilmOrigins(job.currentFilm,job.id);
  const rows=f.job.currentFilmCheckpoint!.rows.map(row=>({kind:"generated" as const,...row}));job.routeDecisions=f.job.routeDecisions;
  job.currentFilmCheckpoint=createCurrentFilmMixedCheckpoint(job,rows);job.checkpointShots=rows.length;job.checkpointFrame=f.job.checkpointFrame;
  const original=f.job.output!.currentFilm!.assembly,clock=createCurrentFilmMixedAssemblyClock(job,job.currentFilmCheckpoint,{sourceFrames:original.spans.map(span=>span.frames),
    effectiveOverlapFrames:original.effectiveOverlapFrames,reason:original.reason,probe:original.probe,video:original.video,captions:{srt:original.captions.srt,vtt:original.captions.vtt}});
  const {mp4Path,hlsPlaylistPath,captionsPath,manifestPath}=f.job.output!;
  job.output={mp4Path,hlsPlaylistPath,captionsPath,manifestPath,currentFilm:createCurrentFilmMixedOutput(job,clock)};
  expect(job.output.currentFilm.proofRevision).toBe(proof.revision);expect(()=>validateCurrentFilmMixedOutput(job,job.output!)).not.toThrow();
  const changed=structuredClone(job.output);delete changed.currentFilm.proofRevision;changed.currentFilm=reseal(changed.currentFilm);
  expect(()=>validateCurrentFilmMixedOutput(job,changed)).toThrow("differs");
  const historical=structuredClone(job);delete historical.currentFilmProof;delete historical.output;
  const old=createCurrentFilmMixedOutput(historical,clock);expect(Object.hasOwn(old,"proofRevision")).toBe(false);
},90000);
