import {afterAll,beforeAll,expect,test} from "bun:test";
import {contentHash as hash} from "../../generator/src/capabilities";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {bindOriginalEditSource,validateEditBinding,type EditSourceBinding} from "../src/edit-jobs";
import {editFactsRevision,editSourceVoiceWindows,validateEditSourceReceipt,type EditSourceReceipt} from "../src/edit-sources";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3,type CurrentFilmReuseChoice} from "../src/current-film-mixed-jobs";
import {CURRENT_FILM_ORIGINS_LIMITS,compileCurrentFilmOrigins,validateCurrentFilmOrigins,type CurrentFilmOrigins} from "../src/current-film-origins";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3;
const jobId="prepared-origin-target";
const seal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
function choice(ordinal:number,receipt=f.receipt):CurrentFilmReuseChoice {
  const slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  return {ordinal,inputRevision:slot.inputRevision,originId:receipt.revision,source:{receiptRevision:receipt.revision,ordinal,
    logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}};
}
function relocate(receipt:EditSourceReceipt,carrierId:string):EditSourceBinding {
  const binding=bindOriginalEditSource(receipt);binding.owner.jobId=carrierId;binding.owner.outputRevision="a".repeat(64);
  binding.files=binding.files.map((item,index)=>({...item,path:`${f.plan.projectId}/${carrierId}/retained/file-${index}`}));
  return validateEditBinding(seal(binding));
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();
  // Only one shot is selected. Full source custody must still retain every other shot.
  plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[choice(0)]});
},180000);
afterAll(async()=>{await f?.close();});

test("one selected take retains the entire actual V2 inventory once without changing source evidence",()=>{
  const before=hash({source:f.receipt,plan}),value=compileCurrentFilmOrigins(plan,jobId),origin=value.origins[0]!;
  expect(value.schema).toBe("hv-current-film-origins/1");expect(value.jobPlanRevision).toBe(plan.revision);
  expect(value.origins).toHaveLength(1);expect(origin.originId).toBe(f.receipt.revision);
  expect(origin.bindingRevision).toBe(plan.origins[0]!.binding.revision);expect(origin.receiptRevision).toBe(f.receipt.revision);
  expect(origin.copies.map(copy=>copy.original)).toEqual(f.receipt.files);
  expect(origin.copies.map(copy=>copy.carrier)).toEqual(f.receipt.files);
  for(const copy of origin.copies){expect(copy.owned).toEqual({...copy.original,path:`${plan.projectId}/${jobId}/originals/${origin.originId}/${copy.original.path}`});}
  for(const row of f.job.currentFilmCheckpoint!.rows.slice(1))for(const file of Object.values(row.record.files)){
    expect(origin.copies.some(copy=>hash(copy.original)===hash(file))).toBe(true);
  }
  const paths=origin.copies.map(copy=>copy.original.path);
  for(const path of [f.job.output!.mp4Path,f.job.output!.manifestPath,f.job.output!.captionsPath,f.job.output!.captionsPath.replace(/\.vtt$/,".srt")])expect(paths).toContain(path);
  expect(paths.some(path=>path.startsWith(`${plan.projectId}/${f.studio.film.id}/`))).toBe(false);
  expect(Object.hasOwn(value,"mediaVerified")).toBe(false);expect(Object.hasOwn(origin,"job")).toBe(false);
  expect(validateCurrentFilmOrigins(JSON.parse(JSON.stringify(value)),plan,jobId)).toEqual(value);
  const returned=validateCurrentFilmOrigins(value,plan,jobId);returned.origins[0]!.copies[0]!.original.path="caller-change";
  expect(validateCurrentFilmOrigins(value,plan,jobId)).toEqual(value);expect(hash({source:f.receipt,plan})).toBe(before);
},90000);

