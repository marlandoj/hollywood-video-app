import type {Job,JobInput} from "../../queue/src/index";
import type {Project,PersistedProject} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {renderShots,type RenderFile} from "./shot-reuse";
import type {Shot} from "./index";
import {assertCurrentCastPermission,castingSnapshot,currentCasting} from "./casting";
import {assertFrameAnchorCatalog} from "./frame-anchors";
import {parseFountain} from "../../parser/src/index";
import {configuredAudioPolicies} from "../../generator/src/audio-config";
import {assertRetainedAuditionPermission,assertRetainedAuditionAvailable,type RetainedAudition} from "./retained-auditions";
import {dialogueSource,dialoguePictureTime,dialogueAuditionAssets,dialogueReportAuditions,validateDialogueBaseline,validateDialogueReplacement,validateDialogueReplacementReport,DialogueReplacementError,type DialogueBaseline,type DialogueReplacementPlan,type DialogueReplacementReport} from "./dialogue-replacement";
import {narrationConvertedName} from "./narration-mix";
import {exportSidecarProblem} from "./provenance";

export interface DialogueJobPlan {source:Job;plan:DialogueReplacementPlan;requestHash:string;storage:"local"|"s3"}
export interface DialogueOutput {revision:string;report:DialogueReplacementReport;wavPath:string;files:RenderFile[]}
function fail(message:string):never{throw new DialogueReplacementError(message);}
export function dialogueAuditionInputs(plan:DialogueReplacementPlan):RetainedAudition[]{
  const unique=new Map<string,RetainedAudition>();for(const edit of [...plan.edits,...(plan.narration?.cues.filter(c=>!plan.baseline?.narration?.track.cues.some(b=>b.audition.revision===c.audition.revision))??[])])if(edit.audition){const old=unique.get(edit.audition.jobId);if(old&&old.revision!==edit.audition.revision)fail("Conflicting retained audition input.");unique.set(edit.audition.jobId,edit.audition);}return [...unique.values()];
}
/** Execute inside the caller's project/job transaction or worker permission callback. */
export async function assertDialogueAuditionInputs(job:Job|JobInput,project:Pick<Project|PersistedProject,"id"|"deleteAfter"|"rightsAttestedAt"|"castingHistory">|undefined,getJob:(id:string)=>Promise<Job|undefined>,now=Date.now()):Promise<void>{
  const inputs=job.dialogueReplacement?dialogueAuditionInputs(job.dialogueReplacement.plan):[];if(!inputs.length)return;const policies=configuredAudioPolicies();
  for(const receipt of inputs){assertRetainedAuditionPermission(receipt,project,policies.find(p=>p.voiceId===receipt.take.policy.voiceId),now);assertRetainedAuditionAvailable(receipt,await getJob(receipt.jobId),now);}
}
const digest=(value:unknown)=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
/** Archive validation checks retained metadata, not whether a new worker may use the source today. */
export function retainedDialogueTime(job:Job):number{return Date.parse(job.dialogueReplacement?.plan.baseline?.completedAt??job.dialogueReplacement?.source.completedAt??"");}
export function dialogueSourceJobId(job:Job|JobInput):string{return job.dialogueReplacement!.plan.baseline?.jobId??job.dialogueReplacement!.source.id;}
export function dialogueBaseline(job:Job,now=Date.now()):DialogueBaseline{
  if(job.stage!=="dialogue-replacement"||job.status!=="done"||!job.output?.dialogue||!job.completedAt||!job.linkExpiresAt||Date.parse(job.linkExpiresAt)<=now)fail("Choose a completed, retained dialogue version.");
  validateDialogueOutput(job,job.output,retainedDialogueTime(job));const source=job.dialogueReplacement!.source,output=job.output.dialogue;
  const file=(path:string)=>structuredClone(output.files.find(f=>f.path===path)!);
  const data={projectId:job.projectId,jobId:job.id,sourceJobId:source.id,sourceRevision:job.dialogueReplacement!.plan.sourceRevision,completedAt:job.completedAt,linkExpiresAt:job.linkExpiresAt,
    planRevision:job.dialogueReplacement!.plan.revision,outputRevision:output.revision,videoStreamSha256:output.report.videoStreamSha256,
    files:{video:file(job.output.mp4Path),manifest:file(job.output.manifestPath),audio:file(output.wavPath)},lines:structuredClone(output.report.lines),
    ...(output.report.schema!=="hv-dialogue-replacement-result/1"?{auditionFiles:dialogueAuditionAssets(dialogueReportAuditions(output.report)).map(a=>file(job.output!.mp4Path.slice(0,-"export.mp4".length)+a.name))}:{}),...(output.report.narration?{narration:structuredClone(output.report.narration)}:{})};
  const schema=output.report.narration?"hv-dialogue-baseline/3":output.report.schema==="hv-dialogue-replacement-result/2"?"hv-dialogue-baseline/2":"hv-dialogue-baseline/1";
  const baseline:DialogueBaseline={schema,...data,revision:contentHash({schema,...data})};validateDialogueBaseline(source,baseline,now);return baseline;
}
export function assertDialogueIdempotency(existing:Job|undefined,input:JobInput):void{
  if(existing&&(existing.dialogueReplacement||input.dialogueReplacement||existing.stage==="dialogue-replacement"||input.stage==="dialogue-replacement")
    &&(existing.stage!==input.stage||existing.dialogueReplacement?.plan.revision!==input.dialogueReplacement?.plan.revision||existing.dialogueReplacement?.requestHash!==input.dialogueReplacement?.requestHash))fail("The idempotency key belongs to a different dialogue replacement. Use a new key for a new version.");
}
export function validateDialogueJob(job:Pick<Job,"id"|"projectId"|"stage"|"dialogueReplacement"|"providerPlan"|"providerSpec"|"shotReuse"|"shotTakes"|"characterSheet"|"casting"|"direction"|"scriptVersion"|"scriptText"|"costCapUsd"|"budgetReservedUsd"|"totalFrames"|"animaticJobId"|"animaticApprovedAt"|"rightsAttestedAt">,now=Date.now()):void{
  if((job.stage==="dialogue-replacement")!==Boolean(job.dialogueReplacement))fail("A dialogue job needs its own admitted replacement plan.");
  if(!job.dialogueReplacement)return;
  const {source,plan,requestHash}=job.dialogueReplacement;
  if(Object.keys(job.dialogueReplacement).sort().join(",")!=="plan,requestHash,source,storage"||!["local","s3"].includes(job.dialogueReplacement.storage)||!digest(requestHash)||!source||source.dialogueReplacement||source.dialogueCheckpoint||source.id===job.id||source.projectId!==job.projectId
    ||job.providerPlan||job.providerSpec||job.shotReuse||job.shotTakes||job.characterSheet||job.casting||job.direction||job.animaticJobId||job.animaticApprovedAt
    ||plan.baseline?.jobId===job.id||job.costCapUsd!==0||job.budgetReservedUsd!==0||!job.rightsAttestedAt||job.scriptVersion!==source.scriptVersion||job.scriptText!==source.scriptText)fail("Invalid isolated dialogue job context.");
  validateDialogueReplacement(source,plan,now);
  if(job.totalFrames!==dialogueSource(source,dialoguePictureTime(source,plan.baseline,now)).totalFrames)fail("The dialogue job changed its locked picture duration.");
}
export function assertDialogueAccess(source:Job,project:Pick<Project|PersistedProject,"id"|"deleteAfter"|"rightsAttestedAt"|"castingHistory"|"referenceAssets">|null|undefined,now=Date.now(),baseline?:DialogueBaseline):void{
  if(baseline)validateDialogueBaseline(source,baseline,now);dialogueSource(source,dialoguePictureTime(source,baseline,now));
  assertDialoguePermissions(source,project,now);
  if(baseline){const policies=configuredAudioPolicies();for(const asset of dialogueAuditionAssets(dialogueReportAuditions(baseline)).filter(a=>a.name.endsWith(".wav")))assertRetainedAuditionPermission(asset.source,project??undefined,policies.find(p=>p.voiceId===asset.source.take.policy.voiceId),now);}
}
export type CastPermissionProject=Pick<Project|PersistedProject,"id"|"deleteAfter"|"rightsAttestedAt"|"castingHistory"|"referenceAssets">|null|undefined;
/**
 * Current cast permission over shots the caller derived.
 *
 * The permission half of `assertDialoguePermissions`, separated because how a
 * job's shots are derived differs -- `renderShots` for a film, `shotTakeShots`
 * for a take group, the sheet's own views for a character sheet -- while what
 * permission means does not. Every caller that serves a character's likeness
 * asks this same question; before HV-029-03 the artifact route asked it only
 * of jobs carrying particular optional fields.
 */
