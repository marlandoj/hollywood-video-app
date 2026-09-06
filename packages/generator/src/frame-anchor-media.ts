export class FrameAnchorError extends Error {override name="FrameAnchorError";}
async function run(args:string[],signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();let child:ReturnType<typeof Bun.spawn>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const abort=()=>child?.kill("SIGKILL");
  try{child=Bun.spawn(args,{stdout:"pipe",stderr:"pipe"});timer=setTimeout(abort,60_000);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
    const [code,output,error]=await Promise.all([child.exited,new Response(child.stdout as ReadableStream).text(),new Response(child.stderr as ReadableStream).text()]);
    signal?.throwIfAborted();if(code!==0)throw new FrameAnchorError("Frame anchor media could not be processed. The paid request will not be repeated automatically. "+error.slice(-200));return output;
  }catch(error){if(signal?.aborted)throw signal.reason;if(error instanceof FrameAnchorError)throw error;throw new FrameAnchorError("Frame anchor media could not be processed. The paid request will not be repeated automatically.",{cause:error});}
  finally{if(timer)clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
/** Distributes decoded frames over the full target duration instead of trimming an anchored ending. */
export async function normalizeAnchoredClip(rawPath:string,outPath:string,target:{width:number;height:number;fps:number;durationSec:number},signal?:AbortSignal):Promise<{sourceFrames:number;outputFrames:number}> {
  if(![target.width,target.height].every(n=>Number.isInteger(n)&&n>=16&&n<=4096&&n%2===0)||!Number.isInteger(target.fps)||target.fps<1||target.fps>60||!Number.isFinite(target.durationSec)||target.durationSec<.1||target.durationSec>600)
    throw new FrameAnchorError("Invalid target dimensions or timing for frame anchors.");
  let sourceFrames:number;
  try{const probe=JSON.parse(await run(["ffprobe","-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames","-of","json",rawPath],signal));
    sourceFrames=Number(probe.streams?.[0]?.nb_read_frames);
    if(!Number.isSafeInteger(sourceFrames)||sourceFrames<2||sourceFrames>36000)throw new FrameAnchorError("An anchored source must contain two to 36000 decoded video frames.");
  }catch(error){if(signal?.aborted)throw signal.reason;if(error instanceof FrameAnchorError)throw error;throw new FrameAnchorError("The anchored source frame count could not be read.",{cause:error});}
  const outputFrames=Math.round(target.fps*target.durationSec);if(outputFrames<2)throw new FrameAnchorError("An anchored output must contain at least two frames.");
  const filter=[`setpts=N*(${outputFrames}-1)/(${sourceFrames}-1)/(${target.fps}*TB)`,
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
    `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`,"setsar=1",
    `fps=fps=${target.fps}:round=near`,`tpad=stop_mode=clone:stop_duration=${1/target.fps}`].join(",");
  await run(["ffmpeg","-y","-v","error","-i",rawPath,"-map","0:v:0","-an","-vf",filter,"-frames:v",String(outputFrames),
    "-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-fflags","+bitexact","-flags:v","+bitexact","-map_metadata","-1",outPath],signal);
  return {sourceFrames,outputFrames};
}
