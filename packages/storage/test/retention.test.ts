import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioDatabase } from "../src/database";
import { PostgresProjectService } from "../src/projects";
import { PostgresJobStore } from "../src/jobs";
import { PostgresCostLedger } from "../src/ledger";
import { objectClient, PostgresArtifactStore } from "../src/artifacts";
import { PostgresRetention } from "../src/retention";
import type { CostEvent } from "../../operator/src/index";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_WORKER_DATABASE_URL && process.env.HV_S3_ENDPOINT);
const s3test = enabled ? test : test.skip;
const name = "hv_retention_test_" + crypto.randomUUID().replaceAll("-","");
let admin: StudioDatabase, database: StudioDatabase, root: string;
const objects = new Set<string>();
beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "retention-fixture-secret-at-least-thirty-two-characters";
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  await admin.sql.unsafe('CREATE DATABASE "'+name+'"');
  const url = new URL(process.env.HV_PG_ADMIN_URL!); url.pathname = "/"+name;
  const migration = new StudioDatabase(url.href); await migration.migrate(); await migration.close();
  const workerUrl = new URL(process.env.HV_WORKER_DATABASE_URL!); workerUrl.pathname = "/"+name;
  database = new StudioDatabase(workerUrl.href);
  root = mkdtempSync(join(tmpdir(),"hv-retention-"));
});
afterAll(async () => {
  if (!enabled) return;
  for (const key of objects) await objectClient().file(key).delete();
  await database?.close();
  if (!/^hv_retention_test_[a-f0-9]{32}$/.test(name)) throw new Error("unexpected retention fixture database");
  await admin.sql.unsafe('DROP DATABASE "'+name+'"'); await admin.close();
  rmSync(root,{recursive:true,force:true});
});
s3test("retention removes content with retryable media deletion while preserving unknown holds and late bills",async () => {
  expect((await database.sql`select current_user as role`)[0].role).toBe("hv_worker");
  const projects = new PostgresProjectService(database), store = new PostgresJobStore(database), ledger = new PostgresCostLedger(database);
  const retention = new PostgresRetention(database), client = objectClient();
  const owner = await projects.createAnonymousProject(), kept = await projects.createAnonymousProject();
  await projects.editScript(owner.token,"EXT. GARDEN - DAY\n\nPrivate screenplay fixture."); await projects.attestRights(owner.token);
  await projects.createReviewLink(owner.token,"approve");
  const jobId = crypto.randomUUID();
  await store.enqueue({id:jobId,idempotencyKey:jobId,projectId:owner.projectId,stage:"animatic",tier:"free",scriptVersion:1,
    scriptText:"Private screenplay fixture.",rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null,
    totalFrames:30,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60_000,costCapUsd:0.03});
  await ledger.reserve(jobId,"animatic",0.03,1);
  const job = (await store.claimNext(Date.now(),{},{workerId:"retention",leaseMs:60_000}))!;
  const attempt = {id:crypto.randomUUID(),projectId:owner.projectId,jobId,shotId:"shot-1",provider:"fixture",workerId:"retention",leaseVersion:job.leaseVersion!,estimateUsd:0.01};
  await ledger.beginAttempt(attempt);
  const cost: CostEvent = {eventId:attempt.id+":0",attemptId:attempt.id,projectId:owner.projectId,jobId,shotId:"shot-1",
    stage:"animatic",at:new Date().toISOString(),provider:"fixture",model:"fixture",prompt_tokens:1,output_frames:30,gpu_seconds:0.1,total_cost_usd:0.005};
  await ledger.record(cost); await ledger.finishAttempt(attempt.id,"unknown");
  const directory = join(root,owner.projectId,jobId); mkdirSync(directory,{recursive:true});
  const media = join(directory,"private.txt"); writeFileSync(media,"private media fixture");
  const artifacts = new PostgresArtifactStore(database,root);
  await artifacts.publishExport(job,"retention",[media]);
  const stored = (await database.sql`select object_key from hv_artifacts where project_id = ${owner.projectId}`)[0].object_key;
  objects.add(stored);
  const orphan = `v1/${owner.projectId}/${jobId}/${"0".repeat(64)}/orphan.bin`;
  const archive = `archives/${owner.projectId}/${crypto.randomUUID()}/${"1".repeat(64)}.zip`;
  const keptKey = `v1/${kept.projectId}/fixture/${"2".repeat(64)}/keep.bin`;
  for (const key of [orphan,archive,keptKey]) {objects.add(key);await client.file(key).write("fixture");}
  await database.sql`insert into hv_archives (id,project_id,schema_version,manifest_sha256,object_key)
    values (${crypto.randomUUID()},${owner.projectId},'hv-project-archive/1',${"1".repeat(64)},${archive})`;
  expect(await retention.purgeProject(owner.projectId)).toBe(false);
  await database.sql`update hv_projects set delete_after = now()-interval '1 second' where id = ${owner.projectId}`;
  await expect(ledger.beginAttempt({...attempt,id:crypto.randomUUID()})).rejects.toThrow("expired");
  expect(await retention.purgeProject(owner.projectId)).toBe(true);
  expect(await projects.authorize(owner.token)).toBeNull();
  const abandoned = join(root,".workers",crypto.randomUUID(),owner.projectId,jobId);
  mkdirSync(abandoned,{recursive:true}); writeFileSync(join(abandoned,"private.txt"),"abandoned media");
  expect(await retention.clearLocalCaches(root)).toBe(2);
  expect(existsSync(directory)).toBe(false); expect(existsSync(abandoned)).toBe(false);
  expect(await store.get(jobId)).toBeUndefined();
  await expect(store.heartbeat(jobId,"retention")).rejects.toThrow("unknown job");
  expect((await database.sql`select body from hv_projects where id = ${owner.projectId}`)[0].body).toEqual({});
  const content = (await database.sql`select (select count(*) from hv_reviews where project_id = ${owner.projectId})+
    (select count(*) from hv_artifacts where project_id = ${owner.projectId})+(select count(*) from hv_archives where project_id = ${owner.projectId})+
    (select count(*) from hv_operator_reviews where project_id = ${owner.projectId}) as count`)[0];
  expect(Number(content.count)).toBe(0);
  expect(await ledger.jobSpend(jobId)).toBe(0.005); expect(await ledger.reservedUsd()).toBeCloseTo(0.005,6);
  const failed = new PostgresRetention(database,{list:async()=>{throw new Error("injected object outage");},file:client.file.bind(client)});
  await expect(failed.drain()).rejects.toThrow("injected object outage");
  expect(Number((await database.sql`select count(*) as count from hv_outbox where event_type = 'storage.project.delete' and published_at is null`)[0].count)).toBe(1);
  expect(await retention.drain()).toEqual({projects:1,objects:3});
  for (const key of [stored,orphan,archive]) expect(await client.file(key).exists()).toBe(false);
  expect(await client.file(keptKey).exists()).toBe(true);
  expect(await retention.purgeProject(owner.projectId)).toBe(false);
  await ledger.record({...cost,eventId:attempt.id+":1"}); await ledger.finishAttempt(attempt.id,"failed"); await ledger.release(jobId);
  expect(await ledger.jobSpend(jobId)).toBe(0.01); expect(await ledger.reservedUsd()).toBe(0);

  const sha = new Bun.CryptoHasher("sha256").update("fixture").digest("hex");
  const referencedKey = `v1/${kept.projectId}/fixture/${sha}/referenced.bin`;
  objects.add(referencedKey); await client.file(referencedKey).write("fixture");
  await database.sql`insert into hv_artifacts (key,object_key,project_id,job_id,sha256,bytes,content_type,backend)
    values (${kept.projectId+"/fixture/referenced.bin"},${referencedKey},${kept.projectId},'fixture',${sha},7,'application/octet-stream','s3')`;
  const anotherJob = crypto.randomUUID();
  await store.enqueue({...job,id:anotherJob,idempotencyKey:anotherJob,projectId:kept.projectId});
  const future = Date.now()+2*864e5;
  expect(await retention.collectOrphans(future)).toBe(0); // Active work protects its project namespace.
  await store.setStatus(anotherJob,"cancelled");
  expect(await retention.collectOrphans()).toBe(0); // Fresh uploads retain their grace period.
  expect(await retention.collectOrphans(future)).toBe(1);
  expect(await client.file(keptKey).exists()).toBe(false);
  expect(await client.file(referencedKey).exists()).toBe(true);
  await projects.takedown(kept.projectId,"fixture takedown");
  expect(await retention.sweep()).toEqual([kept.projectId]);
  expect(await retention.drain()).toEqual({projects:1,objects:1});
},60_000);
