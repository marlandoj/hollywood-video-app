import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStorageBackup, restoreStorageBackup, verifyStorageBackup } from "../src/backups";
import { StudioDatabase } from "../src/database";
import { objectClient, PostgresArtifactStore } from "../src/artifacts";
import { PostgresProjectService } from "../src/projects";
import { PostgresJobStore } from "../src/jobs";
import { PostgresCostLedger } from "../src/ledger";
import { PostgresRetention } from "../src/retention";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_S3_ENDPOINT && process.env.HV_S3_BACKUP_TEST_BUCKET);
const integration=enabled?test:test.skip;
const suffix=crypto.randomUUID().replaceAll("-","");
const names=["hv_backup_source_"+suffix,"hv_backup_restore_"+suffix];
let admin: StudioDatabase,source: StudioDatabase,target: StudioDatabase,root: string,sourceUrl: string,targetUrl: string;
let sourceClient: ReturnType<typeof objectClient>,targetClient: ReturnType<typeof objectClient>;
const keys=new Set<string>();
const originalBucket=process.env.HV_S3_BUCKET,originalBin=process.env.HV_PG_BIN;
beforeAll(async()=>{
  if (!enabled) return;
  if (!/^rough-cut-backup-test(?:-ci)?$/.test(process.env.HV_S3_BACKUP_TEST_BUCKET!)) throw new Error("unexpected backup fixture bucket");
  root=mkdtempSync(join(tmpdir(),"hv-backup-test-"));
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  for (const name of names) await admin.sql.unsafe('CREATE DATABASE "'+name+'"');
  const url=new URL(process.env.HV_PG_ADMIN_URL!);url.pathname="/"+names[0];sourceUrl=url.href;
  source=new StudioDatabase(sourceUrl);await source.migrate();
  url.pathname="/"+names[1];targetUrl=url.href;target=new StudioDatabase(targetUrl);
  sourceClient=objectClient();process.env.HV_S3_BUCKET=process.env.HV_S3_BACKUP_TEST_BUCKET;targetClient=objectClient();process.env.HV_S3_BUCKET=originalBucket;
  if ((await targetClient.list({maxKeys:1})).contents?.length) throw new Error("backup fixture destination is not empty");
});
afterAll(async()=>{
  if (!enabled) return;
  if (originalBin===undefined) delete process.env.HV_PG_BIN;else process.env.HV_PG_BIN=originalBin;
  process.env.HV_S3_BUCKET=originalBucket;
  for (const key of keys) {await sourceClient.file(key).delete();await targetClient.file(key).delete();}
  await source?.close();await target?.close();
  for (const name of names) {
    if (!/^hv_backup_(source|restore)_[a-f0-9]{32}$/.test(name)) throw new Error("unsafe fixture database name");
    await admin.sql.unsafe('DROP DATABASE "'+name+'"');
  }
  await admin?.close();if (root) rmSync(root,{recursive:true,force:true});
});
integration("slow backup preserves its snapshot, deletion lock, active jobs and unknown financial holds",async()=>{
  process.env.HV_TOKEN_SECRET="backup-fixture-secret-at-least-thirty-two-characters";
  const projects=new PostgresProjectService(source),jobs=new PostgresJobStore(source),ledger=new PostgresCostLedger(source);
  const owner=await projects.createAnonymousProject();await projects.editScript(owner.token,"EXT. GARDEN - DAY\n\nBackup screenplay.");await projects.attestRights(owner.token);
  const id=crypto.randomUUID();
  await jobs.enqueue({id,idempotencyKey:id,projectId:owner.projectId,stage:"animatic",tier:"free",scriptVersion:1,scriptText:"Backup screenplay.",
    rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null,totalFrames:30,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:120_000,costCapUsd:0.03});
  await ledger.reserve(id,"animatic",0.03,1);
  const job=(await jobs.claimNext(Date.now(),{},{workerId:"backup-test",leaseMs:120_000}))!;
  const attempt={id:crypto.randomUUID(),projectId:owner.projectId,jobId:id,shotId:"shot-1",provider:"fixture",workerId:"backup-test",leaseVersion:job.leaseVersion!,estimateUsd:0.01};
  await ledger.beginAttempt(attempt);
  await ledger.record({eventId:attempt.id+":0",attemptId:attempt.id,projectId:owner.projectId,jobId:id,shotId:"shot-1",stage:"animatic",at:new Date().toISOString(),
    provider:"fixture",model:"fixture",prompt_tokens:1,output_frames:30,gpu_seconds:0.1,total_cost_usd:0.005});
  await ledger.finishAttempt(attempt.id,"unknown");await ledger.release(id);
  const directory=join(root,owner.projectId,id);mkdirSync(directory,{recursive:true});
  const media=join(directory,"checkpoint.txt");writeFileSync(media,"durable checkpoint");
  await new PostgresArtifactStore(source,root).publishExport(job,"backup-test",[media]);
  const key=(await source.sql`select object_key from hv_artifacts where job_id=${id}`)[0].object_key;keys.add(key);

  // A real pg_dump is delayed past the normal pool's 20-second idle timeout.
  const binary=originalBin?resolve(originalBin,"pg_dump"):Bun.which("pg_dump");
  if (!binary || !existsSync(binary) || !/^[A-Za-z0-9_./-]+$/.test(binary+root)) throw new Error("PostgreSQL client is unavailable");
  const wrapper=join(root,"pg-bin"),started=join(root,"dump-started");mkdirSync(wrapper);
  writeFileSync(join(wrapper,"pg_dump"),`#!/bin/sh\n: > '${started}'\nsleep 22\nexec '${binary}' "$@"\n`,{mode:0o700});
  process.env.HV_PG_BIN=wrapper;
  const backup=createStorageBackup(sourceUrl,join(root,"repository"));
  // Attach a handler while waiting on the explicit fixture barrier.
  let failure: unknown;void backup.catch(error=>{failure=error;});
  for (let count=0;!existsSync(started)&&count<200;count++) {if (failure) throw failure;await Bun.sleep(25);}
  expect(existsSync(started)).toBe(true);
  await projects.createAnonymousProject(); // A later write must be absent from the snapshot.
  const retention=new PostgresRetention(source);
  await source.sql`update hv_projects set delete_after=now()-interval '1 second' where id=${owner.projectId}`;
  expect(await retention.purgeProject(owner.projectId)).toBe(true);
  expect(await retention.drain()).toEqual({projects:0,objects:0});
  expect(await sourceClient.file(key).exists()).toBe(true);
  const manifest=await backup;
  expect(manifest.summary).toEqual({projects:1,jobs:1,costEvents:1,recordedCostUsd:0.005});
  expect(manifest.objects.length).toBe(1);
  expect(Date.parse(manifest.completedAt)-Date.parse(manifest.snapshotAt)).toBeGreaterThanOrEqual(21_000);
  expect(await retention.drain()).toEqual({projects:1,objects:1});expect(await sourceClient.file(key).exists()).toBe(false);
  if (originalBin===undefined) delete process.env.HV_PG_BIN;else process.env.HV_PG_BIN=originalBin;

  process.env.HV_S3_BUCKET=process.env.HV_S3_BACKUP_TEST_BUCKET;
  try {
    await targetClient.file(key).write("occupied");
    await expect(restoreStorageBackup(target,targetUrl,join(root,"repository"))).rejects.toThrow("empty private bucket");
    await targetClient.file(key).delete();
    expect((await restoreStorageBackup(target,targetUrl,join(root,"repository"))).id).toBe(manifest.id);
    expect(await targetClient.file(key).text()).toBe("durable checkpoint");
    expect(await new PostgresProjectService(target).authorize(owner.token)).not.toBeNull();
    expect((await new PostgresJobStore(target).get(id))?.status).toBe("running");
    const recovered=new PostgresCostLedger(target);
    expect(await recovered.jobSpend(id)).toBe(0.005);expect(await recovered.reservedUsd()).toBeCloseTo(0.005,6);
    expect((await target.sql`select status from hv_provider_attempts where id=${attempt.id}`)[0].status).toBe("unknown");
    await expect(restoreStorageBackup(target,targetUrl,join(root,"repository"))).rejects.toThrow("empty offline database");
  } finally {process.env.HV_S3_BUCKET=originalBucket;}
},60_000);

