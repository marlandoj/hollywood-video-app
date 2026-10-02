import {createHash} from "node:crypto";
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job,JobInput} from "../../queue/src/index";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {contentHash} from "./capabilities";
import {speechWavHeader} from "./speech";
import {verifyAudioWav} from "./audio-media";
import {dialogueAuditionAssets,dialogueReportAuditions} from "../../planner/src/dialogue-replacement";
import {narrationMediaNames} from "../../planner/src/narration-mix";
import {verifyNarrationFiles} from "./dialogue-replacement";
import {lipSyncPatch,lipSyncPreparedFiles,lipSyncWindow,validateLipSyncSource,validateLipSyncJob,validateLipSyncPrepared,validateLipSyncOutput,type LipSyncSource,type LipSyncPrepared,type LipSyncReport} from "../../planner/src/lipsync";
import {lipFail,lipNumber,lipSame} from "../../planner/src/lipsync-policy";
import {LIPSYNC_CAPABILITY} from "./lipsync-capability";
import {validateLipSyncDelivery,type LipSyncDelivery} from "./sync-lipsync";
import {exportC2paSigner,exportCredentials} from "../../assembler/src/export-credentials";
import {provenanceSidecarPath} from "../../planner/src/provenance";

const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
/** No shell interpolation or network protocols are used by media subprocesses. */
export async function lipCommand(args:string[],cwd:string,signal?:AbortSignal,input?:Uint8Array):Promise<Buffer>{
  signal?.throwIfAborted();const child=Bun.spawn(args,{cwd,stdin:input?"pipe":"ignore",stdout:"pipe",stderr:"pipe"}),abort=()=>{child.kill("SIGKILL");};
  const timeout=setTimeout(abort,20*60*1000);signal?.addEventListener("abort",abort,{once:true});
  const collect=async(stream:ReadableStream<Uint8Array>)=>{const chunks:Uint8Array[]=[];let total=0;for await(const chunk of stream){total+=chunk.byteLength;if(total>32*1024**2){abort();lipFail("Media command output exceeded its limit.");}chunks.push(chunk);}return Buffer.concat(chunks,total);};
  try{if(signal?.aborted)abort();if(input){child.stdin!.write(input);child.stdin!.end();}const [stdout,stderr,code]=await Promise.all([collect(child.stdout),collect(child.stderr),child.exited]);signal?.throwIfAborted();if(code!==0)lipFail("Lip-sync media processing failed: "+stderr.toString().slice(-300));return stdout;}
  finally{clearTimeout(timeout);signal?.removeEventListener("abort",abort);}
}
export function lipSourcePath(root:string,owner:Pick<Job,"projectId"|"id">,path:string):string{
  if(typeof path!=="string"||!path.startsWith(owner.projectId+"/"+owner.id+"/")||!/^[A-Za-z0-9._/-]+$/.test(path)||path.split("/").some(p=>!p||p==="."||p===".."))lipFail("Lip-sync source media escaped its job.");
  const location=resolve(root,path),scope=resolve(root,owner.projectId,owner.id)+sep;
  if(!existsSync(location)||!lstatSync(location).isFile()||lstatSync(location).isSymbolicLink()||!realpathSync(location).startsWith(scope)||lstatSync(location).size>8*1024**3)lipFail("The lip-sync source file is unavailable.");return location;
}
export async function lipFile(path:string,root:string,signal?:AbortSignal):Promise<RenderFile>{
  const checksum=createHash("sha256");let bytes=0;for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();bytes+=chunk.byteLength;if(bytes>8*1024**3)lipFail("Lip-sync media exceeded its size limit.");checksum.update(chunk);}
  if(!path.startsWith(realpathSync(root)+sep)||!bytes)lipFail("Invalid owned lip-sync artifact.");return {path:path.slice(realpathSync(root).length+1).split(sep).join("/"),sha256:checksum.digest("hex"),bytes};
}
async function verified(root:string,owner:Pick<Job,"projectId"|"id">,file:RenderFile,signal?:AbortSignal):Promise<string>{
  const path=lipSourcePath(root,owner,file.path),actual=await lipFile(path,root,signal);if(!lipSame(actual,file))lipFail("The lip-sync artifact failed checksum verification.");return path;
}
export async function lipVideoInfo(path:string,cwd:string,signal?:AbortSignal):Promise<{width:number;height:number;frames:number;fps:30}>{
  const data=JSON.parse((await lipCommand(["ffprobe","-v","error","-protocol_whitelist","file,pipe","-enable_drefs","0","-select_streams","v:0","-count_frames","-show_entries","stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,start_time,duration","-of","json",path],cwd,signal)).toString()),video=data.streams?.[0],frames=Number(video?.nb_read_frames);
  if(data.streams?.length!==1||video?.codec_name!=="h264"||video.r_frame_rate!=="30/1"||video.avg_frame_rate!=="30/1"||Number(video.start_time)!==0||!Number.isSafeInteger(frames)||frames<1||Math.abs(Number(video.duration)-frames/30)>.003)lipFail("Lip-sync needs measured H.264 video at 30 frames per second.");
  lipNumber(video.width,64,LIPSYNC_CAPABILITY.input.maxWidth,"Video width",true);lipNumber(video.height,64,LIPSYNC_CAPABILITY.input.maxHeight,"Video height",true);if(video.width%2||video.height%2)lipFail("Video dimensions must be even.");return {width:video.width,height:video.height,frames,fps:30};
}
async function imageRgb(png:Uint8Array,cwd:string,signal?:AbortSignal):Promise<Buffer>{return lipCommand(["ffmpeg","-v","error","-protocol_whitelist","file,pipe","-f","image2pipe","-vcodec","png","-i","pipe:0","-frames:v","1","-threads","1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],cwd,signal,png);}
export async function previewLipSyncFrame(source:LipSyncSource,root:string,shotId:string,lineIndex:number,frame:number,signal?:AbortSignal):Promise<{png:Buffer;frame:number;width:number;height:number;rgbSha256:string}>{
  validateLipSyncSource(source);const window=lipSyncWindow(source,shotId,lineIndex);lipNumber(frame,0,window.frames-1,"Speaker frame",true);
  const owner={projectId:source.projectId,id:source.jobId},video=await verified(root,owner,source.files.video,signal),info=await lipVideoInfo(video,root,signal);
  if(info.frames!==source.dialogue.totalFrames)lipFail("The source picture duration changed.");
  const png=await lipCommand(["ffmpeg","-v","error","-protocol_whitelist","file,pipe","-enable_drefs","0","-i",video,"-vf","select=eq(n\\,"+(window.startFrame+frame)+")","-frames:v","1","-threads","1","-f","image2pipe","-vcodec","png","pipe:1"],root,signal),rgb=await imageRgb(png,root,signal);
  if(rgb.byteLength!==info.width*info.height*3)lipFail("The speaker frame could not be verified.");return {png,frame,width:info.width,height:info.height,rgbSha256:hash(rgb)};
}
function ownedDirectory(root:string,job:Pick<Job,"projectId"|"id">,directory:string):void{
  const base=resolve(root,job.projectId,job.id);mkdirSync(base,{recursive:true});
  if(realpathSync(base)!==base||!base.startsWith(realpathSync(root)+sep)||!resolve(directory).startsWith(base+sep)||existsSync(directory))lipFail("Choose a new owned lip-sync directory.");mkdirSync(directory);
}
function inputAudio(job:Job|JobInput,wav:Buffer):Buffer{
  const plan=job.lipSync!,samples=plan.source.dialogue.totalSamples;if(!wav.subarray(0,44).equals(speechWavHeader(samples))||wav.byteLength!==44+samples*2)lipFail("The retained dialogue WAV changed format.");
  const window=plan.window,pcm=Buffer.alloc(window.frames*735*2),offset=window.startSample-window.startFrame*735;
  wav.copy(pcm,offset*2,44+window.startSample*2,44+window.endSample*2);return Buffer.concat([speechWavHeader(window.frames*735),pcm]);
}
export async function prepareLipSyncMedia(job:Job|JobInput,root:string,directory:string,assertAccess:()=>Promise<void>,signal?:AbortSignal):Promise<LipSyncPrepared>{
  validateLipSyncJob(job);await assertAccess();const plan=job.lipSync!,owner={id:plan.source.jobId,projectId:job.projectId};ownedDirectory(root,job,directory);
  const copies:Record<string,RenderFile>={};
  for(const [key,name,source]of [["sourceVideo","source.mp4",plan.source.files.video],["sourceAudio","source.wav",plan.source.files.audio],["sourceManifest","source.json",plan.source.files.manifest],["captions","captions.vtt",plan.source.files.captions],["srt","captions.srt",plan.source.files.srt]] as const){const path=await verified(root,owner,source,signal);copyFileSync(path,join(directory,name));copies[key]=await lipFile(join(directory,name),root,signal);}
  const sourceManifest=JSON.parse(readFileSync(join(directory,"source.json"),"utf8"));
  if(!plan.source.history.length){if(!lipSame(sourceManifest,plan.source.dialogue))lipFail("The source dialogue provenance changed.");}
  else if(sourceManifest.schema!=="hv-lipsync-result/1"||!lipSame(sourceManifest.history,plan.source.history)||!lipSame(sourceManifest.plan?.source?.dialogue,plan.source.dialogue)||sourceManifest.videoSha256!==plan.source.files.video.sha256||sourceManifest.audioSha256!==plan.source.files.audio.sha256)lipFail("The previous lip-sync provenance changed.");
  const auditions:RenderFile[]=[];mkdirSync(join(directory,"auditions"));for(const source of plan.source.files.auditions){const name=source.path.split("/auditions/").at(-1)!;if(!/^[A-Za-z0-9_-]+\.(wav|json)$/.test(name))lipFail("Invalid voice evidence path.");copyFileSync(await verified(root,owner,source,signal),join(directory,"auditions",name));auditions.push(await lipFile(join(directory,"auditions",name),root,signal));}
  const narration:RenderFile[]=[];for(const name of narrationMediaNames(plan.source.dialogue.narration)){const source=plan.source.files.narration!.find(f=>f.path.endsWith("/"+name))!,target=join(directory,name);mkdirSync(resolve(target,".."),{recursive:true});copyFileSync(await verified(root,owner,source,signal),target);narration.push(await lipFile(target,root,signal));}
  const preview=await previewLipSyncFrame(plan.source,root,plan.shotId,plan.lineIndex,plan.selection.frame,signal);if(preview.rgbSha256!==plan.selection.rgbSha256||preview.width!==plan.selection.width||preview.height!==plan.selection.height)lipFail("The selected speaker frame changed. Review the face again.");
  writeFileSync(join(directory,"speaker.png"),preview.png);writeFileSync(join(directory,"input.wav"),inputAudio(job,readFileSync(join(directory,"source.wav"))));await assertAccess();
  await lipCommand(["ffmpeg","-v","error","-protocol_whitelist","file,pipe","-enable_drefs","0","-i",join(directory,"source.mp4"),"-vf",`trim=start_frame=${plan.window.startFrame}:end_frame=${plan.window.startFrame+plan.window.frames},setpts=PTS-STARTPTS`,"-an","-r","30","-c:v","libx264","-preset","medium","-crf","18","-pix_fmt","yuv420p","-threads","1","-movflags","+faststart","-frames:v",String(plan.window.frames),join(directory,"input.mp4")],directory,signal);
  const data={schema:plan.source.dialogue.narration?"hv-lipsync-prepared/2" as const:"hv-lipsync-prepared/1" as const,planRevision:plan.revision,video:await lipFile(join(directory,"input.mp4"),root,signal),audio:await lipFile(join(directory,"input.wav"),root,signal),frame:await lipFile(join(directory,"speaker.png"),root,signal),sourceVideo:copies.sourceVideo!,sourceAudio:copies.sourceAudio!,sourceManifest:copies.sourceManifest!,captions:copies.captions!,srt:copies.srt!,auditions,...(plan.source.dialogue.narration?{narration}:{}),rgbSha256:preview.rgbSha256};
  const prepared={...data,revision:contentHash(data)};await verifyLipSyncPrepared(job,prepared,root,signal);await assertAccess();return prepared;
}
export async function verifyLipSyncPrepared(job:Job|JobInput,prepared:LipSyncPrepared,root:string,signal?:AbortSignal):Promise<void>{
  validateLipSyncPrepared(job,prepared);for(const file of lipSyncPreparedFiles(prepared))await verified(root,job,file,signal);
  const plan=job.lipSync!,video=await lipVideoInfo(lipSourcePath(root,job,prepared.video.path),root,signal);
  if(video.width!==plan.selection.width||video.height!==plan.selection.height||video.frames!==plan.window.frames)lipFail("The prepared video changed its frame range or dimensions.");
  const wav=readFileSync(lipSourcePath(root,job,prepared.sourceAudio.path));if(!readFileSync(lipSourcePath(root,job,prepared.audio.path)).equals(inputAudio(job,wav)))lipFail("The provider input changed the selected dialogue waveform.");
  if(plan.source.dialogue.narration)await verifyNarrationFiles(plan.source.dialogue.narration,resolve(lipSourcePath(root,job,prepared.sourceAudio.path),".."),wav,signal);
  const rgb=await imageRgb(readFileSync(lipSourcePath(root,job,prepared.frame.path)),root,signal);if(rgb.length!==plan.selection.width*plan.selection.height*3||hash(rgb)!==plan.selection.rgbSha256)lipFail("The saved speaker frame differs from its review.");
}
export async function renderLipSyncVersion(job:Job|JobInput,prepared:LipSyncPrepared,video:Buffer,delivery:LipSyncDelivery,root:string,directory:string,assertAccess:()=>Promise<void>,signal?:AbortSignal):Promise<NonNullable<Job["output"]>>{
  await verifyLipSyncPrepared(job,prepared,root,signal);validateLipSyncDelivery(delivery,job.lipSync!,prepared);if(hash(video)!==delivery.videoSha256||video.length!==delivery.videoBytes)lipFail("The downloaded lip-sync video changed.");
  // HV-031-17: the host's signing key is loaded and checked before the version is encoded.
  const signer=exportC2paSigner();await assertAccess();ownedDirectory(root,job,directory);
  const plan=job.lipSync!,provider=join(directory,"provider.mp4"),source=lipSourcePath(root,job,prepared.sourceVideo.path),wav=join(directory,"dialogue.wav");writeFileSync(provider,video);copyFileSync(lipSourcePath(root,job,prepared.sourceAudio.path),wav);
  for(const name of narrationMediaNames(plan.source.dialogue.narration)){const file=prepared.narration!.find(f=>f.path.endsWith("/"+name))!,target=join(directory,name);mkdirSync(resolve(target,".."),{recursive:true});copyFileSync(lipSourcePath(root,job,file.path),target);}
  const info=await lipVideoInfo(provider,directory,signal);if(info.frames!==plan.window.frames||info.width!==plan.selection.width||info.height!==plan.selection.height)lipFail("The provider changed the selected duration or frame size. The original cut remains available.");
  const sourceInfo=await lipVideoInfo(source,directory,signal);if(sourceInfo.frames!==job.totalFrames||sourceInfo.width!==info.width||sourceInfo.height!==info.height)lipFail("The source cut changed before assembly.");
  const filters:string[]=[],parts:string[]=[];let n=0;const add=(input:string,filter:string)=>{const label="part"+n++;filters.push(input+filter+"["+label+"]");parts.push("["+label+"]");};
  if(plan.window.startFrame)add("[0:v]",`trim=end_frame=${plan.window.startFrame},setpts=PTS-STARTPTS`);add("[1:v]","setpts=PTS-STARTPTS");const end=plan.window.startFrame+plan.window.frames;if(end<job.totalFrames)add("[0:v]",`trim=start_frame=${end},setpts=PTS-STARTPTS`);
  filters.push(parts.join("")+`concat=n=${parts.length}:v=1:a=0[out]`);
  await lipCommand(["ffmpeg","-v","error","-protocol_whitelist","file,pipe","-enable_drefs","0","-i",source,"-protocol_whitelist","file,pipe","-enable_drefs","0","-i",provider,"-i",plan.source.dialogue.narration?join(directory,"mix.wav"):wav,"-filter_complex",filters.join(";"),"-map","[out]","-map","2:a:0","-c:v","libx264","-preset","medium","-crf","18","-pix_fmt","yuv420p","-r","30","-threads","1","-c:a","aac","-b:a","96k","-ar","22050","-ac","1","-frames:v",String(job.totalFrames),"-movflags","+faststart",join(directory,"export.mp4")],directory,signal);
  await assertAccess();copyFileSync(lipSourcePath(root,job,prepared.captions.path),join(directory,"captions.vtt"));copyFileSync(lipSourcePath(root,job,prepared.srt.path),join(directory,"captions.srt"));mkdirSync(join(directory,"auditions"));
  for(const file of prepared.auditions)copyFileSync(lipSourcePath(root,job,file.path),join(directory,"auditions",file.path.split("/auditions/").at(-1)!));
  mkdirSync(join(directory,"hls"));await lipCommand(["ffmpeg","-v","error","-protocol_whitelist","file,pipe","-enable_drefs","0","-i",join(directory,"export.mp4"),"-c","copy","-hls_time","6","-hls_playlist_type","vod","-hls_segment_filename",join(directory,"hls/segment-%03d.ts"),join(directory,"hls/index.m3u8")],directory,signal);
  const {credentials,sidecarPath}=await exportCredentials(signer,{mp4Path:join(directory,"export.mp4"),recordDirectory:directory,spec:"hv-lipsync-result/1",projectId:job.projectId},signal);await assertAccess();
  const report:LipSyncReport={schema:"hv-lipsync-result/1",plan:structuredClone(plan),prepared:structuredClone(prepared),delivery:structuredClone(delivery),history:[...plan.source.history,lipSyncPatch(job.id,plan,prepared,delivery)],videoSha256:(await lipFile(join(directory,"export.mp4"),root,signal)).sha256,audioSha256:(await lipFile(wav,root,signal)).sha256,totalFrames:job.totalFrames,picture:"new-encode-with-selected-window",audio:"retained-waveform",credentials};
  writeFileSync(join(directory,"provenance.json"),JSON.stringify(report));const files:RenderFile[]=[];if(sidecarPath)files.push(await lipFile(sidecarPath,root,signal));
  for(const name of ["export.mp4","dialogue.wav","provider.mp4","captions.vtt","captions.srt","provenance.json","hls/index.m3u8",...narrationMediaNames(plan.source.dialogue.narration),...readdirSync(join(directory,"hls")).filter(n=>/^segment-\d{3,5}\.ts$/.test(n)).map(n=>"hls/"+n),...readdirSync(join(directory,"auditions")).map(n=>"auditions/"+n)])files.push(await lipFile(join(directory,name),root,signal));
  const path=(name:string)=>files.find(f=>f.path.endsWith("/"+name))!.path,data={schema:"hv-lipsync-output/1" as const,report,wavPath:path("dialogue.wav"),providerVideoPath:path("provider.mp4"),files};
  const output={mp4Path:path("export.mp4"),captionsPath:path("captions.vtt"),manifestPath:path("provenance.json"),...(sidecarPath?{c2paPath:provenanceSidecarPath(path("provenance.json"))}:{}),hlsPlaylistPath:path("hls/index.m3u8"),lipSync:{...data,revision:contentHash(data)}};
  await verifyLipSyncMedia(job,output,root,signal);await assertAccess();return output;
}
export async function verifyLipSyncMedia(job:Job|JobInput,output:NonNullable<Job["output"]>,root:string,signal?:AbortSignal):Promise<void>{
  validateLipSyncOutput(job,output);const result=output.lipSync!,plan=job.lipSync!;for(const file of result.files)await verified(root,job,file,signal);
  if(!lipSame(JSON.parse(readFileSync(lipSourcePath(root,job,output.manifestPath),"utf8")),result.report))lipFail("The lip-sync manifest changed.");
  const video=await lipVideoInfo(lipSourcePath(root,job,output.mp4Path),root,signal),provider=await lipVideoInfo(lipSourcePath(root,job,result.providerVideoPath),root,signal);
  if(video.frames!==job.totalFrames||provider.frames!==plan.window.frames||[video,provider].some(v=>v.width!==plan.selection.width||v.height!==plan.selection.height))lipFail("The lip-sync export changed timing or dimensions.");
  const wav=readFileSync(lipSourcePath(root,job,result.wavPath));if(wav.byteLength!==44+plan.source.dialogue.totalSamples*2||!wav.subarray(0,44).equals(speechWavHeader(plan.source.dialogue.totalSamples)))lipFail("The lip-sync export changed the retained waveform format.");
  const directory=output.mp4Path.slice(0,-"export.mp4".length);for(const [path,source]of [[output.captionsPath,plan.source.files.captions],[directory+"captions.srt",plan.source.files.srt]] as const)if(result.files.find(f=>f.path===path)!.sha256!==source.sha256)lipFail("The lip-sync captions changed.");
  for(const asset of dialogueAuditionAssets(dialogueReportAuditions(plan.source.dialogue))){const bytes=readFileSync(lipSourcePath(root,job,directory+asset.name));if(asset.name.endsWith(".wav"))verifyAudioWav(bytes,asset.source.output.report);else if(!lipSame(JSON.parse(bytes.toString()),asset.source.output.report))lipFail("Original voice evidence changed.");}
  if(plan.source.dialogue.narration)await verifyNarrationFiles(plan.source.dialogue.narration,resolve(lipSourcePath(root,job,result.wavPath),".."),wav,signal);
  const playlist=readFileSync(lipSourcePath(root,job,output.hlsPlaylistPath),"utf8"),segments=playlist.split(/\r?\n/).filter(line=>line&&!line.startsWith("#"));
  if(!playlist.startsWith("#EXTM3U")||!playlist.includes("#EXT-X-ENDLIST")||!segments.length||segments.some(name=>!/^segment-\d{3,5}\.ts$/.test(name)||!result.files.some(f=>f.path===directory+"hls/"+name))||new Set(segments).size!==segments.length)lipFail("The lip-sync HLS playlist is invalid.");
}
