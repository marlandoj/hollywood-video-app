import type {SQL} from "bun";
import type {Job, JobInput} from "../../queue/src/index";
import {LeaseError} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";
import {BudgetError, type CostEvent, type BudgetReservation} from "../../operator/src/index";
import {assertVoiceVendorBudget,voiceVendorAlerts} from "../../operator/src/voice-vendor-budget";
import {PostgresCostLedger} from "./ledger";
import {PostgresJobStore} from "./jobs";
import {contentHash} from "../../generator/src/capabilities";
import {validateAudioIntent, validateAudioOutcome, type AudioDispatchIntent, type AudioAttemptOutcome, type AudioAttemptJournal, type AudioReservation} from "../../generator/src/cartesia-audio";
import {audioHash, audioNumber, audioRecord} from "../../planner/src/audio-performances";
import {assertAudioTakeIdempotency, assertAudioTakeMemoryCurrent, assertAudioTakePermission, audioTakeHoldUsd, validateAudioTake, validateAudioPolicy, type AudioPolicy} from "../../planner/src/audio-jobs";

export type AudioPolicyLookup = (voiceId: string) => AudioPolicy | undefined | Promise<AudioPolicy | undefined>;
export interface AudioInvoice {
  schema: "hv-audio-invoice-allocation/1"; documentSha256: string; accountRevision: string; totalUsd: number; at: string;
  allocations: {attemptId: string; usd: number}[]; revision: string;
}
/** Project-scoped allocation receipt. It intentionally excludes other projects'
 * attempts, invoice totals and the operator's full allocation worksheet. */
