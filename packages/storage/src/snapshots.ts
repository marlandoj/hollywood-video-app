import {validateGraphicLibrary} from "../../planner/src/graphic-library";
import {validateGraphicJob,validateGraphicOutput} from "../../planner/src/graphic-jobs";
import {sourcePlan} from "../../planner/src/scene-cuts";
import {validateDialogueSelections,validateOutputBinding,outputRevision,dialogueIdentity} from "../../planner/src/dialogue-selection";
import {validateAudioTake,validateAudioTakeOutput} from "../../planner/src/audio-jobs";
import {validateStoredAudioAttempt,storedAudioAttempt,type StoredAudioAttempt} from "./audio-ledger";
import {validateStoredLipSyncAttempt,storedLipSyncAttempt,type StoredLipSyncAttempt} from "./lipsync-ledger";
import {validateLipSyncJob,validateLipSyncPrepared,validateLipSyncOutput,validateLipSyncReviews} from "../../planner/src/lipsync";
import {validateLipSyncIntent} from "../../generator/src/sync-lipsync";
import {validateAudioIntent} from "../../generator/src/cartesia-audio";
import {retainedDialogueTime,validateDialogueJob,validateDialogueOutput} from "../../planner/src/dialogue-jobs";
import {assertShotTakeContext,assertTakeCatalog,shotTakeShots} from "../../planner/src/takes";
import {validateMotionStudies} from "../../planner/src/motion-studies";
import {assertSpeechInput,validateReusePlan,validateRenderRecord,renderShots,renderInputHash,assertRenderedOrigin} from "../../planner/src/shot-reuse";
import {validateShotExecutionInventoryMetadata,validateShotExecutionOutput} from "../../planner/src/shot-execution-inventory";
import {snapshotUsesCurrentScreenplay,snapshotUsesCurrentFilmSources,validateCurrentScreenplayRecovery} from "./current-screenplay-snapshots";
import {isTakeStage,generationStage} from "../../planner/src/render-stage";
import {assertFrameAnchorCatalog} from "../../planner/src/frame-anchors";
import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { isReviewPermission } from "../../api/src/review-capability";
import {validateSoundLibrary} from "../../planner/src/sound-assets";
import {emptyEditLibrary,validateEditLibrary} from "../../planner/src/edit-library";
import {validateProjectAssemblyLibrary} from "../../planner/src/edit-assembly-parent";
import {emptyLivingScriptProposals,validateProjectLivingScriptProposals} from "../../planner/src/living-script-proposals";
import {emptyLivingScriptAcceptances,validateProjectLivingScriptAcceptances} from "../../planner/src/living-script-acceptance-library";
import {validateLivingScriptJob,validateLivingScriptOutput,createLivingScriptPreviewReview,assertLivingScriptPreviewApproval,assertLivingScriptIdempotency} from "../../planner/src/living-script-job-context";
import {validateEditAssemblyJob} from "../../planner/src/edit-assembly-job-context";
import {validateEditAssemblyOutput} from "../../planner/src/edit-assembly-jobs";
import {editHistoryUsesComposite} from "../../planner/src/edit-history";
import {validateEditJob,validateEditOutput,editPerformanceReceipts,bindOriginalEditSource,assertEditBindingAvailable} from "../../planner/src/edit-jobs";
import {validateSoundJob,validateSoundOutput} from "../../planner/src/sound-jobs";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PersistedProject, PersistedState, ReviewLink } from "../../api/src/index";
import type { BudgetReservation, CostEvent, ReviewItem } from "../../operator/src/index";
import type { Job } from "../../queue/src/index";
import { artifactKey } from "./artifacts";
import { StudioDatabase } from "./database";
import { MAX_REFERENCE_ASSETS, validateReference } from "../../planner/src/references";
import { validateCasting,assertPictureDirections,directCast,castingSnapshot } from "../../planner/src/casting";
import { contentHash } from "../../generator/src/capabilities";
import { validateCharacterSheet } from "../../planner/src/sheets";
import { MAX_ACTOR_SHARES, validateActorShare } from "../../planner/src/actor-library";
import {validateDirection,directShots,directionSnapshot} from "../../planner/src/direction";
import {parseFountain} from "../../parser/src/index";
import {TIERS} from "../../queue/src/index";
import {assertArchiveDocument,STATE_SNAPSHOT_SCHEMAS,type StateSnapshotSchema} from "./archive-schema";

export interface StateSnapshot {
  schema: StateSnapshotSchema; projects: PersistedState; jobs: Job[];
  ledger: {events: CostEvent[]; reservations: BudgetReservation[]; audioAttempts?:StoredAudioAttempt[];lipSyncAttempts?:StoredLipSyncAttempt[]}; reviews: ReviewItem[];
}
const FILES = ["state/projects.json", "queue/jobs.json", "state/cost-ledger.json", "state/operator-review-queue.json"] as const;
export function snapshotUsesComposite(projects:PersistedState,jobs:Job[]):boolean{
  return projects.projects.some(project=>project.editLibrary?.sequences.some(sequence=>editHistoryUsesComposite(sequence.history)))||jobs.some(job=>[job.pictureEdit,job.editCheckpoint?.editorial?.plan,job.output?.editorial?.plan].some(plan=>editHistoryUsesComposite(plan?.sequence.history)));
}
export function snapshotUsesAssemblies(projects:PersistedState,jobs:Job[]=[]):boolean{
  return projects.projects.some(project=>{const library=project.assemblyLibrary;if(library===undefined)return false;if(!library||!Array.isArray(library.proposals)||!Array.isArray(library.assemblies))throw new Error("Invalid assembly recovery collections.");return Boolean(library.proposals.length||library.assemblies.length);})||jobs.some(job=>job.stage==="assembly-edit"||job.assemblyEdit!==undefined||job.assemblyCheckpoint!==undefined||job.output?.assembly!==undefined);
}
export function snapshotUsesLivingScript(projects:PersistedState):boolean{
  return projects.projects.some(project=>{const library=project.livingScriptProposals;if(library===undefined)return false;if(!library||!Array.isArray(library.proposals)||!Number.isSafeInteger(library.version)||library.version<0)throw new Error("Invalid screenplay proposal recovery collections.");return Boolean(library.version||library.proposals.length);});
}
export function snapshotUsesLivingScriptAcceptances(projects:PersistedState):boolean{
  return projects.projects.some(project=>{const library=project.livingScriptAcceptances;if(library===undefined)return false;if(!library||!Array.isArray(library.records)||!Number.isSafeInteger(library.version)||library.version<0)throw new Error("Invalid linked screenplay acceptance recovery collections.");return Boolean(library.version||library.records.length);});
}
/** Walk retained receipts as well as queue rows: an old nested original may itself be a
 * pending render. Descriptor inspection prevents hidden markers and accessor execution. */
function pendingSnapshotContexts(projects:PersistedState,jobs:Job[]):{jobs:Job[];reviews:object[]}{
  const pending:Job[]=[],reviews:object[]=[],seen=new Set<object>(),active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(!value||typeof value!=="object")return;
    if(depth>180||active.has(value))throw new Error("Invalid recursive pending recovery metadata.");if(seen.has(value))return;seen.add(value);active.add(value);
    for(const key of Reflect.ownKeys(value)){
      const field=Object.getOwnPropertyDescriptor(value,key)!;
      if(!Object.hasOwn(field,"value"))throw new Error("Recovery metadata cannot contain accessors.");
      if(key==="livingScript"&&field.value!==undefined)pending.push(value as Job);
      if(key==="livingScriptReview"&&field.value!==undefined)reviews.push(value);
      visit(field.value,depth+1);
    }active.delete(value);
  };visit(projects,0);visit(jobs,0);return {jobs:pending,reviews};
}
export function snapshotLivingScriptJobs(projects:PersistedState,jobs:Job[]):Job[]{return pendingSnapshotContexts(projects,jobs).jobs;}
export function snapshotUsesLivingScriptJobs(projects:PersistedState,jobs:Job[]):boolean{const contexts=pendingSnapshotContexts(projects,jobs);return Boolean(contexts.jobs.length||contexts.reviews.length);}
/** Capture markers may occur only in private owning jobs, including independently retained
 * originals. Walk every branch and receipt, rather than only current timeline sources. */
