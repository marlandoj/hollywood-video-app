import type {Project} from "./index";
import {TIERS,type Job} from "../../queue/src/index";
import {parseFountain} from "../../parser/src/index";
import {charactersForScene,currentCasting} from "../../planner/src/casting";
import {filmPlan,inSequence} from "../../planner/src/sequences";
import {appearingIdentities,identityLocks,lockDrift,type LockDrift,type ShotIdentityLock} from "../../planner/src/identity-locks";

export interface IdentityLockRender {
  jobId:string;stage:"animatic"|"final";completedAt:string|null;castingVersion:number;
  /** True when every character the render showed was rendered from its current lock (or is unlocked, as it was). */
  current:boolean;drift:LockDrift[];
  shots:{shotId:string;sceneNumber:number;locks:ShotIdentityLock[]}[];
}
export interface IdentityLockSequence {
  /** The sequence's number in the feature's split; null for a reel or a short, which renders whole. */
  number:number|null;firstScene:number;lastScene:number;
  /** Rendered, but no rough cut of it was made from the current locks: the rule after a lock changes. */
  needsRoughCut:boolean;
  /** What the newest rough cut showed from a lock that has since changed; empty when none has. */
  drift:LockDrift[];
  renders:IdentityLockRender[];
}

/**
 * The shots a finished film render showed, with the characters each one showed, read from the job's
 * own record: its recorded shot renders, and the cast snapshot it was admitted with. The same function
 * (`charactersForScene` over that snapshot) names the characters the render's shots were cast with, so
 * the locks listed are the ones its provenance names per shot.
 */
function renderedShots(job:Job){
  const parsed=parseFountain(job.scriptText),planned=inSequence(filmPlan(parsed,job.direction,TIERS[job.tier].maxShots,job.sequence),job.sequence);
  const recorded=job.output?.shotRenders?.map(record=>record.shotId),shots=recorded?planned.filter(shot=>recorded.includes(shot.id)):planned;
  return shots.map(shot=>({shotId:shot.id,sceneNumber:shot.sceneIndex+1,characters:job.casting?charactersForScene(job.casting,shot.sceneIndex,parsed):[]}));
}
/** A film's own rough cut or final: not a take group, a character sheet, a screenplay preview or a current-film render. */
const filmRender=(job:Job)=>(job.stage==="animatic"||job.stage==="final")&&job.status==="done"&&!job.shotTakes&&!job.characterSheet&&!job.livingScript&&!job.currentFilm;

/**
 * HV-017-17: identity across sequences, at the desk.
 *
 * `GET /api/projects/:projectId/identity-locks`, owner only, as every desk read. The cast's current
 * locks, and per sequence (or the whole film, for a reel or a short) each finished rough cut and final
 * with, per shot, the locks its render used. A sequence rendered from a lock that has changed since is
 * reported `needsRoughCut` until it has a rough cut of the current locks -- the style bible's rule.
 */
export async function identityLockRead(project:Project,jobs:Job[]):Promise<{status:number;body:unknown}>{
  const casting=currentCasting(project.id,project.castingHistory),script=project.versions.latest();
  const plan=project.format==="feature"?project.sequences:undefined;
  // A sequence's renders are those of its number under the current split, as `GET /spend` and the style bible read them.
  const groups=plan?plan.sequences.map((sequence,index)=>({number:index+1 as number|null,firstScene:sequence.firstScene,lastScene:sequence.lastScene}))
    :[{number:null,firstScene:1,lastScene:Math.max(1,parseFountain(script?.text??"").scenes.length)}];
  const renders=jobs.filter(filmRender).sort((a,b)=>(a.completedAt??"").localeCompare(b.completedAt??""));
  const sequences:IdentityLockSequence[]=groups.map(group=>{
    const own=renders.filter(job=>plan?job.sequence?.planRevision===plan.revision&&job.sequence.number===group.number:!job.sequence).map(job=>{
      const shots=renderedShots(job),drift=lockDrift(appearingIdentities(shots),casting);
      return {jobId:job.id,stage:job.stage as "animatic"|"final",completedAt:job.completedAt??null,castingVersion:job.casting?.version??0,current:!drift.length,drift,
        shots:shots.map(shot=>({shotId:shot.shotId,sceneNumber:shot.sceneNumber,locks:identityLocks(shot.characters)}))};
    });
    const roughCuts=own.filter(render=>render.stage==="animatic");
    return {number:group.number,firstScene:group.firstScene,lastScene:group.lastScene,needsRoughCut:own.length>0&&!roughCuts.some(render=>render.current),
      drift:roughCuts.at(-1)?.drift??[],renders:own};
  });
  return {status:200,body:{schema:"hv-identity-locks/1",format:project.format??null,castingVersion:casting.version,locks:identityLocks(casting.characters),sequences}};
}
