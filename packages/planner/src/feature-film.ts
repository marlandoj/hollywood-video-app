import type {Job} from "../../queue/src/index";
import type {ParseResult} from "../../parser/src/index";
import type {RenderFile} from "./shot-reuse";
import {contentHash} from "../../generator/src/capabilities";
import {castingMatches,type CastingSnapshot} from "./casting";
import {directionMatches,type DirectionSnapshot} from "./direction";
import {sameSequence,sequenceRef,stalePlanReason,type SequencePlan} from "./sequences";
import {exportSidecarProblem,type ProvenanceCredentials} from "./provenance";

/**
 * A feature's film: its sequences joined into one (HV-030-30, Release 3 step 7, G20-202610031349).
 *
 * HV-030-29 made the sequence the render unit: each sequence of a feature has its own rough cut and
 * final, finished like a short's (voiced, scored) but with no title or credits. The Editor joins the
 * finished sequence films in order into one film, with one opening title over the start and one end
 * credits after the last frame, as a `feature-film` job: the assembler's own concat with a dissolve at
 * each join and its ffprobe gate, signed like every other export, with one review link bound to it.
 *
 * The join streams the films through ffmpeg rather than conforming them frame by frame as a picture
 * edit does: a picture edit keeps lossless masters and estimates its workspace at three times two raw
 * RGB copies of every frame, which caps it near 4.5 minutes at 1280x720, and a feature is 15 to 20.
 *
 * Admission checks what the request names: one finished film per sequence, each this project's and
 * made from that sequence's current final (the newest final of the current split, screenplay, cast
 * and direction, whose rough cut is still approved), and the Editor's title and credits graphics. The
 * plan records each sequence's final and film, and the export's `provenance.json` carries it.
 */
export const FEATURE_FILM_SCHEMA = "hv-feature-film/1" as const;
export const FEATURE_FILM_OUTPUT_SCHEMA = "hv-feature-film-output/1" as const;
export const FEATURE_FILM_RESULT_SPEC = "hv-feature-film-result/1";
/** Each join dissolves over 12 frames (0.4 s): picture by xfade, sound by acrossfade, as the assembler joins shots. */
export const FEATURE_FILM_CROSSFADE_FRAMES = 12;
/** One film per sequence, and a plan holds at most this many (`SEQUENCE_LIMIT`). */
export const FEATURE_FILM_SEQUENCE_LIMIT = 100;

export interface FeatureFilmSequence {number:number;firstScene:number;lastScene:number;finalJobId:string;filmJobId:string}
/** A sequence's finished film as it was admitted: the job (its own copy), and the revision of its output. */
export interface FeatureFilmSource {number:number;job:Job;outputRevision:string}
/** The Editor's opening title or end credits, as rendered by the graphics path (HV-025-03). */
export interface FeatureFilmGraphic {jobId:string;outputRevision:string;masterPath:string;frames:number;width:number;height:number}
export interface FeatureFilmPlan {
  schema:typeof FEATURE_FILM_SCHEMA;planRevision:string;scriptVersion:number;sequences:FeatureFilmSequence[];films:FeatureFilmSource[];
  title:FeatureFilmGraphic|null;credits:FeatureFilmGraphic|null;width:number;height:number;crossfadeFrames:number;storage:"local"|"s3";requestHash:string;revision:string;
}
export interface FeatureFilmOutput {schema:typeof FEATURE_FILM_OUTPUT_SCHEMA;planRevision:string;sha256:string;durationSec:number;credentials:ProvenanceCredentials;files:RenderFile[];revision:string}

/** A refused join: the API answers 409, as it answers a stale render. */
export class FeatureFilmConflict extends Error {override name="FeatureFilmConflict";}
const refuse=(message:string):never=>{throw new FeatureFilmConflict(message);};
const invalid=(message="The feature's film plan is not one the studio made."):never=>{throw new Error(message);};

const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value)
  &&Object.keys(value as object).sort().join(",")===[...keys].sort().join(",");
const id=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const hex=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=1;
const owned=(path:unknown,projectId:string,jobId:string):path is string=>typeof path==="string"&&path.length<=1024&&path.startsWith(projectId+"/"+jobId+"/")
  &&/^[A-Za-z0-9._/-]+$/.test(path)&&!path.split("/").some(part=>!part||part==="."||part==="..");

/**
 * The render a finished film was made from: the film itself when it is a final, or the final under a
 * dialogue replacement, a lip-sync version or a sound mix (each keeps a copy of its source job). Null
 * when the film isn't made from a film render's final.
 */
