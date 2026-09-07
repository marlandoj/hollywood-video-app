import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync,statfsSync,symlinkSync} from "node:fs";
import {join,sep} from "node:path";
import {tmpdir} from "node:os";
import {assertEditFreeSpaceAsync,EditWorkspaceCheck,scanEditWorkspace} from "../src/edit-workspace-async";
function gate(){let open!:()=>void;const promise=new Promise<void>(resolve=>{open=resolve;});return {promise,open};}
function fixture(){const parent=realpathSync(tmpdir()),root=realpathSync(mkdtempSync(join(parent,"hv-edit-async-"))),owned=join(root,"owned");mkdirSync(owned);return {root,owned,close(){if(!root.startsWith(parent+sep+"hv-edit-async-")||realpathSync(root)!==root)throw new Error("Unsafe workspace fixture cleanup");rmSync(root,{recursive:true,force:true});}};}

test("asynchronous workspace scans enforce actual capacity, free reserve and canonical ownership",async()=>{
  const f=fixture(),other=fixture(),signal=new AbortController().signal,scan=(bytes=64,files=2,paths=[f.owned])=>scanEditWorkspace(f.root,paths,{bytes,files},signal);
  try{
    writeFileSync(join(f.owned,"first"),Buffer.alloc(32));writeFileSync(join(f.owned,"second"),Buffer.alloc(32));
    await scan();await scan(64,2,[f.owned,join(f.owned,"first"),join(f.root,"removed")]);
    await expect(scan(63)).rejects.toThrow("workspace capacity");await expect(scan(64,1)).rejects.toThrow("workspace capacity");await expect(scan(64,2,[other.owned])).rejects.toThrow("escaped its owner");
    const disk=statfsSync(f.root,{bigint:true});await expect(assertEditFreeSpaceAsync(f.root,Number(disk.bavail*disk.bsize)+1)).rejects.toThrow("free workspace");
    for(const target of [other.owned,f.owned]){mkdirSync(join(target,"nested"));const alias=join(f.owned,"alias");symlinkSync(target,alias,"junction");try{await expect(scan()).rejects.toThrow("escaped its owner");await expect(scan(64,2,[join(alias,"nested")])).rejects.toThrow("escaped its owner");}finally{rmSync(alias,{recursive:true,force:true});}}
  }finally{f.close();other.close();}
});

test("a full workspace traversal lets the event loop run and tolerates files removed by cache eviction",async()=>{
  const f=fixture(),controller=new AbortController();
  try{
    for(let i=0;i<128;i++){const path=join(f.owned,String(i));mkdirSync(path);writeFileSync(join(path,"page"),Buffer.alloc(8));}
    let yielded=false;const scan=scanEditWorkspace(f.root,[f.owned],{bytes:1024,files:128},controller.signal);
    setTimeout(()=>{yielded=true;rmSync(join(f.owned,"64"),{recursive:true,force:true});},0);
    await scan;expect(yielded).toBe(true);
    const cancelled=scanEditWorkspace(f.root,[f.owned],{bytes:1024,files:128},controller.signal);controller.abort(new Error("cancelled scan"));await expect(cancelled).rejects.toThrow("cancelled scan");
  }finally{f.close();}
});

test("workspace checks share in-flight scans and retain failures until the next successful full check",async()=>{
  let now=0,calls=0,failure=false;const block=gate(),check=new EditWorkspaceCheck(async()=>{calls++;await block.promise;if(failure)throw new Error("workspace changed");},()=>now);
  try{
    const reads=Array.from({length:16},()=>check.check());await Bun.sleep(0);expect(calls).toBe(1);
    now=5000;const late=check.check();block.open();await Promise.all([...reads,late]);expect(calls).toBe(1);
    await check.check();expect(calls).toBe(2);now=5500;await check.check();expect(calls).toBe(2);
    now=6000;failure=true;await expect(check.check()).rejects.toThrow("workspace changed");expect(calls).toBe(3);
    failure=false;await expect(check.check()).rejects.toThrow("workspace changed");expect(calls).toBe(3);
    now=7000;await check.check();expect(calls).toBe(4);now=1;await check.check();expect(calls).toBe(5);
  }finally{block.open();check.close();}
});

test("caller cancellation leaves a shared scan alive, while close releases waiters and prevents more I/O",async()=>{
  let calls=0,continued=false;const block=gate(),started=gate(),cancelled=new AbortController(),check=new EditWorkspaceCheck(async signal=>{calls++;started.open();await block.promise;signal.throwIfAborted();continued=true;});
  try{
    const one=check.check(cancelled.signal),two=check.check();void one.catch(()=>{});void two.catch(()=>{});await started.promise;cancelled.abort(new Error("caller left"));await expect(one).rejects.toThrow("caller left");
    let otherFinished=false;void two.finally(()=>{otherFinished=true;}).catch(()=>{});await Bun.sleep(0);expect(otherFinished).toBe(false);expect(calls).toBe(1);
    check.close();await expect(two).rejects.toThrow("checking stopped");await expect(check.check()).rejects.toThrow("checking stopped");block.open();await Bun.sleep(0);expect(continued).toBe(false);expect(calls).toBe(1);
  }finally{block.open();check.close();}
});
