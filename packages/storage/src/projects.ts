import type {ShotTakePlan} from "../../planner/src/takes";
import type {SQL} from "bun";
import type {Job} from "../../queue/src/index";
import {DialogueSelectionConflict,type OutputBinding} from "../../planner/src/dialogue-selection";
import { createHash } from "node:crypto";
import { ProjectService, type PersistedProject, type PersistedState, type ReviewDecision, type ReviewLink, type ReferenceBatchOptions } from "../../api/src/index";
import { verifyToken } from "../../api/src/tokens";
import type { ReviewPermission } from "../../api/src/review-capability";
import { PostgresRetention } from "./retention";
import { StudioDatabase } from "./database";
import { castingMatches, currentCasting, type CastingSnapshot } from "../../planner/src/casting";
import type { ReferenceAsset } from "../../planner/src/references";
import type {SoundAsset} from "../../planner/src/sound-assets";
import type {EditSourceReceipt} from "../../planner/src/edit-sources";
import type {GraphicChange} from "../../planner/src/graphic-library";
import {assertEditBindingAvailable,bindOriginalEditSource,validateEditBinding,type EditSourceBinding} from "../../planner/src/edit-jobs";
import type {EditSequenceChange} from "../../planner/src/edit-library";
import type {EditAssemblyProposalInput,EditAssemblyProposalRevision} from "../../planner/src/edit-assembly-proposals";
import type {LivingScriptProposalRequest} from "../../planner/src/living-script-proposals";
import type {LivingScriptAcceptanceRequest} from "../../planner/src/living-script-acceptance";
import type {LivingScriptPreviewReview} from "../../planner/src/living-script-job-context";
import {currentFilmRecordedFiles,type CurrentFilmPreviewReview} from "../../planner/src/current-film-job-context";
import type {EditAssemblyCarrier,EditAssemblyExpected,EditAssemblyRevisionExpected} from "../../planner/src/edit-assembly-parent";
import {editFail,editRecord} from "../../planner/src/edit-timeline";
import { verifyActorToken } from "../../api/src/actor-token";
import { ActorShareUnavailable } from "../../planner/src/actor-library";
import {currentDirection,directionMatches,type DirectionSnapshot} from "../../planner/src/direction";