function executionSnapshotContexts(projects:PersistedState,jobs:Job[]):{jobs:Job[];outputs:Set<object>;captures:Set<object>}{
  const found=new Set<Job>(),outputs=new Set<object>(),captures=new Set<object>(),seen=new Set<object>(),active=new Set<object>();let nodes=0;
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>5000000||depth>180)throw new Error("Execution recovery metadata exceeds its traversal limit.");if(!value||typeof value!=="object")return;
    if(active.has(value))throw new Error("Invalid recursive execution recovery metadata.");if(seen.has(value))return;seen.add(value);active.add(value);
    for(const key of Reflect.ownKeys(value)){
      const field=Object.getOwnPropertyDescriptor(value,key)!;if(!Object.hasOwn(field,"value"))throw new Error("Execution recovery metadata cannot contain accessors.");
      if(key==="executionCheckpoints"&&field.value!==undefined)found.add(value as Job);
      if(key==="shotExecutions"&&field.value!==undefined)outputs.add(value);
      if(key==="schema"&&field.value==="hv-shot-execution-capture/1")captures.add(value);
      if(key==="output"&&field.value&&typeof field.value==="object"){
        const marker=Object.getOwnPropertyDescriptor(field.value,"shotExecutions");if(marker&&!Object.hasOwn(marker,"value"))throw new Error("Execution recovery metadata cannot contain accessors.");
        if(marker?.value!==undefined)found.add(value as Job);
      }
      visit(field.value,depth+1);
    }active.delete(value);
  };visit(projects,0);visit(jobs,0);return {jobs:[...found],outputs,captures};
}
export function snapshotUsesShotExecutions(projects:PersistedState,jobs:Job[]):boolean{const contexts=executionSnapshotContexts(projects,jobs);return Boolean(contexts.jobs.length||contexts.outputs.size||contexts.captures.size);}
function validateExecutionRecovery(projects:PersistedState,jobs:Job[],currentFilmCaptures:Set<object>):void{
  const contexts=executionSnapshotContexts(projects,jobs),allowedOutputs=new Set<object>(),allowedCaptures=new Set<object>(currentFilmCaptures),identities=new Map<string,string>();
  for(const job of contexts.jobs){
    if(!projects.projects.some(project=>project.id===job.projectId)||!identifier(job.id)||!["animatic","final"].includes(job.stage)||job.characterSheet||job.shotTakes
      ||!["done","failed","cancelled"].includes(job.status)||!date(job.startedAt)||!Number.isSafeInteger(job.checkpointShots)||job.checkpointShots<0||!Number.isSafeInteger(job.checkpointFrame)||job.checkpointFrame<0||job.checkpointShots===0&&job.checkpointFrame!==0)throw new Error("Private execution recovery requires a drained owning film and exact checkpoint.");
    validateShotExecutionInventoryMetadata(job.executionCheckpoints!,job);
    if(job.output){validateShotExecutionOutput(job,job.output);allowedOutputs.add(job.output);}else if(job.status==="done")throw new Error("Completed execution recovery lost its output.");
    for(const row of [...job.executionCheckpoints!,...(job.output?.shotExecutions??[])])if(row.capture)allowedCaptures.add(row.capture);
    const key=job.projectId+":"+job.id,digest=contentHash({checkpointShots:job.checkpointShots,checkpointFrame:job.checkpointFrame,inventory:job.executionCheckpoints,output:job.output?.shotExecutions??null});
    if(identities.has(key)&&identities.get(key)!==digest)throw new Error("Retained execution job identities disagree.");identities.set(key,digest);
  }
  if([...contexts.outputs].some(output=>!allowedOutputs.has(output))||[...contexts.captures].some(capture=>!allowedCaptures.has(capture)))throw new Error("Private execution evidence belongs only to its owning job inventory.");
}
function validatePendingRecovery(projects:PersistedState,jobs:Job[]):void{
  const contexts=pendingSnapshotContexts(projects,jobs),all=new Map<string,Job>(),queueJobs=new Map(jobs.map(job=>[job.id,job])),projectMap=new Map(projects.projects.map(project=>[project.id,project]));
  for(const job of contexts.jobs){
    validateLivingScriptJob(job);if(job.output)validateLivingScriptOutput(job,job.output);
    if(!["done","failed","cancelled"].includes(job.status)||job.status==="done"&&!job.output)throw new Error("Retain drained pending jobs and their completed output.");
    const project=projectMap.get(job.projectId),proposal=job.livingScript!.proposal;
    if(!project?.livingScriptProposals?.proposals.some(saved=>saved.revision===proposal.revision&&contentHash(saved)===contentHash(proposal)))throw new Error("Pending generation lost its exact saved screenplay proposal.");
    const before=proposal.request.patch.before;
    if(!project.versions.some(version=>version.version===before.version&&version.text===before.text))throw new Error("Pending generation lost its exact original screenplay version.");
    const carrier=queueJobs.get(job.livingScript!.binding.owner.jobId);
    if(carrier)assertEditBindingAvailable(job.livingScript!.binding,carrier,Date.parse(job.livingScript!.createdAt));
    const queueJob=queueJobs.get(job.id);
    if(queueJob)assertLivingScriptIdempotency(job,queueJob);
    const previous=all.get(job.id);
    if(previous&&contentHash({plan:previous.livingScript,output:previous.output??null,completedAt:previous.completedAt,linkExpiresAt:previous.linkExpiresAt,projectId:previous.projectId})!==contentHash({plan:job.livingScript,output:job.output??null,completedAt:job.completedAt,linkExpiresAt:job.linkExpiresAt,projectId:job.projectId}))throw new Error("Retained pending job identities disagree.");
    all.set(job.id,job);
  }
  // Prefer the queue row when retained: a nested completed copy cannot override it.
  for(const job of jobs)all.set(job.id,job);
  const allowedReviews=new Set<object>();
  for(const project of projects.projects)for(const approval of project.animaticApprovals??[]){
    const preview=all.get(approval.animaticJobId);
    if(approval.livingScriptReview===undefined){if(preview?.livingScript)throw new Error("A pending preview decision lost its exact completed media review.");continue;}allowedReviews.add(approval);
    if(!preview||preview.projectId!==project.id)throw new Error("Pending preview approval lost its saved owning job.");
    const review=createLivingScriptPreviewReview(preview),cast=preview.casting??castingSnapshot(project.id,0,[],0),direction=preview.direction??directionSnapshot(project.id,0,[],0),at=Date.parse(approval.at);
    if(contentHash(approval.livingScriptReview)!==contentHash(review)||approval.scriptVersion!==preview.scriptVersion||approval.takeRevision!==undefined
      ||!["approved","changes_requested"].includes(approval.decision)||!Number.isSafeInteger(at)||at<0||new Date(at).toISOString()!==approval.at||at<Date.parse(preview.completedAt!)||at>=Date.parse(preview.linkExpiresAt!)
      ||approval.castingVersion!==cast.version||approval.castingRevision!==cast.revision||approval.directionVersion!==direction.version||approval.directionRevision!==direction.revision)throw new Error("The saved pending preview decision changed its exact media, settings or historical time.");
  }
  if(contexts.reviews.some(review=>!allowedReviews.has(review)))throw new Error("Pending preview reviews belong only to saved animatic decisions.");
  for(const job of [...jobs,...contexts.jobs])if(job.stage==="final"){
    const preview=all.get(job.animaticJobId??""),project=projectMap.get(job.projectId),approval=project?.animaticApprovals.find(approval=>approval.animaticJobId===job.animaticJobId&&approval.at===job.animaticApprovedAt);
    if(job.livingScript||preview?.livingScript||approval?.livingScriptReview)assertLivingScriptPreviewApproval(job,preview,approval,Date.parse(job.animaticApprovedAt??""));
  }
}
/** Empty defaults do not promote legacy state or change its serialized payload. */
export function stateSnapshotSchema(projects:PersistedState,jobs:Job[],lipSync=false):StateSnapshot["schema"]{
  return snapshotUsesCurrentFilmSources(projects,jobs)?"hv-state/13":snapshotUsesCurrentScreenplay(projects,jobs)?"hv-state/12":snapshotUsesShotExecutions(projects,jobs)?"hv-state/11":snapshotUsesLivingScriptJobs(projects,jobs)?"hv-state/10":snapshotUsesLivingScriptAcceptances(projects)?"hv-state/9":snapshotUsesLivingScript(projects)?"hv-state/8":snapshotUsesAssemblies(projects,jobs)?"hv-state/7":snapshotUsesComposite(projects,jobs)?"hv-state/6":projects.projects.some(p=>p.graphicLibrary!==undefined)||jobs.some(j=>j.graphicRender)?"hv-state/5":projects.projects.some(p=>p.editLibrary!==undefined)||jobs.some(j=>j.pictureEdit)?"hv-state/4":projects.projects.some(p=>p.soundLibrary!==undefined)||jobs.some(j=>j.soundMix)?"hv-state/3":lipSync?"hv-state/2":"hv-state/1";
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const identifier = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const finite = (value: unknown, max = 1e12): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error("duplicate " + label + " in snapshot");
}
/**
 * How far ahead of the validating host's clock a takedown record may be dated.
 *
 * A takedown cannot have happened in the future, but the host validating a
 * snapshot is not necessarily the host that recorded it, so a strict `> now`
 * would refuse a legitimate record over a few seconds of clock difference. An
 * hour is far more skew than any deployment should have and far less than any
 * useful retention extension.
 */
