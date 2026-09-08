import {afterAll,beforeAll,expect,test} from "bun:test";
import {contentHash as hash} from "../../generator/src/capabilities";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {bindOriginalEditSource,validateEditBinding} from "../src/edit-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3,type CurrentFilmReuseChoice} from "../src/current-film-mixed-jobs";
import {CURRENT_FILM_ADOPTION_LIMITS,compileCurrentFilmAdoption,validateCurrentFilmAdoption,type CurrentFilmAdoption} from "../src/current-film-adoption";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3,audioOrdinal:number;
const jobId="adoption-target";
const seal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
function choice(ordinal:number):CurrentFilmReuseChoice {
  const slot=f.plan.materialization.slots[ordinal]!,row=f.job.currentFilmCheckpoint!.rows[ordinal]!;
  return {ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:row.record.revision}};
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();audioOrdinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.files.audio));
  if(audioOrdinal<0)throw new Error("The adoption fixture requires an actual native dialogue role.");
  plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[...new Set([0,audioOrdinal])].map(choice)});
},180000);
afterAll(async()=>{await f?.close();});

test("actual V2 roles receive independent target-owned copy specifications without rewriting original execution",()=>{
  const before=hash({receipt:f.receipt,plan}),first=compileCurrentFilmAdoption(plan,jobId,0),spoken=compileCurrentFilmAdoption(plan,jobId,audioOrdinal);
  for(const adoption of [first,spoken]){
    const row=f.job.currentFilmCheckpoint!.rows[adoption.sourceSelector.ordinal]!,slot=plan.materialization.slots[adoption.target.ordinal]!;
    expect(adoption.schema).toBe("hv-current-film-adoption/1");expect(adoption.jobPlanRevision).toBe(plan.revision);
    expect(adoption.sourceSelector.recordRevision).toBe(row.record.revision);expect(adoption.captureRevision).toBe(row.capture.revision);
    expect(adoption.frames).toBe(f.job.output!.currentFilm!.assembly.spans[adoption.target.ordinal]!.frames);
    expect(adoption.target).toEqual({ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision});
    expect(adoption.copies.map(copy=>copy.role).join(",")).toBe(Object.keys(row.record.files).sort().join(","));
    const prefix=`${plan.projectId}/${jobId}/reused/slot-${String(slot.ordinal).padStart(4,"0")}/`;
    for(const copy of adoption.copies){expect(copy.original).toEqual(row.record.files[copy.role]!);expect(copy.carrier).toEqual(copy.original);
      expect(copy.owned.path.startsWith(prefix)).toBe(true);expect(copy.owned.path).not.toBe(copy.original.path);
      expect(copy.owned.bytes).toBe(copy.original.bytes);expect(copy.owned.sha256).toBe(copy.original.sha256);}
    expect(validateCurrentFilmAdoption(adoption,plan,jobId)).toEqual(adoption);
    expect(Object.hasOwn(adoption,"record")).toBe(false);expect(Object.hasOwn(adoption,"capture")).toBe(false);
    expect(Object.hasOwn(adoption,"mediaVerified")).toBe(false);
  }
  expect(spoken.copies.some(copy=>copy.role==="audio"&&copy.owned.path.endsWith("/audio.wav"))).toBe(true);
  expect(plan.origins).toHaveLength(1);expect(hash({receipt:f.receipt,plan})).toBe(before);
  const changed=validateCurrentFilmAdoption(spoken,plan,jobId);changed.copies[0]!.original.path="caller-mutation";
  expect(validateCurrentFilmAdoption(spoken,plan,jobId)).toEqual(spoken);expect(hash({receipt:f.receipt,plan})).toBe(before);
},90000);

test("metadata-only carrier relocation preserves original references and binds its exact distinct copy mapping",()=>{
  const binding=bindOriginalEditSource(f.receipt),carrierId="metadata-carrier";
  binding.owner.jobId=carrierId;binding.owner.outputRevision="a".repeat(64);
  binding.files=binding.files.map((file,index)=>({...file,path:`${plan.projectId}/${carrierId}/retained/file-${index}`}));
  const checked=validateEditBinding(seal(binding)),relocated=compileCurrentFilmMixedJob(f.plan,{origins:[checked],choices:[choice(audioOrdinal)]});
  const adoption=compileCurrentFilmAdoption(relocated,jobId,audioOrdinal);
  expect(adoption.originId).toBe(f.receipt.revision);expect(adoption.sourceSelector).toEqual(choice(audioOrdinal).source);
  for(const copy of adoption.copies){expect(copy.original.path.startsWith(`${plan.projectId}/${f.job.id}/`)).toBe(true);
    expect(copy.carrier.path.startsWith(`${plan.projectId}/${carrierId}/`)).toBe(true);expect(copy.owned.path.startsWith(`${plan.projectId}/${jobId}/`)).toBe(true);}
  expect(()=>compileCurrentFilmAdoption(relocated,carrierId,audioOrdinal)).toThrow("independent");
  expect(()=>compileCurrentFilmAdoption(relocated,f.job.id,audioOrdinal)).toThrow("independent");
  expect(validateCurrentFilmAdoption(adoption,relocated,jobId)).toEqual(adoption);
  expect(()=>validateCurrentFilmAdoption(adoption,plan,jobId)).toThrow();
  // No files are created at these metadata paths. This contract grants no custody.
},90000);

