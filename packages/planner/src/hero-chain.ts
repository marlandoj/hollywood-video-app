import {contentHash} from "../../generator/src/capabilities";
import type {Job,JobInput} from "../../queue/src/index";
import type {PersistedProject,Project} from "../../api/src/index";
import {editRecord} from "./edit-timeline";
import {assertSelectedOutput,outputRevision} from "./dialogue-selection";
import {validateRenderRecord,type RenderFile} from "./shot-reuse";
import {validatePictureQcReport,type PictureQcReport} from "./picture-qc";
import {PROVENANCE_SIDECAR_NAME,PROVENANCE_SIGNED_CREDENTIAL_TYPE,exportCredentialsProblem,type ProvenanceCredentials} from "./provenance";

/**
 * HV-019-15: the hero-render chain (Release 3, build-order step 11).
 *
 * A creator chooses one shot of a finished final render, and it goes through an ordered chain of
 * stages -- **denoise, then frame-rate conversion, then upscale** -- each of which writes a new file
 * and its own provenance record: the digest of the file it read, the stage, the engine and provider,
 * the exact ffmpeg filter and encode arguments, the ffmpeg build that ran them, the digest of the file
 * it wrote, and an ffprobe reading of that file checked against what the stage was asked for.
 *
 * The order is the cheap and the honest one. Noise is removed at the shot's own size, before an
 * upscale could enlarge it; motion is interpolated at the shot's own size, where estimating it costs a
 * quarter of what it would at 4K; and the upscale comes last, once, from the cleanest frames there are.
 *
 * Every stage that ships is local ffmpeg at $0. The stage interface is written so that a paid one -- a
 * vendor upscaler, say -- has to **declare its provider and its spend** to be planned at all, and a
 * chain carrying any declared spend is still refused by the delivery job, which reserves nothing:
 * running one needs an approved vendor (G3) and a reservation of its own (G1), and neither exists.
 *
 * The chain's result is a deliverable: a new job beside the film, never a change to it. It does not
 * replace the shot in any cut. That would be an editorial operation with its own review, and it is
 * left out on purpose (docs/PROVIDER-ROUTING.md, "Hero-render chain").
 */
export const HERO_STAGES=["denoise","frame-rate","upscale"] as const;
export type HeroStageName=typeof HERO_STAGES[number];
export const HERO_DENOISE={light:"hqdn3d=2:1.5:3:2.25",medium:"hqdn3d=4:3:6:4.5",strong:"hqdn3d=8:6:12:9"} as const;
export type HeroDenoiseStrength=keyof typeof HERO_DENOISE;
export const HERO_FRAME_RATES=[24,25,30,48,50,60] as const;
export const HERO_HEIGHTS=[720,1080,1440,2160] as const;
/**
 * The limits a chain runs inside. The source limits are a shot as this studio renders one -- at most
 * 1080 lines, 60 fps and ten seconds -- and the output limits are UHD at 60 fps. They bound the work a
 * deliverable may cost (a ten-second UHD60 encode on one thread), not what ffmpeg could do.
 */
export const HERO_LIMITS=Object.freeze({
  source:Object.freeze({maxWidth:1920,maxHeight:1080,maxFps:60,maxDurationSec:10}),
  output:Object.freeze({maxWidth:3840,maxHeight:2160,maxFps:60}),
} as const);
/** The encode every stage writes with: H.264 at a near-transparent quality, one thread, so it is repeatable. */
export const HERO_ENCODE=Object.freeze(["-c:v","libx264","-preset","veryfast","-crf","14","-pix_fmt","yuv420p","-threads","1"] as const);
export const HERO_DEFAULTS=Object.freeze({denoise:"medium" as HeroDenoiseStrength,fps:60,height:2160});

/**
 * One engine a stage can run on. `paid` engines must be declared, with their provider and spend,
 * before a stage can name them; `local` ones run on this host's ffmpeg and cost nothing.
 */
