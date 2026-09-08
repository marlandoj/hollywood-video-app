import type {Job} from "../../queue/src/index";
import {createHash} from "node:crypto";
import type {Project,PersistedProject} from "../../api/src/index";
import type {RenderFile} from "./shot-reuse";
import {sourceRenderRecord} from "./shot-reuse";
import {contentHash} from "../../generator/src/capabilities";
import {assertSelectedOutput} from "./dialogue-selection";
import {validateDialogueOutput,retainedDialogueTime,assertDialoguePermissions} from "./dialogue-jobs";
import {dialogueSource,dialogueReportAuditions} from "./dialogue-replacement";
import {validateLipSyncOutput,validateLipSyncReviews,assertLipSyncPermission} from "./lipsync";
import {validateSoundOutput,soundBaseDialogue,assertSoundPermission} from "./sound-jobs";
import {configuredAudioPolicies} from "../../generator/src/audio-config";
import {assertRetainedAuditionPermission} from "./retained-auditions";
import {configuredLipSyncPolicy,validateLipSyncPolicy} from "./lipsync-policy";
import {assertGraphicPermission,validateGraphicOutput} from "./graphic-jobs";
import {EDIT_AUDIO_LANES,editFail,editId,editNumber,editRecord,initialEditTimeline,type EditSource,type EditVoiceWindow} from "./edit-timeline";

