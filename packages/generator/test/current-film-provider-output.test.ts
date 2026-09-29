import {afterEach,expect,spyOn,test} from "bun:test";
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve,sep} from "node:path";
import {withCurrentFilmProviderOutput} from "../src/current-film-provider-output";
import * as workspace from "../src/current-film-workspace";
import {EDIT_STORAGE_LIMITS} from "../../planner/src/edit-resources";
import {FailoverGenerator,sunkCostsOf,type CostRecord,type ProviderAdapter,type VideoClip} from "../src/index";
import {LeaseError} from "../../queue/src/index";

const roots:string[]=[],owner={projectId:"provider-project",jobId:"provider-job"};
const cost={provider:"fixture",model:"fixture-v1",prompt_tokens:3,output_frames:30,gpu_seconds:0,total_cost_usd:0};
function fixture(){const root=mkdtempSync(join(tmpdir(),"hv-provider-output-"));roots.push(root);return root;}
function clip(path:string,body="video"):VideoClip {writeFileSync(path,body);return {path,provider:"fixture",model:"fixture-v1",seed:12,durationSec:1,fingerprint:"a".repeat(64),cost};}
afterEach(()=>{for(const root of roots.splice(0)){const absolute=resolve(root);if(!absolute.startsWith(resolve(tmpdir())+sep)||!absolute.slice(resolve(tmpdir()).length+1).startsWith("hv-provider-output-"))throw new Error("Refuse unowned test cleanup");rmSync(absolute,{recursive:true,force:true});}});

test("each actual invocation owns its roles while preserving returned metadata and actual cost identity",async()=>{
  const root=fixture(),results:VideoClip[]=[];
  for(let i=0;i<2;i++){
    const returned=await withCurrentFilmProviderOutput(root,owner,"shot-a0.mp4",async path=>{
      expect(path.replaceAll("\\","/")).toMatch(/\/provider-project\/provider-job\/clips\/attempts\/[a-f0-9-]{36}\/shot-a0\.mp4$/);
      const value=clip(path);value.audioPath=path+".wav";value.posterPath=path+".png";value.sourcePosterPath=path+".source.png";
      for(const role of [value.audioPath,value.posterPath,value.sourcePosterPath])writeFileSync(role,"actual role");results.push(value);return value;
    });
    expect(returned).toBe(results[i]!);expect(returned.cost).toBe(cost);expect(returned.seed).toBe(12);
  }
  expect(dirname(results[0]!.path)).not.toBe(dirname(results[1]!.path));
  for(const result of results)expect(readFileSync(result.path,"utf8")).toBe("video");
});

test("a delayed aborted first writer cannot overwrite a completed replacement or fallback invocation",async()=>{
  const root=fixture(),abort=new AbortController();let enter!:()=>void,release!:()=>void,firstPath="";
  const entered=new Promise<void>(done=>{enter=done;}),gate=new Promise<void>(done=>{release=done;});
  const old=withCurrentFilmProviderOutput(root,owner,"shot-a0.mp4",async path=>{firstPath=path;enter();await gate;return clip(path,"late old output");},abort.signal);
  await entered;
  const current=await withCurrentFilmProviderOutput(root,owner,"shot-a0.mp4",async path=>clip(path,"completed replacement"));
  const identity=lstatSync(current.path).ino,reason=new Error("old holder lost its lease");abort.abort(reason);
  release();const refusal=await old.then(()=>undefined,error=>error);
  expect(refusal).toBeInstanceOf(Error);expect(refusal.message).toBe("old holder lost its lease");expect(refusal).not.toBe(reason);expect(refusal.cause).toBe(reason);
  expect(firstPath).not.toBe(current.path);expect(readFileSync(firstPath,"utf8")).toBe("late old output");
  expect(readFileSync(current.path,"utf8")).toBe("completed replacement");expect(lstatSync(current.path).ino).toBe(identity);
  expect(sunkCostsOf(refusal)).toEqual([cost]);expect(sunkCostsOf(refusal)[0]).toBe(cost);expect(Object.hasOwn(reason,"sunkCosts")).toBe(false);
});

test("the real attempt executor preserves LeaseError and records one cost after an isolated provider returns during abort",async()=>{
  const root=fixture(),abort=new AbortController(),reason=new LeaseError(owner.jobId,"fence_changed","replacement");
  const charged:CostRecord[]=[],reported:CostRecord[]=[];let dispatched=0,afterError:unknown,reasonWasUntouched=false,output="";
  const provider:ProviderAdapter={name:"fixture",model:"fixture-v1",generate:async(_prompt,_seed,params)=>
    withCurrentFilmProviderOutput(root,owner,"shot-a0.mp4",async path=>{dispatched++;output=path;abort.abort(reason);return clip(path,"completed after lease loss");},params.signal)};
  const executor=new FailoverGenerator(provider,provider,1000);
  const failure=await executor.generateAttempt(provider,"A quiet garden.",12,{seed:12,signal:abort.signal,
    onAttemptCost:actual=>{charged.push(actual);},afterAttempt:outcome=>{reported.push(...outcome.costs);afterError=outcome.error;reasonWasUntouched=!Object.hasOwn(reason,"sunkCosts");}},join(root,"unused.mp4"))
    .then(()=>undefined,error=>error);
  expect(dispatched).toBe(1);expect(charged).toEqual([cost]);expect(charged[0]).toBe(cost);expect(reported).toEqual([cost]);expect(reasonWasUntouched).toBe(true);
  expect(afterError).not.toBe(reason);expect((afterError as Error).cause).toBe(reason);expect(sunkCostsOf(afterError)).toEqual([cost]);
  expect(failure).toBe(reason);expect(failure).toBeInstanceOf(LeaseError);expect(sunkCostsOf(failure)).toEqual([cost]);expect(sunkCostsOf(failure)[0]).toBe(cost);
  expect(readFileSync(output,"utf8")).toBe("completed after lease loss");
});

