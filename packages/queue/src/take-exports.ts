import {mkdirSync,readdirSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {assembleAsync} from "../../assembler/src/index";
import {animaticCommand} from "../../generator/src/animatic";
import {fileSha256} from "../../generator/src/sheet";
import type {VideoClip} from "../../generator/src/index";
import type {Shot} from "../../planner/src/index";
import type {CastingSnapshot} from "../../planner/src/casting";
import {validateShotTakes} from "../../planner/src/takes";
import {readJsonFile,writeJsonFile} from "./persist";
import type {Job} from "./index";

/** Each take gets a standalone playable export; the group never impersonates a full-film preview. */
/** `assembledAt` is passed in rather than read from a clock here, so the manifest carries the worker's own instant for the job and this function has no way to invent one. */
export async function exportShotTakes(job:Job,clips:VideoClip[],shots:Shot[],artifactRoot:string,outputDirectory:string,size:string,casting:CastingSnapshot,shotSpend:(id:string)=>Promise<number>,assembledAt:string,signal:AbortSignal):Promise<{output:NonNullable<Job["output"]>;paths:string[]}> {
  const plan=validateShotTakes(job.shotTakes!);if(clips.length!==plan.takes.length||shots.length!==clips.length)throw new Error("The take group is missing completed clips.");
  const paths:string[]=[],takeClips:NonNullable<NonNullable<Job["output"]>["takeClips"]>=[],relative=(path:string)=>path.slice(resolve(artifactRoot).length+1).replaceAll("\\","/");
  for(const [index,clip]of clips.entries()){
    signal.throwIfAborted();const take=plan.takes[index]!,shot=shots[index]!,directory=join(outputDirectory,"takes",take.id);mkdirSync(directory,{recursive:true});
    const exported=await assembleAsync([clip],[shot],directory,{assembledAt,fps:30,size,crossfadeSec:0,projectId:job.projectId,casting,signal});
    const poster=join(directory,"poster.png");await animaticCommand(["ffmpeg","-y","-v","error","-i",exported.mp4Path,"-frames:v","1","-threads","1",poster],directory,signal);
    const manifest=readJsonFile<Record<string,unknown>>(exported.manifestPath)!;
    const costUsd=await shotSpend(take.id),mode=clip.frameAnchorControl?.mode==="storyboard"?"storyboard":clip.routing?.selectedCapability.synthetic||clip.provider==="mock"?"synthetic":job.stage==="take-preview"?"preview":"video";
    const provenance={...manifest,shotTake:{schema:"hv-shot-take-render/1",groupRevision:plan.revision,source:plan.source,sourceHash:plan.sourceHash,baseDirectionRevision:plan.directionRevision,
      ...take,mode,durationSec:clip.durationSec,requestedDurationSec:shot.durationSec,costUsd,mp4Sha256:exported.sha256,...(clip.frameAnchorControl?{frameAnchorControl:clip.frameAnchorControl}:{}),...(clip.cameraPathControl?{cameraPathControl:clip.cameraPathControl}:{})}};
    writeJsonFile(exported.manifestPath,provenance);
    paths.push(exported.mp4Path,exported.hlsPlaylistPath,exported.srtPath,exported.vttPath,exported.manifestPath,poster,
      ...readdirSync(dirname(exported.hlsPlaylistPath)).filter(name=>name.endsWith(".ts")).map(name=>join(dirname(exported.hlsPlaylistPath),name)));
    takeClips.push({id:take.id,label:take.label,path:relative(exported.mp4Path),hlsPath:relative(exported.hlsPlaylistPath),posterPath:relative(poster),captionsPath:relative(exported.vttPath),manifestPath:relative(exported.manifestPath),
      durationSec:clip.durationSec,seed:clip.seed,sha256:fileSha256(exported.mp4Path),costUsd,mode});
  }
  const manifestPath=join(outputDirectory,"provenance.json");writeJsonFile(manifestPath,{schema:"hv-shot-take-group-render/1",projectId:job.projectId,jobId:job.id,stage:job.stage,plan,takes:takeClips});paths.push(manifestPath);
  const first=takeClips[0]!;
  return {paths,output:{mp4Path:first.path,hlsPlaylistPath:first.hlsPath,captionsPath:first.captionsPath,manifestPath:relative(manifestPath),takeClips,
    ...(clips.some(c=>c.picturePerformance)?{picturePerformances:clips.flatMap((c,i)=>c.picturePerformance?[{shotId:shots[i]!.id,intent:c.picturePerformance}]:[])}:{}),
    ...(clips.some(c=>c.cameraPathControl)?{cameraPathRenders:clips.flatMap((c,i)=>c.cameraPathControl?[{shotId:shots[i]!.id,...c.cameraPathControl}]:[])}:{}),
    ...(clips.some(c=>c.frameAnchorControl)?{frameAnchorRenders:clips.flatMap((c,i)=>c.frameAnchorControl?[{shotId:shots[i]!.id,mode:c.frameAnchorControl.mode,positions:c.frameAnchorControl.positions}]:[])}:{}),
    storyboard:clips.flatMap((clip,i)=>clip.posterPath?[{shotId:shots[i]!.id,path:relative(clip.posterPath),caption:plan.takes[i]!.label,...(clip.sourcePosterPath?{sourcePath:relative(clip.sourcePosterPath)}:{})}]:[])}};
}
