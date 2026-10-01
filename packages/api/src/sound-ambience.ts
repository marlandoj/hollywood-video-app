/**
 * HV-024-12: the studio's own ambience beds for a retained cut.
 *
 *   GET  /api/projects/:id/ambience/:cutId  the catalogue, and the bed each of the cut's scenes gets
 *   POST /api/projects/:id/ambience/:cutId  {overrides?: {"<scene>": "<preset>"|"none"}}
 *        renders any bed the scenes need that the sound library does not already hold, saves it
 *        there with a rights record that says the studio generated it, and answers the ambience
 *        cues in the shape the sound-mix route takes, to be reviewed and rendered with the rest of
 *        the session. Nothing is queued and nothing is spent here.
 *
 * Cue ids are derived from the cut, so asking again for the same cut and choices answers the same
 * cues, and a bed already in the library is reused rather than rendered again.
 */
import type {Job} from "../../queue/src/index";
import type {Project} from "./index";
import {audioRecord} from "../../planner/src/audio-performances";
import {MAX_SOUND_ASSETS,SoundConflict,soundAssetAvailable,soundFail,soundId,updateSoundLibrary,type SoundAsset,type SoundLibrary} from "../../planner/src/sound-assets";
import {soundBaseFilm,soundBaseFrames} from "../../planner/src/sound-jobs";
import {AMBIENCE_PRESETS,AMBIENCE_RECIPE,ambienceCues,ambiencePreset,ambienceRights,ambienceScenes,type AmbienceAssetRef,type AmbienceScene} from "../../planner/src/sound-ambience";
import {renderAmbience} from "../../generator/src/sound-ambience";
import {normalizeSoundUpload} from "../../generator/src/sound-audio";

export interface AmbienceContext {
  root:string;
  job:(projectId:string,jobId:string)=>Promise<Job|undefined|null>;
  authorize:(token:string)=>Promise<Project|null>;
  saveAsset:(token:string,asset:SoundAsset,expectedVersion:number)=>Promise<SoundLibrary|null>;
  putBlob:(asset:SoundAsset,kind:"original"|"audio",bytes:Buffer)=>Promise<void>;
  /** The server's one-at-a-time sound import slot: true when taken. */
  acquire:()=>boolean;release:()=>void;
}
export class AmbienceBusy extends Error {}

/** The studio's bed for a preset already in the library, recognised by its own label and rights source. */
export function studioAmbienceAsset(library:SoundLibrary,presetId:string):SoundAsset|undefined{
  const preset=ambiencePreset(presetId),source=ambienceRights(preset).source;
  return library.assets.find(asset=>asset.label===preset.label&&asset.rights.source===source&&asset.rights.basis==="original"&&asset.audio.frames===AMBIENCE_RECIPE.loopFrames&&soundAssetAvailable(library,asset));
}

/** The cut's scenes, from the base film's shots in cut order and its screenplay. */
function cutScenes(cut:Job,overrides:unknown):{scenes:AmbienceScene[];totalFrames:number}{
  if(cut.status!=="done"||!cut.output)soundFail("Choose a completed film, dialogue, lip-sync or sound version.");
  const base=cut.soundMix?cut.soundMix.source.base:cut;let totalFrames:number,film:Job;
  try{film=soundBaseFilm(base);totalFrames=soundBaseFrames(base)*1600;}catch{soundFail("Choose a completed film, dialogue, lip-sync or sound version.");}
  const shots=(film.output?.shotRenders??[]).map(shot=>({shotId:shot.shotId,frames:Math.round(shot.clip.durationSec*30)*1600}));
  return {scenes:ambienceScenes(base.scriptText,shots,totalFrames,overrides),totalFrames};
}

export async function handleAmbience(context:AmbienceContext,parts:string[],request:Request,project:Project,token:string,body?:unknown):Promise<{status:number;body:unknown}>{
  if(parts.length!==1)return {status:404,body:{error:"Unknown ambience route."}};
  const cutId=soundId(parts[0]),cut=await context.job(project.id,cutId);if(!cut||cut.projectId!==project.id)return {status:404,body:{error:"Unknown retained cut."}};
  const catalogue=AMBIENCE_PRESETS.map(({id,label,description})=>({id,label,description}));
  if(request.method==="GET"){const {scenes}=cutScenes(cut,{});return {status:200,body:{presets:catalogue,scenes,costUsd:0}};}
  if(request.method!=="POST")return {status:404,body:{error:"Unknown ambience route."}};
  const input=audioRecord(body??{},["overrides"]),{scenes,totalFrames}=cutScenes(cut,input.overrides??{});
  if(!project.rightsAttestedAt)soundFail("Confirm project rights before adding ambience.");
  const needed=[...new Set(scenes.flatMap(scene=>scene.preset?[scene.preset]:[]))];
  const missing=needed.filter(id=>!studioAmbienceAsset(project.soundLibrary,id));
  if(missing.length){
    if(project.soundLibrary.assets.length+missing.length>MAX_SOUND_ASSETS)soundFail("This project has reached its retained sound limit.");
    if(!context.acquire())throw new AmbienceBusy("A recording is being processed. Try again shortly.");
    try{for(const id of missing){
      const current=await context.authorize(token);if(!current?.rightsAttestedAt)throw new SoundConflict("Project permission changed while the ambience was made.");if(studioAmbienceAsset(current.soundLibrary,id))continue;
      const preset=ambiencePreset(id),version=current.soundLibrary.version,access=async()=>{const now=await context.authorize(token);if(!now?.rightsAttestedAt||now.soundLibrary.version!==version)throw new SoundConflict("Project permission or the sound library changed while the ambience was kept.");};
      const wav=await renderAmbience(id,context.root,request.signal),normalized=await normalizeSoundUpload(wav,project.id,preset.label,ambienceRights(preset),context.root,access,request.signal);
      updateSoundLibrary(current.soundLibrary,project.id,version,normalized.asset);await context.putBlob(normalized.asset,"original",wav);await context.putBlob(normalized.asset,"audio",normalized.audio);await access();
      if(!await context.saveAsset(token,normalized.asset,version))throw new SoundConflict("Project permission changed while the ambience was kept.");
    }}finally{context.release();}
  }
  const library=(await context.authorize(token))?.soundLibrary;if(!library)soundFail("Project permission changed while the ambience was kept.");
  const assets=new Map<string,AmbienceAssetRef>();for(const id of needed){const asset=studioAmbienceAsset(library,id);if(!asset)throw new SoundConflict("The "+id+" ambience is no longer in the sound library.");assets.set(id,{id:asset.id,revision:asset.revision,frames:asset.audio.frames});}
  return {status:missing.length?201:200,body:{presets:catalogue,scenes,cues:ambienceCues(scenes,assets,totalFrames,cutId),library,costUsd:0}};
}
