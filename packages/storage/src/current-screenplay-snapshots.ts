import type {PersistedState,PersistedProject} from "../../api/src/index";
import type {Job} from "../../queue/src/index";
import {validateProjectCurrentScreenplay,type CurrentScreenplayLibrary,type CurrentScreenplayState} from "../../planner/src/current-screenplay-library";
import {contentHash as hash} from "../../generator/src/capabilities";
import {currentFilmV2Job,validateCurrentFilmJob,advanceCurrentFilmCheckpoint,assertCurrentFilmPreviewApproval} from "../../planner/src/current-film-job-context";
import {currentFilmRuntimeMode,currentFilmV3Job,validateCurrentFilmRuntimeOutput,createCurrentFilmRuntimePreviewReview,assertCurrentFilmRuntimeHeldInputs} from "../../planner/src/current-film-runtime-context";
import {validateCurrentFilmMixedJob,assertCurrentFilmMixedPreviewApproval} from "../../planner/src/current-film-mixed-job-context";
import {advanceCurrentFilmMixedCheckpoint} from "../../planner/src/current-film-mixed-context";
import {validateCurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {emptyEditLibrary,validateEditLibrary,type EditLibrary} from "../../planner/src/edit-library";
import {validateEditSourceReceipt,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {validateEditJob,validateEditOutput} from "../../planner/src/edit-jobs";
import {validateEditAssemblyJob} from "../../planner/src/edit-assembly-job-context";
import {validateEditAssemblyOutput} from "../../planner/src/edit-assembly-jobs";
import {validateCurrentFilmPreparedProof} from "../../planner/src/current-film-prepared-proof";
import {compileCurrentFilmProofClosure,type CurrentFilmProofContext} from "../../planner/src/current-film-proof-closure";
import {emptyLivingScriptProposals,validateProjectLivingScriptProposals} from "../../planner/src/living-script-proposals";
import {validateProjectLivingScriptAcceptances} from "../../planner/src/living-script-acceptance-library";
import {validateLivingScriptJob} from "../../planner/src/living-script-job-context";
import {validateProjectAssemblyLibrary} from "../../planner/src/edit-assembly-parent";

function walk(input:unknown,visit:(value:object,key:string,valueAtKey:unknown,path:string[])=>void):void {
  const active=new Set<object>();let nodes=0,bytes=0;
  const step=(value:unknown,depth:number,path:string[]):void=>{
    if(++nodes>5000000||depth>220)throw new Error("Current screenplay recovery exceeds its traversal capacity.");
    if(!value||typeof value!=="object")return;
    if(active.has(value))throw new Error("Current screenplay recovery cannot contain cycles.");active.add(value);
    for(const key of Reflect.ownKeys(value)){
      const field=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!Object.hasOwn(field,"value")||!field.enumerable&&!(Array.isArray(value)&&key==="length"))throw new Error("Current screenplay recovery cannot contain hidden keys or accessors.");
      bytes+=Buffer.byteLength(key,"utf8");if(typeof field.value==="string")bytes+=Buffer.byteLength(field.value,"utf8");
      if(bytes>512*1024**2)throw new Error("Current screenplay recovery exceeds its byte capacity.");
      const next=[...path,key];visit(value,key,field.value,next);step(field.value,depth+1,next);
    }active.delete(value);
  };step(input,0,[]);
}
function marker(key:string,value:unknown):boolean {
  return key==="currentFilmOrigins"||key==="currentFilmProof"||["currentScreenplay","currentFilm","currentFilmCheckpoint","currentFilmReview"].includes(key)&&value!==undefined
    ||key==="schema"&&typeof value==="string"&&(value==="hv-edit-source/3"||value==="hv-edit-source/4"||value==="hv-edit-library/2"||value.startsWith("hv-current-screenplay-")||value.startsWith("hv-current-film-"));
}
/** Includes abandoned branches and retained originals; a nested marker cannot downgrade. */
export function snapshotUsesCurrentScreenplay(projects:PersistedState,jobs:Job[]):boolean {
  let found=false;walk({projects,jobs},(_object,key,value)=>{if(marker(key,value))found=true;});return found;
}
export function snapshotUsesCurrentFilmSources(projects:PersistedState,jobs:Job[]):boolean {
  let found=false;walk({projects,jobs},(_object,key,value)=>{if(key==="schema"&&value==="hv-edit-source/3")found=true;});return found;
}
/** Detection precedes proof/schema15 selection and exact ownership validation.
 * A sticky library2 with no remaining /4 sources still requires the new reader. */
export function snapshotUsesCurrentFilmMixedSources(projects:PersistedState,jobs:Job[]):boolean {
  let found=false;walk({projects,jobs},(_object,key,value)=>{
    if(key==="schema"&&(value==="hv-edit-source/4"||value==="hv-edit-library/2"))found=true;
  });return found;
}
/** Even an absent-valued, orphaned or abandoned marker cannot downgrade. */
export function snapshotUsesCurrentFilmProof(projects:PersistedState,jobs:Job[]):boolean {
  let found=false;walk({projects,jobs},(_object,key,value)=>{
    if(key==="currentFilmProof"||key==="schema"&&typeof value==="string"&&/^hv-current-film-(prepared-proof|proof(?:-target|-copies|-closure)?)\/1$/.test(value))found=true;
  });return found;
}
/** Read only after validateCurrentScreenplayRecovery has established each marker's
 * exact owning path. These are retained historical scopes, never new queue jobs. */
export function snapshotCurrentFilmProofContexts(projects:PersistedState,jobs:Job[]):CurrentFilmProofContext[] {
  const contexts:CurrentFilmProofContext[]=[];walk({projects,jobs},(_object,key,value)=>{
    if(key==="currentFilmProof"&&value!==undefined)contexts.push((value as NonNullable<Job["currentFilmProof"]>).specification.frozenContext);
  });return contexts;
}
/** V3 markers select the new recovery schema even in abandoned or malformed
 * positions. Selection is not ownership validation or editable-source support. */
export function snapshotUsesCurrentFilmMixed(projects:PersistedState,jobs:Job[]):boolean {
  let found=false;walk({projects,jobs},(_object,key,value)=>{
    if(key==="currentFilmOrigins"||key==="schema"&&typeof value==="string"&&(
      /^hv-current-film-(job|checkpoint|output|clock|preview-review|assembly-inputs)\/3$/.test(value)
      ||/^hv-current-film-(origins|adoption|retained-execution|execution-projection|reuse-review)\/1$/.test(value)))found=true;
  });return found;
}
/** Exact object ownership is returned for the separate legacy capture walker. An arbitrary
 * capture nested beside a valid V2 job is never covered by this set. Retained source jobs
 * are admitted only in validated library, binding and prepared-copy positions. A retained
 * final still requires its actual saved preview job and historical approval, not a hash. */
export function validateCurrentScreenplayRecovery(projects:PersistedState,jobs:Job[]):Set<object> {
  // Complete descriptor traversal must precede any marker reads below.
  walk({projects,jobs},()=>{});
  const locations=new Set<string>(),captureLocations=new Set<string>(),captures=new Set<object>();
  const librarySchemas=new Set(["hv-current-screenplay-library/1","hv-current-screenplay-origin/1","hv-current-screenplay-state/1","hv-current-screenplay-proposal/1","hv-current-screenplay-acceptance/1","hv-current-screenplay-target/1"]);
  const filmSchemas=new Set([...librarySchemas,"hv-current-film-job/2","hv-current-film-materialization/2","hv-current-film-assembly-request/1","hv-current-film-checkpoint/2","hv-current-film-output/2","hv-current-film-clock/2","hv-current-film-preview-review/2",
    "hv-current-film-job/3","hv-current-film-checkpoint/3","hv-current-film-output/3","hv-current-film-clock/3","hv-current-film-preview-review/3","hv-current-film-origins/1","hv-current-film-adoption/1"]);
  const mark=(path:string[])=>locations.add(JSON.stringify(path));
  const register=(root:unknown,allowed:Set<string>,prefix:string[])=>walk(root,(_object,key,value,path)=>{if(key==="schema"&&typeof value==="string"&&allowed.has(value))mark([...prefix,...path]);});
  const projectMap=new Map(projects.projects.map(project=>[project.id,project]));
  // fullProject exists only for actual top-level persisted projects. The frozen
  // proof projection keeps its existing serialized contract and optional fields.
  type Scope={project:CurrentFilmProofContext["project"];path:string[];fullProject?:PersistedProject};
  const scopes:Scope[]=projects.projects.map((project,index)=>({project,fullProject:project,path:["projects","projects",String(index)]}));
  const contexts:{job:Job;path:string[];scope?:Scope;historicalCarrier?:boolean}[]=jobs.map((job,index)=>({job,path:["jobs",String(index)]}));
  const contextPaths=new Set(contexts.map(context=>JSON.stringify(context.path)));
  const addContext=(value:typeof contexts[number])=>{const key=JSON.stringify(value.path);if(!contextPaths.has(key)){contextPaths.add(key);contexts.push(value);}};
  const source=(receipt:EditSourceReceipt,path:string[],projectId:string,scope?:Scope)=>{
    validateEditSourceReceipt(receipt);if(receipt.job.projectId!==projectId)throw new Error("Retained current-film source belongs to another project.");
    // Legacy receipts can retain pending jobs whose frozen editorial library
    // contains an unselected /4. Process every validated receipt's exact Job;
    // only /3 and /4 introduce source markers owned by this feature walker.
    if(receipt.schema==="hv-edit-source/3"||receipt.schema==="hv-edit-source/4")mark([...path,"schema"]);
    addContext({job:receipt.job,path:[...path,"job"],scope});
  };
  const editorial=(library:EditLibrary,path:string[],projectId:string,scope:Scope|undefined)=>{
    validateEditLibrary(library,projectId);
    if(library.schema==="hv-edit-library/2")mark([...path,"schema"]);
    for(const [index,receipt]of library.sources.entries())source(receipt,[...path,"sources",String(index)],projectId,scope);
  };
  // Call only after the owning complete library or runtime plan has validated.
  // Equal receipts at another path do not own these separately serialized Jobs.
  const stateSources=(state:CurrentScreenplayState,path:string[],projectId:string,scope:Scope|undefined)=>{
    for(const [index,receipt]of state.context.originals.entries())source(receipt,[...path,"context","originals",String(index)],projectId,scope);
  };
  const canonicalSources=(library:CurrentScreenplayLibrary,path:string[],projectId:string,scope:Scope|undefined)=>{
    if(library.origin){
      source(library.origin.request.source,[...path,"origin","request","source"],projectId,scope);
      stateSources(library.origin.state,[...path,"origin","state"],projectId,scope);
    }
    for(const [index,proposal]of library.proposals.entries())if(proposal.candidate)stateSources(proposal.candidate,[...path,"proposals",String(index),"candidate"],projectId,scope);
    for(const [index,acceptance]of library.acceptances.entries())stateSources(acceptance.state,[...path,"acceptances",String(index),"state"],projectId,scope);
  };
  const projectSources=(scope:Scope)=>{
    const {project,path:base,fullProject}=scope;
    if(project.currentScreenplay!==undefined){
      validateProjectCurrentScreenplay(project.currentScreenplay,{projectId:project.id,versions:project.versions});
      canonicalSources(project.currentScreenplay,[...base,"currentScreenplay"],project.id,scope);
    }
    if(fullProject?.editLibrary!==undefined)editorial(fullProject.editLibrary,[...base,"editLibrary"],project.id,scope);
    const proposals=project.livingScriptProposals;
    if(proposals!==undefined){
      validateProjectLivingScriptProposals(proposals,project.id,project.versions);
      for(const [index,proposal]of proposals.proposals.entries())editorial(proposal.editorial,[...base,"livingScriptProposals","proposals",String(index),"editorial"],project.id,scope);
    }
    if(fullProject?.livingScriptAcceptances!==undefined){
      validateProjectLivingScriptAcceptances(fullProject.livingScriptAcceptances,proposals??emptyLivingScriptProposals(project.id),
        {projectId:project.id,versions:project.versions,editorial:fullProject.editLibrary??emptyEditLibrary()});
      for(const [index,record]of fullProject.livingScriptAcceptances.records.entries()){
        const input=record.request.recutInput,path=[...base,"livingScriptAcceptances","records",String(index),"request","recutInput"];
        editorial(input.library,[...path,"library"],project.id,scope);source(input.generated,[...path,"generated"],project.id,scope);
      }
    }
    // Frozen assembly parents contain source/receipt identities, not new receipt
    // bodies. Their validator binds every historical parent to the owned catalog.
    if(fullProject?.assemblyLibrary!==undefined)validateProjectAssemblyLibrary(fullProject.assemblyLibrary,project.id,fullProject.editLibrary??emptyEditLibrary());
  };
  for(const scope of scopes)projectSources(scope);
  for(const context of contexts){
    const {job,path}=context;let scope=context.scope;
    if(currentFilmRuntimeMode(job)==="v3"){
      const mixed=currentFilmV3Job(job);
      if(mixed.currentFilmProof!==undefined){
        validateCurrentFilmPreparedProof(mixed.currentFilmProof,mixed);
        const proof=mixed.currentFilmProof,spec=proof.specification,base=[...path,"currentFilmProof"],frozen=[...base,"specification","frozenContext"];
        const closure=compileCurrentFilmProofClosure(mixed.currentFilm,spec.frozenContext,spec.target),receipts=new Map(closure.receipts.map(row=>[row.receipt.revision,hash(row.receipt)]));
        mark(base);mark([...base,"schema"]);mark([...base,"specification","schema"]);mark([...base,"specification","target","schema"]);
        scope={project:spec.frozenContext.project,path:[...frozen,"project"]};scopes.push(scope);context.scope=scope;
        projectSources(scope);
        const carriers=new Set(spec.carriers.map(row=>row.jobId));
        for(const [index,nested]of spec.frozenContext.jobs.entries())addContext({job:nested,path:[...frozen,"jobs",String(index)],scope,historicalCarrier:carriers.has(nested.id)});
        walk(spec,(_object,key,value,relative)=>{
          if(key!=="schema"||(value!=="hv-edit-source/3"&&value!=="hv-edit-source/4"))return;
          // A nested mixed source owns its own already-sealed proof scope. That
          // scope is processed when its exact receipt job/context is visited;
          // a parent closure cannot grant ownership to unrelated nested bytes.
          if(relative.includes("currentFilmProof"))return;
          const receipt=_object as EditSourceReceipt;if(receipts.get(receipt.revision)!==hash(receipt))throw new Error("Prepared proof contains an unowned retained source.");
          source(receipt,[...base,"specification",...relative.slice(0,-1)],job.projectId,scope);
        });
      }
      for(const [i,origin]of mixed.currentFilm.origins.entries())source(origin.binding.source,[...path,"currentFilm","origins",String(i),"binding","source"],job.projectId,scope);
      canonicalSources(mixed.currentFilm.library,[...path,"currentFilm","library"],job.projectId,scope);
      stateSources(mixed.currentFilm.target.state,[...path,"currentFilm","target","state"],job.projectId,scope);
    }else if(job.currentFilm!==undefined){
      const current=currentFilmV2Job(job); // Complete unchanged V2 envelope first.
      const plan=current.currentFilm;if(!plan)throw new Error("The current-film recovery plan disappeared.");
      canonicalSources(plan.library,[...path,"currentFilm","library"],job.projectId,scope);
      stateSources(plan.target.state,[...path,"currentFilm","target","state"],job.projectId,scope);
    }
    if(job.livingScript!==undefined){
      validateLivingScriptJob(job);
      editorial(job.livingScript.proposal.editorial,[...path,"livingScript","proposal","editorial"],job.projectId,scope);
      source(job.livingScript.binding.source,[...path,"livingScript","binding","source"],job.projectId,scope);
    }
    if(job.pictureEdit){validateEditJob(job);for(const [i,binding]of job.pictureEdit.bindings.entries())source(binding.source,[...path,"pictureEdit","bindings",String(i),"source"],job.projectId,scope);}
    if(job.assemblyEdit){validateEditAssemblyJob(job);for(const [i,binding]of job.assemblyEdit.bindings.entries())source(binding.source,[...path,"assemblyEdit","bindings",String(i),"source"],job.projectId,scope);}
    for(const field of ["output","editCheckpoint","assemblyCheckpoint"] as const){
      const output=job[field];if(!output)continue;
      for(const kind of ["editorial","assembly"] as const){
        const owned=output[kind];if(!owned)continue;
        if(kind==="editorial")validateEditOutput(job,output);else validateEditAssemblyOutput(job,output);
        for(const [i,binding]of owned.plan.bindings.entries())source(binding.source,[...path,field,kind,"plan","bindings",String(i),"source"],job.projectId,scope);
        for(const [i,prepared]of owned.prepared.sources.entries())source(prepared.receipt,[...path,field,kind,"prepared","sources",String(i),"receipt"],job.projectId,scope);
      }
    }
  }
  const queue=new Map<string,Job>();
  const identity=(job:Job)=>({proof:job.currentFilmProof??null,origins:job.currentFilmOrigins??null,checkpoint:job.currentFilmCheckpoint??null,output:job.output??null,checkpointShots:job.checkpointShots,checkpointFrame:job.checkpointFrame,
    journal:job.routeDecisions??[],status:job.status,startedAt:job.startedAt,completedAt:job.completedAt,linkExpiresAt:job.linkExpiresAt});
  for(const {job}of contexts){
    const previous=queue.get(job.id);
    if(previous&&(previous.currentFilm||job.currentFilm)){
      assertCurrentFilmRuntimeHeldInputs(previous,job);
      if(hash(identity(previous))!==hash(identity(job)))throw new Error("Retained current-film recovery changed an owning job context.");
    }
    queue.set(job.id,job);
  }
  for(const {project,path:base}of scopes)if(project.currentScreenplay!==undefined){
    // projectSources validated this exact scope before the worklist expanded.
    const path=[...base,"currentScreenplay"];mark(path);
    register(project.currentScreenplay,librarySchemas,path);
  }
  const time=(value:unknown):number=>{if(typeof value!=="string"||!Number.isSafeInteger(Date.parse(value))||Date.parse(value)<0||new Date(value).toISOString()!==value)throw new Error("Retain canonical current-film recovery times.");return Date.parse(value);};
  for(const {job,path,scope,historicalCarrier}of contexts)if(job.currentFilm!==undefined){
    const mixed=currentFilmRuntimeMode(job)==="v3"?currentFilmV3Job(job):undefined;
    const plan=mixed?validateCurrentFilmMixedJob(mixed):validateCurrentFilmJob(currentFilmV2Job(job)),project=scope?.project??projectMap.get(job.projectId);
    for(const saved of [project?.currentScreenplay,...(jobs.includes(job)&&scope?[projectMap.get(job.projectId)?.currentScreenplay]:[])]){
      if(!saved||saved.projectId!==plan.projectId||saved.version<plan.library.version||hash(saved.origin)!==hash(plan.library.origin)
        ||hash(saved.proposals.slice(0,plan.library.proposals.length))!==hash(plan.library.proposals)||hash(saved.acceptances.slice(0,plan.library.acceptances.length))!==hash(plan.library.acceptances))throw new Error("Current-film recovery lost its exact saved screenplay origin, target or historical events.");
    }
    if(!(historicalCarrier?["queued","running","done","failed","cancelled"]:["done","failed","cancelled"]).includes(job.status)||!Number.isSafeInteger(job.checkpointShots)||job.checkpointShots<0||!Number.isSafeInteger(job.checkpointFrame)||job.checkpointFrame<0)throw new Error("Current-film recovery requires a drained owning job and exact prefix.");
    mark([...path,"currentFilm"]);register(job.currentFilm,filmSchemas,[...path,"currentFilm"]);
    if(mixed?.currentFilmOrigins!==undefined){
      time(mixed.startedAt);validateCurrentFilmOrigins(mixed.currentFilmOrigins,mixed.currentFilm,mixed.id);
      mark([...path,"currentFilmOrigins"]);register(mixed.currentFilmOrigins,filmSchemas,[...path,"currentFilmOrigins"]);
    }
    if(job.currentFilmCheckpoint!==undefined){
      time(job.startedAt);
      if(mixed)advanceCurrentFilmMixedCheckpoint(mixed,mixed.currentFilmCheckpoint!,job.checkpointShots,job.checkpointFrame);
      else {const v2=currentFilmV2Job(job);advanceCurrentFilmCheckpoint(v2,v2.currentFilmCheckpoint!,job.checkpointShots,job.checkpointFrame);}
      mark([...path,"currentFilmCheckpoint"]);register(job.currentFilmCheckpoint,filmSchemas,[...path,"currentFilmCheckpoint"]);
      for(const [rowIndex,row]of job.currentFilmCheckpoint.rows.entries())if("capture" in row){captures.add(row.capture);captureLocations.add(JSON.stringify([...path,"currentFilmCheckpoint","rows",String(rowIndex),"capture"]));}
    }else if(job.checkpointShots!==0||job.checkpointFrame!==0)throw new Error("Current-film recovery lost its exact checkpoint prefix.");
    if(job.output){
      if(job.status!=="done")throw new Error("Only a completed current film can own published output.");
      validateCurrentFilmRuntimeOutput(job,job.output);const completed=time(job.completedAt),started=time(job.startedAt);
      if(completed<started||time(job.linkExpiresAt)<=completed)throw new Error("Current-film recovery lost its completed lifetime.");
      mark([...path,"output","currentFilm"]);register(job.output.currentFilm,filmSchemas,[...path,"output","currentFilm"]);
    }else if(job.status==="done")throw new Error("Completed current-film recovery lost its output.");
  }
  for(const {project,path:base}of scopes){const decisions=new Set<string>();for(const [approvalIndex,approval]of (project.animaticApprovals??[]).entries()){
    const preview=queue.get(approval.animaticJobId);
    if(approval.currentFilmReview===undefined){if(preview?.currentFilm)throw new Error("Current-film preview decision lost its exact completed review.");continue;}
    if(!preview?.currentFilm||preview.projectId!==project.id)throw new Error("Current-film review lost its saved owning preview job.");
    const review=createCurrentFilmRuntimePreviewReview(preview),plan=preview.currentFilm,casting=plan.target.state.casting.candidate!,direction=plan.library.origin!.request.baseline.direction,at=time(approval.at),key=project.id+":"+preview.id+":"+approval.at;
    if(decisions.has(key)||hash(approval.currentFilmReview)!==hash(review)||approval.livingScriptReview!==undefined||approval.takeRevision!==undefined
      ||approval.scriptVersion!==preview.scriptVersion||!["approved","changes_requested"].includes(approval.decision)||at<time(preview.completedAt)||at>=time(preview.linkExpiresAt)
      ||approval.castingVersion!==casting.version||approval.castingRevision!==casting.revision||approval.directionVersion!==direction.version||approval.directionRevision!==direction.revision)throw new Error("Current-film preview decision changed its media, settings or historical time.");
    decisions.add(key);const path=[...base,"animaticApprovals",String(approvalIndex),"currentFilmReview"];mark(path);register(approval.currentFilmReview,filmSchemas,path);
  }}
  for(const {job,scope}of contexts)if(job.stage==="final"){
    const preview=queue.get(job.animaticJobId??""),project=scope?.project??projectMap.get(job.projectId),approval=project?.animaticApprovals.find(value=>value.animaticJobId===job.animaticJobId&&value.at===job.animaticApprovedAt);
    if(currentFilmRuntimeMode(job)==="v3")assertCurrentFilmMixedPreviewApproval(currentFilmV3Job(job),preview,approval,time(job.startedAt??job.animaticApprovedAt));
    else if(job.currentFilm||preview?.currentFilm||approval?.currentFilmReview)assertCurrentFilmPreviewApproval(job,preview,approval,time(job.startedAt??job.animaticApprovedAt));
  }
  walk({projects,jobs},(_object,key,value,path)=>{
    if(value&&typeof value==="object"&&captures.has(value)&&!captureLocations.has(JSON.stringify(path)))throw new Error("Current-film captures belong only to their exact private checkpoint row.");
    if(!marker(key,value))return;
    if(locations.has(JSON.stringify(path)))return;
    throw new Error("Current screenplay recovery contains an unowned or unsupported runtime marker.");
  });
  return captures;
}
