import { afterAll, beforeAll, expect, test } from "bun:test";
import { StudioDatabase } from "../src/database";
import { PostgresProjectService } from "../src/projects";
import { PostgresCostLedger } from "../src/ledger";
import { PostgresJobStore } from "../src/jobs";
import type { JobInput } from "../../queue/src/index";
import { createProviderPlan } from "../../generator/src/catalog";
import { parseFountain } from "../../parser/src/index";
import { currentCasting } from "../../planner/src/casting";
import { STAND_IN_STYLE } from "../../planner/src/crew/style-bible";
import { greedySequences, sceneShotCounts, sequencePlan, sequenceRef } from "../../planner/src/sequences";
import { scriptLocations, STYLE_FIELDS, styleBible } from "../../planner/src/style-bible";
import { evenFeature } from "../../../test/fixtures/feature-script";

/**
 * HV-034-02: in PostgreSQL a feature's style bible is kept on the project through the same service, a
 * creator's edit is saved there, and admission checks inside its lock that a sequence render reads the
 * bible the project has now -- not one edited away while the render was being prepared.
 */
const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_WORKER_DATABASE_URL), pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, database: StudioDatabase, projects: PostgresProjectService, ledger: PostgresCostLedger;
const projectIds: string[] = [];
beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "style-bible-postgres-fixture-secret-at-least-thirty-two";
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

pgtest("a feature's bible is kept and edited in PostgreSQL, and admission refuses a render of a bible the project no longer has", async () => {
  const script = evenFeature(3, 13), parsed = parseFountain(script);
  const user = await projects.createAnonymousProject(); projectIds.push(user.projectId);
  await projects.editScript(user.token, script); await projects.attestRights(user.token);
  const plan = sequencePlan(1, greedySequences(sceneShotCounts(parsed)));
  const bible = styleBible({version: 1, scriptVersion: 1, source: "stand-in", ...STAND_IN_STYLE, characters: [], locations: scriptLocations(parsed).locations});
  await projects.applyCrewChanges(user.token, {characters: [], directions: [], format: "feature", sequences: plan, styleBible: bible}, {scriptVersion: 1, castingVersion: 0, directionVersion: 0});
  const project = (await projects.authorize(user.token))!;
  expect(project.styleBible).toEqual(bible);
  const input = (overrides: Partial<JobInput> = {}): JobInput => { const id = crypto.randomUUID(); return {id, projectId: user.projectId, idempotencyKey: id, tier: "free", stage: "animatic",
    scriptVersion: 1, totalFrames: 30, retryPolicy: {maxRetries: 0, backoffMs: 0}, timeoutMs: 60_000, costCapUsd: 5, budgetReservedUsd: 0,
    providerPlan: createProviderPlan("animatic", 5), scriptText: script, rightsAttestedAt: project.rightsAttestedAt, animaticJobId: null, animaticApprovedAt: null,
    casting: currentCasting(user.projectId, project.castingHistory), sequence: sequenceRef(plan, 1, bible.revision), styleBible: bible, ...overrides}; };
  const admitted = await ledger.admit(user.projectId, input(), 500, 150);
  expect((await new PostgresJobStore(database).get(admitted.id))!.sequence!.bibleRevision).toBe(bible.revision);

  const edited = (await projects.saveStyleBible(user.token, {expectedRevision: bible.revision, ...Object.fromEntries(STYLE_FIELDS.map(field => [field, bible[field]])), look: "Grainy 16 mm."}))!;
  expect(edited).toMatchObject({version: 2, source: "creator", look: "Grainy 16 mm."});
  expect((await projects.authorize(user.token))!.styleBible).toEqual(edited);
  // A render prepared from the old bible, or with none, is refused inside admission; the new one is admitted.
  await expect(ledger.admit(user.projectId, input(), 500, 150)).rejects.toThrow("The style bible changed");
  await expect(ledger.admit(user.projectId, input({sequence: sequenceRef(plan, 1), styleBible: undefined}), 500, 150)).rejects.toThrow("The style bible changed");
  await ledger.admit(user.projectId, input({sequence: sequenceRef(plan, 2, edited.revision), styleBible: edited}), 500, 150);
});
