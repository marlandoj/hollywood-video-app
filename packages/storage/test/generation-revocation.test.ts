/**
 * HV-031-01, the PostgreSQL half.
 *
 * The JSON store's revocation policy — which jobs stop, which fields change,
 * which records are left alone — is tested in
 * `packages/queue/test/generation-revocation.test.ts`, and `revokeProjectWithin`
 * delegates to that same domain object, so it is the *transaction* that is under
 * test here: that the takedown and the revocation are one atomic act, that the
 * lease version moves so a worker already holding one of these jobs cannot write
 * again, and that an outbox event is emitted for each stopped job.
 *
 * Gated on a PostgreSQL test environment exactly like every other Postgres suite
 * in this repository, and skipped without one.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PostgresProjectService } from "../src/projects";
import { PostgresJobStore } from "../src/jobs";
import { StudioDatabase } from "../src/database";
import { GENERATION_REVOKED_NOTICE, LeaseError, type Job } from "../../queue/src/index";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
const ids: string[] = [];
let admin: StudioDatabase, database: StudioDatabase;

beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "postgres-revocation-fixture-secret-of-at-least-thirty-two";
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate();
});
afterAll(async () => {
  if (!enabled) return;
  for (const id of ids) {
    await admin.sql`delete from hv_outbox where project_id = ${id}`;
    await admin.sql`delete from hv_jobs where project_id = ${id}`;
    await admin.sql`delete from hv_reviews where project_id = ${id}`;
    await admin.sql`delete from hv_projects where id = ${id}`;
  }
  await Promise.all([admin.close(), database.close()]);
});

const jobBody = (id: string, projectId: string, over: Record<string, unknown> = {}) => ({
  id, idempotencyKey: id, projectId, tier: "free" as const, stage: "final" as const, scriptVersion: 1,
  totalFrames: 60, retryPolicy: { maxRetries: 1, backoffMs: 10 }, timeoutMs: 120_000, costCapUsd: 5,
  scriptText: "INT. ROOM - DAY\n\nA lamp glows.", rightsAttestedAt: "2026-08-31T00:00:00.000Z",
  animaticJobId: null, animaticApprovedAt: null,
  queueAction: "run", queueReason: "capacity_available", queuedBehind: [], notifications: [],
  status: "queued", costUsd: 0, checkpointFrame: 0, checkpointShots: 0, resumedCount: 0,
  claimedBy: null, leaseExpiresAt: null, leaseVersion: 0, completedAt: null, linkExpiresAt: null,
  queuedAt: new Date().toISOString(), ...over,
}) as unknown as Job;

async function seed(projectId: string, job: Job): Promise<void> {
  await admin.sql`insert into hv_jobs (id, project_id, idempotency_key, tier, stage, status, body, queued_at, lease_version)
    values (${job.id}, ${projectId}, ${job.idempotencyKey}, ${job.tier}, ${job.stage}, ${job.status}, ${job}::jsonb, now(), ${job.leaseVersion ?? 0})`;
}

pgtest("a PostgreSQL takedown stops the project's generation in the same transaction and fences its worker", async () => {
  const taken = crypto.randomUUID(), other = crypto.randomUUID();
  ids.push(taken, other);
  for (const id of [taken, other]) {
    await admin.sql`insert into hv_projects (id, body, delete_after)
      values (${id}, ${{ id, createdAt: new Date().toISOString(), deleteAfter: new Date(Date.now() + 86_400_000).toISOString(), versions: [] }}::jsonb, now() + interval '1 day')`;
  }

  // Claimed through the real store, so the fence this worker holds is the one
  // the claim handed it rather than one a test wrote by hand.
  await seed(taken, jobBody("pg-running", taken));
  const store = new PostgresJobStore(database);
  const claimed = await store.claimNext(Date.now(), {}, { workerId: "worker-a", leaseMs: 300_000 });
  expect(claimed?.id).toBe("pg-running");
  await store.heartbeat("pg-running", "worker-a", Date.now(), 300_000);

  await seed(taken, jobBody("pg-queued", taken));
  await seed(taken, jobBody("pg-delivered", taken, { status: "done", completedAt: new Date().toISOString() }));
  await seed(other, jobBody("pg-other", other));

  expect(await new PostgresProjectService(admin).takedown(taken, "verified request", Date.now())).toBe(true);

  const rows = await admin.sql`select id, status, lease_version, claimed_by, lease_expires_at, body from hv_jobs
    where project_id in (${taken}, ${other}) order by id`;
  type JobRow = { id: string; status: string; lease_version: number; claimed_by: string | null; lease_expires_at: Date | null; body: Job };
  const byId = new Map<string, JobRow>((rows as JobRow[]).map(row => [row.id, row]));

  for (const id of ["pg-queued", "pg-running"]) {
    const row = byId.get(id)!;
    expect({ id, status: row.status, claimedBy: row.claimed_by, lease: row.lease_expires_at }).toEqual({ id, status: "cancelled", claimedBy: null, lease: null });
    expect(row.body.cancelReason).toBe(GENERATION_REVOKED_NOTICE);
  }

  // The fence moved, so the worker that was holding pg-running cannot write
  // again even if its heartbeat lands after the revocation.
  expect(byId.get("pg-running")!.lease_version).toBe((claimed!.leaseVersion ?? 0) + 1);
  const late = store.heartbeat("pg-running", "worker-a", Date.now(), 300_000);
  await expect(late).rejects.toBeInstanceOf(LeaseError);
  await late.catch((error: unknown) => expect((error as LeaseError).reason).toBe("fence_changed"));

  // A delivered record is not rewritten, and another project is untouched.
  expect(byId.get("pg-delivered")!.status).toBe("done");
  expect(byId.get("pg-delivered")!.body.cancelReason).toBeUndefined();
  expect(byId.get("pg-other")!.status).toBe("queued");

  // One outbox event per stopped job, and none for the delivered or foreign one.
  const events = await admin.sql`select job_id from hv_outbox where project_id = ${taken} and event_type = 'job.revoked' order by job_id`;
  expect(events.map((event: { job_id: string }) => event.job_id)).toEqual(["pg-queued", "pg-running"]);

  // The project itself is a tombstone, and a second takedown reports no change.
  const project = await admin.sql`select taken_down_at, takedown_reason from hv_projects where id = ${taken}`;
  expect(project[0].taken_down_at).not.toBeNull();
  expect(project[0].takedown_reason).toBe("verified request");
  expect(await new PostgresProjectService(admin).takedown(taken, "again", Date.now())).toBe(false);
});
