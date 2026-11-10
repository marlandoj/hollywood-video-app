/**
 * HV-025-14: a G24-shaped picture edit on generated media, for timing and peak memory.
 *
 * One opaque film clip covers the whole timeline and one masked overlay is composited over a short
 * stretch of it, as in the Release 3 run (`scripts/release-3-run.ts`). Because one composite puts the
 * whole timeline through the RGBA compositor, the cost grows with the film, not with the effect.
 *
 *   bun scripts/bench-picture-edit.ts [frames=240] [width=1280] [height=720]
 *
 * It prints one JSON line: wall time, peak worker RSS, and one hash over every decoded output frame's
 * hash (the part files themselves carry random Matroska ids), so two builds can be compared for speed
 * and for identical pictures. Needs ffmpeg; spends nothing.
 */
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {editTimeline,type EditClip,type EditSource} from "../packages/planner/src/edit-timeline";
import {contentHash} from "../packages/generator/src/capabilities";
import {conformEditPicture} from "../packages/generator/src/edit-picture";
import {soundProcessingCommand} from "../packages/generator/src/sound-finishing";

const [frames=240,width=1280,height=720]=process.argv.slice(2).map(Number),access=async()=>{},revision=contentHash("bench-picture-edit");
if(![frames,width,height].every(n=>Number.isSafeInteger(n)&&n>0)||frames<60||width%2||height%2)throw new Error("Usage: bun scripts/bench-picture-edit.ts [frames>=60] [even width] [even height]");
const source=(id:string,media?:"graphic-rgba"):EditSource=>({id,revision,label:id,frames,width,height,audio:[],captions:[],voices:[],unmeasuredAudio:false,...(media?{media}:{})});
const clip=(id:string,sourceId:string,layer:number,at:number,count:number):EditClip=>({id,sourceId,lane:"picture",layer,at,from:at,frames:count,link:null,gainDb:0,opacity:1,crop:null,envelope:{from:at,frames:count,fadeIn:0,fadeOut:0}});
const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-bench-picture-")));
try{
  const film=join(root,"film.mkv"),overlay=join(root,"overlay.mkv");
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i",`testsrc2=s=${width}x${height}:r=30:d=${frames/30}`,"-frames:v",String(frames),"-an","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","yuv420p",film],root,access);
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i",`color=c=0x1e90ff@0.6:s=${width}x${height}:r=30:d=${frames/30},format=rgba`,"-frames:v",String(frames),"-an","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","bgra",overlay],root,access);
  const clips=[clip("film","film",0,0,frames),clip("overlay","overlay",1,15,30)];
  clips[1]!.opacity=.75;clips[1]!.composite={schema:"hv-edit-composite/1",masks:[{id:"mask",label:"Held rectangle",sourceRevision:revision,kind:"rectangle",combine:"replace",invert:false,featherQ8:0,keyframes:[{sourceFrame:0,interpolation:"hold",geometry:{xQ16:16384,yQ16:16384,widthQ16:32768,heightQ16:32768}}]}]};
  const timeline=editTimeline({schema:"hv-edit-timeline/2",width,height,frames,sources:[source("film"),source("overlay","graphic-rgba")],clips,markers:[]}),directory=join(root,"render");mkdirSync(directory);
  let peak=process.memoryUsage.rss();const sampler=setInterval(()=>{peak=Math.max(peak,process.memoryUsage.rss());},50);
  const started=performance.now(),result=await conformEditPicture(timeline,new Map([["film",film],["overlay",overlay]]),directory,access),seconds=(performance.now()-started)/1000;clearInterval(sampler);peak=Math.max(peak,process.memoryUsage.rss());
  console.log(JSON.stringify({frames,width,height,parts:result.picture.parts.length,recipe:result.picture.recipe.schema,seconds:Math.round(seconds*10)/10,secondsPerFrame:Math.round(seconds/frames*1000)/1000,peakRssMiB:Math.round(peak/2**20),framesSha256:createHash("sha256").update(result.pictureFrames.join("\n")).digest("hex")}));
}finally{const parent=realpathSync(tmpdir());if(root.startsWith(parent+sep+"hv-bench-picture-"))rmSync(root,{recursive:true,force:true});}