export interface AudioAllocation {
  schema:"hv-audio-allocation/1";documentSha256:string;accountRevision:string;invoiceRevision:string;
  attemptId:string;usd:number;at:string;revision:string;
}
export interface StoredAudioAttempt {
  id: string; projectId: string; jobId: string; workerId: string; leaseVersion: number;
  status: "running" | "unknown" | "succeeded" | "failed"; estimatedUsd: number; actualUsd: number | null;
  createdAt: string; updatedAt: string;
  audio: {schema: "hv-audio-attempt/1"; intent: AudioDispatchIntent; reservation: AudioReservation; accountRevision: string; policyRevision: string;
    outcome?: AudioAttemptOutcome; invoice?: AudioAllocation};
}
const same = (a: unknown,b: unknown) => contentHash(a)===contentHash(b);
const money = (v: unknown) => {const n=audioNumber(v,0,1000000,"Audio invoice amount");if(n!==Number(n.toFixed(6)))throw new BudgetError("Use six-decimal USD amounts.");return n;};
export function validateAudioInvoice(invoice: AudioInvoice): AudioInvoice {
  audioRecord(invoice,["schema","documentSha256","accountRevision","totalUsd","at","allocations","revision"]);
  if(invoice.schema!=="hv-audio-invoice-allocation/1"||!Array.isArray(invoice.allocations)||!invoice.allocations.length||invoice.allocations.length>1000
    ||typeof invoice.at!=="string"||!Number.isFinite(Date.parse(invoice.at))||new Date(invoice.at).toISOString()!==invoice.at)throw new BudgetError("Invalid audio invoice allocation.");
  audioHash(invoice.documentSha256);audioHash(invoice.accountRevision);money(invoice.totalUsd);
  const ids=new Set<string>();let micros=0;
  for(const allocation of invoice.allocations){audioRecord(allocation,["attemptId","usd"]);if(typeof allocation.attemptId!=="string"||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(allocation.attemptId)||ids.has(allocation.attemptId))throw new BudgetError("Duplicate or invalid invoice attempt.");ids.add(allocation.attemptId);micros+=Math.round(money(allocation.usd)*1e6);}
  const {revision,...data}=invoice;if(micros!==Math.round(invoice.totalUsd*1e6)||audioHash(revision)!==contentHash(data))throw new BudgetError("Invoice allocations must conserve the documented total.");
  return structuredClone(invoice);
}
export function validateAudioAllocation(value:AudioAllocation):AudioAllocation{
  audioRecord(value,["schema","documentSha256","accountRevision","invoiceRevision","attemptId","usd","at","revision"]);
  if(value.schema!=="hv-audio-allocation/1"||typeof value.attemptId!=="string"||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.attemptId)
    ||typeof value.at!=="string"||!Number.isFinite(Date.parse(value.at))||new Date(value.at).toISOString()!==value.at)throw new BudgetError("Invalid scoped audio allocation.");
  audioHash(value.documentSha256);audioHash(value.accountRevision);audioHash(value.invoiceRevision);money(value.usd);
  const {revision,...data}=value;if(audioHash(revision)!==contentHash(data))throw new BudgetError("The audio allocation receipt changed.");return structuredClone(value);
}
export function validateStoredAudioAttempt(a: StoredAudioAttempt): StoredAudioAttempt {
  audioRecord(a,["id","projectId","jobId","workerId","leaseVersion","status","estimatedUsd","actualUsd","createdAt","updatedAt","audio"]);
  audioRecord(a.audio,["schema","intent","reservation","accountRevision","policyRevision","outcome","invoice"]);validateAudioIntent(a.audio.intent);
  if(a.audio.schema!=="hv-audio-attempt/1"||a.id!==a.audio.intent.attemptId||![a.projectId,a.jobId,a.workerId].every(v=>typeof v==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v))
    ||!Number.isInteger(a.leaseVersion)||a.leaseVersion<1||!["running","unknown","succeeded","failed"].includes(a.status)||![a.createdAt,a.updatedAt].every(v=>typeof v==="string"&&Number.isFinite(Date.parse(v))))throw new BudgetError("Invalid stored audio attempt.");
  audioHash(a.audio.accountRevision);audioHash(a.audio.policyRevision);audioHash(a.audio.reservation.priceRevision);
  audioRecord(a.audio.reservation,["id","priceRevision","heldUsd"]);
  if(a.audio.reservation.id!==a.jobId||money(a.estimatedUsd)<=0||a.audio.reservation.heldUsd!==a.estimatedUsd)throw new BudgetError("Audio hold differs from its dispatch.");
  if(a.audio.outcome){validateAudioOutcome(a.audio.outcome);if(!same(a.audio.outcome.intent,a.audio.intent)||a.audio.outcome.reservation&&!same(a.audio.outcome.reservation,a.audio.reservation))throw new BudgetError("Audio outcome differs from its intent.");}
  if(a.audio.invoice){const invoice=validateAudioAllocation(a.audio.invoice);
    if(invoice.attemptId!==a.id||invoice.accountRevision!==a.audio.accountRevision||invoice.usd!==a.actualUsd||!["succeeded","failed"].includes(a.status))throw new BudgetError("Audio settlement differs from its invoice allocation.");
  }else if(a.audio.outcome&&!a.audio.outcome.dispatched){if(a.actualUsd!==0||a.status!=="failed")throw new BudgetError("Undispatched audio has an invalid settlement.");}
  else if(a.actualUsd!==null||!["running","unknown"].includes(a.status))throw new BudgetError("Unreconciled audio cannot have an actual cost.");
  return structuredClone(a);
}
export function storedAudioAttempt(row: Record<string,any>): StoredAudioAttempt {
  if(row.provider!==row.body?.audio?.intent?.provider)throw new BudgetError("Audio attempt provider differs from its recorded intent.");
  return validateStoredAudioAttempt({id:row.id,projectId:row.project_id,jobId:row.job_id,workerId:row.worker_id,leaseVersion:row.lease_version,status:row.status,
    estimatedUsd:Number(row.estimated_usd),actualUsd:row.actual_usd===null?null:Number(row.actual_usd),createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),audio:row.body.audio});
}

/**
 * What an admission crossed on a vendor's own line, raised after the admission committed.
 *
 * HV-022-13: the operator approved ElevenLabs with a ceiling of $25 and alerts at $5 and $15.
 * `assertVoiceVendorBudget` enforced the ceiling; `voiceVendorAlerts` computed the two warnings and
 * was called by nothing, so the only signal the operator ever got from this line was the hard
 * refusal at $25 -- the thing the warnings exist to arrive before.
 */
