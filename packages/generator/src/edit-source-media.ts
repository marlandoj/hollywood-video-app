import {appendFileSync,closeSync,copyFileSync,existsSync,ftruncateSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync,writeSync} from "node:fs";
import {createHash} from "node:crypto";
import {assertEditFreeSpace,editWorkspaceGuard} from "./edit-workspace";
import {EDIT_STORAGE_LIMITS} from "../../planner/src/edit-resources";
import {dirname,join,resolve,sep} from "node:path";
import type {Job} from "../../queue/src/index";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {sourceRenderRecord} from "../../planner/src/shot-reuse";
import {EDIT_AUDIO_LANES,EDIT_MAX_FRAMES,editFail,editId,editNumber,editRecord,type EditSource} from "../../planner/src/edit-timeline";
import {editOriginalJob,editSourceKnownFiles,editSourceAudio,editSourceLanguage,editSourceVoiceWindows,editFactsRevision,editSourcePicture,editSourceRequiredPaths,editSourceMedia,validateEditSourceReceipt,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {parseEditCaptions} from "../../planner/src/edit-captions";
import {retainedDialogueTime} from "../../planner/src/dialogue-jobs";
import {currentFilmSourceClock} from "../../planner/src/current-film-source-clock";
import {parseCurrentFilmProbe} from "../../planner/src/current-film-clock";
import {verifyCurrentFilmMedia} from "../../queue/src/current-film-media";
import {speechWavHeader} from "./speech";
import {contentHash} from "./capabilities";
import {copyDialogueFiles,verifyDialogueMedia,type DialogueArtifactReader} from "./dialogue-replacement";
import {verifyLipSyncMedia} from "./lipsync-media";
import {verifyGraphicMedia} from "./graphic-media";
import {soundDigest,verifySoundMedia,retainedSourceVoices} from "./sound-media";
import {soundWavHeader,soundRuntimeRevision} from "./sound-audio";
import {soundProcessingCommand} from "./sound-finishing";
import type {EditConformSource} from "./edit-conform";
import {provenanceMatches} from "../../planner/src/provenance";

type Access=()=>Promise<void>;
type Lane=typeof EDIT_AUDIO_LANES[number];
export const EDIT_SOURCE_RECIPE={schema:"hv-edit-source-media/1",sampleRate:48000,channels:2,encoding:"pcm_s24le",existing48:"bitexact-copy",mono:"duplicate-both-channels",resampler:"swr",filterSize:64,phaseShift:10,exactRational:true,dither:"none",decode:"retain-zero-origin; flush; record-tail-padding-or-discard",maxAacTailSamples:2048,voice:"reconstruct-retained-22050-pcm-without-synthesis"} as const;
export function editSourceRecipe(receipts:EditSourceReceipt[]){const graphic="verify-retained-rgba-bundle-and-copy-ffv1-master-without-conversion";
  if(receipts.some(r=>r.job.currentFilm))return {...EDIT_SOURCE_RECIPE,schema:"hv-edit-source-media/3",graphic,currentFilm:"verified-original-clock/2; native-22050-pcm-at-measured-start-frame-times-735; zero-fill-uncovered; one-global-48000-conversion"};
  return receipts.some(r=>r.facts.media==="graphic-rgba")?{...EDIT_SOURCE_RECIPE,schema:"hv-edit-source-media/2",graphic}:EDIT_SOURCE_RECIPE;}
export interface EditAudioConversion {lane:Lane;kind:"copy48"|"decode"|"film-dialogue"|"current-film-dialogue";inputSha256:string;decodedSamples:number;padSamples:number;discardSamples:number;output:RenderFile}
export interface PreparedEditSource {receipt:EditSourceReceipt;copies:{original:RenderFile;copy:RenderFile}[];media:EditConformSource;conversions:EditAudioConversion[]}
export interface PreparedEditSources {schema:"hv-edit-prepared/1";engineVersion:string;recipeRevision:string;sources:PreparedEditSource[];revision:string}
function keyPath(root:string,key:string):string {
  if(typeof key!=="string"||key.length>1024||!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(p=>!p||p==="."||p===".."))editFail("Invalid retained editorial path.");
  const path=resolve(root,key);if(!path.startsWith(root+sep)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||!realpathSync(path).startsWith(root+sep))editFail("Editorial source media escaped its workspace.");return path;
}
function readText(path:string,maximum=32*1024**2):string {if(statSync(path).size>maximum)editFail("Editorial source metadata exceeds its limit.");return readFileSync(path,"utf8");}
function remove(root:string,directory:string):void {if(!directory.startsWith(root+sep)||realpathSync(directory)!==directory)editFail("Editorial source scratch escaped its workspace.");rmSync(directory,{recursive:true,force:true});}
async function record(root:string,path:string,signal?:AbortSignal):Promise<RenderFile>{const key=path.slice(root.length+1).split(sep).join("/");return {path:key,...await soundDigest(keyPath(root,key),signal)};}
/** Covers streamed copies and existing provenance verifiers as well as FFmpeg calls. */
export async function withEditSourceAccess<T>(access:Access,signal:AbortSignal|undefined,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  signal?.throwIfAborted();await access();const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);let pending:Promise<void>|undefined,failure:unknown;
  signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  const timer=setInterval(()=>{if(pending)return;pending=access().catch(error=>{failure=error;controller.abort(error);}).finally(()=>{pending=undefined;});},2000);
  try{const result=await run(controller.signal);clearInterval(timer);await pending;if(failure)throw failure;controller.signal.throwIfAborted();await access();return result;}
  catch(error){if(failure)throw failure;throw error;}finally{clearInterval(timer);signal?.removeEventListener("abort",abort);await pending;}
}
async function verifyOriginal(job:Job,files:RenderFile[],root:string,access:Access,signal:AbortSignal):Promise<void>{
  for(const f of files){await access();const actual=await soundDigest(keyPath(root,f.path),signal);if(actual.sha256!==f.sha256||actual.bytes!==f.bytes)editFail("A retained editorial source failed checksum verification.");}
  if(job.currentFilm){
    await verifyCurrentFilmMedia(job,root,signal);
    const provenance=JSON.parse(readText(keyPath(root,job.output!.manifestPath))),video=files.find(f=>f.path===job.output!.mp4Path)!;
    if(!provenanceMatches(provenance,{projectId:job.projectId,sha256:video.sha256})
      ||contentHash(provenance.shots?.map((s:{renderRecord?:unknown})=>s.renderRecord)??null)!==contentHash(job.output!.currentFilm!.records.map(row=>row.record)))editFail("The editorial source differs from its original current-film picture provenance.");
  }
  else if(job.graphicOutput)await verifyGraphicMedia(job,job.graphicOutput,root,access,signal);
  else if(job.soundMix)await verifySoundMedia(job,job.output!,root,signal);
  else if(job.dialogueReplacement)await verifyDialogueMedia(job,job.output!,root,signal,retainedDialogueTime(job));
  else if(job.lipSync)await verifyLipSyncMedia(job,job.output!,root,signal);
  else {const provenance=JSON.parse(readText(keyPath(root,job.output!.manifestPath))),video=files.find(f=>f.path===job.output!.mp4Path)!;
    const shots=job.output!.shotRenders!.map(s=>sourceRenderRecord(job,s,Date.parse(job.completedAt!)));
    if(!provenanceMatches(provenance,{projectId:job.projectId,sha256:video.sha256})||contentHash(provenance.shots?.map((s:{renderRecord?:unknown})=>s.renderRecord)??null)!==contentHash(shots))editFail("The editorial source differs from its original picture provenance.");
  }
}
async function measuredFacts(job:Job,root:string,directory:string,label:string,access:Access,signal:AbortSignal):Promise<EditSource>{
  const probe=join(directory,"picture-probe.json");await soundProcessingCommand(["ffprobe","-v","error","-protocol_whitelist","file,pipe","-count_frames","-show_streams","-of","json","-o",probe,keyPath(root,editSourcePicture(job))],directory,access,signal);
  const streams=JSON.parse(readText(probe,1024*1024)).streams,video=streams.filter((s:any)=>s.codec_type==="video"),audio=streams.filter((s:any)=>s.codec_type==="audio"),v=video[0],frames=Number(v?.nb_read_frames);
  if(job.graphicOutput){const plan=job.graphicRender!.spec.plan;if(streams.length!==1||video.length!==1||v.codec_name!=="ffv1"||v.pix_fmt!=="bgra"||v.r_frame_rate!=="30/1"||Number(v.start_time)!==0||frames!==plan.frames||v.width!==plan.width||v.height!==plan.height)editFail("Choose the retained 30 fps FFV1 graphic with its original dimensions, frames and alpha.");}
  else if(video.length!==1||v.codec_name!=="h264"||v.r_frame_rate!=="30/1"||Number(v.start_time)!==0||Math.abs(Number(v.duration)-frames/30)>.002||audio.length!==1||Number(audio[0].start_time)!==0||![1,2].includes(audio[0].channels))editFail("Choose a retained 30 fps H.264 picture with one mono or stereo soundtrack starting at zero.");
  editNumber(frames,1,EDIT_MAX_FRAMES,"Measured source frames");editNumber(v.width,16,3840,"Measured source width");editNumber(v.height,16,2160,"Measured source height");if(v.width%2||v.height%2)editFail("Use an even-sized retained picture source.");
  if(job.currentFilm&&contentHash(parseCurrentFilmProbe({streams}))!==contentHash(job.output!.currentFilm!.assembly.probe))editFail("The editorial source changed its exact current-film media clock.");
  const knownFrames=job.output?.currentFilm?.assembly.frames??job.output?.sound?.report.totalVideoFrames??job.output?.dialogue?.report.totalFrames??job.output?.lipSync?.report.totalFrames;
  if(knownFrames!==undefined&&knownFrames!==frames)editFail("The editorial source changed its measured picture length.");
  const captions=job.graphicOutput?[]:parseEditCaptions(readText(keyPath(root,job.output!.captionsPath),8*1024**2),frames);
  return {id:job.id,revision:editFactsRevision(job,frames,v.width,v.height,captions),label,frames,width:v.width,height:v.height,audio:EDIT_AUDIO_LANES.filter(l=>editSourceAudio(job)[l]),captions,...editSourceVoiceWindows(job),...editSourceMedia(job)};
}
/** Only server-side source inspection may create facts; a browser submits a source binding, not this receipt. */
export async function inspectEditSource(job:Job,label:string,artifactRoot:string,access:Access,signal?:AbortSignal,reader?:DialogueArtifactReader,info?:(path:string)=>Promise<RenderFile>):Promise<EditSourceReceipt>{
  // Persist only JSON values. Transient worker objects may carry undefined optional keys.
  job=JSON.parse(JSON.stringify(job)) as Job;
  editOriginalJob(job);editId(job.id);editId(job.projectId);if(typeof label!=="string"||!label.trim()||label.length>160)editFail("Name this retained source in 160 characters or fewer.");
  const root=realpathSync(artifactRoot),scratch=mkdtempSync(join(root,".edit-inspect-")),origin=join(scratch,"origin");mkdirSync(origin);
  const permission=access,disk=editWorkspaceGuard(root,()=>[scratch]);access=async()=>{disk();await permission();};
  try{return await withEditSourceAccess(access,signal,async active=>{
    const inventory=new Map(editSourceKnownFiles(job).map(f=>[f.path,f]));
    for(const path of editSourceRequiredPaths(job))if(!inventory.has(path)){
      if(!path.startsWith(job.projectId+"/"+job.id+"/"))editFail("The selected source escaped its owner.");
      if(reader&&!info)editFail("Stored editorial inspection needs owned artifact metadata.");
      const file=info?await info(path):await record(root,keyPath(root,path),active);if(file.path!==path)editFail("The selected source metadata changed its path.");inventory.set(path,file);
    }
    const files=[...inventory.values()].sort((a,b)=>a.path.localeCompare(b.path)),bytes=files.reduce((n,f)=>n+f.bytes,0);if(bytes>EDIT_STORAGE_LIMITS.outputBytes)editFail("This original source exceeds the current retained-media capacity.");assertEditFreeSpace(root,bytes*2+(job.graphicOutput?0:(job.output?.currentFilm?.assembly.frames??job.totalFrames)*1600*6*8));await copyDialogueFiles(job,files,root,origin,active,reader);
    await verifyOriginal(job,files,realpathSync(origin),access,active);const facts=await measuredFacts(job,realpathSync(origin),scratch,label,access,active);
    const data={schema:job.currentFilm?"hv-edit-source/3" as const:job.graphicOutput?"hv-edit-source/2" as const:"hv-edit-source/1" as const,job:structuredClone(job),facts,language:editSourceLanguage(job),audio:editSourceAudio(job),files};
    return validateEditSourceReceipt({...data,revision:contentHash(data)});
  });}finally{remove(root,scratch);}
}
async function normalize(input:string,path:string,frames:number,access:Access,signal:AbortSignal):Promise<{decodedSamples:number;padSamples:number;discardSamples:number}>{
  const directory=dirname(path),probe=path+".probe.json";await soundProcessingCommand(["ffprobe","-v","error","-protocol_whitelist","file,pipe","-show_streams","-of","json","-o",probe,input],directory,access,signal);
  const audio=JSON.parse(readText(probe,1024*1024)).streams.filter((s:any)=>s.codec_type==="audio"),a=audio[0],target=frames*1600;
  if(audio.length!==1||![1,2].includes(a.channels)||Number(a.sample_rate)<8000||Number(a.sample_rate)>192000||a.start_time!==undefined&&Math.abs(Number(a.start_time))>1/48000)editFail("The editorial audio source has unsupported channels, rate or start offset.");
  const pcm=path+".pcm",filter=(a.channels===1?"pan=stereo|c0=c0|c1=c0,":"")+"aresample=48000:resampler=swr:filter_size=64:phase_shift=10:exact_rational=1:dither_method=none,atrim=end_sample="+(target+2049);
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i",input,"-map","0:a:0","-af",filter,"-c:a","pcm_s24le","-f","s24le",pcm],directory,access,signal);
  const decodedSamples=statSync(pcm).size/6,delta=decodedSamples-target,tolerance=a.codec_name==="aac"?EDIT_SOURCE_RECIPE.maxAacTailSamples:1;
  if(!Number.isSafeInteger(decodedSamples)||Math.abs(delta)>tolerance)editFail("The source waveform no longer matches its measured picture duration.");
  writeFileSync(path,soundWavHeader(target),{flag:"wx"});for await(const chunk of Bun.file(pcm).slice(0,target*6).stream()){signal.throwIfAborted();appendFileSync(path,chunk);}if(delta<0)appendFileSync(path,Buffer.alloc(-delta*6));rmSync(pcm);rmSync(probe);
  return {decodedSamples,padSamples:Math.max(0,-delta),discardSamples:Math.max(0,delta)};
}
/** Reconstruct verified native dialogue at the actual assembly clock, without
 * synthesis or legacy source replanning. One bounded source WAV is held at a time. */
