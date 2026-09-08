import type {PersistedState} from "../../api/src/index";
import type {Job} from "../../queue/src/index";
import {validateProjectCurrentScreenplay} from "../../planner/src/current-screenplay-library";
import {contentHash as hash} from "../../generator/src/capabilities";
import {validateCurrentFilmJob,validateCurrentFilmOutput,advanceCurrentFilmCheckpoint,createCurrentFilmPreviewReview,assertCurrentFilmPreviewApproval} from "../../planner/src/current-film-job-context";

function walk(input:unknown,visit:(value:object,key:string,valueAtKey:unknown,path:string[])=>void):void {
  const active=new Set<object>();let nodes=0,bytes=0;
  const step=(value:unknown,depth:number,path:string[]):void=>{
    if(++nodes>5000000||depth>220)throw new Error("Current screenplay recovery exceeds its traversal capacity.");
    if(!value||typeof value!=="object")return;
    if(active.has(value))throw new Error("Current screenplay recovery cannot contain cycles.");active.add(value);
    for(const key of Reflect.ownKeys(value)){
      const field=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!Object.hasOwn(field,"value"))throw new Error("Current screenplay recovery cannot contain hidden keys or accessors.");
      bytes+=Buffer.byteLength(key,"utf8");if(typeof field.value==="string")bytes+=Buffer.byteLength(field.value,"utf8");
      if(bytes>512*1024**2)throw new Error("Current screenplay recovery exceeds its byte capacity.");
      const next=[...path,key];visit(value,key,field.value,next);step(field.value,depth+1,next);
    }active.delete(value);
  };step(input,0,[]);
}
function marker(key:string,value:unknown):boolean {
  return ["currentScreenplay","currentFilm","currentFilmCheckpoint","currentFilmReview"].includes(key)&&value!==undefined
    ||key==="schema"&&typeof value==="string"&&(value.startsWith("hv-current-screenplay-")||value.startsWith("hv-current-film-"));
}
/** Includes abandoned branches and retained originals; a nested marker cannot downgrade. */
export function snapshotUsesCurrentScreenplay(projects:PersistedState,jobs:Job[]):boolean {
  let found=false;walk({projects,jobs},(_object,key,value)=>{if(marker(key,value))found=true;});return found;
}
/** Exact object ownership is returned for the separate legacy capture walker. An arbitrary
 * capture nested beside a valid V2 job is never covered by this set. V2 editorial source
 * receipts remain unsupported until their explicit source-clock adapter is implemented. */