export interface HeroStageEngine {id:string;stage:HeroStageName;provider:string;paid:boolean;description:string}
export const HERO_ENGINES:Readonly<Record<string,HeroStageEngine>>=Object.freeze({
  "ffmpeg-hqdn3d":{id:"ffmpeg-hqdn3d",stage:"denoise",provider:"local",paid:false,description:"ffmpeg's high-quality 3D denoiser (spatial and temporal)"},
  "ffmpeg-minterpolate":{id:"ffmpeg-minterpolate",stage:"frame-rate",provider:"local",paid:false,description:"ffmpeg's motion-compensated frame interpolation"},
  "ffmpeg-lanczos":{id:"ffmpeg-lanczos",stage:"upscale",provider:"local",paid:false,description:"ffmpeg's scaler with a Lanczos kernel"},
});
export const HERO_LOCAL_ENGINE:Record<HeroStageName,string>={denoise:"ffmpeg-hqdn3d","frame-rate":"ffmpeg-minterpolate",upscale:"ffmpeg-lanczos"};
export type HeroStageParams={strength:HeroDenoiseStrength}|{fps:number}|{height:number};
export interface HeroSpendDeclaration {provider:string;spendUsd:number}
export interface HeroStageRequest {stage:HeroStageName;engine:string;params:HeroStageParams;declared?:HeroSpendDeclaration}
export interface HeroStagePlan {index:number;stage:HeroStageName;engine:string;provider:string;paid:boolean;spendUsd:number;params:HeroStageParams}
export interface HeroChainPlan {schema:"hv-hero-chain-plan/1";stages:HeroStagePlan[];spendUsd:number;encode:string[];limits:typeof HERO_LIMITS;revision:string}
export interface HeroShotBinding {
  schema:"hv-hero-binding/1";storage:"local"|"s3";
  source:{projectId:string;jobId:string;stage:"final";outputRevision:string;shotId:string};
  /** The shot as the film sealed it: its render record and the clip file that record names. */
  shot:{renderRevision:string;inputHash:string;provider:string;model:string;durationSec:number;video:RenderFile};
  revision:string;
}
export interface HeroJobPlan {
  schema:"hv-hero-plan/1";kind:"hero";binding:HeroShotBinding;chain:HeroChainPlan;idempotencyKey:string;revision:string;
  /** A cut's deliverable carries these; a hero plan never does. Declared absent so the two plans share one job field. */
  reframe?:undefined;mezzanine?:undefined;openCaptions?:undefined;grade?:undefined;sdh?:undefined;
}
/** What ffprobe read of one file. `fps` is the rational ffprobe reports, so 30000/1001 is not rounded to 29.97. */
export interface HeroProbe {width:number;height:number;fps:string;frames:number;durationSec:number;codec:string;pixFmt:string}
export interface HeroStageRecord {
  schema:"hv-hero-stage/1";index:number;stage:HeroStageName;engine:string;provider:string;spendUsd:number;params:HeroStageParams;
  input:{sha256:string;bytes:number};filter:string;
  /** The whole ffmpeg command, with its paths written as `<input>` and `<output>` (`heroStageArgs`). */
  args:string[];
  /** The ffmpeg build that ran the stage: its version string and a digest of its whole `-version` banner. */
  runtime:{ffmpeg:string;revision:string};
  output:RenderFile;probe:HeroProbe;revision:string;
}
export interface HeroChainRecord {
  schema:"hv-hero-chain/1";planRevision:string;bindingRevision:string;
  /** Back to the shot: the film, the shot, its render record and the bytes the first stage read. */
  source:{projectId:string;jobId:string;shotId:string;renderRevision:string;sha256:string;bytes:number;probe:HeroProbe};
  stages:HeroStageRecord[];
  /** The content credentials of the chain's result, signed exactly as an export is when the host holds a key. */
  credentials:ProvenanceCredentials;
  revision:string;
}
export interface HeroDeliveryOutput {
  schema:"hv-hero-output/1";planRevision:string;
  /** The chain's result: the last stage's file. */
  file:RenderFile;
  /** Every file this deliverable retains: each stage's file, the chain's provenance record, and its C2PA sidecar when signed. */
  files:RenderFile[];
  chain:HeroChainRecord;
  /** The picture check every deliverable is sealed with, run on the chain's result. */
  quality:PictureQcReport;
  revision:string;
  /** A cut's deliverable carries these; a hero output never does. Declared absent so the two outputs share one job field. */
  resultRevision?:undefined;delivered?:undefined;captions?:undefined;grade?:undefined;sdh?:undefined;
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9_-]{1,128}$/;
export class HeroChainError extends Error {override name="HeroChainError";}
const fail:(message:string)=>never=message=>{throw new HeroChainError(message);};
const same=(a:unknown,b:unknown)=>contentHash(a)===contentHash(b);
const evenNear=(value:number)=>Math.max(2,Math.round(value/2)*2);
/** A rational frame rate as a number, or a refusal. */
export function heroFps(rational:string):number{
  const match=/^(\d{1,6})\/(\d{1,6})$/.exec(rational);if(!match||Number(match[2])===0)return fail("This file reports no usable frame rate.");
  return Number(match[1])/Number(match[2]);
}
function params(stage:HeroStageName,value:unknown):HeroStageParams{
  if(stage==="denoise"){const {strength}=editRecord(value,["strength"]) as {strength:unknown};
    if(typeof strength!=="string"||!Object.hasOwn(HERO_DENOISE,strength))fail("Choose a denoise strength: "+Object.keys(HERO_DENOISE).join(", ")+".");
    return {strength:strength as HeroDenoiseStrength};}
  if(stage==="frame-rate"){const {fps}=editRecord(value,["fps"]) as {fps:unknown};
    if(!(HERO_FRAME_RATES as readonly unknown[]).includes(fps))fail("Choose a frame rate this chain converts to: "+HERO_FRAME_RATES.join(", ")+" fps.");
    return {fps:fps as number};}
  const {height}=editRecord(value,["height"]) as {height:unknown};
  if(!(HERO_HEIGHTS as readonly unknown[]).includes(height))fail("Choose an upscale height this chain makes: "+HERO_HEIGHTS.join(", ")+" lines.");
  return {height:height as number};
}
/**
 * One stage of the chain, planned. This is the interface a later stage plugs into: an engine names
 * its stage, its provider and whether it is paid, and a paid engine is refused unless the request
 * declares that provider and a spend above zero. A local engine declares nothing and spends nothing.
 */