export function assertShotCastPermission(shots:Shot[],source:Job,project:CastPermissionProject,now=Date.now()):void{
  if(!project||project.id!==source.projectId||!project.rightsAttestedAt||!Number.isFinite(Date.parse(project.deleteAfter))||Date.parse(project.deleteAfter)<=now)fail("Current project permission is unavailable.");
  const parsed=parseFountain(source.scriptText),saved=source.casting??castingSnapshot(source.projectId,0,[],0),current=currentCasting(project.id,project.castingHistory);
  for(const shot of shots){
    assertCurrentCastPermission(saved,current,shot.characterIds??[],shot.sceneIndex+1,now,parsed.scenes[shot.sceneIndex]?.heading);
    assertFrameAnchorCatalog(shot.direction?.frameAnchors,project.id,project.referenceAssets??[]);
  }
}
/** Playback permission does not require that a film also be eligible for ADR. */
export function assertDialoguePermissions(source:Job,project:CastPermissionProject,now=Date.now()):void{
  // A job that admits no provider plan has no derivable shot plan -- `renderShots`
  // refuses it outright -- and a job that carries no casting snapshot binds no
  // character, so the loop `renderShots` exists to feed would run over an empty
  // cast and decide nothing. Deriving shots there buys no permission and
  // refuses for a reason that is not about permission, which matters now that
  // this runs on the media path: HV-029-03's first draft made such a job's
  // artifacts unservable. The project-level precondition below still applies.
  const shots=source.providerPlan||source.casting?renderShots(source,Date.parse(source.startedAt??source.completedAt??"")):[];
  assertShotCastPermission(shots,source,project,now);
}
export function assertDialogueSourceAvailable(job:Job|JobInput,current:Job|undefined,now=Date.now()):void{
  validateDialogueJob(job,now);const saved=job.dialogueReplacement!;
  if(!current||current.id!==dialogueSourceJobId(job)||current.projectId!==job.projectId)fail("The selected picture cut changed or is no longer available.");
  if(saved.plan.baseline){if(contentHash(dialogueBaseline(current,now))!==contentHash(saved.plan.baseline))fail("The selected baseline dialogue version changed.");}
  else if(dialogueSource(current,now).revision!==saved.plan.sourceRevision)fail("The selected picture cut changed or is no longer available.");
}
/** Self-contained output metadata remains verifiable after the source job is retained out. */
export function validateDialogueOutput(job:Job|JobInput,output:NonNullable<Job["output"]>,now=Date.now()):void{
  validateDialogueJob(job,now);const selected=job.dialogueReplacement;
  if(!selected||!output||Object.keys(output).sort().join(",")!==(Object.hasOwn(output,"c2paPath")?"c2paPath,":"")+"captionsPath,dialogue,hlsPlaylistPath,manifestPath,mp4Path"||!output.dialogue)fail("A dialogue job is missing its independent output.");
  const result=output.dialogue;
  if(Object.keys(result).sort().join(",")!=="files,report,revision,wavPath"||!digest(result.revision)||!Array.isArray(result.files)||result.files.length<7||result.files.length>20000)fail("Invalid dialogue media receipt.");
  validateDialogueReplacementReport(selected.source,result.report,now);
  if(contentHash(result.report.plan)!==contentHash(selected.plan))fail("The saved dialogue output differs from its admitted plan.");
  const directory=output.mp4Path.slice(0,output.mp4Path.lastIndexOf("/")+1),prefix=job.projectId+"/"+job.id+"/";
  if(!directory.startsWith(prefix)||!/^[A-Za-z0-9._/-]+$/.test(directory)||directory.split("/").slice(0,-1).some(p=>!p||p==="."||p==="..")||output.mp4Path!==directory+"export.mp4"
    ||output.manifestPath!==directory+"provenance.json"||output.captionsPath!==directory+"captions.vtt"||result.wavPath!==directory+"dialogue.wav"||output.hlsPlaylistPath!==directory+"hls/index.m3u8")fail("Dialogue output is outside its own job.");
  const auditionFiles=dialogueAuditionAssets(dialogueReportAuditions(result.report)).map(a=>({...a.file,path:directory+a.name}));
  const mix=result.report.narration,narrationFiles=mix?["mix.wav","narration.wav","ducked-dialogue.wav",...mix.track.cues.map(c=>narrationConvertedName(c.id))].map(name=>directory+name):[];
  // HV-031-17: the record's credentials name this export, and its sidecar when the export is signed.
  const credentialProblem=exportSidecarProblem(output,result.report.credentials,result.report.videoSha256,result.files);if(credentialProblem)fail(credentialProblem);
  const required=[output.mp4Path,output.manifestPath,...(output.c2paPath!==undefined?[output.c2paPath]:[]),output.captionsPath,result.wavPath,output.hlsPlaylistPath,directory+"captions.srt",...auditionFiles.map(f=>f.path),...narrationFiles];
  if(auditionFiles.some(file=>contentHash(result.files.find(f=>f.path===file.path))!==contentHash(file)))fail("The dialogue version lost its original audition evidence.");
  if(new Set(result.files.map(f=>f.path)).size!==result.files.length||required.some(path=>!result.files.some(f=>f.path===path)))fail("The dialogue output is missing required media.");
  for(const file of result.files)if(!file||Object.keys(file).sort().join(",")!=="bytes,path,sha256"||!digest(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>8*1024**3
    ||(!required.includes(file.path)&&(!file.path.startsWith(directory)||!/^hls\/segment-\d{3,5}\.ts$/.test(file.path.slice(directory.length)))))fail("Invalid owned dialogue artifact.");
  if(result.files.find(f=>f.path===output.mp4Path)!.sha256!==result.report.videoSha256||result.files.find(f=>f.path===result.wavPath)!.sha256!==result.report.audioSha256
    ||result.files.find(f=>f.path===result.wavPath)!.bytes!==44+result.report.totalSamples*2)fail("Dialogue media differs from its performance receipt.");
  if(mix){for(const [name,sha256]of [["mix.wav",mix.mixWavSha256],["narration.wav",mix.narrationWavSha256],["ducked-dialogue.wav",mix.duckedWavSha256]]){
    const file=result.files.find(f=>f.path===directory+name)!;if(file.sha256!==sha256||file.bytes!==44+result.report.totalSamples*2)fail("The narration mix lost a retained stem.");}
    for(const conversion of mix.conversions)if(result.files.find(f=>f.path===directory+narrationConvertedName(conversion.cueId))!.bytes!==44+conversion.report.totalSamples*2)fail("A converted narration read changed length.");
  }
  const {revision,...data}=result;if(revision!==contentHash(data))fail("The dialogue media receipt changed.");
}
