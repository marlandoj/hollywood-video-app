import {afterAll,beforeAll,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {DUB_SCRIPT,dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";
import type {VideoClip} from "../../generator/src/index";
import {verifySealedClip} from "../../queue/src/shot-reuse";
import type {Job} from "../../queue/src/index";
import {editOriginalJob} from "../src/edit-sources";
import {renderRecord,renderShots,sourceRenderRecord,type ShotRenderRecord} from "../src/shot-reuse";
import {validateShotExecutionCapture} from "../src/shot-execution-capture";
import {validateJobExecutionCheckpoint,validateJobExecutionRecords,validateShotExecutionClips,validateShotExecutionInventoryMetadata,validateShotExecutionOutput,type ShotExecutionInventoryRow} from "../src/shot-execution-inventory";

let fixture:Awaited<ReturnType<typeof dubStudio>>;
let clips:VideoClip[];
let legacy:Job;
const historicalRows=(records:ShotRenderRecord[]):ShotExecutionInventoryRow[]=>records.map(record=>({shotId:record.shotId,recordRevision:record.revision,capture:null,unavailableReason:record.reusedFrom?"reused-source":"legacy-checkpoint"}));
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...value,revision:contentHash(body)};};

beforeAll(async()=>{
  fixture=await dubStudio(undefined,DUB_SCRIPT+"\n\nINT. HALL - NIGHT\nA door opens.");
  clips=JSON.parse(readFileSync(join(fixture.paths.artifactRoot,fixture.film.projectId,fixture.film.id,"clips/manifest.json"),"utf8"));
  expect(clips.length).toBeGreaterThan(1);
  // Actual sealed worker media, with explicitly unavailable historical inventory.
  // These rows test migration/context validation, not captured execution custody.
  legacy=structuredClone(fixture.film);legacy.executionCheckpoints=historicalRows(legacy.output!.shotRenders!);
  legacy.output!.shotExecutions=structuredClone(legacy.executionCheckpoints);
},60000);
afterAll(async()=>{if(fixture)await fixture.close();});

test("historical unavailable rows validate complete actual film inputs without mutating originals",async()=>{
  const before=contentHash({job:legacy,clips,original:fixture.film});
  validateShotExecutionOutput(legacy,legacy.output!);
  expect(validateShotExecutionClips(legacy,clips)!.inventory).toEqual(legacy.executionCheckpoints!);
  validateJobExecutionRecords(legacy,legacy.output!.shotRenders!,true);
  editOriginalJob(legacy);
  const shots=renderShots(legacy,Date.parse(legacy.startedAt!));
  for(const [i,record]of legacy.output!.shotRenders!.entries()){
    expect(sourceRenderRecord(legacy,record)).toEqual(record);
    await verifySealedClip(legacy,shots[i]!,clips[i]!,fixture.paths.artifactRoot,new AbortController().signal);
  }
  expect(contentHash({job:legacy,clips,original:fixture.film})).toBe(before);
  const old=structuredClone(legacy);delete old.executionCheckpoints;delete old.output!.shotExecutions;
  validateShotExecutionOutput(old,old.output!);expect(validateShotExecutionClips(old,clips)).toBeUndefined();
});

test("fresh worker captures bind every actual film record and its admitted recipe",()=>{
  const job=fixture.film,before=contentHash(job);
  expect(job.executionCheckpoints).toHaveLength(clips.length);
  expect(job.output!.shotExecutions).toEqual(job.executionCheckpoints!);
  for(const [i,row]of job.output!.shotExecutions!.entries()){
    expect(row.capture).not.toBeNull();expect(row.unavailableReason).toBeNull();
    expect(row.recordRevision).toBe(job.output!.shotRenders![i]!.revision);
  }
  validateShotExecutionOutput(job,job.output!);
  expect(validateShotExecutionClips(job,clips)!.inventory).toEqual(job.executionCheckpoints!);
  editOriginalJob(job);expect(contentHash(job)).toBe(before);
});

test("a resealed self-consistent capture cannot replace its admitted screenplay prompt",()=>{
  const job=structuredClone(fixture.film),record=job.output!.shotRenders![0]!;
  expect(job.output!.shotExecutions?.[0]?.capture).toBeDefined();
  const row=job.output!.shotExecutions![0]!,capture=row.capture!;
  capture.observation.recipe.dispatch.prompt="A different unapproved room burns brightly.";
  capture.observation.recipe=reseal(capture.observation.recipe);
  capture.observation.emission.prompt=capture.observation.recipe.dispatch.prompt;
  row.capture=reseal(capture);job.executionCheckpoints=structuredClone(job.output!.shotExecutions!);
  // Internal capture consistency alone is not admission or execution custody.
  expect(validateShotExecutionCapture(row.capture,record)).toEqual(row.capture);
  expect(()=>validateShotExecutionOutput(job,job.output!)).toThrow(/admitted screenplay inputs/);
  expect(()=>validateShotExecutionClips(job,clips)).toThrow(/admitted screenplay inputs/);
  expect(()=>editOriginalJob(job)).toThrow(/admitted screenplay inputs/);
  expect(()=>sourceRenderRecord(job,record)).toThrow(/admitted screenplay inputs/);
});

