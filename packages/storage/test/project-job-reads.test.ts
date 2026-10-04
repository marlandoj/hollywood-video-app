/**
 * HV-030-32 — the API's three narrow job reads on PostgreSQL.
 *
 * The dialogue, score and render routes used to read every job body of the project to find one
 * request key and to count the running jobs; a feature's project holds tens of megabytes of them by
 * its tenth sequence. `PostgresJobStore` now answers those questions from its indexes. These tests
 * hold each answer to the project it was asked for, and to what `all()` would have said.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PostgresJobStore } from "../src/jobs";
import { StudioDatabase } from "../src/database";
import type { JobInput } from "../../queue/src/index";
import { projectJobWithKey, projectJobsAt, projectRunningCount } from "../../api/src/project-jobs";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, api: StudioDatabase;
const projectIds = [crypto.randomUUID(), crypto.randomUUID()];
function input(projectId: string, key: string, stage: JobInput["stage"] = "animatic"): JobInput {
  const id = crypto.randomUUID();
  return {id, projectId, idempotencyKey: projectId + ":" + key, tier: "free", stage, scriptVersion: 1,
    scriptText: "EXT. GARDEN - DAY\n\nA leaf falls.", rightsAttestedAt: new Date().toISOString(),
    animaticJobId: null, animaticApprovedAt: null, totalFrames: 240, retryPolicy: {maxRetries: 1, backoffMs: 10},
    timeoutMs: 60_000, costCapUsd: 1};
}
beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  api = new StudioDatabase(process.env.HV_API_DATABASE_URL!);
  await admin.migrate();
});
afterAll(async () => {
  if (!enabled) return;
  for (const projectId of projectIds) {
    await admin.sql`delete from hv_outbox where project_id = ${projectId}`;
    await admin.sql`delete from hv_jobs where project_id = ${projectId}`;
  }
  await Promise.all([admin.close(), api.close()]);
});

/** Criterion 2: each read answers for its own project only, and says what the whole list would have. */
pgtest("a request key, the running count and a stage's finished jobs are read for one project, as the whole list would say", async () => {
  const [mine, theirs] = projectIds as [string, string];
  const scoped = (projectId: string) => new PostgresJobStore(api).forProject(projectId);
  const first = await scoped(mine).enqueue(input(mine, "first")), second = await scoped(mine).enqueue(input(mine, "second", "final"));
  const third = await scoped(mine).enqueue(input(mine, "third", "final"));
  await scoped(theirs).enqueue(input(theirs, "first"));
  // Two of mine running, one of theirs; one of my finals done.
  const set = (id: string, status: string) => admin.sql`update hv_jobs set status = ${status}, body = jsonb_set(body, '{status}', to_jsonb(${status}::text)) where id = ${id}`;
  await set(first.id, "running"); await set(second.id, "running"); await set(third.id, "done");
  await admin.sql`update hv_jobs set status = 'running', body = jsonb_set(body, '{status}', '"running"') where project_id = ${theirs}`;

  expect((await projectJobWithKey(scoped, mine, mine + ":second"))?.id).toBe(second.id);
  expect(await projectJobWithKey(scoped, mine, theirs + ":first")).toBeUndefined();
  expect(await projectJobWithKey(scoped, mine, mine + ":missing")).toBeUndefined();
  expect(await projectRunningCount(scoped, mine)).toBe(2);
  expect(await projectRunningCount(scoped, theirs)).toBe(1);
  expect((await projectJobsAt(scoped, mine, "final", "done")).map(job => job.id)).toEqual([third.id]);
  expect(await projectJobsAt(scoped, mine, "animatic", "done")).toEqual([]);
  // The same answers the whole list gives.
  const all = await scoped(mine).all();
  expect(all.filter(job => job.status === "running").length).toBe(2);
  expect(all.find(job => job.idempotencyKey === mine + ":second")?.id).toBe(second.id);
  // A store scoped to one project never answers for another, and an unscoped one answers for none.
  expect(() => scoped(theirs).withKey(mine, mine + ":second")).toThrow("its own project's jobs only");
  expect(() => new PostgresJobStore(api).runningCount(mine)).toThrow("its own project's jobs only");
});
