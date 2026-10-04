import {afterAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DeterministicMockProvider} from "../src/index";
import {renderHeroChain,sealHeroJob,verifyHeroMedia} from "../src/hero-chain";
import {contentHash} from "../src/capabilities";
import {validateDeliveryJob,validateDeliveryOutput} from "../../planner/src/delivery-jobs";
import {heroChainRequests,heroDerivation,heroJobPlan,heroShotBinding,heroTotalFrames,type HeroDeliveryOutput,type HeroJobPlan} from "../../planner/src/hero-chain";
import {verifyC2paSidecar} from "../../assembler/src/c2pa";
import {makeC2paTestIdentity,withC2paEnv} from "../../assembler/test/c2pa-fixture";
import type {JobInput} from "../../queue/src/index";

/**
 * HV-019-15: the hero-render chain on a real mock clip -- the deterministic mock provider's own
 * output, as a final render retains it -- through every stage, the seal and the verification.
 */
const ROOT=mkdtempSync(join(tmpdir(),"hv-hero-chain-"));
afterAll(()=>rmSync(ROOT,{recursive:true,force:true}));
const sha=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const noop=async()=>{};
/** An independent ffprobe of a file, not the chain's own reader. */
function probe(path:string){
  const run=Bun.spawnSync(["ffprobe","-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=width,height,r_frame_rate,nb_read_frames,codec_name","-of","json",path],{stdout:"pipe",stderr:"pipe"});
  const video=JSON.parse(run.stdout.toString()).streams[0];
  return {width:Number(video.width),height:Number(video.height),fps:String(video.r_frame_rate),frames:Number(video.nb_read_frames),codec:String(video.codec_name)};
}
async function shot(root:string){
  const projectId=crypto.randomUUID(),filmId=crypto.randomUUID(),relative=projectId+"/"+filmId+"/clips/shot-1-1.mp4",path=join(root,"artifacts",relative);
  mkdirSync(join(root,"artifacts",projectId,filmId,"clips"),{recursive:true});
  await new DeterministicMockProvider().generate("A lantern glows in the garden.",7,{seed:7,widthxheight:"320x180",fps:24,durationSec:1},path);
  const binding=heroShotBinding({storage:"local",source:{projectId,jobId:filmId,stage:"final",outputRevision:"a".repeat(64),shotId:"shot-1-1"},
    shot:{renderRevision:"b".repeat(64),inputHash:"c".repeat(64),provider:"mock",model:"mock-deterministic-v1",durationSec:1,video:{path:relative,sha256:sha(path),bytes:statSync(path).size}}});
  return {projectId,filmId,path,binding};
}
function job(plan:HeroJobPlan):JobInput{
  return {id:crypto.randomUUID(),idempotencyKey:"hero",projectId:plan.binding.source.projectId,tier:"free",stage:"delivery",scriptVersion:0,scriptText:"",
    rightsAttestedAt:new Date(Date.now()-1000).toISOString(),animaticJobId:null,animaticApprovedAt:null,totalFrames:heroTotalFrames(plan),costCapUsd:0,budgetReservedUsd:0,
    retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:600000,delivery:plan};
}

