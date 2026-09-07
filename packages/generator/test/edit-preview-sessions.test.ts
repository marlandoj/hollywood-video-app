import {afterAll,beforeAll,expect,test} from "bun:test";
import {existsSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../src/edit-source-media";
import {EditPreviewSessions,type PreviewSessionIdentity} from "../src/edit-preview-sessions";
import {bindOriginalEditSource,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {EditConflict} from "../../planner/src/edit-timeline";
import {contentHash} from "../src/capabilities";
let f:Awaited<ReturnType<typeof dubStudio>>,binding:EditSourceBinding;
const access=async()=>{};
function identity():PreviewSessionIdentity{return {id:crypto.randomUUID(),projectId:f.owner.projectId,sequenceId:"opening",historyRevision:contentHash("history")};}
function gate(){let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),open:()=>resolve()};}
async function until(check:()=>boolean,timeout=3000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw new Error("Preview session test did not reach its expected state.");await Bun.sleep(5);}}
async function ready(pool:EditPreviewSessions,id:PreviewSessionIdentity){const end=Date.now()+60000;while(Date.now()<end){const state=await pool.status(id);if(state.state==="failed")throw new Error(state.error);if(state.state==="ready")return state;await Bun.sleep(20);}throw new Error("Preview session did not become ready.");}
beforeAll(async()=>{f=await dubStudio();binding=bindOriginalEditSource(await inspectEditSource(f.film,"Retained preview original",f.paths.artifactRoot,access));},120000);
afterAll(async()=>{if(f){await f.close(false);const root=realpathSync(f.root);if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-dub-studio-"))throw new Error("Unsafe session fixture cleanup.");rmSync(root,{recursive:true,force:true});}});

test("owner preview sessions share real originals, retain independent permission, enforce identities and reuse ready media",async()=>{
  const pool=new EditPreviewSessions(f.paths.artifactRoot),one=identity(),two=identity();let revoked=false,checks=0;const check=async()=>{checks++;if(revoked)throw new EditConflict("Original permission withdrawn.");};try{
    const started=await pool.start(one,[binding],check);expect(started.state).toBe("preparing");expect(started.sources[0]!.sourceKey).toBeNull();expect(JSON.stringify(started)).not.toContain("original/");
    expect((await pool.start(one,[binding],check)).id).toBe(one.id);expect(pool.stats.sources).toBe(1);await pool.start(two,[binding],access);expect(pool.stats.sources).toBe(1);expect(pool.stats.running).toBeLessThanOrEqual(1);
    await expect(pool.start({...one,historyRevision:contentHash("different")},[binding],access)).rejects.toThrow("another saved cut");await expect(pool.status({...two,projectId:crypto.randomUUID()})).rejects.toThrow("another saved cut");
    const state=await ready(pool,two);expect(state.completedSources).toBe(1);expect(state.sources[0]!.sourceKey).toHaveLength(64);const key=state.sources[0]!.sourceKey;
    const pcm=await pool.withSources(two,async([source],permission,signal)=>source!.audioPage(0,"mix",permission,signal));expect(pcm.length).toBe(Math.min(60,binding.source.facts.frames)*1600*6);
    await pool.withSources(one,async(_sources,permission)=>{const before=checks;for(let i=0;i<20;i++)await permission();expect(checks-before).toBe(20);});
    revoked=true;expect((await pool.status(one)).error).toBe("Original permission withdrawn.");expect((await pool.status(two)).state).toBe("ready");await expect(pool.withSources(one,async()=>true)).rejects.toThrow("withdrawn");
    pool.release(one);pool.release(two);const next=identity();expect((await pool.start(next,[binding],access)).sources[0]!.sourceKey).toBe(key);expect(pool.stats.running).toBe(0);pool.release(next);
    await expect(pool.start({...identity(),projectId:crypto.randomUUID()},[binding],access)).rejects.toThrow("owned by this project");await expect(pool.start(identity(),[{...binding,revision:"0".repeat(64)}],access)).rejects.toThrow();
  }finally{await pool.close();expect(pool.stats).toMatchObject({closed:true,sessions:0,sources:0,running:0});}
},120000);
test("an abandoned session stops a retained-media reader, while preparation deadlines remain visible failures",async()=>{
  for(const deadline of [false,true]){let reading=false,aborted=false;const reader={async response(_project:string,_job:string,_key:string,request?:Request):Promise<Response>{reading=true;return new Promise((_resolve,reject)=>{const abort=()=>{aborted=true;reject(request!.signal.reason);};request!.signal.addEventListener("abort",abort,{once:true});if(request!.signal.aborted)abort();});}},pool=new EditPreviewSessions(f.paths.artifactRoot,reader,{leaseMs:deadline?10000:200,deadlineMs:deadline?150:10000}),id=identity();
    try{await pool.start(id,[binding],access);await until(()=>reading);await until(()=>pool.stats.running===0);expect(aborted).toBe(true);expect(pool.stats.sources).toBe(0);if(deadline){const state=await pool.status(id);expect(state.state).toBe("failed");expect(state.error).toContain("timed out");}else await expect(pool.status(id)).rejects.toThrow("expired");}finally{await pool.close();}
  }
});
test("cancelled status polling does not cancel a prepared session, and close drains readers before removing source files",async()=>{
  const pool=new EditPreviewSessions(f.paths.artifactRoot),id=identity(),waiting=gate(),stopping=gate();let hold=false,checking=false;const check=async()=>{if(hold){checking=true;await waiting.promise;}};
  try{await pool.start(id,[binding],check);await ready(pool,id);const abort=new AbortController();hold=true;const status=pool.status(id,abort.signal);void status.catch(()=>{});await until(()=>checking);abort.abort();await expect(status).rejects.toThrow();hold=false;waiting.open();expect((await pool.status(id)).state).toBe("ready");
    const directory=readdirSync(f.paths.artifactRoot).filter(n=>n.startsWith(".edit-preview-sources-"));expect(directory).toHaveLength(1);const started=gate();
    const read=pool.withSources(id,async(_sources,_permission,signal)=>{started.open();await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));await stopping.promise;return true;});void read.catch(()=>{});await started.promise;let closed=false;const closing=pool.close().then(()=>{closed=true;});await Bun.sleep(10);expect(closed).toBe(false);expect(existsSync(join(f.paths.artifactRoot,directory[0]!))).toBe(true);stopping.open();await expect(read).rejects.toThrow();await closing;expect(existsSync(join(f.paths.artifactRoot,directory[0]!))).toBe(false);
  }finally{hold=false;waiting.open();stopping.open();await pool.close();}
},120000);
test("empty gap sessions need no media, expire and stay within session capacity",async()=>{
  const pool=new EditPreviewSessions(f.paths.artifactRoot,undefined,{sessions:1,perProject:1,leaseMs:500}),id=identity();try{expect((await pool.start(id,[],access)).state).toBe("ready");expect(pool.stats.sources).toBe(0);await expect(pool.start(identity(),[],access)).rejects.toThrow("capacity");expect(await pool.withSources(id,async sources=>sources.length)).toBe(0);await until(()=>pool.stats.sessions===0);await expect(pool.status(id)).rejects.toThrow("expired");expect((await pool.start(identity(),[],access)).state).toBe("ready");}finally{await pool.close();}
});
test("comparison windows share project/global capacity and concurrent request scopes cannot be interchanged",async()=>{
  const pool=new EditPreviewSessions(f.paths.artifactRoot),base=identity(),a={...base,scopeRevision:contentHash("version-A-window")},b={...base,scopeRevision:contentHash("sequence-window")};
  try{
    const results=await Promise.allSettled([pool.start(a,[],access),pool.start(b,[],access)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
    const winner=results[0]!.status==="fulfilled"?a:b,loser=winner===a?b:a;
    await expect(pool.status(loser)).rejects.toThrow("another saved cut");expect(()=>pool.release(loser)).toThrow("another saved cut");await expect(pool.status(base)).rejects.toThrow("another saved cut");expect((await pool.status(winner)).state).toBe("ready");
    for(let i=0;i<3;i++)await pool.start({...identity(),scopeRevision:contentHash(i)},[],access);
    expect(pool.stats.sessions).toBe(4);await expect(pool.start(identity(),[],access)).rejects.toThrow("capacity");
    for(let i=0;i<4;i++)await pool.start({...identity(),projectId:"second-project"},[],access);
    expect(pool.stats.sessions).toBe(8);await expect(pool.start({...identity(),projectId:"third-project"},[],access)).rejects.toThrow("capacity");
    pool.release(winner);expect(pool.stats.sessions).toBe(7);await pool.start(identity(),[],access);expect(pool.stats.sessions).toBe(8);
  }finally{await pool.close();expect(pool.stats.sessions).toBe(0);}
});
