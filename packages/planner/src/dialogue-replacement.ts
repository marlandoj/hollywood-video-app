import {contentHash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";
import {sourceRenderRecord,renderShots,type ShotRenderRecord,type RenderFile} from "./shot-reuse";
import {voiceProfile,spokenText,PerformanceError,type VoiceProfile,type LineSource} from "./performances";
import {gateOrThrow} from "../../safety/src/index";
import {assertAuditionMatchesFilm,validateRetainedAudition,type RetainedAudition} from "./retained-auditions";
import {validateAudioTimeline,assertAudioTimelineWindow,type AudioTimelineReport} from "./audio-timeline";
import {audioLanguage,type AudioLanguage} from "../../generator/src/audio-languages";
import {validateNarrationTrack,validateNarrationMix,narrationAuditionLines,type NarrationTrack,type NarrationMixReport} from "./narration-mix";
import {exportCredentialsProblem,type ProvenanceCredentials} from "./provenance";

export class DialogueReplacementError extends PerformanceError {override name="DialogueReplacementError";}
function fail(message:string):never{throw new DialogueReplacementError(message);}
export interface DialogueReplacement {
  shotId:string;index:number;sourceHash:string;text:string;voice:VoiceProfile|null;notes:string;audition?:RetainedAudition;
}
export interface DialogueReplacementPlan {
  schema:"hv-dialogue-replacement/1"|"hv-dialogue-replacement/2"|"hv-dialogue-replacement/3"|"hv-dialogue-replacement/4"|"hv-dialogue-replacement/5";revision:string;projectId:string;sourceJobId:string;
  dubLanguage?:AudioLanguage;
  narration?:NarrationTrack;
  sourceRevision:string;sourceFiles:{video:RenderFile;manifest:RenderFile};engineVersion:string;timing:"keep-line-starts";edits:DialogueReplacement[];
  baseline?:DialogueBaseline;
  conversionEngineVersion?:string;
}
export interface ReplacedDialogueLine {
  shotId:string;source:LineSource;text:string;spokenText:string;voice:VoiceProfile|null;notes:string;
  startSample:number;endSample:number;windowEndSample:number;pcmSha256:string;engineVersion:string;replaced:boolean;
  audition?:{source:RetainedAudition;conversion:AudioTimelineReport};
}
export interface DialogueReplacementReport {
  schema:"hv-dialogue-replacement-result/1"|"hv-dialogue-replacement-result/2"|"hv-dialogue-replacement-result/3";plan:DialogueReplacementPlan;sampleRate:22050;totalSamples:number;
  narration?:NarrationMixReport;
  sourceVideoSha256:string;videoStreamSha256:string;totalFrames:number;lines:ReplacedDialogueLine[];
  videoSha256:string;audioSha256:string;
  /** HV-031-17: the export's content-credential block, absent only on records made before it. */
  credentials?:ProvenanceCredentials;
}
/** Flat receipt for the selected parent track: never embeds another plan or Job. */
export interface DialogueBaseline {
  schema:"hv-dialogue-baseline/1"|"hv-dialogue-baseline/2"|"hv-dialogue-baseline/3";revision:string;projectId:string;jobId:string;sourceJobId:string;sourceRevision:string;
  narration?:NarrationMixReport;
  completedAt:string;linkExpiresAt:string;planRevision:string;outputRevision:string;videoStreamSha256:string;
  files:{video:RenderFile;manifest:RenderFile;audio:RenderFile};lines:ReplacedDialogueLine[];
  auditionFiles?:RenderFile[];
}
/** Independent copies of original audition evidence are retained with each derived version. */
export function dialogueAuditionAssets(lines:{audition?:{source:RetainedAudition}}[]):{name:string;file:RenderFile;source:RetainedAudition}[]{
  const unique=new Map<string,RetainedAudition>();for(const line of lines){if(!line.audition)continue;const source=validateRetainedAudition(line.audition.source),old=unique.get(source.jobId);
    if(old&&old.revision!==source.revision)fail("Conflicting evidence for the same retained audition.");unique.set(source.jobId,source);}
  return [...unique.values()].sort((a,b)=>a.jobId.localeCompare(b.jobId)).flatMap(source=>["wav","json"].map(extension=>({name:"auditions/"+source.jobId+"."+extension,
    file:source.output.files.find(f=>f.path===(extension==="wav"?source.output.wavPath:source.output.manifestPath))!,source})));
}
export function dialogueReportAuditions(report:{lines:ReplacedDialogueLine[];narration?:NarrationMixReport}):{audition?:{source:RetainedAudition}}[]{return [...report.lines,...narrationAuditionLines(report.narration?.track)];}
function validateAuditionLine(source:Job,line:ReplacedDialogueLine):void{
  if(!line.audition||Object.keys(line.audition).sort().join(",")!=="conversion,source")fail("Invalid applied audition evidence.");
  const {source:take,conversion}=line.audition;assertAuditionMatchesFilm(take,source,line.shotId,line.source.index);validateAudioTimeline(conversion);
  if(contentHash(conversion.source)!==contentHash(take.output.report)||conversion.sourceWavSha256!==take.output.files.find(f=>f.path===take.output.wavPath)!.sha256
    ||line.voice!==null||line.text!==auditionText(take)||line.spokenText!==take.take.line.spokenText||line.notes!==take.take.line.notes||line.engineVersion!==conversion.engineVersion
    ||line.endSample-line.startSample!==conversion.totalSamples||line.pcmSha256!==conversion.pcmSha256)fail("The applied read differs from its retained audition or conversion.");
}
export function auditionText(take:RetainedAudition):string{return take.take.line.localization?.text??take.take.line.source.text;}
/** A complete dub requires a reviewed localized take for every audible source line. */
export function dialogueLanguage(lines:ReplacedDialogueLine[]):AudioLanguage|"mul"{
  if(!lines.some(l=>l.audition?.source.take.line.localization))return "en";
  const languages=lines.map(l=>l.audition?.source.take.line.localization?.language??null);
  return languages[0]&&languages.every(l=>l===languages[0])?languages[0]:"mul";
}
const digest=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
export function dialoguePictureTime(source:Job,baseline?:DialogueBaseline,now=Date.now()):number{return baseline?Date.parse(source.completedAt??""):now;}
export function validateDialogueBaseline(source:Job,baseline:DialogueBaseline,now=Date.now()):void{
  if(!baseline||Object.keys(baseline).sort().join(",")!==(baseline.schema!=="hv-dialogue-baseline/1"?"auditionFiles,":"")+"completedAt,files,jobId,lines,linkExpiresAt,"+(baseline.schema==="hv-dialogue-baseline/3"?"narration,":"")+"outputRevision,planRevision,projectId,revision,schema,sourceJobId,sourceRevision,videoStreamSha256"
    ||!["hv-dialogue-baseline/1","hv-dialogue-baseline/2","hv-dialogue-baseline/3"].includes(baseline.schema)||baseline.projectId!==source.projectId||baseline.sourceJobId!==source.id||baseline.jobId===source.id||!/^[A-Za-z0-9_-]{1,128}$/.test(baseline.jobId)
    ||![baseline.revision,baseline.sourceRevision,baseline.planRevision,baseline.outputRevision,baseline.videoStreamSha256].every(digest)
    ||!Number.isFinite(Date.parse(baseline.completedAt))||!Number.isFinite(Date.parse(baseline.linkExpiresAt))||Date.parse(baseline.linkExpiresAt)<=now||Date.parse(baseline.linkExpiresAt)<=Date.parse(baseline.completedAt)
    ||!baseline.files||Object.keys(baseline.files).sort().join(",")!=="audio,manifest,video"||!Array.isArray(baseline.lines))fail("Invalid retained dialogue baseline.");
  const {revision,...data}=baseline;if(revision!==contentHash(data))fail("The selected dialogue baseline changed.");
  const picture=dialogueSource(source,Date.parse(source.completedAt??""));if(picture.revision!==baseline.sourceRevision)fail("The baseline belongs to a different picture cut.");
  for(const [kind,file]of Object.entries(baseline.files))if(!file||Object.keys(file).sort().join(",")!=="bytes,path,sha256"||!digest(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>8*1024**3
    ||!file.path.startsWith(source.projectId+"/"+baseline.jobId+"/")||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(p=>!p||p==="."||p==="..")
    ||!file.path.endsWith(kind==="video"?"/export.mp4":kind==="audio"?"/dialogue.wav":"/provenance.json"))fail("Invalid owned baseline media.");
  if(baseline.files.audio.bytes!==44+picture.totalFrames*735*2)fail("The baseline WAV changed duration.");
  let index=0,offset=0;for(const shot of picture.shots){const samples=Math.round(shot.clip.durationSec*30)*735;
    for(const [i,line]of (shot.clip.speech?.lines??[]).entries()){
      const actual=baseline.lines[index++],windowEnd=offset+(shot.clip.speech!.lines[i+1]?.startSample??samples);
      if(!actual||Object.keys(actual).sort().join(",")!==(actual.audition?"audition,":"")+"endSample,engineVersion,notes,pcmSha256,replaced,shotId,source,spokenText,startSample,text,voice,windowEndSample"
        ||actual.shotId!==shot.shotId||contentHash(actual.source)!==contentHash(line.source)||actual.startSample!==offset+line.startSample||actual.windowEndSample!==windowEnd
        ||!Number.isInteger(actual.endSample)||actual.endSample<=actual.startSample||actual.endSample>windowEnd||!digest(actual.pcmSha256)||(!actual.audition&&!/^espeak-[a-f0-9]{64}$/.test(actual.engineVersion))||typeof actual.replaced!=="boolean"
        ||typeof actual.text!=="string"||!actual.text.trim()||actual.text.length>20000||typeof actual.notes!=="string"||actual.notes.length>600
        ||(!actual.audition&&(contentHash(voiceProfile(actual.voice))!==contentHash(actual.voice)||actual.spokenText!==spokenText({...line,source:{...line.source,text:actual.text},voice:actual.voice!}))))fail("A baseline read changed its source, timing or delivery.");
      if(actual.audition){if(baseline.schema==="hv-dialogue-baseline/1")fail("Retained auditions require the current baseline schema.");validateAuditionLine(source,actual);}
      gateOrThrow(actual.text+"\n"+actual.notes);
    }offset+=samples;
  }if(index!==baseline.lines.length)fail("Unexpected baseline dialogue lines.");
  if(baseline.schema!=="hv-dialogue-baseline/1"){
    const assets=dialogueAuditionAssets(dialogueReportAuditions(baseline)),directory=baseline.files.video.path.slice(0,-"export.mp4".length);
    if(!Array.isArray(baseline.auditionFiles)||contentHash(baseline.auditionFiles)!==contentHash(assets.map(a=>({...a.file,path:directory+a.name}))))fail("The baseline lost its independently owned audition evidence.");
  }
  if(baseline.schema==="hv-dialogue-baseline/3"){
    const narration=baseline.narration;if(!narration)fail("The baseline narration is missing.");
    validateNarrationMix(source,narration,narration.track,picture.totalFrames*735,baseline.files.audio.sha256,narration.conversions[0]?.report.engineVersion??"");
    const language=dialogueLanguage(baseline.lines);if(baseline.lines.length&&language!==narration.track.language)fail("The baseline narration changed its dialogue language.");
  }
}

/** A picture cut is immutable; dialogue edits are a separate, explicitly reviewed branch. */
export function dialogueSource(job:Job,now=Date.now()):{revision:string;shots:ShotRenderRecord[];totalFrames:number} {
  const shots=job.output?.shotRenders;
  if(!Number.isFinite(now)||!Number.isFinite(Date.parse(job.rightsAttestedAt??""))||!Number.isFinite(Date.parse(job.startedAt??job.completedAt??""))||!Number.isFinite(Date.parse(job.linkExpiresAt??"")))fail("The source cut is missing its rights or creation and retention dates.");
  if(!["animatic","final"].includes(job.stage)||job.status!=="done"||!job.providerPlan||!shots?.length||shots.length>60
    ||!job.linkExpiresAt||Date.parse(job.linkExpiresAt)<=now)fail("Choose a completed, unexpired film with retained shot media.");
  if(job.providerPlan.pool.some(entry=>entry.snapshot.postProcessing.includes("burn-in-captions")))fail("This picture contains burned-in captions. Render a clean picture before replacing dialogue.");
  const expected=renderShots(job,Date.parse(job.startedAt??job.completedAt??""));
  if(expected.length!==shots.length||expected.some((shot,index)=>shot.id!==shots[index]!.shotId))fail("The retained shots do not cover the complete source cut.");
  let totalFrames=0;
  for(const shot of shots){
    sourceRenderRecord(job,shot,now);
    const frames=Math.round(shot.clip.durationSec*30);
    if(Math.abs(frames/30-shot.clip.durationSec)>1e-6)fail("The retained cut must use exact 30 fps shot boundaries.");
    if(!shot.clip.speech&&shot.clip.audioMode!=="silent-captioned")fail("This cut contains audio without an isolated dialogue receipt. Retain separate sound stems before replacing dialogue.");
    totalFrames+=frames;
  }
  const revision=contentHash({projectId:job.projectId,jobId:job.id,stage:job.stage,scriptVersion:job.scriptVersion,scriptText:job.scriptText,
    providerPlan:job.providerPlan,casting:job.casting??null,direction:job.direction??null,output:job.output});
  return {revision,shots,totalFrames};
}
export function createDialogueReplacement(job:Job,input:unknown,expectedSourceRevision:string,engineVersion:string,sourceFiles:DialogueReplacementPlan["sourceFiles"],now=Date.now(),baseline?:DialogueBaseline,conversionEngineVersion?:string,dubLanguage?:AudioLanguage,narration?:NarrationTrack):DialogueReplacementPlan {
  if(baseline)validateDialogueBaseline(job,baseline,now);
  const source=dialogueSource(job,dialoguePictureTime(job,baseline,now));
  if(source.revision!==expectedSourceRevision)fail("The source cut changed. Review its lines again before replacing dialogue.");
  if(!/^espeak-[a-f0-9]{64}$/.test(engineVersion)&&engineVersion!=="retained-audio")fail("Install a stable temporary speech runtime before replacing dialogue.");
  if(!sourceFiles||Object.keys(sourceFiles).sort().join(",")!=="manifest,video")fail("Pin the source picture and provenance before replacing dialogue.");
  for(const [kind,file]of Object.entries(sourceFiles))if(!file||Object.keys(file).sort().join(",")!=="bytes,path,sha256"||!/^[a-f0-9]{64}$/.test(file.sha256)
    ||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>8*1024**3||file.path!==(baseline?baseline.files[kind as "video"|"manifest"].path:kind==="video"?job.output!.mp4Path:job.output!.manifestPath)
    ||!file.path.startsWith(job.projectId+"/"+(baseline?.jobId??job.id)+"/")||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(p=>!p||p==="."||p===".."))fail("Invalid pinned source media.");
  if(baseline&&(contentHash(sourceFiles.video)!==contentHash(baseline.files.video)||contentHash(sourceFiles.manifest)!==contentHash(baseline.files.manifest)))fail("The pinned baseline files changed.");
  narration=narration??baseline?.narration?.track;
  if(narration)validateNarrationTrack(job,narration,source.totalFrames*735,dubLanguage??"en");
  if(!Array.isArray(input)||!input.length&&!narration||input.length>128)fail("Choose up to 128 replacement lines or a reviewed narration track.");
  const edits:DialogueReplacement[]=input.map(value=>{
    if(!value||typeof value!=="object"||Object.keys(value).some(k=>!["shotId","index","sourceHash","text","voice","notes","audition"].includes(k)))fail("Use supported dialogue replacement fields.");
    const line=source.shots.find(s=>s.shotId===value.shotId)?.clip.speech?.lines[value.index];
    if(!Number.isInteger(value.index)||value.index<0||!line||line.source.hash!==value.sourceHash)fail("A selected line changed or disappeared. Review its source before replacing it.");
    if(value.audition!==undefined){
      const audition=validateRetainedAudition(value.audition);assertAuditionMatchesFilm(audition,job,value.shotId,value.index);
      const shot=source.shots.find(s=>s.shotId===value.shotId)!,windowEnd=shot.clip.speech!.lines[value.index+1]?.startSample??Math.round(shot.clip.durationSec*30)*735;
      assertAudioTimelineWindow(audition.output.report,windowEnd-line.startSample);
      if((value.text!==undefined&&value.text!==auditionText(audition))||(value.voice!==undefined&&value.voice!==null)||(value.notes!==undefined&&value.notes!==audition.take.line.notes))fail("A retained audition keeps its recorded text, voice and direction. Generate a new take to change them.");
      return {shotId:value.shotId,index:value.index,sourceHash:value.sourceHash,text:auditionText(audition),voice:null,notes:audition.take.line.notes,audition};
    }
    const controls=(s:string)=>[...s].some(c=>c.charCodeAt(0)<32&&![9,10,13].includes(c.charCodeAt(0)));
    if(typeof value.text!=="string"||!value.text.trim()||value.text.length>20000||controls(value.text))fail("Use replacement text of one to 20000 characters.");
    if(value.notes!==undefined&&(typeof value.notes!=="string"||value.notes.length>600||controls(value.notes)))fail("Use acting notes of at most 600 characters.");
    const inherited=baseline?.lines.find(l=>l.shotId===value.shotId&&l.source.index===value.index);
    const text=value.text.trim(),voice=voiceProfile(value.voice??inherited?.voice??line.voice),notes=(value.notes??inherited?.notes??line.notes).trim();
    gateOrThrow(text+"\n"+notes);spokenText({...line,source:{...line.source,text},voice});
    return {shotId:value.shotId,index:value.index,sourceHash:value.sourceHash,text,voice,notes};
  }).sort((a,b)=>source.shots.findIndex(s=>s.shotId===a.shotId)-source.shots.findIndex(s=>s.shotId===b.shotId)||a.index-b.index);
  if(new Set(edits.map(e=>e.shotId+":"+e.index)).size!==edits.length)fail("Replace each selected line only once.");
  const retained=edits.some(e=>e.audition)||Boolean(narration?.cues.length),temporary=edits.some(e=>!e.audition);
  const effective=source.shots.flatMap(shot=>(shot.clip.speech?.lines??[]).map((_,index)=>{const edit=edits.find(e=>e.shotId===shot.shotId&&e.index===index);return edit?edit.audition:baseline?.lines.find(l=>l.shotId===shot.shotId&&l.source.index===index)?.audition?.source;}));
  if(dubLanguage!==undefined){audioLanguage(dubLanguage);if(effective.some(t=>t?.take.line.localization?.language!==dubLanguage))fail("A dubbed track needs a reviewed take in the selected language for every line. Complete the missing lines before rendering.");}
  else if(effective.some(t=>t?.take.line.localization))fail("Review the complete target-language track before applying translated takes.");
  if(temporary&&!/^espeak-[a-f0-9]{64}$/.test(engineVersion)||!temporary&&engineVersion!=="retained-audio")fail("Use the declared runtime for the selected dialogue delivery.");
  if(retained?!/^ffmpeg-audio-[a-f0-9]{64}$/.test(conversionEngineVersion??""):conversionEngineVersion!==undefined)fail("Pin the conversion runtime only when applying a retained audition.");
  const data={projectId:job.projectId,sourceJobId:job.id,sourceRevision:source.revision,sourceFiles:structuredClone(sourceFiles),engineVersion,timing:"keep-line-starts" as const,edits,...(baseline?{baseline:structuredClone(baseline)}:{}),...(retained?{conversionEngineVersion}:{}),...(dubLanguage?{dubLanguage}:{}),...(narration?{narration:structuredClone(narration)}:{})};
  return {schema:narration?"hv-dialogue-replacement/5":dubLanguage?"hv-dialogue-replacement/4":retained||baseline?.schema==="hv-dialogue-baseline/2"?"hv-dialogue-replacement/3":baseline?"hv-dialogue-replacement/2":"hv-dialogue-replacement/1",...data,revision:contentHash(data)};
}
export function validateDialogueReplacement(job:Job,plan:DialogueReplacementPlan,now=Date.now()):DialogueReplacementPlan {
  if(!plan||contentHash(createDialogueReplacement(job,plan.edits,plan.sourceRevision,plan.engineVersion,plan.sourceFiles,now,plan.baseline,plan.conversionEngineVersion,plan.dubLanguage,plan.narration))!==contentHash(plan))fail("The admitted dialogue replacement plan changed.");
  return structuredClone(plan);
}

/** Restores validate timing and effective input semantics as well as the file checksums. */
export function validateDialogueReplacementReport(source:Job,report:DialogueReplacementReport,now=Date.now()):DialogueReplacementReport {
  if(!report||Object.keys(report).sort().join(",")!=="audioSha256,"+(Object.hasOwn(report,"credentials")?"credentials,":"")+"lines,"+(report.plan?.narration?"narration,":"")+"plan,sampleRate,schema,sourceVideoSha256,totalFrames,totalSamples,videoSha256,videoStreamSha256"
    ||report.schema!==(report.plan?.narration?"hv-dialogue-replacement-result/3":["hv-dialogue-replacement/3","hv-dialogue-replacement/4"].includes(report.plan?.schema)?"hv-dialogue-replacement-result/2":"hv-dialogue-replacement-result/1")||report.sampleRate!==22050||!Array.isArray(report.lines))fail("Invalid dialogue replacement report.");
  const plan=validateDialogueReplacement(source,report.plan,now),locked=dialogueSource(source,dialoguePictureTime(source,plan.baseline,now));
  if(report.totalFrames!==locked.totalFrames||report.totalSamples!==locked.totalFrames*735||report.sourceVideoSha256!==plan.sourceFiles.video.sha256
    ||[report.videoSha256,report.audioSha256,report.videoStreamSha256].some(h=>typeof h!=="string"||!/^[a-f0-9]{64}$/.test(h))||(plan.baseline&&report.videoStreamSha256!==plan.baseline.videoStreamSha256))fail("The dialogue export differs from its locked cut.");
  let offset=0,index=0;
  for(const shot of locked.shots){
    const samples=Math.round(shot.clip.durationSec*30)*735;
    for(const [i,line]of (shot.clip.speech?.lines??[]).entries()){
      const actual=report.lines[index++],edit=plan.edits.find(e=>e.shotId===shot.shotId&&e.index===i),windowEnd=offset+(shot.clip.speech!.lines[i+1]?.startSample??samples);
      const inherited=plan.baseline?.lines.find(l=>l.shotId===shot.shotId&&l.source.index===i);
      const expected={shotId:shot.shotId,source:line.source,text:edit?.text??inherited?.text??line.source.text,voice:edit?edit.voice:inherited?inherited.voice:line.voice,notes:edit?.notes??inherited?.notes??line.notes,
        startSample:offset+line.startSample,windowEndSample:windowEnd,engineVersion:edit?(edit.audition?plan.conversionEngineVersion!:plan.engineVersion):inherited?.engineVersion??shot.clip.speech!.engineVersion,replaced:Boolean(edit)};
      const retained=edit?edit.audition:inherited?.audition?.source;
      if(!actual||Object.keys(actual).sort().join(",")!==(retained?"audition,":"")+"endSample,engineVersion,notes,pcmSha256,replaced,shotId,source,spokenText,startSample,text,voice,windowEndSample")fail("A dialogue result line is missing or invalid.");
      const {endSample,pcmSha256,spokenText:spoken,audition,...rest}=actual;
      if(contentHash(rest)!==contentHash(expected)||!Number.isInteger(endSample)||endSample<=actual.startSample||endSample>windowEnd||!/^[a-f0-9]{64}$/.test(pcmSha256)
        ||(!edit&&(endSample!==(inherited?.endSample??offset+line.endSample)||pcmSha256!==(inherited?.pcmSha256??line.pcmSha256)))||spoken!==(retained?retained.take.line.spokenText:spokenText({...line,source:{...line.source,text:expected.text},voice:expected.voice!})))fail("A recorded replacement changed its timing, source or delivery.");
      if(retained){validateAuditionLine(source,actual);if(contentHash(audition!.source)!==contentHash(retained)||(!edit&&contentHash(audition)!==contentHash(inherited!.audition)))fail("Inherited audition evidence changed.");}
    }
    offset+=samples;
  }
  if(index!==report.lines.length)fail("Unexpected lines in the dialogue replacement report.");
  if(plan.narration)validateNarrationMix(source,report.narration!,plan.narration,report.totalSamples,report.audioSha256,plan.conversionEngineVersion??"");
  // HV-031-17: the record's credentials name this export; whether its sidecar is held is the output's to say.
  if(Object.hasOwn(report,"credentials")){const problem=exportCredentialsProblem(report.credentials,report.videoSha256);if(problem)fail(problem);}
  return structuredClone(report);
}
