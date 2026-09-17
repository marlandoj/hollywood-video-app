import type { SQL } from "bun";
import {assertGraphicIdempotency,assertGraphicPermission,type GraphicOutput,type GraphicProgress} from "../../planner/src/graphic-jobs";
import {dialogueSourceJobId,assertDialogueAuditionInputs,assertDialogueAccess,assertDialogueSourceAvailable,assertDialogueIdempotency} from "../../planner/src/dialogue-jobs";
import {assertSoundIdempotency,assertSoundPermission,assertSoundSourceAvailable} from "../../planner/src/sound-jobs";
import {assertEditIdempotency,assertEditPermission,assertEditBindingAvailable,validateEditOutput} from "../../planner/src/edit-jobs";
import {assertEditAssemblyIdempotency} from "../../planner/src/edit-assembly-job-context";
import {assertLivingScriptIdempotency} from "../../planner/src/living-script-job-context";
import {assertLivingScriptTransaction} from "./living-script-context";
import {assertCurrentFilmTransaction} from "./current-film-context";
import {assertCurrentFilmIdempotency,currentFilmRecordedFiles} from "../../planner/src/current-film-job-context";
import {assertEditAssemblyPermission,validateEditAssemblyOutput} from "../../planner/src/edit-assembly-jobs";
import {assertAudioTakePermission,assertAudioTakeIdempotency,type AudioTakeOutput} from "../../planner/src/audio-jobs";
import {assertLipSyncIdempotency,assertLipSyncPermission,assertLipSyncSourceAvailable,assertLipSyncPlayback,type LipSyncPrepared,type LipSyncReview,type LipSyncReviews} from "../../planner/src/lipsync";
import {configuredLipSyncPolicy,validateLipSyncPolicy,lipSame} from "../../planner/src/lipsync-policy";
import type {PersistedProject} from "../../api/src/index";
import type { CostRecord } from "../../generator/src/index";
import type { RouteDecision } from "../../generator/src/router";
import { DEFAULT_LEASE_MS, DurableJobStore, LeaseError, TIERS, fairShareOrder, type ClaimOptions, type Job, type JobInput } from "../../queue/src/index";
import { StudioDatabase } from "./database";

async function saveJob(tx: SQL, job: Job, event?: string, workerId = job.claimedBy): Promise<void> {
  await tx`update hv_jobs set body = ${job}::jsonb, status = ${job.status},
    claimed_by = ${job.claimedBy}, lease_expires_at = ${job.leaseExpiresAt},
    next_eligible_at = ${job.nextEligibleAt}, lease_version = ${job.leaseVersion ?? 0},
    updated_at = now() where id = ${job.id}`;
  if (event) await tx`insert into hv_outbox (id, project_id, job_id, event_type, body)
    values (${crypto.randomUUID()}, ${job.projectId}, ${job.id}, ${event},
    ${{status: job.status, workerId, leaseVersion: job.leaseVersion ?? 0, checkpointShots: job.checkpointShots}}::jsonb)`;
}

/**
 * Revocation inside a caller's transaction, so a takedown and the stopping of
 * its generation are one atomic act rather than two that can interleave with a
 * claim. `for update` serialises against `claimNext`; the lease version is
 * bumped so a worker already holding one of these jobs fails its next fenced
 * write. Terminal rows are not selected: a delivered cut is an already-issued
 * record, and revoking future generation must not rewrite history.
 */
export async function revokeProjectWithin(tx: SQL, projectId: string, reason: string, now = Date.now()): Promise<Job[]> {
  const rows = await tx`select body, lease_version from hv_jobs where project_id = ${projectId}
    and status in ('queued', 'running') for update`;
  const jobs = rows.map((row: { body: Job }) => row.body);
  if (!jobs.length) return [];
  // Keyed by identity rather than by position: the domain object returns the
  // jobs it actually revoked, which need not be every selected row in order.
  const versions = new Map<string, number>(rows.map((row: { body: Job; lease_version: number }) => [row.body.id, row.lease_version]));
  const cancelled = DurableJobStore.fromJobs(jobs).revokeProject(projectId, reason, now);
  for (const job of cancelled) {
    job.leaseVersion = (versions.get(job.id) ?? 0) + 1;
    await saveJob(tx, job, "job.revoked");
  }
  return cancelled;
}