export function finalOf(job:Job):Job|null{
  let current:Job|undefined=job;
  for(let depth=0;current&&depth<8;depth++){
    if(current.stage==="final")return current.shotTakes||current.currentFilm||current.livingScript||current.characterSheet?null:current;
    current=current.soundMix?.source.base??current.dialogueReplacement?.source??current.lipSync?.source.film;
  }
  return null;
}

/** What admission reads of the project: its split, its current screenplay, cast and direction, and its rough-cut decisions. */
export interface FeatureFilmProject {
  id:string;format?:string;sequences?:SequencePlan;scriptVersion:number;parsed:ParseResult;casting:CastingSnapshot;direction:DirectionSnapshot;
  /** As `animaticApproval` reads them: the first entry for a rough cut is its decision. */
  approvals:{animaticJobId:string;decision:string}[];
}
/** What a join request names: one finished film per sequence, and the Editor's title and credits (or null). */
export interface FeatureFilmClaim {sequences:{number:number;jobId:string}[];title:string|null;credits:string|null}

export function featureFilmClaim(value:unknown):FeatureFilmClaim{
  if(!exact(value,["sequences","title","credits"])||!Array.isArray(value.sequences)||!value.sequences.length||value.sequences.length>FEATURE_FILM_SEQUENCE_LIMIT
    ||value.sequences.some(entry=>!exact(entry,["number","jobId"])||!positive(entry.number)||!id(entry.jobId))||(value.title!==null&&!id(value.title))||(value.credits!==null&&!id(value.credits)))
    refuse("Name each sequence's finished film to join the feature, and the Editor's title and credits or null: {sequences: [{number, jobId}], title, credits}.");
  return value as unknown as FeatureFilmClaim;
}

/**
 * The sequence films this request may join, or a refusal saying why not. `jobs` are this project's
 * jobs. Every refusal names the sequence it is about.
 */
export function featureFilmSources(project:FeatureFilmProject,claim:FeatureFilmClaim,jobs:Job[]):{plan:SequencePlan;sequences:FeatureFilmSequence[];films:FeatureFilmSource[]}{
  const plan=project.format==="feature"?project.sequences:undefined;
  if(!plan)return refuse("Only a feature the Showrunner split into sequences is joined into one film.");
  const stale=stalePlanReason(plan,project.scriptVersion,project.parsed,project.direction);if(stale)refuse(stale);
  const count=plan.sequences.length;
  if(new Set(claim.sequences.map(entry=>entry.number)).size!==claim.sequences.length||claim.sequences.some(entry=>entry.number>count))refuse("Name each of the feature's "+count+" sequences once.");
  const named=Array.from({length:count},(_,index)=>claim.sequences.find(entry=>entry.number===index+1)?.jobId??refuse("Sequence "+(index+1)+" has no film to join. Make its final before joining the feature."));
  if(new Set(named).size!==named.length)refuse("Each sequence is joined from its own film; one film was named twice.");
  const sequences:FeatureFilmSequence[]=[],films:FeatureFilmSource[]=[];
  for(const [index,filmJobId]of named.entries()){
    const number=index+1,ref=sequenceRef(plan,number),film=jobs.find(job=>job.id===filmJobId);
    if(!film||film.projectId!==project.id)return refuse("Sequence "+number+"'s film isn't one of this project's films.");
    if(film.status!=="done"||!film.output)refuse("Sequence "+number+"'s film isn't finished.");
    const made=finalOf(film),final=made&&jobs.find(job=>job.id===made.id);
    if(!final||final.projectId!==project.id||final.status!=="done")return refuse("Sequence "+number+"'s film isn't made from one of this feature's sequence finals.");
    if(!final.sequence||final.sequence.planRevision!==plan.revision)refuse("Sequence "+number+"'s film is from an older split of the feature. Make its rough cut and final again.");
    if(!sameSequence(final.sequence,ref))refuse("The film named as sequence "+number+" is sequence "+final.sequence!.number+"'s.");
    const approval=project.approvals.find(entry=>entry.animaticJobId===final.animaticJobId);
    if(final.scriptVersion!==project.scriptVersion||!castingMatches(final.casting,project.casting)||!directionMatches(final.direction,project.direction)||approval?.decision!=="approved")
      refuse("Sequence "+number+"'s final is stale: the screenplay, the cast, the shot directions or its rough cut's approval changed after it was made. Make its rough cut and final again.");
    const newer=jobs.find(job=>job.id!==final.id&&job.stage==="final"&&job.status==="done"&&sameSequence(job.sequence,ref)&&Date.parse(job.completedAt??"")>Date.parse(final.completedAt??""));
    if(newer)refuse("Sequence "+number+"'s film isn't from its latest final. Join the film made from that final.");
    sequences.push({number,firstScene:ref.firstScene,lastScene:ref.lastScene,finalJobId:final.id,filmJobId});
    films.push({number,job:structuredClone(film),outputRevision:contentHash(film.output)});
  }
  return {plan,sequences,films};
}