async function retainedCurrentFilmDialogue(job:Job,root:string,directory:string,access:Access,signal:AbortSignal):Promise<string>{
  const clock=currentFilmSourceClock(job);if(!clock.isolatedDialogue)editFail("This current film has no retained isolated dialogue.");
  const path=join(directory,"current-film-dialogue.wav"),samples=clock.frames*735,header=speechWavHeader(samples),fd=openSync(path,"wx");
  try{
    writeSync(fd,header);ftruncateSync(fd,44+samples*2);
    for(const span of clock.spans){const report=span.record.clip.speech;if(!report)continue;signal.throwIfAborted();await access();const file=span.record.files.audio!;
      const size=44+report.totalSamples*2;if(size>44+600*22050*2||size!==file.bytes||report.totalSamples>span.frames*735)editFail("The current-film dialogue exceeds its bounded original PCM span.");
      const bytes=Buffer.from(await Bun.file(keyPath(root,file.path)).slice(0,size+1).arrayBuffer());signal.throwIfAborted();
      if(bytes.length!==size||!bytes.subarray(0,44).equals(speechWavHeader(report.totalSamples))||createHash("sha256").update(bytes).digest("hex")!==file.sha256)editFail("The retained current-film dialogue changed its original PCM.");
      const pcm=bytes.subarray(44);let written=0;while(written<pcm.length){signal.throwIfAborted();const count=writeSync(fd,pcm,written,pcm.length-written,44+span.startFrame*735*2+written);if(count<1)editFail("The retained current-film dialogue could not be written completely.");written+=count;}
    }
    signal.throwIfAborted();await access();return path;
  }finally{closeSync(fd);}
}
/** Retains owned originals and canonical audio once, without nesting earlier editorial exports. */
export async function prepareEditSources(receipts:EditSourceReceipt[],artifactRoot:string,destination:string,access:Access,signal?:AbortSignal,reader?:DialogueArtifactReader):Promise<PreparedEditSources>{
  if(!Array.isArray(receipts)||!receipts.length||receipts.length>16||new Set(receipts.map(r=>r.job.id)).size!==receipts.length||new Set(receipts.map(r=>r.job.projectId)).size!==1||JSON.stringify(receipts).length>64*1024**2)editFail("Use up to sixteen sources from this project within the 64 MiB receipt limit.");receipts.forEach(validateEditSourceReceipt);
  const root=realpathSync(artifactRoot),target=resolve(destination),engineVersion=soundRuntimeRevision();
  const needed=receipts.reduce((n,r)=>n+r.files.reduce((sum,f)=>sum+f.bytes,0)+(44+r.facts.frames*1600*6)*Object.keys(r.audio).length,0)*3;assertEditFreeSpace(root,needed);const permission=access,disk=editWorkspaceGuard(root,()=>[target]);access=async()=>{disk();await permission();};
  if(!target.startsWith(root+sep)||existsSync(target))editFail("Choose a new owned source preparation destination.");mkdirSync(target,{recursive:true});if(realpathSync(target)!==target)editFail("Editorial source preparation escaped its workspace.");
  return withEditSourceAccess(access,signal,async active=>{
    const sources:PreparedEditSource[]=[];
    for(const receipt of receipts){
      const directory=join(target,receipt.job.id),origin=join(directory,"original"),scratch=join(directory,"scratch");mkdirSync(origin,{recursive:true});mkdirSync(scratch);
      try{
        await copyDialogueFiles(receipt.job,receipt.files,root,origin,active,reader);const canonical=realpathSync(origin);await verifyOriginal(receipt.job,receipt.files,canonical,access,active);
        const measured=await measuredFacts(receipt.job,canonical,scratch,receipt.facts.label,access,active);if(contentHash(measured)!==contentHash(receipt.facts))editFail("The editorial source changed since inspection.");
        const copies:PreparedEditSource["copies"]=receipt.files.map(original=>({original,copy:{...original,path:join(origin,original.path).slice(root.length+1).split(sep).join("/")}})),media:EditConformSource={id:receipt.job.id,picture:copies.find(f=>f.original.path===editSourcePicture(receipt.job))!.copy,audio:{}},conversions:EditAudioConversion[]=[];
        let reconstructed:Awaited<ReturnType<typeof retainedSourceVoices>>|undefined,currentDialogue:string|undefined;mkdirSync(join(directory,"audio"));
        for(const lane of EDIT_AUDIO_LANES){const input=receipt.audio[lane];if(!input)continue;await access();let source:string;
          if(input.kind==="film-dialogue"){reconstructed??=await retainedSourceVoices(receipt.job,canonical,scratch,access,active);source=reconstructed.dialogue;}
          else if(input.kind==="current-film-dialogue"){currentDialogue??=await retainedCurrentFilmDialogue(receipt.job,canonical,scratch,access,active);source=currentDialogue;}
          else source=keyPath(canonical,input.path);
          const path=join(directory,"audio",lane+".wav"),inputSha256=(await soundDigest(source,active)).sha256;let timing:{decodedSamples:number;padSamples:number;discardSamples:number};
          if(input.kind==="copy48"){if(statSync(source).size!==44+receipt.facts.frames*1600*6||!Buffer.from(await Bun.file(source).slice(0,44).arrayBuffer()).equals(soundWavHeader(receipt.facts.frames*1600)))editFail("The retained 48 kHz source waveform changed.");copyFileSync(source,path,1);timing={decodedSamples:receipt.facts.frames*1600,padSamples:0,discardSamples:0};}
          else timing=await normalize(source,path,receipt.facts.frames,access,active);
          const output=await record(root,path,active);media.audio[lane]=output;conversions.push({lane,kind:input.kind,inputSha256,...timing,output});
        }
        sources.push({receipt:structuredClone(receipt),copies,media,conversions});
      }finally{remove(root,realpathSync(scratch));}
    }
    if(engineVersion!==soundRuntimeRevision())editFail("The editorial source conversion runtime changed.");
    const data={schema:"hv-edit-prepared/1" as const,engineVersion,recipeRevision:contentHash(editSourceRecipe(receipts)),sources},result=validatePreparedEditSources({...data,revision:contentHash(data)},target.slice(root.length+1).split(sep).join("/"));writeFileSync(join(target,"sources.json"),JSON.stringify(result,null,2)+"\n",{flag:"wx"});return result;
  });
}

