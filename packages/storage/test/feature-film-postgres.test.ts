/**
 * HV-030-30 — a feature's film in PostgreSQL: admitted at $0 only while the films and graphics it names
 * are the ones admitted, kept under its own stage, and completed only while they still are.
 *
 * The sequence films are synthetic finished finals (`test/fixtures/feature-film.ts`) written straight
 * into hv_jobs; nothing is rendered. Runs where CI's PostgreSQL is configured.
 */
import {afterAll, beforeAll, expect, test} from "bun:test";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {PostgresCostLedger} from "../src/ledger";
import {PostgresJobStore} from "../src/jobs";
import type {Job, JobInput} from "../../queue/src/index";
import {featureFixture, SCRIPT} from "../../../test/fixtures/feature-film";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_WORKER_DATABASE_URL), pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, database: StudioDatabase, projects: PostgresProjectService, ledger: PostgresCostLedger;
const projectIds: string[] = [];
beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "feature-film-postgres-fixture-secret-at-least-thirty-two";
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!); database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate(); projects = new PostgresProjectService(database); ledger = new PostgresCostLedger(database);
});
afterAll(async () => {
  if (!enabled) return;
  for (const id of projectIds) {
    await admin.sql`delete from hv_reservations where job_id in (select id from hv_jobs where project_id = ${id})`;
    for (const table of ["hv_cost_events", "hv_provider_attempts", "hv_outbox", "hv_jobs", "hv_reviews"]) await admin.sql.unsafe("delete from " + table + " where project_id = $1", [id]);
    await admin.sql`delete from hv_projects where id = ${id}`;
  }
  await Promise.all([admin.close(), database.close()]);
});

pgtest("a feature's film is admitted at $0 and completed only while its films are the ones it names", async () => {
  const user = await projects.createAnonymousProject(); projectIds.push(user.projectId);
  await projects.editScript(user.token, SCRIPT); await projects.attestRights(user.token);
  const fixture = featureFixture(user.projectId), sources = [...[1, 2, 3].map(number => fixture.final(number)), fixture.graphic("g-title", "title"), fixture.graphic("g-credits", "credits")];
  const put = async (job: Job) => { await admin.sql`insert into hv_jobs(id,project_id,idempotency_key,stage,status,tier,body) values(${job.id},${user.projectId},${job.idempotencyKey},${job.stage},${job.status},${job.tier},${job as never}::jsonb)
    on conflict(id) do update set body=excluded.body,status=excluded.status`; };
  for (const job of sources) await put(job);
  const plan = fixture.featurePlan(true, "final"), project = (await projects.authorize(user.token))!;
  const input = (key: string): JobInput => ({id: crypto.randomUUID(), idempotencyKey: user.projectId + ":" + key, projectId: user.projectId, tier: "free", stage: "feature-film", scriptVersion: 1,
    scriptText: SCRIPT, rightsAttestedAt: project.rightsAttestedAt, animaticJobId: null, animaticApprovedAt: null, totalFrames: 1980, costCapUsd: 0, budgetReservedUsd: 0,
    retryPolicy: {maxRetries: 0, backoffMs: 0}, timeoutMs: 60_000, featureFilm: plan});

  // Admitted, at $0, under its own stage; the stage check holds it.
  const admitted = await ledger.admit(user.projectId, input("join-one"), 500, 150);
  expect([admitted.stage, admitted.status, admitted.costCapUsd, admitted.featureFilm?.revision]).toEqual(["feature-film", "queued", 0, plan.revision]);
  expect((await admin.sql`select stage from hv_jobs where id = ${admitted.id}`)[0]!.stage).toBe("feature-film");
  expect(await ledger.filmSpend(user.projectId)).toEqual({spentUsd: 0, heldUsd: 0});

  // A film made again after the plan was made is refused at admission, and nothing is enqueued.
  const changed = fixture.final(2, {output: {...fixture.final(2).output!, mp4Path: `${user.projectId}/final-2/again.mp4`}});
  await put(changed);
  const refused = input("join-two");
  await expect(ledger.admit(user.projectId, refused, 500, 150)).rejects.toThrow("Sequence 2's film changed or expired after the join was admitted. Join the feature again.");
  expect(await new PostgresJobStore(database).get(refused.id)).toBeUndefined();

  // The admitted join can't complete while sequence 2's film is the changed one, and completes once it is back.
  const store = new PostgresJobStore(database), now = Date.now();
  const claimed = (await store.claimNext(now, {}, {workerId: "feature-worker", leaseMs: 60_000}))!;
  expect(claimed.id).toBe(admitted.id);
  const output = fixture.featureFilmOutput(plan, admitted.id);
  await expect(store.complete(admitted.id, "feature-worker", output, now + 10)).rejects.toThrow("Sequence 2's film changed or expired");
  await put(fixture.final(2));
  const done = await store.complete(admitted.id, "feature-worker", output, now + 20);
  expect([done.status, done.output?.featureFilm?.planRevision]).toEqual(["done", plan.revision]);
  // A tampered export is refused by the same completion as the JSON store's.
  const other = await ledger.admit(user.projectId, input("join-three"), 500, 150);
  await store.claimNext(now + 30, {}, {workerId: "feature-worker-2", leaseMs: 60_000});
  const tampered = fixture.featureFilmOutput(plan, other.id); tampered.featureFilm!.durationSec = 1;
  await expect(store.complete(other.id, "feature-worker-2", tampered, now + 40)).rejects.toThrow("The feature's film export receipt changed.");
});
