import {audioPcmHash} from "./audio-delivery";
import {speechWavHeader} from "./speech";
import {contentHash} from "./capabilities";
import {validateAudioTimeline,type AudioTimelineReport} from "../../planner/src/audio-timeline";
import {AudioPerformanceError} from "../../planner/src/audio-performances";
import {NARRATION_MIX_RECIPE,NARRATION_MIX_RECIPE_REVISION,type NarrationTrack,type NarrationMixReport} from "../../planner/src/narration-mix";

export interface NarrationAudio {cueId:string;pcm:Buffer;report:AudioTimelineReport}
/** Integer gains and bounded chunks keep summing/envelopes deterministic.
 * The dry dialogue is never modified. No limiter or loudness qualification is implied. */
export async function mixNarrationPCM(dry:Buffer,track:NarrationTrack,reads:NarrationAudio[],assertAccess:()=>Promise<void>=async()=>{},signal?:AbortSignal):Promise<{mix:Buffer;narration:Buffer;ducked:Buffer;peaks:NarrationMixReport["peaks"]}> {
  const total=dry.length/2,scale=NARRATION_MIX_RECIPE.gainScale;
  if(!Number.isInteger(total)||total<1||total>22050*3600||reads.length!==track.cues.length)throw new AudioPerformanceError("Invalid narration mix media length.");
  const cues=track.cues.map((cue,i)=>{const read=reads[i];if(!read||read.cueId!==cue.id||contentHash(read.report.source)!==contentHash(cue.audition.output.report))throw new AudioPerformanceError("Narration audio does not match the reviewed cue.");
    validateAudioTimeline(read.report,read.pcm);if(cue.startSample+read.report.totalSamples>total)throw new AudioPerformanceError("The complete narration must fit the picture.");
    const start=cue.startSample+read.report.speechStartSample,end=cue.startSample+read.report.speechEndSample;
    return {cue,read,start,end,attack:Math.max(0,start-Math.round(cue.attackMs*22050/1000)),release:Math.min(total,end+Math.round(cue.releaseMs*22050/1000)),gain:Math.round(10**(cue.gainDb/20)*scale),duck:Math.round(10**(cue.duckDb/20)*scale)};
  });
  const mix=Buffer.alloc(dry.length),narration=Buffer.alloc(dry.length),ducked=Buffer.alloc(dry.length),peaks={mix:0,narration:0,ducked:0};
  const sample=(v:number)=>{const n=Math.round(v/scale);if(n>32767||n< -32768)throw new AudioPerformanceError("The reviewed narration mix would clip. Lower narration gain or increase ducking, then review a new mix.");return n;};
  for(let offset=0;offset<total;offset+=65536){const count=Math.min(65536,total-offset),bedGain=new Int32Array(count).fill(scale),voice=new Float64Array(count);
    if(offset%(65536*16)===0){signal?.throwIfAborted();await assertAccess();await Bun.sleep(0);}
    for(const {cue,read,start,end,attack,release,gain,duck}of cues){
      for(let t=Math.max(offset,attack);t<Math.min(offset+count,release);t++){
        const value=t<start?scale-Math.round((scale-duck)*(t-attack)/(start-attack)):t>=end?duck+Math.round((scale-duck)*(t-end)/(release-end)):duck;
        bedGain[t-offset]=Math.min(bedGain[t-offset]!,value);
      }
      for(let t=Math.max(offset,cue.startSample);t<Math.min(offset+count,cue.startSample+read.report.totalSamples);t++)voice[t-offset]!+=read.pcm.readInt16LE((t-cue.startSample)*2)*gain;
    }
    for(let i=0;i<count;i++){
      const pos=(offset+i)*2,bed=dry.readInt16LE(pos)*bedGain[i]!,n=sample(voice[i]!),d=sample(bed),m=sample(bed+voice[i]!);
      narration.writeInt16LE(n,pos);ducked.writeInt16LE(d,pos);mix.writeInt16LE(m,pos);peaks.narration=Math.max(peaks.narration,Math.abs(n));peaks.ducked=Math.max(peaks.ducked,Math.abs(d));peaks.mix=Math.max(peaks.mix,Math.abs(m));
    }
  }
  return {mix,narration,ducked,peaks};
}
export function narrationWav(pcm:Buffer):Buffer{return Buffer.concat([speechWavHeader(pcm.length/2),pcm]);}
export function narrationMixReport(track:NarrationTrack,dryWav:Buffer,reads:NarrationAudio[],mixed:Awaited<ReturnType<typeof mixNarrationPCM>>):NarrationMixReport {
  const data={schema:"hv-narration-mix/1" as const,track:structuredClone(track),recipeRevision:NARRATION_MIX_RECIPE_REVISION,totalSamples:(dryWav.length-44)/2,sourceAudioSha256:audioPcmHash(dryWav),
    conversions:reads.map(r=>({cueId:r.cueId,report:r.report})),mixWavSha256:audioPcmHash(narrationWav(mixed.mix)),narrationWavSha256:audioPcmHash(narrationWav(mixed.narration)),duckedWavSha256:audioPcmHash(narrationWav(mixed.ducked)),peaks:mixed.peaks};
  return {...data,revision:contentHash(data)};
}
