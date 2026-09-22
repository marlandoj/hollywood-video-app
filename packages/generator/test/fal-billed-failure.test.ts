/**
 * HV-019-09 — a render fal had already billed reported no cost at all.
 *
 * Everything after the queue reports `COMPLETED` runs on a clip fal has rendered and charged for.
 * The adapter attached that cost to a local failure only when the model was `anchored` — one model
 * of four — so for `DEFAULT_FAL_MODEL` and two others a failed download, an unreadable result or a
 * failed normalize threw bare: `sunkCostsOf` found nothing, `FailoverGenerator.attempt` had nothing
 * to hand `onAttemptCost`, and the job's cost, the cost events and the month's spend were all short
 * by the price of that render. The router then tried the next candidate and the worker requeued —
 * up to three billed renders of one shot, none of them recorded.
 *
 * No network and no money: the fal endpoint is stubbed, and it is stubbed to say the render
 * finished, which is the only case this file is about.
 */
import {expect,test,afterAll} from "bun:test";
import {existsSync,mkdtempSync,readFileSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FalVideoProvider} from "../src/fal";
import {DeterministicMockProvider,FailoverGenerator,sunkCostsOf,type CostRecord,type GenParams} from "../src/index";

const roots:string[]=[];
afterAll(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true});});
const scratch=()=>{const root=mkdtempSync(join(tmpdir(),"hv-fal-billed-"));roots.push(root);return root;};

/** A fal that renders, bills, and hands back a clip. What the clip *is* is the test's choice. */
function stub(options:{clipUrl?:string;clip?:ArrayBuffer;contentLength?:string}={}):typeof fetch{
  const body=options.clip??new Uint8Array([1,2,3,4,5,6,7,8]).buffer;
  return (async(input:unknown,init?:{method?:string})=>{
    const url=String(typeof input==="string"?input:(input as {url?:string}).url??input);
    if(init?.method==="POST")return new Response(JSON.stringify({request_id:"req_abc123"}),{status:200,headers:{"content-type":"application/json"}});
    if(url.endsWith("/status"))return new Response(JSON.stringify({status:"COMPLETED"}),{status:200,headers:{"content-type":"application/json"}});
    if(url.endsWith("/requests/req_abc123"))
      return new Response(JSON.stringify({video:{url:options.clipUrl??"https://v3.fal.media/files/clip.mp4"}}),{status:200,headers:{"content-type":"application/json"}});
    return new Response(body,{status:200,...(options.contentLength?{headers:{"content-length":options.contentLength}}:{})});
  }) as unknown as typeof fetch;
}
const params=(over:Partial<GenParams>={}):GenParams=>({widthxheight:"1920x1080",fps:30,durationSec:5,...over} as GenParams);
const provider=(model:string,fetchImpl:typeof fetch)=>new FalVideoProvider({apiKey:"stub-key-not-a-real-one",model,fetchImpl,pollMs:1});
const caught=async(work:()=>Promise<unknown>)=>{try{await work();return undefined;}catch(error){return error;}};

test("a model that reaches the vendor carries what the vendor billed when the local half fails",async()=>{
  const root=scratch();
  // `kling-v2.5-turbo-pro` is DEFAULT_FAL_MODEL. Before this increment both of these threw bare,
  // and only `kling-o3-standard-keyframes` -- the one anchored model -- carried its cost.
  for(const model of ["kling-v2.5-turbo-pro","veo3-fast"]){
    const error=await caught(()=>provider(model,stub()).generate("a shot",1,params(),join(root,model,"shot.mp4")));
    expect({model,message:(error as Error).message}).toMatchObject({model,message:expect.stringContaining("normalize failed")});
    const costs=sunkCostsOf(error);
    expect({model,records:costs.length}).toEqual({model,records:1});
    expect({model,spent:costs[0]!.total_cost_usd>0}).toEqual({model,spent:true});
    expect(costs[0]!).toMatchObject({provider:"fal",output_frames:150});
  }
});

test("and a model that refuses before it reaches the vendor still charges nothing",async()=>{
  const root=scratch();
  // The other half of the same rule. These two refuse the request rather than sending it -- one
  // wants reference images, one wants frame anchors -- so there is nothing to charge, and a fix
  // that attached a cost to every failure here would invent spending that never happened.
  for(const model of ["kling-o3-standard-reference","kling-o3-standard-keyframes"]){
    const error=await caught(()=>provider(model,stub()).generate("a shot",1,params(),join(root,model,"shot.mp4")));
    expect({model,message:(error as Error).message}).toMatchObject({model,message:expect.stringContaining("requires")});
    expect({model,records:sunkCostsOf(error).length}).toEqual({model,records:0});
  }
});