/** The Editor's title or credits graphic: a finished motion graphic of this project, of that kind. */
export function featureFilmGraphic(role:"title"|"credits",jobId:string|null,jobs:Job[],projectId:string):FeatureFilmGraphic|null{
  if(jobId===null)return null;
  const job=jobs.find(value=>value.id===jobId),spec=job?.graphicRender?.spec,output=job?.graphicOutput;
  if(!job||job.projectId!==projectId||job.status!=="done"||!spec||!output||(spec.plan as {kind?:string}).kind!==role)
    return refuse("The feature's "+(role==="title"?"opening title":"end credits")+" must be a finished "+role+" graphic of this project.");
  const plan=spec.plan as {frames:number;width:number;height:number};
  return {jobId:job.id,outputRevision:contentHash(output),masterPath:output.masterPath,frames:plan.frames,width:plan.width,height:plan.height};
}

export function createFeatureFilmPlan(input:Omit<FeatureFilmPlan,"schema"|"revision"|"crossfadeFrames">):FeatureFilmPlan{
  const data={schema:FEATURE_FILM_SCHEMA,planRevision:input.planRevision,scriptVersion:input.scriptVersion,sequences:structuredClone(input.sequences),films:structuredClone(input.films),
    title:structuredClone(input.title),credits:structuredClone(input.credits),width:input.width,height:input.height,crossfadeFrames:FEATURE_FILM_CROSSFADE_FRAMES,storage:input.storage,requestHash:input.requestHash};
  const plan={...data,revision:contentHash(data)} as FeatureFilmPlan;validateFeatureFilmPlan(plan,input.films[0]?.job.projectId??"");return plan;
}

function graphic(value:unknown,projectId:string):void{
  if(value===null)return;
  if(!exact(value,["jobId","outputRevision","masterPath","frames","width","height"])||!id(value.jobId)||!hex(value.outputRevision)||!owned(value.masterPath,projectId,value.jobId as string)
    ||!positive(value.frames)||!positive(value.width)||!positive(value.height))invalid();
}

/** A plan's own shape: every film is the project's, in sequence order, with its final; the graphics are its own. */
export function validateFeatureFilmPlan(plan:FeatureFilmPlan,projectId:string):FeatureFilmPlan{
  if(!exact(plan,["schema","planRevision","scriptVersion","sequences","films","title","credits","width","height","crossfadeFrames","storage","requestHash","revision"])||plan.schema!==FEATURE_FILM_SCHEMA
    ||!hex(plan.planRevision)||!positive(plan.scriptVersion)||!Array.isArray(plan.sequences)||!plan.sequences.length||plan.sequences.length>FEATURE_FILM_SEQUENCE_LIMIT
    ||!Array.isArray(plan.films)||plan.films.length!==plan.sequences.length||plan.crossfadeFrames!==FEATURE_FILM_CROSSFADE_FRAMES||!["local","s3"].includes(plan.storage)||!hex(plan.requestHash)
    ||!positive(plan.width)||!positive(plan.height)||plan.width>1920||plan.height>1080||plan.width%2||plan.height%2)invalid();
  let next=1;
  for(const [index,sequence]of plan.sequences.entries()){
    const film=plan.films[index]!;
    if(!exact(sequence,["number","firstScene","lastScene","finalJobId","filmJobId"])||sequence.number!==index+1||sequence.firstScene!==next||!positive(sequence.lastScene)||sequence.lastScene<sequence.firstScene
      ||!id(sequence.finalJobId)||!id(sequence.filmJobId)||!exact(film,["number","job","outputRevision"])||film.number!==index+1||!hex(film.outputRevision)
      ||!film.job||film.job.id!==sequence.filmJobId||film.job.projectId!==projectId||film.job.status!=="done"||!film.job.output||contentHash(film.job.output)!==film.outputRevision
      ||finalOf(film.job)?.id!==sequence.finalJobId)invalid();
    next=sequence.lastScene+1;
  }
  if(new Set(plan.sequences.map(sequence=>sequence.filmJobId)).size!==plan.sequences.length)invalid();
  graphic(plan.title,projectId);graphic(plan.credits,projectId);
  const {revision,...data}=plan;if(revision!==contentHash(data))invalid("The feature's film plan changed after admission.");
  return plan;
}

