import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectService } from "../../api/src/index";
import { DurableJobStore } from "../../queue/src/index";
import { StudioDatabase } from "../src/database";
import { exportStateSnapshot, importStateSnapshot, readStateSnapshot, snapshotSummary, writeStateSnapshot, type StateSnapshot } from "../src/snapshots";

function fixture(): StateSnapshot {
  process.env.HV_TOKEN_SECRET = "snapshot-fixture-secret-with-at-least-thirty-two-characters";
  const projects = new ProjectService();
  const owner = projects.createAnonymousProject();
  const script = "EXT. GARDEN - DAY\n\nLeaves turn.";
  projects.editScript(owner.token,script); projects.attestRights(owner.token);
  projects.createReviewLink(owner.token,"approve");
  const jobs = DurableJobStore.fromJobs([]);
  const id = crypto.randomUUID();
  jobs.enqueue({id,projectId:owner.projectId,idempotencyKey:"fixture",tier:"free",stage:"animatic",scriptVersion:1,
    scriptText:script,rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null,
    costCapUsd:1,totalFrames:30,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60_000});
  jobs.claimNext(Date.now(),{}, {workerId:"fixture"});
  const event = {at:new Date().toISOString(),projectId:owner.projectId,jobId:id,shotId:"shot-1",stage:"animatic" as const,
    provider:"fixture",model:"fixture",prompt_tokens:0,output_frames:30,gpu_seconds:1,total_cost_usd:0.01};
  jobs.recordCost(id,"fixture",event); jobs.recordCost(id,"fixture",event);
  const root = owner.projectId + "/" + id + "/";
  jobs.complete(id,"fixture",{mp4Path:root+"export.mp4",hlsPlaylistPath:root+"hls/index.m3u8",captionsPath:root+"captions.vtt",manifestPath:root+"provenance.json"});
  projects.recordAnimaticDecision(owner.projectId,id,1,"approved");
  return {schema:"hv-state/1",projects:projects.snapshot(),jobs:jobs.all(),ledger:{events:[event,{...event}],reservations:[]},reviews:[]};
}
test("rollback snapshots preserve state and refuse corrupted or overwritten output", () => {
  const root = mkdtempSync(join(tmpdir(),"hv-snapshot-"));
  try {
    const snapshot = fixture(), target = join(root,"snapshot");
    writeStateSnapshot(target,snapshot);
    expect(readStateSnapshot(target)).toEqual(snapshot);
    expect(() => writeStateSnapshot(target,snapshot)).toThrow("already exists");
    const path = join(target,"state/projects.json");
    writeFileSync(path,readFileSync(path,"utf8").replace("Leaves turn.","Leaves changed."));
    expect(() => readStateSnapshot(target)).toThrow("checksum mismatch");
    const active = fixture(); active.jobs[0]!.status = "running";
    expect(() => writeStateSnapshot(join(root,"active"),active)).toThrow("drained jobs");
  } finally { rmSync(root,{recursive:true,force:true}); }
});
const enabled = Boolean(process.env.HV_PG_ADMIN_URL);
const pgtest = enabled ? test : test.skip;
const name = "hv_snapshot_test_" + crypto.randomUUID().replaceAll("-","");
let rootDatabase: StudioDatabase, database: StudioDatabase;
beforeAll(async () => {
  if (!enabled) return;
  rootDatabase = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  await rootDatabase.sql.unsafe('CREATE DATABASE "' + name + '"');
  const url = new URL(process.env.HV_PG_ADMIN_URL!); url.pathname = "/" + name;
  database = new StudioDatabase(url.href);
  await database.migrate();
});
afterAll(async () => {
  if (!enabled) return;
  await database?.close();
  if (!/^hv_snapshot_test_[a-f0-9]{32}$/.test(name)) throw new Error("refusing to drop an unexpected fixture database");
  await rootDatabase.sql.unsafe('DROP DATABASE "' + name + '"');
  await rootDatabase.close();
});
pgtest("state import is atomic, preserves duplicate legacy bills and refuses unsettled rollback", async () => {
  const snapshot = fixture();
  await database.sql.unsafe("ALTER TABLE hv_projects ADD CONSTRAINT fixture_reject CHECK (false)");
  await expect(importStateSnapshot(database,snapshot,500)).rejects.toThrow();
  expect(Number((await database.sql`select count(*) as count from hv_projects`)[0].count)).toBe(0);
  expect(Number((await database.sql`select count(*) as count from hv_cost_events`)[0].count)).toBe(0);
  await database.sql.unsafe("ALTER TABLE hv_projects DROP CONSTRAINT fixture_reject");
  expect(await importStateSnapshot(database,snapshot,500)).toEqual(snapshotSummary(snapshot));
  await expect(importStateSnapshot(database,snapshot,500)).rejects.toThrow("empty destination");
  const exported = await exportStateSnapshot(database);
  expect(exported.projects).toEqual(snapshot.projects);
  expect(exported.jobs[0]).toMatchObject(JSON.parse(JSON.stringify(snapshot.jobs[0])));
  expect(exported.ledger.events.map(({eventId: _eventId,...event}) => event)).toEqual(snapshot.ledger.events);
  expect(new Set(exported.ledger.events.map(event => event.eventId)).size).toBe(2);
  expect(snapshotSummary(exported)).toEqual(snapshotSummary(snapshot));
  const job = snapshot.jobs[0]!;
  const otherId = crypto.randomUUID(), otherProject = crypto.randomUUID();
  const other = {...job,id:otherId,projectId:otherProject,status:"running"};
  await database.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body)
    values (${otherId},${otherProject},'active-other-project','animatic','running','free',${other}::jsonb)`;
  expect(snapshotSummary(await exportStateSnapshot(database,job.projectId))).toEqual(snapshotSummary(snapshot));
  await expect(exportStateSnapshot(database)).rejects.toThrow("drained jobs");
  await database.sql`delete from hv_jobs where id = ${otherId}`;
  const attempt = crypto.randomUUID();
  await database.sql`insert into hv_provider_attempts (id,project_id,job_id,shot_id,provider,worker_id,lease_version,status,estimated_usd)
    values (${attempt},${job.projectId},${job.id},'fixture','fixture','fixture',1,'unknown',0.01)`;
  await expect(exportStateSnapshot(database)).rejects.toThrow("billing must be reconciled");
  await database.sql`delete from hv_provider_attempts where id = ${attempt}`;
  expect(snapshotSummary(await exportStateSnapshot(database))).toEqual(snapshotSummary(snapshot));
});
