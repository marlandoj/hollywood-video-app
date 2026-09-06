import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {RichAnimaticProvider,FailoverGenerator,sunkCostsOf,type CostRecord,type ImageProvider,type VideoClip} from "../src/index";
import {frameClip} from "../src/framing";
import {sampleCameraPath,type ShotCameraPath} from "../../planner/src/camera-path";
const root=mkdtempSync(join(tmpdir(),"hv-camera-path-"));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function run(args:string[]){const p=Bun.spawnSync(args);if(p.exitCode)throw new Error(p.stderr.toString());return p.stdout;}
const source=join(root,"source.png");run(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=red:s=320x180,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill","-frames:v","1",source]);
const cost:CostRecord={provider:"fixture",model:"halves",prompt_tokens:0,output_frames:1,gpu_seconds:0,total_cost_usd:.03};
const images:ImageProvider={name:"fixture",model:"halves",generateFrame:async(_prompt,seed,_params,path)=>{writeFileSync(path,readFileSync(source));return {path,seed,provider:cost.provider,model:cost.model,cost,fingerprint:"fixture"};}};
const path:ShotCameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:2500,size:5000,easing:"smooth"},{at:5000,x:2500,y:2500,size:5000,easing:"linear"},{at:10000,x:5000,y:2500,size:5000,easing:"linear"}]};
const pixel=(file:string,frame=0)=>run(["ffmpeg","-v","error","-i",file,"-vf",`select=eq(n\\,${frame}),scale=1:1`,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"]);
const streams=(file:string)=>JSON.parse(run(["ffprobe","-v","error","-show_streams","-of","json",file]).toString()).streams;
function check(clip:VideoClip){
  expect(clip.cameraPathControl).toEqual({mode:"screen-space",keyframes:path.keyframes,outputFrames:121});
  expect(pixel(clip.path,0)[0]!).toBeGreaterThan(245);expect(pixel(clip.path,120)[2]!).toBeGreaterThan(245);
  const middle=pixel(clip.path,60);expect(middle[0]!).toBeGreaterThan(110);expect(middle[2]!).toBeGreaterThan(110);
  expect(Number(streams(clip.path).find((s:{codec_type:string})=>s.codec_type==="video").nb_frames)).toBe(121);
  expect(readFileSync(clip.sourcePosterPath!)).toEqual(readFileSync(source));expect(pixel(clip.posterPath!)[0]!).toBeGreaterThan(245);
}
test("timed still paths render first, middle and last crops, preserve original pixels and override the retained static crop",async()=>{
  const clip=await new RichAnimaticProvider(images).generate("A garden gate",7,{seed:7,widthxheight:"320x180",durationSec:121/30,exactDuration:true,fps:30,cameraPath:path,framing:{x:5000,y:2500,size:5000}},join(root,"preview.mp4"));check(clip);expect(clip.framing).toBeUndefined();
  // A sampled intermediate frame has the same visible area as its independently rendered crop.
  const expected=await new RichAnimaticProvider(images).generate("A garden gate",7,{seed:7,widthxheight:"320x180",durationSec:1,fps:30,cameraMove:"static",framing:sampleCameraPath(path,30,121)},join(root,"expected.mp4"));
  const a=pixel(clip.path,30),b=pixel(expected.path);for(let channel=0;channel<3;channel++)expect(Math.abs(a[channel]!-b[channel]!)).toBeLessThan(5);
},20000);
test("video paths keep the full decoded timeline and encoded audio while applying the curve",async()=>{
  const file=join(root,"final.mp4");run(["ffmpeg","-y","-v","error","-loop","1","-i",source,"-f","lavfi","-i","sine=frequency=440:sample_rate=44100","-t",String(121/30),"-frames:v","121","-r","30","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",file]);
  const audio=()=>run(["ffmpeg","-v","error","-i",file,"-map","0:a:0","-c","copy","-f","adts","-"]),before=audio();
  const clip=await frameClip({path:file,posterPath:source,seed:7,durationSec:121/30,cost,provider:"fixture",model:"fixture",fingerprint:"before"},{x:5000,y:2500,size:5000},"320x180",30,undefined,path);check(clip);expect(audio()).toEqual(before);
},20000);
test("a camera processing failure accounts for the completed inference once and stops failover",async()=>{
  let called=0,fallback=0,admitted=0;const drained:CostRecord[]=[];
  const primary={name:"fixture",model:"fixture",generate:async()=>{called++;return {path:join(root,"absent","missing.mp4"),seed:7,durationSec:1,cost,provider:"fixture",model:"fixture",fingerprint:"before"};}};
  const gen=new FailoverGenerator(primary,{...primary,generate:async()=>{fallback++;return primary.generate();}});
  let error:unknown;try{await gen.generate("A garden",7,{seed:7,widthxheight:"320x180",durationSec:1,cameraPath:path,beforeAttempt:()=>{admitted++;},onAttemptCost:c=>{drained.push(c);}},join(root,"failed.mp4"));}catch(e){error=e;}
  expect(error).toMatchObject({name:"FramingError"});expect([called,fallback,admitted]).toEqual([1,0,1]);expect(drained).toEqual([cost]);expect(sunkCostsOf(error)).toEqual(drained);
  await expect(gen.generate("A garden",7,{seed:7,cameraPath:path,routingRequirements:{nativeResolution:true},beforeAttempt:()=>{admitted++;}},join(root,"refused.mp4"))).rejects.toThrow("native-resolution");expect([called,fallback,admitted]).toEqual([1,0,1]);
});
test("changing zoom follows the authored crop and captions stay in the final output area",async()=>{
  const zoom:ShotCameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:0,size:10000,easing:"linear"},{at:10000,x:5000,y:2500,size:5000,easing:"linear"}]};
  const clip=await new RichAnimaticProvider(images,{captions:true}).generate("A garden",7,{seed:7,widthxheight:"320x180",durationSec:61/30,exactDuration:true,fps:30,cameraPath:zoom,dialogue:[{character:"SPUD",lines:["Hello."]}]},join(root,"zoom-captions.mp4"));
  for(const frame of [0,30,60]){const decoded=run(["ffmpeg","-v","error","-i",clip.path,"-vf",`select=eq(n\\,${frame})`,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"]);
    let white=0;for(let y=110;y<180;y++)for(let x=0;x<320;x++){const p=(y*320+x)*3;if(decoded[p]!>210&&decoded[p+1]!>210&&decoded[p+2]!>210)white++;}expect(white).toBeGreaterThan(20);
    // Sample an uncaptained scan line: the red/blue boundary follows changing zoom.
    const crop=sampleCameraPath(zoom,frame,61),expectedBoundary=320*(5000-crop.x)/crop.size;
    let red=0;for(let x=0;x<320;x++){const i=(40*320+x)*3;if(decoded[i]!>200&&decoded[i+2]!<50)red++;}expect(Math.abs(red-expectedBoundary)).toBeLessThan(4);
  }
},10000);
