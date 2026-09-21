import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,existsSync,readdirSync,statSync} from "node:fs";
import {join,dirname,resolve} from "node:path";
import {animaticCommand,ShotDurationError} from "./animatic";
import {compilePerformances,spokenText,PerformanceError,type PerformanceLine,type SpeechReport} from "../../planner/src/performances";
import type {DialogueBlock} from "../../planner/src/captions";

const hash=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const executable=()=>process.env.HV_ESPEAK_PATH??Bun.which("espeak-ng")??"espeak-ng";
/** Pinned in the provider capability and the audio receipt; never exposed as a local path. */
export function speechRuntimeRevision():string {
  const exe=executable(),root=process.env.HV_ESPEAK_DATA_PATH;
  const files:string[]=[];const walk=(path:string)=>{if(!existsSync(path))return;if(statSync(path).isDirectory())for(const name of readdirSync(path).sort())walk(join(path,name));else files.push(path);};
  walk(exe);if(root){walk(join(root,"espeak-ng-data"));walk(join(dirname(exe),"libespeak-ng.dll"));}
  // Linux distributions store the voice data alongside libespeak-ng. Include it when available.
  if(!root&&process.platform!=="win32")for(const path of ["/usr/lib/x86_64-linux-gnu/espeak-ng-data","/usr/share/espeak-ng-data","/usr/lib/aarch64-linux-gnu/espeak-ng-data","/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1","/usr/lib/aarch64-linux-gnu/libespeak-ng.so.1"])walk(path);
  if(!files.length)return "espeak-unavailable";
  return "espeak-"+hash(files.map(file=>(file===exe?"executable":root&&file.startsWith(root)?file.slice(root.length+1):file.replace(/^.*?(espeak-ng-data[/\\])/,"$1"))+":"+hash(readFileSync(file))).join("\n"));
}
export function speechWavHeader(samples:number):Buffer {if(!Number.isSafeInteger(samples)||samples<0||samples*2>0xffffffff-36)throw new PerformanceError("Dialogue exceeds the WAV size limit.");const b=Buffer.alloc(44);b.write("RIFF");b.writeUInt32LE(36+samples*2,4);b.write("WAVEfmt ",8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(22050,24);b.writeUInt32LE(44100,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(samples*2,40);return b;}
function wav(pcm:Buffer):Buffer {return Buffer.concat([speechWavHeader(pcm.length/2),pcm]);}
async function synthesize(scratch:string,dialogue:DialogueBlock[],input:PerformanceLine[]|undefined,fps:number,frames:number,exactDuration:boolean|undefined,narration:boolean|undefined,signal?:AbortSignal,expectedRuntime?:string){
  if(input?.length&&!narration)throw new PerformanceError("Enable temporary speech to render the assigned voices and line performances.");
  if(!narration)return {voice:false,frames,durationSec:frames/fps};
  const lines=compilePerformances(dialogue,input),parts:Buffer[]=[],report:SpeechReport={schema:"hv-speech/1",engine:"espeak-ng",engineVersion:speechRuntimeRevision(),sampleRate:22050,totalSamples:0,lines:[]};
  if(!lines.length)return {voice:false,frames,durationSec:frames/fps};
  if(expectedRuntime&&report.engineVersion!==expectedRuntime)throw new PerformanceError("The speech runtime changed after admission. Start a new render with the current worker.");
  if(report.engineVersion==="espeak-unavailable")throw new PerformanceError("Install eSpeak NG on the worker to generate temporary character speech.");
  const silence=(ms:number)=>{const samples=Math.round(ms*22050/1000);parts.push(Buffer.alloc(samples*2));report.totalSamples+=samples;};
  for(const [i,line]of lines.entries()){
    signal?.throwIfAborted();const text=spokenText(line);if(!text||text.length>20000)throw new PerformanceError("Split the dialogue into lines of at most 20000 characters.");
    writeFileSync(join(scratch,`line-${i}.txt`),text);
    const root=process.env.HV_ESPEAK_DATA_PATH;
    await animaticCommand([executable(),...(root?["--path="+resolve(root)]:[]),"-b","1","-v",line.voice.voice,"-s",String(line.voice.rateWpm),"-p",String(line.voice.pitch),"-a",String(line.voice.level),"-z","-f",`line-${i}.txt`,"-w",`line-${i}.wav`],scratch,signal);
    await animaticCommand(["ffmpeg","-v","error","-y","-i",`line-${i}.wav`,"-ac","1","-ar","22050","-f","s16le",`line-${i}.pcm`],scratch,signal);
    const pcm=readFileSync(join(scratch,`line-${i}.pcm`));if(!pcm.length||pcm.length%2||pcm.length>22050*2*600)throw new PerformanceError("The speech engine returned invalid line audio.");
    silence(line.beforeMs);const startSample=report.totalSamples;parts.push(pcm);report.totalSamples+=pcm.length/2;
    report.lines.push({...line,spokenText:text,startSample,endSample:report.totalSamples,pcmSha256:hash(pcm)});silence(line.afterMs);
    const required=Math.ceil((report.totalSamples/22050+.3)*fps);
    // HV-030-05: the measurement is in hand, so the refusal states it. "Increase the duration" alone
    // left the creator guessing at a number only this loop knows; the seconds named here are rounded
    // up to the tenth the editor accepts, so setting exactly what it asks for fits.
    if(exactDuration&&required>frames)throw new ShotDurationError("Temporary dialogue needs "+(Math.ceil(required/fps*10)/10).toFixed(1)+" s and this shot is set to "+(frames/fps).toFixed(1)+" s. Set the duration to at least "+(Math.ceil(required/fps*10)/10).toFixed(1)+" s, shorten the dialogue, or use automatic duration; no image was requested.");
    if(required>600*fps)throw new PerformanceError("Split this shot into coverage with less than ten minutes of dialogue.");
  }
  if(report.engineVersion!==speechRuntimeRevision())throw new PerformanceError("The local speech engine changed while rendering. Retry with a stable worker runtime.");
  frames=Math.max(frames,Math.ceil((report.totalSamples/22050+.3)*fps));
  writeFileSync(join(scratch,"voice.wav"),wav(Buffer.concat(parts)));
  return {voice:true,frames,durationSec:frames/fps,speech:report};
}

export async function synthesizeLines(...args:Parameters<typeof synthesize>):Promise<Awaited<ReturnType<typeof synthesize>>>{
  try{return await synthesize(...args);}catch(error){args[7]?.throwIfAborted();if(error instanceof PerformanceError||error instanceof ShotDurationError||(error as Error).name==="SafetyRefusal")throw error;throw new PerformanceError("Temporary line synthesis failed before image generation. Check the worker's eSpeak NG installation and retry.");}
}
