import type {Job} from "../../queue/src/index";
import type {Project,PersistedProject} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {assertDialogueAccess,assertDialoguePermissions,dialogueBaseline} from "./dialogue-jobs";
import {dialogueSource} from "./dialogue-replacement";
import {assertLipSyncPlayback,retainLipSyncSource} from "./lipsync";
import {assertSoundPermission,validateSoundOutput} from "./sound-jobs";

export class DialogueSelectionConflict extends Error {}
export interface OutputBinding {jobId:string;outputRevision:string}
export interface DialogueSelection extends OutputBinding {version:number;sourceJobId:string;sourceRevision:string;at:string;revision:string}
export interface DialogueSelections {version:number;entries:DialogueSelection[]}
export const emptyDialogueSelections=():DialogueSelections=>({version:0,entries:[]});
const id=(v:unknown)=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
export function outputRevision(job:Job):string {if(!job.output)throw new DialogueSelectionConflict("This cut has no retained output.");return contentHash(job.output);}
export function validateOutputBinding(value:OutputBinding):OutputBinding{
  if(!value||Object.keys(value).sort().join(",")!=="jobId,outputRevision"||!id(value.jobId)||!digest(value.outputRevision))throw new Error("Invalid retained output binding.");return structuredClone(value);
}
export function validateDialogueSelections(value:DialogueSelections):DialogueSelections{
  if(!value||Object.keys(value).sort().join(",")!=="entries,version"||!Array.isArray(value.entries)||value.entries.length>1000||value.version!==value.entries.length)throw new Error("Invalid dialogue selection history.");
  let at=-Infinity;
  for(const [index,entry]of value.entries.entries()){
    if(!entry||Object.keys(entry).sort().join(",")!=="at,jobId,outputRevision,revision,sourceJobId,sourceRevision,version"||entry.version!==index+1||!id(entry.sourceJobId)||!id(entry.jobId)||!digest(entry.sourceRevision)||!digest(entry.outputRevision)||!Number.isFinite(Date.parse(entry.at))||Date.parse(entry.at)<at)throw new Error("Invalid dialogue selection event.");
    const {revision,...data}=entry;if(revision!==contentHash(data))throw new Error("Dialogue selection history changed.");at=Date.parse(entry.at);
  }
  return structuredClone(value);
}
export function dialogueIdentity(job:Job,now=Date.now()):{sourceJobId:string;sourceRevision:string}{
  if(job.soundMix){validateSoundOutput(job,job.output!);return dialogueIdentity(job.soundMix.source.base,Date.parse(job.soundMix.source.base.completedAt!));}
  if(job.lipSync){const source=retainLipSyncSource(job,now);return {sourceJobId:source.film.id,sourceRevision:source.dialogue.plan.sourceRevision};}
  if(job.stage==="dialogue-replacement"){const baseline=dialogueBaseline(job,now);return {sourceJobId:baseline.sourceJobId,sourceRevision:baseline.sourceRevision};}
  return {sourceJobId:job.id,sourceRevision:dialogueSource(job,now).revision};
}
export function assertSelectedOutput(job:Job|undefined,project:Project|PersistedProject|undefined|null,binding:OutputBinding,now=Date.now()):asserts job is Job{
  validateOutputBinding(binding);
  if(!job||!project||job.projectId!==project.id||job.id!==binding.jobId||job.status!=="done"||!job.output||!Number.isFinite(Date.parse(job.linkExpiresAt??""))||Date.parse(job.linkExpiresAt!)<=now||Date.parse(project.deleteAfter)<=now||outputRevision(job)!==binding.outputRevision)throw new DialogueSelectionConflict("This selected cut is unavailable, expired or changed. Choose another retained version.");
  if(job.stage==="dialogue-replacement")assertDialogueAccess(job.dialogueReplacement!.source,project,now,dialogueBaseline(job,now));
  else if(job.soundMix){validateSoundOutput(job,job.output);assertSoundPermission(job.soundMix,project,now);}
  else if(job.lipSync)assertLipSyncPlayback(job,project,now);
  else if(!["animatic","final"].includes(job.stage))throw new DialogueSelectionConflict("Choose a completed film or dialogue version.");
  else assertDialoguePermissions(job,project,now);
}
export function selectDialogueOutput(history:DialogueSelections,job:Job,project:Project|PersistedProject,sourceJobId:string,expectedVersion:number,expectedOutputRevision:string,now=Date.now()):DialogueSelections{
  validateDialogueSelections(history);
  if(expectedVersion!==history.version)throw new DialogueSelectionConflict("The chosen version changed in another window. Refresh versions and try again.");
  if(history.version>=1000)throw new DialogueSelectionConflict("This project has reached its retained selection history limit.");
  assertSelectedOutput(job,project,{jobId:job.id,outputRevision:expectedOutputRevision},now);
  if(job.lipSync&&job.lipSyncReviews?.entries.at(-1)?.decision!=="accept")throw new DialogueSelectionConflict("Save an accepted quality review before choosing this lip-sync export.");
  const identity=dialogueIdentity(job,now);if(identity.sourceJobId!==sourceJobId)throw new DialogueSelectionConflict("Choose a version from the same original picture cut.");
  if(job.stage!=="dialogue-replacement"&&!job.lipSync&&!job.soundMix)assertDialogueAccess(job,project,now);
  const data={version:history.version+1,...identity,jobId:job.id,outputRevision:expectedOutputRevision,at:new Date(Math.max(now,Date.parse(history.entries.at(-1)?.at??"")||0)).toISOString()};
  return {version:data.version,entries:[...history.entries,{...data,revision:contentHash(data)}]};
}
