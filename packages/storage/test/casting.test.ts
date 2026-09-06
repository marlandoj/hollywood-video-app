import { afterAll, beforeAll, expect, test } from "bun:test";
import { StudioDatabase } from "../src/database";
import { PostgresProjectService } from "../src/projects";
import { PostgresCostLedger } from "../src/ledger";
import { PostgresJobStore } from "../src/jobs";
import { currentCasting } from "../../planner/src/casting";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import type { JobInput } from "../../queue/src/index";
import { createCharacterSheet } from "../../planner/src/sheets";
import { createProviderPlan } from "../../generator/src/catalog";
import { parseFountain } from "../../parser/src/index";
import type { ReferenceAsset } from "../../planner/src/references";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_WORKER_DATABASE_URL), pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, database: StudioDatabase, projects: PostgresProjectService, ledger: PostgresCostLedger, previousCap: string | null;
const projectIds: string[] = [];
beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "casting-postgres-fixture-secret-at-least-thirty-two-characters";
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
async function owner() {
  const result = await projects.createAnonymousProject(); projectIds.push(result.projectId);
  await projects.editScript(result.token, CAST_SCRIPT); await projects.attestRights(result.token);
  return result;
}

pgtest("concurrent cast saves have one winner, preserve project state and remain isolated", async () => {
  const first = await owner(), other = await owner(), id = crypto.randomUUID();
  const results = await Promise.allSettled([projects.saveCharacter(first.token, id, CAST_INPUT, 0),
    projects.saveCharacter(first.token, id, {...CAST_INPUT, appearance: "A green scarf"}, 0)]);
  expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(value => value.status === "rejected")).toHaveLength(1);
  const project = (await projects.authorize(first.token))!;
  expect(project.castingHistory).toHaveLength(1); expect(project.versions.latest()!.text).toBe(CAST_SCRIPT); expect(project.rightsAttestedAt).toBeTruthy();
  expect((await projects.authorize(other.token))!.castingHistory).toHaveLength(0);
  expect(await projects.saveCharacter("invalid", id, CAST_INPUT, 0)).toBeNull();
});

pgtest("atomic admission rejects a stale cast and queued permission revocation blocks dispatch", async () => {
  const user = await owner(), actorId = crypto.randomUUID();
  const saved = (await projects.saveCharacter(user.token, actorId, CAST_INPUT, 0))!;
  const project = (await projects.authorize(user.token))!;
  const id = crypto.randomUUID(), input: JobInput = {id, projectId: user.projectId, idempotencyKey: id, tier: "free", stage: "animatic",
    scriptVersion: 1, totalFrames: 120, retryPolicy: {maxRetries: 0, backoffMs: 0}, timeoutMs: 60_000,
    costCapUsd: 1, budgetReservedUsd: 0, scriptText: CAST_SCRIPT, rightsAttestedAt: project.rightsAttestedAt,
    animaticJobId: null, animaticApprovedAt: null, casting: saved};
  const updated = (await projects.saveCharacter(user.token, actorId, {...CAST_INPUT, appearance: "A blue scarf"}, 1))!;
  await expect(ledger.admit(user.projectId, input, 500)).rejects.toThrow("cast changed");
  expect(await new PostgresJobStore(database).get(id)).toBeUndefined();
  await ledger.admit(user.projectId, {...input, casting: updated}, 500);
  const store = new PostgresJobStore(database), now = Date.now(), job = (await store.claimNext(now, {}, {workerId: "cast-worker", leaseMs: 60_000}))!;
  const attempt = {id: crypto.randomUUID(), projectId: user.projectId, jobId: id, shotId: "shot-1-1", provider: "fixture",
    workerId: "cast-worker", leaseVersion: job.leaseVersion!, estimateUsd: 0};
  await ledger.beginAttempt(attempt, now + 1); await ledger.finishAttempt(attempt.id, "succeeded");
  await projects.revokeCharacterPermission(user.token, actorId, 2);
  await expect(ledger.beginAttempt({...attempt, id: crypto.randomUUID(), shotId: "shot-2-1"}, now + 2)).rejects.toThrow("not permitted");
  expect(Number((await admin.sql`select count(*) as count from hv_provider_attempts where job_id = ${id}`)[0].count)).toBe(1);
  await store.setStatus(id, "cancelled"); await ledger.release(id);
});