/** Validate path ownership and all retained relationships before reading a recovery package. */
export function validatePreparedEditSources(value:PreparedEditSources,relativeDirectory:string):PreparedEditSources{
  editRecord(value,["schema","engineVersion","recipeRevision","sources","revision"]);
  if(value.schema!=="hv-edit-prepared/1"||!/^ffmpeg-sound-[a-f0-9]{64}$/.test(value.engineVersion)||!Array.isArray(value.sources)||!value.sources.length||value.sources.length>16||JSON.stringify(value).length>128*1024**2||value.recipeRevision!==contentHash(editSourceRecipe(value.sources.map(s=>s.receipt))))editFail("Invalid retained editorial preparation.");
  if(!/^[A-Za-z0-9._/-]+$/.test(relativeDirectory)||relativeDirectory.split("/").some(p=>!p||p==="."||p==="..")||new Set(value.sources.map(s=>s.receipt.job.id)).size!==value.sources.length||new Set(value.sources.map(s=>s.receipt.job.projectId)).size!==1)editFail("Editorial source preparation changed its owner.");
  for(const source of value.sources){
    editRecord(source,["receipt","copies","media","conversions"]);const receipt=validateEditSourceReceipt(source.receipt),prefix=relativeDirectory+"/"+receipt.job.id+"/";
    if(!Array.isArray(source.copies)||source.copies.length!==receipt.files.length||!Array.isArray(source.conversions)||source.conversions.length!==receipt.facts.audio.length)editFail("The editorial preparation lost retained source media.");
    const expectedCopies=receipt.files.map(original=>({original,copy:{...original,path:prefix+"original/"+original.path}}));if(contentHash(source.copies)!==contentHash(expectedCopies))editFail("The editorial preparation changed an original source copy.");
    editRecord(source.media,["id","picture","audio"]);editRecord(source.media.audio,[...receipt.facts.audio]);
    const expectedPicture=expectedCopies.find(f=>f.original.path===editSourcePicture(receipt.job))!.copy;
    if(source.media.id!==receipt.job.id||contentHash(source.media.picture)!==contentHash(expectedPicture)||Object.keys(source.media.audio).length!==receipt.facts.audio.length)editFail("The editorial preparation changed its picture or sound lanes.");
    for(const [i,lane]of receipt.facts.audio.entries()){
      const conversion=source.conversions[i]!,file=source.media.audio[lane]!,input=receipt.audio[lane]!;
      editRecord(conversion,["lane","kind","inputSha256","decodedSamples","padSamples","discardSamples","output"]);editRecord(file,["path","bytes","sha256"]);
      const target=receipt.facts.frames*1600;
      if(conversion.lane!==lane||conversion.kind!==input.kind||file.path!==prefix+"audio/"+lane+".wav"||file.bytes!==44+target*6||!/^[a-f0-9]{64}$/.test(file.sha256)||!/^[a-f0-9]{64}$/.test(conversion.inputSha256)||contentHash(conversion.output)!==contentHash(file))editFail("An editorial audio conversion changed its identity or waveform.");
      editNumber(conversion.decodedSamples,target-2048,target+2048,"Converted samples");editNumber(conversion.padSamples,0,2048,"Audio tail padding");editNumber(conversion.discardSamples,0,2048,"Audio tail discard");
      if(conversion.padSamples!==Math.max(0,target-conversion.decodedSamples)||conversion.discardSamples!==Math.max(0,conversion.decodedSamples-target)||"path" in input&&conversion.inputSha256!==receipt.files.find(f=>f.path===input.path)!.sha256||input.kind==="copy48"&&(conversion.padSamples!==0||conversion.discardSamples!==0||file.sha256!==conversion.inputSha256))editFail("The editorial audio conversion changed its source samples or tail accounting.");
    }
  }
  const {revision,...data}=value;if(contentHash(data)!==revision)editFail("The retained editorial preparation changed.");return structuredClone(value);
}
/** Rehydrate only owned originals and independently reproduce every canonical conversion. */
export async function verifyPreparedEditSources(value:PreparedEditSources,artifactRoot:string,directory:string,access:Access,signal?:AbortSignal):Promise<void>{
  const root=realpathSync(artifactRoot),target=resolve(directory);if(!target.startsWith(root+sep)||realpathSync(target)!==target)editFail("Editorial recovery escaped its workspace.");
  const relative=target.slice(root.length+1).split(sep).join("/"),saved=validatePreparedEditSources(value,relative);
  if(contentHash(JSON.parse(readText(keyPath(root,relative+"/sources.json"),128*1024**2)))!==contentHash(saved))editFail("The editorial source manifest changed.");
  if(saved.engineVersion!==soundRuntimeRevision())editFail("Restore the recorded editorial conversion runtime before verifying these source waveforms.");
  await withEditSourceAccess(access,signal,async active=>{
    for(const s of saved.sources)for(const file of [...s.copies.map(c=>c.copy),...Object.values(s.media.audio)]){await access();const d=await soundDigest(keyPath(root,file.path),active);if(d.sha256!==file.sha256||d.bytes!==file.bytes)editFail("A retained editorial preparation failed checksum verification.");}
    const scratch=mkdtempSync(join(root,".edit-recover-"));
    try{
      const reader:DialogueArtifactReader={async response(projectId,jobId,path){const source=saved.sources.find(s=>s.receipt.job.projectId===projectId&&s.receipt.job.id===jobId),copy=source?.copies.find(c=>c.original.path===path)?.copy;if(!copy)editFail("Editorial recovery requested unowned source media.");return new Response(Bun.file(keyPath(root,copy.path)).stream(),{headers:{etag:'"'+copy.sha256+'"',"content-length":String(copy.bytes)}});}};
      const rebuilt=await prepareEditSources(saved.sources.map(s=>s.receipt),root,join(scratch,"sources"),access,active,reader),rebuiltPrefix=join(scratch,"sources").slice(root.length+1).split(sep).join("/");
      const rebase=(file:RenderFile)=>({...file,path:relative+file.path.slice(rebuiltPrefix.length)});
      for(const s of rebuilt.sources){s.copies=s.copies.map(c=>({...c,copy:rebase(c.copy)}));s.media={...s.media,picture:rebase(s.media.picture),audio:Object.fromEntries(Object.entries(s.media.audio).map(([k,f])=>[k,rebase(f)]))};s.conversions=s.conversions.map(c=>({...c,output:rebase(c.output)}));}
      if(contentHash(rebuilt.sources)!==contentHash(saved.sources))editFail("The retained editorial waveforms do not reproduce their original conversion.");
    }finally{remove(root,scratch);}
  });
}