export type EditAudioInput={kind:"copy48"|"decode";path:string}|{kind:"film-dialogue"};
export interface EditSourceReceipt {schema:"hv-edit-source/1"|"hv-edit-source/2";job:Job;facts:EditSource;language:string;audio:Partial<Record<typeof EDIT_AUDIO_LANES[number],EditAudioInput>>;files:RenderFile[];revision:string}
// Cache only pure metadata validation, never permissions or availability. Digests retain no source objects.
const validReceipts=new Set<string>();
function plainJson(value:unknown,seen=new Set<object>()):boolean{
  if(value===null||typeof value==="string"||typeof value==="boolean")return true;if(typeof value==="number")return Number.isFinite(value)&&!Object.is(value,-0);if(typeof value!=="object"||seen.has(value))return false;
  const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)return false;seen.add(value);
  const keys=Reflect.ownKeys(value);if(array&&(keys.length!==value.length+1||keys.some(k=>k!=="length"&&(typeof k!=="string"||! /^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=value.length))))return false;
  for(const key of keys){if(array&&key==="length")continue;if(typeof key!=="string")return false;const property=Object.getOwnPropertyDescriptor(value,key)!;if(!property.enumerable||!Object.hasOwn(property,"value")||!plainJson(property.value,seen))return false;}seen.delete(value);return true;
}
/** These source receipts never contain another editorial job. Continued edits reuse the original receipts. */
export function editOriginalJob(job:Job):void{
  if(job?.pictureEdit||job?.editCheckpoint||job?.output?.editorial)editFail("Retain the original source receipts instead of nesting an editorial job.");
  if(!job||job.status!=="done"||!(job.output||job.graphicOutput)||!Number.isFinite(Date.parse(job.completedAt??""))||!Number.isFinite(Date.parse(job.linkExpiresAt??""))||Date.parse(job.linkExpiresAt!)<=Date.parse(job.completedAt!))editFail("Choose a completed retained film, dialogue, lip-sync, sound or graphic version.");
  if(job.graphicOutput){validateGraphicOutput(job,job.graphicOutput);return;}
  if(!job.output)editFail("Choose a completed retained picture source.");
  if(job.soundMix)validateSoundOutput(job,job.output);else if(job.dialogueReplacement)validateDialogueOutput(job,job.output,retainedDialogueTime(job));
  else if(job.lipSync){validateLipSyncOutput(job,job.output);validateLipSyncReviews(job.lipSyncReviews!,contentHash(job.output));if(job.lipSyncReviews?.entries.at(-1)?.decision!=="accept")editFail("Accept the lip-sync quality review before editing its picture.");}
  else{if(!["animatic","final"].includes(job.stage)||!job.output.shotRenders?.length)editFail("Choose a film with retained shot provenance.");for(const shot of job.output.shotRenders)sourceRenderRecord(job,shot,Date.parse(job.completedAt!));}
  const original=job.soundMix?.source.base??job,film=original.dialogueReplacement?.source??original.lipSync?.source.film??original;
  if(film.providerPlan?.pool.some(p=>p.snapshot.postProcessing.includes("burn-in-captions")))editFail("This source may contain burned captions. Render a clean picture before editing its caption track.");
}
export function editSourcePicture(job:Job):string{const path=job.graphicOutput?.masterPath??job.output?.mp4Path;if(!path)editFail("Choose a completed retained picture source.");return path;}
export function editSourceOutputRevision(job:Job):string{const output=job.graphicOutput??job.output;if(!output)editFail("Choose a completed retained picture source.");return contentHash(output);}
export function editSourceMedia(job:Job):Pick<EditSource,"media">{return job.graphicOutput?{media:"graphic-rgba"}:{};}
export function editSourceRequiredPaths(job:Job):string[]{return job.graphicOutput?[job.graphicOutput.masterPath,job.graphicOutput.manifestPath]:[job.output!.mp4Path,job.output!.captionsPath,job.output!.manifestPath];}
export function editSourceKnownFiles(job:Job):RenderFile[]{editOriginalJob(job);return structuredClone(job.graphicOutput?.files??job.output!.sound?.files??job.output!.dialogue?.files??job.output!.lipSync?.files??job.output!.shotRenders!.flatMap(r=>Object.values(r.files).filter(Boolean) as RenderFile[]));}
export function editSourceLanguage(job:Job):string{if(job.graphicOutput)return "und";const base=job.soundMix?.source.base??job;return soundBaseDialogue(base)?.plan.dubLanguage??"en";}
export function editSourceVoiceWindows(job:Job):{voices:EditVoiceWindow[];unmeasuredAudio:boolean}{
  if(job.graphicOutput)return {voices:[],unmeasuredAudio:false};
  const base=job.soundMix?.source.base??job,dialogue=soundBaseDialogue(base),voices:EditVoiceWindow[]=[];const add=(id:string,lane:EditVoiceWindow["lane"],start:number,end:number)=>{if(end>start)voices.push({id:editId(id),lane,start:Math.round(start*48000/22050),end:Math.round(end*48000/22050)});};
  if(dialogue){for(const [i,line]of dialogue.lines.entries()){const read=line.audition?.conversion;add("dialogue-"+i,"dialogue",line.startSample+(read?.speechStartSample??0),read?line.startSample+read.speechEndSample:line.endSample);}if(dialogue.narration)for(const [i,cue]of dialogue.narration.track.cues.entries()){const r=dialogue.narration.conversions[i]!.report;add("narration-"+i,"narration",cue.startSample+r.speechStartSample,cue.startSample+r.speechEndSample);}return {voices,unmeasuredAudio:false};}
  const shots=base.output!.shotRenders!;let offset=0;for(const [i,shot]of shots.entries()){for(const [j,line]of (shot.clip.speech?.lines??[]).entries())add("dialogue-"+i+"-"+j,"dialogue",offset+line.startSample,offset+line.endSample);offset+=Math.round(shot.clip.durationSec*30)*735;}
  return {voices,unmeasuredAudio:shots.some(s=>!s.clip.speech&&s.clip.audioMode!=="silent-captioned")};
}
export function editSourceAudio(job:Job):EditSourceReceipt["audio"]{
  if(job.graphicOutput)return {};
  const prefix=job.output!.mp4Path.slice(0,-"export.mp4".length);
  if(job.soundMix){const r=job.output!.sound!.report;return {mix:{kind:"copy48",path:prefix+(r.finishing?"finishing/master.wav":"stems/mix.wav")},...Object.fromEntries(EDIT_AUDIO_LANES.filter(l=>l!=="mix").map(l=>[l,{kind:"copy48",path:prefix+"stems/"+l+".wav"}]))};}
  const dialogue=job.output!.dialogue?.report??job.lipSync?.source.dialogue,wav=job.output!.dialogue?.wavPath??job.output!.lipSync?.wavPath;if(dialogue&&wav){return dialogue.narration?{mix:{kind:"decode",path:prefix+"mix.wav"},dialogue:{kind:"decode",path:prefix+"ducked-dialogue.wav"},narration:{kind:"decode",path:prefix+"narration.wav"}}:{mix:{kind:"decode",path:wav},dialogue:{kind:"decode",path:wav}};}
  let isolated=false;try{isolated=dialogueSource(job,Date.parse(job.completedAt!)).shots.some(s=>Boolean(s.clip.speech));}catch{/* Mixed native audio remains available without claiming an isolated speech lane. */}
  return {mix:{kind:"decode",path:job.output!.mp4Path},...(isolated?{dialogue:{kind:"film-dialogue" as const}}:{})};
}
export function editFactsRevision(job:Job,frames:number,width:number,height:number,captions:EditSource["captions"]):string{return contentHash({outputRevision:editSourceOutputRevision(job),frames,width,height,captions,...editSourceVoiceWindows(job),audio:editSourceAudio(job),language:editSourceLanguage(job),...editSourceMedia(job)});}
export function validateEditSourceReceipt(receipt:EditSourceReceipt):EditSourceReceipt{
  const serialized=JSON.stringify(receipt);if(serialized.length>32*1024**2)editFail("An editorial source receipt exceeds its 32 MiB metadata limit.");const key=plainJson(receipt)?createHash("sha256").update(serialized).digest("hex"):null;if(key&&validReceipts.has(key)){validReceipts.delete(key);validReceipts.add(key);return structuredClone(receipt);}if(contentHash(JSON.parse(serialized))!==contentHash(receipt))editFail("Retain only portable JSON values in an editorial source receipt.");
  editRecord(receipt,["schema","job","facts","language","audio","files","revision"]);const job=receipt.job,facts=receipt.facts;editOriginalJob(job);editId(job.id);editId(job.projectId);initialEditTimeline([facts],facts.id,Math.min(facts.width,1920),Math.min(facts.height,1080));
  if(receipt.schema!==(job.graphicOutput?"hv-edit-source/2":"hv-edit-source/1")||facts.media!==editSourceMedia(job).media||facts.id!==job.id||facts.revision!==editFactsRevision(job,facts.frames,facts.width,facts.height,facts.captions)||receipt.language!==editSourceLanguage(job)||contentHash({voices:facts.voices,unmeasuredAudio:facts.unmeasuredAudio})!==contentHash(editSourceVoiceWindows(job))||contentHash(receipt.audio)!==contentHash(editSourceAudio(job))||contentHash(facts.audio)!==contentHash(EDIT_AUDIO_LANES.filter(l=>receipt.audio[l])))editFail("Editorial source facts differ from their original receipt.");
  if(job.graphicOutput){const plan=job.graphicRender!.spec.plan;if(facts.frames!==plan.frames||facts.width!==plan.width||facts.height!==plan.height)editFail("The graphic source changed its admitted dimensions or duration.");}
  if(!Array.isArray(receipt.files)||receipt.files.length>30000||new Set(receipt.files.map(f=>f.path)).size!==receipt.files.length)editFail("Invalid editorial source inventory.");
  const known=editSourceKnownFiles(job),required=new Set([...known.map(f=>f.path),...editSourceRequiredPaths(job)]);if(receipt.files.length!==required.size||known.some(k=>!receipt.files.some(f=>contentHash(k)===contentHash(f))))editFail("The editorial source lost original media or provenance.");
  for(const f of receipt.files){editRecord(f,["path","bytes","sha256"]);if(!required.has(f.path)||!f.path.startsWith(job.projectId+"/"+job.id+"/")||!/^[A-Za-z0-9._/-]+$/.test(f.path)||f.path.split("/").some(p=>!p||p==="."||p==="..")||!/^[a-f0-9]{64}$/.test(f.sha256))editFail("Editorial source media escaped its owner.");editNumber(f.bytes,1,8*1024**3,"Editorial source file size");}
  for(const audio of Object.values(receipt.audio))if(audio.kind!=="film-dialogue"&&!receipt.files.some(f=>f.path===audio.path))editFail("The editorial source lost a waveform.");const {revision,...data}=receipt;if(contentHash(data)!==revision)editFail("The editorial source receipt changed.");if(key){validReceipts.add(key);if(validReceipts.size>64)validReceipts.delete(validReceipts.values().next().value!);}return structuredClone(receipt);
}
export function assertEditSourcePermission(receipt:EditSourceReceipt,project:Project|PersistedProject|undefined|null,now=Date.now()):void{validateEditSourceReceipt(receipt);if(receipt.job.graphicOutput){assertEditSourceAvailable(receipt,receipt.job,now);assertGraphicPermission(receipt.job.graphicRender!,project,now);return;}assertSelectedOutput(receipt.job,project,{jobId:receipt.job.id,outputRevision:editSourceOutputRevision(receipt.job)},now);}
/** Playback of an owned copy uses current policies; the enclosing media binding owns retention availability. */
export function assertEditOriginalPermission(receipt:EditSourceReceipt,project:Project|PersistedProject|undefined|null,now=Date.now()):void{
  validateEditSourceReceipt(receipt);const job=receipt.job;if(job.graphicOutput){assertGraphicPermission(job.graphicRender!,project,now);return;}if(job.soundMix){assertSoundPermission(job.soundMix,project,now);return;}
  if(job.lipSync){assertLipSyncPermission(job.lipSync,project,now);const policy=configuredLipSyncPolicy();if(!policy||validateLipSyncPolicy(policy,now).permissionRevision!==job.lipSync.policy.permissionRevision)editFail("The retained lip-sync provider permission is unavailable.");return;}
  assertDialoguePermissions(job.dialogueReplacement?.source??job,project,now);const dialogue=job.output!.dialogue?.report;
  if(dialogue){const policies=configuredAudioPolicies();for(const {audition}of dialogueReportAuditions(dialogue))if(audition)assertRetainedAuditionPermission(audition.source,project??undefined,policies.find(p=>p.voiceId===audition.source.take.policy.voiceId),now);}
}
export function assertEditSourceAvailable(receipt:EditSourceReceipt,current:Job|undefined,now=Date.now()):void{validateEditSourceReceipt(receipt);const saved=receipt.job;if(!current||current.id!==saved.id||current.projectId!==saved.projectId||current.status!=="done"||!(current.output||current.graphicOutput)||editSourceOutputRevision(current)!==editSourceOutputRevision(saved)||current.completedAt!==saved.completedAt||current.linkExpiresAt!==saved.linkExpiresAt||Date.parse(saved.linkExpiresAt!)<=now||contentHash(current.lipSyncReviews??null)!==contentHash(saved.lipSyncReviews??null))editFail("A retained editorial source changed or expired. Review the current source again.");if(current.graphicOutput)editOriginalJob(current);}
