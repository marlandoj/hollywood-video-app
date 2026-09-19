import { afterAll, beforeAll, expect, test } from "bun:test";
import { StudioDatabase } from "../src/database";
import { PostgresProjectService } from "../src/projects";
import { PostgresCostLedger } from "../src/ledger";
import { PostgresJobStore } from "../src/jobs";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import type { JobInput } from "../../queue/src/index";
import { createProviderPlan } from "../../generator/src/catalog";

// HV-019-04: in PostgreSQL the film limit is checked inside admission's lock, beside the monthly cap.
const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_WORKER_DATABASE_URL), pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, database: StudioDatabase, projects: PostgresProjectService, ledger: PostgresCostLedger, previousCap: string | null;
const projectIds: string[] = [];
beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "film-budget-postgres-fixture-secret-at-least-thirty-two";
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!); database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate(); projects = new PostgresProjectService(database); ledger = new PostgresCostLedger(database);
  previousCap = (await admin.sql`select monthly_cap_usd from hv_budget_accounts where id = 'operator'`)[0]?.monthly_cap_usd ?? null;
});
afterAll(async () => {
  if (!enabled) return;
  for (const id of projectIds) {
    await admin.sql`delete from hv_reservations where job_id in (select id from hv_jobs where project_id = ${id})`;
    for (const table of ["hv_cost_events", "hv_provider_attempts", "hv_outbox", "hv_jobs", "hv_reviews"]) await admin.sql.unsafe("delete from " + table + " where project_id = $1", [id]);
    await admin.sql`delete from hv_projects where id = ${id}`;
  }
  if (previousCap === null) await admin.sql`delete from hv_budget_accounts where id = 'operator'`;
  else await admin.sql`update hv_budget_accounts set monthly_cap_usd = ${previousCap} where id = 'operator'`;
  await Promise.all([admin.close(), database.close()]);
});

async function film() {
  const user = await projects.createAnonymousProject(); projectIds.push(user.projectId);
  await projects.editScript(user.token, CAST_SCRIPT); await projects.attestRights(user.token);
  const casting = (await projects.saveCharacter(user.token, crypto.randomUUID(), CAST_INPUT, 0))!;
  const project = (await projects.authorize(user.token))!;
  const input = (): JobInput => { const id = crypto.randomUUID(); return {id, projectId: user.projectId, idempotencyKey: id, tier: "free", stage: "animatic",
    scriptVersion: 1, totalFrames: 30, retryPolicy: {maxRetries: 0, backoffMs: 0}, timeoutMs: 60_000, costCapUsd: 5, budgetReservedUsd: 5,
    providerPlan: createProviderPlan("animatic", 5), scriptText: CAST_SCRIPT, rightsAttestedAt: project.rightsAttestedAt, animaticJobId: null, animaticApprovedAt: null, casting}; };
  return {projectId: user.projectId, input};
}

pgtest("a film's admissions stop at its limit; the refused job holds nothing and other films keep their own limit", async () => {
  const one = await film();
  expect(await ledger.filmSpend(one.projectId)).toEqual({spentUsd: 0, heldUsd: 0});
  await ledger.admit(one.projectId, one.input(), 500, 8);
  expect(await ledger.filmSpend(one.projectId)).toEqual({spentUsd: 0, heldUsd: 5});
  const refused = one.input();
  await expect(ledger.admit(one.projectId, refused, 500, 8)).rejects.toThrow("spending limit of $8.00");
  expect(await new PostgresJobStore(database).get(refused.id)).toBeUndefined();
  expect((await ledger.filmSpend(one.projectId)).heldUsd).toBe(5);
  // Without a film limit (every caller before HV-019-04), admission is unchanged.
  await ledger.admit(one.projectId, one.input(), 500);
  const two = await film();
  await ledger.admit(two.projectId, two.input(), 500, 8);
  expect((await ledger.filmSpend(two.projectId)).heldUsd).toBe(5);
});
