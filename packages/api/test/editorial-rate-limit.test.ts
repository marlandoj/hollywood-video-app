import {expect,test} from "bun:test";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {createApiServer,DEFAULT_RATE_LIMITS,type RateLimitOptions} from "../src/server";

const picture=(kind="sequences",stream="a")=>`/api/projects/project/editorial/${kind}/${stream}/preview/window/picture/timeline-picture/0?frame=0`;
const original="/api/projects/project/editorial/sequences/a/sources/original/frames/0";
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-editorial-rate-")||realpathSync(root)!==root)throw new Error("Unsafe rate fixture cleanup.");rmSync(root,{recursive:true,force:true});}
async function fixture<T>(run:(request:(path:string,method?:string)=>Promise<Response>)=>Promise<T>,rateLimit?:Partial<RateLimitOptions>,compositeEnvironment?:string){
  const names=["HV_TOKEN_SECRET","HV_RATE_LIMIT_API_PER_MINUTE","HV_RATE_LIMIT_ARTIFACTS_PER_MINUTE","HV_RATE_LIMIT_COMPOSITE_FRAMES_PER_MINUTE"],previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-editorial-rate-")));for(const name of names)delete process.env[name];process.env.HV_TOKEN_SECRET="editorial-rate-fixture-secret-at-least-thirty-two-characters";
  if(compositeEnvironment!==undefined)process.env.HV_RATE_LIMIT_COMPOSITE_FRAMES_PER_MINUTE=compositeEnvironment;
  const server=createApiServer({port:0,hostname:"127.0.0.1",tls:null,statePath:join(root,"projects.json"),queuePath:join(root,"jobs.json"),costLedgerPath:join(root,"costs.json"),artifactRoot:join(root,"media"),rateLimit});
  try{return await run(async(path,method="GET")=>fetch(new URL(path,server.url),{method}));}
  finally{await server.stop(true);for(const [name,value]of Object.entries(previous))if(value===undefined)delete process.env[name];else process.env[name]=value;cleanup(root);}
}

test("default composed-frame allowance covers sustained comparison request counts and still enforces its shared bound",async()=>{
  expect(DEFAULT_RATE_LIMITS.api.limit).toBe(120);expect(DEFAULT_RATE_LIMITS.artifacts.limit).toBe(600);expect(DEFAULT_RATE_LIMITS.compositeFrames.limit).toBe(8000);
  await fixture(async request=>{
    // Exercise actual HTTP classification without media rendering: GET still requires an owner;
    // OPTIONS represents the cross-origin preflight. This is rate accounting, not an fps benchmark.
    const counts=new Map<number,number>();
    for(let i=0;i<8000;i++){const method=i%2?"OPTIONS":"GET",response=await request(picture(i%4<2?"sequences":"versions",i%4<2?"a":"b"),method);await response.arrayBuffer();if(response.status!==(method==="GET"?401:204))throw new Error("Composed-frame request "+(i+1)+" was unexpectedly limited: "+response.status);counts.set(response.status,(counts.get(response.status)??0)+1);}
    expect(counts).toEqual(new Map([[401,4000],[204,4000]]));const limited=await request(picture());expect(limited.status).toBe(429);expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);await limited.arrayBuffer();
    const editing=await request("/api/unknown"),scrub=await request(original);expect(editing.status).toBe(404);expect(scrub.status).toBe(401);await editing.arrayBuffer();await scrub.arrayBuffer();
  });
},60000);

test("explicit composition limits share GET and preflight capacity while source scrubbing and edit writes keep separate buckets",async()=>{
  await fixture(async request=>{
    const status=async(path:string,method="GET")=>{const response=await request(path,method);await response.arrayBuffer();return response.status;};
    expect(await status(picture())).toBe(401);expect(await status(picture("versions"),"OPTIONS")).toBe(204);expect(await status(picture("versions","other"))).toBe(429);
    expect(await status(original)).toBe(401);expect(await status(original,"OPTIONS")).toBe(204);expect(await status("/api/projects/project/editorial/sequences/a/preview/window/picture/original/0")).toBe(429);expect(await status("/artifacts/project/job/export.mp4")).toBe(429);
    expect(await status("/api/unknown")).toBe(404);expect(await status(original,"POST")).toBe(401);expect(await status("/api/unknown")).toBe(429);
  },{api:{limit:2,windowMs:60000},artifacts:{limit:2,windowMs:60000},compositeFrames:{limit:2,windowMs:60000}});
});

