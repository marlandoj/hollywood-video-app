import type {ShotTakePlan} from "../../planner/src/takes";
import { createHash } from "node:crypto";
import { ProjectService, type PersistedProject, type PersistedState, type ReviewDecision, type ReviewLink, type ReferenceBatchOptions } from "../../api/src/index";
import { verifyToken } from "../../api/src/tokens";
import { PostgresRetention } from "./retention";
import { StudioDatabase } from "./database";
import { castingMatches, currentCasting, type CastingSnapshot } from "../../planner/src/casting";
import type { ReferenceAsset } from "../../planner/src/references";
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
  private async state<T>(id: string, write: boolean, fn: (service: ProjectService) => T): Promise<T> {
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
      const result = fn(service);
      if (!write || !row) return result;
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
  saveShotDirection(token:string,shotId:string,input:unknown,expectedVersion:number,expectedScriptVersion:number,sourceHash:string,maxShots=24,now=Date.now()) {
    return this.owner(token,true,now,null,service=>service.saveShotDirection(token,shotId,input,expectedVersion,expectedScriptVersion,sourceHash,maxShots,Date.now()));
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
  createReviewLink(token: string, permission: "read" | "approve", now = Date.now()) {
    return this.owner(token, true, now, null, service => service.createReviewLink(token, permission, now));
  }
  revokeReviewLink(token: string, reviewToken: string, now = Date.now()) {
    return this.owner(token, true, now, false, service => service.revokeReviewLink(token, reviewToken, now));
  }
  useReviewLink(token: string, now = Date.now()) { return this.reviewer(token, true, now, null, service => service.useReviewLink(token, now)); }
  peekReviewLink(token: string, now = Date.now()) { return this.reviewer(token, false, now, null, service => service.peekReviewLink(token, now)); }
  submitReviewDecision(token: string, decision: ReviewDecision, note = "", now = Date.now()) {
    return this.reviewer(token, true, now, false, service => service.submitReviewDecision(token, decision, note, now));
  }
  peekProject(id: string) { return this.state(id, false, service => service.peekProject(id)); }
  animaticApproval(projectId: string, jobId: string) { return this.state(projectId, false, service => service.animaticApproval(projectId, jobId)); }
  recordAnimaticDecision(projectId: string, jobId: string, version: number, decision: ReviewDecision, note = "", now = Date.now(), expectedCasting?: CastingSnapshot, expectedDirection?:DirectionSnapshot,expectedTakes?:ShotTakePlan) {
    return this.state(projectId, true, service => {
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
