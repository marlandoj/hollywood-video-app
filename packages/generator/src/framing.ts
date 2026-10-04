import {cameraPathFilter,cameraPathSettings,sampleCameraPath,type CameraCropReason,type ShotCameraPath} from "../../planner/src/camera-path";
import {dirname,join} from "node:path";
import {mkdtempSync,renameSync,rmSync} from "node:fs";
import {framingFilter,framingSettings,isCropped,type ShotFraming} from "../../planner/src/framing";
import {frameFingerprint} from "./fal";
import {parseFrameSize} from "./image";
import type {VideoClip} from "./index";
export class FramingError extends Error {override name="FramingError";}
async function command(args:string[],signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const child=Bun.spawn(args,{stdout:"ignore",stderr:"pipe"}),abort=()=>child.kill("SIGKILL"),timer=setTimeout(abort,60000);
  signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  try{const [code,error]=await Promise.all([child.exited,new Response(child.stderr).text()]);signal?.throwIfAborted();if(code!==0)throw new FramingError("Local framing failed. The paid request will not be repeated automatically. "+error.slice(-200));}
  finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
export async function frameImage(source:string,target:string,framing:ShotFraming,size:string,signal?:AbortSignal):Promise<void>{
  try{const [width,height]=parseFrameSize(size);await command(["ffmpeg","-y","-v","error","-i",source,"-vf",framingFilter(framing,width,height),"-frames:v","1","-fflags","+bitexact",target],signal);}
  catch(error){if(signal?.aborted)throw signal.reason;if(error instanceof FramingError)throw error;throw new FramingError("Local image framing failed. The paid request will not be repeated automatically.",{cause:error});}
}
/** Runs after a successful provider request. Its cost remains available on local failure. */
/** `cropReason` (HV-020-01) is recorded with a camera path: why it was framed here, not by the provider. */
export async function frameClip(clip:VideoClip,framing:ShotFraming,size:string,fps:number,signal?:AbortSignal,cameraPath?:ShotCameraPath,cropReason:CameraCropReason="provider-has-no-native-camera"):Promise<VideoClip>{
  let scratch:string|undefined;
  try{const path=cameraPath?cameraPathSettings(cameraPath):undefined,value=path?sampleCameraPath(path,0,Math.round(clip.durationSec*fps)):framingSettings(framing);if(!path&&!isCropped(value))return clip;
    const [width,height]=parseFrameSize(size);scratch=mkdtempSync(join(dirname(clip.path),".hv-framing-"));
    const target=join(scratch,"framed.mp4");await command(["ffmpeg","-y","-v","error","-i",clip.path,"-map","0:v:0","-map","0:a?","-vf",`fps=${fps},`+(path?cameraPathFilter(path,width,height,fps,Math.round(clip.durationSec*fps)):framingFilter(value,width,height)),
      "-frames:v",String(Math.round(clip.durationSec*fps)),"-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-c:a","copy","-fflags","+bitexact","-flags:v","+bitexact","-map_metadata","-1",target],signal);
    let posterPath=clip.posterPath,sourcePosterPath=clip.sourcePosterPath;
    if(posterPath){const cropped=join(scratch,"poster.png");await frameImage(posterPath,cropped,value,size,signal);sourcePosterPath=posterPath;posterPath=clip.path+".framed.png";renameSync(cropped,posterPath);}
    signal?.throwIfAborted();renameSync(target,clip.path);
    return {...clip,posterPath,sourcePosterPath,...(path?{cameraPathControl:{mode:"screen-space" as const,keyframes:path.keyframes,outputFrames:Math.round(clip.durationSec*fps),applied:"local-crop" as const,reason:cropReason}}:{framing:value}),fingerprint:frameFingerprint(clip.path,clip.durationSec/2)};
  }catch(error){if(signal?.aborted)throw signal.reason;if(error instanceof FramingError)throw error;throw new FramingError("Local framing failed after generation. The paid request will not be repeated automatically.",{cause:error});}
  // Project retention also removes this scratch directory. Never replace a result or cost-bearing error.
  finally{if(scratch)try{rmSync(scratch,{recursive:true,force:true});}catch {}}
}