/** One instance per worker execution loop. Claim fences never transfer between instances. */
export class PostgresJobStore {
  private readonly fences = new Map<string, number>();
  constructor(private readonly database: StudioDatabase, private readonly projectId?: string) {}
  forProject(projectId: string): PostgresJobStore { return new PostgresJobStore(this.database, projectId); }
  private transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
    return this.projectId ? this.database.forProject(this.projectId, fn)
      : this.database.sql.begin(tx => fn(tx as unknown as SQL)) as Promise<T>;
  }
  private save = saveJob;
  async enqueue(input: JobInput): Promise<Job> {
    return this.transaction(tx => this.enqueueWithin(tx, input));
  }
  /** Admission may include a budget reservation in this same transaction. */
  async enqueueWithin(tx: SQL, input: JobInput): Promise<Job> {
      const active = await tx`select body from hv_jobs where status in ('queued', 'running') order by queued_at, id`;
      const domain = DurableJobStore.fromJobs(active.map((row: { body: Job }) => row.body));
      const job = domain.enqueue(input);
      const inserted = await tx`insert into hv_jobs (id, project_id, idempotency_key, stage, status, tier, body)
        values (${job.id}, ${job.projectId}, ${job.idempotencyKey}, ${job.stage}, ${job.status}, ${job.tier}, ${job}::jsonb)
        on conflict (project_id, idempotency_key) do nothing returning id`;
      if (inserted.length) await this.save(tx, job, "job.queued");
      const rows = await tx`select body from hv_jobs where project_id = ${input.projectId} and idempotency_key = ${input.idempotencyKey}`;
      if (!rows.length) throw new Error("job admission did not persist");
      assertDialogueIdempotency(rows[0].body as Job,input);
      assertAudioTakeIdempotency(rows[0].body as Job,input);
      assertLipSyncIdempotency(rows[0].body as Job,input);
      assertSoundIdempotency(rows[0].body as Job,input);
      assertEditIdempotency(rows[0].body as Job,input);
      assertEditAssemblyIdempotency(rows[0].body as Job,input);
      assertLivingScriptIdempotency(rows[0].body as Job,input);
      assertCurrentFilmIdempotency(rows[0].body as Job,input);
      assertGraphicIdempotency(rows[0].body as Job,input);
      return rows[0].body as Job;
  }
  private async mutate<T>(id: string, fn: (domain: DurableJobStore) => T, event?: string, held = false,finish=false): Promise<T> {
    return this.transaction(async tx => {
      // Retention locks project then jobs. Completion follows that same order.
      const finishing=finish?(await tx`select body from hv_jobs where id=${id}`)[0]?.body as Job|undefined:undefined;
      const finishProject=finishing&&(finishing.dialogueReplacement||finishing.audioTake||finishing.lipSync||finishing.soundMix||finishing.pictureEdit||finishing.assemblyEdit||finishing.graphicRender||finishing.livingScript||finishing.currentFilm)?(await tx`select body from hv_projects where id=${finishing.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined:undefined;
      const rows = await tx`select body, lease_version from hv_jobs where id = ${id} for update`;
      if (!rows.length) throw new Error(`unknown job ${id}`);
      const job = rows[0].body as Job;
      if (held && this.fences.get(id) !== rows[0].lease_version) throw new LeaseError(id, "fence_changed", job.claimedBy);
      if(finish)await assertLivingScriptTransaction(tx,job,finishProject);
      if(finish)await assertCurrentFilmTransaction(tx,job,finishProject);
      if(finish&&job.audioTake)assertAudioTakePermission(job,finishProject);
      if(finish&&job.graphicRender)assertGraphicPermission(job.graphicRender,finishProject);
      if(finish&&job.pictureEdit){assertEditPermission(job.pictureEdit,finishProject);if(job.editCheckpoint)validateEditOutput(job,job.editCheckpoint);else for(const binding of job.pictureEdit.bindings){const source=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertEditBindingAvailable(binding,source);}}
      if(finish&&job.assemblyEdit){assertEditAssemblyPermission(job.assemblyEdit,finishProject);if(job.assemblyCheckpoint)validateEditAssemblyOutput(job,job.assemblyCheckpoint);else for(const binding of job.assemblyEdit.bindings.slice().sort((a,b)=>a.owner.jobId.localeCompare(b.owner.jobId))){const source=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertEditBindingAvailable(binding,source);}}
      if(finish&&job.soundMix){const source=(await tx`select body from hv_jobs where id=${job.soundMix.source.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertSoundSourceAvailable(job.soundMix,source);assertSoundPermission(job.soundMix,finishProject);}
      if(finish&&job.lipSync){assertLipSyncPermission(job.lipSync,finishProject);const policy=configuredLipSyncPolicy();if(!policy||!lipSame(validateLipSyncPolicy(policy,Date.now()),job.lipSync.policy))throw new Error("The lip-sync policy changed before completion.");const source=(await tx`select body from hv_jobs where id=${job.lipSync.source.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertLipSyncSourceAvailable(job.lipSync,source);}
      if(finish&&job.dialogueReplacement){
        const source=(await tx`select body from hv_jobs where id=${dialogueSourceJobId(job)} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;
        assertDialogueSourceAvailable(job,source);assertDialogueAccess(job.dialogueReplacement.source,finishProject,Date.now(),job.dialogueReplacement.plan.baseline);
        await assertDialogueAuditionInputs(job,finishProject,async sourceId=>(await tx`select body from hv_jobs where id=${sourceId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined);
      }
      const domain = DurableJobStore.fromJobs([job]);
      const result = fn(domain);
      if(finish&&job.currentFilm){
        const updated=domain.get(id)!,files=currentFilmRecordedFiles(updated),indexed=await tx`select key,sha256,bytes from hv_artifacts where project_id=${job.projectId} and job_id=${job.id} for share`;
        for(const file of files)if(!indexed.some((row:{key:string;sha256:string;bytes:number})=>row.key===file.path&&row.sha256===file.sha256&&Number(row.bytes)===file.bytes))throw new Error("Complete only the exact published current-film media.");
        if(updated.output)for(const path of [updated.output.mp4Path,updated.output.hlsPlaylistPath,updated.output.captionsPath,updated.output.manifestPath])if(!indexed.some((row:{key:string})=>row.key===path))throw new Error("The current-film export is missing a published artifact.");
      }
      const audio=domain.get(id)?.audioCheckpoint;
      const lip=domain.get(id)?.lipSyncCheckpoint;
      if(finish&&job.lipSync&&lip){const attempt=(await tx`select body from hv_provider_attempts where id=${lip.lipSync!.report.delivery.attemptId} and job_id=${job.id} and project_id=${job.projectId} for share`)[0]?.body.lipSync;
        if(!attempt?.receipt?.delivery||!lipSame(attempt.receipt.delivery,lip.lipSync!.report.delivery))throw new Error("Lip-sync checkpoint has no matching provider delivery.");}
      if(finish&&job.audioTake&&audio){const attempt=(await tx`select body from hv_provider_attempts where id=${audio.report.attemptId} and job_id=${job.id} and project_id=${job.projectId} for share`)[0]?.body.audio;
        if(!attempt||attempt.intent.planRevision!==job.audioTake.line.revision||attempt.outcome?.providerState!=="completed"||attempt.outcome?.deliveryState!=="ready"||attempt.outcome?.deliveryRevision!==audio.report.revision)throw new Error("Audio checkpoint has no matching completed provider outcome.");}
      await this.save(tx, domain.get(id)!, event, job.claimedBy);
      return result;
    });
  }
  async checkpoint(id: string, workerId: string, shots: number, frames: number, now = Date.now(), leaseMs = DEFAULT_LEASE_MS,execution?:Parameters<DurableJobStore["checkpoint"]>[6]): Promise<void> {
    await this.mutate(id, domain => domain.checkpoint(id, workerId, shots, frames, now, leaseMs,execution), "job.checkpoint", true,Boolean(execution&&"schema" in execution));
  }
  async checkpointDialogue(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):Promise<void>{
    await this.mutate(id,domain=>domain.checkpointDialogue(id,workerId,output,now,leaseMs),"dialogue.checkpoint",true);
  }
  async checkpointSound(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):Promise<void>{
    await this.mutate(id,domain=>domain.checkpointSound(id,workerId,output,now,leaseMs),"sound.checkpoint",true,true);
  }
  async checkpointEdit(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):Promise<void>{
    await this.mutate(id,domain=>domain.checkpointEdit(id,workerId,output,now,leaseMs),"editorial.checkpoint",true,true);
  }
  async checkpointAssembly(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):Promise<void>{
    await this.mutate(id,domain=>domain.checkpointAssembly(id,workerId,output,now,leaseMs),"assembly.checkpoint",true,true);
  }
  async heartbeat(id: string, workerId: string, now = Date.now(), leaseMs = DEFAULT_LEASE_MS): Promise<void> {
    await this.mutate(id, domain => domain.heartbeat(id, workerId, now, leaseMs), undefined, true);
  }
  checkpointLipSyncPrepared(id:string,workerId:string,prepared:LipSyncPrepared,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):Promise<void>{return this.mutate(id,d=>d.checkpointLipSyncPrepared(id,workerId,prepared,now,leaseMs),"lipsync.prepared",true,true);}
  checkpointLipSync(id:string,workerId:string,output:NonNullable<Job["output"]>,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):Promise<void>{return this.mutate(id,d=>d.checkpointLipSync(id,workerId,output,now,leaseMs),"lipsync.checkpoint",true,true);}
  reviewLipSync(id:string,input:Pick<LipSyncReview,"mouthSync"|"faceStability"|"expression"|"decision"|"notes">,expectedVersion:number,expectedOutputRevision:string,now=Date.now()):Promise<LipSyncReviews>{
    return this.transaction(async tx=>{const saved=(await tx`select body from hv_jobs where id=${id}`)[0]?.body as Job|undefined;if(!saved)throw new Error("Unknown lip-sync result.");const project=(await tx`select body from hv_projects where id=${saved.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
      const job=(await tx`select body from hv_jobs where id=${id} for update`)[0]?.body as Job|undefined;if(!job)throw new Error("Unknown lip-sync result.");assertLipSyncPlayback(job,project,now);const domain=DurableJobStore.fromJobs([job]),review=domain.reviewLipSync(id,input,expectedVersion,expectedOutputRevision,now);await this.save(tx,domain.get(id)!,"lipsync.reviewed");return review;});
  }
  checkpointAudio(id:string,workerId:string,output:AudioTakeOutput,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):Promise<void>{
    return this.mutate(id,domain=>domain.checkpointAudio(id,workerId,output,now,leaseMs),"audio.checkpoint",true,true);
  }
  progressGraphic(id:string,workerId:string,progress:GraphicProgress,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):Promise<void>{
    return this.mutate(id,domain=>domain.progressGraphic(id,workerId,progress,now,leaseMs),"graphic.progress",true,true);
  }
  checkpointGraphic(id:string,workerId:string,output:GraphicOutput,now=Date.now(),leaseMs=DEFAULT_LEASE_MS):Promise<void>{
    return this.mutate(id,domain=>domain.checkpointGraphic(id,workerId,output,now,leaseMs),"graphic.checkpoint",true,true);
  }
  completeGraphic(id:string,workerId:string,output:GraphicOutput,now=Date.now()):Promise<Job>{
    return this.mutate(id,domain=>domain.completeGraphic(id,workerId,output,now),"graphic.completed",true,true);
  }
  completeAudio(id:string,workerId:string,output:AudioTakeOutput,now=Date.now()):Promise<Job>{
    return this.mutate(id,domain=>domain.completeAudio(id,workerId,output,now),"audio.completed",true,true);
  }
  async recordRouteDecision(id: string, workerId: string, decision: RouteDecision, now = Date.now()): Promise<void> {
    await this.mutate(id, domain => domain.recordRouteDecision(id, workerId, decision, now), "job.routed", true);
  }
  async setStatus(id: string, status: Job["status"]): Promise<void> {
    await this.mutate(id, domain => domain.setStatus(id, status), "job.status");
  }
  async recoverAbandoned(now = Date.now()): Promise<Job[]> {
    return this.transaction(async tx => {
      const rows = await tx`select body from hv_jobs where status = 'running'
        and (lease_expires_at is null or lease_expires_at <= ${new Date(now).toISOString()})
        for update skip locked`;
      const domain = DurableJobStore.fromJobs(rows.map((row: { body: Job }) => row.body));
      const recovered = domain.recoverAbandoned(now);
      for (const job of recovered) await this.save(tx, job, "job.resumed");
      return recovered;
    });
  }
  /** Revocation in its own transaction, for callers that are not already in one. */
  async revokeProject(projectId: string, reason: string, now = Date.now()): Promise<Job[]> {
    const revoked = await this.transaction(tx => revokeProjectWithin(tx, projectId, reason, now));
    for (const job of revoked) this.fences.delete(job.id);
    return revoked;
  }
  async claimNext(now = Date.now(), gpuSecondsByProject: Record<string, number> = {}, options: ClaimOptions = {}): Promise<Job | undefined> {
    await this.recoverAbandoned(now);
    const claimed = await this.transaction(async tx => {
      const timestamp = new Date(now).toISOString();
      const rows = await tx`select id, project_id, tier from hv_jobs where status = 'queued'
        and (next_eligible_at is null or next_eligible_at <= ${timestamp}) order by queued_at, id`;
      const order = fairShareOrder(rows.map((row: { id: string; project_id: string; tier: string }) => ({
        jobId: row.id, projectId: row.project_id, gpuSecondsUsed: gpuSecondsByProject[row.project_id] ?? 0,
        priority: row.tier === "elevated" ? 0 : 1,
      })));
      const candidates = new Map<string, string>(rows.map((row: { id: string; project_id: string }) => [row.id, row.project_id]));
      for (const id of order) {
        // Serialize the count-and-claim decision for a project without waiting on busy projects.
        const lock = await tx`select pg_try_advisory_xact_lock(hashtextextended(${candidates.get(id)!}, 731)) as acquired`;
        if (!lock[0].acquired) continue;
        const selected = await tx`select body, lease_version from hv_jobs where id = ${id} and status = 'queued'
          and (next_eligible_at is null or next_eligible_at <= ${timestamp}) for update skip locked`;
        if (!selected.length) continue;
        const job = selected[0].body as Job;
        const running = await tx`select count(*)::int as count from hv_jobs where project_id = ${job.projectId}
          and status = 'running' and lease_expires_at > ${timestamp}`;
        if (running[0].count >= TIERS[job.tier].maxConcurrent) continue;
        const ahead = await tx`select id from hv_jobs where status in ('queued', 'running') and id in
          (select jsonb_array_elements_text(body->'queuedBehind') from hv_jobs where id = ${id}) limit 1`;
        if (ahead.length) continue;
        const domain = DurableJobStore.fromJobs([job]);
        const result = domain.claimNext(now, gpuSecondsByProject, options)!;
        result.leaseVersion = selected[0].lease_version + 1;
        await this.save(tx, result, "job.claimed");
        return result;
      }
      return undefined;
    });
    if (claimed) this.fences.set(claimed.id, claimed.leaseVersion!);
    return claimed;
  }
  complete(id: string, workerId: string, output: NonNullable<Job["output"]>, now = Date.now()): Promise<Job> {
    return this.mutate(id, domain => domain.complete(id, workerId, output, now), "job.completed", true,true);
  }
  fail(id: string, workerId: string, reason: string, now = Date.now()): Promise<Job> {
    return this.mutate(id, domain => domain.fail(id, workerId, reason, now), "job.failed", true);
  }
  refuse(id: string, workerId: string, reason: string, now = Date.now()): Promise<Job> {
    return this.mutate(id, domain => domain.refuse(id, workerId, reason, now), "job.refused", true);
  }
  cancel(id: string, workerId: string, reason: string, now = Date.now()): Promise<Job> {
    return this.mutate(id, domain => domain.cancel(id, workerId, reason, now), "job.cancelled", true);
  }
  recordCost(id: string, workerId: string, cost: CostRecord, now = Date.now()): Promise<Job> {
    return this.mutate(id, domain => domain.recordCost(id, workerId, cost, now), "job.cost", true);
  }
  get(id: string): Promise<Job | undefined> {
    return this.transaction(async tx => (await tx`select body from hv_jobs where id = ${id}`)[0]?.body);
  }
  all(): Promise<Job[]> {
    return this.transaction(async tx => (await tx`select body from hv_jobs order by queued_at, id`).map((row: { body: Job }) => row.body));
  }
}
