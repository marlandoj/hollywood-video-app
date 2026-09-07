import type {SQL} from "bun";
import type {Job,JobInput} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";
import {LeaseError} from "../../queue/src/index";
import {BudgetError,type CostEvent,type BudgetReservation} from "../../operator/src/index";
import {PostgresCostLedger} from "./ledger";
import {PostgresJobStore} from "./jobs";
import {contentHash} from "../../generator/src/capabilities";
import {validateAudioInvoice,validateAudioAllocation,type AudioInvoice,type AudioAllocation} from "./audio-ledger";
import {validateLipSyncIntent,validateLipSyncReceipt,assertLipSyncObservation,type LipSyncIntent,type LipSyncJournal,type LipSyncReceipt,type LipSyncReservation} from "../../generator/src/sync-lipsync";
import {assertLipSyncIdempotency,assertLipSyncPermission,assertLipSyncSourceAvailable,validateLipSyncJob,validateLipSyncPrepared} from "../../planner/src/lipsync";
import {lipDate,lipHash,lipId,lipNumber,lipRecord,lipSame,validateLipSyncPolicy,type LipSyncPolicy} from "../../planner/src/lipsync-policy";

export type LipSyncPolicyLookup=()=>LipSyncPolicy|undefined|Promise<LipSyncPolicy|undefined>;
export interface LipSyncInvoice extends Omit<AudioInvoice,"schema"> {schema:"hv-lipsync-invoice-allocation/1"}
export interface LipSyncAllocation extends Omit<AudioAllocation,"schema"> {schema:"hv-lipsync-allocation/1"}
export interface StoredLipSyncAttempt {id:string;projectId:string;jobId:string;shotId:string;workerId:string;leaseVersion:number;status:"running"|"unknown"|"succeeded"|"failed";estimatedUsd:number;actualUsd:number|null;createdAt:string;updatedAt:string;
  lipSync:{schema:"hv-lipsync-attempt/1";intent:LipSyncIntent;reservation:LipSyncReservation;accountRevision:string;policyRevision:string;receipt?:LipSyncReceipt;invoice?:LipSyncAllocation}}