test("captured decision observations must equal the durable router journal under the same IDs",()=>{
  const job=structuredClone(fixture.film),record=job.output!.shotRenders![0]!,journal=contentHash(job.routeDecisions);
  expect(job.output!.shotExecutions?.[0]?.capture).toBeDefined();
  const row=job.output!.shotExecutions![0]!,capture=row.capture!,decision=capture.routes.at(-1)!;
  const selected=decision.candidates.find(candidate=>candidate.id===decision.selectedId)!;
  selected.health={scope:"worker-process",state:"closed",probeInFlight:false,samples:3,latencyMs:17,observedAt:decision.at};
  row.capture=reseal(capture);job.executionCheckpoints=structuredClone(job.output!.shotExecutions!);
  expect(contentHash(job.routeDecisions)).toBe(journal);
  expect(validateShotExecutionCapture(row.capture,record)).toEqual(row.capture);
  // Clip preflight can receive the worker's stale claimed Job. Journal custody
  // is checked against the held queue Job, and again at completed/source boundaries.
  expect(validateShotExecutionClips(job,clips)!.inventory).toEqual(job.executionCheckpoints!);
  expect(()=>validateJobExecutionCheckpoint(job,{records:job.output!.shotRenders!,inventory:job.executionCheckpoints!})).toThrow(/route|decision|journal/i);
  expect(()=>validateShotExecutionOutput(job,job.output!)).toThrow(/route|decision|journal/i);
  expect(()=>editOriginalJob(job)).toThrow(/route|decision|journal/i);
  expect(()=>sourceRenderRecord(job,record)).toThrow(/route|decision|journal/i);
});

test("checkpoint envelope alone cannot bless a different actual record or publish an incomplete film",()=>{
  const altered=structuredClone(legacy);altered.executionCheckpoints![0]!.recordRevision="f".repeat(64);
  // The envelope deliberately has no clip records: full media/context validation is mandatory next.
  expect(validateShotExecutionInventoryMetadata(altered.executionCheckpoints!,altered)).toEqual(altered.executionCheckpoints!);
  expect(()=>validateShotExecutionClips(altered,clips)).toThrow(/immutable shot record/);
  expect(()=>validateShotExecutionOutput(altered,altered.output!)).toThrow(/immutable shot record/);
  const records=legacy.output!.shotRenders!;
  validateJobExecutionRecords(legacy,records.slice(0,1));
  expect(()=>validateJobExecutionRecords(legacy,records.slice(0,1),true)).toThrow(/every admitted shot/);
  expect(()=>validateJobExecutionRecords(legacy,records.slice().reverse())).toThrow(/admitted input prefix/);
  expect(validateShotExecutionClips(legacy,clips.slice(0,1),legacy.executionCheckpoints!.slice(0,1))!.records).toHaveLength(1);
});

test("completed sources refuse absent inventory, changed counts and resealed wrong admitted inputs",()=>{
  const changes:((job:Job)=>void)[]=[
    job=>{delete job.executionCheckpoints;},job=>{delete job.output!.shotExecutions;},
    job=>{job.checkpointFrame++;},job=>{job.checkpointShots--;},
    job=>{job.output!.shotExecutions!.reverse();},
    job=>{const {schema:_schema,revision:_revision,...body}=job.output!.shotRenders![0]!;
      job.output!.shotRenders![0]=renderRecord({...body,inputHash:"e".repeat(64)});
      job.executionCheckpoints=historicalRows(job.output!.shotRenders!);job.output!.shotExecutions=structuredClone(job.executionCheckpoints);},
  ];
  for(const change of changes){
    const job=structuredClone(legacy);change(job);
    expect(()=>validateShotExecutionOutput(job,job.output!)).toThrow();
    expect(()=>editOriginalJob(job)).toThrow();
    expect(()=>sourceRenderRecord(job,job.output!.shotRenders![0]!)).toThrow();
  }
});

test("clip metadata and every retained media role must survive the checkpoint",async()=>{
  const roles=["audioPath","posterPath","sourcePosterPath"] as const;
  const shot=renderShots(legacy,Date.parse(legacy.startedAt!))[0]!;
  expect(clips[0]!.audioPath).toBeDefined();expect(clips[0]!.posterPath).toBeDefined();
  for(const role of roles){
    if(clips[0]![role]===undefined)continue;
    const missing=structuredClone(clips);delete missing[0]![role];
    expect(()=>{validateShotExecutionClips(legacy,missing);}).toThrow(/media role/);
    await expect(verifySealedClip(legacy,shot,missing[0]!,fixture.paths.artifactRoot,new AbortController().signal)).rejects.toThrow();
  }
  const metadata=structuredClone(clips);metadata[0]!.seed++;
  expect(()=>validateShotExecutionClips(legacy,metadata)).toThrow(/clip differs/);
  const wrongPath=structuredClone(clips);wrongPath[0]!.audioPath=wrongPath[1]!.path;
  await expect(verifySealedClip(legacy,shot,wrongPath[0]!,fixture.paths.artifactRoot,new AbortController().signal)).rejects.toThrow();
});

test("execution context rejects accessor inputs before reading job, inventory or clip fields",()=>{
  let reads=0;
  const accessor=<T extends object>(value:T,key:keyof T):T=>Object.defineProperty(value,key,{enumerable:true,get(){reads++;return undefined;}});
  const cases=[
    ()=>{const job=accessor(structuredClone(legacy),"executionCheckpoints");validateShotExecutionOutput(job,job.output!);},
    ()=>{const job=structuredClone(legacy),output=accessor(job.output!,"shotExecutions");validateShotExecutionOutput(job,output);},
    ()=>{const values=structuredClone(clips);accessor(values[0]!,"renderRecord");validateShotExecutionClips(legacy,values);},
    ()=>{const values=structuredClone(clips);accessor(values[0]!,"seed");validateShotExecutionClips(legacy,values);},
    ()=>{const job=accessor(structuredClone(legacy),"scriptText");validateJobExecutionRecords(job,legacy.output!.shotRenders!,true);},
    ()=>{const records=structuredClone(legacy.output!.shotRenders!);accessor(records[0]!,"inputHash");validateJobExecutionRecords(legacy,records,true);},
  ];
  for(const check of cases){reads=0;expect(check).toThrow();expect(reads).toBe(0);}
});
