import {mkdirSync,mkdtempSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {gateOrThrow} from "../../safety/src/index";
import {isCropped} from "../../planner/src/framing";
import {animaticCommand,animaticCaptionFilters,prepareAnimaticAudio,ShotDurationError} from "./animatic";
import {baseCapability,capability,matchCapability,videoRequirements} from "./capabilities";
import {frameFingerprint} from "./fal";
import {FrameAnchorError} from "./frame-anchor-media";
import {frameImage,FramingError} from "./framing";
import {privatePngReferences,parseFrameSize} from "./image";
import type {GenParams,ProviderAdapter,VideoClip} from "./index";

export function anchorStoryboardCapability(options:{narration?:boolean;captions?:boolean}={}) {
  const definition=baseCapability("anchor-storyboard","anchor-storyboard-v1","video");
  definition.input.minimumFirstFrame=true;
  definition.output.minWidth=320;definition.output.minHeight=180;
  definition.frameControls={first:true,last:true,intermediate:true};definition.frameControlMode="storyboard";
  definition.audio=options.narration?"temporary-dialogue":"silent";
  definition.cameraMoves=["static"];
  definition.postProcessing=["provided-still-dissolves","scale-and-pad",...(options.narration?["temporary-narration"]:[]),...(options.captions?["burn-in-captions"]:[])];
  definition.cancellation="local";definition.determinism="local-bitexact";definition.region="local";
  return capability(definition);
}

/** Presents the provided images. It does not generate motion or recondition cast identity. */
export class AnchorStoryboardProvider implements ProviderAdapter {
  readonly name="anchor-storyboard";readonly model="anchor-storyboard-v1";readonly capabilities;
  constructor(private options:{narration?:boolean;captions?:boolean}={}){this.capabilities=anchorStoryboardCapability(options);}
  async generate(prompt:string,seed:number,params:GenParams,outPath:string):Promise<VideoClip>{
    const dialogue=(params.dialogue??[]).map(d=>`${d.character}: ${d.lines.join(" ")}`).join("\n");
    gateOrThrow([prompt,params.shotId??"",params.sceneHeading??"",params.action??"",dialogue].join("\n"));
    params.signal?.throwIfAborted();
    try{if(!params.frameAnchors||!matchCapability(this.capabilities,videoRequirements(params),0).eligible)throw new Error("Choose first-frame anchors, automatic or static storyboard motion, and compatible render requirements.");
      privatePngReferences(params.frameAnchors.frames.map(f=>f.image),1,5);
    }catch(error){throw new FrameAnchorError((error as Error).message);}
    const [width,height]=parseFrameSize(params.widthxheight??"640x360"),fps=params.fps??30;
    const target=resolve(outPath);mkdirSync(dirname(target),{recursive:true});
    const scratch=mkdtempSync(join(dirname(target),".hv-anchor-storyboard-"));
    try{
      const {voice,frames,durationSec}=await prepareAnimaticAudio(scratch,dialogue,fps,Math.round(fps*(params.durationSec??2)),params.exactDuration,this.options.narration,params.signal);
      const anchors=params.frameAnchors!.frames,positions=anchors.map(f=>Math.round(f.at*(frames-1)/10000));
      if(positions.some((at,i)=>i>0&&at<=positions[i-1]!))throw new FrameAnchorError("Frame anchors collide at this duration. Space them farther apart or increase the duration.");
      const cropped=isCropped(params.framing),inputs:string[]=[],filters:string[]=[];
      for(const [i,anchor]of anchors.entries()){
        writeFileSync(join(scratch,`anchor-${i}.png`),Buffer.from(anchor.image.slice(22),"base64"));
        if(cropped)await frameImage(join(scratch,`anchor-${i}.png`),join(scratch,`framed-${i}.png`),params.framing!,`${width}x${height}`,params.signal);
        inputs.push("-loop","1","-framerate",String(fps),"-i",`${cropped?"framed":"anchor"}-${i}.png`);
        filters.push(`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv444p[v${i}]`);
      }
      let previous="v0";
      for(let i=1;i<anchors.length;i++){
        const start=positions[i-1]!/fps,length=(positions[i]!-positions[i-1]!)/fps;
        filters.push(`[${previous}][v${i}]xfade=transition=fade:duration=${length}:offset=${start}[b${i}]`);previous=`b${i}`;
      }
      const captions=this.options.captions?animaticCaptionFilters(width,params.dialogue??[],durationSec,scratch):[];
      filters.push(`[${previous}]${[...captions,"format=yuv420p"].join(",")}[video]`);
      await animaticCommand(["ffmpeg","-y","-v","error",...inputs,
        ...(voice?["-i","voice.wav"]:["-f","lavfi","-i","anullsrc=r=44100:cl=stereo"]),
        "-filter_complex_threads","1","-filter_complex",filters.join(";"),"-map","[video]","-map",`${anchors.length}:a:0`,
        "-af","apad","-t",String(durationSec),"-frames:v",String(frames),"-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p",
        "-c:a","aac","-b:a","128k","-ar","44100","-ac","2","-fflags","+bitexact","-flags:v","+bitexact","-flags:a","+bitexact","-map_metadata","-1","clip.mp4"],scratch,params.signal);
      params.signal?.throwIfAborted();const fingerprint=frameFingerprint(join(scratch,"clip.mp4"),durationSec/2);
      if(cropped)renameSync(join(scratch,"anchor-0.png"),`${target}.source.png`);
      renameSync(join(scratch,cropped?"framed-0.png":"anchor-0.png"),`${target}.png`);renameSync(join(scratch,"clip.mp4"),target);
      return {path:outPath,provider:this.name,model:this.model,seed,durationSec,fingerprint,posterPath:`${target}.png`,
        ...(cropped?{sourcePosterPath:`${target}.source.png`,framing:params.framing}:{}),audioMode:voice?"provided":"silent-captioned",
        frameAnchorControl:{mode:"storyboard",positions:anchors.map(f=>f.at)},cost:{provider:this.name,model:this.model,prompt_tokens:0,output_frames:frames,gpu_seconds:0,total_cost_usd:0}};
    }catch(error){if(params.signal?.aborted)throw params.signal.reason;if(error instanceof FrameAnchorError||error instanceof FramingError||error instanceof ShotDurationError)throw error;throw new FrameAnchorError((error as Error).message);}
    finally{try{rmSync(scratch,{recursive:true,force:true});}catch{/* Project retention cleans an abandoned scratch directory. */}}
  }
}
