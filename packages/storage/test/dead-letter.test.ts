/**
 * HV-032-01, the PostgreSQL half.
 *
 * `recoverAbandoned` now returns dead-lettered jobs alongside resumed ones and
 * the store chooses the outbox event from the status. That one line is the only
 * change outside `packages/queue`, and the in-memory suite cannot see it: a
 * ternary rewritten to emit `job.resumed` unconditionally, or with its arms
 * swapped, leaves every queue test green while the row's event stream lies
 * about why the job stopped. This suite is that line's only guard, and it also
 * checks the half of the claim the in-memory tests cannot reach — that the row
 * itself stops at `failed` in the database rather than staying `running`.
 *
 * Gated on a PostgreSQL test environment like every other PostgreSQL suite
 * here; CI supplies the three database URLs at the job level, so it runs there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PostgresJobStore } from "../src/jobs";
import { StudioDatabase } from "../src/database";
import { MAX_LEASE_RECOVERIES, type Job } from "../../queue/src/index";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
const ids: string[] = [];
let admin: StudioDatabase, database: StudioDatabase;

beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "postgres-dead-letter-fixture-secret-of-at-least-thirty-two";
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate();
});
afterAll(async () => {
  if (!enabled) return;
  for (const id of ids) {
    await admin.sql`delete from hv_outbox where project_id = ${id}`;
    await admin.sql`delete from hv_jobs where project_id = ${id}`;
    await admin.sql`delete from hv_projects where id = ${id}`;
  }
  await Promise.all([admin.close(), database.close()]);
});

const body = (id: string, projectId: string, over: Record<string, unknown> = {}) => ({
  id, idempotencyKey: id, projectId, tier: "free" as const, stage: "final" as const, scriptVersion: 1,
  totalFrames: 60, retryPolicy: { maxRetries: 2, backoffMs: 10 }, timeoutMs: 120_000, costCapUsd: 5,
  scriptText: "INT. ROOM - DAY\n\nA lamp glows.", rightsAttestedAt: "2026-08-31T00:00:00.000Z",
  animaticJobId: null, animaticApprovedAt: null,
  queueAction: "run", queueReason: "capacity_available", queuedBehind: [], notifications: [],
  status: "running", costUsd: 0, retriesUsed: 0, checkpointFrame: 0, checkpointShots: 0, resumedCount: 0,
  claimedBy: "worker-gone", leaseExpiresAt: new Date(Date.now() - 600_000).toISOString(), leaseVersion: 1,
  completedAt: null, linkExpiresAt: null, lapsesWithoutProgress: 0,
  ...over,
}) as unknown as Job;

async function seed(projectId: string, job: Job): Promise<void> {
  await admin.sql`insert into hv_jobs (id, project_id, idempotency_key, tier, stage, status, body, queued_at, lease_expires_at, claimed_by, lease_version)
    values (${job.id}, ${projectId}, ${job.idempotencyKey}, ${job.tier}, ${job.stage}, ${job.status}, ${job}::jsonb,
      now() - interval '1 hour', ${job.leaseExpiresAt}, ${job.claimedBy}, ${job.leaseVersion ?? 0})`;
}

pgtest("PostgreSQL recovery stops a stalled job at a dead letter and says so on the outbox", async () => {
  const projectId = crypto.randomUUID();
  ids.push(projectId);
  await admin.sql`insert into hv_projects (id, body, delete_after)
    values (${projectId}, ${{ id: projectId, createdAt: new Date().toISOString(), deleteAfter: new Date(Date.now() + 86_400_000).toISOString(), versions: [] }}::jsonb, now() + interval '1 day')`;

  await seed(projectId, body("pg-stalled", projectId));
  const store = new PostgresJobStore(database);

  /** Puts a row back to running with a lapsed lease, leaving the body's counters alone. */
  const abandonRow = (id: string) => admin.sql`update hv_jobs set status = 'running',
    claimed_by = 'worker-gone', lease_expires_at = now() - interval '10 minutes',
    body = jsonb_set(jsonb_set(jsonb_set(body, '{status}', '"running"'), '{claimedBy}', '"worker-gone"'),
      '{leaseExpiresAt}', to_jsonb((now() - interval '10 minutes')::text)) where id = ${id}`;

  // Driven for real rather than by seeding a counter: the streak only builds
  // when the progress fingerprint is genuinely unchanged between lapses, and a
  // fixture that wrote the mark by hand would be asserting against a value the
  // code did not produce. Five lapses resume; the sixth is the terminus.
  for (let lapse = 1; lapse <= MAX_LEASE_RECOVERIES; lapse += 1) {
    const touched = await store.recoverAbandoned(Date.now());
    expect({ lapse, touched: touched.map(job => `${job.id}:${job.status}`) }).toEqual({ lapse, touched: ["pg-stalled:queued"] });
    await abandonRow("pg-stalled");
  }

  // The second job joins on the terminal pass, on its own first lapse, so both
  // arms of the event ternary run inside one call.
  await seed(projectId, body("pg-fresh", projectId));
  const touched = await store.recoverAbandoned(Date.now());
  expect(touched.map(job => `${job.id}:${job.status}`).sort()).toEqual(["pg-fresh:queued", "pg-stalled:failed"]);

  const rows = await admin.sql`select id, status, claimed_by, lease_expires_at, body from hv_jobs where project_id = ${projectId} order by id`;
  type Row = { id: string; status: string; claimed_by: string | null; lease_expires_at: Date | null; body: Job };
  const byId = new Map<string, Row>((rows as Row[]).map(row => [row.id, row]));

  // The row itself stops, in the database. This is the half the in-memory suite
  // cannot see: a terminus computed and thrown away would leave this `running`.
  const dead = byId.get("pg-stalled")!;
  expect({ status: dead.status, claimedBy: dead.claimed_by, lease: dead.lease_expires_at }).toEqual({ status: "failed", claimedBy: null, lease: null });
  expect(dead.body.failureKind).toBe("dead_letter");
  expect(dead.body.lapsesWithoutProgress).toBe(MAX_LEASE_RECOVERIES + 1);
  expect(dead.body.resumedCount).toBe(MAX_LEASE_RECOVERIES);

  const fresh = byId.get("pg-fresh")!;
  expect({ status: fresh.status, resumed: fresh.body.resumedCount, stalled: fresh.body.lapsesWithoutProgress })
    .toEqual({ status: "queued", resumed: 1, stalled: 1 });
  expect(fresh.body.failureKind).toBeUndefined();

  // One event each, and the right one each. A ternary rewritten to emit
  // `job.resumed` unconditionally fails here and nowhere else.
  const events = await admin.sql`select job_id, event_type, count(*)::int as n from hv_outbox
    where project_id = ${projectId} group by job_id, event_type order by job_id, event_type`;
  expect((events as { job_id: string; event_type: string; n: number }[]).map(event => `${event.job_id}:${event.event_type}=${event.n}`))
    .toEqual(["pg-fresh:job.resumed=1", `pg-stalled:job.dead_lettered=1`, `pg-stalled:job.resumed=${MAX_LEASE_RECOVERIES}`]);

  // And the dead letter is a terminus in the database too: the claim path
  // selects `status = 'queued'`, so only the resumed job is offered.
  const claimed = await store.claimNext(Date.now(), {}, { workerId: "worker-next", leaseMs: 600_000 });
  expect(claimed?.id).toBe("pg-fresh");
  expect(await store.claimNext(Date.now(), {}, { workerId: "worker-after" })).toBeUndefined();
});
