import type { SQL } from "bun";
import { BudgetError, type BudgetReservation, type CostEvent } from "../../operator/src/index";
import { LeaseError, type Job, type JobInput, type JobStage } from "../../queue/src/index";
import type { PersistedProject } from "../../api/src/index";
import { PostgresJobStore } from "./jobs";
import { StudioDatabase } from "./database";

const money = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) throw new BudgetError("invalid generation budget");
  return Number(value.toFixed(6));
};
export interface ProviderAttempt {
  id: string; projectId: string; jobId: string; shotId: string; provider: string;
  workerId: string; leaseVersion: number; estimateUsd: number;
}
export class PostgresCostLedger {
  constructor(private readonly database: StudioDatabase) {}
  private async lockWithin<T>(tx: SQL, fn: (tx: SQL, cap: number) => Promise<T>, initialCap: number): Promise<T> {
    await tx`insert into hv_budget_accounts (id, monthly_cap_usd) values ('operator', ${initialCap})
      on conflict (id) do nothing`;
    const account = await tx`select monthly_cap_usd from hv_budget_accounts where id = 'operator' for update`;
    return fn(tx, Number(account[0].monthly_cap_usd));
  }
  private async locked<T>(fn: (tx: SQL, cap: number) => Promise<T>, initialCap = Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000)): Promise<T> {
    return await this.database.sql.begin(transaction => this.lockWithin(transaction as unknown as SQL, fn, initialCap)) as T;
  }
  async reserve(jobId: string, stage: JobStage, amountUsd: number, monthlyCapUsd: number, now = new Date()): Promise<void> {
    amountUsd = money(amountUsd);
    if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) throw new BudgetError("invalid monthly budget");
    await this.locked((tx, storedCap) => this.reserveWithin(tx, storedCap, jobId, stage, amountUsd, monthlyCapUsd, now), monthlyCapUsd);
  }
  private async reserveWithin(tx: SQL, storedCap: number, jobId: string, stage: JobStage, amountUsd: number, monthlyCapUsd: number, now: Date): Promise<void> {
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
      await tx`insert into hv_reservations (job_id, stage, amount_usd, remaining_usd, body, created_at)
        values (${jobId}, ${stage}, ${amountUsd}, ${remaining}, ${body}::jsonb, ${body.createdAt})`;
  }
  /** Project version, idempotency, budget reservation and admission commit together. */
  async admit(projectId: string, input: JobInput, monthlyCapUsd: number): Promise<Job> {
    if (input.projectId !== projectId || !Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) throw new BudgetError("invalid job admission");
    const amount = money(input.budgetReservedUsd ?? input.costCapUsd);
    return this.database.forProject(projectId, tx => this.lockWithin(tx, async (tx, cap) => {
      const previous = await tx`select body from hv_jobs where project_id = ${projectId} and idempotency_key = ${input.idempotencyKey}`;
      if (previous.length) return previous[0].body as Job;
      const rows = await tx`select body, taken_down_at from hv_projects where id = ${projectId} for update`;
      const project = rows[0]?.body as PersistedProject | undefined;
      const latest = project?.versions.at(-1);
      if (!project || rows[0].taken_down_at || Date.parse(project.deleteAfter) <= Date.now() || !project.rightsAttestedAt
        || latest?.version !== input.scriptVersion || latest.text !== input.scriptText) throw new Error("the screenplay changed; reload before starting generation");
      if (input.stage === "final") {
        const approval = project.animaticApprovals.find(value => value.animaticJobId === input.animaticJobId);
        const animatic = (await tx`select body from hv_jobs where id = ${input.animaticJobId}`)[0]?.body as Job | undefined;
        if (!approval || approval.decision !== "approved" || approval.scriptVersion !== input.scriptVersion
          || !animatic || animatic.stage !== "animatic" || animatic.status !== "done" || animatic.scriptVersion !== input.scriptVersion)
          throw new Error("a finished animatic for the current screenplay must be approved");
      }
      await this.reserveWithin(tx, cap, input.id, input.stage, amount, monthlyCapUsd, new Date());
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
  async beginAttempt(attempt: ProviderAttempt, now = Date.now()): Promise<void> {
    const estimate = money(attempt.estimateUsd);
    await this.locked(async tx => {
      const project = (await tx`select id from hv_projects where id = ${attempt.projectId} and taken_down_at is null
        and delete_after > ${new Date(now).toISOString()} for share`)[0];
      if (!project) throw new BudgetError("project is unavailable or expired");
      const rows = await tx`select body, lease_version from hv_jobs where id = ${attempt.jobId} for update`;
      const job = rows[0]?.body as Job | undefined;
      if (!job || job.projectId !== attempt.projectId) throw new Error("unknown provider job");
      if (job.status !== "running") throw new LeaseError(job.id, "not_running", job.claimedBy);
      if (job.claimedBy !== attempt.workerId) throw new LeaseError(job.id, "wrong_worker", job.claimedBy);
      if (rows[0].lease_version !== attempt.leaseVersion) throw new LeaseError(job.id, "fence_changed", job.claimedBy);
      if (!job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= now) throw new LeaseError(job.id, "lease_expired", job.claimedBy);
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
      await tx`insert into hv_provider_attempts (id, project_id, job_id, shot_id, provider, worker_id, lease_version, status, estimated_usd)
        values (${attempt.id}, ${attempt.projectId}, ${attempt.jobId}, ${attempt.shotId}, ${attempt.provider},
        ${attempt.workerId}, ${attempt.leaseVersion}, 'running', ${estimate})`;
      await tx`insert into hv_outbox (id, project_id, job_id, event_type, body)
        values (${crypto.randomUUID()}, ${attempt.projectId}, ${attempt.jobId}, 'provider.dispatched',
        ${{attemptId: attempt.id, shotId: attempt.shotId, provider: attempt.provider, estimateUsd: estimate}}::jsonb)`;
    });
  }
  async finishAttempt(id: string, outcome: "succeeded" | "failed" | "unknown"): Promise<void> {
    await this.locked(async tx => {
      const rows = await tx`select project_id, job_id from hv_provider_attempts where id = ${id} and status in ('running', 'unknown') for update`;
      if (!rows.length) return;
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
      if (job.costUsd > job.costCapUsd && ["running", "queued"].includes(job.status)) {
        job.status = "cancelled"; job.claimedBy = null; job.leaseExpiresAt = null;
        job.completedAt = new Date().toISOString();
        job.cancelReason = `cost $${job.costUsd.toFixed(2)} exceeded per-job cap $${job.costCapUsd.toFixed(2)}`;
        job.notifications.push(`Your shot was cancelled: ${job.cancelReason}. You were not charged — this project is operator-funded.`);
      }
      await tx`update hv_jobs set body = ${job}::jsonb, status = ${job.status}, claimed_by = ${job.claimedBy},
        lease_expires_at = ${job.leaseExpiresAt}, updated_at = now() where id = ${job.id}`;
      return job;
    });
  }
  private async releaseIn(tx: SQL, jobId: string): Promise<void> {
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
  async jobSpend(jobId: string): Promise<number> {
    return Number((await this.database.sql`select coalesce(sum(total_usd),0) as total from hv_cost_events where job_id = ${jobId}`)[0].total);
  }
  async all(): Promise<CostEvent[]> {
    return (await this.database.sql`select body from hv_cost_events order by created_at,id`).map((row: {body: CostEvent}) => row.body);
  }
  async gpuSecondsByProject(): Promise<Record<string, number>> {
    const rows = await this.database.sql`select project_id, sum((body->>'gpu_seconds')::numeric) as seconds from hv_cost_events group by project_id`;
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