test("and the accounted path the worker uses is handed it, which is the point",async()=>{
  const root=scratch();
  const charged:CostRecord[]=[];
  const failing=provider("kling-v2.5-turbo-pro",stub());
  const failover=new FailoverGenerator(failing,new DeterministicMockProvider(),30_000);
  // `generateAttempt` is the single accounting path: it drains every cost through `onAttemptCost`,
  // which is `chargeCost` in the worker, before it reports the failure.
  await caught(()=>failover.generateAttempt(failing,"a shot",1,
    params({onAttemptCost:async(cost:CostRecord)=>{charged.push(cost);}}),join(root,"clips","shot.mp4")));
  expect(charged).toHaveLength(1);
  expect(charged[0]!.total_cost_usd).toBeGreaterThan(0);
  expect(charged[0]!.model).toContain("kling");
});

test("a clip url the vendor names is still only fetched from where a fal clip lives",async()=>{
  const root=scratch();
  for(const url of ["http://127.0.0.1:8080/internal/secret.mp4","https://example.invalid/clip.mp4",
    "https://v3.fal.media:8443/files/clip.mp4","https://notfal.media.example.com/clip.mp4","not a url at all"]){
    const error=await caught(()=>provider("kling-v2.5-turbo-pro",stub({clipUrl:url})).generate("a shot",1,params(),join(root,"a","shot.mp4")));
    expect({url,message:(error as Error).message}).toMatchObject({url,message:expect.stringContaining("url")});
    // Refused before anything was written, and the billed cost still travels with the refusal.
    expect({url,wrote:existsSync(join(root,"a","shot.mp4.raw.mp4"))}).toEqual({url,wrote:false});
    expect(sunkCostsOf(error)).toHaveLength(1);
  }
  // A real fal host is still accepted: it gets as far as the clip, which is undecodable here.
  const accepted=await caught(()=>provider("kling-v2.5-turbo-pro",stub({clipUrl:"https://fal.media/files/clip.mp4"}))
    .generate("a shot",1,params(),join(root,"b","shot.mp4")));
  expect((accepted as Error).message).toContain("normalize failed");
});

test("and a clip larger than any clip is refused rather than written to the artifact disk",async()=>{
  const root=scratch();
  // Declared: refused before a byte is read.
  const declared=await caught(()=>provider("kling-v2.5-turbo-pro",stub({contentLength:String(512*1024**2)}))
    .generate("a shot",1,params(),join(root,"declared","shot.mp4")));
  expect((declared as Error).message).toContain("size limit");
  expect(existsSync(join(root,"declared","shot.mp4.raw.mp4"))).toBe(false);
  // Undeclared: refused while streaming, and what it managed to write is bounded rather than the
  // whole of whatever the host wanted to send.
  const huge=new ArrayBuffer(300*1024**2);
  const streamed=await caught(()=>provider("kling-v2.5-turbo-pro",stub({clip:huge}))
    .generate("a shot",1,params(),join(root,"streamed","shot.mp4")));
  expect((streamed as Error).message).toContain("size limit");
  const written=join(root,"streamed","shot.mp4.raw.mp4");
  if(existsSync(written))expect(statSync(written).size).toBeLessThanOrEqual(257*1024**2);
},120_000);

test("no synchronous ffmpeg in this package runs without a bound on how long it can hold the worker",()=>{
  // `Bun.spawnSync` blocks the loop, so a call without a timeout is a worker that cannot heartbeat,
  // cannot be cancelled and has no upper bound -- measured at zero heartbeat ticks in 2.1 s on a
  // six-second clip, with a cancel scheduled 100 ms in never delivered. Asserted over the source
  // because exhibiting the unbounded case means waiting for it.
  for(const file of ["../src/fal.ts","../src/index.ts","../src/sound-audio.ts","../src/audio-timeline.ts","../src/graphic-render.ts"]){
    const source=readFileSync(new URL(file,import.meta.url),"utf8");
    const calls=[...source.matchAll(/Bun\.spawnSync\(/g)];
    for(const call of calls){
      // The options bag is the balanced `{ … }` that closes the call; reading to the next `);` is
      // enough here because none of these commands contains one.
      const options=source.slice(call.index!,source.indexOf(");",call.index!));
      expect({file,bounded:/timeout:\s*[A-Z_0-9]/.test(options)}).toEqual({file,bounded:true});
    }
  }
});