export interface VoiceVendorAlert {provider:string;thresholdUsd:number;committedUsd:number}
export class PostgresAudioLedger extends PostgresCostLedger {
  private async currentPolicy(job:Job|JobInput,lookup:AudioPolicyLookup,now:number):Promise<AudioPolicy>{
    validateAudioTake(job);const saved=job.audioTake!.policy,current=await lookup(saved.voiceId);
    if(!current||!same(validateAudioPolicy(current,now),saved))throw new BudgetError("The audio voice or pricing policy changed. Review a new audition.");return current;
  }
  /**
   * HV-022-08: what the studio has committed to one voice vendor -- takes it has paid for, plus the
   * holds its queued takes carry. A vendor sells a prepaid allowance, so the hold is the honest
   * measure of commitment until the operator allocates that vendor's invoice.
   */
  //
  // HV-022-17: read from the rows retention keeps. Both sums used to find the vendor through
  // `join hv_jobs`, and `PostgresRetention.purgeProject` deletes a project's jobs while it keeps its
  // financial receipts, attempts and unknown-liability holds on purpose. So every expired or taken-down
  // project handed its vendor spend back: a line holding $20 spent and $4 held read $0 after the purge,
  // and a new $20 take was admitted on a $25 line. An invoice settled after the purge never counted.
  //
  // It was also narrower than it looked. Admission reads it as hv_api inside `forProject`, and hv_jobs
  // and hv_provider_attempts are row-secured to the admitting project, so the "vendor's line" was
  // each project's own: $25 per project rather than $25 for the studio. hv_cost_events and
  // hv_reservations are readable across projects by hv_api, and now say which vendor they belong to:
  // a cost event by its provider column, a hold by the provider its admission wrote into it. Holds
  // admitted before this carry no provider and are still found through their job or attempt, which
  // the admitting project can see for itself.
  async voiceVendorSpend(provider:string,tx:SQL=this.database.sql):Promise<{spentUsd:number;heldUsd:number}>{
    const row=(await tx`select
      (select coalesce(sum(e.total_usd),0) from hv_cost_events e
        where e.stage='audio-take' and e.provider = ${provider}) as spent,
      (select coalesce(sum(r.remaining_usd),0) from hv_reservations r
        where r.stage='audio-take' and (
          r.body->>'provider' = ${provider}
          or exists (select 1 from hv_jobs j where j.id = r.job_id and j.body->'audioTake'->'policy'->>'provider' = ${provider})
          or exists (select 1 from hv_provider_attempts a where a.job_id = r.job_id and a.provider = ${provider}))) as held`)[0];
    return {spentUsd:Number(row.spent),heldUsd:Number(row.held)};
  }
  /**
   * Set by the studio so the two thresholds the operator approved reach the operator. It runs after
   * the admission has committed, never inside the transaction, so a rolled-back admission raises
   * nothing and a raised alert is always about money the studio has actually committed.
   */
  onVendorAlert?:(alert:VoiceVendorAlert)=>void;
  async admitAudio(projectId:string,input:JobInput,lookup:AudioPolicyLookup,monthlyCapUsd:number,now=Date.now(),filmCapUsd?:number,vendorCapUsd?:number):Promise<Job>{
    if(input.projectId!==projectId||input.stage!=="audio-take"||!Number.isFinite(monthlyCapUsd)||monthlyCapUsd<=0)throw new BudgetError("Invalid audio admission.");
    const policy=await this.currentPolicy(input,lookup,now);
    // HV-022-21: what this take holds -- an ElevenLabs take its own line, every other vendor's take its
    // policy's per-take hold. `validateAudioTake` has already checked the job's cap and reservation
    // are this figure, so every check below and the reservation itself use the one number.
    const heldUsd=audioTakeHoldUsd(input.audioTake!);
    let crossed:VoiceVendorAlert[]=[];
    const job=await this.database.forProject(projectId,tx=>this.lockWithin(tx,async(tx,cap)=>{
      crossed=[];
      const previous=(await tx`select body from hv_jobs where project_id=${projectId} and idempotency_key=${input.idempotencyKey}`)[0]?.body as Job|undefined;
      assertAudioTakeIdempotency(previous,input);if(previous)return previous;
      const project=(await tx`select body from hv_projects where id=${projectId} and taken_down_at is null and expired_at is null for update`)[0]?.body as PersistedProject|undefined;
      assertAudioTakePermission(input,project,now);
      assertAudioTakeMemoryCurrent(input,project!);
      // HV-022-03: a take's hold counts toward the film's own limit (HV-019-04) as well as the month's.
      await this.assertFilmWithin(tx,projectId,heldUsd,filmCapUsd);
      // HV-022-08: and toward the vendor's own line, when the operator has given that vendor one.
      if(vendorCapUsd!==undefined){
        const committed=await this.voiceVendorSpend(policy.provider,tx),before=committed.spentUsd+committed.heldUsd;
        assertVoiceVendorBudget({provider:policy.provider,...committed,capUsd:vendorCapUsd},heldUsd);
        // Read from the same row set the ceiling was checked against, inside the same transaction,
        // so the figure an alert names is the figure the refusal would have named.
        crossed=voiceVendorAlerts(before,heldUsd).map(thresholdUsd=>({provider:policy.provider,thresholdUsd,committedUsd:before+heldUsd}));
      }
      await this.reserveWithin(tx,cap,input.id,input.stage,heldUsd,monthlyCapUsd,new Date(now),projectId,policy.provider);
      return new PostgresJobStore(this.database).enqueueWithin(tx,input);
    },monthlyCapUsd));
    for(const alert of crossed)this.onVendorAlert?.(alert);
    return job;
  }
  private async held(tx:SQL,job:Job,workerId:string,now:number):Promise<Job>{
    const project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null and expired_at is null for share`)[0]?.body as PersistedProject|undefined;
    const row=(await tx`select body,lease_version from hv_jobs where id=${job.id} and project_id=${job.projectId} for update`)[0],current=row?.body as Job|undefined;
    if(!current||current.status!=="running")throw new LeaseError(job.id,"not_running",current?.claimedBy??null);
    if(current.claimedBy!==workerId)throw new LeaseError(job.id,"wrong_worker",current.claimedBy);
    if(row.lease_version!==job.leaseVersion)throw new LeaseError(job.id,"fence_changed",current.claimedBy);
    if(!current.leaseExpiresAt||!Number.isFinite(Date.parse(current.leaseExpiresAt))||Date.parse(current.leaseExpiresAt)<=now)throw new LeaseError(job.id,"lease_expired",current.claimedBy);
    if(!same(current.audioTake,job.audioTake)||current.scriptText!==job.scriptText||!same(current.casting,job.casting))throw new BudgetError("The admitted audio context changed.");
    assertAudioTakePermission(current,project,now);return current;
  }
  async assertAudioPermission(job:Job,workerId:string,lookup:AudioPolicyLookup,now=Date.now()):Promise<void>{
    await this.currentPolicy(job,lookup,now);await this.database.forProject(job.projectId,tx=>this.held(tx,job,workerId,now));
  }
  journal(job:Job,workerId:string,lookup:AudioPolicyLookup):AudioAttemptJournal {
    return {authorize:async(intent,line)=>{
      if(!same(line,job.audioTake?.line))throw new BudgetError("Audio request differs from the admitted line.");
      const now=Date.now(),policy=await this.currentPolicy(job,lookup,now),heldUsd=audioTakeHoldUsd(job.audioTake!);validateAudioIntent(intent,line);
      return this.locked(async tx=>{
        await this.held(tx,job,workerId,now);
        if((await tx`select id from hv_provider_attempts where job_id=${job.id} limit 1`).length)throw new BudgetError("This audio audition was already dispatched. Recover its checkpoint or reconcile the original attempt.");
        const budget=(await tx`select remaining_usd from hv_reservations where job_id=${job.id} for update`)[0];
        if(!budget||Number(budget.remaining_usd)<heldUsd)throw new BudgetError("The audio reservation is unavailable.");
        const reservation:AudioReservation={id:job.id,priceRevision:policy.priceRevision,heldUsd};
        const audio:StoredAudioAttempt["audio"]={schema:"hv-audio-attempt/1",intent,reservation,accountRevision:policy.accountRevision,policyRevision:policy.revision};
        await tx`insert into hv_provider_attempts (id,project_id,job_id,shot_id,provider,worker_id,lease_version,status,estimated_usd,actual_usd,body)
          values (${intent.attemptId},${job.projectId},${job.id},'audio-line',${intent.provider},${workerId},${job.leaseVersion!},'running',${heldUsd},null,${{audio}}::jsonb)`;
        await tx`insert into hv_outbox (id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'audio.dispatched',${{attemptId:intent.attemptId,planRevision:line.revision,heldUsd}}::jsonb)`;
        return reservation;
      });
    },assertCurrent:()=>this.assertAudioPermission(job,workerId,lookup),recordOutcome:outcome=>this.recordAudioOutcome(job,workerId,outcome)};
  }
  async recordAudioOutcome(job:Job,workerId:string,outcome:AudioAttemptOutcome):Promise<void>{
    validateAudioOutcome(outcome);
    await this.locked(async tx=>{
      const row=(await tx`select * from hv_provider_attempts where id=${outcome.intent.attemptId} for update`)[0];
      if(!row){if(!outcome.dispatched&&!outcome.reservation)return;throw new BudgetError("The original audio dispatch is missing.");}
      const a=storedAudioAttempt(row);
      if(a.projectId!==job.projectId||a.jobId!==job.id||a.workerId!==workerId||a.leaseVersion!==job.leaseVersion||!same(outcome.intent,a.audio.intent)
        ||outcome.reservation&&!same(outcome.reservation,a.audio.reservation))throw new BudgetError("Audio outcome does not belong to its original worker and intent.");
      if(a.audio.outcome){if(!same(a.audio.outcome,outcome))throw new BudgetError("The recorded audio outcome is immutable.");return;}
      if(a.audio.invoice&&!outcome.dispatched)throw new BudgetError("An invoiced request cannot become undispatched.");
      a.audio.outcome=structuredClone(outcome);
      if(!a.audio.invoice){a.status=outcome.dispatched?"unknown":"failed";a.actualUsd=outcome.dispatched?null:0;}
      else a.status=outcome.providerState==="completed"?"succeeded":"failed";
      await tx`update hv_provider_attempts set body=${{audio:a.audio}}::jsonb,status=${a.status},actual_usd=${a.actualUsd},updated_at=now() where id=${a.id}`;
      await tx`insert into hv_outbox (id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${a.projectId},${a.jobId},'audio.outcome',${{attemptId:a.id,providerState:outcome.providerState,billing:outcome.billing}}::jsonb)`;
    });
  }
  async audioAttempt(jobId:string,projectId?:string):Promise<StoredAudioAttempt|undefined>{
    const read=async(tx:SQL)=>{const row=(await tx`select * from hv_provider_attempts where job_id=${jobId} and (${projectId??null}::text is null or project_id=${projectId??null}) and body ? 'audio'`)[0];return row?storedAudioAttempt(row):undefined;};
    return projectId?this.database.forProject(projectId,read):read(this.database.sql);
  }

  /** Explicit operator invoice allocation. No owner/worker route can forge the
   * evidence or settle a request using an aggregate provider credit difference. */
  async settleAudioInvoice(value:AudioInvoice):Promise<void>{
    const invoice=validateAudioInvoice(value);
    if((await this.database.sql`select current_user as role`)[0].role!=="hv_admin")throw new BudgetError("Audio invoice reconciliation requires the operator database role.");
    await this.locked(async tx=>{
      const prior=await tx`select body from hv_cost_events where body->'audioBilling'->>'documentSha256'=${invoice.documentSha256}`;
      if(prior.length){if(prior.length!==invoice.allocations.length||prior.some((r:any)=>r.body.audioBilling.invoiceRevision!==invoice.revision))throw new BudgetError("This invoice document already has a different or partially restored allocation.");return;}
      // Follow retention's project → job → attempt order under the account lock.
      const identities=[];
      for(const allocation of invoice.allocations){const row=(await tx`select project_id,job_id from hv_provider_attempts where id=${allocation.attemptId}`)[0];if(!row)throw new BudgetError("Invoice names an unknown audio attempt.");identities.push(row);}
      for(const id of [...new Set(identities.map(r=>String(r.project_id)))].sort())await tx`select id from hv_projects where id=${id} for share`;
      for(const id of [...new Set(identities.map(r=>String(r.job_id)))].sort())await tx`select id from hv_jobs where id=${id} for update`;
      const attempts:StoredAudioAttempt[]=[];
      for(const allocation of [...invoice.allocations].sort((a,b)=>a.attemptId.localeCompare(b.attemptId))){
        const row=(await tx`select * from hv_provider_attempts where id=${allocation.attemptId} for update`)[0];if(!row)throw new BudgetError("Invoice names an unknown audio attempt.");
        const a=storedAudioAttempt(row);if(a.audio.accountRevision!==invoice.accountRevision||a.audio.invoice||a.audio.outcome&&!a.audio.outcome.dispatched)throw new BudgetError("Invoice scope conflicts with the audio attempt.");attempts.push(a);
      }
      for(const a of attempts){const usd=invoice.allocations.find(v=>v.attemptId===a.id)!.usd;
        const allocationData={schema:"hv-audio-allocation/1" as const,documentSha256:invoice.documentSha256,accountRevision:invoice.accountRevision,invoiceRevision:invoice.revision,attemptId:a.id,usd,at:invoice.at};
        const allocation=validateAudioAllocation({...allocationData,revision:contentHash(allocationData)});
        const event:CostEvent&{audioBilling:AudioAllocation}={eventId:"audio:"+invoice.documentSha256+":"+a.id,attemptId:a.id,at:invoice.at,projectId:a.projectId,jobId:a.jobId,shotId:"audio-line",stage:"audio-take",provider:a.audio.intent.provider,model:a.audio.intent.model,prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:usd,audioBilling:allocation};
        await tx`insert into hv_cost_events (id,event_key,project_id,job_id,attempt_id,stage,provider,total_usd,body,created_at)
          values (${crypto.randomUUID()},${event.eventId!},${a.projectId},${a.jobId},${a.id},'audio-take',${a.audio.intent.provider},${usd},${event}::jsonb,${invoice.at})`;
        a.audio.invoice=allocation;a.actualUsd=usd;a.status=a.audio.outcome?.providerState==="completed"?"succeeded":"failed";
        await tx`update hv_provider_attempts set body=${{audio:a.audio}}::jsonb,status=${a.status},actual_usd=${usd},updated_at=now() where id=${a.id}`;
        const saved=(await tx`select body from hv_reservations where job_id=${a.jobId} for update`)[0]?.body as BudgetReservation|undefined;
        if(saved){saved.remainingUsd=Number(Math.max(0,saved.remainingUsd-usd).toFixed(6));await tx`update hv_reservations set remaining_usd=${saved.remainingUsd},body=${saved}::jsonb where job_id=${a.jobId}`;}
        const current=(await tx`select body from hv_jobs where id=${a.jobId} for update`)[0]?.body as Job|undefined;
        if(current){if(current.projectId!==a.projectId||current.stage!=="audio-take")throw new BudgetError("Audio billing job identity changed.");current.costUsd=usd;current.cost={provider:event.provider,model:event.model,prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:usd};
          if(usd>current.costCapUsd&&["queued","running"].includes(current.status)){current.status="cancelled";current.claimedBy=null;current.leaseExpiresAt=null;current.completedAt=new Date().toISOString();current.cancelReason="The audio invoice allocation exceeded its job cap.";}
          await tx`update hv_jobs set body=${current}::jsonb,status=${current.status},claimed_by=${current.claimedBy},lease_expires_at=${current.leaseExpiresAt},updated_at=now() where id=${a.jobId}`;
        }
        if(!current||["done","failed","cancelled"].includes(current.status))await this.releaseIn(tx,a.jobId);
        await tx`insert into hv_outbox (id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${a.projectId},${a.jobId},'audio.invoice_allocated',${{attemptId:a.id,documentSha256:invoice.documentSha256,totalUsd:usd,basis:"invoice-allocation"}}::jsonb)`;
      }
    });
  }
}
