import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {ReferenceBlobStore} from "../../storage/src/references";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {compileWanMovePacket,compileWanMovePacketAsync,verifyWanMovePacket} from "../../generator/src/wan-move-packet";
import type {MotionStudy} from "../../planner/src/motion-studies";
import type {ReferenceAsset} from "../../planner/src/references";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
const SCRIPT="EXT. GARDEN - DAY\n\nSpud rolls a ball across a table.";
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});
const subjects=[{id:"ball",label:"Red ball",tracks:[{id:"center",keyframes:[{frame:0,x:2500,y:5000,easing:"smooth",visible:true},{frame:40,x:7500,y:5000,easing:"linear",visible:false},{frame:80,x:2500,y:5000,easing:"linear",visible:true}]}]}];
async function fixture(){
  process.env.HV_TOKEN_SECRET="subject-motion-test-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-subject-editor-")),paths={statePath:join(root,"projects.json"),queuePath:join(root,"jobs.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:SCRIPT},owner.token);
  const route=base+"/direction/shot-1-1/subject-motion",view=()=>call(route,"GET",undefined,owner.token).then(r=>r.json() as Promise<any>);
  const pngFile=join(root,"source.png"),made=Bun.spawnSync(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=red:s=640x480","-frames:v","1",pngFile]);if(made.exitCode)throw new Error(made.stderr.toString());const png=readFileSync(pngFile);
  const upload=async(headers:Record<string,string>={},orientation="landscape")=>{const state=await view();return fetch(new URL(base+"/direction/shot-1-1/motion-image?orientation="+orientation,server.url),{method:"POST",headers:{authorization:"Bearer "+owner.token,"content-type":"image/png","x-hv-reference-attested":"true","x-hv-direction-version":String(state.directionVersion),"x-hv-script-version":String(state.scriptVersion),"x-hv-source-hash":state.source.sourceHash,...headers},body:new Uint8Array(png)});};
  const body=async(asset:ReferenceAsset)=>{const state=await view();return {input:{sourceHash:state.source.sourceHash,maxShots:24,assetId:asset.id,appearance:"source-image",prompt:"A red ball rolls right, then returns.",seed:7,subjects,links:[] as {subjectId:string;characterId:string}[]},expected:{version:state.version,scriptVersion:state.scriptVersion,directionVersion:state.directionVersion,castingRevision:state.castingRevision}};};
  const save=async(asset:ReferenceAsset)=>{const response=await call(route,"PUT",await body(asset),owner.token);expect(response.status).toBe(200);return (await response.json() as {study:MotionStudy}).study;};
  const projects=new ProjectService(paths.statePath),references=new ReferenceBlobStore(paths.artifactRoot);
  const exportStudy=(study:MotionStudy,token=owner.token)=>call(route+"/export?revision="+study.revision,"GET",undefined,token);
  return {root,paths,server,owner,base,route,call,view,upload,png,body,save,projects,references,exportStudy};
}
test("private source preparation preserves aspect, requires permission and refuses other owners and reviewers",async()=>{
  const f=await fixture(),other=await(await f.call("/api/projects","POST")).json() as {token:string},review=await(await f.call(f.base+"/reviews","POST",{permission:"read"},f.owner.token)).json() as {token:string};
  for(const token of [other.token,review.token]){expect((await f.call(f.route,"GET",undefined,token)).status).toBe(401);expect((await f.upload({authorization:"Bearer "+token})).status).toBe(401);}
  expect((await f.upload({"x-hv-reference-attested":"false"})).status).toBe(400);expect((await f.upload({"x-hv-source-hash":"0".repeat(64)})).status).toBe(409);expect((await f.upload({},"square")).status).toBe(400);
  const response=await f.upload();expect(response.status).toBe(201);const {asset}=await response.json() as {asset:ReferenceAsset};
  expect([asset.width,asset.height]).toEqual([832,480]);expect(asset.originalSha256).toBe(createHash("sha256").update(f.png).digest("hex"));expect(asset.sha256).not.toBe(asset.originalSha256);
  const image=await f.references.read(asset),decoded=Bun.spawnSync(["ffmpeg","-v","error","-f","image2pipe","-i","pipe:0","-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"],{stdin:image});expect(decoded.exitCode).toBe(0);
  expect([...decoded.stdout.subarray(0,3)]).toEqual([0,0,0]);expect(decoded.stdout[(240*832+416)*3]!).toBeGreaterThan(245);
  const portrait=(await(await f.upload({},"portrait")).json() as {asset:ReferenceAsset}).asset;expect([portrait.width,portrait.height]).toEqual([480,832]);
  const view=await f.view();expect(view.assets).toHaveLength(2);expect(view.directionVersion).toBe(0);expect(view.version).toBe(0);
});
test("saved plans export exact native inputs with context, survive snapshots and leave film direction and jobs unchanged",async()=>{
  const f=await fixture(),asset=(await(await f.upload()).json() as {asset:ReferenceAsset}).asset,study=await f.save(asset);
  expect((await f.view()).study).toEqual(study);expect((await f.view()).version).toBe(1);expect((await f.view()).directionVersion).toBe(0);
  const response=await f.exportStudy(study);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("content-disposition")).toContain("attachment");
  const archive=new Bun.Archive(await response.arrayBuffer()),files=await archive.files();expect(files.size).toBe(7);const target=join(f.root,"export");await archive.extract(target);
  expect(verifyWanMovePacket(join(target,"packet"))).toMatchObject({subjects:1,tracks:1,rendered:false});
  expect(readFileSync(join(target,"packet/source.png"))).toEqual(Buffer.from(await f.references.read(asset)));expect(JSON.parse(readFileSync(join(target,"study.json"),"utf8"))).toEqual(study);
  const binding=JSON.parse(readFileSync(join(target,"binding.json"),"utf8"));expect(binding.studyRevision).toBe(study.revision);expect(binding.packetRevision).toBe(verifyWanMovePacket(join(target,"packet")).revision);
  const snapshot:StateSnapshot={schema:"hv-state/1",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:[],ledger:{events:[],reservations:[]},reviews:[]};
  expect(validateSnapshot(snapshot).projects.projects[0]!.motionStudies!.studies[0]).toEqual(study);expect(ProjectService.fromState(snapshot.projects).currentMotionStudy(f.owner.token,"shot-1-1",study.revision)).toEqual(study);
  const corrupt=structuredClone(snapshot);corrupt.projects.projects[0]!.motionStudies!.studies[0]!.plan.subjects[0]!.tracks[0]!.keyframes[0]!.x=123;expect(()=>validateSnapshot(corrupt)).toThrow("revision");
  const missing=structuredClone(snapshot);missing.projects.projects[0]!.referenceAssets=[];expect(()=>validateSnapshot(missing)).toThrow("catalog");
  const project=await(await f.call(f.base,"GET",undefined,f.owner.token)).json() as {jobs:unknown[];directionVersion:number};expect(project.jobs).toEqual([]);expect(project.directionVersion).toBe(0);
  expect(await compileWanMovePacketAsync(study.plan,await f.references.read(asset),new AbortController().signal)).toEqual(compileWanMovePacket(study.plan,await f.references.read(asset)));
  await expect(compileWanMovePacketAsync(study.plan,await f.references.read(asset),AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
},15000);
test("stale and concurrent saves, forged assets and obsolete exports are refused without dropping the saved plan",async()=>{
  const f=await fixture(),asset=(await(await f.upload()).json() as {asset:ReferenceAsset}).asset,body=await f.body(asset);
  const results=await Promise.all([f.call(f.route,"PUT",body,f.owner.token),f.call(f.route,"PUT",body,f.owner.token)]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  const first=(await f.view()).study as MotionStudy,bad=await f.body(asset);bad.input.assetId=crypto.randomUUID();expect((await f.call(f.route,"PUT",bad,f.owner.token)).status).toBe(400);
  const revision=(await f.view()).study.revision;expect(revision).toBe(first.revision);
  await f.call(f.base+"/script","PUT",{text:SCRIPT+"\n\nA gate opens."},f.owner.token);expect((await f.view()).staleReason).toContain("changed");expect((await f.exportStudy(first)).status).toBe(409);
  // The original shot is unchanged, but a new screenplay revision still requires explicit review/save.
  const next=await f.save(asset);expect((await f.exportStudy(next)).status).toBe(200);expect((await f.exportStudy(first)).status).toBe(409);
  expect((await f.call(f.route+"/remove","POST",{expectedVersion:1,revision:next.revision},f.owner.token)).status).toBe(409);
  expect((await f.call(f.route+"/remove","POST",{expectedVersion:2,revision:next.revision},f.owner.token)).status).toBe(200);expect((await f.view()).study).toBeNull();expect((await f.view()).version).toBe(3);
});
test("source or permission changes during export prevent the archive response",async()=>{
  const f=await fixture(),asset=(await(await f.upload()).json() as {asset:ReferenceAsset}).asset,study=await f.save(asset),read=ReferenceBlobStore.prototype.read;
  try{ReferenceBlobStore.prototype.read=async function(value){const data=await read.call(this,value);if(value.id===asset.id)f.projects.editScript(f.owner.token,SCRIPT+"\n\nRain falls.");return data;};
    const result=await f.exportStudy(study);expect(result.status).toBe(409);expect(result.headers.get("content-type")).toContain("application/json");
  }finally{ReferenceBlobStore.prototype.read=read;}
  const updated=await f.save(asset);
  try{ReferenceBlobStore.prototype.read=async function(value){const data=await read.call(this,value);if(value.id===asset.id)f.projects.takedown(f.owner.projectId,"fixture removal");return data;};expect((await f.exportStudy(updated)).status).toBe(401);}
  finally{ReferenceBlobStore.prototype.read=read;}
});
test("cast associations and current scene permission are checked for saved movement exports",async()=>{
  const f=await fixture(),now=Date.now(),id=crypto.randomUUID();
  f.projects.saveCharacter(f.owner.token,id,{...CAST_INPUT,permission:{...CAST_INPUT.permission,expiresAt:new Date(now+60000).toISOString()}},0,now);
  const asset=(await(await f.upload()).json() as {asset:ReferenceAsset}).asset,body=await f.body(asset);body.input.links=[{subjectId:"ball",characterId:id}];
  const response=await f.call(f.route,"PUT",body,f.owner.token);expect(response.status).toBe(200);const study=(await response.json() as {study:MotionStudy}).study;
  expect(study.links).toEqual([{subjectId:"ball",characterId:id}]);expect(()=>f.projects.currentMotionStudy(f.owner.token,"shot-1-1",study.revision,now+120000)).toThrow("not permitted");
  f.projects.saveCharacter(f.owner.token,id,{...CAST_INPUT,permission:{...CAST_INPUT.permission,status:"revoked"}},1);expect((await f.exportStudy(study)).status).toBe(409);
  const current=f.projects.authorize(f.owner.token)!;expect(currentCasting(current.id,current.castingHistory).version).toBe(2);expect(currentDirection(current.id,current.directionHistory).version).toBe(0);
});