export function heroStagePlan(request:HeroStageRequest,index:number,engines:Readonly<Record<string,HeroStageEngine>>=HERO_ENGINES):HeroStagePlan{
  const value=editRecord(request,["stage","engine","params","declared"]) as unknown as HeroStageRequest;
  if(!(HERO_STAGES as readonly string[]).includes(value.stage))fail("Choose a hero stage: "+HERO_STAGES.join(", ")+".");
  const engine=typeof value.engine==="string"&&Object.hasOwn(engines,value.engine)?engines[value.engine]!:fail("This studio has no hero engine called "+String(value.engine).slice(0,64)+".");
  if(engine.stage!==value.stage)fail("The "+engine.id+" engine runs the "+engine.stage+" stage, not "+value.stage+".");
  let spendUsd=0;
  if(engine.paid){
    const declared=value.declared;
    if(!declared||typeof declared!=="object")return fail("The "+engine.id+" engine is paid ("+engine.provider+"). A paid stage must declare its provider and its spend before it is planned, and this one declares neither.");
    editRecord(declared,["provider","spendUsd"]);
    if(declared.provider!==engine.provider)fail("The "+engine.id+" engine is "+engine.provider+"'s, and this stage declares "+String(declared.provider).slice(0,64)+".");
    if(typeof declared.spendUsd!=="number"||!Number.isFinite(declared.spendUsd)||declared.spendUsd<=0||declared.spendUsd>50)
      fail("A paid stage declares its spend in dollars, above zero and at most $50 (the single-evaluation gate, G1).");
    spendUsd=Math.round(declared.spendUsd*10000)/10000;
  }else if(value.declared!==undefined)fail("The "+engine.id+" engine runs on this host and costs nothing; it declares no provider or spend.");
  return {index,stage:value.stage,engine:engine.id,provider:engine.provider,paid:engine.paid,spendUsd,params:params(value.stage,value.params)};
}
/** The chain: exactly the three stages, in their order, each planned through `heroStagePlan`. */
export function heroChainPlan(requests:HeroStageRequest[],engines:Readonly<Record<string,HeroStageEngine>>=HERO_ENGINES):HeroChainPlan{
  if(!Array.isArray(requests)||requests.length!==HERO_STAGES.length)fail("A hero chain runs "+HERO_STAGES.join(", then ")+", each once.");
  const stages=requests.map((request,at)=>{
    if(request?.stage!==HERO_STAGES[at])fail("A hero chain runs "+HERO_STAGES.join(", then ")+", in that order.");
    return heroStagePlan(request,at+1,engines);
  });
  const data={schema:"hv-hero-chain-plan/1" as const,stages,spendUsd:Math.round(stages.reduce((total,stage)=>total+stage.spendUsd,0)*10000)/10000,
    encode:[...HERO_ENCODE],limits:HERO_LIMITS};
  return {...data,revision:contentHash(data)};
}
/** The creator's three choices, made into the chain's requests on this host's own engines. Every choice has a default. */
export function heroChainRequests(input:{denoise?:unknown;fps?:unknown;height?:unknown}={}):HeroStageRequest[]{
  editRecord(input,["denoise","fps","height"]);
  return [
    {stage:"denoise",engine:HERO_LOCAL_ENGINE.denoise,params:{strength:(input.denoise??HERO_DEFAULTS.denoise) as HeroDenoiseStrength}},
    {stage:"frame-rate",engine:HERO_LOCAL_ENGINE["frame-rate"],params:{fps:(input.fps??HERO_DEFAULTS.fps) as number}},
    {stage:"upscale",engine:HERO_LOCAL_ENGINE.upscale,params:{height:(input.height??HERO_DEFAULTS.height) as number}},
  ];
}
function shotFile(value:RenderFile,prefix:string):RenderFile{
  editRecord(value,["path","sha256","bytes"]);
  if(typeof value.path!=="string"||!value.path.startsWith(prefix)||!/^[A-Za-z0-9._/-]{1,1024}$/.test(value.path)||value.path.split("/").some(segment=>!segment||segment==="."||segment===".."))
    fail("A hero chain reads the shot from inside its own film and nowhere else.");
  if(!HASH.test(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<1)fail("Name the shot's bytes and their digest.");
  return {path:value.path,sha256:value.sha256,bytes:value.bytes};
}
export function heroShotBinding(input:Omit<HeroShotBinding,"schema"|"revision">):HeroShotBinding{
  const {storage,source,shot}=editRecord(input,["storage","source","shot"]) as unknown as Omit<HeroShotBinding,"schema"|"revision">;
  if(storage!=="local"&&storage!=="s3")fail("Choose the configured storage backend for this film.");
  editRecord(source,["projectId","jobId","stage","outputRevision","shotId"]);editRecord(shot,["renderRevision","inputHash","provider","model","durationSec","video"]);
  if(!UUID.test(source.projectId)||!UUID.test(source.jobId)||!ID.test(source.shotId))fail("Name the film's project, job and shot.");
  if(source.stage!=="final")fail("A hero chain is made from a shot of a final render.");
  if(!HASH.test(source.outputRevision)||!HASH.test(shot.renderRevision)||!HASH.test(shot.inputHash))fail("Name the sealed film and the shot's render record.");
  if(typeof shot.provider!=="string"||!shot.provider||shot.provider.length>64||typeof shot.model!=="string"||!shot.model||shot.model.length>128)fail("Name the provider and model that rendered this shot.");
  if(typeof shot.durationSec!=="number"||!Number.isFinite(shot.durationSec)||shot.durationSec<=0)fail("Name how long this shot runs.");
  if(shot.durationSec>HERO_LIMITS.source.maxDurationSec)
    fail("This shot runs "+shot.durationSec+" s, and a hero chain takes shots of at most "+HERO_LIMITS.source.maxDurationSec+" s.");
  const data={schema:"hv-hero-binding/1" as const,storage,
    source:{projectId:source.projectId,jobId:source.jobId,stage:"final" as const,outputRevision:source.outputRevision,shotId:source.shotId},
    shot:{renderRevision:shot.renderRevision,inputHash:shot.inputHash,provider:shot.provider,model:shot.model,durationSec:shot.durationSec,
      video:shotFile(shot.video,source.projectId+"/"+source.jobId+"/clips/")}};
  return {...data,revision:contentHash(data)};
}
export function validateHeroShotBinding(binding:HeroShotBinding):HeroShotBinding{
  if(!binding||binding.schema!=="hv-hero-binding/1")fail("Use a hero shot binding.");
  editRecord(binding,["schema","storage","source","shot","revision"]);
  const rebuilt=heroShotBinding({storage:binding.storage,source:binding.source,shot:binding.shot});
  if(!same(rebuilt,binding))fail("This hero binding does not match the shot it names.");
  return rebuilt;
}
/**
 * The shot of a finished film, bound by what the film sealed: its output's revision, the shot's own
 * render record (re-validated against the film) and the clip file that record names.
 */
export function heroShotBindingFor(job:Job,shotId:string,storage:HeroShotBinding["storage"]):HeroShotBinding{
  assertHeroSourceShape(job);
  const record=job.output!.shotRenders?.find(value=>value.shotId===shotId);
  if(!record)fail("This film has no rendered shot called "+String(shotId).slice(0,128)+".");
  const valid=validateRenderRecord(record,job);
  return heroShotBinding({storage,source:{projectId:job.projectId,jobId:job.id,stage:"final",outputRevision:outputRevision(job),shotId:valid.shotId},
    shot:{renderRevision:valid.revision,inputHash:valid.inputHash,provider:valid.clip.provider,model:valid.clip.model,durationSec:valid.clip.durationSec,video:valid.files.video}});
}
function assertHeroSourceShape(job:Job|undefined):asserts job is Job{
  if(!job||job.stage!=="final")fail("A hero chain is made from a shot of a final render.");
  // A mixed current film keeps takes adopted from other films; their shots are not this film's to bind.
  if(job.currentFilm?.schema==="hv-current-film-job/3")fail("A mixed film, one that keeps takes from earlier films, has no shots of its own to make a hero render from.");
  if(job.status!=="done"||!job.output)fail("This film is not finished, so none of its shots can be made a hero render yet.");
  if(!job.output.shotRenders?.length)fail("This film retained no shot renders, so none of its shots can be made a hero render.");
}
/** A hero chain is a deliverable, and a deliverable reserves and spends nothing. */
export function heroJobPlan(binding:HeroShotBinding,requests:HeroStageRequest[],engines:Readonly<Record<string,HeroStageEngine>>=HERO_ENGINES):HeroJobPlan{
  const valid=validateHeroShotBinding(binding),chain=heroChainPlan(requests,engines);
  if(chain.spendUsd!==0)
    fail("This hero chain declares $"+chain.spendUsd+" of paid stages. A hero render is a deliverable and is admitted only at zero cost: a paid stage needs its vendor approved (G3) and a reservation of its own (G1) before it can run.");
  const data={schema:"hv-hero-plan/1" as const,kind:"hero" as const,binding:valid,chain,
    idempotencyKey:contentHash({schema:"hv-hero-idempotency/1",outputRevision:valid.source.outputRevision,shotId:valid.source.shotId,renderRevision:valid.shot.renderRevision,chain:chain.revision})};
  return {...data,revision:contentHash(data)};
}
export function validateHeroJobPlan(plan:HeroJobPlan):HeroJobPlan{
  if(!plan||plan.schema!=="hv-hero-plan/1"||plan.kind!=="hero")fail("Use a hero plan.");
  editRecord(plan,["schema","kind","binding","chain","idempotencyKey","revision"]);
  if(!Array.isArray(plan.chain?.stages))fail("Use a hero plan.");
  const rebuilt=heroJobPlan(plan.binding,plan.chain.stages.map(stage=>({stage:stage.stage,engine:stage.engine,params:stage.params,
    ...(stage.paid?{declared:{provider:stage.provider,spendUsd:stage.spendUsd}}:{})})));
  if(!same(rebuilt,plan))fail("This hero plan does not match the shot and chain it names.");
  return rebuilt;
}
/** The directory a hero deliverable writes into, under its own job. */
export const HERO_DIRECTORY="hero";
export function heroStageFileName(stage:HeroStagePlan):string{return stage.index+"-"+stage.stage+".mp4";}
/** The files a hero deliverable may retain, closed before it is made: one per stage, the record, and the sidecar when signed. */
export function heroInventory(job:{projectId:string;id:string},plan:HeroJobPlan,signed:boolean):string[]{
  const prefix=job.projectId+"/"+job.id+"/"+HERO_DIRECTORY+"/";
  return [...plan.chain.stages.map(stage=>prefix+heroStageFileName(stage)),prefix+"provenance.json",...(signed?[prefix+PROVENANCE_SIDECAR_NAME]:[])];
}
/**
 * The ffmpeg filter a stage runs, derived from its plan and the probe of the file it reads. Derived,
 * not carried, so a record cannot name one filter and have run another.
 */
export function heroStageFilter(stage:HeroStagePlan,input:HeroProbe):string{
  if(stage.stage==="denoise")return HERO_DENOISE[(stage.params as {strength:HeroDenoiseStrength}).strength];
  if(stage.stage==="frame-rate")return "minterpolate=fps="+(stage.params as {fps:number}).fps+":mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1";
  const {width,height}=heroUpscaleSize(input,(stage.params as {height:number}).height);
  return "scale="+width+":"+height+":flags=lanczos";
}
export function heroUpscaleSize(input:Pick<HeroProbe,"width"|"height">,height:number):{width:number;height:number}{
  if(height<=input.height)fail("An upscale makes the shot larger: it is "+input.height+" lines and this chain asked for "+height+".");
  const width=evenNear(input.width*height/input.height);
  if(width>HERO_LIMITS.output.maxWidth||height>HERO_LIMITS.output.maxHeight)
    fail("Upscaled to "+height+" lines this shot would be "+width+" by "+height+", over the "+HERO_LIMITS.output.maxWidth+" by "+HERO_LIMITS.output.maxHeight+" limit.");
  return {width,height};
}
/** The source a chain may read: within the shot limits, and the duration its render record claims. */
export function assertHeroSourceProbe(probe:HeroProbe,binding:HeroShotBinding):void{
  validateHeroProbe(probe);const {maxWidth,maxHeight,maxFps,maxDurationSec}=HERO_LIMITS.source,fps=heroFps(probe.fps);
  if(probe.width>maxWidth||probe.height>maxHeight)fail("This shot is "+probe.width+" by "+probe.height+", and a hero chain takes shots of at most "+maxWidth+" by "+maxHeight+".");
  if(fps>maxFps)fail("This shot runs at "+Math.round(fps*1000)/1000+" fps, and a hero chain takes shots of at most "+maxFps+" fps.");
  if(probe.durationSec>maxDurationSec+0.5)fail("This shot runs "+probe.durationSec+" s, and a hero chain takes shots of at most "+maxDurationSec+" s.");
  if(Math.abs(probe.durationSec-binding.shot.durationSec)>1)fail("This shot's file runs "+probe.durationSec+" s and its render record says "+binding.shot.durationSec+" s.");
}
export function validateHeroProbe(probe:HeroProbe):HeroProbe{
  editRecord(probe,["width","height","fps","frames","durationSec","codec","pixFmt"]);
  for(const key of ["width","height","frames"] as const)if(!Number.isSafeInteger(probe[key])||probe[key]<1)fail("A hero probe reads a whole number of pixels and frames.");
  heroFps(probe.fps);
  if(typeof probe.durationSec!=="number"||!Number.isFinite(probe.durationSec)||probe.durationSec<=0)fail("A hero probe reads a playable duration.");
  if(typeof probe.codec!=="string"||!probe.codec||typeof probe.pixFmt!=="string"||!probe.pixFmt)fail("A hero probe names its codec and pixel format.");
  return probe;
}
/**
 * The ffprobe gate on one stage's file: what that stage was asked to make, from the file it read.
 * Denoise keeps every frame and the frame size; frame-rate conversion keeps the frame size and the
 * running time at the new rate; the upscale keeps every frame at the new size.
 */
export function assertHeroStageProbe(stage:HeroStagePlan,input:HeroProbe,output:HeroProbe):void{
  validateHeroProbe(input);validateHeroProbe(output);
  const what=stage.index+" ("+stage.stage+")",fps=heroFps(output.fps);
  if(output.codec!=="h264"||output.pixFmt!=="yuv420p")fail("Stage "+what+" wrote "+output.codec+" "+output.pixFmt+", and every stage writes h264 yuv420p.");
  if(output.width>HERO_LIMITS.output.maxWidth||output.height>HERO_LIMITS.output.maxHeight||fps>HERO_LIMITS.output.maxFps)fail("Stage "+what+" wrote a file over the chain's output limits.");
  if(stage.stage==="upscale"){
    const size=heroUpscaleSize(input,(stage.params as {height:number}).height);
    if(output.width!==size.width||output.height!==size.height)fail("Stage "+what+" wrote "+output.width+" by "+output.height+" and was asked for "+size.width+" by "+size.height+".");
  }else if(output.width!==input.width||output.height!==input.height)fail("Stage "+what+" changed the frame size from "+input.width+" by "+input.height+" to "+output.width+" by "+output.height+".");
  if(stage.stage==="frame-rate"){
    const target=(stage.params as {fps:number}).fps;
    if(fps!==target)fail("Stage "+what+" wrote "+output.fps+" fps and was asked for "+target+".");
    // Interpolation ends on the last source frame's instant, so the result may be up to one source
    // frame and one output frame shorter than the file it read.
    if(Math.abs(output.durationSec-input.durationSec)>1/heroFps(input.fps)+2/target+0.01)fail("Stage "+what+" runs "+output.durationSec+" s and the file it read runs "+input.durationSec+" s.");
  }else{
    if(output.fps!==input.fps)fail("Stage "+what+" changed the frame rate from "+input.fps+" to "+output.fps+".");
    if(output.frames!==input.frames)fail("Stage "+what+" wrote "+output.frames+" frames from "+input.frames+".");
  }
}
/** A frame-rate stage that would write the rate the shot already has is refused rather than run for nothing. */
export function assertHeroFrameRateChanges(stage:HeroStagePlan,input:HeroProbe):void{
  if(stage.stage==="frame-rate"&&heroFps(input.fps)===(stage.params as {fps:number}).fps)
    fail("This shot already runs at "+(stage.params as {fps:number}).fps+" fps. Choose another frame rate for the conversion stage.");
}
function file(value:RenderFile,path:string,what:string):RenderFile{
  editRecord(value,["path","sha256","bytes"]);
  if(value.path!==path||!HASH.test(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>8*1024**3)fail(what+" is not the file this deliverable retains.");
  return value;
}
/**
 * A hero chain's record, re-derived link by link. Each stage read the file the one before it wrote
 * (the first read the shot the binding names), ran the filter its plan and that file derive, and
 * wrote a file whose probe passes the stage's gate.
 */
export function validateHeroChainRecord(plan:HeroJobPlan,job:{projectId:string;id:string},record:HeroChainRecord,signed:boolean):HeroChainRecord{
  editRecord(record,["schema","planRevision","bindingRevision","source","stages","credentials","revision"]);
  const {revision,...data}=record;
  if(record.schema!=="hv-hero-chain/1"||revision!==contentHash(data))fail("This hero chain's record changed.");
  if(record.planRevision!==plan.revision||record.bindingRevision!==plan.binding.revision)fail("This hero chain's record belongs to another plan.");
  const source=editRecord(record.source,["projectId","jobId","shotId","renderRevision","sha256","bytes","probe"]) as HeroChainRecord["source"],binding=plan.binding;
  if(source.projectId!==binding.source.projectId||source.jobId!==binding.source.jobId||source.shotId!==binding.source.shotId||source.renderRevision!==binding.shot.renderRevision
    ||source.sha256!==binding.shot.video.sha256||source.bytes!==binding.shot.video.bytes)fail("This hero chain's record does not lead back to the shot it was made from.");
  assertHeroSourceProbe(source.probe,binding);
  if(!Array.isArray(record.stages)||record.stages.length!==plan.chain.stages.length)fail("A hero chain records every stage it ran.");
  const paths=heroInventory(job,plan,signed);
  let input={sha256:source.sha256,bytes:source.bytes},probe=source.probe;
  for(const [at,stage] of record.stages.entries()){
    const planned=plan.chain.stages[at]!;
    editRecord(stage,["schema","index","stage","engine","provider","spendUsd","params","input","filter","args","runtime","output","probe","revision"]);
    const {revision:stageRevision,...stageData}=stage;
    if(stage.schema!=="hv-hero-stage/1"||stageRevision!==contentHash(stageData))fail("Stage "+(at+1)+"'s record changed.");
    if(stage.index!==planned.index||stage.stage!==planned.stage||stage.engine!==planned.engine||stage.provider!==planned.provider||stage.spendUsd!==planned.spendUsd||!same(stage.params,planned.params))
      fail("Stage "+(at+1)+" ran something other than its plan.");
    if(!same(stage.input,input))fail("Stage "+(at+1)+" did not read the file "+(at?"stage "+at+" wrote":"the shot is")+".");
    if(stage.filter!==heroStageFilter(planned,probe))fail("Stage "+(at+1)+" names a filter its plan does not derive.");
    if(!Array.isArray(stage.args)||!same(stage.args,heroStageArgs(stage.filter)))fail("Stage "+(at+1)+" names arguments other than the chain's.");
    editRecord(stage.runtime,["ffmpeg","revision"]);
    if(typeof stage.runtime.ffmpeg!=="string"||!/^[A-Za-z0-9._+~:-]{1,64}$/.test(stage.runtime.ffmpeg)||!HASH.test(stage.runtime.revision))fail("Stage "+(at+1)+" names the ffmpeg build that ran it.");
    file(stage.output,paths[at]!,"Stage "+(at+1)+"'s file");
    assertHeroStageProbe(planned,probe,stage.probe);
    if(planned.stage==="frame-rate")assertHeroFrameRateChanges(planned,probe);
    input={sha256:stage.output.sha256,bytes:stage.output.bytes};probe=stage.probe;
  }
  const problem=exportCredentialsProblem(record.credentials,input.sha256);
  if(problem)fail(problem);
  if((record.credentials.type===PROVENANCE_SIGNED_CREDENTIAL_TYPE)!==signed)fail("This hero chain's credentials and its retained files disagree about its signature.");
  return record;
}
/**
 * The whole command a stage runs, with its two paths written as `<input>` and `<output>`. One list for
 * every stage but the filter, so a record can name exactly what ran. The picture only: a hero render
 * is the shot's frames, and its sound is the cut's.
 */
export function heroStageArgs(filter:string):string[]{
  return ["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i","<input>",
    "-map","0:v:0","-an","-sn","-dn","-vf",filter,"-filter_threads","1",...HERO_ENCODE,
    "-map_metadata","-1","-fflags","+bitexact","-flags:v","+bitexact","-bsf:v","filter_units=remove_types=6","-movflags","+faststart","-y","<output>"];
}
export function validateHeroOutput(plan:HeroJobPlan,job:{projectId:string;id:string},output:HeroDeliveryOutput):HeroDeliveryOutput{
  editRecord(output,["schema","planRevision","file","files","chain","quality","revision"]);
  const {revision,...data}=output;
  if(output.schema!=="hv-hero-output/1"||revision!==contentHash(data)||output.planRevision!==plan.revision)fail("The hero deliverable lost its admitted plan.");
  const signed=heroSigned(output.chain?.credentials),paths=heroInventory(job,plan,signed);
  if(!Array.isArray(output.files)||output.files.length!==paths.length)fail("A hero deliverable retains each stage's file, its record and nothing else.");
  output.files.forEach((value,at)=>file(value,paths[at]!,"Retained file "+(at+1)));
  const chain=validateHeroChainRecord(plan,job,output.chain,signed),last=chain.stages.at(-1)!.output;
  for(const [at,stage] of chain.stages.entries())if(!same(stage.output,output.files[at]))fail("Stage "+(at+1)+"'s retained file is not the one its record names.");
  if(!same(output.file,last))fail("A hero deliverable's result is its last stage's file.");
  if(signed&&chain.credentials.type===PROVENANCE_SIGNED_CREDENTIAL_TYPE&&output.files.at(-1)!.sha256!==chain.credentials.sidecar.sha256)fail("The C2PA sidecar differs from the bytes the chain's record names.");
  let report:PictureQcReport;
  try{report=validatePictureQcReport(output.quality);}catch(error){return fail("This hero deliverable's quality check is not a reading of its own file. "+(error as Error).message);}
  if(report.source.sha256!==last.sha256||report.source.bytes!==last.bytes)fail("This hero deliverable's quality check measured different bytes from its result.");
  const probe=chain.stages.at(-1)!.probe;
  if(report.programme.width!==probe.width||report.programme.height!==probe.height||report.programme.video!==probe.codec)fail("This hero deliverable's two readings of its result disagree.");
  return output;
}
/** A hero job's frame count: its shot's running time at the rate the chain converts it to. */
export function heroTotalFrames(plan:Pick<HeroJobPlan,"binding"|"chain">):number{
  const conversion=plan.chain.stages.find(stage=>stage.stage==="frame-rate")!;
  return Math.max(1,Math.round(plan.binding.shot.durationSec*(conversion.params as {fps:number}).fps));
}
type JobLike=Job|JobInput;
export function validateHeroJob(job:JobLike,plan:HeroJobPlan):HeroJobPlan{
  const valid=validateHeroJobPlan(plan);
  if(!UUID.test(job.id)||!UUID.test(job.projectId))fail("Use a valid project and job identity.");
  if(valid.binding.source.projectId!==job.projectId)fail("A hero render is made inside the project the film belongs to.");
  if(valid.binding.source.jobId===job.id)fail("A hero render is a new job beside the film, never the film's own job.");
  if(job.totalFrames!==heroTotalFrames(valid))fail("A hero render counts the frames of its shot at the rate the chain converts it to.");
  return valid;
}
/** At admission and at dispatch: the film is still the one the binding names, and the shot is still in it. */
export function assertHeroSourceAvailable(binding:HeroShotBinding,source:(JobLike&{status?:string})|undefined):void{
  const valid=validateHeroShotBinding(binding);
  if(!source||source.id!==valid.source.jobId||source.projectId!==valid.source.projectId||source.stage!=="final"||source.status!=="done"||!source.output)
    fail("The film this hero render is made from is no longer available.");
  if(outputRevision(source as Job)!==valid.source.outputRevision)fail("This film has been rendered again since the hero render was planned. Choose the shot from the film that is current now.");
  const record=source.output.shotRenders?.find(value=>value.shotId===valid.source.shotId);
  if(!record||record.revision!==valid.shot.renderRevision||!same(record.files.video,valid.shot.video))fail("The shot this hero render names is not in the film's sealed output.");
}
/** The film's own media rule: retained, done, the output it sealed, and current cast permission for every shot. */
export function assertHeroSourcePermission(source:Job|undefined,project:Project|PersistedProject|null|undefined,now=Date.now()):void{
  assertHeroSourceShape(source);
  try{assertSelectedOutput(source,project,{jobId:source.id,outputRevision:outputRevision(source)},now);}
  catch(error){fail("This film's cast or source permission is no longer available, so no hero render can be made from it. "+(error as Error).message);}
}
/**
 * What the result's signed C2PA manifest says it was derived from: the film, the shot, the shot's
 * render record, the bytes the first stage read, and the digest of every stage's record. The chain's
 * own revision cannot be signed, because the chain's record carries the signature's credentials.
 */
export function heroDerivation(source:Pick<HeroChainRecord["source"],"jobId"|"shotId"|"renderRevision"|"sha256">,stages:HeroStageRecord[]):{jobId:string;shotId:string;renderRevision:string;sha256:string;stagesRevision:string}{
  return {jobId:source.jobId,shotId:source.shotId,renderRevision:source.renderRevision,sha256:source.sha256,stagesRevision:contentHash(stages)};
}
/** Whether a hero chain's result was signed: its credentials name a C2PA sidecar. */
export function heroSigned(credentials:ProvenanceCredentials|undefined):boolean{return credentials?.type===PROVENANCE_SIGNED_CREDENTIAL_TYPE;}
/** The C2PA sidecar a hero deliverable retains beside its record, or `undefined` when it is unsigned. */
export function heroSidecarFile(output:Pick<HeroDeliveryOutput,"files">):RenderFile|undefined{
  return output.files.find(file=>file.path.endsWith("/"+HERO_DIRECTORY+"/"+PROVENANCE_SIDECAR_NAME));
}
