import type {Job,JobInput} from "../../queue/src/index";
import type {Project,PersistedProject} from "../../api/src/index";
import type {RenderFile} from "./shot-reuse";
import {renderShots} from "./shot-reuse";
import {contentHash} from "../../generator/src/capabilities";
import {LIPSYNC_CAPABILITY} from "../../generator/src/lipsync-capability";
import {dialogueAuditionAssets,validateDialogueReplacementReport,type DialogueReplacementReport} from "./dialogue-replacement";
import {assertDialoguePermissions,retainedDialogueTime,validateDialogueOutput} from "./dialogue-jobs";
import {configuredAudioPolicies} from "../../generator/src/audio-config";
import {assertRetainedAuditionPermission} from "./retained-auditions";
import {configuredLipSyncPolicy,lipDate,lipFail,lipHash,lipId,lipNumber,lipRecord,lipSame,validateLipSyncPolicy,type LipSyncPolicy} from "./lipsync-policy";
import {validateLipSyncDelivery,type LipSyncDelivery} from "../../generator/src/sync-lipsync";

export interface LipSyncWindow {startFrame:number;frames:number;startSample:number;endSample:number}
export interface LipSyncPatch {jobId:string;sourceJobId:string;sourceOutputRevision:string;planRevision:string;characterId:string;shotId:string;lineIndex:number;window:LipSyncWindow;generationId:string;attemptId:string;inputVideoSha256:string;inputAudioSha256:string;outputVideoSha256:string;revision:string}
/** Flat source receipt: repeated passes never nest whole prior jobs. */
export interface LipSyncSource {schema:"hv-lipsync-source/1";projectId:string;jobId:string;completedAt:string;linkExpiresAt:string;outputRevision:string;film:Job;dialogue:DialogueReplacementReport;
  files:{video:RenderFile;audio:RenderFile;manifest:RenderFile;captions:RenderFile;srt:RenderFile;auditions:RenderFile[]};history:LipSyncPatch[];revision:string}
export interface LipSyncSelection {frame:number;width:number;height:number;x:number;y:number;rgbSha256:string}
export interface LipSyncPlan {schema:"hv-lipsync-plan/1";source:LipSyncSource;shotId:string;lineIndex:number;sourceHash:string;characterId:string;window:LipSyncWindow;selection:LipSyncSelection;
  policy:LipSyncPolicy;capabilityRevision:string;storage:"local"|"s3";requestHash:string;admittedAt:string;revision:string}