pgtest("approval checks the latest cast under the project lock", async () => {
  const user = await owner(), id = crypto.randomUUID();
  const original = currentCasting(user.projectId, (await projects.authorize(user.token))!.castingHistory);
  await projects.saveCharacter(user.token, id, CAST_INPUT, 0);
  expect(await projects.recordAnimaticDecision(user.projectId, crypto.randomUUID(), 1, "approved", "", Date.now(), original)).toBeNull();
  const current = currentCasting(user.projectId, (await projects.authorize(user.token))!.castingHistory);
  expect((await projects.recordAnimaticDecision(user.projectId, crypto.randomUUID(), 1, "approved", "", Date.now(), current))!.castingRevision).toBe(current.revision);
});

pgtest("sheet stage admission and per-view permission are enforced by PostgreSQL",async()=>{
  const user=await owner(),characterId=crypto.randomUUID(),casting=(await projects.saveCharacter(user.token,characterId,CAST_INPUT,0))!;
  const id=crypto.randomUUID(),sheet=createCharacterSheet(casting,parseFountain(CAST_SCRIPT),characterId,{kind:"turnaround",seed:123,sceneNumber:null});
  const input:JobInput={id,projectId:user.projectId,idempotencyKey:id,tier:"free",stage:"character-sheet",scriptVersion:1,scriptText:CAST_SCRIPT,
    rightsAttestedAt:(await projects.authorize(user.token))!.rightsAttestedAt,casting,characterSheet:sheet,providerPlan:createProviderPlan("character-sheet",1),
    animaticJobId:null,animaticApprovedAt:null,totalFrames:120,costCapUsd:4,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60_000};
  await ledger.admit(user.projectId,input,500);const store=new PostgresJobStore(database),job=(await store.claimNext(Date.now(),{},{workerId:"sheet-worker",leaseMs:60_000}))!;
  expect(job.stage).toBe("character-sheet");expect(job.characterSheet).toEqual(sheet);
  await projects.saveCharacter(user.token,characterId,{...CAST_INPUT,permission:{...CAST_INPUT.permission,scope:"scenes",sceneNumbers:[1]}},1);
  await expect(ledger.beginAttempt({id:crypto.randomUUID(),projectId:user.projectId,jobId:id,shotId:"sheet-1",provider:input.providerPlan!.pool[0]!.snapshot.adapter,
    workerId:"sheet-worker",leaseVersion:job.leaseVersion!,estimateUsd:0})).rejects.toThrow("project-wide");
  expect(Number((await admin.sql`select count(*) as count from hv_provider_attempts where job_id=${id}`)[0].count)).toBe(0);
  await store.setStatus(id,"cancelled");await ledger.release(id);
});

pgtest("competing reference batches commit once and a changed screenplay prevents adoption",async()=>{
  const user=await owner(),characterId=crypto.randomUUID(),saved=(await projects.saveCharacter(user.token,characterId,CAST_INPUT,0))!,jobId=crypto.randomUUID();
  const assets=Array.from({length:4},(_,index):ReferenceAsset=>({schema:"hv-reference/1",id:crypto.randomUUID(),projectId:user.projectId,sha256:"a".repeat(64),originalSha256:"b".repeat(64),bytes:100,width:512,height:512,
    contentType:"image/png",createdAt:new Date().toISOString(),attestedAt:new Date().toISOString(),source:{kind:"character-sheet",jobId,viewId:"sheet-"+(index+1),castingRevision:saved.revision}}));
  const results=await Promise.allSettled([projects.addCharacterReferences(user.token,characterId,assets,1,Date.now(),{expectedScriptVersion:1,replaceExisting:true}),
    projects.addCharacterReferences(user.token,characterId,assets,1,Date.now(),{expectedScriptVersion:1,replaceExisting:true})]);
  expect(results.filter(value=>value.status==="fulfilled")).toHaveLength(1);expect(results.filter(value=>value.status==="rejected")).toHaveLength(1);
  const current=(await projects.authorize(user.token))!;expect(current.castingHistory).toHaveLength(2);expect(current.referenceAssets).toEqual(assets);
  await projects.editScript(user.token,CAST_SCRIPT+"\n\nThe wind picks up.");
  await expect(projects.addCharacterReferences(user.token,characterId,[{...assets[0]!,id:crypto.randomUUID()}],2,Date.now(),{expectedScriptVersion:1,replaceExisting:true})).rejects.toThrow("screenplay changed");
  expect((await projects.authorize(user.token))!.castingHistory).toHaveLength(2);
});
