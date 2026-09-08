import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {bindOriginalEditSource,type EditSourceBinding} from "../src/edit-jobs";
import {renderRecord,sourceRenderRecord,type ShotRenderRecord} from "../src/shot-reuse";
import {compileRetainedShotReuse,validateRetainedShotReuse,retainedShotReuseFiles,type RetainedShotReuse} from "../src/retained-shot-reuse";

let fixture:Awaited<ReturnType<typeof dubStudio>>,original:EditSourceBinding,carrier:EditSourceBinding,record:ShotRenderRecord;
const seal=<T extends {revision:string}>(input:T):T=>{const {revision:_revision,...data}=input;return {...data,revision:contentHash(data)} as T;};
beforeAll(async()=>{
  fixture=await dubStudio();original=bindOriginalEditSource(await inspectEditSource(fixture.film,"Original speech",fixture.paths.artifactRoot,async()=>{}));record=fixture.film.output!.shotRenders![0]!;
  // Structural fixture only: current carrier availability is deliberately outside this compiler.
  carrier=seal({...structuredClone(original),owner:{...original.owner,jobId:"retaining-editorial-job"},files:original.files.map((file,index)=>({...file,path:fixture.owner.projectId+"/retaining-editorial-job/originals/file-"+index}))});
},120000);
afterAll(async()=>{await fixture?.close();});

test("retained shot context seals the exact original record and positional role mapping without rewriting history",()=>{
  const before=contentHash({record,carrier}),context=compileRetainedShotReuse(record,carrier),files=retainedShotReuseFiles(context);
  expect(context.schema).toBe("hv-retained-shot-reuse/1");expect(context.record).toEqual(record);expect(context.binding).toEqual(carrier);expect(context.record.jobId).not.toBe(context.binding.owner.jobId);
  for(const [role,file]of Object.entries(record.files)){const index=original.source.files.findIndex(item=>item.path===file.path);expect(files[role as keyof typeof files]).toEqual(carrier.files[index]!);expect(files[role as keyof typeof files]!.sha256).toBe(file.sha256);expect(files[role as keyof typeof files]!.bytes).toBe(file.bytes);}
  expect(Object.keys(files)).toEqual(Object.keys(record.files));expect(validateRetainedShotReuse(context)).toEqual(context);expect(compileRetainedShotReuse(record,carrier)).toEqual(context);expect(contentHash({record,carrier})).toBe(before);
  const {revision,...data}=context;expect(revision).toBe(contentHash(data));context.record.clip.model="Caller mutation";context.binding.files[0]!.path="Caller mutation";files.video.sha256="a".repeat(64);expect(contentHash({record,carrier})).toBe(before);
});

test("historical validation remains valid after ordinary original availability expires",()=>{
  const now=spyOn(Date,"now").mockReturnValue(Date.parse(original.owner.linkExpiresAt)+1);
  try{expect(()=>sourceRenderRecord(original.source.job,record)).toThrow("unavailable");expect(compileRetainedShotReuse(record,carrier).record).toEqual(record);expect(retainedShotReuseFiles(compileRetainedShotReuse(record,original))).toEqual(record.files);}finally{now.mockRestore();}
});

test("recompiled context rejects nonmember records, forged project/file bindings and resealed context changes",()=>{
  const {schema:_schema,revision:_revision,...data}=record,changed=renderRecord({...data,inputHash:"a".repeat(64)});
  expect(()=>compileRetainedShotReuse(changed,carrier)).toThrow();expect(()=>compileRetainedShotReuse({...record,projectId:"foreign"},carrier)).toThrow();
  const wrongProject=seal({...carrier,owner:{...carrier.owner,projectId:"foreign"}});expect(()=>compileRetainedShotReuse(record,wrongProject)).toThrow();
  const swapped=structuredClone(carrier);[swapped.files[0],swapped.files[1]]=[swapped.files[1]!,swapped.files[0]!];expect(()=>compileRetainedShotReuse(record,seal(swapped))).toThrow();
  const wrongBytes=structuredClone(carrier);wrongBytes.files[0]!.bytes++;expect(()=>compileRetainedShotReuse(record,seal(wrongBytes))).toThrow();
  const context=compileRetainedShotReuse(record,carrier);expect(()=>validateRetainedShotReuse({...context,record:changed})).toThrow();expect(()=>validateRetainedShotReuse(seal({...context,record:changed}))).toThrow();
  expect(()=>validateRetainedShotReuse({...context,revision:"b".repeat(64)})).toThrow("context changed");expect(()=>validateRetainedShotReuse({...context,extra:true} as RetainedShotReuse)).toThrow("exact sealed");
});

test("descriptor and array validation rejects executable or dropped metadata before reading it",()=>{
  let reads=0;const trapped=Object.defineProperty({...record},"clip",{enumerable:true,get(){reads++;return record.clip;}});expect(()=>compileRetainedShotReuse(trapped,carrier)).toThrow("without accessors");expect(reads).toBe(0);
  const sparse=structuredClone(carrier);sparse.files.length++;expect(()=>compileRetainedShotReuse(record,sparse)).toThrow("dense");
  const symbol=structuredClone(carrier);Object.defineProperty(symbol,Symbol("unreviewed"),{value:true});expect(()=>compileRetainedShotReuse(record,symbol)).toThrow();
  const context=compileRetainedShotReuse(record,carrier);Object.defineProperty(context,"revision",{enumerable:true,get(){reads++;return "a".repeat(64);}});expect(()=>validateRetainedShotReuse(context)).toThrow("without accessors");expect(reads).toBe(0);
});
