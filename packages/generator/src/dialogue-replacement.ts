import {createHash} from "node:crypto";
import {appendFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job} from "../../queue/src/index";
import {contentHash} from "./capabilities";
import {synthesizeLines,speechRuntimeRevision,speechWavHeader} from "./speech";
import {compilePerformances} from "../../planner/src/performances";
import {captionCues} from "../../planner/src/captions";
import {validateExport} from "../../assembler/src/index";
import {dialogueSource,dialoguePictureTime,dialogueAuditionAssets,dialogueReportAuditions,validateDialogueReplacement,validateDialogueReplacementReport,DialogueReplacementError,type DialogueReplacementPlan,type DialogueReplacementReport,type ReplacedDialogueLine} from "../../planner/src/dialogue-replacement";
import {narrationAuditionLines,narrationConvertedName,narrationMediaNames,type NarrationMixReport} from "../../planner/src/narration-mix";
import {mixNarrationPCM,narrationWav,narrationMixReport,type NarrationAudio} from "./narration-mix";
import {convertAudioToTimeline} from "./audio-timeline";
import {verifyAudioWav} from "./audio-media";
import {validateAudioTimeline} from "../../planner/src/audio-timeline";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {dialogueBaseline,dialogueAuditionInputs,validateDialogueOutput} from "../../planner/src/dialogue-jobs";

