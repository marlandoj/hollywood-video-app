import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {RichAnimaticProvider,FailoverGenerator,sunkCostsOf,type CostRecord,type ImageProvider,type VideoClip} from "../src/index";
import {frameClip} from "../src/framing";
const root=mkdtempSync(join(tmpdir(),"hv-framing-test-"));afterAll(()=>rmSync(root,{recursive:true,force:true}));
function run(args:string[]){const p=Bun.spawnSync(args);if(p.exitCode)throw new Error(p.stderr.toString());return p.stdout;}
const cost:CostRecord={provider:"fixture",model:"quadrants",prompt_tokens:0,output_frames:1,gpu_seconds:0,total_cost_usd:.03};
const source=join(root,"source.png");run(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=red:s=320x180,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill","-frames:v","1",source]);
const images:ImageProvider={name:"fixture",model:"quadrants",generateFrame:async(_prompt,seed,_params,path)=>{writeFileSync(path,readFileSync(source));return {path,seed,provider:cost.provider,model:cost.model,cost,fingerprint:"fixture"};}};
const pixel=(path:string)=>run(["ffmpeg","-v","error","-i",path,"-frames:v","1","-vf","scale=1:1","-pix_fmt","rgb24","-f","rawvideo","-"]);
const streams=(path:string)=>JSON.parse(run(["ffprobe","-v","error","-show_streams","-of","json",path]).toString()).streams;
test("actual preview crops select opposite source halves, retain raw pixels and render exactly 121 frames",async()=>{
  const provider=new RichAnimaticProvider(images),base={seed:7,widthxheight:"320x180",durationSec:121/30,exactDuration:true,fps:30,cameraMove:"static" as const};
  for(const [name,x,color]of [["left",0,0],["right",5000,2]] as const){const clip=await provider.generate("A garden gate",7,{...base,framing:{x,y:2500,size:5000}},join(root,name+".mp4"));
    expect(readFileSync(clip.sourcePosterPath!)).toEqual(readFileSync(source));expect(clip.posterPath).not.toBe(clip.sourcePosterPath);
    expect(pixel(clip.posterPath!)[color]!).toBeGreaterThan(245);expect(pixel(clip.path)[color]!).toBeGreaterThan(245);
    const video=streams(clip.path).find((s:{codec_type:string})=>s.codec_type==="video");expect([video.width,video.height,Number(video.nb_frames)]).toEqual([320,180,121]);expect(clip.framing).toEqual({x,y:2500,size:5000});}
},20000);
test("final video crop preserves encoded audio, duration, frame count, source poster and changes visible pixels",async()=>{
  const path=join(root,"audio.mp4");run(["ffmpeg","-y","-v","error","-loop","1","-i",source,"-f","lavfi","-i","sine=frequency=440:sample_rate=44100","-t",String(121/30),"-frames:v","121","-r","30","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",path]);
  const audio=()=>run(["ffmpeg","-v","error","-i",path,"-map","0:a:0","-c","copy","-f","adts","-"]),before=audio();
  const clip:VideoClip={path,posterPath:source,seed:7,durationSec:121/30,cost,fingerprint:"before",provider:"fixture",model:"fixture"};
  const framed=await frameClip(clip,{x:5000,y:2500,size:5000},"320x180",30);expect(audio()).toEqual(before);expect(framed.sourcePosterPath).toBe(source);
  expect(pixel(path)[2]!).toBeGreaterThan(245);expect(pixel(framed.posterPath!)[2]!).toBeGreaterThan(245);expect(framed.fingerprint).not.toBe("before");
  expect(Number(streams(path).find((s:{codec_type:string})=>s.codec_type==="video").nb_frames)).toBe(121);expect(framed.durationSec).toBe(121/30);
},20000);
test("preview captions are drawn inside the output after the image crop",async()=>{
  const clip=await new RichAnimaticProvider(images,{captions:true}).generate("A garden gate",7,{seed:7,widthxheight:"320x180",durationSec:1,fps:30,cameraMove:"static",framing:{x:5000,y:2500,size:5000},dialogue:[{character:"SPUD",lines:["Hello."]}]},join(root,"captioned.mp4"));
  const decoded=run(["ffmpeg","-v","error","-i",clip.path,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"]);
  let white=0;for(let y=110;y<180;y++)for(let x=0;x<320;x++){const p=(y*320+x)*3;if(decoded[p]!>210&&decoded[p+1]!>210&&decoded[p+2]!>210)white++;}
  expect(white).toBeGreaterThan(20);expect(pixel(clip.posterPath!)[2]!).toBeGreaterThan(245);
},10000);
test("a local crop failure drains each known cost once and never dispatches a paid fallback",async()=>{
  let generated=0,fallback=0,started=0;const drained:CostRecord[]=[],outcomes:unknown[]=[];
  const primary={name:"paid-fixture",model:"fixture",generate:async()=>{generated++;return {path:join(root,"missing-directory","missing.mp4"),seed:7,durationSec:1,cost,provider:"fixture",model:"fixture",fingerprint:"none",sunkCosts:[{...cost,total_cost_usd:.02}]};}};
  const secondary={...primary,generate:async()=>{fallback++;return primary.generate();}},generator=new FailoverGenerator(primary,secondary);
  let failure:unknown;try{await generator.generate("A garden gate",7,{seed:7,widthxheight:"320x180",framing:{x:0,y:0,size:5000},beforeAttempt:()=>{started++;},onAttemptCost:c=>{drained.push(c);},afterAttempt:o=>{outcomes.push(o);}},join(root,"failed.mp4"));}catch(error){failure=error;}
  expect(failure).toMatchObject({name:"FramingError"});expect([generated,fallback,started]).toEqual([1,0,1]);expect(drained.map(c=>c.total_cost_usd)).toEqual([.02,.03]);expect(sunkCostsOf(failure)).toEqual(drained);expect(outcomes).toHaveLength(1);
  await expect(generator.generate("A garden",7,{seed:7,framing:{x:0,y:0,size:5000},routingRequirements:{nativeResolution:true},beforeAttempt:()=>{started++;}},join(root,"native.mp4"))).rejects.toThrow("native-resolution");expect([generated,fallback,started]).toEqual([1,0,1]);
});
test("a failed image crop carries the image cost and stops before fallback",async()=>{
  let called=0;const broken:ImageProvider={...images,generateFrame:async(...args)=>{called++;const frame=await images.generateFrame(...args);writeFileSync(frame.path,"bad image");return frame;}};
  const primary=new RichAnimaticProvider(broken),fallback=new RichAnimaticProvider(images),drained:CostRecord[]=[];
  let failure:unknown;try{await new FailoverGenerator(primary,fallback).generate("A garden",7,{seed:7,widthxheight:"320x180",framing:{x:0,y:0,size:5000},onAttemptCost:c=>{drained.push(c);}},join(root,"broken-image.mp4"));}catch(error){failure=error;}
  expect(failure).toMatchObject({name:"FramingError"});expect(called).toBe(1);expect(drained).toEqual([cost]);expect(sunkCostsOf(failure)).toEqual([cost]);
});