export interface LipSyncPrepared {schema:"hv-lipsync-prepared/1";planRevision:string;video:RenderFile;audio:RenderFile;frame:RenderFile;sourceVideo:RenderFile;sourceAudio:RenderFile;sourceManifest:RenderFile;captions:RenderFile;srt:RenderFile;auditions:RenderFile[];rgbSha256:string;revision:string}
export interface LipSyncReport {schema:"hv-lipsync-result/1";plan:LipSyncPlan;prepared:LipSyncPrepared;delivery:LipSyncDelivery;history:LipSyncPatch[];videoSha256:string;audioSha256:string;totalFrames:number;picture:"new-encode-with-selected-window";audio:"retained-waveform"}
export interface LipSyncOutput {schema:"hv-lipsync-output/1";report:LipSyncReport;wavPath:string;providerVideoPath:string;files:RenderFile[];revision:string}
export interface LipSyncReview {version:number;outputRevision:string;rubric:"owner-rubric/1";mouthSync:number;faceStability:number;expression:number;decision:"accept"|"revise"|"cutaway";notes:string;at:string;revision:string}
export interface LipSyncReviews {version:number;entries:LipSyncReview[]}
export const emptyLipSyncReviews=():LipSyncReviews=>({version:0,entries:[]});
const historicalTime=(source:LipSyncSource)=>Date.parse(source.dialogue.plan.baseline?.completedAt??source.film.completedAt??"");
function file(value:RenderFile,projectId:string,jobId:string):RenderFile{
  lipRecord(value,["path","sha256","bytes"]);lipHash(value.sha256);lipNumber(value.bytes,1,8*1024**3,"Artifact bytes",true);
  if(typeof value.path!=="string"||value.path.length>1024||!value.path.startsWith(lipId(projectId)+"/"+lipId(jobId)+"/")||!/^[A-Za-z0-9._/-]+$/.test(value.path)||value.path.split("/").some(p=>!p||p==="."||p===".."))lipFail("Lip-sync media is outside its owner.");return value;
}
export function lipSyncSourceFiles(source:LipSyncSource):RenderFile[]{return [source.files.video,source.files.audio,source.files.manifest,source.files.captions,source.files.srt,...source.files.auditions];}
export function lipSyncPreparedFiles(prepared:LipSyncPrepared):RenderFile[]{return [prepared.video,prepared.audio,prepared.frame,prepared.sourceVideo,prepared.sourceAudio,prepared.sourceManifest,prepared.captions,prepared.srt,...prepared.auditions];}
export function validateLipSyncSource(source:LipSyncSource,now?:number):LipSyncSource{
  lipRecord(source,["schema","projectId","jobId","completedAt","linkExpiresAt","outputRevision","film","dialogue","files","history","revision"]);
  if(source.schema!=="hv-lipsync-source/1"||source.projectId!==source.film?.projectId||source.jobId===source.film.id||source.film.lipSync||source.film.dialogueReplacement)lipFail("Choose a retained dialogue or lip-sync version.");
  lipId(source.projectId);lipId(source.jobId);lipHash(source.outputRevision);lipDate(source.completedAt);lipDate(source.linkExpiresAt);
  if(Date.parse(source.linkExpiresAt)<=Date.parse(source.completedAt)||(now!==undefined&&(!Number.isFinite(now)||Date.parse(source.linkExpiresAt)<=now)))lipFail("The selected lip-sync source expired.");
  validateDialogueReplacementReport(source.film,source.dialogue,historicalTime(source));
  lipRecord(source.files,["video","audio","manifest","captions","srt","auditions"]);
  if(!Array.isArray(source.files.auditions)||!Array.isArray(source.history)||source.history.length>32)lipFail("Invalid lip-sync source history.");
  const files=lipSyncSourceFiles(source);files.forEach(f=>file(f,source.projectId,source.jobId));if(new Set(files.map(f=>f.path)).size!==files.length)lipFail("Duplicate lip-sync source media.");
  if(source.files.audio.sha256!==source.dialogue.audioSha256||source.files.audio.bytes!==44+source.dialogue.totalSamples*2)lipFail("The retained dialogue waveform changed.");
  const assets=dialogueAuditionAssets(source.dialogue.lines);if(source.files.auditions.length!==assets.length||assets.some(a=>!source.files.auditions.some(f=>f.path.endsWith("/"+a.name)&&f.sha256===a.file.sha256&&f.bytes===a.file.bytes)))lipFail("The source lost its original voice evidence.");
  for(const patch of source.history){
    lipRecord(patch,["jobId","sourceJobId","sourceOutputRevision","planRevision","characterId","shotId","lineIndex","window","generationId","attemptId","inputVideoSha256","inputAudioSha256","outputVideoSha256","revision"]);
    for(const key of ["jobId","sourceJobId","characterId","shotId","generationId","attemptId"] as const)lipId(patch[key]);for(const key of ["sourceOutputRevision","planRevision","inputVideoSha256","inputAudioSha256","outputVideoSha256"] as const)lipHash(patch[key]);
    const line=source.dialogue.lines.find(l=>l.shotId===patch.shotId&&l.source.index===patch.lineIndex);if(!line?.audition||line.audition.source.take.characterId!==patch.characterId||!lipSame(patch.window,lipSyncWindow(source,patch.shotId,patch.lineIndex)))lipFail("A prior lip-sync pass changed its line.");
    const {revision,...data}=patch;if(contentHash(data)!==revision)lipFail("A prior lip-sync receipt changed.");
  }
  if(new Set(source.history.map(p=>p.jobId)).size!==source.history.length||source.history.length&&source.history.at(-1)!.jobId!==source.jobId)lipFail("The source pass history is inconsistent.");
  const {revision,...data}=source;if(contentHash(data)!==revision)lipFail("The selected lip-sync source changed.");return structuredClone(source);
}
export function retainLipSyncSource(job:Job,now=Date.now()):LipSyncSource{
  if(job.status!=="done"||!job.output||!job.completedAt||!job.linkExpiresAt)lipFail("Choose a completed dialogue version first.");
  let film:Job,dialogue:DialogueReplacementReport,history:LipSyncPatch[],files:RenderFile[],wavPath:string;
  if(job.dialogueReplacement&&job.output.dialogue){validateDialogueOutput(job,job.output,retainedDialogueTime(job));film=job.dialogueReplacement.source;dialogue=job.output.dialogue.report;history=[];files=job.output.dialogue.files;wavPath=job.output.dialogue.wavPath;}
  else if(job.lipSync&&job.output.lipSync){validateLipSyncOutput(job,job.output);film=job.lipSync.source.film;dialogue=job.lipSync.source.dialogue;history=job.output.lipSync.report.history;files=job.output.lipSync.files;wavPath=job.output.lipSync.wavPath;}
  else lipFail("Apply a saved dialogue take before directing lip-sync.");
  const find=(path:string)=>{const found=files.find(f=>f.path===path);if(!found)lipFail("A source artifact is missing.");return structuredClone(found);};
  const directory=job.output.mp4Path.slice(0,-"export.mp4".length);
  const data={schema:"hv-lipsync-source/1" as const,projectId:job.projectId,jobId:job.id,completedAt:job.completedAt,linkExpiresAt:job.linkExpiresAt,outputRevision:contentHash(job.output),film:structuredClone(film),dialogue:structuredClone(dialogue),
    files:{video:find(job.output.mp4Path),audio:find(wavPath),manifest:find(job.output.manifestPath),captions:find(job.output.captionsPath),srt:find(directory+"captions.srt"),auditions:dialogueAuditionAssets(dialogue.lines).map(a=>find(directory+a.name))},history:structuredClone(history)};
  return validateLipSyncSource({...data,revision:contentHash(data)},now);
}
export function lipSyncWindow(source:LipSyncSource,shotId:string,lineIndex:number):LipSyncWindow{
  lipId(shotId);lipNumber(lineIndex,0,127,"Dialogue line",true);const line=source.dialogue.lines.find(l=>l.shotId===shotId&&l.source.index===lineIndex);
  if(!line?.audition)lipFail("Choose a line with an applied retained voice take.");
  const startFrame=Math.floor(line.startSample/735),endFrame=Math.ceil(line.endSample/735);
  if(startFrame<0||endFrame>source.dialogue.totalFrames||endFrame<=startFrame)lipFail("The line has invalid picture timing.");return {startFrame,frames:endFrame-startFrame,startSample:line.startSample,endSample:line.endSample};
}
export function createLipSyncPlan(source:LipSyncSource,shotId:string,lineIndex:number,selection:LipSyncSelection,policy:LipSyncPolicy,storage:LipSyncPlan["storage"],requestHash:string,now=Date.now()):LipSyncPlan{
  const retained=validateLipSyncSource(source,now),checked=validateLipSyncPolicy(policy,now),window=lipSyncWindow(retained,shotId,lineIndex),line=retained.dialogue.lines.find(l=>l.shotId===shotId&&l.source.index===lineIndex)!;
  if(retained.history.length>=32)lipFail("This cut has reached its 32 retained lip-sync passes.");if(window.frames>checked.maxFrames)lipFail("This line exceeds the configured lip-sync duration. Review a shorter dialogue take.");
  lipRecord(selection,["frame","width","height","x","y","rgbSha256"]);lipNumber(selection.frame,0,window.frames-1,"Speaker frame",true);lipNumber(selection.width,64,LIPSYNC_CAPABILITY.input.maxWidth,"Frame width",true);lipNumber(selection.height,64,LIPSYNC_CAPABILITY.input.maxHeight,"Frame height",true);
  lipNumber(selection.x,0,selection.width-1,"Face position X",true);lipNumber(selection.y,0,selection.height-1,"Face position Y",true);lipHash(selection.rgbSha256);if(selection.width%2||selection.height%2)lipFail("The source frame needs even video dimensions.");
  if(!["local","s3"].includes(storage))lipFail("Invalid lip-sync storage.");
  const data={schema:"hv-lipsync-plan/1" as const,source:retained,shotId,lineIndex,sourceHash:line.source.hash,characterId:line.audition!.source.take.characterId,window,selection:structuredClone(selection),policy:checked,capabilityRevision:LIPSYNC_CAPABILITY.revision,storage,requestHash:lipHash(requestHash),admittedAt:new Date(now).toISOString()};return {...data,revision:contentHash(data)};
}
export function validateLipSyncPlan(plan:LipSyncPlan):LipSyncPlan{
  lipRecord(plan,["schema","source","shotId","lineIndex","sourceHash","characterId","window","selection","policy","capabilityRevision","storage","requestHash","admittedAt","revision"]);
  const valid=createLipSyncPlan(plan.source,plan.shotId,plan.lineIndex,plan.selection,plan.policy,plan.storage,plan.requestHash,Date.parse(lipDate(plan.admittedAt)));if(!lipSame(valid,plan))lipFail("The reviewed lip-sync plan changed.");return valid;
}
export function assertLipSyncPermission(plan:LipSyncPlan,project:Project|PersistedProject|null|undefined,now=Date.now()):void{
  validateLipSyncPlan(plan);assertDialoguePermissions(plan.source.film,project,now);const policies=configuredAudioPolicies();
  for(const asset of dialogueAuditionAssets(plan.source.dialogue.lines).filter(a=>a.name.endsWith(".wav")))assertRetainedAuditionPermission(asset.source,project??undefined,policies.find(p=>p.voiceId===asset.source.take.policy.voiceId),now);
}
export function assertLipSyncSourceAvailable(plan:LipSyncPlan,current:Job|undefined,now=Date.now()):void{
  if(!current||!lipSame(retainLipSyncSource(current,now),plan.source))lipFail("The selected dialogue cut changed or expired. Review it again.");
}
export function assertLipSyncPlayback(job:Job,project:Project|PersistedProject|null|undefined,now=Date.now()):void{
  if(job.status!=="done"||!job.output?.lipSync||!job.linkExpiresAt||!Number.isFinite(Date.parse(job.linkExpiresAt))||Date.parse(job.linkExpiresAt)<=now)lipFail("This lip-sync result is unavailable or expired.");
  validateLipSyncOutput(job,job.output);assertLipSyncPermission(job.lipSync!,project,now);const current=configuredLipSyncPolicy();
  if(!current||validateLipSyncPolicy(current,now).permissionRevision!==job.lipSync!.policy.permissionRevision)lipFail("The lip-sync provider permission is unavailable.");
  validateLipSyncReviews(job.lipSyncReviews??emptyLipSyncReviews(),contentHash(job.output));
}
export function validateLipSyncJob(job:Job|JobInput):void{
  if((job.stage==="lip-sync")!==Boolean(job.lipSync))lipFail("Lip-sync needs its own admitted job.");
  if(!job.lipSync){if(job.lipSyncPrepared||job.lipSyncCheckpoint||job.lipSyncReviews||job.output?.lipSync)lipFail("A different job cannot carry lip-sync media.");return;}
  const plan=validateLipSyncPlan(job.lipSync);
  if(job.projectId!==plan.source.projectId||job.id===plan.source.jobId||job.providerPlan||job.providerSpec||job.casting||job.direction||job.shotReuse||job.shotTakes||job.characterSheet||job.dialogueReplacement||job.audioTake||job.audioCheckpoint||job.audioOutput||job.dialogueCheckpoint
    ||job.scriptText!==plan.source.film.scriptText||job.scriptVersion!==plan.source.film.scriptVersion||!job.rightsAttestedAt||job.totalFrames!==plan.source.dialogue.totalFrames||job.costCapUsd!==plan.policy.heldUsd||job.budgetReservedUsd!==plan.policy.heldUsd)lipFail("Invalid isolated lip-sync job context.");
}
export function assertLipSyncIdempotency(existing:Job|undefined,input:JobInput):void{
  const stable=(plan:LipSyncPlan|undefined)=>{if(!plan)return null;const {admittedAt:_at,revision:_revision,...data}=plan;return data;};
  if(existing&&(existing.lipSync||input.lipSync||existing.stage==="lip-sync"||input.stage==="lip-sync")&&(existing.stage!==input.stage||!lipSame(stable(existing.lipSync),stable(input.lipSync))))lipFail("This key belongs to a different lip-sync request. Use a new key for another pass.");
}
export function validateLipSyncPrepared(job:Job|JobInput,prepared:LipSyncPrepared):void{
  validateLipSyncJob(job);const plan=job.lipSync!;lipRecord(prepared,["schema","planRevision","video","audio","frame","sourceVideo","sourceAudio","sourceManifest","captions","srt","auditions","rgbSha256","revision"]);
  if(prepared.schema!=="hv-lipsync-prepared/1"||prepared.planRevision!==plan.revision||prepared.rgbSha256!==plan.selection.rgbSha256||!Array.isArray(prepared.auditions))lipFail("The prepared speaker frame differs from its review.");
  const files=lipSyncPreparedFiles(prepared);files.forEach(f=>file(f,job.projectId,job.id));if(new Set(files.map(f=>f.path)).size!==files.length)lipFail("Duplicate prepared media.");
  if(prepared.video.bytes>LIPSYNC_CAPABILITY.input.maxFileBytes||prepared.audio.bytes>LIPSYNC_CAPABILITY.input.maxFileBytes||prepared.audio.bytes!==44+plan.window.frames*735*2)lipFail("The prepared lip-sync input exceeds its bound.");
  for(const [key,source]of [["sourceVideo",plan.source.files.video],["sourceAudio",plan.source.files.audio],["sourceManifest",plan.source.files.manifest],["captions",plan.source.files.captions],["srt",plan.source.files.srt]] as const)if(prepared[key].sha256!==source.sha256||prepared[key].bytes!==source.bytes)lipFail("A prepared source copy changed.");
  if(prepared.auditions.length!==plan.source.files.auditions.length||plan.source.files.auditions.some(s=>!prepared.auditions.some(f=>f.sha256===s.sha256&&f.bytes===s.bytes&&f.path.endsWith("/auditions/"+s.path.split("/auditions/").at(-1)))))lipFail("Prepared voice evidence changed.");
  const {revision,...data}=prepared;if(contentHash(data)!==revision)lipFail("Prepared lip-sync media changed.");
}
export function validateLipSyncReviews(value:LipSyncReviews,outputRevision?:string):LipSyncReviews{
  lipRecord(value,["version","entries"]);if(!Array.isArray(value.entries)||value.version!==value.entries.length||value.version>100)lipFail("Invalid lip-sync review history.");let last=-Infinity;
  for(const [i,entry]of value.entries.entries()){
    lipRecord(entry,["version","outputRevision","rubric","mouthSync","faceStability","expression","decision","notes","at","revision"]);lipHash(entry.outputRevision);lipDate(entry.at);
    if(entry.version!==i+1||entry.rubric!=="owner-rubric/1"||(outputRevision&&entry.outputRevision!==outputRevision)||Date.parse(entry.at)<last||!["accept","revise","cutaway"].includes(entry.decision)||typeof entry.notes!=="string"||entry.notes.length>600||[...entry.notes].some(c=>c.charCodeAt(0)<32&&![9,10,13].includes(c.charCodeAt(0))))lipFail("Invalid owner lip-sync assessment.");
    const scores=[entry.mouthSync,entry.faceStability,entry.expression];scores.forEach(n=>lipNumber(n,1,5,"Review rating",true));if((Math.min(...scores)<3||entry.decision!=="accept")&&entry.notes.trim().length<10)lipFail("Describe the visible issue in at least ten characters.");
    const {revision,...data}=entry;if(contentHash(data)!==revision)lipFail("A lip-sync assessment changed.");last=Date.parse(entry.at);
  }return structuredClone(value);
}
export function addLipSyncReview(job:Job,input:Pick<LipSyncReview,"mouthSync"|"faceStability"|"expression"|"decision"|"notes">,expectedVersion:number,expectedOutputRevision:string,now=Date.now()):LipSyncReviews{
  if(job.status!=="done"||!job.output?.lipSync||contentHash(job.output)!==expectedOutputRevision)lipFail("Choose the completed lip-sync result to review.");
  lipRecord(input,["mouthSync","faceStability","expression","decision","notes"]);const history=validateLipSyncReviews(job.lipSyncReviews??emptyLipSyncReviews(),expectedOutputRevision);
  if(history.version!==expectedVersion)lipFail("The review changed in another window. Refresh the result.");
  if(typeof input.notes!=="string")lipFail("Use text for review notes.");
  const data={version:history.version+1,outputRevision:expectedOutputRevision,rubric:"owner-rubric/1" as const,...input,notes:input.notes.trim(),at:new Date(Math.max(now,Date.parse(history.entries.at(-1)?.at??"")||0)).toISOString()};
  return validateLipSyncReviews({version:data.version,entries:[...history.entries,{...data,revision:contentHash(data)}]},expectedOutputRevision);
}
export function lipSyncCutaways(source:LipSyncSource,shotId:string):{shotId:string;reason:string;startFrame:number;frames:number}[]{
  const shots=renderShots(source.film,Date.parse(source.film.startedAt??source.film.completedAt??"")),selected=shots.find(s=>s.id===shotId);let offset=0;
  return source.film.output!.shotRenders!.flatMap(record=>{const startFrame=offset,frames=Math.round(record.clip.durationSec*30);offset+=frames;const shot=shots.find(s=>s.id===record.shotId);
    return shot&&selected&&shot.sceneIndex===selected.sceneIndex&&shot.id!==selected.id&&!record.clip.speech?.lines.length?[{shotId:shot.id,reason:"Retained shot in this scene without recorded dialogue",startFrame,frames}]:[];}).slice(0,3);
}
export function lipSyncPatch(jobId:string,plan:LipSyncPlan,prepared:LipSyncPrepared,delivery:LipSyncDelivery):LipSyncPatch{
  validateLipSyncDelivery(delivery,plan,prepared);
  const data={jobId:lipId(jobId),sourceJobId:plan.source.jobId,sourceOutputRevision:plan.source.outputRevision,planRevision:plan.revision,characterId:plan.characterId,shotId:plan.shotId,lineIndex:plan.lineIndex,window:structuredClone(plan.window),generationId:delivery.generationId,attemptId:delivery.attemptId,inputVideoSha256:prepared.video.sha256,inputAudioSha256:prepared.audio.sha256,outputVideoSha256:delivery.videoSha256};
  return {...data,revision:contentHash(data)};
}
export function validateLipSyncOutput(job:Job|JobInput,output:NonNullable<Job["output"]>):void{
  validateLipSyncJob(job);const result=output?.lipSync;if(!result)lipFail("The lip-sync job has no independent output.");
  lipRecord(output,["mp4Path","hlsPlaylistPath","captionsPath","manifestPath","lipSync"]);lipRecord(result,["schema","report","wavPath","providerVideoPath","files","revision"]);
  if(result.schema!=="hv-lipsync-output/1"||!Array.isArray(result.files)||result.files.length<8||result.files.length>20000)lipFail("Invalid lip-sync output files.");
  const report=result.report;lipRecord(report,["schema","plan","prepared","delivery","history","videoSha256","audioSha256","totalFrames","picture","audio"]);
  if(report.schema!=="hv-lipsync-result/1"||!lipSame(report.plan,job.lipSync)||report.picture!=="new-encode-with-selected-window"||report.audio!=="retained-waveform"||report.audioSha256!==job.lipSync!.source.dialogue.audioSha256||report.totalFrames!==job.totalFrames)lipFail("The lip-sync output changed its admitted source.");
  validateLipSyncPrepared(job,report.prepared);lipHash(report.videoSha256);result.files.forEach(f=>file(f,job.projectId,job.id));
  validateLipSyncDelivery(report.delivery,job.lipSync!,report.prepared);
  if(!lipSame(report.history,[...job.lipSync!.source.history,lipSyncPatch(job.id,job.lipSync!,report.prepared,report.delivery)]))lipFail("The lip-sync pass history changed.");
  const directory=output.mp4Path.slice(0,-"export.mp4".length),required=[output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.manifestPath,result.wavPath,result.providerVideoPath,directory+"captions.srt",...dialogueAuditionAssets(job.lipSync!.source.dialogue.lines).map(a=>directory+a.name)];
  if(result.files.some(f=>!required.includes(f.path)&&(!f.path.startsWith(directory+"hls/")||!/^segment-\d{3,5}\.ts$/.test(f.path.slice((directory+"hls/").length)))))lipFail("The lip-sync result contains an unexpected artifact.");
  if(!output.mp4Path.endsWith("/export.mp4")||output.manifestPath!==directory+"provenance.json"||output.captionsPath!==directory+"captions.vtt"||output.hlsPlaylistPath!==directory+"hls/index.m3u8"||result.wavPath!==directory+"dialogue.wav"||result.providerVideoPath!==directory+"provider.mp4"||new Set(result.files.map(f=>f.path)).size!==result.files.length||required.some(path=>!result.files.some(f=>f.path===path)))lipFail("The lip-sync output is missing required media.");
  for(const asset of dialogueAuditionAssets(job.lipSync!.source.dialogue.lines)){const saved=result.files.find(f=>f.path===directory+asset.name)!;if(saved.sha256!==asset.file.sha256||saved.bytes!==asset.file.bytes)lipFail("The lip-sync output lost original voice evidence.");}
  if(result.files.find(f=>f.path===output.mp4Path)!.sha256!==report.videoSha256||result.files.find(f=>f.path===result.wavPath)!.sha256!==report.audioSha256||result.files.find(f=>f.path===result.providerVideoPath)!.sha256!==report.delivery.videoSha256||result.files.find(f=>f.path===result.providerVideoPath)!.bytes!==report.delivery.videoBytes)lipFail("Lip-sync output bytes differ from the report.");
  const {revision,...data}=result;if(contentHash(data)!==revision)lipFail("The lip-sync media receipt changed.");
}