test("canonical direct-origin order and full positional carrier maps survive source inventory reordering",()=>{
  // Two separately labelled receipts of the same real film exercise catalog identities;
  // these metadata-only carrier paths do not claim that any media was copied.
  const first=structuredClone(f.receipt),second=structuredClone(f.receipt);first.facts.label="First retained inspection";
  second.facts.label="Second retained inspection";second.files.reverse();
  const a=validateEditSourceReceipt(seal(first)),b=validateEditSourceReceipt(seal(second)),bindings=[relocate(a,"carrier-a"),relocate(b,"carrier-b")];
  const mixed=compileCurrentFilmMixedJob(f.plan,{origins:bindings.reverse(),choices:[choice(0,a),choice(1,b)]}),value=compileCurrentFilmOrigins(mixed,jobId);
  expect(value.origins.map(origin=>origin.originId)).toEqual(mixed.origins.map(origin=>origin.id));
  expect(value.origins.map(origin=>origin.originId)).toEqual([a.revision,b.revision].sort());
  for(const origin of value.origins){const binding=mixed.origins.find(item=>item.id===origin.originId)!.binding;
    expect(origin.copies.map(copy=>copy.original)).toEqual(binding.source.files);expect(origin.copies.map(copy=>copy.carrier)).toEqual(binding.files);
    expect(origin.copies.every(copy=>copy.carrier.path!==copy.original.path&&copy.owned.path!==copy.carrier.path)).toBe(true);
  }
  expect(validateCurrentFilmOrigins(value,mixed,jobId)).toEqual(value);
  const changed=structuredClone(value);changed.origins.reverse();expect(()=>validateCurrentFilmOrigins(seal(changed),mixed,jobId)).toThrow("exact plan");
  for(const owner of [f.job.id,"carrier-a","carrier-b",f.studio.film.id])expect(()=>compileCurrentFilmOrigins(mixed,owner)).toThrow("independent");
},90000);

test("all-fresh V3 needs an empty direct inventory but still refuses the bootstrap owner",()=>{
  const fresh=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]}),value=compileCurrentFilmOrigins(fresh,jobId);
  expect(value.origins).toEqual([]);expect(value.jobPlanRevision).toBe(fresh.revision);
  expect(validateCurrentFilmOrigins(value,fresh,jobId)).toEqual(value);
  expect(()=>compileCurrentFilmOrigins(fresh,f.studio.film.id)).toThrow("independent");
  expect(()=>compileCurrentFilmOrigins(fresh,"../escape")).toThrow("bounded");
  expect(()=>compileCurrentFilmOrigins(fresh,"a".repeat(129))).toThrow("bounded");
},90000);

test("resealed omissions, aliases, order, owner and binding changes cannot replace complete source custody metadata",()=>{
  const value=compileCurrentFilmOrigins(plan,jobId),changes:((input:CurrentFilmOrigins)=>void)[]=[
    input=>{input.origins=[];},
    input=>{input.origins[0]!.copies.pop();},
    input=>{input.origins[0]!.copies.reverse();},
    input=>{input.origins.push(structuredClone(input.origins[0]!));},
    input=>{input.origins[0]!.copies.push(structuredClone(input.origins[0]!.copies[0]!));},
    input=>{input.origins[0]!.copies[0]!.original.bytes++;},
    input=>{input.origins[0]!.copies[0]!.carrier.path=input.origins[0]!.copies[1]!.carrier.path;},
    input=>{input.origins[0]!.copies[0]!.owned.path=`${plan.projectId}/foreign/originals/file`;},
    input=>{input.origins[0]!.copies[0]!.owned.path=`${plan.projectId}/${jobId}/originals/../file`;},
    input=>{input.origins[0]!.copies[0]!.owned.sha256="b".repeat(64);},
    input=>{input.origins[0]!.bindingRevision="c".repeat(64);},
    input=>{input.origins[0]!.receiptRevision="d".repeat(64);},
    input=>{input.origins[0]!.originId="e".repeat(64);},
    input=>{input.jobPlanRevision=f.plan.revision;},
    input=>{input.projectId="foreign";},
    input=>{input.jobId="other-target";},
  ];
  for(const change of changes){const input=structuredClone(value);change(input);expect(()=>validateCurrentFilmOrigins(seal(input),plan,jobId)).toThrow();}
  expect(()=>validateCurrentFilmOrigins(value,plan,"other-target")).toThrow();
  const broken=structuredClone(plan);broken.origins[0]!.binding.files.pop();
  expect(()=>compileCurrentFilmOrigins(seal(broken),jobId)).toThrow();
},90000);

