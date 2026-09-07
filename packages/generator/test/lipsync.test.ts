import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {createLipSyncFixture,LIPSYNC_POLICY,lipFixtureJob} from "../../../test/fixtures/lipsync";
import {SyncLipSyncProvider,assertLipSyncObservation,lipSyncRequest,type LipSyncJournal,type LipSyncReceipt} from "../src/sync-lipsync";
import {renderLipSyncVersion,verifyLipSyncMedia,verifyLipSyncPrepared,previewLipSyncFrame,lipCommand} from "../src/lipsync-media";
import {addLipSyncReview,assertLipSyncPermission,createLipSyncPlan,retainLipSyncSource,validateLipSyncPlan,validateLipSyncOutput} from "../../planner/src/lipsync";
import {lipSyncPolicy} from "../../planner/src/lipsync-policy";
import {contentHash} from "../src/capabilities";

const root=mkdtempSync(join(tmpdir(),"hv-lipsync-fixture-")),keys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE"],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
let f:Awaited<ReturnType<typeof createLipSyncFixture>>;
beforeAll(async()=>{Object.assign(process.env,{HV_TOKEN_SECRET:"lipsync-fixture-secret-at-least-thirty-two-characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});f=await createLipSyncFixture(root);process.env.HV_AUDIO_POLICY_FILE=join(root,"audio-policy.json");},60000);
afterAll(()=>{for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}if(!resolve(root).startsWith(resolve(tmpdir())+sep+"hv-lipsync-fixture-"))throw new Error("Unexpected fixture path");rmSync(root,{recursive:true,force:true});});
const media=()=>({video:readFileSync(join(f.artifacts,f.prepared.video.path)),audio:readFileSync(join(f.artifacts,f.prepared.audio.path))});
function journal(options:{failObserved?:boolean;deny?:()=>boolean}={}){
  const records:LipSyncReceipt[]=[];let authorized=0;
  const journal:LipSyncJournal={async authorize(){authorized++;return {id:f.job.id,heldUsd:LIPSYNC_POLICY.heldUsd,priceRevision:LIPSYNC_POLICY.priceRevision};},async assertCurrent(){if(options.deny?.())throw new Error("permission changed");},async observe(receipt){if(options.failObserved)throw new Error("journal unavailable");assertLipSyncObservation(records.at(-1),receipt);records.push(structuredClone(receipt));}};
  return {journal,records,get authorized(){return authorized;}};
}
test("lip-sync source compilation binds native face coordinates, original voice evidence and owner assessments",()=>{
  expect(validateLipSyncPlan(f.plan)).toEqual(f.plan);expect(()=>assertLipSyncPermission(f.plan,f.project)).not.toThrow();
  const forged=structuredClone(f.plan);forged.selection.x++;expect(()=>validateLipSyncPlan(forged)).toThrow("changed");
  expect(()=>createLipSyncPlan(f.plan.source,f.plan.shotId,0,{...f.plan.selection,x:f.plan.selection.width},LIPSYNC_POLICY,"local",f.plan.requestHash)).toThrow("Face position");
  expect(()=>createLipSyncPlan(f.plan.source,f.plan.shotId,1,f.plan.selection,LIPSYNC_POLICY,"local",f.plan.requestHash)).toThrow("retained voice");
  const {schema:_s,provider:_p,model:_m,apiVersion:_a,capabilityRevision:_c,permissionRevision:_r,priceRevision:_v,revision:_h,...policy}=LIPSYNC_POLICY;
  expect(()=>lipSyncPolicy({...policy,outputHosts:["localhost"]})).toThrow("public");expect(()=>createLipSyncPlan(f.plan.source,f.plan.shotId,0,f.plan.selection,lipSyncPolicy({...policy,maxFrames:1}),"local",f.plan.requestHash)).toThrow("duration");
  const revoked=structuredClone(f.project);revoked.castingHistory!.at(-1)!.characters[0]!.permission.status="revoked";expect(()=>assertLipSyncPermission(f.plan,revoked)).toThrow();
});
test("closed multipart submission is made once; fresh workers resume the original remote generation and retain its waveform",async()=>{
  let submissions=0,observations=0;const sourceMedia=media(),requests:{method:string;path:string}[]=[],remote={id:"fixture-generation",createdAt:"2026-09-07T00:00:00Z",model:"sync-3"};
  const altered=join(root,"altered.mp4");await lipCommand(["ffmpeg","-v","error","-f","lavfi","-i",`color=c=magenta:s=${f.plan.selection.width}x${f.plan.selection.height}:r=30`,"-frames:v",String(f.plan.window.frames),"-c:v","libx264","-pix_fmt","yuv420p","-threads","1",altered],root);const alteredVideo=readFileSync(altered);
  const wire=Bun.serve({port:0,hostname:"127.0.0.1",async fetch(request){const url=new URL(request.url);requests.push({method:request.method,path:url.pathname});
    if(request.method==="POST"){submissions++;expect(request.headers.get("x-api-key")).toBe("fixture-key");const form=await request.formData();expect([...form.keys()].sort()).toEqual(["audio","model","options","video"]);expect(form.get("model")).toBe("sync-3");expect(JSON.parse(String(form.get("options")))).toEqual(lipSyncRequest(f.plan,f.prepared).options);expect(Buffer.from(await (form.get("video") as File).arrayBuffer())).toEqual(sourceMedia.video);expect(Buffer.from(await (form.get("audio") as File).arrayBuffer())).toEqual(sourceMedia.audio);return Response.json({...remote,status:"PENDING"},{status:201});}
    if(url.pathname==="/clip.mp4"){expect(request.headers.has("x-api-key")).toBe(false);return new Response(alteredVideo);}
    observations++;return Response.json({...remote,status:observations<2?"PROCESSING":"COMPLETED",outputUrl:"https://output.sync.so/clip.mp4",outputDuration:f.plan.window.frames/30});
  }});
  const fetchImpl=((url:Parameters<typeof fetch>[0],init?:RequestInit)=>{const given=new URL(String(url));return fetch(new URL(given.pathname+given.search,wire.url),init);}) as typeof fetch;
  try{
    const first=journal(),controller=new AbortController(),underlying=first.journal.observe;first.journal.observe=async receipt=>{await underlying(receipt);if(receipt.remote)controller.abort();};
    await expect(new SyncLipSyncProvider({apiKey:"fixture-key",fetchImpl,pollMs:1}).synthesize(f.plan,f.prepared,sourceMedia,first.journal,undefined,controller.signal)).rejects.toMatchObject({kind:"cancelled"});expect(submissions).toBe(1);expect(first.authorized).toBe(1);
    const second=journal(),last=first.records.at(-1)!;expect(last.remote!.id).toBe(remote.id);const delivered=await new SyncLipSyncProvider({apiKey:"fixture-key",fetchImpl,pollMs:1}).synthesize(f.plan,f.prepared,sourceMedia,second.journal,last);expect(second.authorized).toBe(0);expect(submissions).toBe(1);expect(observations).toBe(2);expect(delivered.video).toEqual(alteredVideo);expect(delivered.receipt.delivery).toEqual(delivered.delivery);
    const output=await renderLipSyncVersion(f.job,f.prepared,delivered.video,delivered.delivery,f.artifacts,join(f.artifacts,f.job.projectId,f.job.id,"version"),async()=>{});validateLipSyncOutput(f.job,output);await verifyLipSyncMedia(f.job,output,f.artifacts);
    expect(readFileSync(join(f.artifacts,output.lipSync!.wavPath))).toEqual(readFileSync(join(f.artifacts,f.plan.source.files.audio.path)));expect(readFileSync(join(f.artifacts,output.captionsPath))).toEqual(readFileSync(join(f.artifacts,f.plan.source.files.captions.path)));
    const pixels=(path:string,frame:number)=>lipCommand(["ffmpeg","-v","error","-i",join(f.artifacts,path),"-vf",`select=eq(n\\,${frame}),scale=32:32`,"-frames:v","1","-threads","1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],root);
    expect(f.plan.window.startFrame).toBeGreaterThan(0);const end=f.plan.window.startFrame+f.plan.window.frames;expect(end).toBeLessThan(f.job.totalFrames);
    for(const index of [0,f.plan.window.startFrame-1,end,f.job.totalFrames-1]){const before=await pixels(f.plan.source.files.video.path,index),after=await pixels(output.mp4Path,index);expect(after.length).toBe(before.length);expect(after.reduce((sum,v,i)=>sum+Math.abs(v-before[i]!),0)/after.length).toBeLessThan(5);}
    for(const index of [f.plan.window.startFrame,end-1]){const frame=await pixels(output.mp4Path,index);expect(frame[0]).toBeGreaterThan(230);expect(frame[1]).toBeLessThan(30);expect(frame[2]).toBeGreaterThan(230);}
    f.store.checkpointLipSync(f.job.id,"fixture-lipsync",output);const done=f.store.complete(f.job.id,"fixture-lipsync",output),retained=retainLipSyncSource(done);expect(retained.history).toHaveLength(1);expect(retained.film.id).toBe(f.film.id);expect(retained.dialogue).toEqual(f.plan.source.dialogue);
    const review=addLipSyncReview(done,{mouthSync:2,faceStability:4,expression:4,decision:"cutaway",notes:"Mouth motion is visibly late."},0,contentHash(output));expect(review.entries[0]!.rubric).toBe("owner-rubric/1");expect(review.entries[0]!.decision).toBe("cutaway");expect(()=>addLipSyncReview(done,{mouthSync:2,faceStability:4,expression:4,decision:"cutaway",notes:""},0,contentHash(output))).toThrow("visible issue");
    f.store.reviewLipSync(done.id,{mouthSync:4,faceStability:4,expression:4,decision:"accept",notes:"Fixture review; no acting quality claim."},0,contentHash(output));expect(()=>f.store.reviewLipSync(done.id,{mouthSync:4,faceStability:4,expression:4,decision:"accept",notes:""},0,contentHash(output))).toThrow("another window");
    const nextPreview=await previewLipSyncFrame(retained,f.artifacts,f.plan.shotId,0,0),next=createLipSyncPlan(retained,f.plan.shotId,0,{...f.plan.selection,rgbSha256:nextPreview.rgbSha256},LIPSYNC_POLICY,"local",contentHash({pass:2}));expect(next.source.history).toHaveLength(1);expect(lipFixtureJob(next).stage).toBe("lip-sync");
  }finally{await wire.stop(true);}
},60000);
test("ambiguous submission, accounting failure and unapproved output hosts never create another paid request",async()=>{
  const body=media();let calls=0;const network=((_url:unknown,_init:RequestInit)=>{calls++;return Promise.reject(new Error("connection lost"));}) as typeof fetch,first=journal();
  await expect(new SyncLipSyncProvider({apiKey:"fixture",fetchImpl:network}).synthesize(f.plan,f.prepared,body,first.journal)).rejects.toMatchObject({kind:"transport"});expect(calls).toBe(1);const original=first.records.at(-1)!;expect(original.dispatched).toBe(true);expect(original.remote).toBeNull();
  await expect(new SyncLipSyncProvider({apiKey:"fixture",fetchImpl:network}).synthesize(f.plan,f.prepared,body,journal().journal,original)).rejects.toMatchObject({kind:"ambiguous"});expect(calls).toBe(1);
  await expect(new SyncLipSyncProvider({apiKey:"fixture",fetchImpl:network}).synthesize(f.plan,f.prepared,body,journal({failObserved:true}).journal)).rejects.toMatchObject({kind:"accounting"});expect(calls).toBe(1);
  let downloads=0;const badHost=(async(url:unknown,init?:RequestInit)=>{if(String(url).includes("169.254"))downloads++;return Response.json({id:"host-probe",model:"sync-3",createdAt:"2026-09-07T00:00:00.000Z",status:"COMPLETED",outputUrl:"https://169.254.169.254/credentials"},{status:init?.method==="POST"?201:200});}) as typeof fetch;
  await expect(new SyncLipSyncProvider({apiKey:"fixture",fetchImpl:badHost}).synthesize(f.plan,f.prepared,body,journal().journal)).rejects.toMatchObject({kind:"protocol"});expect(downloads).toBe(0);
});
test("same-size source and prepared audio tampering are refused before another provider call",async()=>{
  const path=join(f.artifacts,f.prepared.audio.path),original=readFileSync(path),bad=Buffer.from(original);bad[100]^=1;writeFileSync(path,bad);
  try{await expect(verifyLipSyncPrepared(f.job,f.prepared,f.artifacts)).rejects.toThrow("checksum");}finally{writeFileSync(path,original);}
  let dispatched=0;await expect(new SyncLipSyncProvider({apiKey:"fixture",fetchImpl:(async(_url:unknown)=>{dispatched++;throw new Error();}) as unknown as typeof fetch}).synthesize(f.plan,f.prepared,{...media(),audio:bad},journal().journal)).rejects.toThrow("input bytes");expect(dispatched).toBe(0);
});