test("backup verification rejects altered payloads, invalid paths and linked blob directories",async()=>{
  const fixture=mkdtempSync(join(tmpdir(),"hv-backup-integrity-")),snapshot=join(fixture,"snapshots","fixture");
  const sha=(value: string)=>createHash("sha256").update(value).digest("hex");
  mkdirSync(snapshot,{recursive:true});mkdirSync(join(fixture,"blobs"));
  writeFileSync(join(snapshot,"state.dump"),"dump");writeFileSync(join(fixture,"blobs",sha("media")),"media");
  const manifest={schema:"hv-backup/1",id:"fixture",source:{cluster:"123",database:"fixture"},snapshotAt:new Date().toISOString(),completedAt:new Date().toISOString(),
    database:{file:"state.dump",bytes:4,sha256:sha("dump")},objects:[{key:`v1/project/job/${sha("media")}/clip.bin`,bytes:5,sha256:sha("media")}],
    summary:{projects:1,jobs:1,costEvents:0,recordedCostUsd:0}};
  const save=()=>{writeFileSync(join(snapshot,"backup.json"),JSON.stringify(manifest));writeFileSync(join(snapshot,"receipt.json"),JSON.stringify({schema:"hv-backup-receipt/1",manifestSha256:sha(JSON.stringify(manifest))}));};save();
  try {
    expect((await verifyStorageBackup(fixture,"fixture")).manifest.id).toBe("fixture");
    writeFileSync(join(snapshot,"state.dump"),"fail");await expect(verifyStorageBackup(fixture,"fixture")).rejects.toThrow("database checksum");writeFileSync(join(snapshot,"state.dump"),"dump");
    writeFileSync(join(fixture,"blobs",sha("media")),"alter");await expect(verifyStorageBackup(fixture,"fixture")).rejects.toThrow("media checksum");writeFileSync(join(fixture,"blobs",sha("media")),"media");
    manifest.objects[0]!.key="v1/../job/"+sha("media")+"/clip.bin";save();await expect(verifyStorageBackup(fixture,"fixture")).rejects.toThrow("object path");
    await expect(verifyStorageBackup(fixture,"../fixture")).rejects.toThrow("identifier");
    writeFileSync(join(snapshot,"backup.json"),readFileSync(join(snapshot,"backup.json"),"utf8")+" ");await expect(verifyStorageBackup(fixture,"fixture")).rejects.toThrow("manifest checksum");
    rmSync(join(fixture,"blobs"),{recursive:true});symlinkSync(snapshot,join(fixture,"blobs"),"dir");await expect(verifyStorageBackup(fixture,"fixture")).rejects.toThrow("directory is unsafe");
  } finally {rmSync(fixture,{recursive:true,force:true});}
});
