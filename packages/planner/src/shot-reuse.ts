import {compilePerformances,validateSpeechReport} from "./performances";
import {filmPlan,inSequence} from "./sequences";
import {bibleShots} from "./style-bible";
import {contentHash} from "../../generator/src/capabilities";
import {validateProviderPlan} from "../../generator/src/catalog";
import type {VideoClip} from "../../generator/src/index";
import {parseFountain} from "../../parser/src/index";
import {TIERS,type Job} from "../../queue/src/index";
import {castingSnapshot,directCast} from "./casting";
import {poolReferenceBudget} from "./reference-budget";
import {directionSnapshot,directShots,directionSettings} from "./direction";
import {type Shot} from "./index";
import {validatePicturePerformance,assertPicturePerformance} from "./picture-performance";
import {validateShotExecutionOutput} from "./shot-execution-inventory";
import {HistoricalValidationCache} from "./historical-validation-cache";

/** Bump when rendering semantics change beyond the admitted provider capability snapshot. */
export const SHOT_RENDER_ENGINE=1;
export interface RenderFile {path:string;sha256:string;bytes:number}
export type RenderClip=Omit<VideoClip,"path"|"audioPath"|"posterPath"|"sourcePosterPath"|"cost"|"renderRecord">;
export interface ShotRenderRecord {
  schema:"hv-shot-render/1";revision:string;projectId:string;jobId:string;shotId:string;inputHash:string;
  clip:RenderClip;files:{video:RenderFile;audio?:RenderFile;poster?:RenderFile;sourcePoster?:RenderFile};
  origin:{jobId:string;shotId:string};reusedFrom?:{jobId:string;shotId:string;revision:string};
}
export interface ShotReusePlan {schema:"hv-shot-reuse/1";revision:string;projectId:string;shots:ShotRenderRecord[];forceShotIds:string[]}
type RenderJob=Pick<Job,"projectId"|"stage"|"tier"|"scriptText"|"casting"|"direction"|"providerPlan"|"sequence"|"styleBible">;
const hash=(value:unknown)=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const id=(value:unknown)=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
export class ShotReuseError extends Error {override name="ShotReuseError";}
/** The fields `renderShots` plans from, and the time it plans at. A field the job doesn't carry is left out. */
type ShotPlanInput=Pick<RenderJob,"projectId"|"stage"|"tier"|"scriptText"|"casting"|"direction"|"sequence"|"styleBible">&{now:number};
function planShots(job:ShotPlanInput):Shot[] {
  const now=job.now;
  const parsed=parseFountain(job.scriptText);if(parsed.rejected||!parsed.scenes.length)throw new ShotReuseError("Reuse requires a valid screenplay.");
  // HV-030-29: a sequence render's shots are its own scenes' shots of the feature's plan; any other film's, its own plan, as before.
  // HV-034-02: a feature's sequence render reads its style bible into every shot's prompt.
  return bibleShots(inSequence(directShots(directCast(filmPlan(parsed,job.direction,TIERS[job.tier].maxShots,job.sequence),parsed,job.casting??castingSnapshot(job.projectId,0,[],0),now,job.direction,poolReferenceBudget(job.providerPlan.pool)),job.direction??directionSnapshot(job.projectId,0,[],0)),job.sequence),parsed,job.styleBible);
}
/**
 * HV-030-32: a film's shots, planned once for the same inputs. Planning a feature's sequence plans the
 * whole feature and runs the safety gate over every shot's prompt, about 0.2 s for 202 shots, and a
 * retained film was planned again for each of its shots and each check that read it: 170 times for one
 * score quote on staging. Planning is a pure function of the fields `ShotPlanInput` names and the time
 * given, so the memo is keyed on exactly those, serialized whole (a field that can't be serialized
 * exactly is planned afresh). A plan that fails is never kept, so every refusal runs every time, and
 * each caller gets its own copy.
 */
