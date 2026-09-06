import {contentHash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";
import {sourceRenderRecord,renderShots,type ShotRenderRecord,type RenderFile} from "./shot-reuse";
import {voiceProfile,spokenText,PerformanceError,type VoiceProfile,type LineSource} from "./performances";
import {gateOrThrow} from "../../safety/src/index";

export class DialogueReplacementError extends PerformanceError {override name="DialogueReplacementError";}
function fail(message:string):never{throw new DialogueReplacementError(message);}
export interface DialogueReplacement {
  shotId:string;index:number;sourceHash:string;text:string;voice:VoiceProfile;notes:string;
}
export interface DialogueReplacementPlan {
  schema:"hv-dialogue-replacement/1";revision:string;projectId:string;sourceJobId:string;
  sourceRevision:string;sourceFiles:{video:RenderFile;manifest:RenderFile};engineVersion:string;timing:"keep-line-starts";edits:DialogueReplacement[];
}
export interface ReplacedDialogueLine {
  shotId:string;source:LineSource;text:string;spokenText:string;voice:VoiceProfile;notes:string;
  startSample:number;endSample:number;windowEndSample:number;pcmSha256:string;engineVersion:string;replaced:boolean;
}
export interface DialogueReplacementReport {
  schema:"hv-dialogue-replacement-result/1";plan:DialogueReplacementPlan;sampleRate:22050;totalSamples:number;
  sourceVideoSha256:string;videoStreamSha256:string;totalFrames:number;lines:ReplacedDialogueLine[];
  videoSha256:string;audioSha256:string;
}

/** A picture cut is immutable; dialogue edits are a separate, explicitly reviewed branch. */
export function dialogueSource(job:Job,now=Date.now()):{revision:string;shots:ShotRenderRecord[];totalFrames:number} {
  const shots=job.output?.shotRenders;
  if(!["animatic","final"].includes(job.stage)||job.status!=="done"||!job.providerPlan||!shots?.length||shots.length>60
    ||!job.linkExpiresAt||Date.parse(job.linkExpiresAt)<=now)fail("Choose a completed, unexpired film with retained shot media.");
  if(job.providerPlan.pool.some(entry=>entry.snapshot.postProcessing.includes("burn-in-captions")))fail("This picture contains burned-in captions. Render a clean picture before replacing dialogue.");
  const expected=renderShots(job,Date.parse(job.startedAt??job.completedAt??""));
  if(expected.length!==shots.length||expected.some((shot,index)=>shot.id!==shots[index]!.shotId))fail("The retained shots do not cover the complete source cut.");
  let totalFrames=0,spoken=0;
  for(const shot of shots){
    sourceRenderRecord(job,shot,now);
    const frames=Math.round(shot.clip.durationSec*30);
    if(Math.abs(frames/30-shot.clip.durationSec)>1e-6)fail("The retained cut must use exact 30 fps shot boundaries.");
    if(!shot.clip.speech&&shot.clip.audioMode!=="silent-captioned")fail("This cut contains audio without an isolated dialogue receipt. Retain separate sound stems before replacing dialogue.");
    totalFrames+=frames;spoken+=shot.clip.speech?.lines.length??0;
  }
  if(!spoken)fail("The cut needs retained measured dialogue before line replacement.");
  const revision=contentHash({projectId:job.projectId,jobId:job.id,stage:job.stage,scriptVersion:job.scriptVersion,scriptText:job.scriptText,
    providerPlan:job.providerPlan,casting:job.casting??null,direction:job.direction??null,output:job.output});
  return {revision,shots,totalFrames};
}
export function createDialogueReplacement(job:Job,input:unknown,expectedSourceRevision:string,engineVersion:string,sourceFiles:DialogueReplacementPlan["sourceFiles"],now=Date.now()):DialogueReplacementPlan {
  const source=dialogueSource(job,now);
  if(source.revision!==expectedSourceRevision)fail("The source cut changed. Review its lines again before replacing dialogue.");
  if(!/^espeak-[a-f0-9]{64}$/.test(engineVersion))fail("Install a stable temporary speech runtime before replacing dialogue.");
  if(!sourceFiles||Object.keys(sourceFiles).sort().join(",")!=="manifest,video")fail("Pin the source picture and provenance before replacing dialogue.");
  for(const [kind,file]of Object.entries(sourceFiles))if(!file||Object.keys(file).sort().join(",")!=="bytes,path,sha256"||!/^[a-f0-9]{64}$/.test(file.sha256)
    ||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>8*1024**3||file.path!==(kind==="video"?job.output!.mp4Path:job.output!.manifestPath)
    ||!file.path.startsWith(job.projectId+"/"+job.id+"/")||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(p=>!p||p==="."||p===".."))fail("Invalid pinned source media.");
  if(!Array.isArray(input)||!input.length||input.length>128)fail("Choose between one and 128 lines to replace.");
  const edits:DialogueReplacement[]=input.map(value=>{
    if(!value||typeof value!=="object"||Object.keys(value).some(k=>!["shotId","index","sourceHash","text","voice","notes"].includes(k)))fail("Use supported dialogue replacement fields.");
    const line=source.shots.find(s=>s.shotId===value.shotId)?.clip.speech?.lines[value.index];
    if(!Number.isInteger(value.index)||value.index<0||!line||line.source.hash!==value.sourceHash)fail("A selected line changed or disappeared. Review its source before replacing it.");
    const controls=(s:string)=>[...s].some(c=>c.charCodeAt(0)<32&&![9,10,13].includes(c.charCodeAt(0)));
    if(typeof value.text!=="string"||!value.text.trim()||value.text.length>20000||controls(value.text))fail("Use replacement text of one to 20000 characters.");
    if(value.notes!==undefined&&(typeof value.notes!=="string"||value.notes.length>600||controls(value.notes)))fail("Use acting notes of at most 600 characters.");
    const text=value.text.trim(),voice=voiceProfile(value.voice??line.voice),notes=(value.notes??line.notes).trim();
    gateOrThrow(text+"\n"+notes);spokenText({...line,source:{...line.source,text},voice});
    return {shotId:value.shotId,index:value.index,sourceHash:value.sourceHash,text,voice,notes};
  }).sort((a,b)=>source.shots.findIndex(s=>s.shotId===a.shotId)-source.shots.findIndex(s=>s.shotId===b.shotId)||a.index-b.index);
  if(new Set(edits.map(e=>e.shotId+":"+e.index)).size!==edits.length)fail("Replace each selected line only once.");
  const data={projectId:job.projectId,sourceJobId:job.id,sourceRevision:source.revision,sourceFiles:structuredClone(sourceFiles),engineVersion,timing:"keep-line-starts" as const,edits};
  return {schema:"hv-dialogue-replacement/1",...data,revision:contentHash(data)};
}
export function validateDialogueReplacement(job:Job,plan:DialogueReplacementPlan,now=Date.now()):DialogueReplacementPlan {
  if(!plan||contentHash(createDialogueReplacement(job,plan.edits,plan.sourceRevision,plan.engineVersion,plan.sourceFiles,now))!==contentHash(plan))fail("The admitted dialogue replacement plan changed.");
  return structuredClone(plan);
}

/** Restores validate timing and effective input semantics as well as the file checksums. */
export function validateDialogueReplacementReport(source:Job,report:DialogueReplacementReport,now=Date.now()):DialogueReplacementReport {
  if(!report||Object.keys(report).sort().join(",")!=="audioSha256,lines,plan,sampleRate,schema,sourceVideoSha256,totalFrames,totalSamples,videoSha256,videoStreamSha256"
    ||report.schema!=="hv-dialogue-replacement-result/1"||report.sampleRate!==22050||!Array.isArray(report.lines))fail("Invalid dialogue replacement report.");
  const plan=validateDialogueReplacement(source,report.plan,now),locked=dialogueSource(source,now);
  if(report.totalFrames!==locked.totalFrames||report.totalSamples!==locked.totalFrames*735||report.sourceVideoSha256!==plan.sourceFiles.video.sha256
    ||[report.videoSha256,report.audioSha256,report.videoStreamSha256].some(h=>typeof h!=="string"||!/^[a-f0-9]{64}$/.test(h)))fail("The dialogue export differs from its locked cut.");
  let offset=0,index=0;
  for(const shot of locked.shots){
    const samples=Math.round(shot.clip.durationSec*30)*735;
    for(const [i,line]of (shot.clip.speech?.lines??[]).entries()){
      const actual=report.lines[index++],edit=plan.edits.find(e=>e.shotId===shot.shotId&&e.index===i),windowEnd=offset+(shot.clip.speech!.lines[i+1]?.startSample??samples);
      const expected={shotId:shot.shotId,source:line.source,text:edit?.text??line.source.text,voice:edit?.voice??line.voice,notes:edit?.notes??line.notes,
        startSample:offset+line.startSample,windowEndSample:windowEnd,engineVersion:edit?plan.engineVersion:shot.clip.speech!.engineVersion,replaced:Boolean(edit)};
      if(!actual||Object.keys(actual).sort().join(",")!=="endSample,engineVersion,notes,pcmSha256,replaced,shotId,source,spokenText,startSample,text,voice,windowEndSample")fail("A dialogue result line is missing or invalid.");
      const {endSample,pcmSha256,spokenText:spoken,...rest}=actual;
      if(contentHash(rest)!==contentHash(expected)||!Number.isInteger(endSample)||endSample<=actual.startSample||endSample>windowEnd||!/^[a-f0-9]{64}$/.test(pcmSha256)
        ||(!edit&&(endSample!==offset+line.endSample||pcmSha256!==line.pcmSha256))||spoken!==spokenText({...line,source:{...line.source,text:expected.text},voice:expected.voice}))fail("A recorded replacement changed its timing, source or delivery.");
    }
    offset+=samples;
  }
  if(index!==report.lines.length)fail("Unexpected lines in the dialogue replacement report.");return structuredClone(report);
}
