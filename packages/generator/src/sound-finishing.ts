import {createHash} from "node:crypto";
import {appendFileSync,copyFileSync,readFileSync,rmSync,statSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {contentHash} from "./capabilities";
import {soundWavHeader,soundRuntimeRevision} from "./sound-audio";
import {soundFail} from "../../planner/src/sound-assets";
import {SOUND_FINISH_RECIPE,soundFinishing,soundTargetsMet,validateSoundLoudness,type SoundFinishing,type SoundLoudness,type SoundFinishingReport} from "../../planner/src/sound-finishing";

type Norm=Record<string,string>;
type Access=()=>Promise<void>;
/** Local subprocess with bounded diagnostics, cancellation, and periodic lease/permission checks. */
export async function soundProcessingCommand(args:string[],cwd:string,access:Access,signal?:AbortSignal):Promise<string>{
  await access();signal?.throwIfAborted();const child=Bun.spawn(args,{cwd,stdin:"ignore",stdout:"ignore",stderr:"pipe"});let failure:unknown;
  const abort=()=>child.kill("SIGKILL"),timer=setTimeout(()=>{failure=new Error("Sound finishing timed out.");abort();},20*60*1000);
  let pending:Promise<void>|undefined;const lease=setInterval(()=>{if(pending)return;pending=access().catch(e=>{failure=e;abort();}).finally(()=>{pending=undefined;});},2000);
  signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  try{const chunks:Uint8Array[]=[];let bytes=0;for await(const part of child.stderr){bytes+=part.length;if(bytes>1024*1024){failure=new Error("Sound finishing diagnostics exceeded their limit.");abort();break;}chunks.push(part);}const code=await child.exited;clearInterval(lease);await pending;signal?.throwIfAborted();if(failure)throw failure;const log=Buffer.concat(chunks).toString();if(code!==0)soundFail("Sound finishing failed: "+log.slice(-500));await access();return log;}
  finally{clearTimeout(timer);clearInterval(lease);signal?.removeEventListener("abort",abort);await pending;}
}
const hash=async(path:string,signal?:AbortSignal)=>{const h=createHash("sha256");for await(const b of Bun.file(path).stream()){signal?.throwIfAborted();h.update(b);}return h.digest("hex");};
const numeric=(value:unknown):number|null=>{if(value==="-inf")return null;if(typeof value!=="string"||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)||!Number.isFinite(Number(value)))soundFail("The loudness meter returned an invalid value: "+String(value).slice(0,30));return Number(value);};
function normFromLog(log:string):Norm{const matches=[...log.matchAll(/\{\s*"input_i"[\s\S]*?\}/g)];if(matches.length!==1)soundFail("The loudness meter did not return one complete measurement.");const data=JSON.parse(matches[0]![0]);for(const key of ["input_i","input_tp","input_lra","input_thresh"])numeric(data[key]);return data;}
const boundedText=(path:string)=>{if(statSync(path).size>32*1024**2)soundFail("A loudness report exceeds its limit.");return readFileSync(path,"utf8");};
/** Keep nonfinite silence out of JSON measurements and discard incomplete M/S windows. */
export function readSoundMeasurement(directory:string,tag:string,frames:number):SoundLoudness{
  const n=JSON.parse(boundedText(join(directory,tag+"-loudnorm.json"))) as Norm,raw=boundedText(join(directory,tag+"-windows.txt"));
  const windows=raw.split(/(?=frame:)/).filter(Boolean);let previous=-1,momentary:number|null=null,short:number|null=null,unavailableMomentaryWindows=0,unavailableShortTermWindows=0;
  for(const window of windows){const header=/^frame:\d+\s+pts:(\d+)\s+pts_time:/.exec(window);if(!header)soundFail("A loudness window lost its sample position.");const start=Number(header[1]);if(previous!==-1&&start!==previous+4800||previous===-1&&start!==0||start>=frames)soundFail("Loudness windows changed order or timing.");previous=start;
    const value=(key:string)=>{const match=window.split(/\r?\n/).find(line=>line.startsWith("lavfi.r128."+key+"="));if(!match)soundFail("A loudness window is incomplete.");const raw=match.split("=")[1]!;return /^[-+]?nan$/i.test(raw)?"unavailable":numeric(raw);};
    const m=value("M"),s=value("S"),end=Math.min(start+4800,frames);if(end>=19200){if(m==="unavailable")unavailableMomentaryWindows++;else if(m!==null)momentary=Math.max(momentary??-Infinity,m);}if(end>=144000){if(s==="unavailable")unavailableShortTermWindows++;else if(s!==null)short=Math.max(short??-Infinity,s);}
  }
  const completed=Math.floor(frames/4800);if(windows.length!==completed||previous!==(completed?4800*(completed-1):-1))soundFail("The loudness meter did not cover every complete 100 ms window.");
  const i=numeric(n.input_i),tp=numeric(n.input_tp),lra=numeric(n.input_lra),gate=numeric(n.input_thresh),silent=tp===null;
  const result:SoundLoudness={schema:"hv-sound-loudness/1",frames,integratedLufs:frames<19200?null:i,truePeakDbtp:tp,rangeLu:frames<144000||i===null?null:lra,relativeGateLufs:i===null?null:gate,momentaryMaxLufs:silent?null:momentary,shortTermMaxLufs:silent?null:short,rangeStable:frames>=48000*60,silent,unavailableMomentaryWindows,unavailableShortTermWindows};validateSoundLoudness(result,frames);return result;
}
function filterTarget(settings:SoundFinishing):string{return settings.mode==="normalize"?`I=${settings.targetLufs}:TP=${settings.ceilingDbtp}:LRA=${settings.rangeLu}`:"I=-23:TP=-2:LRA=7";}
function processingFilter(settings:SoundFinishing,n:Norm,frames:number):string|null{
  if(settings.mode==="measure")return null;
  const i=numeric(n.input_i),tp=numeric(n.input_tp),lra=numeric(n.input_lra),gate=numeric(n.input_thresh);
  if(i===null||tp===null||lra===null||gate===null||frames<144000)soundFail("Normalization needs at least three seconds of audio above the loudness gate. Use measurement only for silence, very quiet or shorter material.");
  if(settings.targetLufs-i>SOUND_FINISH_RECIPE.maximumGainDb)soundFail("This target would raise the mix by more than 20 dB. Balance the source levels or choose a lower target, then review again.");
  const offset=numeric(n.target_offset);if(offset===null)soundFail("The normalizer returned no gain offset.");
  return `loudnorm=${filterTarget(settings)}:measured_I=${i}:measured_TP=${tp}:measured_LRA=${lra}:measured_thresh=${gate}:offset=${offset}:linear=true:print_format=json,aresample=48000:dither_method=none,apad=whole_len=${frames},atrim=end_sample=${frames}`;
}
export async function measureSound(path:string,frames:number,directory:string,tag:"before"|"after"|"encoded",access:Access,signal?:AbortSignal,settings:SoundFinishing={schema:"hv-sound-finishing/1",mode:"measure"}):Promise<SoundLoudness>{
  const common=["ffmpeg","-hide_banner","-nostdin","-nostats","-protocol_whitelist","file,pipe","-i",path,"-map","0:a:0"],trim=`atrim=end_sample=${frames},asetpts=N/SR/TB`;
  const log=await soundProcessingCommand([...common,"-af",trim+",loudnorm="+filterTarget(settings)+":print_format=json","-f","null","-"],directory,access,signal),n=normFromLog(log);writeFileSync(join(directory,tag+"-loudnorm.json"),JSON.stringify(n,null,2)+"\n",{flag:"wx"});
  await soundProcessingCommand([...common,"-v","error","-af",trim+`,ebur128=metadata=1:peak=true,ametadata=print:file=${tag}-windows.txt`,"-f","null","-"],directory,access,signal);
  return readSoundMeasurement(directory,tag,frames);
}
export async function finishSoundMaster(input:string,frames:number,directory:string,settings:SoundFinishing,access:Access,signal?:AbortSignal){
  soundFinishing(settings);const engineVersion=soundRuntimeRevision(),before=await measureSound(input,frames,directory,"before",access,signal,settings),n=JSON.parse(boundedText(join(directory,"before-loudnorm.json"))) as Norm,filter=processingFilter(settings,n,frames),master=join(directory,"master.wav");let mode:SoundFinishingReport["mode"]="measure",statistics:Norm|null=null;
  if(filter){const pcm=join(directory,"master.pcm"),log=await soundProcessingCommand(["ffmpeg","-hide_banner","-nostdin","-nostats","-protocol_whitelist","file,pipe","-i",input,"-map","0:a:0","-af",filter,"-ar","48000","-ac","2","-c:a","pcm_s24le","-f","s24le",pcm],directory,access,signal);statistics=normFromLog(log);if(!["linear","dynamic"].includes(statistics.normalization_type!))soundFail("The normalizer did not identify its applied mode.");mode=statistics.normalization_type as "linear"|"dynamic";if(statSync(pcm).size!==frames*6)soundFail("Sound finishing changed the sample count.");writeFileSync(master,soundWavHeader(frames),{flag:"wx"});for await(const b of Bun.file(pcm).stream()){signal?.throwIfAborted();appendFileSync(master,b);}rmSync(pcm);
  }else copyFileSync(input,master,1);
  writeFileSync(join(directory,"processing.json"),JSON.stringify({schema:"hv-sound-processing/1",mode,filter,statistics},null,2)+"\n",{flag:"wx"});
  const after=await measureSound(master,frames,directory,"after",access,signal);if(engineVersion!==soundRuntimeRevision())soundFail("The sound finishing runtime changed.");
  return {settings,engineVersion,inputSha256:await hash(input,signal),masterSha256:await hash(master,signal),mode,before,after};
}
export function completeSoundFinishing(master:Awaited<ReturnType<typeof finishSoundMaster>>,encoded:SoundLoudness):SoundFinishingReport{return {schema:"hv-sound-finishing-result/1",recipeRevision:contentHash(SOUND_FINISH_RECIPE),...master,encoded,pcmTargetsMet:soundTargetsMet(master.after,master.settings),encodedTargetsMet:soundTargetsMet(encoded,master.settings)};}
/** Compare receipts with their retained raw meter output without rewriting the old evidence. */
export function verifyFinishingRecords(report:SoundFinishingReport,directory:string):void{
  for(const tag of ["before","after","encoded"] as const)if(contentHash(readSoundMeasurement(directory,tag,report.before.frames))!==contentHash(report[tag]))soundFail("The retained loudness values differ from the meter evidence.");
  const data=JSON.parse(boundedText(join(directory,"processing.json"))),n=JSON.parse(boundedText(join(directory,"before-loudnorm.json")));
  if(data.schema!=="hv-sound-processing/1"||data.mode!==report.mode||data.filter!==processingFilter(report.settings,n,report.before.frames)||(report.mode==="measure"?data.statistics!==null:data.statistics?.normalization_type!==report.mode))soundFail("The retained finishing recipe changed.");
}
