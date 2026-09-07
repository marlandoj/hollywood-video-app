import {expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {EditPreviewPageCache} from "../src/edit-preview-cache";
import {contentHash} from "../src/capabilities";
import {decodePreviewPage,encodePreviewPage,previewDigest,type PreviewPageIdentity} from "../../planner/src/edit-preview-protocol";
type Source=Parameters<EditPreviewPageCache["read"]>[0];
const access=async()=>{};
function gate(){let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),open:()=>resolve()};}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw new Error("Preview test did not reach the expected state.");await Bun.sleep(2);}}
function fixture(hook?:(from:number,access:()=>Promise<void>,signal:AbortSignal)=>Promise<void>){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-preview-cache-"))),paths:string[]=[],calls:number[]=[];
  const identity=(from:number):PreviewPageIdentity=>({sourceKey:contentHash("cache-source"),sourceId:"source",sourceRevision:contentHash("revision"),engineVersion:"ffmpeg-sound-"+contentHash("engine"),sourceFrames:180,from,frames:60,width:16,height:16,includePicture:false,audioLanes:["mix"]});
  const source:Source={sourceKey:identity(0).sourceKey,identity,page:async(from,path,permission,signal)=>{
    calls.push(from);await permission();signal!.throwIfAborted();mkdirSync(path);paths.push(path);await hook?.(from,permission,signal!);signal!.throwIfAborted();
    const packet=await encodePreviewPage(identity(from),[],[{lane:"mix",data:new Uint8Array(60*1600*6).fill(from)}]);await permission();signal!.throwIfAborted();writeFileSync(join(path,"page.hvp"),packet,{flag:"wx"});
    return {identity:identity(from),file:{path:join(path,"page.hvp").slice(root.length+1).split(sep).join("/"),bytes:packet.length,sha256:await previewDigest(packet)}};
  }};
  return {root,source,paths,calls,close:()=>{if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe preview cache fixture cleanup.");rmSync(root,{recursive:true,force:true});}};
}
test("preview cache authenticates hits, preserves copy isolation, evicts least recently used pages and rebuilds corrupt entries",async()=>{
  const f=fixture(),cache=new EditPreviewPageCache(f.root,{pages:2});try{
    const first=await cache.read(f.source,0,access);expect((await decodePreviewPage(first.bytes,{sourceKey:f.source.sourceKey,from:0,sha256:first.sha256})).header.from).toBe(0);
    first.bytes[0]^=1;first.identity.audioLanes.length=0;const hit=await cache.read(f.source,0,access);expect(hit.bytes[0]).not.toBe(first.bytes[0]);expect(hit.identity.audioLanes).toEqual(["mix"]);expect(f.calls).toEqual([0]);
    await cache.read(f.source,60,access);await cache.read(f.source,0,access);await cache.read(f.source,120,access);expect(cache.stats.pages).toBe(2);expect(existsSync(f.paths[0]!)).toBe(true);expect(existsSync(f.paths[1]!)).toBe(false);
    await cache.read(f.source,60,access);expect(f.calls).toEqual([0,60,120,60]);expect(cache.stats.bytes).toBeLessThan(2*1024**2);
    for(const mode of ["checksum","length","missing"]){const path=join(f.paths.at(-1)!,"page.hvp"),bytes=readFileSync(path);if(mode==="checksum"){bytes[100]^=1;writeFileSync(path,bytes);}else if(mode==="length")writeFileSync(path,bytes.subarray(1));else rmSync(path);
      await expect(cache.read(f.source,60,access)).rejects.toThrow("cached preview page changed");expect(existsSync(f.paths.at(-1)!)).toBe(false);await cache.read(f.source,60,access);
    }
  }finally{await cache.close();expect(readdirSync(f.root)).toEqual([]);f.close();}
});

test("ready pages release their renderer while authenticated cache hits remain usable",async()=>{
  const f=fixture(),cache=new EditPreviewPageCache(f.root);
  async function prepare(){const renderer={...f.source},reference=new WeakRef(renderer);await cache.read(renderer,0,access);return reference;}
  try{
    const reference=await prepare();
    // Cross job boundaries before collecting: deref keeps its target alive until the current job ends.
    for(let i=0;i<20;i++){await Bun.sleep(5);Bun.gc(true);if(!reference.deref())break;}
    expect(reference.deref()).toBeUndefined();expect(cache.stats.pages).toBe(1);
    let checks=0;const hit=await cache.read(f.source,0,async()=>{checks++;});
    expect(checks).toBeGreaterThan(1);expect(hit.identity.from).toBe(0);expect(f.calls).toEqual([0]);
    await expect(cache.read(f.source,0,async()=>{throw new Error("permission withdrawn");})).rejects.toThrow("permission withdrawn");
  }finally{await cache.close();f.close();}
});
test("shared preview work survives one cancellation and withdraws permission independently, including warm hits",async()=>{
  const block=gate(),f=fixture(async(_from,permission)=>{await block.promise;await permission();}),cache=new EditPreviewPageCache(f.root);try{
    const abort=new AbortController();let revoked=false;const check=async()=>{if(revoked)throw new Error("permission withdrawn");};
    const one=cache.read(f.source,0,access,abort.signal),two=cache.read(f.source,0,check),three=cache.read(f.source,0,access);const results=Promise.allSettled([one,two,three]);await until(()=>f.paths.length===1);abort.abort(new Error("caller cancelled"));revoked=true;block.open();
    const [a,b,c]=await results;expect(a.status).toBe("rejected");expect(b.status).toBe("rejected");if(b.status==="rejected")expect(b.reason.message).toBe("permission withdrawn");expect(c.status).toBe("fulfilled");expect(f.calls).toEqual([0]);expect(cache.stats.readers).toBe(0);
    await expect(cache.read(f.source,0,check)).rejects.toThrow("permission withdrawn");expect(f.calls).toEqual([0]);expect((await cache.read(f.source,0,access)).identity.from).toBe(0);
  }finally{block.open();await cache.close();expect(readdirSync(f.root)).toEqual([]);f.close();}
});
test("all cancelled consumers stop producers and queued cancellation cannot accumulate work beyond capacity",async()=>{
  const f=fixture(async(_from,_permission,signal)=>{await new Promise<void>((_resolve,reject)=>{signal.addEventListener("abort",()=>reject(signal.reason),{once:true});});}),cache=new EditPreviewPageCache(f.root,{concurrency:1,pending:2});try{
    const running=new AbortController(),first=cache.read(f.source,0,access,running.signal);void first.catch(()=>{});await until(()=>f.paths.length===1);
    for(let i=0;i<50;i++){const queued=new AbortController(),next=cache.read(f.source,60,access,queued.signal);void next.catch(()=>{});await until(()=>cache.stats.queued===1);expect(cache.stats.pending).toBe(2);await expect(cache.read(f.source,120,access)).rejects.toThrow("capacity is full");queued.abort();await expect(next).rejects.toThrow();expect(cache.stats.queued).toBe(0);}
    expect(f.calls).toEqual([0]);running.abort();await expect(first).rejects.toThrow();await until(()=>cache.stats.running===0);expect(cache.stats.pending).toBe(0);expect(f.paths.every(p=>!existsSync(p))).toBe(true);
  }finally{await cache.close();expect(readdirSync(f.root)).toEqual([]);f.close();}
});
test("preview deadlines and close release hung access, bounded readers, running work and queued work",async()=>{
  const f=fixture(async(_from,_permission,signal)=>{await new Promise<void>((_resolve,reject)=>{signal.addEventListener("abort",()=>reject(signal.reason),{once:true});});});
  const cache=new EditPreviewPageCache(f.root,{deadlineMs:100,readers:2,concurrency:1});try{
    const first=cache.read(f.source,0,access),second=cache.read(f.source,60,access),settled=Promise.allSettled([first,second]);await until(()=>cache.stats.pending===2);await expect(cache.read(f.source,120,access)).rejects.toThrow("reader capacity");expect((await settled).every(r=>r.status==="rejected")).toBe(true);await until(()=>cache.stats.running===0);expect(cache.stats).toMatchObject({queued:0,pending:0,readers:0});
    const blocked=cache.read(f.source,0,()=>new Promise<void>(()=>{}));void blocked.catch(()=>{});await until(()=>cache.stats.readers===1);await cache.close();await expect(blocked).rejects.toThrow("stopped");expect(cache.stats.readers).toBe(0);await expect(cache.read(f.source,0,access)).rejects.toThrow("stopped");
  }finally{await cache.close();expect(readdirSync(f.root)).toEqual([]);f.close();}
});
test("preview preparation errors keep their cause and close waits until the producer stops before cleanup",async()=>{
  const stopping=gate(),started=gate(),f=fixture(async(_from,_permission,signal)=>{started.open();await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));await stopping.promise;}),cache=new EditPreviewPageCache(f.root);try{
    const read=cache.read(f.source,0,access);void read.catch(()=>{});await started.promise;let closed=false;const closing=cache.close().then(()=>{closed=true;});await expect(read).rejects.toThrow("stopped");expect(closed).toBe(false);expect(existsSync(f.paths[0]!)).toBe(true);stopping.open();await closing;expect(existsSync(f.paths[0]!)).toBe(false);
  }finally{stopping.open();await cache.close();f.close();}
  const broken=fixture(async()=>{throw new Error("original frames changed");}),other=new EditPreviewPageCache(broken.root);try{await expect(other.read(broken.source,0,access)).rejects.toThrow("original frames changed");await until(()=>other.stats.running===0);expect(broken.paths.every(p=>!existsSync(p))).toBe(true);}finally{await other.close();broken.close();}
});