export function validateLipSyncInvoice(value:LipSyncInvoice):LipSyncInvoice{
  const {revision,...data}=value;if(value.schema!=="hv-lipsync-invoice-allocation/1"||lipHash(revision)!==contentHash(data))throw new BudgetError("The lip-sync invoice changed.");
  const audio={...data,schema:"hv-audio-invoice-allocation/1" as const};validateAudioInvoice({...audio,revision:contentHash(audio)});return structuredClone(value);
}
export function validateLipSyncAllocation(value:LipSyncAllocation):LipSyncAllocation{
  const {revision,...data}=value;if(value.schema!=="hv-lipsync-allocation/1"||lipHash(revision)!==contentHash(data))throw new BudgetError("The scoped lip-sync invoice changed.");
  const audio={...data,schema:"hv-audio-allocation/1" as const};validateAudioAllocation({...audio,revision:contentHash(audio)});return structuredClone(value);
}
export function validateStoredLipSyncAttempt(a:StoredLipSyncAttempt):StoredLipSyncAttempt{
  lipRecord(a,["id","projectId","jobId","shotId","workerId","leaseVersion","status","estimatedUsd","actualUsd","createdAt","updatedAt","lipSync"]);lipRecord(a.lipSync,["schema","intent","reservation","accountRevision","policyRevision","receipt","invoice"]);validateLipSyncIntent(a.lipSync.intent);
  [a.id,a.projectId,a.jobId,a.shotId].forEach(lipId);if(typeof a.workerId!=="string"||!/^[A-Za-z0-9_.:-]{1,128}$/.test(a.workerId))throw new BudgetError("Invalid original lip-sync worker.");lipNumber(a.leaseVersion,1,Number.MAX_SAFE_INTEGER,"Original lease",true);lipDate(a.createdAt);lipDate(a.updatedAt);lipHash(a.lipSync.accountRevision);lipHash(a.lipSync.policyRevision);lipRecord(a.lipSync.reservation,["id","priceRevision","heldUsd"]);lipHash(a.lipSync.reservation.priceRevision);
  lipNumber(a.estimatedUsd,.000001,1000000,"Original lip-sync hold");if(a.estimatedUsd!==Number(a.estimatedUsd.toFixed(6))||a.lipSync.schema!=="hv-lipsync-attempt/1"||a.id!==a.lipSync.intent.attemptId||a.lipSync.reservation.id!==a.jobId||a.lipSync.reservation.heldUsd!==a.estimatedUsd||!["running","unknown","succeeded","failed"].includes(a.status))throw new BudgetError("Invalid retained lip-sync attempt.");
  if(a.lipSync.receipt){validateLipSyncReceipt(a.lipSync.receipt);if(!lipSame(a.lipSync.receipt.intent,a.lipSync.intent)||!lipSame(a.lipSync.receipt.reservation,a.lipSync.reservation))throw new BudgetError("The observation changed its original hold.");}
  if(a.lipSync.invoice){const invoice=validateLipSyncAllocation(a.lipSync.invoice);if(invoice.attemptId!==a.id||invoice.accountRevision!==a.lipSync.accountRevision||invoice.usd!==a.actualUsd||!["succeeded","failed"].includes(a.status)||a.lipSync.receipt&&!a.lipSync.receipt.dispatched)throw new BudgetError("Lip-sync settlement differs from its invoice.");}
  else if(a.lipSync.receipt&&!a.lipSync.receipt.dispatched){if(a.actualUsd!==0||a.status!=="failed")throw new BudgetError("An undispatched attempt has invalid billing.");}
  else if(a.actualUsd!==null||!["running","unknown"].includes(a.status))throw new BudgetError("Unreconciled lip-sync cannot have a fabricated actual cost.");return structuredClone(a);
}
export function storedLipSyncAttempt(row:Record<string,any>):StoredLipSyncAttempt{
  if(row.provider!==row.body?.lipSync?.intent?.provider||(row.request_id??null)!==(row.body?.lipSync?.receipt?.remote?.id??null))throw new BudgetError("Lip-sync provider or generation differs from its original intent.");return validateStoredLipSyncAttempt({id:row.id,projectId:row.project_id,jobId:row.job_id,shotId:row.shot_id,workerId:row.worker_id,leaseVersion:row.lease_version,status:row.status,estimatedUsd:Number(row.estimated_usd),actualUsd:row.actual_usd===null?null:Number(row.actual_usd),createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),lipSync:row.body.lipSync});
}
export class PostgresLipSyncLedger extends PostgresCostLedger {
  private async currentPolicy(job:Job|JobInput,lookup:LipSyncPolicyLookup,now:number):Promise<LipSyncPolicy>{
    validateLipSyncJob(job);const current=await lookup();if(!current||!lipSame(validateLipSyncPolicy(current,now),job.lipSync!.policy))throw new BudgetError("The lip-sync provider or price policy changed. Review a new pass.");return current;
  }
  async admitLipSync(projectId:string,input:JobInput,lookup:LipSyncPolicyLookup,monthlyCapUsd:number,now=Date.now()):Promise<Job>{
    if(input.projectId!==projectId||input.stage!=="lip-sync"||!Number.isFinite(monthlyCapUsd)||monthlyCapUsd<=0)throw new BudgetError("Invalid lip-sync admission.");
    return this.database.forProject(projectId,tx=>this.lockWithin(tx,async(tx,cap)=>{
      const previous=(await tx`select body from hv_jobs where project_id=${projectId} and idempotency_key=${input.idempotencyKey}`)[0]?.body as Job|undefined;assertLipSyncIdempotency(previous,input);if(previous)return previous;
      const project=(await tx`select body from hv_projects where id=${projectId} and taken_down_at is null for update`)[0]?.body as PersistedProject|undefined,policy=await this.currentPolicy(input,lookup,now);
      assertLipSyncPermission(input.lipSync!,project,now);const source=(await tx`select body from hv_jobs where id=${input.lipSync!.source.jobId} and project_id=${projectId} for share`)[0]?.body as Job|undefined;assertLipSyncSourceAvailable(input.lipSync!,source,now);
      await this.reserveWithin(tx,cap,input.id,input.stage,policy.heldUsd,monthlyCapUsd,new Date(now));return new PostgresJobStore(this.database).enqueueWithin(tx,input);
    },monthlyCapUsd));
  }
  private async held(tx:SQL,job:Job,workerId:string,now:number):Promise<Job>{
    const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null for share`)[0]?.body as PersistedProject|undefined;
    const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} and project_id=${job.projectId} for update`)[0],current=row?.body as Job|undefined;
    if(!current||current.status!=="running")throw new LeaseError(job.id,"not_running",current?.claimedBy??null);if(current.claimedBy!==workerId)throw new LeaseError(job.id,"wrong_worker",current.claimedBy);if(row.lease_version!==job.leaseVersion)throw new LeaseError(job.id,"fence_changed",current.claimedBy);
    if(!Number.isFinite(Date.parse(current.leaseExpiresAt??""))||Date.parse(current.leaseExpiresAt!)<=now)throw new LeaseError(job.id,"lease_expired",current.claimedBy);
    if(!lipSame(current.lipSync,job.lipSync))throw new BudgetError("The admitted lip-sync context changed.");assertLipSyncPermission(current.lipSync!,project,now);
    const source=(await tx`select body from hv_jobs where id=${current.lipSync!.source.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertLipSyncSourceAvailable(current.lipSync!,source,now);return current;
  }
  async assertLipSyncPermission(job:Job,workerId:string,lookup:LipSyncPolicyLookup,now=Date.now()):Promise<void>{await this.currentPolicy(job,lookup,now);await this.database.forProject(job.projectId,tx=>this.held(tx,job,workerId,now));}
  journal(job:Job,workerId:string,lookup:LipSyncPolicyLookup):LipSyncJournal{
    return {authorize:async intent=>{
      if(!job.lipSyncPrepared)throw new BudgetError("Save owned lip-sync inputs before dispatch.");validateLipSyncPrepared(job,job.lipSyncPrepared);validateLipSyncIntent(intent,job.lipSync!,job.lipSyncPrepared);
      return this.locked(async tx=>{const now=Date.now(),policy=await this.currentPolicy(job,lookup,now),current=await this.held(tx,job,workerId,now);
        if(!lipSame(current.lipSyncPrepared,job.lipSyncPrepared))throw new BudgetError("The prepared lip-sync inputs changed.");
        if((await tx`select id from hv_provider_attempts where job_id=${job.id} limit 1`).length)throw new BudgetError("This pass already has an attempt. Resume its original generation.");
        const hold=(await tx`select remaining_usd from hv_reservations where job_id=${job.id} for update`)[0];if(!hold||Number(hold.remaining_usd)<policy.heldUsd)throw new BudgetError("The original lip-sync reservation is unavailable.");
        const reservation={id:job.id,priceRevision:policy.priceRevision,heldUsd:policy.heldUsd},lipSync:StoredLipSyncAttempt["lipSync"]={schema:"hv-lipsync-attempt/1",intent,reservation,accountRevision:policy.accountRevision,policyRevision:policy.revision};
        await tx`insert into hv_provider_attempts (id,project_id,job_id,shot_id,provider,worker_id,lease_version,status,estimated_usd,actual_usd,body) values (${intent.attemptId},${job.projectId},${job.id},${job.lipSync!.shotId},'sync',${workerId},${job.leaseVersion!},'running',${policy.heldUsd},null,${{lipSync}}::jsonb)`;
        await tx`insert into hv_outbox (id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'lipsync.authorized',${{attemptId:intent.attemptId,planRevision:job.lipSync!.revision}}::jsonb)`;return reservation;
      });},assertCurrent:()=>this.assertLipSyncPermission(job,workerId,lookup),observe:receipt=>this.recordLipSyncReceipt(job,workerId,receipt)};
  }
  /** Original workers may attach late receipts; resumed workers need the current
   * lease. Neither path can change the generation identity or erase liability. */
  async recordLipSyncReceipt(job:Job,workerId:string,receipt:LipSyncReceipt):Promise<void>{
    validateLipSyncReceipt(receipt);await this.locked(async tx=>{
      await tx`select id from hv_projects where id=${job.projectId} for share`;const currentRow=(await tx`select body,lease_version from hv_jobs where id=${job.id} for update`)[0],current=currentRow?.body as Job|undefined;
      const row=(await tx`select * from hv_provider_attempts where id=${receipt.intent.attemptId} for update`)[0];if(!row)throw new BudgetError("The original lip-sync attempt is missing.");const a=storedLipSyncAttempt(row);
      const original=a.workerId===workerId&&a.leaseVersion===job.leaseVersion,resumed=current?.status==="running"&&current.claimedBy===workerId&&currentRow.lease_version===job.leaseVersion&&Number.isFinite(Date.parse(current.leaseExpiresAt??""))&&Date.parse(current.leaseExpiresAt!)>Date.now()&&lipSame(current.lipSync,job.lipSync);
      if(a.projectId!==job.projectId||a.jobId!==job.id||!lipSame(a.lipSync.intent,receipt.intent)||!lipSame(a.lipSync.reservation,receipt.reservation)||(!original&&!resumed))throw new BudgetError("The observation does not belong to the original or resumed lip-sync worker.");
      assertLipSyncObservation(a.lipSync.receipt,receipt);if(a.lipSync.invoice&&!receipt.dispatched)throw new BudgetError("An invoiced attempt cannot become undispatched.");if(lipSame(a.lipSync.receipt,receipt))return;
      a.lipSync.receipt=structuredClone(receipt);if(!a.lipSync.invoice){a.status=receipt.dispatched?"unknown":"failed";a.actualUsd=receipt.dispatched?null:0;}else a.status=receipt.state==="COMPLETED"?"succeeded":"failed";
      await tx`update hv_provider_attempts set body=${{lipSync:a.lipSync}}::jsonb,status=${a.status},actual_usd=${a.actualUsd},request_id=${receipt.remote?.id??null},updated_at=now() where id=${a.id}`;
      await tx`insert into hv_outbox (id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${a.projectId},${a.jobId},'lipsync.observed',${{attemptId:a.id,state:receipt.state,generationId:receipt.remote?.id??null}}::jsonb)`;
    });
  }
  async lipSyncAttempt(jobId:string,projectId?:string):Promise<StoredLipSyncAttempt|undefined>{
    const read=async(tx:SQL)=>{const row=(await tx`select * from hv_provider_attempts where job_id=${jobId} and (${projectId??null}::text is null or project_id=${projectId??null}) and body ? 'lipSync'`)[0];return row?storedLipSyncAttempt(row):undefined;};return projectId?this.database.forProject(projectId,read):read(this.database.sql);
  }
  async settleLipSyncInvoice(value:LipSyncInvoice):Promise<void>{
    const invoice=validateLipSyncInvoice(value);if((await this.database.sql`select current_user as role`)[0].role!=="hv_admin")throw new BudgetError("Lip-sync invoice reconciliation requires the operator database role.");
    await this.locked(async tx=>{
      const prior=await tx`select body from hv_cost_events where body->'lipSyncBilling'->>'documentSha256'=${invoice.documentSha256}`;
      if(prior.length){if(prior.length!==invoice.allocations.length||prior.some((r:any)=>r.body.lipSyncBilling.invoiceRevision!==invoice.revision))throw new BudgetError("This invoice already has another or partially restored allocation.");return;}
      const identities=[];for(const allocation of invoice.allocations){const row=(await tx`select project_id,job_id from hv_provider_attempts where id=${allocation.attemptId}`)[0];if(!row)throw new BudgetError("Invoice names an unknown lip-sync attempt.");identities.push(row);}
      for(const id of [...new Set(identities.map(r=>String(r.project_id)))].sort())await tx`select id from hv_projects where id=${id} for share`;for(const id of [...new Set(identities.map(r=>String(r.job_id)))].sort())await tx`select id from hv_jobs where id=${id} for update`;
      const attempts:StoredLipSyncAttempt[]=[];for(const allocation of [...invoice.allocations].sort((a,b)=>a.attemptId.localeCompare(b.attemptId))){const row=(await tx`select * from hv_provider_attempts where id=${allocation.attemptId} for update`)[0];if(!row)throw new BudgetError("Unknown original lip-sync attempt.");const a=storedLipSyncAttempt(row);if(a.lipSync.accountRevision!==invoice.accountRevision||a.lipSync.invoice||a.lipSync.receipt&&!a.lipSync.receipt.dispatched)throw new BudgetError("Invoice scope conflicts with the lip-sync attempt.");attempts.push(a);}
      for(const a of attempts){const usd=invoice.allocations.find(v=>v.attemptId===a.id)!.usd,data={schema:"hv-lipsync-allocation/1" as const,documentSha256:invoice.documentSha256,accountRevision:invoice.accountRevision,invoiceRevision:invoice.revision,attemptId:a.id,usd,at:invoice.at},allocation=validateLipSyncAllocation({...data,revision:contentHash(data)});
        const event:CostEvent&{lipSyncBilling:LipSyncAllocation}={eventId:"lipsync:"+invoice.documentSha256+":"+a.id,attemptId:a.id,at:invoice.at,projectId:a.projectId,jobId:a.jobId,shotId:a.shotId,stage:"lip-sync",provider:a.lipSync.intent.provider,model:a.lipSync.intent.model,prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:usd,lipSyncBilling:allocation};
        await tx`insert into hv_cost_events (id,event_key,project_id,job_id,attempt_id,stage,provider,total_usd,body,created_at) values (${crypto.randomUUID()},${event.eventId!},${a.projectId},${a.jobId},${a.id},'lip-sync','sync',${usd},${event}::jsonb,${invoice.at})`;
        a.lipSync.invoice=allocation;a.actualUsd=usd;a.status=a.lipSync.receipt?.state==="COMPLETED"?"succeeded":"failed";await tx`update hv_provider_attempts set body=${{lipSync:a.lipSync}}::jsonb,status=${a.status},actual_usd=${usd},updated_at=now() where id=${a.id}`;
        const saved=(await tx`select body from hv_reservations where job_id=${a.jobId} for update`)[0]?.body as BudgetReservation|undefined;if(saved){saved.remainingUsd=Number(Math.max(0,saved.remainingUsd-usd).toFixed(6));await tx`update hv_reservations set remaining_usd=${saved.remainingUsd},body=${saved}::jsonb where job_id=${a.jobId}`;}
        const current=(await tx`select body from hv_jobs where id=${a.jobId} for update`)[0]?.body as Job|undefined;if(current){if(current.projectId!==a.projectId||current.stage!=="lip-sync")throw new BudgetError("Lip-sync billing job identity changed.");current.costUsd=usd;current.cost={provider:event.provider,model:event.model,prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:usd};
          if(usd>current.costCapUsd&&["queued","running"].includes(current.status)){current.status="cancelled";current.claimedBy=null;current.leaseExpiresAt=null;current.completedAt=new Date().toISOString();current.cancelReason="The lip-sync invoice allocation exceeded its job cap.";}
          await tx`update hv_jobs set body=${current}::jsonb,status=${current.status},claimed_by=${current.claimedBy},lease_expires_at=${current.leaseExpiresAt},updated_at=now() where id=${a.jobId}`;}
        if(!current||["done","failed","cancelled"].includes(current.status))await this.releaseIn(tx,a.jobId);
        await tx`insert into hv_outbox (id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${a.projectId},${a.jobId},'lipsync.invoice_allocated',${{attemptId:a.id,documentSha256:invoice.documentSha256,totalUsd:usd,basis:"invoice-allocation"}}::jsonb)`;
      }
    });
  }
}
