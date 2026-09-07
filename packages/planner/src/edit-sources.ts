import type {Job} from "../../queue/src/index";
import type {Project,PersistedProject} from "../../api/src/index";
import type {RenderFile} from "./shot-reuse";
import {sourceRenderRecord} from "./shot-reuse";
import {contentHash} from "../../generator/src/capabilities";
import {assertSelectedOutput} from "./dialogue-selection";
import {validateDialogueOutput,retainedDialogueTime} from "./dialogue-jobs";
import {dialogueSource} from "./dialogue-replacement";
import {validateLipSyncOutput,validateLipSyncReviews} from "./lipsync";
import {validateSoundOutput,soundBaseDialogue} from "./sound-jobs";
import {EDIT_AUDIO_LANES,editFail,editId,editNumber,editRecord,initialEditTimeline,type EditSource,type EditVoiceWindow} from "./edit-timeline";

export type EditAudioInput={kind:"copy48"|"decode";path:string}|{kind:"film-dialogue"};
export interface EditSourceReceipt {schema:"hv-edit-source/1";job:Job;facts:EditSource;language:string;audio:Partial<Record<typeof EDIT_AUDIO_LANES[number],EditAudioInput>>;files:RenderFile[];revision:string}
/** These source receipts never contain another editorial job. Continued edits reuse the original receipts. */
export function editOriginalJob(job:Job):void{
  if(!job||job.status!=="done"||!job.output||!Number.isFinite(Date.parse(job.completedAt??""))||!Number.isFinite(Date.parse(job.linkExpiresAt??""))||Date.parse(job.linkExpiresAt!)<=Date.parse(job.completedAt!))editFail("Choose a completed retained film, dialogue, lip-sync or sound version.");
  if(job.soundMix)validateSoundOutput(job,job.output);else if(job.dialogueReplacement)validateDialogueOutput(job,job.output,retainedDialogueTime(job));
  else if(job.lipSync){validateLipSyncOutput(job,job.output);validateLipSyncReviews(job.lipSyncReviews!,contentHash(job.output));if(job.lipSyncReviews?.entries.at(-1)?.decision!=="accept")editFail("Accept the lip-sync quality review before editing its picture.");}
  else{if(!["animatic","final"].includes(job.stage)||!job.output.shotRenders?.length)editFail("Choose a film with retained shot provenance.");for(const shot of job.output.shotRenders)sourceRenderRecord(job,shot,Date.parse(job.completedAt!));}
  const original=job.soundMix?.source.base??job,film=original.dialogueReplacement?.source??original.lipSync?.source.film??original;
  if(film.providerPlan?.pool.some(p=>p.snapshot.postProcessing.includes("burn-in-captions")))editFail("This source may contain burned captions. Render a clean picture before editing its caption track.");
}
export function editSourceKnownFiles(job:Job):RenderFile[]{editOriginalJob(job);return structuredClone(job.output!.sound?.files??job.output!.dialogue?.files??job.output!.lipSync?.files??job.output!.shotRenders!.flatMap(r=>Object.values(r.files).filter(Boolean) as RenderFile[]));}
export function editSourceLanguage(job:Job):string{const base=job.soundMix?.source.base??job;return soundBaseDialogue(base)?.plan.dubLanguage??"en";}
export function editSourceVoiceWindows(job:Job):{voices:EditVoiceWindow[];unmeasuredAudio:boolean}{
  const base=job.soundMix?.source.base??job,dialogue=soundBaseDialogue(base),voices:EditVoiceWindow[]=[];const add=(id:string,lane:EditVoiceWindow["lane"],start:number,end:number)=>{if(end>start)voices.push({id:editId(id),lane,start:Math.round(start*48000/22050),end:Math.round(end*48000/22050)});};
  if(dialogue){for(const [i,line]of dialogue.lines.entries()){const read=line.audition?.conversion;add("dialogue-"+i,"dialogue",line.startSample+(read?.speechStartSample??0),read?line.startSample+read.speechEndSample:line.endSample);}if(dialogue.narration)for(const [i,cue]of dialogue.narration.track.cues.entries()){const r=dialogue.narration.conversions[i]!.report;add("narration-"+i,"narration",cue.startSample+r.speechStartSample,cue.startSample+r.speechEndSample);}return {voices,unmeasuredAudio:false};}
  const shots=base.output!.shotRenders!;let offset=0;for(const [i,shot]of shots.entries()){for(const [j,line]of (shot.clip.speech?.lines??[]).entries())add("dialogue-"+i+"-"+j,"dialogue",offset+line.startSample,offset+line.endSample);offset+=Math.round(shot.clip.durationSec*30)*735;}
  return {voices,unmeasuredAudio:shots.some(s=>!s.clip.speech&&s.clip.audioMode!=="silent-captioned")};
}
export function editSourceAudio(job:Job):EditSourceReceipt["audio"]{
  const prefix=job.output!.mp4Path.slice(0,-"export.mp4".length);
  if(job.soundMix){const r=job.output!.sound!.report;return {mix:{kind:"copy48",path:prefix+(r.finishing?"finishing/master.wav":"stems/mix.wav")},...Object.fromEntries(EDIT_AUDIO_LANES.filter(l=>l!=="mix").map(l=>[l,{kind:"copy48",path:prefix+"stems/"+l+".wav"}]))};}
  const dialogue=job.output!.dialogue?.report??job.lipSync?.source.dialogue,wav=job.output!.dialogue?.wavPath??job.output!.lipSync?.wavPath;if(dialogue&&wav){return dialogue.narration?{mix:{kind:"decode",path:prefix+"mix.wav"},dialogue:{kind:"decode",path:prefix+"ducked-dialogue.wav"},narration:{kind:"decode",path:prefix+"narration.wav"}}:{mix:{kind:"decode",path:wav},dialogue:{kind:"decode",path:wav}};}
  let isolated=false;try{dialogueSource(job,Date.parse(job.completedAt!));isolated=true;}catch{/* Mixed native audio remains available without claiming an isolated speech lane. */}
  return {mix:{kind:"decode",path:job.output!.mp4Path},...(isolated?{dialogue:{kind:"film-dialogue" as const}}:{})};
}
export function editFactsRevision(job:Job,frames:number,width:number,height:number,captions:EditSource["captions"]):string{return contentHash({outputRevision:contentHash(job.output),frames,width,height,captions,...editSourceVoiceWindows(job),audio:editSourceAudio(job),language:editSourceLanguage(job)});}
export function validateEditSourceReceipt(receipt:EditSourceReceipt):EditSourceReceipt{
  const serialized=JSON.stringify(receipt);if(serialized.length>32*1024**2)editFail("An editorial source receipt exceeds its 32 MiB metadata limit.");if(contentHash(JSON.parse(serialized))!==contentHash(receipt))editFail("Retain only portable JSON values in an editorial source receipt.");
  editRecord(receipt,["schema","job","facts","language","audio","files","revision"]);const job=receipt.job,facts=receipt.facts;editOriginalJob(job);editId(job.id);editId(job.projectId);initialEditTimeline([facts],facts.id,Math.min(facts.width,1920),Math.min(facts.height,1080));
  if(receipt.schema!=="hv-edit-source/1"||facts.id!==job.id||facts.revision!==editFactsRevision(job,facts.frames,facts.width,facts.height,facts.captions)||receipt.language!==editSourceLanguage(job)||contentHash({voices:facts.voices,unmeasuredAudio:facts.unmeasuredAudio})!==contentHash(editSourceVoiceWindows(job))||contentHash(receipt.audio)!==contentHash(editSourceAudio(job))||contentHash(facts.audio)!==contentHash(EDIT_AUDIO_LANES.filter(l=>receipt.audio[l])))editFail("Editorial source facts differ from their original receipt.");
  if(!Array.isArray(receipt.files)||receipt.files.length>30000||new Set(receipt.files.map(f=>f.path)).size!==receipt.files.length)editFail("Invalid editorial source inventory.");
  const known=editSourceKnownFiles(job),required=new Set([...known.map(f=>f.path),job.output!.mp4Path,job.output!.captionsPath,job.output!.manifestPath]);if(receipt.files.length!==required.size||known.some(k=>!receipt.files.some(f=>contentHash(k)===contentHash(f))))editFail("The editorial source lost original media or provenance.");
  for(const f of receipt.files){editRecord(f,["path","bytes","sha256"]);if(!required.has(f.path)||!f.path.startsWith(job.projectId+"/"+job.id+"/")||!/^[A-Za-z0-9._/-]+$/.test(f.path)||f.path.split("/").some(p=>!p||p==="."||p==="..")||!/^[a-f0-9]{64}$/.test(f.sha256))editFail("Editorial source media escaped its owner.");editNumber(f.bytes,1,8*1024**3,"Editorial source file size");}
  for(const audio of Object.values(receipt.audio))if(audio.kind!=="film-dialogue"&&!receipt.files.some(f=>f.path===audio.path))editFail("The editorial source lost a waveform.");const {revision,...data}=receipt;if(contentHash(data)!==revision)editFail("The editorial source receipt changed.");return structuredClone(receipt);
}
export function assertEditSourcePermission(receipt:EditSourceReceipt,project:Project|PersistedProject|undefined|null,now=Date.now()):void{validateEditSourceReceipt(receipt);assertSelectedOutput(receipt.job,project,{jobId:receipt.job.id,outputRevision:contentHash(receipt.job.output)},now);}
export function assertEditSourceAvailable(receipt:EditSourceReceipt,current:Job|undefined,now=Date.now()):void{validateEditSourceReceipt(receipt);const saved=receipt.job;if(!current||current.id!==saved.id||current.projectId!==saved.projectId||current.status!=="done"||!current.output||contentHash(current.output)!==contentHash(saved.output)||current.completedAt!==saved.completedAt||current.linkExpiresAt!==saved.linkExpiresAt||Date.parse(saved.linkExpiresAt!)<=now||contentHash(current.lipSyncReviews??null)!==contentHash(saved.lipSyncReviews??null))editFail("A retained editorial source changed or expired. Review the current source again.");}