export function validateCurrentScreenplayRecovery(projects:PersistedState,jobs:Job[]):Set<object> {
  // Complete descriptor traversal must precede any marker reads below.
  walk({projects,jobs},()=>{});
  const locations=new Set<string>(),captureLocations=new Set<string>(),captures=new Set<object>();
  const librarySchemas=new Set(["hv-current-screenplay-library/1","hv-current-screenplay-origin/1","hv-current-screenplay-state/1","hv-current-screenplay-proposal/1","hv-current-screenplay-acceptance/1","hv-current-screenplay-target/1"]);
  const filmSchemas=new Set([...librarySchemas,"hv-current-film-job/2","hv-current-film-materialization/2","hv-current-film-assembly-request/1","hv-current-film-checkpoint/2","hv-current-film-output/2","hv-current-film-clock/2","hv-current-film-preview-review/2"]);
  const mark=(path:string[])=>locations.add(JSON.stringify(path));
  const register=(root:unknown,allowed:Set<string>,prefix:string[])=>walk(root,(_object,key,value,path)=>{if(key==="schema"&&typeof value==="string"&&allowed.has(value))mark([...prefix,...path]);});
  const projectMap=new Map(projects.projects.map(project=>[project.id,project])),queue=new Map(jobs.map(job=>[job.id,job]));
  for(const [index,project]of projects.projects.entries())if(project.currentScreenplay!==undefined){
    validateProjectCurrentScreenplay(project.currentScreenplay,{projectId:project.id,versions:project.versions});const path=["projects","projects",String(index),"currentScreenplay"];mark(path);
    register(project.currentScreenplay,librarySchemas,path);
  }
  const time=(value:unknown):number=>{if(typeof value!=="string"||!Number.isSafeInteger(Date.parse(value))||Date.parse(value)<0||new Date(value).toISOString()!==value)throw new Error("Retain canonical current-film recovery times.");return Date.parse(value);};
  for(const [index,job]of jobs.entries())if(job.currentFilm!==undefined){
    const plan=validateCurrentFilmJob(job),project=projectMap.get(job.projectId),saved=project?.currentScreenplay;
    if(!saved||saved.projectId!==plan.projectId||saved.version<plan.library.version||hash(saved.origin)!==hash(plan.library.origin)
      ||hash(saved.proposals.slice(0,plan.library.proposals.length))!==hash(plan.library.proposals)||hash(saved.acceptances.slice(0,plan.library.acceptances.length))!==hash(plan.library.acceptances))throw new Error("Current-film recovery lost its exact saved screenplay origin, target or historical events.");
    if(!["done","failed","cancelled"].includes(job.status)||!Number.isSafeInteger(job.checkpointShots)||job.checkpointShots<0||!Number.isSafeInteger(job.checkpointFrame)||job.checkpointFrame<0)throw new Error("Current-film recovery requires a drained owning job and exact prefix.");
    const path=["jobs",String(index)];mark([...path,"currentFilm"]);register(job.currentFilm,filmSchemas,[...path,"currentFilm"]);
    if(job.currentFilmCheckpoint!==undefined){
      time(job.startedAt);advanceCurrentFilmCheckpoint(job,job.currentFilmCheckpoint,job.checkpointShots,job.checkpointFrame);
      mark([...path,"currentFilmCheckpoint"]);register(job.currentFilmCheckpoint,filmSchemas,[...path,"currentFilmCheckpoint"]);
      for(const [rowIndex,row]of job.currentFilmCheckpoint.rows.entries()){captures.add(row.capture);captureLocations.add(JSON.stringify([...path,"currentFilmCheckpoint","rows",String(rowIndex),"capture"]));}
    }else if(job.checkpointShots!==0||job.checkpointFrame!==0)throw new Error("Current-film recovery lost its exact checkpoint prefix.");
    if(job.output){
      if(job.status!=="done")throw new Error("Only a completed current film can own published output.");
      validateCurrentFilmOutput(job,job.output);const completed=time(job.completedAt),started=time(job.startedAt);
      if(completed<started||time(job.linkExpiresAt)<=completed)throw new Error("Current-film recovery lost its completed lifetime.");
      mark([...path,"output","currentFilm"]);register(job.output.currentFilm,filmSchemas,[...path,"output","currentFilm"]);
    }else if(job.status==="done")throw new Error("Completed current-film recovery lost its output.");
  }
  const decisions=new Set<string>();
  for(const [projectIndex,project]of projects.projects.entries())for(const [approvalIndex,approval]of (project.animaticApprovals??[]).entries()){
    const preview=queue.get(approval.animaticJobId);
    if(approval.currentFilmReview===undefined){if(preview?.currentFilm)throw new Error("Current-film preview decision lost its exact completed review.");continue;}
    if(!preview?.currentFilm||preview.projectId!==project.id)throw new Error("Current-film review lost its saved owning preview job.");
    const review=createCurrentFilmPreviewReview(preview),plan=preview.currentFilm,casting=plan.target.state.casting.candidate!,direction=plan.library.origin!.request.baseline.direction,at=time(approval.at),key=project.id+":"+preview.id+":"+approval.at;
    if(decisions.has(key)||hash(approval.currentFilmReview)!==hash(review)||approval.livingScriptReview!==undefined||approval.takeRevision!==undefined
      ||approval.scriptVersion!==preview.scriptVersion||!["approved","changes_requested"].includes(approval.decision)||at<time(preview.completedAt)||at>=time(preview.linkExpiresAt)
      ||approval.castingVersion!==casting.version||approval.castingRevision!==casting.revision||approval.directionVersion!==direction.version||approval.directionRevision!==direction.revision)throw new Error("Current-film preview decision changed its media, settings or historical time.");
    decisions.add(key);const path=["projects","projects",String(projectIndex),"animaticApprovals",String(approvalIndex),"currentFilmReview"];mark(path);register(approval.currentFilmReview,filmSchemas,path);
  }
  for(const job of jobs)if(job.stage==="final"){
    const preview=queue.get(job.animaticJobId??""),project=projectMap.get(job.projectId),approval=project?.animaticApprovals.find(value=>value.animaticJobId===job.animaticJobId&&value.at===job.animaticApprovedAt);
    if(job.currentFilm||preview?.currentFilm||approval?.currentFilmReview)assertCurrentFilmPreviewApproval(job,preview,approval,time(job.startedAt??job.animaticApprovedAt));
  }
  walk({projects,jobs},(_object,key,value,path)=>{
    if(value&&typeof value==="object"&&captures.has(value)&&!captureLocations.has(JSON.stringify(path)))throw new Error("Current-film captures belong only to their exact private checkpoint row.");
    if(!marker(key,value))return;
    if(locations.has(JSON.stringify(path)))return;
    throw new Error("Current screenplay recovery contains an unowned or unsupported runtime marker.");
  });
  return captures;
}