/** A feature-film job carries its plan and nothing of any other kind of job. */
export function validateFeatureFilmJob(job:Pick<Job,"stage"|"projectId"|"featureFilm"|"output"|"costCapUsd"|"budgetReservedUsd"|"providerPlan"|"shotTakes"|"characterSheet"|"livingScript"|"currentFilm"|"dialogueReplacement"|"audioTake"|"lipSync"|"soundMix"|"pictureEdit"|"assemblyEdit"|"graphicRender"|"delivery"|"sequence"|"shotReuse"|"animaticJobId">):void{
  if((job.stage==="feature-film")!==Boolean(job.featureFilm))invalid("A feature's film requires its own admitted plan.");
  if(!job.featureFilm){if(job.output?.featureFilm)invalid("A different job cannot carry a feature's film.");return;}
  validateFeatureFilmPlan(job.featureFilm,job.projectId);
  if(job.costCapUsd!==0||job.budgetReservedUsd!==0||job.providerPlan||job.shotTakes||job.characterSheet||job.livingScript||job.currentFilm||job.dialogueReplacement||job.audioTake||job.lipSync
    ||job.soundMix||job.pictureEdit||job.assemblyEdit||job.graphicRender||job.delivery||job.sequence||job.shotReuse||job.animaticJobId)invalid("Invalid isolated feature-film job context.");
}

/** The export a feature-film job made: its own paths, its plan, its files and its content credentials. */
export function validateFeatureFilmOutput(job:Pick<Job,"id"|"projectId"|"featureFilm">,output:NonNullable<Job["output"]>):FeatureFilmOutput{
  const plan=job.featureFilm;if(!plan)return invalid("Only a feature's film carries a feature-film export.");
  if(!exact(output,["mp4Path","hlsPlaylistPath","captionsPath","manifestPath","featureFilm",...(output.c2paPath!==undefined?["c2paPath"]:[])]))invalid("The feature's film export carries other media.");
  const result=output.featureFilm!,suffix="export.mp4",prefix=output.mp4Path.slice(0,-suffix.length);
  if(!owned(output.mp4Path,job.projectId,job.id)||!output.mp4Path.endsWith("/"+suffix)||output.hlsPlaylistPath!==prefix+"hls/index.m3u8"||output.captionsPath!==prefix+"captions.vtt"||output.manifestPath!==prefix+"provenance.json")
    invalid("The feature's film export escaped its job.");
  if(!exact(result,["schema","planRevision","sha256","durationSec","credentials","files","revision"])||result.schema!==FEATURE_FILM_OUTPUT_SCHEMA||result.planRevision!==plan.revision||!hex(result.sha256)
    ||typeof result.durationSec!=="number"||!Number.isFinite(result.durationSec)||result.durationSec<=0||!Array.isArray(result.files)||!result.files.length||result.files.length>100_000)invalid("The feature's film export differs from its plan.");
  for(const file of result.files)if(!exact(file,["path","bytes","sha256"])||!owned(file.path,job.projectId,job.id)||!file.path.startsWith(prefix)||!hex(file.sha256)||!positive(file.bytes))invalid("The feature's film export lists media it doesn't own.");
  if(new Set(result.files.map(file=>file.path)).size!==result.files.length)invalid("The feature's film export lists a file twice.");
  for(const path of [output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.manifestPath])if(!result.files.some(file=>file.path===path))invalid("The feature's film export is missing "+path.slice(prefix.length)+".");
  if(result.files.find(file=>file.path===output.mp4Path)!.sha256!==result.sha256)invalid("The feature's film export changed its MP4.");
  const problem=exportSidecarProblem(output,result.credentials,result.sha256,result.files);if(problem)invalid(problem);
  const {revision,...data}=result;if(revision!==contentHash(data))invalid("The feature's film export receipt changed.");
  return result;
}

/**
 * Each sequence film and each graphic is still the one admitted: present, finished, its output
 * unchanged. A film made again, expired or taken down stops the join rather than joining something else.
 */
export function assertFeatureFilmSourcesAvailable(plan:FeatureFilmPlan,current:(jobId:string)=>Job|undefined,now=Date.now()):void{
  for(const film of plan.films){
    const job=current(film.job.id);
    if(!job||job.status!=="done"||!job.output||contentHash(job.output)!==film.outputRevision||!Number.isFinite(Date.parse(job.linkExpiresAt??""))||Date.parse(job.linkExpiresAt!)<=now)
      throw new FeatureFilmConflict("Sequence "+film.number+"'s film changed or expired after the join was admitted. Join the feature again.");
  }
  for(const graphic of [plan.title,plan.credits])if(graphic){
    const job=current(graphic.jobId);
    if(!job||job.status!=="done"||!job.graphicOutput||contentHash(job.graphicOutput)!==graphic.outputRevision)throw new FeatureFilmConflict("The Editor's title or credits changed after the join was admitted. Join the feature again.");
  }
}