const shotPlanMemo=new HistoricalValidationCache(planShots,{entries:32,bytes:64*1024**2,entryBytes:8*1024**2},{digest:true});
export function renderShots(job:RenderJob,now=Date.now()):Shot[] {
  if(!["animatic","final"].includes(job.stage)||!job.providerPlan)throw new ShotReuseError("Reuse requires a film render with an admitted provider plan.");
  const input:Record<string,unknown>={projectId:job.projectId,stage:job.stage,tier:job.tier,scriptText:job.scriptText,now};
  for(const key of ["casting","direction","sequence","styleBible"] as const)if(job[key]!==undefined)input[key]=job[key];
  return shotPlanMemo.get(input as ShotPlanInput);
}
export function renderInputHash(job:RenderJob,shot:Shot):string {
  if(!job.providerPlan||!["animatic","final"].includes(job.stage))throw new ShotReuseError("A pinned film provider plan is required.");
  validateProviderPlan(job.providerPlan);
  return shotInputHash(job,shot,parseFountain(job.scriptText));
}
/** `renderInputHash` once its provider plan is validated, with its screenplay already parsed. */
function shotInputHash(job:RenderJob,shot:Shot,parsed:ReturnType<typeof parseFountain>):string {
  // Global script/cast/direction revisions are deliberately absent. Their actual per-shot inputs remain bound.
  return contentHash({schema:"hv-shot-input/1",engine:SHOT_RENDER_ENGINE,projectId:job.projectId,stage:job.stage,tier:job.tier,providerPlanRevision:job.providerPlan!.revision,
    sceneHeading:parsed.scenes[shot.sceneIndex]?.heading??"",shot:{id:shot.id,sceneIndex:shot.sceneIndex,prompt:shot.prompt,sourcePrompt:shot.sourcePrompt??shot.prompt,dialogue:shot.dialogue,...(shot.performances?{performances:shot.performances}:{}),
      ...(shot.picturePerformance?{picturePerformance:shot.picturePerformance}:{}),durationSec:shot.durationSec,seed:shot.seed,characterIds:shot.characterIds??[],referenceAssets:shot.referenceAssets??[],direction:directionSettings(shot.direction??{})}});
}
export function renderRecord(data:Omit<ShotRenderRecord,"schema"|"revision">):ShotRenderRecord {
  return {schema:"hv-shot-render/1",...data,revision:contentHash(data)};
}
export function validateRenderRecord(record:ShotRenderRecord,job:Pick<Job,"projectId"|"id">):ShotRenderRecord {
  if(!record||record.schema!=="hv-shot-render/1"||record.projectId!==job.projectId||record.jobId!==job.id||!id(record.jobId)||!id(record.projectId)||!id(record.shotId)||!hash(record.inputHash)||!hash(record.revision)
    ||!record.clip||!record.files?.video||!id(record.origin?.jobId)||!id(record.origin?.shotId))throw new ShotReuseError("Invalid saved shot render.");
  const keys=Object.keys(record).filter(k=>k!=="reusedFrom").sort().join(",");if(keys!=="clip,files,inputHash,jobId,origin,projectId,revision,schema,shotId"||record.origin.shotId!==record.shotId||(!record.reusedFrom&&record.origin.jobId!==record.jobId))throw new ShotReuseError("Invalid saved shot origin.");
  if(record.reusedFrom&&(!id(record.reusedFrom.jobId)||!id(record.reusedFrom.shotId)||!hash(record.reusedFrom.revision)))throw new ShotReuseError("Invalid reused shot origin.");
  const c=record.clip;if(typeof c.provider!=="string"||typeof c.model!=="string"||!Number.isSafeInteger(c.seed)||c.seed<0||!Number.isFinite(c.durationSec)||c.durationSec<=0||c.durationSec>600||!hash(c.fingerprint)
    ||["path","audioPath","posterPath","sourcePosterPath","cost","renderRecord"].some(k=>Object.hasOwn(c,k)))throw new ShotReuseError("Invalid saved clip metadata.");
  if(c.picturePerformance)validatePicturePerformance(c.picturePerformance);
  if(c.speech){validateSpeechReport(c.speech);if(!record.files.audio||record.files.audio.bytes!==44+c.speech.totalSamples*2||c.audioMode!=="provided"||c.speech.totalSamples/c.speech.sampleRate>c.durationSec)throw new ShotReuseError("Recorded speech is missing its audio or exceeds the shot.");}
  if(record.files.audio&&!c.speech)throw new ShotReuseError("Recorded audio is missing its line provenance.");
  if(Object.keys(record.files).some(k=>!["video","audio","poster","sourcePoster"].includes(k)))throw new ShotReuseError("Invalid saved shot files.");
  for(const file of Object.values(record.files))if(!file||!hash(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>8*1024**3||typeof file.path!=="string"||file.path.length>1024
    ||!file.path.startsWith(job.projectId+"/"+job.id+"/clips/")||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(v=>!v||v==="."||v===".."))throw new ShotReuseError("Invalid saved shot media reference.");
  const {schema:_schema,revision,...data}=record;if(contentHash(data)!==revision)throw new ShotReuseError("The saved shot render changed.");return structuredClone(record);
}
export function validateReusePlan(plan:ShotReusePlan,job:RenderJob,now=Date.now()):ShotReusePlan {
  if(!plan||Object.keys(plan).sort().join(",")!=="forceShotIds,projectId,revision,schema,shots"||plan.schema!=="hv-shot-reuse/1"||plan.projectId!==job.projectId||!Array.isArray(plan.shots)||plan.shots.length>60||!Array.isArray(plan.forceShotIds)||plan.forceShotIds.length>60
    ||new Set(plan.shots.map(r=>r.shotId)).size!==plan.shots.length||new Set(plan.forceShotIds).size!==plan.forceShotIds.length)throw new ShotReuseError("Invalid selective render plan.");
  const shots=renderShots(job,now);for(const id of plan.forceShotIds)if(!shots.some(s=>s.id===id))throw new ShotReuseError("Choose existing shots to render fresh.");
  for(const record of plan.shots){validateRenderRecord(record,{projectId:job.projectId,id:record.jobId});const shot=shots.find(s=>s.id===record.shotId);if(!shot||record.inputHash!==renderInputHash(job,shot)||plan.forceShotIds.includes(record.shotId))throw new ShotReuseError("The selected reusable shot no longer matches its render inputs.");}
  const {schema:_schema,revision,...data}=plan;if(contentHash(data)!==revision)throw new ShotReuseError("The selective render plan changed.");return structuredClone(plan);
}
export function assertRenderedOrigin(record:ShotRenderRecord,job:Pick<Job,"shotReuse">):void {
  const selected=job.shotReuse?.shots.find(r=>r.shotId===record.shotId);
  if(!selected){if(record.reusedFrom)throw new ShotReuseError("The shot was not admitted for reuse.");return;}
  const fileHashes=(value:ShotRenderRecord)=>Object.fromEntries(Object.entries(value.files).map(([key,f])=>[key,{sha256:f.sha256,bytes:f.bytes}]));
  if(record.reusedFrom?.revision!==selected.revision||record.reusedFrom.jobId!==selected.jobId||record.reusedFrom.shotId!==selected.shotId||contentHash(record.origin)!==contentHash(selected.origin)
    ||contentHash(record.clip)!==contentHash(selected.clip)||contentHash(fileHashes(record))!==contentHash(fileHashes(selected)))throw new ShotReuseError("The reused render differs from its admitted source.");
}
export function sourceRenderRecord(source:Job,record:ShotRenderRecord,now=Date.now()):ShotRenderRecord {
  return sourceRenderRecords(source,[record],now)[0]!;
}
/**
 * HV-030-32: `sourceRenderRecord` for several records of one source film. Each record gets every check
 * `sourceRenderRecord` makes, in the same order. What depends only on the film -- its execution
 * evidence, its planned shots, its parsed screenplay and its provider plan -- is checked once for all of
 * them, where it used to be checked again for each record. The answer is the same: those checks read
 * nothing from the record, and they either hold for the film or throw.
 */
export function sourceRenderRecords(source:Job,records:ShotRenderRecord[],now=Date.now()):ShotRenderRecord[] {
  verifiedRecords.get({source,records,now});return records;
}
/**
 * HV-030-32: one score request read the same retained film 17 times (its plan, its permission, its
 * source, its admission), and each read verified every shot record again. The verification reads
 * only the film, the records and the time, so a pass is remembered under the SHA-256 of exactly
 * those, serialized whole. A failure is never remembered, and a film or record that differs in any
 * byte, or a different time, is verified afresh.
 */
const verifiedRecords=new HistoricalValidationCache((input:{source:Job;records:ShotRenderRecord[];now:number})=>{checkSourceRenderRecords(input.source,input.records,input.now);return true;},
  {entries:256,bytes:1024**2,entryBytes:64*1024**2},{digest:true});
function checkSourceRenderRecords(source:Job,records:ShotRenderRecord[],now:number):void {
  if(source.currentFilm||source.currentFilmCheckpoint||source.output?.currentFilm)throw new ShotReuseError("Current-film reuse requires its explicit source and target slot bindings.");
  if(source.output)validateShotExecutionOutput(source,source.output);
  let film:{planned:Shot[];parsed:ReturnType<typeof parseFountain>}|undefined,planChecked=false;
  for(const record of records){
    if(source.status!=="done"||!source.linkExpiresAt||Date.parse(source.linkExpiresAt)<=now||source.projectId!==record.projectId||source.id!==record.jobId
      ||!source.output?.shotRenders?.some(r=>r.revision===record.revision&&contentHash(r)===contentHash(record)))throw new ShotReuseError("A selected source render is unavailable. Turn off reuse to generate fresh shots.");
    validateRenderRecord(record,source);
    assertRenderedOrigin(record,source);
    const renderedAt=Date.parse(source.startedAt??source.completedAt??source.rightsAttestedAt??"");if(!Number.isFinite(renderedAt))throw new ShotReuseError("The source render has no verified creation time.");
    film??={planned:renderShots(source,renderedAt),parsed:parseFountain(source.scriptText)};
    const shot=film.planned.find(s=>s.id===record.shotId);
    if(shot)assertSpeechInput(record,shot);
    if(!shot)throw new ShotReuseError("The source render does not match its recorded inputs.");
    if(!source.providerPlan||!["animatic","final"].includes(source.stage))throw new ShotReuseError("A pinned film provider plan is required.");
    if(!planChecked){validateProviderPlan(source.providerPlan);planChecked=true;}
    if(shotInputHash(source,shot,film.parsed)!==record.inputHash)throw new ShotReuseError("The source render does not match its recorded inputs.");
  }
}
export function createReusePlan(job:RenderJob,sources:Job[],forceShotIds:unknown=[],now=Date.now()):ShotReusePlan {
  if(!Array.isArray(forceShotIds)||forceShotIds.some(v=>typeof v!=="string"))throw new ShotReuseError("Choose existing shots to render fresh.");
  const shots=renderShots(job,now),records:ShotRenderRecord[]=[];
  for(const shot of shots){if(forceShotIds.includes(shot.id))continue;const inputHash=renderInputHash(job,shot);
    for(const source of sources){if(source.projectId!==job.projectId||source.stage!==job.stage||source.status!=="done")continue;const record=source.output?.shotRenders?.find(r=>r.shotId===shot.id&&r.inputHash===inputHash);if(!record)continue;
      try{records.push(sourceRenderRecord(source,record,now));break;}catch{/* Ineligible historical results are omitted; no media is read. */}
    }
  }
  const data={projectId:job.projectId,shots:records,forceShotIds:forceShotIds as string[]};return validateReusePlan({schema:"hv-shot-reuse/1",...data,revision:contentHash(data)},job,now);
}

export function assertSpeechInput(record:ShotRenderRecord,shot:Shot):void {
  assertPicturePerformance(record.clip.picturePerformance,shot.picturePerformance);
  const report=record.clip.speech;if(!report){if(shot.performances?.length)throw new ShotReuseError("Directed dialogue is missing its speech receipt.");return;}
  const expected=compilePerformances(shot.dialogue,shot.performances),actual=report.lines.map(({source,voice,beforeMs,afterMs,notes})=>({source,voice,beforeMs,afterMs,notes}));
  if(contentHash(expected)!==contentHash(actual))throw new ShotReuseError("The recorded speech differs from its admitted line performances.");
}