test("provider exceptions and partial owned bytes remain unchanged without cleanup",async()=>{
  const root=fixture(),failure=Object.assign(new Error("actual provider refusal"),{sunkCosts:[cost]});let partial="";
  try{await withCurrentFilmProviderOutput(root,owner,"shot-a0.mp4",async path=>{partial=path;writeFileSync(path,"partial provider bytes");throw failure;});throw new Error("Expected refusal");}
  catch(error){expect(error).toBe(failure);}
  expect(failure.sunkCosts).toEqual([cost]);expect(readFileSync(partial,"utf8")).toBe("partial provider bytes");
});

test("hostile ownership, unsafe basenames and already-aborted calls refuse before dispatch",async()=>{
  const root=fixture();let reads=0,dispatched=0;const hostile={...owner};Object.defineProperty(hostile,"jobId",{enumerable:true,get(){reads++;return owner.jobId;}});
  const dispatch=async(path:string)=>{dispatched++;return clip(path);};
  await expect(withCurrentFilmProviderOutput(root,hostile,"shot.mp4",dispatch)).rejects.toThrow("portable");
  for(const name of ["../shot.mp4","sub/shot.mp4","shot.mov",".hidden.mp4"])await expect(withCurrentFilmProviderOutput(root,owner,name,dispatch)).rejects.toThrow("basename");
  const controller=new AbortController();controller.abort(new Error("already stopped"));await expect(withCurrentFilmProviderOutput(root,owner,"shot.mp4",dispatch,controller.signal)).rejects.toThrow("already stopped");
  expect(reads).toBe(0);expect(dispatched).toBe(0);expect(readdirSync(root)).toEqual([]);
});

test("foreign video, ancillary aliases, accessors and empty or linked roles refuse without deleting bytes",async()=>{
  for(const kind of ["video","audio","duplicate","accessor","empty","linked"]){
    const root=fixture(),foreign=join(root,"foreign.bin");writeFileSync(foreign,"retain foreign bytes");let reads=0,original="";
    await expect(withCurrentFilmProviderOutput(root,owner,"shot.mp4",async path=>{
      original=path;const value=clip(path);
      if(kind==="video")value.path=foreign;
      else if(kind==="audio")value.audioPath=foreign;
      else if(kind==="duplicate")value.posterPath=path;
      else if(kind==="accessor")Object.defineProperty(value,"audioPath",{enumerable:true,get(){reads++;return foreign;}});
      else if(kind==="empty")writeFileSync(path,"");
      else {const linked=path+".linked";symlinkSync(dirname(foreign),linked,process.platform==="win32"?"junction":"dir");value.posterPath=linked;}
      return value;
    })).rejects.toThrow();
    expect(reads).toBe(0);expect(readFileSync(foreign,"utf8")).toBe("retain foreign bytes");expect(readFileSync(original,"utf8")).toBe(kind==="empty"?"":"video");
  }
});

test("linked owner components and replaced invocation directories refuse rather than adopting another directory",async()=>{
  const linkedRoot=fixture(),external=fixture();mkdirSync(join(linkedRoot,owner.projectId));symlinkSync(external,join(linkedRoot,owner.projectId,owner.jobId),process.platform==="win32"?"junction":"dir");let calls=0;
  await expect(withCurrentFilmProviderOutput(linkedRoot,owner,"shot.mp4",async path=>{calls++;return clip(path);})).rejects.toThrow("linked");expect(calls).toBe(0);expect(readdirSync(external)).toEqual([]);
  const root=fixture();let abandoned="";
  await expect(withCurrentFilmProviderOutput(root,owner,"shot.mp4",async path=>{
    const directory=dirname(path);abandoned=directory+"-old";renameSync(directory,abandoned);mkdirSync(directory);return clip(path);
  })).rejects.toThrow("identity");expect(readdirSync(abandoned)).toEqual([]);
});

test("a completed invocation still enforces the unchanged whole-job budget and retains actual costs",async()=>{
  const root=fixture(),construct=workspace.currentFilmWorkspaceGuard;
  const limited=spyOn(workspace,"currentFilmWorkspaceGuard").mockImplementation((path,projectId,jobId)=>construct(path,projectId,jobId,{bytes:EDIT_STORAGE_LIMITS.workspaceBytes,files:4}));
  let result:VideoClip|undefined;
  try{
    await expect(withCurrentFilmProviderOutput(root,owner,"shot.mp4",async path=>{result=clip(path);for(let i=0;i<4;i++)writeFileSync(path+`.orphan-${i}`,"retained");return result;})).rejects.toThrow("capacity");
    expect(result!.cost).toBe(cost);expect(readFileSync(result!.path,"utf8")).toBe("video");expect(readdirSync(dirname(result!.path))).toHaveLength(5);
  }finally{limited.mockRestore();}
});
