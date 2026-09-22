import {expect,test} from "bun:test";
import {UNRECORDED_CHECKPOINT_PHASE,checkpointMedia,type ArtifactRecord} from "../src/artifacts";

/**
 * HV-025-12: a checkpoint verifies and then stores, and verification reproduces the render rather
 * than re-reading it. On the object-store path both halves ran inside one call that recorded no
 * phase, so an editorial job's largest cost was invisible in its own trace.
 */
const file=(name:string,bytes=10)=>({path:"p/j/"+name,sha256:name.repeat(64).slice(0,64),bytes});
const record=(f:{path:string;sha256:string;bytes:number}):ArtifactRecord=>
  ({key:f.path,objectKey:"v1/"+f.path,projectId:"p",jobId:"j",sha256:f.sha256,bytes:f.bytes,contentType:"application/octet-stream"});
const recorder=()=>{const phases:{name:string;files:number}[]=[];
  return {phases,phase:(async<T>(name:"verify"|"store",files:number,step:()=>Promise<T>)=>{phases.push({name,files});return await step();}) as Parameters<typeof checkpointMedia>[4]};};

test("a checkpoint verifies and then stores, and each half reports itself with its file count",async()=>{
  const files=[file("a"),file("b"),file("c")],order:string[]=[],{phases,phase}=recorder();
  let opened=0;
  const records=await checkpointMedia(files,async()=>{order.push("verify");},async f=>{order.push("upload "+f.path);return record(f);},
    async()=>{opened++;},phase,"Editorial media changed before checkpointing.");
  expect(order).toEqual(["verify","upload p/j/a","upload p/j/b","upload p/j/c"]);
  expect(records.map(value=>value.key)).toEqual(files.map(value=>value.path));
  // One span for the verification and one for the whole store, each naming how many files it covers.
  expect(phases).toEqual([{name:"verify",files:3},{name:"store",files:3}]);
  // The lease and permission gate is still asked before every file.
  expect(opened).toBe(3);
});

test("verification is the gate: a checkpoint that cannot reproduce its render stores nothing",async()=>{
  const {phases,phase}=recorder();let uploads=0;
  await expect(checkpointMedia([file("a")],async()=>{throw new Error("The editorial checkpoint does not reproduce its original source frames or samples.");},
    async f=>{uploads++;return record(f);},async()=>{},phase,"Editorial media changed before checkpointing."))
    .rejects.toThrow("does not reproduce");
  expect(uploads).toBe(0);
  expect(phases).toEqual([{name:"verify",files:1}]);
});

test("a file that changed under the checkpoint stops it with the caller's own words, before the next file",async()=>{
  const files=[file("a"),file("b"),file("c")];let uploads=0;
  await expect(checkpointMedia(files,async()=>{},async f=>{uploads++;return f.path.endsWith("b")?{...record(f),bytes:f.bytes+1}:record(f);},
    async()=>{},UNRECORDED_CHECKPOINT_PHASE,"Editorial media changed before checkpointing."))
    .rejects.toThrow("Editorial media changed before checkpointing.");
  expect(uploads).toBe(2);
  await expect(checkpointMedia(files,async()=>{},async f=>({...record(f),sha256:"0".repeat(64)}),
    async()=>{},UNRECORDED_CHECKPOINT_PHASE,"Assembly media changed before checkpointing."))
    .rejects.toThrow("Assembly media changed before checkpointing.");
});

test("a caller that records nothing still verifies, stores and gates in the same order",async()=>{
  const order:string[]=[];
  const records=await checkpointMedia([file("a"),file("b")],async()=>{order.push("verify");},async f=>{order.push("upload");return record(f);},
    async()=>{order.push("access");},UNRECORDED_CHECKPOINT_PHASE,"Editorial media changed before checkpointing.");
  expect(order).toEqual(["verify","access","upload","access","upload"]);
  expect(records).toHaveLength(2);
});
