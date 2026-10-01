/**
 * HV-024-12: renders one of the studio's ambience presets as a seamless 48 kHz stereo 24-bit loop.
 * FFmpeg makes the sound from seeded noise sources (one per channel, so the bed is wide), the
 * preset's fixed filters and, where the preset has one, a tone. This code then lays the loop's tail
 * over its head with an equal-power crossfade, so the loop repeats without a click, and scales the
 * result to the recipe's peak, less the preset's trim. The same recipe, preset and FFmpeg runtime give the same bytes.
 */
import {mkdtempSync,readFileSync,realpathSync,rmSync} from "node:fs";
import {join,sep} from "node:path";
import {AMBIENCE_RECIPE,ambiencePreset,type AmbiencePreset} from "../../planner/src/sound-ambience";
import {SOUND_FRAME_BYTES,soundFail} from "../../planner/src/sound-assets";
import {soundCommand,soundWav} from "./sound-audio";

/** The FFmpeg filter graph for a preset, rendering `frames` stereo frames into [out]. */
export function ambienceFilter(preset:AmbiencePreset,frames:number):string{
  if(!Number.isSafeInteger(frames)||frames<1)soundFail("Invalid ambience length.");
  const {sampleRate,sourceAmplitude}=AMBIENCE_RECIPE,noise=(seed:number,label:string)=>`anoisesrc=r=${sampleRate}:c=${preset.color}:seed=${seed}:a=${sourceAmplitude},${preset.channel}[${label}]`;
  const graph=[noise(preset.seed,"n0"),noise(preset.seed+1,"n1"),"[n0][n1]join=inputs=2:channel_layout=stereo[noise]"];let last="noise";
  if(preset.tone){graph.push(`sine=f=${preset.tone.hz}:r=${sampleRate},${preset.tone.filter},pan=stereo|c0=c0|c1=c0[tone]`,`[noise][tone]amix=inputs=2:weights=1 ${preset.tone.weight}:normalize=0[mixed]`);last="mixed";}
  graph.push(`[${last}]${preset.bed?preset.bed+",":""}atrim=end_sample=${frames},aformat=sample_fmts=s32:channel_layouts=stereo[out]`);
  return graph.join(";");
}

/** The bed as a canonical WAV of exactly AMBIENCE_RECIPE.loopFrames frames. Takes a catalogue id, or a preset (tests vary its seed). */
export async function renderAmbience(presetOrId:string|AmbiencePreset,cwd:string,signal?:AbortSignal):Promise<Buffer>{
  const preset=typeof presetOrId==="string"?ambiencePreset(presetOrId):presetOrId,{loopFrames,crossfadeFrames,peakDbfs}=AMBIENCE_RECIPE,frames=loopFrames+crossfadeFrames,root=realpathSync(cwd),scratch=mkdtempSync(join(root,".ambience-"));
  try{
    await soundCommand(["ffmpeg","-v","error","-nostdin","-filter_threads","1","-filter_complex_threads","1","-filter_complex",ambienceFilter(preset,frames),"-map","[out]","-c:a","pcm_s24le","-f","s24le","bed.pcm"],scratch,signal);
    const raw=readFileSync(join(scratch,"bed.pcm"));if(raw.length!==frames*SOUND_FRAME_BYTES)soundFail("The ambience render changed length.");
    const samples=new Float64Array(loopFrames*2);
    for(let i=0;i<loopFrames;i++)for(let ch=0;ch<2;ch++){let value=raw.readIntLE((i*2+ch)*3,3);
      if(i<crossfadeFrames){const t=(i+0.5)/crossfadeFrames;value=value*Math.sin(Math.PI/2*t)+raw.readIntLE(((loopFrames+i)*2+ch)*3,3)*Math.cos(Math.PI/2*t);}
      samples[i*2+ch]=value;}
    let peak=0;for(const value of samples)peak=Math.max(peak,Math.abs(value));if(!peak)soundFail("The ambience render was silent.");
    const scale=Math.round(8388607*10**((peakDbfs+Math.min(0,preset.trimDb))/20))/peak,pcm=Buffer.alloc(loopFrames*SOUND_FRAME_BYTES);
    for(let i=0;i<samples.length;i++)pcm.writeIntLE(Math.round(samples[i]!*scale),i*3,3);
    return soundWav(pcm);
  }finally{if(!scratch.startsWith(root+sep)||realpathSync(scratch)!==scratch)soundFail("The ambience scratch directory escaped its workspace.");rmSync(scratch,{recursive:true,force:true});}
}