test("resealed adoption tampering cannot lose roles or cross-bind source, target, carrier and reviewed timing",()=>{
  const adoption=compileCurrentFilmAdoption(plan,jobId,audioOrdinal);
  const changes:((value:CurrentFilmAdoption)=>void)[]=[
    value=>{value.copies=value.copies.filter(copy=>copy.role!=="audio");},
    value=>{value.copies[0]!.owned.path=`${plan.projectId}/foreign/reused/video.mp4`;},
    value=>{value.copies[0]!.owned.path=`${plan.projectId}/${jobId}/reused/../video.mp4`;},
    value=>{value.copies[0]!.owned.sha256="b".repeat(64);},
    value=>{value.copies[0]!.carrier.path=value.copies[0]!.owned.path;},
    value=>{value.copies[0]!.original.bytes++;},
    value=>{value.copies[0]!.role="sourcePoster";},
    value=>{value.sourceSelector.recordRevision="c".repeat(64);},
    value=>{value.target.inputRevision="d".repeat(64);},
    value=>{value.jobPlanRevision=f.plan.revision;},
    value=>{value.originId="e".repeat(64);},
    value=>{value.captureRevision="f".repeat(64);},
    value=>{value.reviewRevision="a".repeat(64);},
    value=>{value.correspondenceRevision="b".repeat(64);},
    value=>{value.frames++;},
    value=>{value.jobId="another-target";},
  ];
  for(const change of changes){const modified=structuredClone(adoption);change(modified);expect(()=>validateCurrentFilmAdoption(seal(modified),plan,jobId)).toThrow();}
  expect(()=>validateCurrentFilmAdoption(adoption,plan,"another-target")).toThrow();
  expect(()=>compileCurrentFilmAdoption(plan,"../escaped",audioOrdinal)).toThrow();
  expect(()=>compileCurrentFilmAdoption(plan,jobId,-1)).toThrow();
  const fresh=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]});
  expect(()=>compileCurrentFilmAdoption(fresh,jobId,audioOrdinal)).toThrow("fresh generation");
},90000);

test("adoption validation rejects nonportable, unknown and oversized metadata before invoking accessors",()=>{
  const adoption=compileCurrentFilmAdoption(plan,jobId,audioOrdinal);let reads=0;
  const accessor=structuredClone(adoption);Object.defineProperty(accessor,"target",{enumerable:true,get(){reads++;return adoption.target;}});
  expect(()=>validateCurrentFilmAdoption(accessor,plan,jobId)).toThrow("portable");expect(reads).toBe(0);
  const hidden=structuredClone(adoption);Object.defineProperty(hidden.copies[0]!,Symbol("hidden"),{value:1});
  expect(()=>validateCurrentFilmAdoption(hidden,plan,jobId)).toThrow("portable");
  const extra=structuredClone(adoption);Object.assign(extra.copies,{extra:true});
  expect(()=>validateCurrentFilmAdoption(extra,plan,jobId)).toThrow("portable");
  expect(()=>validateCurrentFilmAdoption({...adoption,claim:undefined} as CurrentFilmAdoption,plan,jobId)).toThrow("exact");
  const oversized=structuredClone(adoption);oversized.copies[0]!.owned.path="a".repeat(CURRENT_FILM_ADOPTION_LIMITS.bytes+1);
  expect(()=>validateCurrentFilmAdoption(oversized,plan,jobId)).toThrow("bounded");
  const duplicated=structuredClone(adoption);duplicated.copies=Array.from({length:CURRENT_FILM_ADOPTION_LIMITS.copies+1},()=>adoption.copies[0]!);
  expect(()=>validateCurrentFilmAdoption(duplicated,plan,jobId)).toThrow("bounded");
},90000);