const empty = (): PersistedState => ({ version: 1, projects: [], reviewLinks: [], takenDown: [], takedownLog: [] });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Reuse the existing domain rules while committing each project mutation under a row lock. */
export class PostgresProjectService {
  constructor(readonly database: StudioDatabase) {}
  private projectId(token: string, kind: "project" | "review", now: number): string | null {
    const payload = verifyToken(token, now);
    return payload?.kind === kind ? payload.projectId : null;
  }
  private async state<T>(id: string, write: boolean|((result:T)=>boolean), fn: (service: ProjectService,tx:SQL) => T|Promise<T>): Promise<T> {
    return this.database.forProject(id, async tx => {
      const rows = await tx`select body, taken_down_at, takedown_reason from hv_projects where id = ${id} for update`;
      const row = rows[0];
      const links = await tx`select body from hv_reviews where project_id = ${id}`;
      const snapshot = empty();
      if (row?.taken_down_at) {
        snapshot.takenDown = [id];
        snapshot.takedownLog = [{ projectId: id, at: new Date(row.taken_down_at).toISOString(), reason: row.takedown_reason ?? "" }];
      } else if (row) snapshot.projects = [row.body as PersistedProject];
      snapshot.reviewLinks = links.map((link: { body: ReviewLink }) => link.body);
      const service = ProjectService.fromState(snapshot);
      const result = await fn(service,tx);
      if (!(typeof write==="function"?write(result):write) || !row) return result;
      const next = service.snapshot();
      const project = next.projects[0];
      if (project) {
        await tx`update hv_projects set body = ${project}::jsonb, delete_after = ${project.deleteAfter}, version = version + 1 where id = ${id}`;
      } else if (next.takenDown.includes(id)) {
        const event = next.takedownLog.find(event => event.projectId === id)!;
        await tx`update hv_projects set body = '{}'::jsonb, taken_down_at = ${event.at}, takedown_reason = ${event.reason}, version = version + 1 where id = ${id}`;
      } else {
        await tx`delete from hv_projects where id = ${id}`;
      }
      await tx`delete from hv_reviews where project_id = ${id}`;
      if (project) for (const link of next.reviewLinks) {
        await tx`insert into hv_reviews (token_hash, project_id, body) values (${hash(link.token)}, ${id}, ${link}::jsonb)`;
      }
      return result;
    });
  }
  private async owner<T>(token: string, write: boolean, now: number, fallback: T, fn: (service: ProjectService) => T): Promise<T> {
    const id = this.projectId(token, "project", now);
    return id ? this.state(id, write, fn) : fallback;
  }
  private async reviewer<T>(token: string, write: boolean, now: number, fallback: T, fn: (service: ProjectService) => T): Promise<T> {
    const id = this.projectId(token, "review", now);
    return id ? this.state(id, write, service => service.peekProject(id) ? fn(service) : fallback) : fallback;
  }
  async createAnonymousProject(now = Date.now()) {
    const service = new ProjectService();
    const result = service.createAnonymousProject(now);
    const body = service.snapshot().projects[0]!;
    await this.database.forProject(result.projectId, async tx => {
      await tx`insert into hv_projects (id, body, created_at, delete_after) values (${body.id}, ${body}::jsonb, ${body.createdAt}, ${body.deleteAfter})`;
    });
    return result;
  }
  authorize(token: string, now = Date.now()) { return this.owner(token, false, now, null, service => service.authorize(token, now)); }
  editScript(token: string, text: string, now = Date.now()) { return this.owner(token, true, now, null, service => service.editScript(token, text, now)); }
  saveCharacter(token: string, id: string, input: unknown, expectedVersion: number, now = Date.now()) {
    return this.owner(token, true, now, null, service => service.saveCharacter(token, id, input, expectedVersion, now));
  }
  saveCharacterAudioVoice(token:string,id:string,profile:import("../../planner/src/audio-performances").AudioVoiceProfile|null,expectedVersion:number,now=Date.now()){
    return this.owner(token,true,now,null,service=>service.saveCharacterAudioVoice(token,id,profile,expectedVersion,now));
  }
  saveScenePerformance(token:string,id:string,input:unknown,expectedVersion:number,now=Date.now()){
    return this.owner(token,true,now,null,service=>service.saveScenePerformance(token,id,input,expectedVersion,now));
  }
  saveShotDirection(token:string,shotId:string,input:unknown,expectedVersion:number,expectedScriptVersion:number,sourceHash:string,maxShots=24,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.saveShotDirection(token,shotId,input,expectedVersion,expectedScriptVersion,sourceHash,maxShots,Date.now()));
  }
  reviewSceneCut(token:string,input:unknown,now=Date.now()) {
    return this.owner(token,false,now,null,service=>service.reviewSceneCut(token,input,Date.now()));
  }
  acceptSceneCut(token:string,input:import("../../planner/src/scene-cuts").CutProposal,removeDirectionIds:unknown,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.acceptSceneCut(token,input,removeDirectionIds,Date.now()));
  }
  storeFrameAnchorAsset(token:string,reference:ReferenceAsset,expectedVersion:number,expectedScriptVersion:number,maxShots=24,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.storeFrameAnchorAsset(token,reference,expectedVersion,expectedScriptVersion,maxShots,Date.now()));
  }
  adoptShotTake(token:string,plan:ShotTakePlan,takeId:string,expectedVersion:number,expectedScriptVersion:number,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.adoptShotTake(token,plan,takeId,expectedVersion,expectedScriptVersion,Date.now()));
  }
  saveMotionStudy(token:string,shotId:string,input:unknown,expected:{version:number;scriptVersion:number;directionVersion:number;castingRevision:string},now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.saveMotionStudy(token,shotId,input,expected,Date.now()));
  }
  removeMotionStudy(token:string,shotId:string,expectedVersion:number,revision:string,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.removeMotionStudy(token,shotId,expectedVersion,revision,Date.now()));
  }
  currentMotionStudy(token:string,shotId:string,revision:string,now=Date.now()) {
    return this.owner(token,false,now,null,service=>service.currentMotionStudy(token,shotId,revision,Date.now()));
  }
  removeShotDirection(token:string,shotId:string,expectedVersion:number,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.removeShotDirection(token,shotId,expectedVersion,Date.now()));
  }
  restoreDirection(token:string,version:number,expectedVersion:number,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.restoreDirection(token,version,expectedVersion,Date.now()));
  }
  shareCharacter(token:string,id:string,expectedVersion:number,attested:boolean,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.shareCharacter(token,id,expectedVersion,attested,Date.now()));
  }
  revokeActorShare(token:string,id:string,shareId:string,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.revokeActorShare(token,id,shareId,Date.now()));
  }
  async sharedActor(token:string,now=Date.now()) {
    const payload=verifyActorToken(token,now);if(!payload)throw new ActorShareUnavailable();
    return this.state(payload.projectId,false,service=>service.sharedActor(token,Date.now()));
  }
  async importSharedActor(token:string,shareToken:string,references:ReferenceAsset[],expectedVersion:number,options:{name:string;aliases:string[];attested:boolean},now=Date.now()) {
    const destination=this.projectId(token,"project",now),grant=verifyActorToken(shareToken,now);if(!destination)return null;if(!grant)throw new ActorShareUnavailable();
    if(destination===grant.projectId)throw new Error("Import this shared actor into a different project.");
    // Both capabilities are validated before entering either RLS scope. Stable lock order
    // makes opposing A-to-B and B-to-A imports safe; copying bytes happens before this transaction.
    return this.database.sql.begin(async tx=>{
      const state=empty();
      for(const id of [destination,grant.projectId].sort()) {
        await tx`select set_config('hv.project_id',${id},true)`;
        const row=(await tx`select body,taken_down_at from hv_projects where id=${id} for update`)[0];
        if(!row || row.taken_down_at)throw new ActorShareUnavailable();state.projects.push(row.body as PersistedProject);
      }
      const service=ProjectService.fromState(state),result=service.importSharedActor(token,shareToken,references,expectedVersion,options,Date.now());if(!result)return null;
      const project=service.snapshot().projects.find(value=>value.id===destination)!;
      await tx`select set_config('hv.project_id',${destination},true)`;
      await tx`update hv_projects set body=${project}::jsonb,version=version+1 where id=${destination}`;
      return result;
    });
  }
  useCostumePreset(token:string,id:string,index:number,sceneNumber:number|null,expectedVersion:number,remove=false,now=Date.now(),expectedScriptVersion?:number) {
    return this.owner(token,true,now,null,service=>service.useCostumePreset(token,id,index,sceneNumber,expectedVersion,remove,now,expectedScriptVersion));
  }
  removeCharacter(token: string, id: string, expectedVersion: number, now = Date.now()) {
    return this.owner(token, true, now, null, service => service.removeCharacter(token, id, expectedVersion, now));
  }
  revokeCharacterPermission(token: string, id: string, expectedVersion: number, now = Date.now()) {
    return this.owner(token, true, now, null, service => service.revokeCharacterPermission(token, id, expectedVersion, now));
  }
  addCharacterReference(token: string, id: string, reference: ReferenceAsset, expectedVersion: number, now = Date.now(), expectedScriptVersion?:number) {
    return this.owner(token,true,now,null,service => service.addCharacterReference(token,id,reference,expectedVersion,now,expectedScriptVersion));
  }
  addCharacterReferences(token:string,id:string,references:ReferenceAsset[],expectedVersion:number,now=Date.now(),options:ReferenceBatchOptions={}) {
    return this.owner(token,true,now,null,service=>service.addCharacterReferences(token,id,references,expectedVersion,options.sheet?Date.now():now,options));
  }
  removeCharacterReference(token: string, id: string, referenceId: string, expectedVersion: number, now = Date.now()) {
    return this.owner(token,true,now,null,service => service.removeCharacterReference(token,id,referenceId,expectedVersion,now));
  }
  restoreCasting(token: string, version: number, expectedVersion: number, now = Date.now()) {
    return this.owner(token, true, now, null, service => service.restoreCasting(token, version, expectedVersion, now));
  }
  getVersion(token: string, version: number, now = Date.now()) { return this.owner(token, false, now, null, service => service.getVersion(token, version, now)); }
  attestRights(token: string, now = Date.now()) { return this.owner(token, true, now, null, service => service.attestRights(token, now)); }
  latestScript(token: string, now = Date.now()) { return this.owner(token, false, now, null, service => service.latestScript(token, now)); }
  createReviewLink(token: string, permission: ReviewPermission, now = Date.now()) {
    return this.owner(token, true, now, null, service => service.createReviewLink(token, permission, now));
  }
  saveSoundAsset(token:string,input:SoundAsset|{assetId:string;available:boolean},expectedVersion:number,now=Date.now()){
    return this.owner(token,true,now,null,service=>service.saveSoundAsset(token,input,expectedVersion,now));
  }
  async saveGraphic(token:string,input:GraphicChange,expectedVersion:number,now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;return this.state(projectId,true,service=>service.saveGraphic(token,input,expectedVersion,now));
  }
  private async editorialBindings(tx:SQL,projectId:string,bindings:EditSourceBinding[]){
      const jobs:Job[]=[];
      for(const binding of [...bindings].sort((a,b)=>a.owner.jobId.localeCompare(b.owner.jobId))){
        const current=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${projectId} for share`)[0]?.body as Job|undefined;assertEditBindingAvailable(binding,current,Date.now());
        const files=await tx`select key,sha256,bytes from hv_artifacts where project_id=${projectId} and job_id=${binding.owner.jobId}`;
        for(const file of binding.files)if(!files.some((f:{key:string;sha256:string;bytes:number})=>f.key===file.path&&f.sha256===file.sha256&&Number(f.bytes)===file.bytes))throw new Error("An editorial source artifact changed during sequence admission.");
        jobs.push(current!);
      }
      return jobs;
  }
  private async assemblyCarriers(tx:SQL,projectId:string,carriers:EditAssemblyCarrier[]):Promise<EditAssemblyCarrier[]>{
    if(!Array.isArray(carriers)||!carriers.length||carriers.length>16)editFail("Retain one to sixteen current assembly carriers.");
    const bindings=carriers.map(carrier=>{editRecord(carrier,["binding","current"]);if(!Object.hasOwn(carrier,"binding")||!Object.hasOwn(carrier,"current"))editFail("Retain current assembly carrier metadata.");const binding=validateEditBinding(carrier.binding,Date.now());if(binding.owner.projectId!==projectId)editFail("Choose assembly originals from this project.");return binding;});
    const jobs=await this.editorialBindings(tx,projectId,bindings);return bindings.map(binding=>({binding,current:jobs.find(job=>job.id===binding.owner.jobId)}));
  }
  async createAssemblyProposal(token:string,sequenceId:string,input:EditAssemblyProposalInput,expected:EditAssemblyExpected,carriers:EditAssemblyCarrier[],now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;return this.state(projectId,true,async(service,tx)=>service.createAssemblyProposal(token,sequenceId,input,expected,await this.assemblyCarriers(tx,projectId,carriers),Date.now()));
  }
  async createLivingScriptProposal(token:string,input:LivingScriptProposalRequest,expectedVersion:number,carriers:EditAssemblyCarrier[],now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;
    return this.state(projectId,(result:ReturnType<ProjectService["createLivingScriptProposal"]>)=>Boolean(result&&!result.replayed),async(service,tx)=>service.createLivingScriptProposal(token,input,expectedVersion,await this.assemblyCarriers(tx,projectId,carriers),Date.now()));
  }
  async bootstrapCurrentScreenplay(token:string,request:Parameters<ProjectService["bootstrapCurrentScreenplay"]>[1],expectedVersion:number,carrier:EditAssemblyCarrier,now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;
    return this.state(projectId,(result:ReturnType<ProjectService["bootstrapCurrentScreenplay"]>)=>Boolean(result&&!result.replayed),async(service,tx)=>service.bootstrapCurrentScreenplay(token,request,expectedVersion,(await this.assemblyCarriers(tx,projectId,[carrier]))[0]!,Date.now()));
  }
  async saveCurrentScreenplayProposal(token:string,request:Parameters<ProjectService["saveCurrentScreenplayProposal"]>[1],expectedVersion:number,now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;
    return this.state(projectId,(result:ReturnType<ProjectService["saveCurrentScreenplayProposal"]>)=>Boolean(result&&!result.replayed),service=>service.saveCurrentScreenplayProposal(token,request,expectedVersion,Date.now()));
  }
  async acceptCurrentScreenplayProposal(token:string,request:Parameters<ProjectService["acceptCurrentScreenplayProposal"]>[1],expectedVersion:number,now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;
    return this.state(projectId,(result:ReturnType<ProjectService["acceptCurrentScreenplayProposal"]>)=>Boolean(result&&!result.replayed),service=>service.acceptCurrentScreenplayProposal(token,request,expectedVersion,Date.now()));
  }
  async acceptLivingScriptProposal(token:string,proposalId:string,proposalRevision:string,request:LivingScriptAcceptanceRequest,expectedVersion:number,carriers:EditAssemblyCarrier[],now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;
    return this.state(projectId,(result:ReturnType<ProjectService["acceptLivingScriptProposal"]>)=>Boolean(result&&!result.replayed),async(service,tx)=>service.acceptLivingScriptProposal(token,proposalId,proposalRevision,request,expectedVersion,await this.assemblyCarriers(tx,projectId,carriers),Date.now()));
  }
  async reviseAssemblyProposal(token:string,proposalId:string,input:EditAssemblyProposalRevision,expected:EditAssemblyRevisionExpected,carriers:EditAssemblyCarrier[],now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;return this.state(projectId,true,async(service,tx)=>service.reviseAssemblyProposal(token,proposalId,input,expected,await this.assemblyCarriers(tx,projectId,carriers),Date.now()));
  }
  async acceptAssemblyProposal(token:string,proposalId:string,proposalRevision:string,assemblyId:string,expected:EditAssemblyExpected,carriers:EditAssemblyCarrier[],now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;return this.state(projectId,(result:ReturnType<ProjectService["acceptAssemblyProposal"]>)=>Boolean(result&&!result.replayed),async(service,tx)=>service.acceptAssemblyProposal(token,proposalId,proposalRevision,assemblyId,expected,await this.assemblyCarriers(tx,projectId,carriers),Date.now()));
  }
  async admitEditSource(token:string,id:string,binding:EditSourceBinding,expectedVersion:number,expectedHistoryRevision:string,now=Date.now()){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;return this.state(projectId,true,async(service,tx)=>{await this.editorialBindings(tx,projectId,[binding]);return service.admitEditSource(token,id,binding,expectedVersion,expectedHistoryRevision,Date.now());});
  }
  async createEditSequence(token:string,receipts:EditSourceReceipt[],sequenceId:string,label:string,firstId:string,width:number,height:number,expectedVersion:number,now=Date.now(),bindings?:EditSourceBinding[]){
    const projectId=this.projectId(token,"project",now);if(!projectId)return null;
    return this.state(projectId,true,async(service,tx)=>{
      const selected=bindings??receipts.map(bindOriginalEditSource);
      await this.editorialBindings(tx,projectId,selected);
      return service.createEditSequence(token,receipts,sequenceId,label,firstId,width,height,expectedVersion,Date.now(),selected);
    });
  }
  changeEditSequence(token:string,id:string,change:EditSequenceChange,expectedVersion:number,expectedHistoryRevision:string,now=Date.now()){
    return this.owner(token,true,now,null,service=>service.changeEditSequence(token,id,change,expectedVersion,expectedHistoryRevision,Date.now()));
  }
  private async retainedOutput(tx:SQL,projectId:string,jobId:string):Promise<Job>{
    const job=(await tx`select body from hv_jobs where id=${jobId} and project_id=${projectId} for share`)[0]?.body as Job|undefined;
    if(!job?.output||job.status!=="done")throw new DialogueSelectionConflict("Choose a completed retained cut.");
    const required=job.output.editorial?.files??job.output.sound?.files??job.output.lipSync?.files??job.output.dialogue?.files??[job.output.mp4Path,job.output.manifestPath,job.output.captionsPath,job.output.hlsPlaylistPath].map(path=>({path,sha256:null,bytes:null}));
    const records=await tx`select key,sha256,bytes from hv_artifacts where project_id=${projectId} and job_id=${jobId}`;
    for(const file of required){const found=records.find((r:{key:string;sha256:string;bytes:number})=>r.key===file.path);if(!found||(file.sha256&&(found.sha256!==file.sha256||Number(found.bytes)!==file.bytes)))throw new DialogueSelectionConflict("The retained media receipt is unavailable or changed.");}
    return job;
  }
  async selectDialogueVersion(token:string,job:Job,sourceJobId:string,expectedVersion:number,expectedOutputRevision:string,now=Date.now()){
    const id=this.projectId(token,"project",now);if(!id)return null;
    return this.state(id,true,async(service,tx)=>service.selectDialogueVersion(token,await this.retainedOutput(tx,id,job.id),sourceJobId,expectedVersion,expectedOutputRevision,Date.now()));
  }
  async createBoundReviewLink(token:string,permission:ReviewPermission,job:Job,binding:OutputBinding,now=Date.now()){
    const id=this.projectId(token,"project",now);if(!id)return null;
    return this.state(id,true,async(service,tx)=>service.createBoundReviewLink(token,permission,await this.retainedOutput(tx,id,job.id),binding,Date.now()));
  }
  revokeReviewLink(token: string, reviewToken: string, now = Date.now()) {
    return this.owner(token, true, now, false, service => service.revokeReviewLink(token, reviewToken, now));
  }
  useReviewLink(token: string, now = Date.now()) { return this.reviewer(token, true, now, null, service => service.useReviewLink(token, now)); }
  peekReviewLink(token: string, now = Date.now()) { return this.reviewer(token, false, now, null, service => service.peekReviewLink(token, now)); }
  async submitReviewDecision(token: string, decision: ReviewDecision, note = "", now = Date.now(),_job?:Job) {
    const id=this.projectId(token,"review",now);if(!id)return false;
    return this.state(id,true,async(service,tx)=>{if(!service.peekProject(id))return false;const link=service.peekReviewLink(token,Date.now());if(!link)return false;
      const job=link.outputBinding?await this.retainedOutput(tx,id,link.outputBinding.jobId):undefined;return service.submitReviewDecision(token,decision,note,Date.now(),job);});
  }
  peekProject(id: string) { return this.state(id, false, service => service.peekProject(id)); }
  animaticApproval(projectId: string, jobId: string) { return this.state(projectId, false, service => service.animaticApproval(projectId, jobId)); }
  async recordLivingScriptDecision(token:string,preview:Job,review:LivingScriptPreviewReview,decision:ReviewDecision,note:string,carrier:EditAssemblyCarrier,now=Date.now()){
    const id=this.projectId(token,"project",now);if(!id)return null;
    return this.state(id,(result:ReturnType<ProjectService["recordLivingScriptDecision"]>)=>Boolean(result&&!result.replayed),async(service,tx)=>{
      const current=await this.retainedOutput(tx,id,preview.id),carriers=await this.assemblyCarriers(tx,id,[carrier]);
      const files=await tx`select key,sha256,bytes from hv_artifacts where project_id=${id} and job_id=${current.id} for share`;
      for(const record of current.output?.shotRenders??[])for(const file of Object.values(record.files))if(!files.some((value:{key:string;sha256:string;bytes:number})=>value.key===file.path&&value.sha256===file.sha256&&Number(value.bytes)===file.bytes))editFail("The pending preview shot artifacts changed before review.");
      return service.recordLivingScriptDecision(token,current,review,decision,note,carriers[0]!,Date.now());
    });
  }
  async recordCurrentFilmDecision(token:string,preview:Job,review:CurrentFilmPreviewReview,decision:ReviewDecision,note:string,now=Date.now()){
    const id=this.projectId(token,"project",now);if(!id)return null;
    return this.state(id,(result:ReturnType<ProjectService["recordCurrentFilmDecision"]>)=>Boolean(result&&!result.replayed),async(service,tx)=>{
      const current=await this.retainedOutput(tx,id,preview.id),files=await tx`select key,sha256,bytes from hv_artifacts where project_id=${id} and job_id=${current.id} for share`;
      for(const file of currentFilmRecordedFiles(current))if(!files.some((row:{key:string;sha256:string;bytes:number})=>row.key===file.path&&row.sha256===file.sha256&&Number(row.bytes)===file.bytes))editFail("The current-film preview artifacts changed before review.");
      return service.recordCurrentFilmDecision(token,current,review,decision,note,Date.now());
    });
  }
  recordAnimaticDecision(projectId: string, jobId: string, version: number, decision: ReviewDecision, note = "", now = Date.now(), expectedCasting?: CastingSnapshot, expectedDirection?:DirectionSnapshot,expectedTakes?:ShotTakePlan) {
    return this.state(projectId, true, async(service,tx) => {
      const job=(await tx`select body from hv_jobs where id=${jobId} and project_id=${projectId} for share`)[0]?.body as Job|undefined;
      if(job?.livingScript||job?.currentFilm)editFail("Use the screenplay-specific preview decision flow.");
      const project = service.peekProject(projectId);
      if (project?.versions.latest()?.version !== version || (expectedCasting && !castingMatches(expectedCasting, currentCasting(projectId, project.castingHistory)))) return null;
      if(expectedDirection&&!directionMatches(expectedDirection,currentDirection(projectId,project.directionHistory)))return null;
      return service.recordAnimaticDecision(projectId, jobId, version, decision, note, now, expectedCasting,expectedDirection,expectedTakes);
    });
  }
  takedown(projectId: string, reason: string, now = Date.now()) { return this.state(projectId, true, service => service.takedown(projectId, reason, now)); }
  isTakenDown(projectId: string) { return this.state(projectId, false, service => service.isTakenDown(projectId)); }
  extendRetention(projectId: string, days: number, reason: string, now = Date.now()) {
    return this.state(projectId, true, service => service.extendRetention(projectId, days, reason, now));
  }
  async sweepExpired(now = Date.now()): Promise<string[]> {
    return new PostgresRetention(this.database).sweep(now);
  }
}