test("a real mock clip goes through denoise, frame rate and upscale, and every stage records its own provenance",async()=>{
  const root=join(ROOT,"unsigned"),artifacts=join(root,"artifacts"),work=join(artifacts,".work");mkdirSync(work,{recursive:true});
  const {path,binding}=await shot(root);
  expect(probe(path)).toMatchObject({width:320,height:180,fps:"24/1",frames:24});
  const plan=heroJobPlan(binding,heroChainRequests({denoise:"strong",fps:30,height:720})),input=job(plan);
  validateDeliveryJob(input);
  expect(plan.chain.stages.map(stage=>[stage.stage,stage.engine,stage.provider,stage.spendUsd])).toEqual([
    ["denoise","ffmpeg-hqdn3d","local",0],["frame-rate","ffmpeg-minterpolate","local",0],["upscale","ffmpeg-lanczos","local",0]]);

  const rendered=await renderHeroChain(input,path,artifacts,work,noop);
  const output=await sealHeroJob(input,artifacts,rendered,noop);
  validateDeliveryOutput(input,output);
  await verifyHeroMedia(input,output,artifacts,noop);

  // Three new artifacts, each read back by an independent ffprobe: the size and rate each stage was asked for.
  const files=output.chain.stages.map(stage=>join(artifacts,stage.output.path));
  expect(files.map(probe)).toEqual([
    {width:320,height:180,fps:"24/1",frames:24,codec:"h264"},
    {width:320,height:180,fps:"30/1",frames:expect.any(Number) as unknown as number,codec:"h264"},
    {width:1280,height:720,fps:"30/1",frames:expect.any(Number) as unknown as number,codec:"h264"}]);
  // Interpolation ends on the last source frame's instant (23/24 s), so a second at 30 fps is 28 to 30 frames.
  expect(probe(files[1]!).frames).toBeGreaterThanOrEqual(28);expect(probe(files[1]!).frames).toBeLessThanOrEqual(30);
  expect(probe(files[2]!).frames).toBe(probe(files[1]!).frames);

  // Each stage's provenance links the file it read to the file it wrote, by digest, back to the shot.
  const chain=output.chain;
  expect(chain.source).toMatchObject({jobId:binding.source.jobId,shotId:"shot-1-1",renderRevision:binding.shot.renderRevision,sha256:sha(path)});
  expect(chain.stages[0]!.input.sha256).toBe(sha(path));
  for(const [at,stage] of chain.stages.entries()){
    expect(stage.output.sha256).toBe(sha(files[at]!));
    expect(stage.output.bytes).toBe(statSync(files[at]!).size);
    if(at)expect(stage.input).toEqual({sha256:chain.stages[at-1]!.output.sha256,bytes:chain.stages[at-1]!.output.bytes});
    expect(stage.runtime.ffmpeg).toMatch(/^[A-Za-z0-9._+~:-]+$/);
    expect(stage.args.slice(0,10)).toEqual(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i","<input>"]);
    expect(stage.args).toContain(stage.filter);
  }
  expect(chain.stages.map(stage=>stage.filter)).toEqual(["hqdn3d=8:6:12:9","minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1","scale=1280:720:flags=lanczos"]);
  expect(Bun.spawnSync(["ffmpeg","-version"],{stdout:"pipe"}).stdout.toString()).toStartWith("ffmpeg version "+chain.stages[0]!.runtime.ffmpeg);

  // The result is the last stage's file; the record is written beside it; with no key on this host, unsigned.
  expect(output.file).toEqual(chain.stages[2]!.output);
  expect(output.files.map(file=>file.path.slice(file.path.indexOf("/hero/")+1))).toEqual(["hero/1-denoise.mp4","hero/2-frame-rate.mp4","hero/3-upscale.mp4","hero/provenance.json"]);
  expect(contentHash(JSON.parse(readFileSync(join(artifacts,output.files[3]!.path),"utf8")))).toBe(contentHash(chain));
  expect(chain.credentials.type).toBe("c2pa-style");
  expect(output.quality.source).toEqual({sha256:output.file.sha256,bytes:output.file.bytes});
  expect(output.quality.programme).toMatchObject({width:1280,height:720,video:"h264"});

  // Any link of the chain edited under a fresh revision is refused by name.
  const reseal=(edit:(copy:HeroDeliveryOutput)=>void)=>{
    const copy=structuredClone(output);edit(copy);
    for(const stage of copy.chain.stages){const {revision:_r,...data}=stage;stage.revision=contentHash(data);}
    const {revision:_c,...chainData}=copy.chain;copy.chain.revision=contentHash(chainData);
    const {revision:_o,...data}=copy;copy.revision=contentHash(data);return ()=>validateDeliveryOutput(input,copy);
  };
  expect(reseal(copy=>{copy.chain.stages[1]!.input.sha256="0".repeat(64);})).toThrow("did not read the file stage 1 wrote");
  expect(reseal(copy=>{copy.chain.stages[0]!.input.sha256="0".repeat(64);})).toThrow("did not read the file the shot is");
  expect(reseal(copy=>{copy.chain.stages[2]!.filter="scale=1280:720:flags=bicubic";})).toThrow("names a filter its plan does not derive");
  expect(reseal(copy=>{copy.chain.stages[2]!.probe.width=1282;})).toThrow("was asked for 1280 by 720");
  expect(reseal(copy=>{copy.chain.source.shotId="shot-2-1";})).toThrow("does not lead back to the shot");
  expect(reseal(copy=>{copy.chain.stages[1]!.spendUsd=0.5;})).toThrow("ran something other than its plan");
  // And bytes changed on disk are refused at verification.
  await Bun.write(join(artifacts,output.files[1]!.path),"not the stage's file");
  await expect(verifyHeroMedia(input,output,artifacts,noop)).rejects.toThrow("checksum verification");
},120_000);

test("with a key on the host, the chain's result is signed the way an export is, and its manifest leads back to the shot",async()=>{
  const root=join(ROOT,"signed"),artifacts=join(root,"artifacts"),work=join(artifacts,".work");mkdirSync(work,{recursive:true});
  const identity=makeC2paTestIdentity(join(root,"identity"));
  const {path,binding}=await shot(root);
  const plan=heroJobPlan(binding,heroChainRequests({denoise:"light",fps:48,height:720})),input=job(plan);
  const output=await withC2paEnv({key:identity.keyPath,cert:identity.chainPath},async()=>{
    const rendered=await renderHeroChain(input,path,artifacts,work,noop);return sealHeroJob(input,artifacts,rendered,noop);});
  validateDeliveryOutput(input,output);
  await verifyHeroMedia(input,output,artifacts,noop);
  expect(output.chain.credentials.type).toBe("c2pa-sidecar");
  expect(output.files.map(file=>file.path.split("/").slice(-1)[0])).toEqual(["1-denoise.mp4","2-frame-rate.mp4","3-upscale.mp4","provenance.json","provenance.c2pa"]);
  const result=join(artifacts,output.file.path),sidecar=readFileSync(join(artifacts,output.files[4]!.path));
  expect(probe(result)).toMatchObject({width:1280,height:720,fps:"48/1"});
  const read=await verifyC2paSidecar(result,sidecar,identity.anchorPem);
  expect(read.state).toBe("Trusted");
  expect(read.provenance).toMatchObject({spec:"hv-hero-chain/1",projectId:input.projectId,mp4Sha256:output.file.sha256,
    derivedFrom:heroDerivation(output.chain.source,output.chain.stages)});
  expect(read.provenance!.derivedFrom).toMatchObject({jobId:binding.source.jobId,shotId:"shot-1-1",renderRevision:binding.shot.renderRevision,sha256:binding.shot.video.sha256});
},120_000);