test("a valid long original manifest address cannot overflow the new owned namespace",()=>{
  const source=structuredClone(f.receipt),oldPath=source.job.output!.manifestPath,prefix=`${plan.projectId}/${source.job.id}/`;
  const longPath=prefix+"m".repeat(900-prefix.length)+".json";source.job.output!.manifestPath=longPath;
  source.files.find(file=>file.path===oldPath)!.path=longPath;
  Object.assign(source.facts,editSourceVoiceWindows(source.job));source.facts.revision=editFactsRevision(source.job,source.facts.frames,source.facts.width,source.facts.height,source.facts.captions);
  const receipt=validateEditSourceReceipt(seal(source)),binding=bindOriginalEditSource(receipt);
  const mixed=compileCurrentFilmMixedJob(f.plan,{origins:[binding],choices:[choice(0,receipt)]});
  // This is a supported source metadata address, not a claim the relocated file exists.
  expect(binding.source.files.some(file=>file.path===longPath)).toBe(true);
  expect(()=>compileCurrentFilmOrigins(mixed,"target-"+"x".repeat(121))).toThrow("paths");
},90000);

test("metadata capacity, duplicate paths and portable descriptors fail before accessors run",()=>{
  const value=compileCurrentFilmOrigins(plan,jobId);let reads=0;
  for(const part of ["manifest","copy","plan"]){
    const input=structuredClone(value),source=structuredClone(plan);
    if(part==="manifest")Object.defineProperty(input,"origins",{enumerable:true,get(){reads++;return value.origins;}});
    else if(part==="copy")Object.defineProperty(input.origins[0]!.copies[0]!.owned,"path",{enumerable:true,get(){reads++;return "path";}});
    else Object.defineProperty(source,"origins",{enumerable:true,get(){reads++;return plan.origins;}});
    expect(()=>validateCurrentFilmOrigins(input,source,jobId)).toThrow("portable");
  }
  expect(reads).toBe(0);
  const extra=structuredClone(value);Object.assign(extra.origins,{hidden:true});expect(()=>validateCurrentFilmOrigins(extra,plan,jobId)).toThrow("portable");
  const hidden=structuredClone(value);Object.defineProperty(hidden,Symbol("hidden"),{value:1});expect(()=>validateCurrentFilmOrigins(hidden,plan,jobId)).toThrow("portable");
  const sparse=structuredClone(value);delete sparse.origins[0]!.copies[0];expect(()=>validateCurrentFilmOrigins(sparse,plan,jobId)).toThrow("portable");
  expect(()=>validateCurrentFilmOrigins({...value,approved:undefined} as CurrentFilmOrigins,plan,jobId)).toThrow("exact");
  const long=structuredClone(value);long.origins[0]!.copies[0]!.owned.path="x".repeat(CURRENT_FILM_ORIGINS_LIMITS.path+1);expect(()=>validateCurrentFilmOrigins(long,plan,jobId)).toThrow("paths");
  const many=structuredClone(value);many.origins=Array.from({length:CURRENT_FILM_ORIGINS_LIMITS.origins+1},()=>value.origins[0]!);expect(()=>validateCurrentFilmOrigins(many,plan,jobId)).toThrow("bounded");
  const huge=structuredClone(value),file={path:"source/file",sha256:"a".repeat(64),bytes:CURRENT_FILM_ORIGINS_LIMITS.fileBytes};
  huge.origins[0]!.copies=Array.from({length:7},(_,index)=>({original:{...file},carrier:{...file},owned:{...file,path:`owned/${index}`}}));
  expect(()=>validateCurrentFilmOrigins(huge,plan,jobId)).toThrow("capacity");
  const tooMany=structuredClone(value),small={...file,bytes:1};
  tooMany.origins[0]!.copies=Array.from({length:CURRENT_FILM_ORIGINS_LIMITS.files+1},(_,index)=>({original:small,carrier:small,owned:{...small,path:`owned/${index}`}}));
  expect(()=>validateCurrentFilmOrigins(tooMany,plan,jobId)).toThrow("bounded");
},90000);
