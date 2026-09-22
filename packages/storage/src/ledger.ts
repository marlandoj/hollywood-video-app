import { assertFilmBudget } from "../../operator/src/film-budget";
import {assertGraphicIdempotency,assertGraphicPermission,validateGraphicJob} from "../../planner/src/graphic-jobs";
import {assertDeliveryIdempotency,assertDeliveryPermission,assertDeliverySourceAvailable,validateDeliveryJob} from "../../planner/src/delivery-jobs";
import {sourcePlan} from "../../planner/src/scene-cuts";
import {contentHash} from "../../generator/src/capabilities";
import {assertSoundIdempotency,assertSoundPermission,assertSoundSourceAvailable,validateSoundJob} from "../../planner/src/sound-jobs";
import {assertEditIdempotency,assertEditPermission,assertEditBindingAvailable,validateEditJob,validateEditOutput} from "../../planner/src/edit-jobs";
import {assertEditAssemblyIdempotency,validateEditAssemblyJob} from "../../planner/src/edit-assembly-job-context";
import {assertLivingScriptIdempotency,validateLivingScriptJob} from "../../planner/src/living-script-job-context";
import {assertLivingScriptTransaction} from "./living-script-context";
import {assertCurrentFilmTransaction} from "./current-film-context";
import {assertCurrentFilmIdempotency,assertCurrentFilmHeldInputs,assertCurrentFilmMode,validateCurrentFilmJob} from "../../planner/src/current-film-job-context";
import {assertEditAssemblyPermission,validateEditAssemblyOutput,type EditAssemblyRenderPlan} from "../../planner/src/edit-assembly-jobs";
import {dialogueSourceJobId,dialogueAuditionInputs,assertDialogueAuditionInputs,assertDialogueAccess,assertDialogueSourceAvailable,assertDialogueIdempotency,validateDialogueJob} from "../../planner/src/dialogue-jobs";
import {isTakeStage} from "../../planner/src/render-stage";
import {validateReusePlan,sourceRenderRecord,ShotReuseError} from "../../planner/src/shot-reuse";
import type {Shot} from "../../planner/src/index";
import {shotTakeShots,assertTakeCatalog} from "../../planner/src/takes";
import {assertFrameAnchorCatalog} from "../../planner/src/frame-anchors";
import {FrameAnchorError} from "../../generator/src/frame-anchor-media";
import type {ReferenceAsset} from "../../planner/src/references";
import type { SQL } from "bun";
import { validateProviderReceipt, type ProviderRequestReceipt } from "../../generator/src/receipts";
import { BudgetError, type BudgetReservation, type CostEvent } from "../../operator/src/index";
import { LeaseError, type Job, type JobInput, type JobStage } from "../../queue/src/index";
import type { PersistedProject } from "../../api/src/index";
import { PostgresJobStore } from "./jobs";
import { StudioDatabase } from "./database";
import { assertCurrentCastPermission, castingMatches, charactersForScene, currentCasting, assertPictureDirections } from "../../planner/src/casting";
import {currentDirection,directionMatches,directShots} from "../../planner/src/direction";
import { parseFountain } from "../../parser/src/index";
import { FAIR_SHARE_WINDOW_MS, TIERS, costCapCancelNotice, notify } from "../../queue/src/index";
import { assertSheetDispatch, characterSheetShots } from "../../planner/src/sheets";

