import {afterAll,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {assembleAsync} from "../../assembler/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import type {VideoClip} from "../../generator/src/index";
import {renderRecord} from "../src/shot-reuse";
import {createCurrentFilmAssemblyClock,validateCurrentFilmAssemblyClock,type CurrentFilmAssemblyClockInput,type CurrentFilmClockRow} from "../src/current-film-clock";
import type {Shot} from "../src/index";

let root:string,clips:VideoClip[],rows:CurrentFilmClockRow[],shots:Shot[];
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
beforeAll(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),"hv-current-clock-")));const directory=join(root,"clock-project","clock-job","clips");mkdirSync(directory,{recursive:true});
  clips=[60,90].map((frames,i)=>{const path=join(directory,"shot-"+i+".mp4"),made=Bun.spawnSync(["ffmpeg","-v","error","-f","lavfi","-i","color=c="+(i?"blue":"red")+":s=32x24:r=30","-frames:v",String(frames),"-c:v","libx264","-pix_fmt","yuv420p",path],{stdout:"pipe",stderr:"pipe"});if(made.exitCode)throw new Error(made.stderr.toString());return {path,provider:"mock",model:"mock",seed:i,durationSec:frames/30,fingerprint:hash("frame"+i),cost:{provider:"mock",model:"mock",prompt_tokens:0,output_frames:frames,gpu_seconds:0,total_cost_usd:0}};});
  rows=clips.map((clip,i)=>{const {path,cost:_cost,...metadata}=clip,bytes=readFileSync(path),inputRevision=hash("input"+i),record=renderRecord({projectId:"clock-project",jobId:"clock-job",shotId:"shot-"+i,inputHash:inputRevision,clip:metadata,files:{video:{path:"clock-project/clock-job/clips/shot-"+i+".mp4",sha256:sha(bytes),bytes:bytes.length}},origin:{jobId:"clock-job",shotId:"shot-"+i}});clip.renderRecord=record;return {ordinal:i,logicalShotId:hash("logical"+i),renderId:"shot-"+i,inputRevision,record};});
  shots=clips.map((clip,i)=>({id:"shot-"+i,sceneIndex:i,prompt:"A colored frame.",dialogue:[],durationSec:clip.durationSec,seed:clip.seed}));
},30000);
afterAll(()=>{if(root){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-current-clock-"))throw new Error("Unsafe clock test cleanup");rmSync(root,{recursive:true,force:true});}});
function input(overlap:0|15=15):CurrentFilmAssemblyClockInput{return {projectId:"clock-project",jobId:"clock-job",jobPlanRevision:hash("plan"),materializationRevision:hash("materialization"),requestedOverlapFrames:overlap,effectiveOverlapFrames:overlap,reason:overlap?"requested-crossfade":"requested-zero",rows,sourceFrames:[60,90],probe:{video:{codec:"h264",width:32,height:24,frames:150-overlap,rateNumerator:30,rateDenominator:1,timeBaseNumerator:1,timeBaseDenominator:15360,durationTicks:(150-overlap)*512},audio:{codec:"aac",sampleRate:44100,channels:2,timeBaseNumerator:1,timeBaseDenominator:44100,durationTicks:(150-overlap)*1470}},video:{sha256:hash("video"),bytes:1000},captions:{srt:{sha256:hash("srt"),bytes:12},vtt:{sha256:hash("vtt"),bytes:12}}};}

test("clock retains exact half-open overlapping spans, raw frame sum and physical 44.1kHz evidence",()=>{
  const request=input(),before=hash(request),clock=createCurrentFilmAssemblyClock(request);expect(clock.rawFrames).toBe(150);expect(clock.frames).toBe(135);expect(clock.spans.map(row=>[row.startFrame,row.endFrame])).toEqual([[0,60],[45,135]]);expect(clock.probe.audio.sampleRate).toBe(44100);expect(clock.captions.policy).toBe("hv-captions-measured-or-fallback-ms/1");expect(validateCurrentFilmAssemblyClock(clock,rows,15)).toEqual(clock);clock.spans[0]!.frames++;expect(hash(request)).toBe(before);
});
test("actual action-only assembler counts decoded frames and hashes fallback captions for cuts and odd dissolves",async()=>{
  for(const overlap of [0,15] as const){const result=await assembleAsync(clips,shots,join(root,"out-"+overlap),{size:"32x24",fps:30,crossfadeSec:overlap/30,projectId:"clock-project",currentFilm:{jobId:"clock-job",jobPlanRevision:hash("plan"),materializationRevision:hash("materialization"),rows}}),clock=result.currentFilmClock!;
    expect(readFileSync(result.srtPath,"utf8")).toContain("[no dialogue]");expect(clock.captions.srt.bytes).toBeGreaterThan(0);
    expect(clock.frames).toBe(150-overlap);expect(clock.probe.video.frames).toBe(clock.frames);expect(clock.video).toEqual({sha256:sha(readFileSync(result.mp4Path)),bytes:readFileSync(result.mp4Path).length});expect(clock.captions.vtt).toEqual({sha256:sha(readFileSync(result.vttPath)),bytes:readFileSync(result.vttPath).length});expect(clock.captions.srt.sha256).toBe(sha(readFileSync(result.srtPath)));expect(validateCurrentFilmAssemblyClock(clock,rows,overlap)).toEqual(clock);
  }
},60000);
test("changed record identities, reordered slots, rounded durations, false stream rates and resealed clocks reject",()=>{
  const changes:((value:CurrentFilmAssemblyClockInput)=>void)[]=[v=>{v.sourceFrames[0]++;},v=>{v.rows.reverse();},v=>{v.rows[0]!.inputRevision=hash("wrong");},v=>{v.effectiveOverlapFrames=0;},v=>{v.probe.video.frames++;},v=>{v.probe.video.durationTicks++;},v=>{v.probe.audio.sampleRate=48000 as 44100;},v=>{v.video.bytes=0;},v=>{v.rows.pop();}];
  for(const change of changes){const value=structuredClone(input());change(value);expect(()=>createCurrentFilmAssemblyClock(value)).toThrow();}
  const clock=createCurrentFilmAssemblyClock(input());clock.spans[1]!.startFrame++;expect(()=>validateCurrentFilmAssemblyClock(reseal(clock),rows,15)).toThrow(/differs/);
  const hostile=input();let reads=0;Object.defineProperty(hostile,"rows",{enumerable:true,get(){reads++;return rows;}});expect(()=>createCurrentFilmAssemblyClock(hostile)).toThrow(/accessors/);expect(reads).toBe(0);
});
