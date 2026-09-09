import {createHash} from "node:crypto";
import {lstatSync,mkdirSync,realpathSync} from "node:fs";
import {resolve,join} from "node:path";
import {contentHash as hash} from "../../generator/src/capabilities";
import {audioAbortable} from "../../generator/src/audio-stream";
import {speechWavHeader} from "../../generator/src/speech";
import type {VideoClip} from "../../generator/src/index";
import {editValidationKey} from "../../planner/src/edit-validation-key";
import {resolveCurrentFilmMixedAssembly,validateCurrentFilmMixedAssemblyClock,type CurrentFilmMixedAssembly,type CurrentFilmMixedAssemblyClock} from "../../planner/src/current-film-mixed-clock";
import type {CurrentFilmMixedCheckpoint,CurrentFilmMixedCheckpointContext} from "../../planner/src/current-film-mixed-context";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {currentFilmExportDirectoryKey,createCurrentFilmExportDirectory} from "./current-film-output-directory";

export interface CurrentFilmMixedAssembleOptions {
  /** Caller ties signal to its lease/current-authority monitor during FFmpeg steps. */
  access:()=>Promise<void>;signal?:AbortSignal;burnInCaptions?:boolean;degradedShots?:string[];
}
export interface CurrentFilmMixedProvenance {
  spec:"hv-provenance/3.0";projectId:string;jobId:string;jobPlanRevision:string;materializationRevision:string;checkpointRevision:string;
  documentRevision:string;targetRevision:string;clockRevision:string;videoSha256:string;
  shots:{ordinal:number;logicalShotId:string;renderId:string;inputRevision:string;kind:"generated"|"reused";
    original:{jobId:string;shotId:string;inputRevision:string;recordRevision:string;captureRevision:string};
    adoptionRevision:string|null;provider:string;model:string;seed:number;fingerprint:string;startFrame:number;endFrame:number;
    recordedPictureRevision:string|null;targetPictureRevision:string|null;recordedSpeechRevision:string|null;degraded:boolean}[];
  assembledAt:"1970-01-01T00:00:00.000Z";
  credentials:{type:"c2pa-style";issuer:"hollywood-video-app";claim:string};
}
/** Private kernel input intentionally has neither an inference cost nor a new owning record. */
export type CurrentFilmMixedKernelClip=Omit<VideoClip,"cost"|"renderRecord">;
export interface PreparedCurrentFilmMixedAssembly {
  context:CurrentFilmMixedCheckpointContext;checkpoint:CurrentFilmMixedCheckpoint;assembly:CurrentFilmMixedAssembly;
  root:string;outDir:string;clips:CurrentFilmMixedKernelClip[];degradedShots:string[];
}
function fail(message:string):never {throw new Error(message);}
function degradedTargets(assembly:CurrentFilmMixedAssembly,value:string[]):string[] {
  if(!Array.isArray(value)||value.length>assembly.slots.length||new Set(value).size!==value.length||value.some(id=>!assembly.slots.some(slot=>slot.target.renderId===id)))fail("Retain exact unique target degraded-shot identities.");
  return value;
}
async function access(options:CurrentFilmMixedAssembleOptions):Promise<void> {
  options.signal?.throwIfAborted();const checked=Promise.resolve().then(options.access);
  if(options.signal)await audioAbortable(checked,options.signal);else await checked;
  options.signal?.throwIfAborted();
}
function rootPath(path:string):string {
  if(typeof path!=="string"||lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())fail("Use a real mixed-film artifact directory.");
  return realpathSync(path);
}
function components(root:string,key:string,create=false):string {
  if(!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(part=>!part||part==="."||part===".."))fail("Mixed assembly media escaped its owner.");
  let path=root;
  for(const part of key.split("/")){path=join(path,part);if(create)try{mkdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    const stat=lstatSync(path);if(stat.isSymbolicLink()||realpathSync(path)!==path||create&&!stat.isDirectory())fail("Mixed assembly refuses linked or unavailable paths.");}
  return path;
}
function filePath(root:string,file:RenderFile):string {
  const path=components(root,file.path),stat=lstatSync(path);if(!stat.isFile()||stat.size!==file.bytes)fail("The exact owned mixed-film role is missing or changed.");return path;
}
async function verifyNativeSpeech(prepared:PreparedCurrentFilmMixedAssembly,index:number,options:CurrentFilmMixedAssembleOptions):Promise<void> {
  const slot=prepared.assembly.slots[index]!,report=slot.originalRecord.clip.speech;if(!report)return;
  const file=slot.ownedFiles.audio,size=44+report.totalSamples*2;
  if(!file||!Number.isSafeInteger(size)||size<46||size>44+600*22050*2||file.bytes!==size)fail("Mixed assembly requires its exact bounded native speech role.");
  await access(options);const bytes=Buffer.from(await Bun.file(filePath(prepared.root,file)).slice(0,size+1).arrayBuffer());options.signal?.throwIfAborted();
  if(bytes.byteLength!==size||!bytes.subarray(0,44).equals(speechWavHeader(report.totalSamples)))fail("Mixed assembly speech lost its native 22,050 Hz mono PCM header.");
  let cursor=0;const silence=(end:number)=>{if(bytes.subarray(44+cursor*2,44+end*2).some(value=>value!==0))fail("Mixed assembly speech pauses contain changed PCM.");};
  for(const line of report.lines){options.signal?.throwIfAborted();silence(line.startSample);if(createHash("sha256").update(bytes.subarray(44+line.startSample*2,44+line.endSample*2)).digest("hex")!==line.pcmSha256)fail("Mixed assembly speech lost its recorded line PCM.");cursor=line.endSample;}
  silence(report.totalSamples);
}
/** Checks every owned role, including ancillary poster and original native audio. */
export async function verifyCurrentFilmMixedAssemblyRoles(prepared:PreparedCurrentFilmMixedAssembly,options:CurrentFilmMixedAssembleOptions):Promise<void> {
  for(const [index,slot]of prepared.assembly.slots.entries()){
    for(const file of Object.values(slot.ownedFiles)){
      await access(options);const path=filePath(prepared.root,file),digest=createHash("sha256");let bytes=0;
      for await(const chunk of Bun.file(path).stream()){
        await access(options);bytes+=chunk.byteLength;if(bytes>file.bytes)fail("Mixed assembly role exceeds its recorded size.");digest.update(chunk);
      }
      if(bytes!==file.bytes||digest.digest("hex")!==file.sha256)fail("The exact owned mixed-film role failed checksum verification.");
      filePath(prepared.root,file);
    }
    await verifyNativeSpeech(prepared,index,options);
  }
  await access(options);
}
export async function prepareCurrentFilmMixedAssembly(context:CurrentFilmMixedCheckpointContext,checkpoint:CurrentFilmMixedCheckpoint,artifactRoot:string,outDir:string,options:CurrentFilmMixedAssembleOptions):Promise<PreparedCurrentFilmMixedAssembly> {
  if(!options||typeof options.access!=="function"||options.burnInCaptions!==undefined&&typeof options.burnInCaptions!=="boolean")fail("Use an explicit current-access guard and mixed assembly options.");
  if(!editValidationKey({context,checkpoint,degradedShots:options.degradedShots??[]},256*1024**2))fail("Retain bounded portable mixed assembly inputs before accessing media.");
  const copied=structuredClone({context,checkpoint,degradedShots:options.degradedShots??[]}),assembly=resolveCurrentFilmMixedAssembly(copied.context,copied.checkpoint);
  const degraded=degradedTargets(assembly,copied.degradedShots);
  await access(options);
  const root=rootPath(artifactRoot);
  currentFilmExportDirectoryKey(root,assembly.projectId,assembly.jobId,outDir);
  const clips:CurrentFilmMixedKernelClip[]=assembly.slots.map(slot=>{
    const original=slot.originalRecord.clip,files=slot.ownedFiles;
    return {path:filePath(root,files.video),provider:original.provider,model:original.model,seed:original.seed,durationSec:original.durationSec,fingerprint:original.fingerprint,
      ...(original.audioMode?{audioMode:original.audioMode}:{}),...(original.speech?{speech:original.speech}:{}),...(original.picturePerformance?{picturePerformance:original.picturePerformance}:{}),
      ...(files.audio?{audioPath:filePath(root,files.audio)}:{}),...(files.poster?{posterPath:filePath(root,files.poster)}:{}),...(files.sourcePoster?{sourcePosterPath:filePath(root,files.sourcePoster)}:{})};
  });
  const prepared={context:copied.context,checkpoint:copied.checkpoint,assembly,root,outDir:resolve(outDir),clips,degradedShots:degraded};
  await verifyCurrentFilmMixedAssemblyRoles(prepared,options);await access(options);createCurrentFilmExportDirectory(root,assembly.projectId,assembly.jobId,outDir);return prepared;
}
/** This whitelist intentionally excludes private route/capture bodies, source
 * catalogs, retained paths, casting snapshots and arbitrary clip properties. */
export function currentFilmMixedProvenance(prepared:PreparedCurrentFilmMixedAssembly,clock:CurrentFilmMixedAssemblyClock):CurrentFilmMixedProvenance {
  return manifest(prepared.assembly,clock,prepared.degradedShots);
}
function manifest(assembly:CurrentFilmMixedAssembly,clock:CurrentFilmMixedAssemblyClock,degradedShots:string[]):CurrentFilmMixedProvenance {
  return {spec:"hv-provenance/3.0",projectId:assembly.projectId,jobId:assembly.jobId,jobPlanRevision:assembly.jobPlanRevision,materializationRevision:assembly.materializationRevision,checkpointRevision:assembly.checkpointRevision,
    documentRevision:assembly.documentRevision,targetRevision:assembly.targetRevision,clockRevision:clock.revision,videoSha256:clock.video.sha256,
    shots:assembly.slots.map((slot,index)=>{const original=slot.originalRecord,span=clock.spans[index]!;
      return {ordinal:slot.target.ordinal,logicalShotId:slot.target.logicalShotId,renderId:slot.target.renderId,inputRevision:slot.target.inputRevision,kind:slot.execution.kind,
        original:{jobId:original.jobId,shotId:original.shotId,inputRevision:original.inputHash,recordRevision:original.revision,captureRevision:slot.execution.captureRevision},
        adoptionRevision:slot.execution.kind==="reused"?slot.execution.adoptionRevision:null,provider:original.clip.provider,model:original.clip.model,seed:original.clip.seed,fingerprint:original.clip.fingerprint,
        startFrame:span.startFrame,endFrame:span.endFrame,recordedPictureRevision:original.clip.picturePerformance?.revision??null,targetPictureRevision:slot.target.pictureIntent?.revision??null,
        recordedSpeechRevision:original.clip.speech?hash(original.clip.speech):null,degraded:degradedShots.includes(slot.target.renderId)};}),
    assembledAt:"1970-01-01T00:00:00.000Z",credentials:{type:"c2pa-style",issuer:"hollywood-video-app",claim:`AI-generated video; content credentials sha256:${clock.video.sha256}`}};
}
/** Restore can reproduce the public whitelist without rendering or reading media.
 * Continuity outcomes are supplied from the separately retained worker result. */
export function createCurrentFilmMixedProvenance(context:CurrentFilmMixedCheckpointContext,checkpoint:CurrentFilmMixedCheckpoint,clock:CurrentFilmMixedAssemblyClock,degradedShots:string[]=[]):CurrentFilmMixedProvenance {
  if(!editValidationKey({context,checkpoint,clock,degradedShots},256*1024**2))fail("Retain bounded portable mixed provenance inputs.");
  const input=structuredClone({context,checkpoint,clock,degradedShots}),checked=validateCurrentFilmMixedAssemblyClock(input.context,input.checkpoint,input.clock),assembly=resolveCurrentFilmMixedAssembly(input.context,input.checkpoint);
  return manifest(assembly,checked,degradedTargets(assembly,input.degradedShots));
}
export function validateCurrentFilmMixedProvenance(raw:unknown,context:CurrentFilmMixedCheckpointContext,checkpoint:CurrentFilmMixedCheckpoint,clock:CurrentFilmMixedAssemblyClock,degradedShots:string[]=[]):CurrentFilmMixedProvenance {
  if(!editValidationKey(raw,4*1024**2))fail("Retain bounded portable public mixed provenance.");
  const expected=createCurrentFilmMixedProvenance(context,checkpoint,clock,degradedShots);
  if(hash(raw)!==hash(expected))fail("The public mixed provenance differs from its exact target, original performance or measured clock.");
  return expected;
}