const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function fail(message:string):never{throw new DialogueReplacementError(message);}
/** Commands stay asynchronous so a surrounding worker can heartbeat its lease. */
async function command(args:string[],cwd:string,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();
  const child=Bun.spawn(args,{cwd,stdin:"ignore",stdout:"pipe",stderr:"pipe"}),abort=()=>{child.kill("SIGKILL");};
  const timer=setTimeout(abort,20*60*1000);signal?.addEventListener("abort",abort,{once:true});
  try{if(signal?.aborted)abort();const [out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    signal?.throwIfAborted();if(code!==0)fail(`Dialogue media processing failed: ${error.slice(-300)}`);return out;
  }finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
function sourcePath(root:string,job:Pick<Job,"id"|"projectId">,key:string):string{
  if(typeof key!=="string"||key.length>1024||!key.startsWith(job.projectId+"/"+job.id+"/")||!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(p=>!p||p==="."||p===".."))fail("Dialogue source media is outside its job.");
  const path=resolve(root,key),scope=resolve(root,job.projectId,job.id)+sep;
  if(!existsSync(path)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||!realpathSync(path).startsWith(scope))fail("Dialogue source media is missing or outside its job.");
  return path;
}
async function digest(path:string,signal?:AbortSignal):Promise<{sha256:string;bytes:number}>{
  let bytes=0;const checksum=createHash("sha256");for await(const part of Bun.file(path).stream()){signal?.throwIfAborted();bytes+=part.byteLength;if(bytes>8*1024**3)fail("Dialogue media exceeds the artifact size limit.");checksum.update(part);}return {sha256:checksum.digest("hex"),bytes};
}
async function verifiedFile(root:string,job:Pick<Job,"id"|"projectId">,file:RenderFile,signal?:AbortSignal):Promise<string>{
  const path=sourcePath(root,job,file.path),actual=await digest(path,signal);
  if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)fail("The retained dialogue media failed checksum verification.");return path;
}
/** Owner-scoped admission pins both source files; workers independently verify the bytes. */
export async function inspectDialogueSource(source:Job,artifactRoot:string,signal?:AbortSignal):Promise<{revision:string;files:DialogueReplacementPlan["sourceFiles"]}>{
  if(source.dialogueReplacement){const baseline=dialogueBaseline(source),root=realpathSync(artifactRoot);await verifiedFile(root,source,baseline.files.video,signal);await verifiedFile(root,source,baseline.files.manifest,signal);return {revision:baseline.sourceRevision,files:{video:baseline.files.video,manifest:baseline.files.manifest}};}
  const {revision}=dialogueSource(source),root=realpathSync(artifactRoot);
  const file=async(key:string):Promise<RenderFile>=>({path:key,...await digest(sourcePath(root,source,key),signal)});
  return {revision,files:{video:await file(source.output!.mp4Path),manifest:await file(source.output!.manifestPath)}};
}
export interface DialogueArtifactReader {response(projectId:string,jobId:string,key:string,request:Request):Promise<Response|null>}
/** Selection checks the saved exports without running synthesis or rendering. */
export async function verifyRetainedOutputFiles(job:Job,artifactRoot:string):Promise<void>{
  if(!job.output)fail("This cut has no saved media.");const root=realpathSync(artifactRoot);
  if(job.output.dialogue){for(const file of job.output.dialogue.files)await verifiedFile(root,job,file);}
  else for(const key of [job.output.mp4Path,job.output.manifestPath,job.output.hlsPlaylistPath,job.output.captionsPath])sourcePath(root,job,key);
}
/** Copy into a unique worker root; never hydrate into another worker's source cache. */
export async function copyDialogueFiles(owner:Pick<Job,"id"|"projectId">,files:RenderFile[],fromRoot:string,toRoot:string,signal?:AbortSignal,reader?:DialogueArtifactReader):Promise<void>{
  for(const file of files){
    signal?.throwIfAborted();
    if(!file.path.startsWith(owner.projectId+"/"+owner.id+"/")||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(p=>!p||p==="."||p===".."))fail("Dialogue copy escaped its owner.");
    const path=resolve(toRoot,file.path),parent=resolve(path,"..");mkdirSync(parent,{recursive:true});
    if(!realpathSync(parent).startsWith(realpathSync(toRoot)+sep)||existsSync(path))fail("Dialogue copy destination is unavailable.");
    let stream:ReadableStream<Uint8Array>;
    if(reader){const response=await reader.response(owner.projectId,owner.id,file.path,new Request("http://127.0.0.1/internal-dialogue",{signal}));if(!response?.ok||response.headers.get("etag")!=='"'+file.sha256+'"'||Number(response.headers.get("content-length"))!==file.bytes||!response.body)fail("The stored dialogue source changed or disappeared.");stream=response.body;}
    else stream=Bun.file(sourcePath(realpathSync(fromRoot),owner,file.path)).stream();
    const writer=Bun.file(path).writer(),sum=createHash("sha256");let bytes=0;
    try{for await(const chunk of stream){signal?.throwIfAborted();bytes+=chunk.byteLength;if(bytes>file.bytes)fail("Dialogue media exceeds its recorded size.");sum.update(chunk);writer.write(chunk);await writer.flush();}await writer.end();if(bytes!==file.bytes||sum.digest("hex")!==file.sha256)fail("Dialogue source failed checksum verification.");}finally{await writer.end();}
  }
}
export async function verifyDialogueMedia(job:Job,output:NonNullable<Job["output"]>,root:string,signal?:AbortSignal,now=Date.now()):Promise<void>{
  validateDialogueOutput(job,output,now);const result=output.dialogue!;
  for(const file of result.files)await verifiedFile(root,job,file,signal);
  const exportDirectory=resolve(sourcePath(root,job,output.mp4Path),"..");
  for(const asset of dialogueAuditionAssets(dialogueReportAuditions(result.report))){
    const bytes=readFileSync(join(exportDirectory,asset.name));
    if(asset.name.endsWith(".wav"))verifyAudioWav(bytes,asset.source.output.report);
    else if(contentHash(JSON.parse(bytes.toString()))!==contentHash(asset.source.output.report))fail("The original audition report changed.");
  }
  if(contentHash(JSON.parse(readFileSync(sourcePath(root,job,output.manifestPath),"utf8")))!==contentHash(result.report))fail("The dialogue manifest differs from its saved checkpoint.");
  const wav=sourcePath(root,job,result.wavPath),header=Buffer.from(await Bun.file(wav).slice(0,44).arrayBuffer());
  if(!header.equals(speechWavHeader(result.report.totalSamples)))fail("The checkpoint dialogue WAV changed format.");
  let cursor=0;
  for(const line of result.report.lines){
    for await(const chunk of Bun.file(wav).slice(44+cursor*2,44+line.startSample*2).stream()){signal?.throwIfAborted();if(chunk.some(byte=>byte!==0))fail("The dialogue checkpoint contains unrecorded audio.");}
    const sum=createHash("sha256");for await(const chunk of Bun.file(wav).slice(44+line.startSample*2,44+line.endSample*2).stream()){signal?.throwIfAborted();sum.update(chunk);}if(sum.digest("hex")!==line.pcmSha256)fail("A checkpoint dialogue read changed.");cursor=line.endSample;
    if(line.audition)validateAudioTimeline(line.audition.conversion,Buffer.from(await Bun.file(wav).slice(44+line.startSample*2,44+line.endSample*2).arrayBuffer()));
  }
  for await(const chunk of Bun.file(wav).slice(44+cursor*2).stream()){signal?.throwIfAborted();if(chunk.some(byte=>byte!==0))fail("The dialogue checkpoint has unrecorded trailing audio.");}
  const video=await videoIdentity(sourcePath(root,job,output.mp4Path),root,signal);if(video.sha256!==result.report.videoStreamSha256||video.frames!==result.report.totalFrames)fail("The checkpoint changed the locked picture.");
  const expected=captions(result.report.lines,result.report.narration),directory=resolve(sourcePath(root,job,output.mp4Path),"..");
  if(result.report.narration)await verifyNarrationFiles(result.report.narration,directory,readFileSync(wav),signal);
  if(readFileSync(join(directory,"captions.vtt"),"utf8")!==expected.vtt||readFileSync(join(directory,"captions.srt"),"utf8")!==expected.srt)fail("The checkpoint captions changed.");
  const playlist=readFileSync(sourcePath(root,job,output.hlsPlaylistPath),"utf8"),segments=playlist.split(/\r?\n/).filter(line=>line&&!line.startsWith("#"));
  if(!playlist.includes("#EXT-X-ENDLIST")||!segments.length||segments.some(name=>!/^segment-\d{3,5}\.ts$/.test(name))||contentHash(segments.slice().sort())!==contentHash(result.files.filter(f=>f.path.endsWith(".ts")).map(f=>f.path.slice(f.path.lastIndexOf("/")+1)).sort()))fail("The checkpoint HLS media list changed.");
}
/** Rebuild the mix from independently retained dry dialogue and converted cues. */
export async function verifyNarrationFiles(report:NarrationMixReport,directory:string,dryWav:Buffer,signal?:AbortSignal):Promise<void>{
  const reads:NarrationAudio[]=report.conversions.map(c=>{const wav=readFileSync(join(directory,narrationConvertedName(c.cueId)));if(!wav.subarray(0,44).equals(speechWavHeader(c.report.totalSamples)))fail("A retained narration cue changed WAV format.");return {cueId:c.cueId,pcm:wav.subarray(44),report:c.report};});
  const mixed=await mixNarrationPCM(dryWav.subarray(44),report.track,reads,undefined,signal);
  if(contentHash(narrationMixReport(report.track,dryWav,reads,mixed))!==contentHash(report))fail("The narration mix changed its stems, timing or measured peaks.");
  for(const [name,pcm]of [["mix.wav",mixed.mix],["narration.wav",mixed.narration],["ducked-dialogue.wav",mixed.ducked]] as const)if(!readFileSync(join(directory,name)).equals(narrationWav(pcm)))fail("A retained narration stem differs from its reviewed mix.");
}
export async function sealDialogueExport(job:Job,result:DialogueReplacementExport,artifactRoot:string,signal?:AbortSignal):Promise<NonNullable<Job["output"]>>{
  const {readdirSync}=await import("node:fs"),root=realpathSync(artifactRoot),relative=(path:string)=>realpathSync(path).slice(root.length+1).split(sep).join("/");
  const paths=[result.mp4Path,result.wavPath,result.captionsPath,result.srtPath,result.manifestPath,result.hlsPlaylistPath,...dialogueAuditionAssets(dialogueReportAuditions(result.report)).map(a=>join(result.directory,a.name)),...narrationMediaNames(result.report.narration).map(name=>join(result.directory,name)),...readdirSync(join(result.directory,"hls")).filter(name=>name.endsWith(".ts")).map(name=>join(result.directory,"hls",name))];
  const files:RenderFile[]=[];for(const path of paths){const key=relative(path);sourcePath(root,job,key);files.push({path:key,...await digest(path,signal)});}
  const data={report:result.report,wavPath:relative(result.wavPath),files};
  const output={mp4Path:relative(result.mp4Path),captionsPath:relative(result.captionsPath),manifestPath:relative(result.manifestPath),hlsPlaylistPath:relative(result.hlsPlaylistPath),dialogue:{...data,revision:contentHash(data)}};
  await verifyDialogueMedia(job,output,root,signal);return output;
}
async function videoIdentity(path:string,cwd:string,signal?:AbortSignal):Promise<{sha256:string;frames:number;durationSec:number;width:number;height:number}>{
  const probe=JSON.parse(await command(["ffprobe","-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=codec_name,width,height,r_frame_rate,nb_read_frames,start_time,duration","-of","json",path],cwd,signal));
  const video=probe.streams?.[0],frames=Number(video?.nb_read_frames),durationSec=Number(video?.duration);
  if(video?.codec_name!=="h264"||video.r_frame_rate!=="30/1"||Number(video.start_time)!==0||!Number.isSafeInteger(frames)||frames<1||Math.abs(durationSec-frames/30)>.002)fail("The source must have a measured H.264 picture cut at 30 fps.");
  const fingerprint=(await command(["ffmpeg","-v","error","-i",path,"-map","0:v:0","-c:v","copy","-bsf:v","h264_mp4toannexb","-f","hash","-hash","sha256","-"],cwd,signal)).trim();
  if(!/^SHA256=[a-f0-9]{64}$/.test(fingerprint))fail("The picture stream could not be verified.");
  return {sha256:fingerprint.slice(7),frames,durationSec,width:video.width,height:video.height};
}
function timestamp(samples:number,separator:string):string{
  const millis=Math.round(samples*1000/22050);
  return [Math.floor(millis/3600000),Math.floor(millis/60000)%60,Math.floor(millis/1000)%60].map(n=>String(n).padStart(2,"0")).join(":")+separator+String(millis%1000).padStart(3,"0");
}
function captions(lines:ReplacedDialogueLine[],narration?:NarrationMixReport):{srt:string;vtt:string}{
  const srt:string[]=[],vtt=["WEBVTT",""];let index=0;
  const reads=[...lines,...(narration?.track.cues.map((cue,i)=>{const converted=narration.conversions[i]!.report;return {source:{character:cue.audition.take.line.source.character+" ("+cue.role+")"},text:cue.audition.take.line.localization?.text??cue.audition.take.narration!.text,startSample:cue.startSample+converted.speechStartSample,endSample:cue.startSample+converted.speechEndSample};})??[])].sort((a,b)=>a.startSample-b.startSample||a.endSample-b.endSample);
  const cues=reads.flatMap(line=>captionCues([{character:line.source.character,lines:[line.text]}],(line.endSample-line.startSample)/22050).map(cue=>({start:line.startSample+Math.round(cue.startSec*22050),end:line.startSample+Math.round(cue.endSec*22050),text:cue.text}))).sort((a,b)=>a.start-b.start||a.end-b.end);
  for(const {start,end,text}of cues){
    srt.push(String(++index),timestamp(start,",")+" --> "+timestamp(end,","),text,"");vtt.push(timestamp(start,".")+" --> "+timestamp(end,"."),text,"");
  }
  return {srt:srt.join("\n"),vtt:vtt.join("\n")};
}
export interface DialogueReplacementExport {
  directory:string;mp4Path:string;wavPath:string;captionsPath:string;srtPath:string;manifestPath:string;hlsPlaylistPath:string;
  report:DialogueReplacementReport;
}
/**
 * Local media execution only. The caller must hydrate verified source artifacts and assert
 * current owner/cast permission under its lease; no image/video generation adapter is used.
 * Publishing is an atomic directory rename after all reads and permission checks succeed.
 */
export async function replaceLockedDialogue(source:Job,plan:DialogueReplacementPlan,artifactRoot:string,destinationJobId:string,
  assertAccess:()=>Promise<void>,signal?:AbortSignal):Promise<DialogueReplacementExport>{
  signal?.throwIfAborted();validateDialogueReplacement(source,plan);await assertAccess();
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(destinationJobId)||destinationJobId===source.id||destinationJobId===plan.baseline?.jobId)fail("Choose a new job for this dialogue version.");
  const needsSpeech=plan.edits.some(e=>!e.audition);
  if(needsSpeech&&speechRuntimeRevision()!==plan.engineVersion)fail("The speech runtime changed after admission. Review and submit the replacement again.");
  const root=realpathSync(artifactRoot),project=resolve(root,source.projectId),destination=resolve(project,destinationJobId);
  const owner={id:plan.baseline?.jobId??source.id,projectId:source.projectId};
  const sourceVideo=await verifiedFile(root,owner,plan.sourceFiles.video,signal),provenancePath=await verifiedFile(root,owner,plan.sourceFiles.manifest,signal);
  if(existsSync(destination)||realpathSync(project)!==project)fail("The dialogue destination already exists or is outside its project.");
  const locked=dialogueSource(source,dialoguePictureTime(source,plan.baseline)),sourceDigest=await digest(sourceVideo,signal);
  if(lstatSync(provenancePath).size>32*1024**2)fail("The source provenance exceeds the supported size.");
  const provenance=JSON.parse(readFileSync(provenancePath,"utf8"));
  if(plan.baseline){
    validateDialogueReplacementReport(source,provenance,Date.parse(provenance.plan?.baseline?.completedAt??source.completedAt??""));
    if(provenance.plan.revision!==plan.baseline.planRevision||provenance.videoSha256!==plan.baseline.files.video.sha256||provenance.audioSha256!==plan.baseline.files.audio.sha256
      ||provenance.videoStreamSha256!==plan.baseline.videoStreamSha256||contentHash(provenance.lines)!==contentHash(plan.baseline.lines)||contentHash(provenance.narration??null)!==contentHash(plan.baseline.narration??null))fail("The selected baseline differs from its retained provenance.");
  }else if(provenance.spec!=="hv-provenance/1.0"||provenance.projectId!==source.projectId||provenance.credentials?.claim!==`AI-generated video; content credentials sha256:${sourceDigest.sha256}`
    ||contentHash(provenance.shots?.map((s:{renderRecord?:unknown})=>s.renderRecord))!==contentHash(locked.shots))fail("The source export does not match its retained picture and shot provenance.");
  const scratch=mkdtempSync(join(project,".hv-dialogue-"));
  try{
    const retained=dialogueAuditionAssets([...(plan.baseline?.lines.filter(l=>!plan.edits.some(e=>e.shotId===l.shotId&&e.index===l.source.index))??[]),...plan.edits.filter(e=>e.audition).map(e=>({audition:{source:e.audition!}})),...narrationAuditionLines(plan.narration)]),freshInputs=dialogueAuditionInputs(plan);
    if(retained.length)mkdirSync(join(scratch,"auditions"));
    for(const asset of retained){
      await assertAccess();const fresh=freshInputs.some(e=>e.revision===asset.source.revision),file=fresh?asset.file:plan.baseline?.auditionFiles?.find(f=>f.path.endsWith("/"+asset.name));
      if(!file)fail("The baseline is missing its retained audition audio.");
      const bytes=readFileSync(await verifiedFile(root,fresh?{id:asset.source.jobId,projectId:asset.source.projectId}:owner,file,signal));
      if(asset.name.endsWith(".wav"))verifyAudioWav(bytes,asset.source.output.report);else if(contentHash(JSON.parse(bytes.toString()))!==contentHash(asset.source.output.report))fail("The retained audition report changed.");
      writeFileSync(join(scratch,asset.name),bytes,{flag:"wx"});
    }
    const baselineWav=plan.baseline?await verifiedFile(root,owner,plan.baseline.files.audio,signal):undefined;
    if(baselineWav&&!Buffer.from(await Bun.file(baselineWav).slice(0,44).arrayBuffer()).equals(speechWavHeader(locked.totalFrames*735)))fail("The baseline dialogue WAV format changed.");
    const picture=await videoIdentity(sourceVideo,scratch,signal);
    if(picture.frames!==locked.totalFrames)fail("The assembled picture no longer matches its retained shot timing.");
    const totalSamples=locked.totalFrames*735,wavPath=join(scratch,"dialogue.wav"),lines:ReplacedDialogueLine[]=[];
    writeFileSync(wavPath,speechWavHeader(totalSamples));let offset=0;
    for(const shot of locked.shots){
      signal?.throwIfAborted();await assertAccess();
      const samples=Math.round(shot.clip.durationSec*30)*735,pcm=baselineWav?Buffer.from(await Bun.file(baselineWav).slice(44+offset*2,44+(offset+samples)*2).arrayBuffer()):Buffer.alloc(samples*2),report=shot.clip.speech;
      if(pcm.length!==samples*2||(!report&&pcm.some(byte=>byte!==0)))fail("The baseline contains unrecorded audio or changed duration.");
      if(report){
        if(!baselineWav){const original=readFileSync(await verifiedFile(root,source,shot.files.audio!,signal));
          if(!original.subarray(0,44).equals(speechWavHeader(report.totalSamples)))fail("The retained dialogue WAV format changed.");original.subarray(44).copy(pcm);}
        // Only measured dialogue and declared silence may be retained. Never discard hidden audio.
        let cursor=0;
        const retained=plan.baseline?plan.baseline.lines.filter(l=>l.shotId===shot.shotId).map(l=>({...l,startSample:l.startSample-offset,endSample:l.endSample-offset})):report.lines;
        for(const line of retained){
          if(!pcm.subarray(cursor*2,line.startSample*2).every(byte=>byte===0)||hash(pcm.subarray(line.startSample*2,line.endSample*2))!==line.pcmSha256)fail("The retained line audio or silence changed.");cursor=line.endSample;
        }
        if(!pcm.subarray(cursor*2).every(byte=>byte===0))fail("The retained dialogue contains audio outside its measured lines.");
        for(const [index,line]of report.lines.entries()){
          const edit=plan.edits.find(e=>e.shotId===shot.shotId&&e.index===index),windowEnd=report.lines[index+1]?.startSample??samples;
          const inherited=plan.baseline?.lines.find(l=>l.shotId===shot.shotId&&l.source.index===index);
          let endSample=inherited?inherited.endSample-offset:line.endSample,text=inherited?.text??line.source.text,voice=inherited?inherited.voice:line.voice,notes=inherited?.notes??line.notes,spoken=inherited?.spokenText??line.spokenText,engineVersion=inherited?.engineVersion??report.engineVersion,audition=inherited?.audition;
          if(edit?.audition){
            const converted=await convertAudioToTimeline(readFileSync(join(scratch,"auditions",edit.audition.jobId+".wav")),edit.audition.output.report,scratch,plan.conversionEngineVersion!,windowEnd-line.startSample,assertAccess,signal);
            pcm.fill(0,line.startSample*2,windowEnd*2);converted.pcm.copy(pcm,line.startSample*2);endSample=line.startSample+converted.report.totalSamples;
            text=edit.text;voice=null;notes=edit.notes;spoken=edit.audition.take.line.spokenText;engineVersion=converted.report.engineVersion;audition={source:edit.audition,conversion:converted.report};
          }else if(edit){
            await assertAccess();const dialogue=[{character:line.source.character,lines:[edit.text]}],performance=compilePerformances(dialogue,undefined);
            performance[0]!.voice=edit.voice!;performance[0]!.beforeMs=0;performance[0]!.afterMs=0;performance[0]!.notes=edit.notes;
            const audio=await synthesizeLines(scratch,dialogue,performance,30,1,false,true,signal,plan.engineVersion);
            if(!audio.speech)fail("The speech engine returned no replacement read.");
            const replacement=readFileSync(join(scratch,"voice.wav")).subarray(44);
            const available=windowEnd-line.startSample;
            if(audio.speech.totalSamples>available)fail(`${line.source.character}, line ${index+1}: the new read needs ${(audio.speech.totalSamples/22050).toFixed(2)}s; ${(available/22050).toFixed(2)}s is available in the locked picture. Shorten the line or increase its pace. Picture timing was preserved.`);
            pcm.fill(0,line.startSample*2,windowEnd*2);replacement.copy(pcm,line.startSample*2);endSample=line.startSample+audio.speech.totalSamples;
            text=edit.text;voice=edit.voice;notes=edit.notes;spoken=audio.speech.lines[0]!.spokenText;engineVersion=audio.speech.engineVersion;audition=undefined;
          }
          lines.push({shotId:shot.shotId,source:line.source,text,spokenText:spoken,voice,notes,startSample:offset+line.startSample,endSample:offset+endSample,windowEndSample:offset+windowEnd,
            pcmSha256:hash(pcm.subarray(line.startSample*2,endSample*2)),engineVersion,replaced:Boolean(edit),...(audition?{audition}:{})});
        }
      }
      appendFileSync(wavPath,pcm);offset+=samples;
    }
    let narration:NarrationMixReport|undefined;
    if(plan.narration){
      const reads:NarrationAudio[]=[];if(plan.narration.cues.length)mkdirSync(join(scratch,"narration"));
      for(const cue of plan.narration.cues){const converted=await convertAudioToTimeline(readFileSync(join(scratch,"auditions",cue.audition.jobId+".wav")),cue.audition.output.report,scratch,plan.conversionEngineVersion!,totalSamples-cue.startSample,assertAccess,signal);
        reads.push({cueId:cue.id,pcm:converted.pcm,report:converted.report});writeFileSync(join(scratch,narrationConvertedName(cue.id)),converted.wav,{flag:"wx"});}
      const dryWav=readFileSync(wavPath),mixed=await mixNarrationPCM(dryWav.subarray(44),plan.narration,reads,assertAccess,signal);narration=narrationMixReport(plan.narration,dryWav,reads,mixed);
      for(const [name,pcm]of [["mix.wav",mixed.mix],["narration.wav",mixed.narration],["ducked-dialogue.wav",mixed.ducked]] as const)writeFileSync(join(scratch,name),narrationWav(pcm),{flag:"wx"});
    }
    const mp4Path=join(scratch,"export.mp4");
    await command(["ffmpeg","-v","error","-y","-i",sourceVideo,"-i",narration?join(scratch,"mix.wav"):wavPath,"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-b:a","128k","-ar","44100","-ac","2","-t",String(picture.frames/30),"-map_metadata","-1","-movflags","+faststart",mp4Path],scratch,signal);
    const outputPicture=await videoIdentity(mp4Path,scratch,signal);
    if(contentHash(outputPicture)!==contentHash(picture))fail("The dialogue export altered the locked picture stream or timing.");
    const probe=JSON.parse(await command(["ffprobe","-v","error","-show_streams","-show_format","-of","json",mp4Path],scratch,signal));
    validateExport(probe,{width:picture.width,height:picture.height,fps:30,durationSec:picture.frames/30});
    if((await digest(sourceVideo,signal)).sha256!==sourceDigest.sha256)fail("The source picture changed during dialogue replacement.");
    if(needsSpeech&&speechRuntimeRevision()!==plan.engineVersion)fail("The speech runtime changed during dialogue replacement.");
    const caption=captions(lines,narration);writeFileSync(join(scratch,"captions.srt"),caption.srt);writeFileSync(join(scratch,"captions.vtt"),caption.vtt);
    const result:DialogueReplacementReport={schema:narration?"hv-dialogue-replacement-result/3":["hv-dialogue-replacement/3","hv-dialogue-replacement/4"].includes(plan.schema)?"hv-dialogue-replacement-result/2":"hv-dialogue-replacement-result/1",plan,sampleRate:22050,totalSamples,sourceVideoSha256:sourceDigest.sha256,...(narration?{narration}:{}),
      videoStreamSha256:picture.sha256,totalFrames:picture.frames,lines,videoSha256:(await digest(mp4Path,signal)).sha256,audioSha256:(await digest(wavPath,signal)).sha256};
    validateDialogueReplacementReport(source,result);writeFileSync(join(scratch,"provenance.json"),JSON.stringify(result,null,2)+"\n");
    mkdirSync(join(scratch,"hls"));await command(["ffmpeg","-v","error","-y","-i",mp4Path,"-map","0:v:0","-map","0:a:0","-c","copy","-hls_time","2","-hls_list_size","0","-hls_playlist_type","vod","-hls_segment_filename",join(scratch,"hls/segment-%03d.ts"),join(scratch,"hls/index.m3u8")],scratch,signal);
    // Scratch speech intermediates must not become published artifacts.
    for(const name of ["line-0.txt","line-0.wav","line-0.pcm","voice.wav"])if(existsSync(join(scratch,name)))rmSync(join(scratch,name));
    signal?.throwIfAborted();validateDialogueReplacement(source,plan);await verifiedFile(root,owner,plan.sourceFiles.manifest,signal);await assertAccess();renameSync(scratch,destination);
    return {directory:destination,mp4Path:join(destination,"export.mp4"),wavPath:join(destination,"dialogue.wav"),captionsPath:join(destination,"captions.vtt"),srtPath:join(destination,"captions.srt"),
      manifestPath:join(destination,"provenance.json"),hlsPlaylistPath:join(destination,"hls/index.m3u8"),report:result};
  }finally{
    if(existsSync(scratch))rmSync(scratch,{recursive:true,force:true});
  }
}