const money = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new BudgetError("invalid generation budget");
  return Number(value.toFixed(6));
};
export interface ProviderAttempt {
  id: string; projectId: string; jobId: string; shotId: string; provider: string;
  workerId: string; leaseVersion: number; estimateUsd: number;
  shotCapUsd?: number; routeDecisionId?: string; model?: string; capabilityRevision?: string;
}
export class PostgresCostLedger {
  constructor(protected readonly database: StudioDatabase) {}
  protected async lockWithin<T>(tx: SQL, fn: (tx: SQL, cap: number) => Promise<T>, initialCap: number): Promise<T> {
    await tx`insert into hv_budget_accounts (id, monthly_cap_usd) values ('operator', ${initialCap})
      on conflict (id) do nothing`;
    const account = await tx`select monthly_cap_usd from hv_budget_accounts where id = 'operator' for update`;
    return fn(tx, Number(account[0].monthly_cap_usd));
  }
  protected async locked<T>(fn: (tx: SQL, cap: number) => Promise<T>, initialCap = Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000)): Promise<T> {
    return await this.database.sql.begin(transaction => this.lockWithin(transaction as unknown as SQL, fn, initialCap)) as T;
  }
  /** Worker path: unscoped, so the hold carries no project id. API admission goes through admit() inside forProject. */
  async reserve(jobId: string, stage: JobStage, amountUsd: number, monthlyCapUsd: number, now = new Date(), projectId: string | null = null): Promise<void> {
    amountUsd = money(amountUsd);
    if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) throw new BudgetError("invalid monthly budget");
    await this.locked((tx, storedCap) => this.reserveWithin(tx, storedCap, jobId, stage, amountUsd, monthlyCapUsd, now, projectId), monthlyCapUsd);
  }
  /** project_id must equal the transaction's hv.project_id for hv_api (policy hv_reservations_api_admit); hv_worker writes NULL. */
  protected async reserveWithin(tx: SQL, storedCap: number, jobId: string, stage: JobStage, amountUsd: number, monthlyCapUsd: number, now: Date, projectId: string | null): Promise<void> {
      if (monthlyCapUsd < storedCap) await tx`update hv_budget_accounts set monthly_cap_usd = ${monthlyCapUsd}, updated_at = now() where id = 'operator'`;
      const previous = (await tx`select body from hv_reservations where job_id = ${jobId}`)[0]?.body as BudgetReservation | undefined;
      if (previous) {
        if (previous.stage !== stage || previous.amountUsd !== amountUsd) throw new BudgetError("job budget changed while reserved");
        return;
      }
      const spent = await tx`select coalesce(sum(total_usd), 0) as total from hv_cost_events where job_id = ${jobId}`;
      const remaining = money(Math.max(0, amountUsd - Number(spent[0].total)));
      const totals = await tx`select
        (select coalesce(sum(total_usd), 0) from hv_cost_events where created_at >= ${new Date(now.getTime() - 2592e6).toISOString()}) as spent,
        (select coalesce(sum(remaining_usd), 0) from hv_reservations) as held`;
      if (Number(totals[0].spent) + Number(totals[0].held) + remaining > Math.min(monthlyCapUsd, storedCap) + 1e-9)
        throw new BudgetError("generation capacity is reserved; try again when current jobs finish");
      const body: BudgetReservation = {jobId, stage, amountUsd, remainingUsd: remaining, createdAt: now.toISOString()};
      await tx`insert into hv_reservations (job_id, stage, amount_usd, remaining_usd, body, created_at, project_id)
        values (${jobId}, ${stage}, ${amountUsd}, ${remaining}, ${body}::jsonb, ${body.createdAt}, ${projectId})`;
  }
  /** Project version, idempotency, budget reservation and admission commit together. */
  /** HV-019-04: what one film has spent and holds, read under the caller's transaction when given. */
  async filmSpend(projectId: string, tx: SQL = this.database.sql): Promise<{spentUsd: number; heldUsd: number}> {
    const row = (await tx`select
      (select coalesce(sum(total_usd), 0) from hv_cost_events where project_id = ${projectId}) as spent,
      (select coalesce(sum(remaining_usd), 0) from hv_reservations where project_id = ${projectId}) as held`)[0];
    return {spentUsd: Number(row.spent), heldUsd: Number(row.held)};
  }
  protected async assertFilmWithin(tx: SQL, projectId: string, amount: number, filmCapUsd: number | undefined): Promise<void> {
    if (filmCapUsd === undefined || amount <= 0) return;
    assertFilmBudget({...await this.filmSpend(projectId, tx), capUsd: filmCapUsd}, amount);
  }
  async admit(projectId: string, input: JobInput, monthlyCapUsd: number, filmCapUsd?: number): Promise<Job> {
    if(input.audioTake||input.stage==="audio-take")throw new BudgetError("Audio auditions require separate admission.");
    if(input.lipSync||input.stage==="lip-sync")throw new BudgetError("Lip-sync requires separate admission.");
    if (input.projectId !== projectId || !Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) throw new BudgetError("invalid job admission");
    const amount = money(input.budgetReservedUsd ?? input.costCapUsd);
    return this.database.forProject(projectId, tx => this.lockWithin(tx, async (tx, cap) => {
      const previous = await tx`select body from hv_jobs where project_id = ${projectId} and idempotency_key = ${input.idempotencyKey}`;
      assertDialogueIdempotency(previous[0]?.body as Job|undefined,input);
      assertSoundIdempotency(previous[0]?.body as Job|undefined,input);
      assertEditIdempotency(previous[0]?.body as Job|undefined,input);
      assertEditAssemblyIdempotency(previous[0]?.body as Job|undefined,input);
      assertLivingScriptIdempotency(previous[0]?.body as Job|undefined,input);
      assertCurrentFilmIdempotency(previous[0]?.body as Job|undefined,input);
      assertGraphicIdempotency(previous[0]?.body as Job|undefined,input);
      assertDeliveryIdempotency(previous[0]?.body as Job|undefined,input);
      if(previous.length&&(input.shotTakes||isTakeStage(previous[0].body.stage))&&(previous[0].body.stage!==input.stage||previous[0].body.shotTakes?.revision!==input.shotTakes?.revision))throw new Error("The idempotency key belongs to a different take plan or render stage.");
      if (previous.length&&!input.assemblyEdit) return previous[0].body as Job;
      const rows = await tx`select body, taken_down_at from hv_projects where id = ${projectId} for update`;
      const project = rows[0]?.body as PersistedProject | undefined;
      validateLivingScriptJob(input,previous.length?undefined:Date.now());
      validateDialogueJob(input);
      validateSoundJob(input,Date.now());
      validateEditJob(input,Date.now());
      validateEditAssemblyJob(input,previous.length?undefined:Date.now());
      validateGraphicJob(input);
      validateDeliveryJob(input);
      if(input.assemblyEdit){assertEditAssemblyPermission(input.assemblyEdit,rows[0]?.taken_down_at?undefined:project);
        const existing=previous[0]?.body as Job|undefined,retained=existing?.assemblyCheckpoint??existing?.output;
        if(!existing&&!project?.assemblyLibrary?.assemblies.some(assembly=>assembly.id===input.assemblyEdit!.assembly.id&&contentHash(assembly)===contentHash(input.assemblyEdit!.assembly)))throw new Error("Choose the current saved accepted assembly before admission.");
        if(existing&&retained)validateEditAssemblyOutput(existing,retained);else await this.assemblySources(tx,projectId,input.assemblyEdit);
        if(existing)return existing;
        await this.reserveWithin(tx,cap,input.id,input.stage,0,monthlyCapUsd,new Date(),projectId);return new PostgresJobStore(this.database).enqueueWithin(tx,input);
      }
      if(input.graphicRender){assertGraphicPermission(input.graphicRender,rows[0]?.taken_down_at?undefined:project);await this.reserveWithin(tx,cap,input.id,input.stage,0,monthlyCapUsd,new Date(),projectId);return new PostgresJobStore(this.database).enqueueWithin(tx,input);}
      if(input.delivery){assertDeliveryPermission(input.delivery,rows[0]?.taken_down_at?undefined:project);
        const origin=(await tx`select body from hv_jobs where id=${input.delivery.binding.source.jobId} and project_id=${projectId} for share`)[0]?.body as Job|undefined;
        assertDeliverySourceAvailable(input.delivery.binding,origin);
        await this.reserveWithin(tx,cap,input.id,input.stage,0,monthlyCapUsd,new Date(),projectId);return new PostgresJobStore(this.database).enqueueWithin(tx,input);}
      if(input.pictureEdit){assertEditPermission(input.pictureEdit,rows[0]?.taken_down_at?undefined:project);
        for(const binding of input.pictureEdit.bindings){const source=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${projectId} for share`)[0]?.body as Job|undefined;assertEditBindingAvailable(binding,source);
          if(input.pictureEdit.storage==="s3"){const files=await tx`select key,sha256,bytes from hv_artifacts where project_id=${projectId} and job_id=${binding.owner.jobId}`;for(const file of binding.files)if(!files.some((f:{key:string;sha256:string;bytes:number})=>f.key===file.path&&f.sha256===file.sha256&&Number(f.bytes)===file.bytes))throw new Error("An editorial source changed before admission.");}
        }
        await this.reserveWithin(tx,cap,input.id,input.stage,0,monthlyCapUsd,new Date(),projectId);return new PostgresJobStore(this.database).enqueueWithin(tx,input);
      }
      if(input.soundMix){const source=(await tx`select body from hv_jobs where id=${input.soundMix.source.jobId} and project_id=${projectId} for share`)[0]?.body as Job|undefined;
        assertSoundSourceAvailable(input.soundMix,source);assertSoundPermission(input.soundMix,rows[0]?.taken_down_at?undefined:project);
        if(input.soundMix.storage==="s3")for(const {file}of input.soundMix.source.files){const record=(await tx`select sha256,bytes from hv_artifacts where project_id=${projectId} and job_id=${source!.id} and key=${file.path}`)[0];if(!record||record.sha256!==file.sha256||Number(record.bytes)!==file.bytes)throw new Error("The retained sound source media changed before admission.");}
        await this.reserveWithin(tx,cap,input.id,input.stage,0,monthlyCapUsd,new Date(),projectId);return new PostgresJobStore(this.database).enqueueWithin(tx,input);
      }
      if(input.dialogueReplacement){
        const source=(await tx`select body from hv_jobs where id=${dialogueSourceJobId(input)} and project_id=${projectId} for share`)[0]?.body as Job|undefined;
        assertDialogueSourceAvailable(input,source);assertDialogueAccess(input.dialogueReplacement.source,rows[0]?.taken_down_at?undefined:project,Date.now(),input.dialogueReplacement.plan.baseline);
        await assertDialogueAuditionInputs(input,project,async id=>(await tx`select body from hv_jobs where id=${id} and project_id=${projectId} for share`)[0]?.body as Job|undefined);
        for(const file of [...Object.values(input.dialogueReplacement.plan.baseline?.files??input.dialogueReplacement.plan.sourceFiles),...(input.dialogueReplacement.plan.baseline?.auditionFiles??[])]){
          const recorded=(await tx`select sha256,bytes from hv_artifacts where project_id=${projectId} and job_id=${source!.id} and key=${file.path}`)[0];
          if(input.dialogueReplacement.storage==="s3"&&(!recorded||recorded.sha256!==file.sha256||Number(recorded.bytes)!==file.bytes))throw new Error("The pinned dialogue source media changed before admission.");
        }
        if(input.dialogueReplacement.storage==="s3")for(const receipt of dialogueAuditionInputs(input.dialogueReplacement.plan))for(const file of receipt.output.files){
          const recorded=(await tx`select sha256,bytes from hv_artifacts where project_id=${projectId} and job_id=${receipt.jobId} and key=${file.path}`)[0];
          if(!recorded||recorded.sha256!==file.sha256||Number(recorded.bytes)!==file.bytes)throw new Error("The pinned audition media changed before admission.");
        }
        await this.reserveWithin(tx,cap,input.id,input.stage,0,monthlyCapUsd,new Date(),projectId);return new PostgresJobStore(this.database).enqueueWithin(tx,input);
      }
      if(input.livingScript){
        await assertLivingScriptTransaction(tx,input,rows[0]?.taken_down_at?undefined:project);
        await this.assertFilmWithin(tx,projectId,amount,filmCapUsd);
        await this.reserveWithin(tx,cap,input.id,input.stage,amount,monthlyCapUsd,new Date(),projectId);
        return new PostgresJobStore(this.database).enqueueWithin(tx,input);
      }
      if(input.currentFilm){
        validateCurrentFilmJob(input,Date.now());await assertCurrentFilmTransaction(tx,input,rows[0]?.taken_down_at?undefined:project);
        await this.assertFilmWithin(tx,projectId,amount,filmCapUsd);
        await this.reserveWithin(tx,cap,input.id,input.stage,amount,monthlyCapUsd,new Date(),projectId);
        return new PostgresJobStore(this.database).enqueueWithin(tx,input);
      }
      const latest = project?.versions.at(-1);
      if (!project || rows[0].taken_down_at || Date.parse(project.deleteAfter) <= Date.now() || !project.rightsAttestedAt
        || latest?.version !== input.scriptVersion || latest.text !== input.scriptText) throw new Error("the screenplay changed; reload before starting generation");
      const casting = currentCasting(projectId, project.castingHistory);
      if (!castingMatches(input.casting, casting)) throw new Error("The cast changed; reload before starting generation.");
      const direction=currentDirection(projectId,project.directionHistory);
      if(isTakeStage(input.stage)!==Boolean(input.shotTakes)||(input.shotTakes&&(input.characterSheet||input.shotTakes.maxShots!==TIERS[input.tier].maxShots)))throw new Error("Invalid take-group admission.");
      if(input.stage!=="character-sheet") {
        if(!directionMatches(input.direction,direction))throw new Error("The shot directions changed; reload before starting generation.");
        for(const entry of direction.entries)assertFrameAnchorCatalog(entry.settings.frameAnchors,projectId,project.referenceAssets??[]);
        if(input.shotTakes){shotTakeShots(input.shotTakes,casting,parseFountain(input.scriptText),direction,input.scriptVersion);assertTakeCatalog(input.shotTakes,project.referenceAssets??[]);}
        else {const parsed=parseFountain(input.scriptText),shots=sourcePlan(parsed,direction,7000,TIERS[input.tier].maxShots);assertPictureDirections(shots,parsed,casting,direction);directShots(shots,direction);}
      }else if(input.direction)throw new Error("Character sheets cannot carry film shot directions.");
      if((input.stage==="character-sheet")!==Boolean(input.characterSheet))throw new Error("Invalid character sheet admission.");
      if(input.characterSheet)characterSheetShots(input.characterSheet,casting,parseFountain(input.scriptText));
      if (input.stage === "final"||input.stage==="take-final") {
        const approval = project.animaticApprovals.find(value => value.animaticJobId === input.animaticJobId);
        const animatic = (await tx`select body from hv_jobs where id = ${input.animaticJobId}`)[0]?.body as Job | undefined;
        if(animatic?.livingScript||approval?.livingScriptReview||animatic?.currentFilm||approval?.currentFilmReview)throw new Error("A screenplay-specific preview cannot approve an ordinary final film.");
        if (!approval || approval.decision !== "approved" || approval.scriptVersion !== input.scriptVersion
          || !animatic || animatic.projectId!==projectId || animatic.stage !== (input.shotTakes?"take-preview":"animatic") || animatic.status !== "done" || animatic.scriptVersion !== input.scriptVersion
          || !castingMatches(animatic.casting, casting) || (approval.castingVersion ?? 0) !== casting.version
          || (casting.version > 0 && approval.castingRevision !== casting.revision))
          throw new Error("a finished animatic for the current screenplay must be approved");
        if(input.shotTakes&&(animatic.shotTakes?.revision!==input.shotTakes.revision||approval.takeRevision!==input.shotTakes.revision||input.animaticApprovedAt!==approval.at))throw new Error("Approve this exact take group before final rendering.");
        if(!input.shotTakes&&approval.takeRevision!==undefined)throw new Error("A take comparison cannot approve a full film.");
        if(!directionMatches(animatic.direction,direction)||(approval.directionVersion??0)!==direction.version||(direction.version>0&&approval.directionRevision!==direction.revision))throw new Error("Approve a new animatic for the current shot directions.");
      }
      if(input.shotReuse){validateReusePlan(input.shotReuse,input);for(const record of input.shotReuse.shots){const source=(await tx`select body from hv_jobs where project_id=${projectId} and id=${record.jobId} for share`)[0]?.body as Job|undefined;if(!source)throw new ShotReuseError("The reusable source job disappeared.");sourceRenderRecord(source,record);}}
      await this.assertFilmWithin(tx, projectId, amount, filmCapUsd);
      await this.reserveWithin(tx, cap, input.id, input.stage, amount, monthlyCapUsd, new Date(), projectId);
      return new PostgresJobStore(this.database).enqueueWithin(tx, input);
    }, monthlyCapUsd));
  }
  async assertCanSpend(jobId: string, estimateUsd: number): Promise<void> {
    estimateUsd = money(estimateUsd);
    if (estimateUsd === 0) return;
    const rows = await this.database.sql`select remaining_usd -
      (select coalesce(sum(greatest(0, estimated_usd - coalesce(actual_usd, 0))),0) from hv_provider_attempts where job_id = ${jobId} and status in ('running','unknown')) as available
      from hv_reservations where job_id = ${jobId}`;
    if (!rows.length || Number(rows[0].available) + 1e-9 < estimateUsd) throw new BudgetError("this job reached its generation budget");
  }
  async shotCapacity(jobId: string, shotId: string, shotCapUsd: number): Promise<number> {
    shotCapUsd = money(shotCapUsd);
    const rows = await this.database.sql`select
      (select remaining_usd from hv_reservations where job_id = ${jobId}) as remaining,
      (select coalesce(sum(total_usd),0) from hv_cost_events where job_id = ${jobId} and body->>'shotId' = ${shotId}) as shot_spent,
      coalesce(sum(greatest(0, estimated_usd - coalesce(actual_usd,0))),0) as held,
      coalesce(sum(case when shot_id = ${shotId} then greatest(0, estimated_usd - coalesce(actual_usd,0)) else 0 end),0) as shot_held
      from hv_provider_attempts where job_id = ${jobId} and status in ('running','unknown')`;
    const row = rows[0];
    return money(Math.max(0, Math.min(Number(row?.remaining ?? 0) - Number(row?.held ?? 0), shotCapUsd - Number(row?.shot_spent ?? 0) - Number(row?.shot_held ?? 0))));
  }
  async frameAnchorCatalog(projectId:string,now=Date.now()):Promise<ReferenceAsset[]> {
    return this.database.forProject(projectId,async tx=>{
      const row=(await tx`select body from hv_projects where id=${projectId} and taken_down_at is null and delete_after>${new Date(now).toISOString()}`)[0];
      if(!row)throw new FrameAnchorError("Current frame anchor storage is unavailable.");
      return structuredClone((row.body as PersistedProject).referenceAssets??[]);
    });
  }
  async assertReusePermission(job:Job,workerId:string,shot:Shot,now=Date.now()):Promise<void> {
    await this.database.forProject(job.projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null and delete_after>${new Date(now).toISOString()} for share`)[0]?.body as PersistedProject|undefined;
      if(!project)throw new ShotReuseError("Current project permission is unavailable.");
      const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} and project_id=${job.projectId} for share`)[0],current=row?.body as Job|undefined;
      if(!current||current.status!=="running"||current.claimedBy!==workerId||row.lease_version!==job.leaseVersion||!Number.isFinite(Date.parse(current.leaseExpiresAt??""))||Date.parse(current.leaseExpiresAt!)<=now)throw new LeaseError(job.id,"not_running",current?.claimedBy??null);
      assertLivingScriptIdempotency(current,job);await assertLivingScriptTransaction(tx,current,project,now);
      if(!job.casting)throw new ShotReuseError("Reuse requires the admitted cast context.");
      assertCurrentCastPermission(job.casting,currentCasting(job.projectId,project.castingHistory),shot.characterIds??[],shot.sceneIndex+1,now,parseFountain(job.scriptText).scenes[shot.sceneIndex]?.heading);
      assertFrameAnchorCatalog(shot.direction?.frameAnchors,job.projectId,project.referenceAssets??[]);
    });
  }
  async assertCurrentFilmContext(job:Job,workerId:string,now=Date.now()):Promise<void>{
    await this.database.forProject(job.projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
      const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} and project_id=${job.projectId} for share`)[0],current=row?.body as Job|undefined;
      if(!current||current.status!=="running"||current.claimedBy!==workerId||row.lease_version!==job.leaseVersion||!Number.isFinite(Date.parse(current.leaseExpiresAt??""))||Date.parse(current.leaseExpiresAt!)<=now)throw new LeaseError(job.id,"fence_changed",current?.claimedBy??null);
      validateCurrentFilmJob(job);assertCurrentFilmHeldInputs(current,job);await assertCurrentFilmTransaction(tx,current,project,now);
    });
  }
  async assertLivingScriptContext(job:Job,workerId:string,now=Date.now()):Promise<void>{
    await this.database.forProject(job.projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
      const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} and project_id=${job.projectId} for share`)[0],current=row?.body as Job|undefined;
      if(!current||current.status!=="running"||current.claimedBy!==workerId||row.lease_version!==job.leaseVersion||!Number.isFinite(Date.parse(current.leaseExpiresAt??""))||Date.parse(current.leaseExpiresAt!)<=now)throw new LeaseError(job.id,"fence_changed",current?.claimedBy??null);
      if(!job.livingScript)throw new Error("Expected a pending screenplay job.");
      assertLivingScriptIdempotency(current,job);await assertLivingScriptTransaction(tx,current,project,now);
    });
  }
  async assertSoundPermission(job:Job,workerId:string,now=Date.now()):Promise<void>{
    await this.database.forProject(job.projectId,async tx=>{const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
      const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} for share`)[0],current=row?.body as Job|undefined;
      if(!current||current.status!=="running"||current.claimedBy!==workerId||row.lease_version!==job.leaseVersion||Date.parse(current.leaseExpiresAt??"")<=now)throw new LeaseError(job.id,"fence_changed",current?.claimedBy??null);
      if(contentHash(current.soundMix)!==contentHash(job.soundMix))throw new Error("The sound plan changed during processing.");
      const source=(await tx`select body from hv_jobs where id=${job.soundMix!.source.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertSoundSourceAvailable(job.soundMix!,source,now);assertSoundPermission(job.soundMix!,project,now);
    });
  }
  /** HV-025-04: a PostgreSQL worker has no in-process project store; the graphic's permission is read here. */
  async assertGraphicPermission(job:Job,workerId:string,now=Date.now()):Promise<void>{
    await this.database.forProject(job.projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
      const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} and project_id=${job.projectId} for share`)[0],current=row?.body as Job|undefined;
      if(!current||current.status!=="running"||current.claimedBy!==workerId||row.lease_version!==job.leaseVersion||!Number.isFinite(Date.parse(current.leaseExpiresAt??""))||Date.parse(current.leaseExpiresAt!)<=now)throw new LeaseError(job.id,"fence_changed",current?.claimedBy??null);
      if(current.graphicRender?.revision!==job.graphicRender?.revision)throw new Error("The graphic plan changed during processing.");
      assertGraphicPermission(job.graphicRender!,project,now);
    });
  }
  /**
   * HV-027-04: a deliverable is made from a film the project may since have lost the right to hold.
   * The permission it inherits is the source film's project permission, re-read under the same fence
   * every other independent media job uses, so a deliverable cannot be written after a takedown.
   */
  async assertDeliveryPermission(job:Job,workerId:string,now=Date.now()):Promise<void>{
    await this.database.forProject(job.projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
      const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} and project_id=${job.projectId} for share`)[0],current=row?.body as Job|undefined;
      if(!current||current.status!=="running"||current.claimedBy!==workerId||row.lease_version!==job.leaseVersion||!Number.isFinite(Date.parse(current.leaseExpiresAt??""))||Date.parse(current.leaseExpiresAt!)<=now)throw new LeaseError(job.id,"fence_changed",current?.claimedBy??null);
      if(current.delivery?.revision!==job.delivery?.revision)throw new Error("The delivery plan changed during processing.");
      assertDeliveryPermission(job.delivery!,project,now);
      // The film itself, not only the project: a source re-rendered while this job runs is a
      // different film, and the local path already refused it. Both paths refuse it now.
      const origin=(await tx`select body from hv_jobs where id=${job.delivery!.binding.source.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;
      assertDeliverySourceAvailable(job.delivery!.binding,origin);
    });
  }
  async assertEditPermission(job:Job,workerId:string,now=Date.now()):Promise<void>{
    await this.database.forProject(job.projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
      const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} and project_id=${job.projectId} for share`)[0],current=row?.body as Job|undefined;
      if(!current||current.status!=="running"||current.claimedBy!==workerId||row.lease_version!==job.leaseVersion||!Number.isFinite(Date.parse(current.leaseExpiresAt??""))||Date.parse(current.leaseExpiresAt!)<=now)throw new LeaseError(job.id,"fence_changed",current?.claimedBy??null);
      if(contentHash(current.pictureEdit)!==contentHash(job.pictureEdit))throw new Error("The editorial plan changed during processing.");assertEditPermission(job.pictureEdit!,project,now);
      // A fenced checkpoint owns its original media independently of prior job retention.
      if(current.editCheckpoint)validateEditOutput(current,current.editCheckpoint);else for(const binding of job.pictureEdit!.bindings){const source=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertEditBindingAvailable(binding,source,now);}
    });
  }
  private async assemblySources(tx:SQL,projectId:string,plan:EditAssemblyRenderPlan,now=Date.now()):Promise<void>{
    for(const binding of plan.bindings.slice().sort((a,b)=>a.owner.jobId.localeCompare(b.owner.jobId))){
      const source=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${projectId} for share`)[0]?.body as Job|undefined;assertEditBindingAvailable(binding,source,now);
      if(plan.storage==="s3"){const files=await tx`select key,sha256,bytes from hv_artifacts where project_id=${projectId} and job_id=${binding.owner.jobId}`;for(const file of binding.files)if(!files.some((f:{key:string;sha256:string;bytes:number})=>f.key===file.path&&f.sha256===file.sha256&&Number(f.bytes)===file.bytes))throw new Error("An assembly source artifact changed.");}
    }
  }
  async assertAssemblyContext(job:Job,workerId:string,now=Date.now()):Promise<void>{
    await this.database.forProject(job.projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
      const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} and project_id=${job.projectId} for share`)[0],current=row?.body as Job|undefined;
      if(!current||current.status!=="running"||current.claimedBy!==workerId||row.lease_version!==job.leaseVersion||!Number.isFinite(Date.parse(current.leaseExpiresAt??""))||Date.parse(current.leaseExpiresAt!)<=now)throw new LeaseError(job.id,"fence_changed",current?.claimedBy??null);
      validateEditAssemblyJob(current);if(!job.assemblyEdit||contentHash(current.assemblyEdit)!==contentHash(job.assemblyEdit))throw new Error("The assembly plan changed during processing.");assertEditAssemblyPermission(job.assemblyEdit,project,now);
      if(current.assemblyCheckpoint)validateEditAssemblyOutput(current,current.assemblyCheckpoint);else await this.assemblySources(tx,job.projectId,job.assemblyEdit,now);
    });
  }
  async assertDialoguePermission(job:Job,workerId:string,now=Date.now()):Promise<void>{
    await this.database.forProject(job.projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
      const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} for share`)[0],current=row?.body as Job|undefined;
      if(!current||current.status!=="running"||current.claimedBy!==workerId||row.lease_version!==job.leaseVersion||Date.parse(current.leaseExpiresAt??"")<=now||!Number.isFinite(Date.parse(current.leaseExpiresAt??"")))throw new LeaseError(job.id,"not_running",current?.claimedBy??null);
      validateDialogueJob(job,now);if(!job.dialogueReplacement)throw new Error("Expected a dialogue job.");
      const source=(await tx`select body from hv_jobs where project_id=${job.projectId} and id=${dialogueSourceJobId(job)} for share`)[0]?.body as Job|undefined;
      assertDialogueSourceAvailable(job,source,now);assertDialogueAccess(job.dialogueReplacement.source,project,now,job.dialogueReplacement.plan.baseline);
      await assertDialogueAuditionInputs(job,project,async id=>(await tx`select body from hv_jobs where id=${id} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined,now);
    });
  }
  async beginAttempt(attempt: ProviderAttempt, now = Date.now()): Promise<void> {
    const estimate = money(attempt.estimateUsd);
    await this.locked(async tx => {
      const project = (await tx`select id, body from hv_projects where id = ${attempt.projectId} and taken_down_at is null
        and delete_after > ${new Date(now).toISOString()} for share`)[0];
      if (!project) throw new BudgetError("project is unavailable or expired");
      const rows = await tx`select body, lease_version from hv_jobs where id = ${attempt.jobId} for update`;
      const job = rows[0]?.body as Job | undefined;
      if (!job || job.projectId !== attempt.projectId) throw new Error("unknown provider job");
      assertCurrentFilmMode(job);
      if(job.audioTake)throw new BudgetError("Audio dispatch requires its admitted audio journal.");
      if(job.lipSync)throw new BudgetError("Lip-sync dispatch requires its admitted journal.");
      if(job.graphicRender)throw new BudgetError("Graphics do not dispatch providers.");
      if(job.pictureEdit)throw new BudgetError("Editorial renders do not dispatch providers.");
      if(job.assemblyEdit||job.stage==="assembly-edit")throw new BudgetError("Assembly renders do not dispatch providers.");
      if (job.status !== "running") throw new LeaseError(job.id, "not_running", job.claimedBy);
      if (job.claimedBy !== attempt.workerId) throw new LeaseError(job.id, "wrong_worker", job.claimedBy);
      if (rows[0].lease_version !== attempt.leaseVersion) throw new LeaseError(job.id, "fence_changed", job.claimedBy);
      if (!job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= now) throw new LeaseError(job.id, "lease_expired", job.claimedBy);
      await assertLivingScriptTransaction(tx,job,project.body as PersistedProject,now);
      await assertCurrentFilmTransaction(tx,job,project.body as PersistedProject,now);
      if(job.currentFilm){
        const slot=validateCurrentFilmJob(job).materialization.slots.find(value=>value.renderId===attempt.shotId);
        if(!slot)throw new Error("The dispatch does not name an admitted current-film slot.");
        assertFrameAnchorCatalog(slot.shot.direction?.frameAnchors,job.projectId,(project.body as PersistedProject).referenceAssets??[]);
      }
      try{assertFrameAnchorCatalog((job.shotTakes?.takes.find(t=>t.id===attempt.shotId)?.settings??job.direction?.entries.find(e=>e.source.id===attempt.shotId)?.settings)?.frameAnchors,job.projectId,(project.body as PersistedProject).referenceAssets??[]);}
      catch(error){throw new FrameAnchorError((error as Error).message);}
      if (!job.currentFilm&&job.casting?.characters.length) {
        const parsed = parseFountain(job.scriptText), shot = (job.shotTakes ? shotTakeShots(job.shotTakes,job.casting,parsed,job.direction!,job.scriptVersion,now) : job.characterSheet ? characterSheetShots(job.characterSheet,job.casting,parsed,now) : sourcePlan(parsed,job.direction,7000,TIERS[job.tier].maxShots)).find(value => value.id === attempt.shotId);
        if (!shot) throw new Error("The dispatch does not name a planned shot.");
        const current=currentCasting(job.projectId,(project.body as PersistedProject).castingHistory);
        if(job.characterSheet)assertSheetDispatch(job.characterSheet,job.casting,current,shot.id,parsed,now);
        else assertCurrentCastPermission(job.casting,current,charactersForScene(job.casting,shot.sceneIndex,parsed).map(character=>character.id),shot.sceneIndex+1,now,parsed.scenes[shot.sceneIndex]?.heading);
      }
      if (job.providerPlan && !attempt.routeDecisionId) throw new BudgetError("Provider dispatch requires a saved route.");
      if (attempt.routeDecisionId) {
        const decision = job.routeDecisions?.find(value => value.id === attempt.routeDecisionId);
        const selected = decision?.candidates.find(value => value.id === decision.selectedId);
        if (!decision || decision.shotId !== attempt.shotId || !selected?.eligible || selected.provider !== attempt.provider || selected.model !== attempt.model
          || selected.capabilityRevision !== attempt.capabilityRevision || selected.estimateUsd !== estimate)
          throw new BudgetError("Provider route does not match its dispatch.");
        if ((await tx`select id from hv_provider_attempts where job_id = ${attempt.jobId} and body->>'routeDecisionId' = ${attempt.routeDecisionId} limit 1`).length)
          throw new BudgetError("Provider route has already been dispatched.");
      }
      const shotCap = job.providerPlan?.maxShotUsd ?? attempt.shotCapUsd;
      if (shotCap !== undefined) {
        const limit = money(shotCap);
        const totals = (await tx`select
          (select coalesce(sum(total_usd),0) from hv_cost_events where job_id = ${attempt.jobId} and body->>'shotId' = ${attempt.shotId}) as spent,
          coalesce(sum(greatest(0, estimated_usd - coalesce(actual_usd,0))),0) as held
          from hv_provider_attempts where job_id = ${attempt.jobId} and shot_id = ${attempt.shotId} and status in ('running','unknown')`)[0];
        if (Number(totals.spent) + Number(totals.held) + estimate > limit + 1e-9) throw new BudgetError("this shot reached its generation budget");
      }
      const existing = await tx`select job_id, worker_id, lease_version, provider, estimated_usd from hv_provider_attempts where id = ${attempt.id}`;
      if (existing.length) {
        const prior = existing[0];
        if (prior.job_id !== attempt.jobId || prior.worker_id !== attempt.workerId || prior.lease_version !== attempt.leaseVersion
          || prior.provider !== attempt.provider || Number(prior.estimated_usd) !== estimate) throw new BudgetError("provider attempt changed");
        throw new BudgetError("provider attempt has already been dispatched");
      }
      const budget = await tx`select remaining_usd -
        (select coalesce(sum(greatest(0, estimated_usd - coalesce(actual_usd, 0))),0) from hv_provider_attempts where job_id = ${attempt.jobId} and status in ('running','unknown')) as available
        from hv_reservations where job_id = ${attempt.jobId}`;
      if (!budget.length || Number(budget[0].available) + 1e-9 < estimate) throw new BudgetError("this job reached its generation budget");
      await tx`insert into hv_provider_attempts (id, project_id, job_id, shot_id, provider, worker_id, lease_version, status, estimated_usd, body)
        values (${attempt.id}, ${attempt.projectId}, ${attempt.jobId}, ${attempt.shotId}, ${attempt.provider},
        ${attempt.workerId}, ${attempt.leaseVersion}, 'running', ${estimate}, ${{routeDecisionId: attempt.routeDecisionId, model: attempt.model, capabilityRevision: attempt.capabilityRevision, shotCapUsd: shotCap}}::jsonb)`;
      await tx`insert into hv_outbox (id, project_id, job_id, event_type, body)
        values (${crypto.randomUUID()}, ${attempt.projectId}, ${attempt.jobId}, 'provider.dispatched',
        ${{attemptId: attempt.id, shotId: attempt.shotId, provider: attempt.provider, estimateUsd: estimate}}::jsonb)`;
    });
  }
  /** A late acknowledgement remains useful after lease loss or content deletion. */
  async attachRequest(id: string, workerId: string, leaseVersion: number, value: ProviderRequestReceipt): Promise<void> {
    const receipt = validateProviderReceipt(value);
    await this.locked(async tx => {
      const row = (await tx`select project_id,job_id,worker_id,lease_version,request_id,body from hv_provider_attempts where id = ${id} for update`)[0];
      if (!row || row.worker_id !== workerId || row.lease_version !== leaseVersion) throw new BudgetError("provider receipt does not match its dispatch");
      if(row.body.audio||row.body.lipSync)throw new BudgetError("Performance jobs cannot accept a video provider receipt.");
      const existing = row.body.request as ProviderRequestReceipt | undefined;
      if (row.request_id && (!existing || row.request_id !== receipt.requestId
        || JSON.stringify(validateProviderReceipt(existing)) !== JSON.stringify(receipt))) throw new BudgetError("provider request receipt changed");
      if ((await tx`select id from hv_provider_attempts where request_id = ${receipt.requestId} and id <> ${id} limit 1`).length)
        throw new BudgetError("provider request is already assigned to another attempt");
      await tx`update hv_provider_attempts set request_id = ${receipt.requestId},
        body = jsonb_set(body,'{request}',${receipt}::jsonb),updated_at = now() where id = ${id}`;
      if (!row.request_id) await tx`insert into hv_outbox (id,project_id,job_id,event_type,body)
        values (${crypto.randomUUID()},${row.project_id},${row.job_id},'provider.request_received',${{attemptId:id,requestId:receipt.requestId}}::jsonb)`;
    });
  }
  async finishAttempt(id: string, outcome: "succeeded" | "failed" | "unknown"): Promise<void> {
    await this.locked(async tx => {
      const rows = await tx`select project_id, job_id, body from hv_provider_attempts where id = ${id} and status in ('running', 'unknown') for update`;
      if (!rows.length) return;
      if(rows[0].body.audio)throw new BudgetError("Audio requires explicit billing reconciliation.");
      if(rows[0].body.lipSync)throw new BudgetError("Lip-sync requires explicit billing reconciliation.");
      const costs = await tx`select coalesce(sum(total_usd),0) as total from hv_cost_events where attempt_id = ${id}`;
      await tx`update hv_provider_attempts set status = ${outcome}, actual_usd = ${Number(costs[0].total)},
        updated_at = now() where id = ${id}`;
      await tx`insert into hv_outbox (id, project_id, job_id, event_type, body)
        values (${crypto.randomUUID()}, ${rows[0].project_id}, ${rows[0].job_id}, 'provider.settled',
        ${{attemptId: id, outcome, costUsd: Number(costs[0].total)}}::jsonb)`;
    });
  }
  /** The event key is stable across retries; a late bill is recorded even after lease loss. */
  async record(event: CostEvent): Promise<void> { await this.recordForJob(event); }
  async recordForJob(event: CostEvent): Promise<Job | undefined> {
    const cost = money(event.total_cost_usd);
    if (!Number.isFinite(new Date(event.at).getTime())) throw new BudgetError("invalid cost timestamp");
    return this.locked(async tx => {
      if(event.stage==="audio-take"||(event.attemptId&&(await tx`select id from hv_provider_attempts where id=${event.attemptId} and body ? 'audio'`).length))throw new BudgetError("Audio costs require invoice allocation evidence.");
      if(event.stage==="motion-graphic"||(event.jobId&&(await tx`select id from hv_jobs where id=${event.jobId} and stage='motion-graphic'`).length))throw new BudgetError("Graphics do not incur provider costs.");
      if(event.stage==="picture-edit"||(event.jobId&&(await tx`select id from hv_jobs where id=${event.jobId} and stage='picture-edit'`).length))throw new BudgetError("Editorial renders do not incur provider costs.");
      if(event.stage==="assembly-edit"||(event.jobId&&(await tx`select id from hv_jobs where id=${event.jobId} and stage='assembly-edit'`).length))throw new BudgetError("Assembly renders do not incur provider costs.");
      if(event.stage==="delivery"||(event.jobId&&(await tx`select id from hv_jobs where id=${event.jobId} and stage='delivery'`).length))throw new BudgetError("Deliverables do not incur provider costs.");
      if(event.stage==="sound-mix"||(event.jobId&&(await tx`select id from hv_jobs where id=${event.jobId} and stage='sound-mix'`).length))throw new BudgetError("Sound sessions do not incur provider costs.");
      if(event.jobId&&((await tx`select id from hv_jobs where id=${event.jobId} and stage='audio-take'`).length||(await tx`select id from hv_provider_attempts where job_id=${event.jobId} and body ? 'audio'`).length))throw new BudgetError("Audio costs require invoice allocation evidence.");
      if(event.stage==="lip-sync"||(event.attemptId&&(await tx`select id from hv_provider_attempts where id=${event.attemptId} and body ? 'lipSync'`).length)||(event.jobId&&((await tx`select id from hv_jobs where id=${event.jobId} and stage='lip-sync'`).length||(await tx`select id from hv_provider_attempts where job_id=${event.jobId} and body ? 'lipSync'`).length)))throw new BudgetError("Lip-sync costs require invoice allocation evidence.");
      const inserted = await tx`insert into hv_cost_events
        (id, event_key, project_id, job_id, attempt_id, stage, provider, total_usd, body, created_at)
        values (${crypto.randomUUID()}, ${event.eventId ?? crypto.randomUUID()}, ${event.projectId}, ${event.jobId ?? null},
        ${event.attemptId ?? null}, ${event.stage ?? null}, ${event.provider}, ${cost}, ${event}::jsonb, ${event.at})
        on conflict (event_key) do nothing returning id`;
      if (!inserted.length && event.eventId) {
        const prior = (await tx`select body from hv_cost_events where event_key = ${event.eventId}`)[0]?.body as CostEvent | undefined;
        if (!prior || prior.projectId !== event.projectId || prior.jobId !== event.jobId || prior.attemptId !== event.attemptId
          || prior.provider !== event.provider || prior.model !== event.model || money(prior.total_cost_usd) !== cost)
          throw new BudgetError("a billing event key was reused with different details");
      }
      if (!event.jobId) return undefined;
      const rows = await tx`select body from hv_jobs where id = ${event.jobId} for update`;
      if (rows.length && (rows[0].body as Job).projectId !== event.projectId) throw new BudgetError("billing project does not match the job");
      if (!inserted.length) return rows[0]?.body;
      if (event.attemptId) {
        // Accounted costs consume an attempt's hold. The remaining unknown liability stays reserved.
        await tx`update hv_provider_attempts set actual_usd = coalesce(actual_usd, 0) + ${cost},
          updated_at = now() where id = ${event.attemptId}`;
      }
      const reservation = (await tx`select body from hv_reservations where job_id = ${event.jobId}`)[0]?.body as BudgetReservation | undefined;
      if (reservation) {
        reservation.remainingUsd = money(Math.max(0, reservation.remainingUsd - cost));
        await tx`update hv_reservations set remaining_usd = ${reservation.remainingUsd}, body = ${reservation}::jsonb where job_id = ${event.jobId}`;
      }
      if (!rows.length) return undefined;
      const job = rows[0].body as Job;
      const total = await tx`select coalesce(sum(total_usd), 0) as total from hv_cost_events where job_id = ${event.jobId}`;
      job.cost = event;
      job.costUsd = Number(total[0].total);
      const attemptBody = event.attemptId ? (await tx`select body from hv_provider_attempts where id = ${event.attemptId}`)[0]?.body : undefined;
      const shotCap = job.providerPlan?.maxShotUsd ?? attemptBody?.shotCapUsd;
      const shotSpent = shotCap !== undefined && event.shotId
        ? Number((await tx`select coalesce(sum(total_usd),0) as total from hv_cost_events where job_id = ${job.id} and body->>'shotId' = ${event.shotId}`)[0].total) : 0;
      const shotExceeded = shotCap !== undefined && shotSpent > shotCap + 1e-9;
      if ((job.costUsd > job.costCapUsd || shotExceeded) && ["running", "queued"].includes(job.status)) {
        job.status = "cancelled"; job.claimedBy = null; job.leaseExpiresAt = null;
        job.completedAt = new Date().toISOString();
        job.cancelReason = shotExceeded ? `shot cost $${shotSpent.toFixed(2)} exceeded per-shot cap $${Number(shotCap).toFixed(2)}`
          : `cost $${job.costUsd.toFixed(2)} exceeded per-job cap $${job.costCapUsd.toFixed(2)}`;
        notify(job, costCapCancelNotice(job.cancelReason));
      }
      await tx`update hv_jobs set body = ${job}::jsonb, status = ${job.status}, claimed_by = ${job.claimedBy},
        lease_expires_at = ${job.leaseExpiresAt}, updated_at = now() where id = ${job.id}`;
      return job;
    });
  }
  protected async releaseIn(tx: SQL, jobId: string): Promise<void> {
    const holding = await tx`select coalesce(sum(greatest(0, estimated_usd - coalesce(actual_usd, 0))),0) as total from hv_provider_attempts
      where job_id = ${jobId} and status in ('running','unknown')`;
    const held = Number(holding[0].total);
    if (held === 0) { await tx`delete from hv_reservations where job_id = ${jobId}`; return; }
    const reservation = (await tx`select body from hv_reservations where job_id = ${jobId}`)[0]?.body as BudgetReservation | undefined;
    if (reservation) {
      reservation.remainingUsd = money(Math.min(reservation.remainingUsd, held));
      await tx`update hv_reservations set remaining_usd = ${reservation.remainingUsd}, body = ${reservation}::jsonb where job_id = ${jobId}`;
    }
  }
  async release(jobId: string): Promise<void> { await this.locked(tx => this.releaseIn(tx, jobId)); }
  async reconcile(activeJobIds: Set<string>, graceMs = 60_000, now = Date.now()): Promise<void> {
    await this.locked(async tx => {
      const rows = await tx`select job_id from hv_reservations where created_at < ${new Date(now - graceMs).toISOString()}`;
      for (const row of rows) if (!activeJobIds.has(row.job_id)) await this.releaseIn(tx, row.job_id);
    });
  }
  async reservedUsd(): Promise<number> {
    return Number((await this.database.sql`select coalesce(sum(remaining_usd),0) as total from hv_reservations`)[0].total);
  }
  async shotSpend(jobId:string,shotId:string):Promise<number>{return Number((await this.database.sql`select coalesce(sum(total_usd),0) as total from hv_cost_events where job_id=${jobId} and body->>'shotId'=${shotId}`)[0].total);}
  async jobSpend(jobId: string): Promise<number> {
    return Number((await this.database.sql`select coalesce(sum(total_usd),0) as total from hv_cost_events where job_id = ${jobId}`)[0].total);
  }
  async all(): Promise<CostEvent[]> {
    return (await this.database.sql`select body from hv_cost_events order by created_at,id`).map((row: {body: CostEvent}) => row.body);
  }
  /** The PostgreSQL half of the same window; see FAIR_SHARE_WINDOW_MS. */
  async fairShareWeights(now = Date.now()): Promise<Record<string, number>> {
    const rows = await this.database.sql`select project_id, sum((body->>'gpu_seconds')::numeric) as seconds
      from hv_cost_events where created_at >= ${new Date(now - FAIR_SHARE_WINDOW_MS).toISOString()} group by project_id`;
    return Object.fromEntries(rows.map((row: {project_id: string; seconds: string}) => [row.project_id, Number(row.seconds)]));
  }
  async rollup(period: "day" | "week" | "month", now = new Date()): Promise<{totalUsd: number; byProvider: Record<string, number>; jobs: number}> {
    const ms = period === "day" ? 864e5 : period === "week" ? 6048e5 : 2592e6;
    const rows = await this.database.sql`select provider, sum(total_usd) as total, count(*)::int as count from hv_cost_events
      where created_at >= ${new Date(now.getTime() - ms).toISOString()} group by provider`;
    return {totalUsd: rows.reduce((sum: number, row: {total: string}) => sum + Number(row.total), 0),
      byProvider: Object.fromEntries(rows.map((row: {provider: string; total: string}) => [row.provider, Number(row.total)])),
      jobs: rows.reduce((sum: number, row: {count: number}) => sum + row.count, 0)};
  }
  async monthSpend(now = new Date()): Promise<number> { return (await this.rollup("month", now)).totalUsd; }
}