export const TAKEDOWN_CLOCK_SKEW_MS = 3600_000;

export function validateSnapshot(value: StateSnapshot, now = Date.now()): StateSnapshot {
  if (!(STATE_SNAPSHOT_SCHEMAS as readonly string[]).includes(value.schema) || value.projects?.version !== 1 || !Array.isArray(value.projects.projects)
    || !Array.isArray(value.projects.reviewLinks) || !Array.isArray(value.projects.takenDown) || !Array.isArray(value.projects.takedownLog)
    || !Array.isArray(value.jobs) || !Array.isArray(value.ledger?.events) || !Array.isArray(value.ledger.reservations)
    || !Array.isArray(value.reviews)) throw new Error("unsupported state snapshot");
  if(value.schema!=="hv-state/13"&&snapshotUsesCurrentFilmSources(value.projects,value.jobs))throw new Error("Retained current-film source recovery requires state schema 13.");
  if(!["hv-state/12","hv-state/13"].includes(value.schema)&&snapshotUsesCurrentScreenplay(value.projects,value.jobs))throw new Error("Current screenplay recovery requires state schema 12.");
  const currentFilmCaptures=validateCurrentScreenplayRecovery(value.projects,value.jobs);
  if(!["hv-state/11","hv-state/12","hv-state/13"].includes(value.schema)&&snapshotUsesShotExecutions(value.projects,value.jobs))throw new Error("Worker execution recovery requires state schema 11.");
  if(!["hv-state/10","hv-state/11","hv-state/12","hv-state/13"].includes(value.schema)&&snapshotUsesLivingScriptJobs(value.projects,value.jobs))throw new Error("Pending screenplay jobs and preview reviews require state schema 10.");
  if(!["hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13"].includes(value.schema)&&snapshotUsesLivingScriptAcceptances(value.projects))throw new Error("Linked screenplay acceptance recovery requires state schema 9; older readers must not discard the accepted versions, cut or exact replay ledger.");
  if(!["hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13"].includes(value.schema)&&snapshotUsesLivingScript(value.projects))throw new Error("Living screenplay proposal recovery requires state schema 8; older readers must not discard frozen originals or reviewed impact.");
  if(!["hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13"].includes(value.schema)&&snapshotUsesAssemblies(value.projects,value.jobs))throw new Error("Alternate assembly recovery requires state schema 7; older readers must not discard frozen parents, proposals or accepted versions.");
  if(value.schema==="hv-state/1"&&(value.ledger.lipSyncAttempts!==undefined||value.jobs.some(j=>j.stage==="lip-sync"||j.lipSync||j.lipSyncPrepared||j.lipSyncCheckpoint||j.output?.lipSync)||value.ledger.events.some(e=>e.stage==="lip-sync"||(e as CostEvent&{lipSyncBilling?:unknown}).lipSyncBilling)||value.ledger.reservations.some(r=>r.stage==="lip-sync")))throw new Error("Lip-sync recovery requires state schema 2; older readers must not discard its accounting.");
  if (value.projects.projects.length > 100_000 || value.jobs.length > 1_000_000 || value.ledger.events.length > 10_000_000) throw new Error("state snapshot exceeds its record limit");
  if(!["hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13"].includes(value.schema)&&(value.projects.projects.some(p=>p.soundLibrary!==undefined)||value.jobs.some(j=>j.soundMix||j.soundCheckpoint||j.output?.sound||j.stage==="sound-mix")))throw new Error("Sound recovery requires state schema 3; older readers must not discard its recording and rights records.");
  if(!["hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13"].includes(value.schema)&&(value.projects.projects.some(p=>p.editLibrary!==undefined)||value.jobs.some(j=>j.pictureEdit||j.editCheckpoint||j.output?.editorial||j.stage==="picture-edit")))throw new Error("Editorial recovery requires state schema 4; older readers must not discard sequences, branches or source receipts.");
  if(!["hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13"].includes(value.schema)&&snapshotUsesComposite(value.projects,value.jobs))throw new Error("Authored mask and matte recovery requires state schema 6; older readers must not discard effect branches.");
  const frozenSources=value.projects.projects.flatMap(project=>{
    const proposals=validateProjectLivingScriptProposals(project.livingScriptProposals===undefined?emptyLivingScriptProposals(project.id):project.livingScriptProposals,project.id,project.versions);
    const acceptances=validateProjectLivingScriptAcceptances(project.livingScriptAcceptances===undefined?emptyLivingScriptAcceptances(project.id):project.livingScriptAcceptances,proposals,{projectId:project.id,versions:project.versions,editorial:project.editLibrary===undefined?emptyEditLibrary():project.editLibrary});
    return [...proposals.proposals.flatMap(proposal=>proposal.editorial.sources),...acceptances.records.flatMap(record=>[...record.request.recutInput.library.sources,record.request.recutInput.generated]),...(project.currentScreenplay?.origin?[project.currentScreenplay.origin.request.source]:[])];
  });
  const graphicSources=[...value.projects.projects.flatMap(p=>p.editLibrary?.sources.map(s=>s.job)??[]),...frozenSources.map(s=>s.job),...value.jobs.flatMap(j=>(j.pictureEdit??j.assemblyEdit)?.bindings.map(b=>b.source.job)??[])].filter(j=>j.graphicRender);
  if(!["hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10","hv-state/11","hv-state/12","hv-state/13"].includes(value.schema)&&(graphicSources.length||value.projects.projects.some(p=>p.graphicLibrary!==undefined)||value.jobs.some(j=>j.graphicRender||j.graphicCheckpoint||j.graphicOutput||j.graphicProgress||j.stage==="motion-graphic")))throw new Error("Graphic recovery requires state schema 5; older readers must not discard owned graphics.");
  for (const project of value.projects.projects) {
    if (!identifier(project.id) || !date(project.createdAt) || !date(project.deleteAfter) || !Array.isArray(project.versions)
      || !Array.isArray(project.animaticApprovals) || !Array.isArray(project.operatorExtensions)
      || (project.rightsAttestedAt !== null && !date(project.rightsAttestedAt))) throw new Error("invalid project snapshot");
    let previous = 0;
    if(project.dialogueSelections!==undefined)validateDialogueSelections(project.dialogueSelections);
    if(project.motionStudies!==undefined)validateMotionStudies(project.motionStudies,project.id,project.referenceAssets??[]);
    if(project.directionHistory!==undefined) {
      if(!Array.isArray(project.directionHistory)||project.directionHistory.length>100)throw new Error("invalid direction history");
      let version=0;for(const entry of project.directionHistory){validateDirection(entry,project.id);for(const shot of entry.entries)assertFrameAnchorCatalog(shot.settings.frameAnchors,project.id,project.referenceAssets??[]);if(entry.version<=version)throw new Error("invalid direction revision order");version=entry.version;}
    }
    if(project.actorShares!==undefined) {
      if(!Array.isArray(project.actorShares)||project.actorShares.length>MAX_ACTOR_SHARES)throw new Error("invalid actor shares");
      unique(project.actorShares.map(share=>share.id),"actor share");
      for(const share of project.actorShares) {
        validateActorShare(share,project.id);
        for(const asset of share.character.references??[])if(!project.referenceAssets?.some(value=>contentHash(value)===contentHash(asset)))throw new Error("shared actor reference is absent from the project catalog");
      }
    }
    if(project.soundLibrary!==undefined)validateSoundLibrary(project.soundLibrary,project.id);
    if(project.editLibrary!==undefined)validateEditLibrary(project.editLibrary,project.id);
    if(project.assemblyLibrary!==undefined)validateProjectAssemblyLibrary(project.assemblyLibrary,project.id,project.editLibrary??emptyEditLibrary());
    if(project.graphicLibrary!==undefined)validateGraphicLibrary(project.graphicLibrary,project.id);
    if (project.referenceAssets !== undefined) {
      if (!Array.isArray(project.referenceAssets) || project.referenceAssets.length > MAX_REFERENCE_ASSETS) throw new Error("invalid reference catalog");
      for (const reference of project.referenceAssets) validateReference(reference,project.id);
      unique(project.referenceAssets.map(reference => reference.id),"reference");
    }
    for (const cast of project.castingHistory ?? []) {
      validateCasting(cast,project.id);
      for (const character of cast.characters) for (const reference of character.references ?? [])
        if (!project.referenceAssets?.some(asset => contentHash(asset) === contentHash(reference))) throw new Error("cast reference is absent from the project catalog");
    }
    for (const version of project.versions) {
      if (!Number.isSafeInteger(version.version) || version.version <= previous || !text(version.text, 200_000)) throw new Error("invalid screenplay version");
      previous = version.version;
    }
    for (const approval of project.animaticApprovals) if (!identifier(approval.animaticJobId)
      || !Number.isSafeInteger(approval.scriptVersion) || !["approved", "changes_requested"].includes(approval.decision)
      || !date(approval.at) || !text(approval.note, 2000) || (approval.takeRevision!==undefined&&!/^[a-f0-9]{64}$/.test(approval.takeRevision))) throw new Error("invalid animatic decision");
  }
  validatePendingRecovery(value.projects,value.jobs);
  validateExecutionRecovery(value.projects,value.jobs,currentFilmCaptures);
  unique(value.projects.projects.map(project => project.id), "project");
  unique(value.projects.takenDown, "takedown");
  const projectIds = new Set(value.projects.projects.map(project => project.id));
  for (const id of value.projects.takenDown) if (!identifier(id) || projectIds.has(id)) throw new Error("invalid project tombstone");
  for (const link of value.projects.reviewLinks) if (!text(link.token, 4096) || !identifier(link.projectId)
    || !projectIds.has(link.projectId) || !isReviewPermission(link.permission) || !Number.isSafeInteger(link.views)
    || link.views < 0 || typeof link.revoked !== "boolean") throw new Error("invalid review link");
  unique(value.projects.reviewLinks.map(link => link.token), "review link");
  // `date()` is `Number.isFinite(Date.parse(...))` and `text()` is a length
  // bound, so before this a record could say `reason: ""` and `at: "1970"` and
  // be accepted -- and a record dated in the future was accepted too, which
  // matters because `delete_after` is derived from `at`: `2099-01-01` bought a
  // seventy-three-year extension of the tombstone. The check moved the
  // fabrication out of the code and into whatever an operator types, so the
  // record has to be plausible and not merely present.
  for (const event of value.projects.takedownLog) {
    if (!identifier(event.projectId) || !date(event.at) || !text(event.reason,2000)) throw new Error("invalid takedown history");
    if (!event.reason.trim()) throw new Error("takedown record for " + event.projectId + " has no reason");
    if (Date.parse(event.at) > now + TAKEDOWN_CLOCK_SKEW_MS) throw new Error("takedown record for " + event.projectId + " is dated in the future: " + event.at);
  }
  // The two halves of a takedown record have to agree, because nothing else
  // makes them. `takenDown` says a project is tombstoned; `takedownLog` says
  // when and why. A tombstone with no entry used to be accepted here and then
  // completed at import time with `new Date().toISOString()` and the reason
  // "takedown" -- so a restore asserted that a takedown performed months ago
  // happened at the moment of the restore, and the next export re-emitted the
  // invented values as the record. A snapshot that cannot say when a takedown
  // happened is refused instead, at the point an operator can still fix the
  // file.
  unique(value.projects.takedownLog.map(event => event.projectId), "takedown record");
  const tombstones = new Set(value.projects.takenDown);
  const recorded = new Set(value.projects.takedownLog.map(event => event.projectId));
  const missing = value.projects.takenDown.filter(id => !recorded.has(id));
  if (missing.length) throw new Error("takedown records are missing for " + missing.length + " tombstoned project(s): " + missing.join(", "));
  const orphaned = value.projects.takedownLog.map(event => event.projectId).filter(id => !tombstones.has(id));
  if (orphaned.length) throw new Error("takedown records name " + orphaned.length + " project(s) that are not tombstoned: " + orphaned.join(", "));
  for (const item of value.reviews) if (!identifier(item.projectId) || !text(item.shotId,256) || !finite(item.score,1)
    || !date(item.queuedAt) || typeof item.resolved !== "boolean") throw new Error("invalid operator review");
  for (const job of value.jobs) {
    validateGraphicJob(job);if(job.graphicRender){if(job.checkpointShots!==0||job.checkpointFrame!==(job.graphicCheckpoint?job.totalFrames:0))throw new Error("Invalid graphic checkpoint progress.");if(job.graphicCheckpoint)validateGraphicOutput(job,job.graphicCheckpoint);if(job.graphicOutput){validateGraphicOutput(job,job.graphicOutput);if(!job.graphicCheckpoint||contentHash(job.graphicOutput)!==contentHash(job.graphicCheckpoint))throw new Error("Completed graphic differs from its checkpoint.");}if(job.status==="done"&&!job.graphicOutput)throw new Error("Completed graphic has no output.");}
    validateLipSyncJob(job);
    if(job.lipSync){
      if(job.checkpointShots!==0||job.checkpointFrame!==(job.lipSyncCheckpoint?job.totalFrames:0))throw new Error("Invalid lip-sync checkpoint progress.");
      if(job.lipSyncPrepared)validateLipSyncPrepared(job,job.lipSyncPrepared);
      if(job.lipSyncCheckpoint)validateLipSyncOutput(job,job.lipSyncCheckpoint);
      if(job.output){validateLipSyncOutput(job,job.output);if(contentHash(job.output)!==contentHash(job.lipSyncCheckpoint))throw new Error("Completed lip-sync differs from its checkpoint.");}
      if(job.status==="done"&&!job.output)throw new Error("Completed lip-sync has no output.");
      if(job.lipSyncReviews)validateLipSyncReviews(job.lipSyncReviews,job.output?contentHash(job.output):undefined);
    }
    validateAudioTake(job);
    validateSoundJob(job);
    if(job.soundMix){if(job.checkpointShots!==0||job.checkpointFrame!==(job.soundCheckpoint?job.totalFrames:0)||job.costUsd!==0||job.cost)throw new Error("Invalid provider-free sound job progress or cost.");if(job.soundCheckpoint)validateSoundOutput(job,job.soundCheckpoint);if(job.output){validateSoundOutput(job,job.output);if(contentHash(job.output)!==contentHash(job.soundCheckpoint))throw new Error("Completed sound differs from its checkpoint.");}if(job.status==="done"&&!job.output)throw new Error("Completed sound has no output.");}
    validateEditJob(job);if(job.pictureEdit){if(job.checkpointShots!==0||job.checkpointFrame!==(job.editCheckpoint?job.totalFrames:0)||job.costUsd!==0||job.cost)throw new Error("Invalid provider-free editorial job progress or cost.");if(job.editCheckpoint)validateEditOutput(job,job.editCheckpoint);if(job.output){validateEditOutput(job,job.output);if(!job.editCheckpoint||contentHash(job.output)!==contentHash(job.editCheckpoint))throw new Error("Completed editorial media differs from its checkpoint.");}if(job.status==="done"&&!job.output)throw new Error("Completed editorial job has no output.");}
    validateEditAssemblyJob(job);if(job.assemblyEdit){if(job.checkpointShots!==0||job.checkpointFrame!==(job.assemblyCheckpoint?job.totalFrames:0))throw new Error("Invalid assembly checkpoint progress.");if(job.assemblyCheckpoint)validateEditAssemblyOutput(job,job.assemblyCheckpoint);if(job.output){validateEditAssemblyOutput(job,job.output);if(!job.assemblyCheckpoint||contentHash(job.output)!==contentHash(job.assemblyCheckpoint))throw new Error("Completed assembly media differs from its checkpoint.");}if(job.status==="done"&&!job.output)throw new Error("Completed assembly job has no output.");}
    if(job.audioTake){
      if(job.checkpointShots!==0||job.checkpointFrame!==0)throw new Error("Audio auditions cannot contain video progress.");
      if(job.audioCheckpoint)validateAudioTakeOutput(job,job.audioCheckpoint);
      if(job.audioOutput){validateAudioTakeOutput(job,job.audioOutput);if(contentHash(job.audioOutput)!==contentHash(job.audioCheckpoint))throw new Error("Completed audio differs from its checkpoint.");}
      if(job.status==="done"&&!job.audioOutput)throw new Error("Completed audition has no media.");
    }
    const renderedAt=job.dialogueReplacement?retainedDialogueTime(job):Date.parse(job.startedAt??job.completedAt??job.rightsAttestedAt??"");
    validateDialogueJob(job,renderedAt);
    if(job.stage==="dialogue-replacement"&&(job.checkpointShots!==0||job.checkpointFrame!==(job.dialogueCheckpoint?job.totalFrames:0)))throw new Error("Invalid dialogue checkpoint progress.");
    if(job.dialogueCheckpoint)validateDialogueOutput(job,job.dialogueCheckpoint,renderedAt);
    if(job.output?.dialogue||job.stage==="dialogue-replacement"&&job.output){validateDialogueOutput(job,job.output!,renderedAt);if(contentHash(job.output)!==contentHash(job.dialogueCheckpoint))throw new Error("Completed dialogue differs from its retained checkpoint.");}
    if(job.stage==="dialogue-replacement"&&job.status==="done"&&!job.output)throw new Error("Completed dialogue has no media output.");
    if(job.shotReuse)validateReusePlan(job.shotReuse,job,renderedAt);
    if(job.output?.shotRenders){const shots=renderShots(job,renderedAt);if(job.output.shotRenders.length!==shots.length||new Set(job.output.shotRenders.map(r=>r.shotId)).size!==shots.length)throw new Error("Saved shot renders do not cover the film.");
      for(const [index,record]of job.output.shotRenders.entries()){validateRenderRecord(record,job);assertSpeechInput(record,shots[index]!);assertRenderedOrigin(record,job);if(record.shotId!==shots[index]!.id||record.inputHash!==renderInputHash(job,shots[index]!))throw new Error("Saved shot render inputs changed.");}
    }
    if(isTakeStage(job.stage)!==Boolean(job.shotTakes))throw new Error("invalid take group job snapshot");
    if(job.shotTakes){
      if(!job.casting||!job.direction||job.shotTakes.maxShots!==TIERS[job.tier].maxShots||job.shotTakes.projectId!==job.projectId)throw new Error("take group is missing its source context");
      assertShotTakeContext(job.shotTakes,job.casting,parseFountain(job.scriptText),job.direction,job.scriptVersion);
      assertTakeCatalog(job.shotTakes,value.projects.projects.find(p=>p.id===job.projectId)?.referenceAssets??[]);
      if(job.status==="done"){
        const clips=job.output?.takeClips;if(!Array.isArray(clips)||clips.length!==job.shotTakes.takes.length)throw new Error("completed take group is missing its exports");
        for(const [index,clip]of clips.entries()){
          const take=job.shotTakes.takes[index]!;
          if(clip.id!==take.id||clip.label!==take.label||clip.seed!==take.seed||!/^[a-f0-9]{64}$/.test(clip.sha256)||!finite(clip.durationSec,600)||clip.durationSec<.1||!finite(clip.costUsd)
            ||!["preview","video","storyboard","synthetic"].includes(clip.mode)||(job.stage==="take-preview"&&clip.mode==="video")||(job.stage==="take-final"&&clip.mode==="preview"))throw new Error("invalid completed take export");
        }
      }
    }else if(job.output?.takeClips!==undefined)throw new Error("film job contains take exports");
    const directedEntries=job.currentFilm?job.currentFilm.materialization.slots.map(slot=>({source:{id:slot.renderId},settings:slot.shot.direction!})):(job.shotTakes?job.shotTakes.takes.map(take=>({source:{id:take.id},settings:take.settings})):job.direction?.entries??[]);
    const directedPaths=directedEntries.filter(entry=>entry.settings?.cameraPath),pathRenders=job.output?.cameraPathRenders;
    if((job.status==="done"&&directedPaths.length)||pathRenders!==undefined){
      if(!Array.isArray(pathRenders)||pathRenders.length!==directedPaths.length||new Set(pathRenders.map(r=>r.shotId)).size!==pathRenders.length)throw new Error("invalid camera path render provenance");
      for(const render of pathRenders){const entry=directedPaths.find(e=>e.source.id===render.shotId),duration=job.output?.takeClips?.find(c=>c.id===render.shotId)?.durationSec;
        if(!entry||render.mode!=="screen-space"||contentHash(render.keyframes)!==contentHash(entry.settings.cameraPath!.keyframes)||!Number.isInteger(render.outputFrames)||render.outputFrames<2||render.outputFrames>18000
          ||(duration!==undefined&&render.outputFrames!==Math.round(duration*30))||(entry.settings.durationFrames!==null&&render.outputFrames!==entry.settings.durationFrames))throw new Error("invalid camera path render provenance");
      }
    }
    const anchored=directedEntries.filter(entry=>entry.settings?.frameAnchors),renders=job.output?.frameAnchorRenders;
    if((job.status==="done"&&anchored.length)||renders!==undefined){
      if(!Array.isArray(renders)||renders.length!==anchored.length||new Set(renders.map(r=>r.shotId)).size!==renders.length)throw new Error("invalid frame anchor render provenance");
      for(const render of renders){const anchors=anchored.find(e=>e.source.id===render.shotId)?.settings.frameAnchors;
        if(!anchors||!["native","storyboard"].includes(render.mode)||JSON.stringify(render.positions)!==JSON.stringify(anchors.frames.map(f=>f.at))
          ||(generationStage(job.stage)==="animatic"&&render.mode!=="storyboard")||(generationStage(job.stage)==="final"&&anchors.fallback==="stop"&&render.mode!=="native")
          ||(render.mode==="native"&&render.positions.some(at=>at!==0&&at!==10000)))throw new Error("invalid frame anchor render provenance");
      }
    }
    if(job.direction){validateDirection(job.direction,job.projectId);for(const shot of job.direction.entries)assertFrameAnchorCatalog(shot.settings.frameAnchors,job.projectId,value.projects.projects.find(p=>p.id===job.projectId)?.referenceAssets??[]);if(job.stage==="character-sheet")throw new Error("character sheet contains film direction");if(!job.shotTakes){const parsed=parseFountain(job.scriptText),shots=sourcePlan(parsed,job.direction,7000,TIERS[job.tier].maxShots);assertPictureDirections(shots,parsed,job.casting??castingSnapshot(job.projectId,0,[],0),job.direction);directShots(shots,job.direction);}}
    const pictureStage=["animatic","final","take-preview","take-final"].includes(job.stage),hasPicture=pictureStage&&(job.currentFilm?job.currentFilm.materialization.slots.some(slot=>slot.shot.picturePerformance):job.casting?.characters.some(c=>c.scenePerformances?.some(p=>p.picture))||job.direction?.entries.some(e=>e.settings.picture?.length)||job.shotTakes?.takes.some(t=>t.settings.picture?.length));
    if(job.output?.picturePerformances!==undefined||hasPicture){
      if(!pictureStage)throw new Error("Picture performance receipt belongs to a film or take render.");
      const parsed=parseFountain(job.scriptText),cast=job.casting??castingSnapshot(job.projectId,0,[],0),direction=job.direction??directionSnapshot(job.projectId,0,[],0);
      const shots=job.currentFilm?job.currentFilm.materialization.slots.map(slot=>slot.shot):job.shotTakes?shotTakeShots(job.shotTakes,cast,parsed,direction,job.scriptVersion,renderedAt):directShots(directCast(sourcePlan(parsed,direction,7000,TIERS[job.tier].maxShots),parsed,cast,renderedAt,direction),direction),expected=shots.flatMap(s=>s.picturePerformance?[{shotId:s.id,intent:s.picturePerformance}]:[]);
      if((job.status==="done"||job.output?.picturePerformances!==undefined)&&contentHash(job.output?.picturePerformances??[])!==contentHash(expected))throw new Error("The exported picture performances differ from the admitted scene and shot direction.");
    }
    if((job.stage==="character-sheet")!==Boolean(job.characterSheet))throw new Error("invalid character sheet job snapshot");
    if(job.characterSheet) {
      validateCharacterSheet(job.characterSheet);if(job.characterSheet.castingRevision!==job.casting?.revision)throw new Error("character sheet cast mismatch");
      if(job.status==="done" && (!job.output?.sheetPath || job.output.storyboard?.length!==job.characterSheet.views.length
        || job.output.storyboard.some((frame,index)=>frame.shotId!==job.characterSheet!.views[index]!.id || !/^[a-f0-9]{64}$/.test(frame.sha256??""))))
        throw new Error("completed character sheet is missing its verified views");
    }
    if (job.casting) {
      validateCasting(job.casting,job.projectId);
      for (const character of job.casting.characters) for (const reference of character.references ?? [])
        if (!value.projects.projects.find(project => project.id === job.projectId)?.referenceAssets?.some(asset => contentHash(asset) === contentHash(reference)))
          throw new Error("render reference is absent from the project catalog");
    }
    if (!identifier(job.id) || !identifier(job.projectId) || !text(job.idempotencyKey, 512) || !text(job.scriptText, 200_000)
      || !["animatic","final","character-sheet","take-preview","take-final","dialogue-replacement","audio-take","lip-sync","sound-mix","picture-edit","motion-graphic","assembly-edit"].includes(job.stage) || !["free","elevated"].includes(job.tier)
      || !["done","failed","cancelled"].includes(job.status) || !finite(job.costUsd) || !finite(job.costCapUsd)
      || !Number.isSafeInteger(job.scriptVersion) || !Number.isSafeInteger(job.checkpointShots) || job.checkpointShots < 0
      || !Number.isSafeInteger(job.checkpointFrame) || job.checkpointFrame < 0 || !Array.isArray(job.notifications))
      throw new Error("snapshot requires valid, drained jobs");
    if (job.output) for (const path of [job.output.mp4Path,job.output.hlsPlaylistPath,job.output.captionsPath,job.output.manifestPath,
      ...(job.output.sheetPath ? [job.output.sheetPath] : []),...(job.output.takeClips??[]).flatMap(clip=>[clip.path,clip.hlsPath,clip.posterPath,clip.captionsPath,clip.manifestPath]), ...(job.output.storyboard ?? []).flatMap(frame => [frame.path,...(frame.sourcePath?[frame.sourcePath]:[])])]) artifactKey(path, job.projectId, job.id);
  }
  unique(value.jobs.map(job => job.id), "job");
  for(const job of [...value.jobs,...graphicSources])if(job.graphicRender){const project=value.projects.projects.find(p=>p.id===job.projectId);if(!project?.graphicLibrary?.events.some(e=>e.change.kind==="save"&&e.change.spec.revision===job.graphicRender!.spec.revision))throw new Error("The graphic job lost its saved owner revision.");}
  // Retention may remove an old job. Keep its audit entry and show it as unavailable;
  // any retained job must still match the exact selected output and picture identity.
  const jobsById=new Map(value.jobs.map(job=>[job.id,job]));
  if(value.ledger.events.some(e=>e.stage==="motion-graphic"||jobsById.get(e.jobId??"")?.graphicRender))throw new Error("Graphics cannot carry provider charges.");
  if(value.ledger.events.some(e=>e.stage==="assembly-edit"||jobsById.get(e.jobId??"")?.assemblyEdit))throw new Error("Assembly renders cannot carry provider charges.");
  for(const project of value.projects.projects)for(const entry of project.dialogueSelections?.entries??[]){const job=jobsById.get(entry.jobId);if(!job)continue;
    if(job.projectId!==project.id||job.status!=="done"||outputRevision(job)!==entry.outputRevision||contentHash(dialogueIdentity(job,Date.parse(entry.at)))!==contentHash({sourceJobId:entry.sourceJobId,sourceRevision:entry.sourceRevision}))throw new Error("Selected dialogue output differs from the retained job.");}
  for(const link of value.projects.reviewLinks)if(link.outputBinding){validateOutputBinding(link.outputBinding);const job=jobsById.get(link.outputBinding.jobId);if(job&&(job.projectId!==link.projectId||job.status!=="done"||outputRevision(job)!==link.outputBinding.outputRevision))throw new Error("Review link differs from its retained output.");}
  unique(value.jobs.map(job => job.projectId + ":" + job.idempotencyKey), "job idempotency key");
  for (const event of value.ledger.events) if (!identifier(event.projectId) || !text(event.shotId, 256) || !date(event.at)
    || !text(event.provider, 256) || !text(event.model, 1024) || !finite(event.total_cost_usd, 1e9)
    || !finite(event.gpu_seconds) || !finite(event.prompt_tokens) || !finite(event.output_frames)
    || (event.jobId !== undefined && !identifier(event.jobId))) throw new Error("invalid cost event");
  unique(value.ledger.events.flatMap(event => event.eventId ? [event.eventId] : []), "billing event key");
  const audio=value.ledger.audioAttempts??[];
  if(!Array.isArray(audio)||audio.length>1000000)throw new Error("Invalid audio attempt snapshot.");
  unique(audio.map(a=>a.id),"audio attempt");unique(audio.map(a=>a.jobId),"audio dispatch job");
  for(const attempt of audio){validateStoredAudioAttempt(attempt);const job=jobsById.get(attempt.jobId);
    if(!projectIds.has(attempt.projectId)&&!value.projects.takenDown.includes(attempt.projectId))throw new Error("Audio attempt has no project or tombstone.");
    if(job&&(job.projectId!==attempt.projectId||job.audioTake?.line.revision!==attempt.audio.intent.planRevision||job.audioTake.policy.revision!==attempt.audio.policyRevision))throw new Error("Audio attempt differs from its admitted job.");
    if(job?.audioTake){validateAudioIntent(attempt.audio.intent,job.audioTake.line);const policy=job.audioTake.policy;
      if(attempt.estimatedUsd!==policy.heldUsd||attempt.audio.reservation.priceRevision!==policy.priceRevision||attempt.audio.accountRevision!==policy.accountRevision)throw new Error("Audio liability differs from its admitted policy.");}
    const output=job?.audioOutput??job?.audioCheckpoint;
    if(output&&(output.report.attemptId!==attempt.id||attempt.audio.outcome?.deliveryRevision!==output.report.revision||attempt.audio.outcome?.providerState!=="completed"))throw new Error("Audio checkpoint differs from its provider outcome.");
    const costs=value.ledger.events.filter(e=>e.attemptId===attempt.id);
    if(attempt.audio.invoice){if(costs.length!==1||costs[0]!.total_cost_usd!==attempt.actualUsd||costs[0]!.projectId!==attempt.projectId||costs[0]!.jobId!==attempt.jobId
      ||costs[0]!.provider!==attempt.audio.intent.provider||costs[0]!.model!==attempt.audio.intent.model||costs[0]!.stage!=="audio-take"||costs[0]!.shotId!=="audio-line"
      ||costs[0]!.eventId!=="audio:"+attempt.audio.invoice.documentSha256+":"+attempt.id||costs[0]!.gpu_seconds!==0||costs[0]!.prompt_tokens!==0||costs[0]!.output_frames!==0
      ||contentHash((costs[0] as CostEvent&{audioBilling?:unknown}).audioBilling)!==contentHash(attempt.audio.invoice))throw new Error("Audio invoice allocation differs from its cost event.");}
    else if(costs.length)throw new Error("Audio has costs without settlement evidence.");
  }
  for(const event of value.ledger.events)if((event.stage==="audio-take"||(event as CostEvent&{audioBilling?:unknown}).audioBilling||jobsById.get(event.jobId??"")?.audioTake)&&!audio.some(a=>a.id===event.attemptId&&a.jobId===event.jobId&&a.projectId===event.projectId))throw new Error("Audio cost is missing its attempt provenance.");
  for(const job of value.jobs)if(job.audioTake){
    const attempt=audio.find(a=>a.jobId===job.id);
    if((job.audioOutput||job.audioCheckpoint)&&!attempt)throw new Error("Audio media is missing its accounting provenance.");
    if(job.costUsd!==(attempt?.audio.invoice?.usd??0)||Boolean(job.cost)!==Boolean(attempt?.audio.invoice)||(job.cost&&job.cost.total_cost_usd!==job.costUsd))throw new Error("Audio job cost differs from its invoice allocation.");
  }
  const lipSync=value.ledger.lipSyncAttempts??[];
  if(!Array.isArray(lipSync)||lipSync.length>1000000)throw new Error("Invalid lip-sync attempt snapshot.");
  unique([...audio,...lipSync].map(a=>a.id),"performance attempt");unique([...audio,...lipSync].map(a=>a.jobId),"performance dispatch job");
  for(const a of lipSync){validateStoredLipSyncAttempt(a);const job=jobsById.get(a.jobId);
    if(!projectIds.has(a.projectId)&&!value.projects.takenDown.includes(a.projectId))throw new Error("Lip-sync attempt has no project or tombstone.");
    if(job){if(!job.lipSync||!job.lipSyncPrepared||job.projectId!==a.projectId||job.lipSync.shotId!==a.shotId||job.lipSync.policy.revision!==a.lipSync.policyRevision)throw new Error("Lip-sync attempt differs from its admitted job.");
      validateLipSyncIntent(a.lipSync.intent,job.lipSync,job.lipSyncPrepared);const policy=job.lipSync.policy;
      if(a.estimatedUsd!==policy.heldUsd||a.lipSync.reservation.priceRevision!==policy.priceRevision||a.lipSync.accountRevision!==policy.accountRevision)throw new Error("Lip-sync liability differs from its admitted policy.");}
    const output=job?.output??job?.lipSyncCheckpoint;
    if(output&&(!a.lipSync.receipt?.delivery||contentHash(output.lipSync?.report.delivery)!==contentHash(a.lipSync.receipt.delivery)))throw new Error("Lip-sync checkpoint differs from its provider delivery.");
    const costs=value.ledger.events.filter(e=>e.attemptId===a.id),invoice=a.lipSync.invoice;
    if(invoice){const e=costs[0];if(costs.length!==1||!e||e.total_cost_usd!==a.actualUsd||e.projectId!==a.projectId||e.jobId!==a.jobId||e.provider!==a.lipSync.intent.provider||e.model!==a.lipSync.intent.model||e.stage!=="lip-sync"||e.shotId!==a.shotId||e.eventId!=="lipsync:"+invoice.documentSha256+":"+a.id||e.gpu_seconds!==0||e.prompt_tokens!==0||e.output_frames!==0||contentHash((e as CostEvent&{lipSyncBilling?:unknown}).lipSyncBilling)!==contentHash(invoice))throw new Error("Lip-sync invoice differs from its cost event.");}
    else if(costs.length)throw new Error("Lip-sync has costs without settlement evidence.");
  }
  for(const e of value.ledger.events)if((e.stage==="lip-sync"||(e as CostEvent&{lipSyncBilling?:unknown}).lipSyncBilling||jobsById.get(e.jobId??"")?.lipSync)&&!lipSync.some(a=>a.id===e.attemptId&&a.jobId===e.jobId&&a.projectId===e.projectId))throw new Error("Lip-sync cost is missing its attempt provenance.");
  for(const job of value.jobs)if(job.lipSync){const a=lipSync.find(a=>a.jobId===job.id);
    if((job.output||job.lipSyncCheckpoint)&&!a)throw new Error("Lip-sync media is missing its accounting provenance.");
    if(job.costUsd!==(a?.lipSync.invoice?.usd??0)||Boolean(job.cost)!==Boolean(a?.lipSync.invoice)||(job.cost&&job.cost.total_cost_usd!==job.costUsd))throw new Error("Lip-sync job cost differs from its invoice allocation.");}
  const performanceContexts=[...value.jobs.flatMap(job=>job.pictureEdit||job.assemblyEdit?[{projectId:job.projectId,plan:(job.pictureEdit??job.assemblyEdit)!}]:[]),...frozenSources.map(source=>({projectId:source.job.projectId,plan:{bindings:[bindOriginalEditSource(source)]}}))];
  for(const context of performanceContexts){
    const retained=editPerformanceReceipts(context.plan);
    for(const source of retained.auditions){const attempt=audio.find(a=>a.projectId===context.projectId&&a.jobId===source.jobId),policy=source.take.policy;
      if(!attempt||attempt.id!==source.output.report.attemptId||attempt.audio.policyRevision!==policy.revision||attempt.audio.accountRevision!==policy.accountRevision||attempt.estimatedUsd!==policy.heldUsd||attempt.audio.outcome?.deliveryRevision!==source.output.report.revision||attempt.audio.outcome.providerState!=="completed")throw new Error("Retained editorial voice media is missing its original accounting provenance.");validateAudioIntent(attempt.audio.intent,source.take.line);
    }
    for(const pass of retained.lipSync){const attempt=lipSync.find(a=>a.projectId===context.projectId&&a.jobId===pass.jobId),delivery=attempt?.lipSync.receipt?.delivery;
      if(!attempt||attempt.id!==pass.attemptId||attempt.lipSync.intent.planRevision!==pass.planRevision||!delivery||delivery.generationId!==pass.generationId||delivery.videoSha256!==pass.outputVideoSha256)throw new Error("Retained editorial lip-sync media is missing its original accounting provenance.");
    }
  }
  const attempts=[...audio.map(a=>({...a,stage:"audio-take"})),...lipSync.map(a=>({...a,stage:"lip-sync"}))];
  unique(value.ledger.reservations.map(r=>r.jobId),"performance reservation");
  for(const hold of value.ledger.reservations){const a=attempts.find(a=>a.jobId===hold.jobId);
    if(!a||!["running","unknown"].includes(a.status)||hold.stage!==a.stage||hold.amountUsd!==a.estimatedUsd||hold.remainingUsd!==a.estimatedUsd||!date(hold.createdAt))throw new Error("Resolve other reservations before snapshot migration; performance holds must match unresolved attempts.");}
  for(const a of attempts)if(["running","unknown"].includes(a.status)&&!value.ledger.reservations.some(r=>r.jobId===a.jobId))throw new Error("The unresolved performance liability has no retained hold.");
  return value;
}
export function snapshotSummary(snapshot: StateSnapshot) {
  return {projects: snapshot.projects.projects.length, reviewLinks: snapshot.projects.reviewLinks.length,
    tombstones: snapshot.projects.takenDown.length, jobs: snapshot.jobs.length, costEvents: snapshot.ledger.events.length,
    totalUsd: Number(snapshot.ledger.events.reduce((sum,event) => sum + event.total_cost_usd, 0).toFixed(6)),
    operatorReviews: snapshot.reviews.length};
}
export function readStateSnapshot(directory: string): StateSnapshot {
  const root = resolve(directory);
  const bytes = FILES.map((file,index) => {
    const path = resolve(root,file);
    if (!existsSync(path) && index === 3) return "[]";
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 256 * 1024 ** 2) throw new Error("snapshot state file exceeds 256 MiB or is not a file");
    const data = readFileSync(path);
    return data.toString("utf8");
  });
  const manifestPath = resolve(root,"snapshot.json");
  let schema:StateSnapshot["schema"]="hv-state/1";
  if (existsSync(manifestPath)) {
    // The hv-state/1 manifest contract runs first (docs/PROJECT-ARCHIVE.md "Schema files"), then the version gate and checksums.
    const manifest = assertArchiveDocument("hv-state/1",JSON.parse(readFileSync(manifestPath,"utf8")) as {schema: string; files: Record<string,string>});
    if (!(STATE_SNAPSHOT_SCHEMAS as readonly string[]).includes(manifest.schema)) throw new Error("unknown snapshot schema");
    schema=manifest.schema as StateSnapshot["schema"];
    FILES.forEach((file,index) => { if (manifest.files[file] !== hash(bytes[index]!)) throw new Error("snapshot checksum mismatch"); });
  }
  const cost = JSON.parse(bytes[2]!) as CostEvent[] | StateSnapshot["ledger"];
  return validateSnapshot({schema,projects:JSON.parse(bytes[0]!),jobs:JSON.parse(bytes[1]!),
    ledger:Array.isArray(cost) ? {events:cost,reservations:[]} : cost,reviews:JSON.parse(bytes[3]!)});
}
export function writeStateSnapshot(directory: string, snapshot: StateSnapshot): {directory: string; digest: string} {
  validateSnapshot(snapshot);
  const destination = resolve(directory);
  if (existsSync(destination)) throw new Error("snapshot destination already exists");
  mkdirSync(dirname(destination),{recursive:true});
  const temporary = destination + "." + crypto.randomUUID() + ".pending";
  mkdirSync(temporary,{mode:0o700});
  const files: Record<string,string> = {};
  const parts = [snapshot.projects,snapshot.jobs,snapshot.ledger,snapshot.reviews];
  FILES.forEach((file,index) => {
    const path = resolve(temporary,file), bytes = JSON.stringify(parts[index],null,2) + "\n";
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const descriptor = openSync(path,"wx",0o600);
    try { writeFileSync(descriptor,bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    files[file] = hash(bytes);
  });
  const manifest = JSON.stringify(assertArchiveDocument("hv-state/1",{schema:snapshot.schema,files,summary:snapshotSummary(snapshot)}),null,2) + "\n";
  const descriptor = openSync(resolve(temporary,"snapshot.json"),"wx",0o600);
  try { writeFileSync(descriptor,manifest); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  // Bun/Windows rejects fsync on directory handles with EPERM. File contents are
  // flushed above on every platform; directory-fsync durability is POSIX-only.
  for (const path of process.platform==="win32"?[]:[resolve(temporary,"state"),resolve(temporary,"queue"),temporary]) {
    const descriptor = openSync(path,"r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  renameSync(temporary,destination);
  if(process.platform!=="win32"){
    const parent = openSync(dirname(destination),"r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  return {directory:destination,digest:hash(manifest)};
}
export async function importStateSnapshot(database: StudioDatabase, snapshot: StateSnapshot, monthlyCapUsd: number): Promise<ReturnType<typeof snapshotSummary>> {
  validateSnapshot(snapshot);
  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) throw new Error("invalid operator budget");
  const digest = hash(JSON.stringify(snapshot));
  await database.sql.begin(async transaction => {
    const tx = transaction as unknown as SQL;
    await tx`select pg_advisory_xact_lock(91271, 1)`;
    if ((await tx`select current_user as role`)[0].role !== "hv_admin") throw new Error("state import requires the migration role");
    const count = (await tx`select (select count(*) from hv_projects) + (select count(*) from hv_reviews) +
      (select count(*) from hv_jobs) + (select count(*) from hv_cost_events) + (select count(*) from hv_reservations) +
      (select count(*) from hv_provider_attempts) + (select count(*) from hv_artifacts) + (select count(*) from hv_archives) +
      (select count(*) from hv_operator_reviews) + (select count(*) from hv_workers) + (select count(*) from hv_outbox) as total`)[0].total;
    if (Number(count) !== 0) throw new Error("state import requires an empty destination database");
    for (const project of snapshot.projects.projects) await tx`insert into hv_projects (id,body,created_at,delete_after)
      values (${project.id},${project}::jsonb,${project.createdAt},${project.deleteAfter})`;
    // Driven by the takedown records, not by the tombstone list. `validateSnapshot`
    // holds the two in exact correspondence, so this inserts the same rows either
    // way -- but iterating the records leaves no "tombstone with no record" case
    // to handle, and therefore nothing to complete. The previous loop walked
    // `takenDown` and filled the gaps with `event?.at ?? new Date().toISOString()`
    // and `event?.reason ?? "takedown"`, so a restore wrote a fabricated date and
    // a generic reason into the database with no error, no counter and no log
    // line, derived `delete_after` from the fabricated date -- silently extending
    // the tombstone's retention thirty days past the restore -- and any later
    // export re-emitted the invented values as the record. Guarding that loop
    // would have left the fabrication expressible; removing the loop does not.
    for (const event of snapshot.projects.takedownLog) {
      await tx`insert into hv_projects (id,body,delete_after,taken_down_at,takedown_reason)
        values (${event.projectId},'{}'::jsonb,${new Date(Date.parse(event.at) + 30 * 864e5).toISOString()},${event.at},${event.reason})`;
    }
    for (const link of snapshot.projects.reviewLinks) await tx`insert into hv_reviews (token_hash,project_id,body)
      values (${hash(link.token)},${link.projectId},${link}::jsonb)`;
    for (const original of snapshot.jobs) {
      const job = {...original,claimedBy:null,leaseExpiresAt:null,leaseVersion:original.leaseVersion ?? 0};
      await tx`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body,lease_version)
        values (${job.id},${job.projectId},${job.idempotencyKey},${job.stage},${job.status},${job.tier},${job}::jsonb,${job.leaseVersion})`;
    }
    for (const [index,event] of snapshot.ledger.events.entries()) await tx`insert into hv_cost_events
      (id,event_key,project_id,job_id,attempt_id,stage,provider,total_usd,body,created_at)
      values (${crypto.randomUUID()},${event.eventId ?? "legacy:" + digest + ":" + index},${event.projectId},${event.jobId ?? null},
        ${event.attemptId ?? null},${event.stage ?? null},${event.provider},${event.total_cost_usd},${event}::jsonb,${event.at})`;
    for(const a of snapshot.ledger.audioAttempts??[])await tx`insert into hv_provider_attempts
      (id,project_id,job_id,shot_id,provider,worker_id,lease_version,status,estimated_usd,actual_usd,body,created_at,updated_at)
      values (${a.id},${a.projectId},${a.jobId},'audio-line',${a.audio.intent.provider},${a.workerId},${a.leaseVersion},${a.status},${a.estimatedUsd},${a.actualUsd},${{audio:a.audio}}::jsonb,${a.createdAt},${a.updatedAt})`;
    for(const a of snapshot.ledger.lipSyncAttempts??[])await tx`insert into hv_provider_attempts
      (id,project_id,job_id,shot_id,provider,worker_id,lease_version,status,estimated_usd,actual_usd,request_id,body,created_at,updated_at)
      values (${a.id},${a.projectId},${a.jobId},${a.shotId},${a.lipSync.intent.provider},${a.workerId},${a.leaseVersion},${a.status},${a.estimatedUsd},${a.actualUsd},${a.lipSync.receipt?.remote?.id??null},${{lipSync:a.lipSync}}::jsonb,${a.createdAt},${a.updatedAt})`;
    for(const r of snapshot.ledger.reservations)await tx`insert into hv_reservations (job_id,stage,amount_usd,remaining_usd,body,created_at)
      values (${r.jobId},${r.stage},${r.amountUsd},${r.remainingUsd},${r}::jsonb,${r.createdAt})`;
    for (const item of snapshot.reviews) await tx`insert into hv_operator_reviews (id,project_id,shot_id,body,resolved_at)
      values (${crypto.randomUUID()},${item.projectId},${item.shotId},${item}::jsonb,${item.resolved ? new Date().toISOString() : null})`;
    await tx`insert into hv_budget_accounts (id,monthly_cap_usd) values ('operator',${monthlyCapUsd})
      on conflict (id) do update set monthly_cap_usd = excluded.monthly_cap_usd, updated_at = now()`;
  });
  return snapshotSummary(snapshot);
}
export async function exportStateSnapshot(database: StudioDatabase, projectId?: string): Promise<StateSnapshot> {
  if (projectId !== undefined && !identifier(projectId)) throw new Error("invalid archive project id");
  return await database.sql.begin(async transaction => {
    const tx = transaction as unknown as SQL;
    await tx`set transaction isolation level repeatable read, read only`;
    if ((await tx`select current_user as role`)[0].role !== "hv_admin") throw new Error("state export requires the migration role");
    const pending = await tx`select id from hv_provider_attempts where status in ('running','unknown') and not (body ? 'audio') and not (body ? 'lipSync')
      and (${projectId ?? null}::text is null or project_id = ${projectId ?? null}) limit 1`;
    if (pending.length) throw new Error("provider billing must be reconciled before rollback export");
    const rows = await tx`select id,body,taken_down_at,takedown_reason from hv_projects where (${projectId ?? null}::text is null or id = ${projectId ?? null}) order by id`;
    const projects: PersistedState = {version:1,projects:[],reviewLinks:[],takenDown:[],takedownLog:[]};
    for (const row of rows) {
      if (row.taken_down_at) {
        projects.takenDown.push(row.id);
        // `takedown_reason` is a nullable column, and a NULL here used to make
        // the export emit a record the validator it returns through then
        // refuses -- so a rollback export failed with "invalid takedown
        // history" and an operator mid-incident could not get their state out.
        // `PostgresProjectService` already read this column as
        // `row.takedown_reason ?? ""`, and the two disagreed. Neither an empty
        // string nor a NULL is a reason, so the row is named rather than
        // papered over: this is a database row that cannot say why a project
        // was taken down, and the operator has to look it up.
        if (!row.takedown_reason?.trim()) throw new Error("project " + row.id + " is tombstoned with no recorded reason");
        projects.takedownLog.push({projectId:row.id,at:new Date(row.taken_down_at).toISOString(),reason:row.takedown_reason});
      } else projects.projects.push(row.body as PersistedProject);
    }
    projects.reviewLinks = (await tx`select body from hv_reviews where (${projectId ?? null}::text is null or project_id = ${projectId ?? null}) order by token_hash`).map((row: {body: ReviewLink}) => row.body);
    const jobs = (await tx`select body from hv_jobs where (${projectId ?? null}::text is null or project_id = ${projectId ?? null}) order by queued_at,id`).map((row: {body: Job}) => row.body);
    const events = (await tx`select body,event_key from hv_cost_events where (${projectId ?? null}::text is null or project_id = ${projectId ?? null}) order by created_at,id`)
      .map((row: {body: CostEvent;event_key: string}) => ({...row.body,eventId:row.event_key}));
    const reservations = (await tx`select body from hv_reservations where (${projectId ?? null}::text is null or job_id in (select id from hv_jobs where project_id = ${projectId ?? null}) or job_id in (select job_id from hv_provider_attempts where project_id=${projectId??null})) order by job_id`).map((row: {body: BudgetReservation}) => row.body);
    const reviews = (await tx`select body from hv_operator_reviews where (${projectId ?? null}::text is null or project_id = ${projectId ?? null}) order by id`).map((row: {body: ReviewItem}) => row.body);
    const audioAttempts=(await tx`select * from hv_provider_attempts where body ? 'audio' and (${projectId??null}::text is null or project_id=${projectId??null}) order by created_at,id`).map(storedAudioAttempt);
    const lipSyncAttempts=(await tx`select * from hv_provider_attempts where body ? 'lipSync' and (${projectId??null}::text is null or project_id=${projectId??null}) order by created_at,id`).map(storedLipSyncAttempt);
    const lipSync=lipSyncAttempts.length||jobs.some((j:Job)=>j.lipSync)||events.some((e:CostEvent)=>e.stage==="lip-sync");
    return validateSnapshot({schema:stateSnapshotSchema(projects,jobs,Boolean(lipSync)),projects,jobs,ledger:{events,reservations,...(audioAttempts.length?{audioAttempts}:{}),...(lipSync?{lipSyncAttempts}:{})},reviews});
  }) as StateSnapshot;
}
