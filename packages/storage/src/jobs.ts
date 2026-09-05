import type { SQL } from "bun";
import type { CostRecord } from "../../generator/src/index";
import { DEFAULT_LEASE_MS, DurableJobStore, LeaseError, TIERS, fairShareOrder, type ClaimOptions, type Job, type JobInput } from "../../queue/src/index";
import { StudioDatabase } from "./database";

/** One instance per worker execution loop. Claim fences never transfer between instances. */
export class PostgresJobStore {
  private readonly fences = new Map<string, number>();
  constructor(private readonly database: StudioDatabase, private readonly projectId?: string) {}
  forProject(projectId: string): PostgresJobStore { return new PostgresJobStore(this.database, projectId); }
  private transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
    return this.projectId ? this.database.forProject(this.projectId, fn)
      : this.database.sql.begin(tx => fn(tx as unknown as SQL)) as Promise<T>;
  }
  private async save(tx: SQL, job: Job, event?: string): Promise<void> {
    await tx`update hv_jobs set body = ${job}::jsonb, status = ${job.status},
      claimed_by = ${job.claimedBy}, lease_expires_at = ${job.leaseExpiresAt},
      next_eligible_at = ${job.nextEligibleAt}, lease_version = ${job.leaseVersion ?? 0},
      updated_at = now() where id = ${job.id}`;
    if (event) await tx`insert into hv_outbox (id, project_id, job_id, event_type, body)
      values (${crypto.randomUUID()}, ${job.projectId}, ${job.id}, ${event},
      ${{status: job.status, leaseVersion: job.leaseVersion ?? 0, checkpointShots: job.checkpointShots}}::jsonb)`;
  }
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
      return rows[0].body as Job;
  }
  private async mutate<T>(id: string, fn: (domain: DurableJobStore) => T, event?: string, held = false): Promise<T> {
    return this.transaction(async tx => {
      const rows = await tx`select body, lease_version from hv_jobs where id = ${id} for update`;
      if (!rows.length) throw new Error(`unknown job ${id}`);
      const job = rows[0].body as Job;
      if (held && this.fences.get(id) !== rows[0].lease_version) throw new LeaseError(id, "fence_changed", job.claimedBy);
      const domain = DurableJobStore.fromJobs([job]);
      const result = fn(domain);
      await this.save(tx, domain.get(id)!, event);
      return result;
    });
  }
  async checkpoint(id: string, workerId: string, shots: number, frames: number, now = Date.now(), leaseMs = DEFAULT_LEASE_MS): Promise<void> {
    await this.mutate(id, domain => domain.checkpoint(id, workerId, shots, frames, now, leaseMs), "job.checkpoint", true);
  }
  async heartbeat(id: string, workerId: string, now = Date.now(), leaseMs = DEFAULT_LEASE_MS): Promise<void> {
    await this.mutate(id, domain => domain.heartbeat(id, workerId, now, leaseMs), undefined, true);
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
    return this.mutate(id, domain => domain.complete(id, workerId, output, now), "job.completed", true);
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
