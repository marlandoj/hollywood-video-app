import {SOUND_MIX_RECIPE,SOUND_STEMS,type SoundSession,type SoundStem} from "../../planner/src/sound-session";
import {SOUND_FRAME_BYTES,soundFail} from "../../planner/src/sound-assets";
export interface VoiceWindow {start:number;end:number}
export type SoundChunks=Record<SoundStem,Buffer>;
/** Streams deterministic 24-bit stereo stems. Existing voice timing remains fixed. */
export async function mixSoundSession(session:SoundSession,readVoice:(stem:"dialogue"|"narration",offset:number,frames:number)=>Buffer,recordings:Map<string,Buffer>,windows:VoiceWindow[],write:(offset:number,chunks:SoundChunks)=>Promise<void>,assertAccess:()=>Promise<void>=async()=>{},signal?:AbortSignal):Promise<Record<SoundStem,number>>{
  const scale=SOUND_MIX_RECIPE.gainScale,peaks=Object.fromEntries(SOUND_STEMS.map(s=>[s,0])) as Record<SoundStem,number>,voices={dialogue:Math.round(10**(session.dialogueGainDb/20)*scale),narration:Math.round(10**(session.narrationGainDb/20)*scale)};
  for(const w of windows)if(!Number.isSafeInteger(w.start)||!Number.isSafeInteger(w.end)||w.start<0||w.end<=w.start||w.end>session.totalFrames)soundFail("A measured voice window escaped the sound timeline.");
  const cues=session.cues.map(cue=>{const pcm=recordings.get(cue.asset.id);if(!pcm||pcm.length!==cue.asset.audio.frames*SOUND_FRAME_BYTES)soundFail("A sound cue lost its recorded waveform.");return {cue,pcm,gain:10**(cue.gainDb/20),duck:Math.round(10**(cue.duckDb/20)*scale)};});
  const sample=(v:number)=>{const n=Math.round(v/scale);if(n< -8388608||n>8388607)soundFail("The sound mix or a retained stem would clip. Lower the cue or voice levels, then review again.");return n;};
  for(let offset=0;offset<session.totalFrames;offset+=65536){signal?.throwIfAborted();if(offset%(65536*16)===0){await assertAccess();await Bun.sleep(0);}const frames=Math.min(65536,session.totalFrames-offset),weighted=Object.fromEntries(SOUND_STEMS.map(s=>[s,new Float64Array(frames*2)])) as Record<SoundStem,Float64Array>;
    for(const stem of ["dialogue","narration"] as const){const pcm=readVoice(stem,offset,frames);if(pcm.length!==frames*SOUND_FRAME_BYTES)soundFail("A voice stem changed length.");for(let i=0;i<frames*2;i++)weighted[stem][i]=pcm.readIntLE(i*3,3)*voices[stem];}
    for(const {cue,pcm,gain,duck}of cues){const first=Math.max(offset,cue.start),last=Math.min(offset+frames,cue.start+cue.frames);if(first>=last)continue;const envelope=new Int32Array(last-first).fill(scale);
      if(duck<scale)for(const window of windows){const start=Math.max(0,window.start-cue.duckAttack),end=Math.min(session.totalFrames,window.end+cue.duckRelease);for(let t=Math.max(first,start);t<Math.min(last,end);t++){
        const value=t<window.start?scale-Math.round((scale-duck)*(t-start)/(window.start-start)):t>=window.end?duck+Math.round((scale-duck)*(t-window.end)/(end-window.end)):duck;envelope[t-first]=Math.min(envelope[t-first]!,value);}}
      for(let t=first;t<last;t++){const pos=t-cue.start,source=(cue.trimIn+pos%(cue.trimOut-cue.trimIn))*SOUND_FRAME_BYTES,fade=Math.min(1,cue.fadeIn?pos/cue.fadeIn:1,cue.fadeOut?(cue.frames-1-pos)/cue.fadeOut:1),coefficient=gain*fade*envelope[t-first]!;
        const left=Math.round(coefficient*(cue.balance>0?1-cue.balance:1)),right=Math.round(coefficient*(cue.balance<0?1+cue.balance:1)),i=(t-offset)*2;weighted[cue.role][i]!+=pcm.readIntLE(source,3)*left;weighted[cue.role][i+1]!+=pcm.readIntLE(source+3,3)*right;}
    }
    const chunks=Object.fromEntries(SOUND_STEMS.map(s=>[s,Buffer.alloc(frames*SOUND_FRAME_BYTES)])) as SoundChunks;
    for(let i=0;i<frames*2;i++){weighted.me[i]=weighted.music[i]!+weighted.ambience[i]!+weighted.effects[i]!;weighted.mix[i]=weighted.dialogue[i]!+weighted.narration[i]!+weighted.me[i]!;for(const stem of SOUND_STEMS){const value=sample(weighted[stem][i]!);chunks[stem].writeIntLE(value,i*3,3);peaks[stem]=Math.max(peaks[stem],Math.abs(value));}}
    await write(offset,chunks);
  }
  signal?.throwIfAborted();await assertAccess();return peaks;
}
