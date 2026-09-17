/**
 * HV-032-02, the PostgreSQL half.
 *
 * The fair-share horizon is computed twice: once over a JSON array in
 * `packages/operator/src/index.ts`, once in SQL here. Sharing the constant
 * stops the two *numbers* diverging and does nothing about the two
 * *expressions* — the JSON side filters on the event body's `at`, this side on
 * the `created_at` column, and an inclusive `>=` on one side with an exclusive
 * `>` on the other would put a job in a different order depending only on which
 * storage backend the deployment runs. So this seeds the same events into both
 * ledgers and requires the same answer, at the window's edge as well as inside
 * it. That equality is the assertion; the individual sums are incidental.
 *
 * Gated on a PostgreSQL test environment like every other PostgreSQL suite
 * here; CI supplies the three database URLs at the job level, so it runs there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresCostLedger } from "../src/ledger";
import { PostgresJobStore } from "../src/jobs";
import { StudioDatabase } from "../src/database";
import { CostLedger } from "../../operator/src/index";
import { FAIR_SHARE_WINDOW_MS, type JobInput } from "../../queue/src/index";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
const projects: string[] = [];
const root = mkdtempSync(join(tmpdir(), "hv-fair-share-pg-"));
let admin: StudioDatabase, database: StudioDatabase;

beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "fair-share-window-fixture-secret-of-at-least-thirty-two";
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate();
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  if (!enabled) return;
  for (const id of projects) {
    await admin.sql`delete from hv_outbox where project_id = ${id}`;
    await admin.sql`delete from hv_jobs where project_id = ${id}`;
    await admin.sql`delete from hv_cost_events where project_id = ${id}`;
    await admin.sql`delete from hv_projects where id = ${id}`;
  }
  await Promise.all([admin.close(), database.close()]);
});

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const eventBody = (projectId: string, seconds: number, at: number, eventId: string) => ({
  eventId, jobId: `${projectId}-${eventId}`, at: new Date(at).toISOString(),
  projectId, shotId: "s", stage: "animatic" as const, provider: "test", model: "m",
  prompt_tokens: 1, output_frames: 1, gpu_seconds: seconds, total_cost_usd: 0,
});
const claimInput = (projectId: string, id: string): JobInput => ({
  id, projectId, idempotencyKey: id, tier: "free", stage: "animatic", scriptVersion: 1,
  scriptText: "EXT. GARDEN - DAY\n\nA leaf falls.", rightsAttestedAt: new Date(NOW).toISOString(),
  animaticJobId: null, animaticApprovedAt: null, totalFrames: 240,
  retryPolicy: { maxRetries: 1, backoffMs: 10 }, timeoutMs: 60_000, costCapUsd: 1,
});

pgtest("both cost ledgers answer the same fair-share weights for the same events", async () => {
  const inside = crypto.randomUUID(), edge = crypto.randomUUID(), outside = crypto.randomUUID(), later = crypto.randomUUID();
  projects.push(inside, edge, outside, later);
  for (const id of [inside, edge, outside, later]) {
    await admin.sql`insert into hv_projects (id, body, delete_after)
      values (${id}, ${{ id, createdAt: new Date(NOW).toISOString(), deleteAfter: new Date(NOW + 86_400_000).toISOString(), versions: [] }}::jsonb, now() + interval '1 day')`;
  }

  const events = [
    { projectId: inside, seconds: 12.5, at: NOW - 3_600_000 },
    { projectId: inside, seconds: 30, at: NOW - 60_000 },
    { projectId: edge, seconds: 7, at: NOW - FAIR_SHARE_WINDOW_MS },
    { projectId: outside, seconds: 5_000, at: NOW - FAIR_SHARE_WINDOW_MS - 1 },
    // Dated after NOW, so that the third sampled instant below still has
    // something inside its window. Without it every event is outside by then,
    // both sides answer `{}`, and two empty objects are equal whatever either
    // implementation does -- which is what an earlier draft of this suite was
    // actually asserting at that instant. It also pins the horizon's one-sided
    // shape: an event dated ahead of `now`, by clock skew or otherwise, is
    // inside the window and counts, on both backends alike.
    { projectId: later, seconds: 3, at: NOW + FAIR_SHARE_WINDOW_MS },
  ].map((item, index) => ({
    eventId: `fair-share-${index}-${item.projectId}`,
    jobId: `${item.projectId}-${index}`, at: new Date(item.at).toISOString(),
    projectId: item.projectId, shotId: "s", stage: "animatic" as const,
    provider: "test", model: "m", prompt_tokens: 1, output_frames: 1,
    gpu_seconds: item.seconds, total_cost_usd: 0,
  }));

  const json = new CostLedger(join(root, "ledger.json"));
  const postgres = new PostgresCostLedger(database);
  for (const item of events) {
    json.record(item);
    await postgres.record(item);
  }

  // Three sampled instants: inside the window, exactly on the edge's boundary,
  // and a millisecond past it. Equal at all three, or the claim order depends
  // on the backend.
  for (const [label, at, expected] of [
    ["inside", NOW, { [inside]: 42.5, [edge]: 7, [later]: 3 }],
    ["edge", NOW + 1, { [inside]: 42.5, [later]: 3 }],
    ["past", NOW + FAIR_SHARE_WINDOW_MS + 1, { [later]: 3 }],
  ] as const) {
    const [fromJson, fromPostgres] = [json.fairShareWeights(at), await postgres.fairShareWeights(at)];
    // Equal to each other AND to the horizon's own answer, so "equal" cannot
    // be two implementations agreeing on the same mistake, and no instant is
    // a comparison of two empty maps.
    expect({ label, fromPostgres }).toEqual({ label, fromPostgres: fromJson });
    expect({ label, fromJson }).toEqual({ label, fromJson: expected });
    expect({ label, keys: Object.keys(fromJson).length > 0 }).toEqual({ label, keys: true });
  }

  // The events are all still recorded; only the weight is windowed.
  let total = 0;
  for (const id of [inside, edge, outside, later]) {
    const rows = await admin.sql`select coalesce(sum((body->>'gpu_seconds')::numeric), 0) as seconds
      from hv_cost_events where project_id = ${id}`;
    total += Number((rows as { seconds: string }[])[0]!.seconds);
  }
  expect(total).toBe(5_052.5);
});

pgtest("the PostgreSQL job store orders the claim by the weights it is handed", async () => {
  // The claim path that actually runs in staging. `packages/queue/src/worker.ts`
  // builds a PostgresJobStore whenever a database is configured, and no test in
  // this repository ever handed that store a non-empty weight map -- every one
  // passes `{}`. Replacing `fairShareWeights[row.project_id] ?? 0` with `0` in
  // `packages/storage/src/jobs.ts` therefore disabled fair share on the live
  // backend with every suite green, which the critic pass measured. This is
  // that line's guard.
  const busy = crypto.randomUUID(), quiet = crypto.randomUUID();
  projects.push(busy, quiet);
  const store = new PostgresJobStore(database);
  // Ids chosen so that the alphabetical tie-break would serve `busy` first:
  // if the weights are ignored, this claims the wrong job rather than passing
  // by luck.
  const busyJob = await store.enqueue(claimInput(busy, "00000000-0000-4000-8000-00000000000a"));
  const quietJob = await store.enqueue(claimInput(quiet, "ffffffff-0000-4000-8000-00000000000f"));

  const json = new CostLedger(join(root, "claim-ledger.json"));
  json.record(eventBody(busy, 900, NOW - 60_000, "claim-busy"));
  json.record(eventBody(quiet, 5, NOW - 60_000, "claim-quiet"));
  const weights = json.fairShareWeights(NOW);
  expect(weights).toEqual({ [busy]: 900, [quiet]: 5 });

  expect((await store.claimNext(NOW, weights, { workerId: "w-weighted", leaseMs: 60_000 }))?.id).toBe(quietJob.id);
  // And with no weights the tie-break decides, which is the state this store
  // was in for every test that existed before this one.
  expect((await store.claimNext(NOW, {}, { workerId: "w-bare", leaseMs: 60_000 }))?.id).toBe(busyJob.id);
});
