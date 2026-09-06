import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {contentHash} from "./capabilities";
import {verifyAudioWav} from "./audio-media";
import {audioPcmHash,type AudioLineDelivery} from "./audio-delivery";
import {speechWavHeader} from "./speech";
import {AudioPerformanceError} from "../../planner/src/audio-performances";
import {AUDIO_TIMELINE_RECIPE_REVISION,assertAudioTimelineWindow,createAudioTimelineReport,timelineSampleCounts,type AudioTimelineReport} from "../../planner/src/audio-timeline";

/** Fingerprint the actual FFmpeg build and fixed conversion recipe at admission and execution. */
export function audioTimelineRuntimeRevision():string{
  try{const result=Bun.spawnSync(["ffmpeg","-version"],{stdin:"ignore",stdout:"pipe",stderr:"pipe",timeout:10000});
    if(result.exitCode!==0||!result.stdout.toString().startsWith("ffmpeg version "))throw new Error();
    return "ffmpeg-audio-"+contentHash({runtime:result.stdout.toString().replace(/\r\n/g,"\n"),recipe:AUDIO_TIMELINE_RECIPE_REVISION});
  }catch{throw new AudioPerformanceError("Install a supported FFmpeg audio conversion runtime before applying an audition.");}
}
function removeScratch(root:string,scratch:string):void{
  if(!scratch.startsWith(root+sep)||realpathSync(scratch)!==scratch)throw new AudioPerformanceError("The conversion scratch directory escaped its workspace.");
  rmSync(scratch,{recursive:true,force:true});
}
/** Local conversion only. No provider, account, job admission or billing side effects. */
export async function convertAudioToTimeline(wav:Buffer,source:AudioLineDelivery,cwd:string,engineVersion:string,
  availableSamples:number,assertAccess:()=>Promise<void>,signal?:AbortSignal):Promise<{wav:Buffer;pcm:Buffer;report:AudioTimelineReport}>{
  signal?.throwIfAborted();verifyAudioWav(wav,source);assertAudioTimelineWindow(source,availableSamples);
  if(engineVersion!==audioTimelineRuntimeRevision())throw new AudioPerformanceError("The audio conversion runtime changed. Review the retained take again.");
  await assertAccess();signal?.throwIfAborted();
  const root=realpathSync(cwd),scratch=mkdtempSync(join(root,".audio-resample-"));
  try{
    const original=Buffer.from(wav),counts=timelineSampleCounts(source);
    writeFileSync(join(scratch,"speech.pcm"),original.subarray(44+source.speechStartSample*2,44+source.speechEndSample*2),{flag:"wx"});
    // Explicit zero extension flushes the filter for even one-sample inputs.
    // Trimming is only to the rational conversion length, never to a film window.
    const filter=`apad=pad_len=128,aresample=22050:resampler=swr:filter_size=64:phase_shift=10:exact_rational=1:dither_method=none,atrim=end_sample=${counts.speech}`;
    const child=Bun.spawn(["ffmpeg","-v","error","-nostdin","-f","s16le","-ar","48000","-ac","1","-i","speech.pcm","-af",filter,"-c:a","pcm_s16le","-f","s16le","speech-22050.pcm"],{cwd:scratch,stdin:"ignore",stdout:"ignore",stderr:"pipe"});
    let timedOut=false;const abort=()=>child.kill("SIGKILL"),timer=setTimeout(()=>{timedOut=true;abort();},120000);signal?.addEventListener("abort",abort,{once:true});
    try{if(signal?.aborted)abort();const [code]=await Promise.all([child.exited,new Response(child.stderr).text()]);signal?.throwIfAborted();
      if(timedOut||code!==0)throw new AudioPerformanceError(timedOut?"Audio conversion timed out. The audition and picture remain unchanged.":"FFmpeg could not convert the retained audition. Its original audio is unchanged.");
    }finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
    const speech=readFileSync(join(scratch,"speech-22050.pcm"));if(speech.length!==counts.speech*2)throw new AudioPerformanceError("Audio conversion returned an unexpected sample count.");
    const pcm=Buffer.concat([Buffer.alloc(counts.before*2),speech,Buffer.alloc(counts.after*2)]);
    if(engineVersion!==audioTimelineRuntimeRevision())throw new AudioPerformanceError("The audio conversion runtime changed during processing.");
    await assertAccess();signal?.throwIfAborted();
    const report=createAudioTimelineReport(source,audioPcmHash(original),engineVersion,pcm);
    return {wav:Buffer.concat([speechWavHeader(counts.total),pcm]),pcm,report};
  }finally{removeScratch(root,scratch);}
}