test("the composed-frame environment setting applies without changing artifact or edit defaults",async()=>{
  await fixture(async request=>{
    for(let i=0;i<3;i++){const response=await request(picture());expect(response.status).toBe(401);await response.arrayBuffer();}const limited=await request(picture(),"OPTIONS");expect(limited.status).toBe(429);await limited.arrayBuffer();
    for(const path of [original,"/api/unknown"]){const response=await request(path);expect(response.status).not.toBe(429);await response.arrayBuffer();}
  },undefined,"3");
});

test("screenplay recut packets share ordinary artifact/composite buckets while registration and writes retain API limits",async()=>{
  const prefix="/api/projects/project/editorial/screenplay/proposals/proposal/recut-preview/review",window=prefix+"/preview/session";
  await fixture(async request=>{
    const status=async(path:string,method="GET")=>{const response=await request(path,method);await response.arrayBuffer();return response.status;};
    // Real GETs still require the owner; preflights count against the same media bucket.
    expect(await status(window+"/picture/timeline-picture/0?frame=0")).toBe(401);
    expect(await status(picture(),"OPTIONS")).toBe(204);
    expect(await status("/api/projects/project/editorial/assemblies/accepted/cut/preview/session/picture/timeline-picture/0?frame=0")).toBe(401);
    expect(await status(window+"/picture/timeline-picture/60?frame=60","OPTIONS")).toBe(429);
    expect(await status(window+"/picture/original/0")).toBe(401);
    expect(await status(window+"/audio/0","OPTIONS")).toBe(204);
    expect(await status("/api/projects/project/editorial/sequences/cut/preview/session/audio/0")).toBe(401);
    expect(await status("/api/projects/project/editorial/assemblies/proposals/cut/preview/session/picture/original/0","OPTIONS")).toBe(204);
    expect(await status(window+"/audio/60")).toBe(429);
    expect(await status(prefix)).toBe(401);
    expect(await status(window+"/picture/timeline-picture/0","POST")).toBe(401);
    expect(await status(prefix+"/preview","OPTIONS")).toBe(204);
    expect(await status(prefix,"OPTIONS")).toBe(429);
  },{api:{limit:3,windowMs:60000},artifacts:{limit:4,windowMs:60000},compositeFrames:{limit:3,windowMs:60000}});
});

test("recut lookalike paths and non-read methods cannot borrow a media rate allowance",async()=>{
  const prefix="/api/projects/project/editorial/screenplay/proposals/proposal/recut-preview/review",window=prefix+"/preview/session",malformed=[
    window+"/picture/timeline-picture",window+"/picture/timeline-picture/0/extra",window+"/audio",window+"/audio/0/extra",
    window.replace("/recut-preview/","/recut/")+"/picture/timeline-picture/0",
    window.replace("/screenplay/","/scripts/")+"/audio/0",
    window.replace("/proposals/","/accepted/")+"/picture/timeline-picture/0",
    window.replace("/preview/session","/frames/session")+"/audio/0",
  ];
  await fixture(async request=>{
    const status=async(path:string,method="OPTIONS")=>{const response=await request(path,method);await response.arrayBuffer();return response.status;};
    expect(await status(window+"/picture/timeline-picture/0")).toBe(204);expect(await status(window+"/audio/0")).toBe(204);
    for(const path of malformed)expect(await status(path)).toBe(204);
    expect(await status(window+"/picture/timeline-picture/0","DELETE")).toBe(401);
    expect(await status(window+"/audio/0","POST")).toBe(401);
    expect(await status("/api/unknown")).toBe(429);
    expect(await status(window+"/picture/timeline-picture/0")).toBe(429);expect(await status(window+"/audio/0")).toBe(429);
  },{api:{limit:malformed.length+2,windowMs:60000},artifacts:{limit:1,windowMs:60000},compositeFrames:{limit:1,windowMs:60000}});
});
