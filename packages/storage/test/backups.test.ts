import {withAnchorStoryboard} from "../../generator/src/catalog";
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
import { normalizeReference, ReferenceBlobStore } from "../src/references";
import { referenceObjectKey } from "../../planner/src/references";
import { DeterministicMockImageProvider } from "../../generator/src/image";
import { CAST_INPUT } from "../../../test/fixtures/casting";
import { exportProjectArchive, importProjectArchive } from "../src/archives";
import { createCharacterSheet } from "../../planner/src/sheets";
import { createProviderPlan } from "../../generator/src/catalog";
import { parseFountain } from "../../parser/src/index";
import { processNextJob } from "../../queue/src/worker";
import { PostgresReviewQueue } from "../src/reviews";
import {mintActorToken} from "../../api/src/actor-token";
import {copiedActorReferences} from "../../planner/src/actor-library";
import {planShots} from "../../planner/src/index";
import {directionEntry} from "../../planner/src/direction";
import {createShotTakes} from "../../planner/src/takes";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_S3_ENDPOINT && process.env.HV_S3_BACKUP_TEST_BUCKET);
const integration=enabled?test:test.skip;
const suffix=crypto.randomUUID().replaceAll("-","");
const names=["hv_backup_source_"+suffix,"hv_backup_restore_"+suffix,"hv_backup_restore_"+crypto.randomUUID().replaceAll("-","")];
let admin: StudioDatabase,source: StudioDatabase,target: StudioDatabase,archiveTarget: StudioDatabase,root: string,sourceUrl: string,targetUrl: string;
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
  url.pathname="/"+names[2];archiveTarget=new StudioDatabase(url.href);await archiveTarget.migrate();
  sourceClient=objectClient();process.env.HV_S3_BUCKET=process.env.HV_S3_BACKUP_TEST_BUCKET;targetClient=objectClient();process.env.HV_S3_BUCKET=originalBucket;
  if ((await targetClient.list({maxKeys:1})).contents?.length) throw new Error("backup fixture destination is not empty");
});
afterAll(async()=>{
  if (!enabled) return;
  if (originalBin===undefined) delete process.env.HV_PG_BIN;else process.env.HV_PG_BIN=originalBin;
  process.env.HV_S3_BUCKET=originalBucket;
  for (const key of keys) {await sourceClient.file(key).delete();await targetClient.file(key).delete();}
  await source?.close();await target?.close();await archiveTarget?.close();
  for (const name of names) {
    if (!/^hv_backup_(source|restore)_[a-f0-9]{32}$/.test(name)) throw new Error("unsafe fixture database name");
    await admin.sql.unsafe('DROP DATABASE "'+name+'"');
  }
  await admin?.close();if (root) rmSync(root,{recursive:true,force:true});
});
integration("slow backup preserves its snapshot, deletion lock, active jobs and unknown financial holds",async()=>{
  process.env.HV_TOKEN_SECRET="backup-fixture-secret-at-least-thirty-two-characters";
  const projects=new PostgresProjectService(source),jobs=new PostgresJobStore(source),ledger=new PostgresCostLedger(source);
  const script="EXT. GARDEN - DAY\n\nSpud waves beside the gate.";
  const owner=await projects.createAnonymousProject();await projects.editScript(owner.token,script);await projects.attestRights(owner.token);
  const direction=(await projects.saveShotDirection(owner.token,"shot-1-1",{durationFrames:121,previewMove:"pan-left",lensMm:85,coverage:{role:"master",subjects:["SPUD"],axis:"garden",cameraSide:"a"}},0,1,directionEntry(planShots(parseFountain(script),7000,24)[0]!,{}).sourceHash))!;
  const characterId=crypto.randomUUID();await projects.saveCharacter(owner.token,characterId,CAST_INPUT,0);
  const frame=await new DeterministicMockImageProvider().generateFrame("A fictional potato",7,{},join(root,"reference.png"));
  const reference=await normalizeReference(readFileSync(frame.path),owner.projectId);
  const referenceKey=referenceObjectKey(reference.asset);keys.add(referenceKey);
  await new ReferenceBlobStore(root,sourceClient).put(reference.asset,reference.data);
  const casting=await projects.addCharacterReference(owner.token,characterId,reference.asset,1);
  const share=(await projects.shareCharacter(owner.token,characterId,2,true))!;
  await projects.removeCharacterReference(owner.token,characterId,reference.asset.id,2);
  expect(await new PostgresRetention(source).collectOrphans(Date.now()+7200_000,3600_000)).toBe(0);
  expect(await sourceClient.file(referenceKey).exists()).toBe(true); // History alone keeps the asset indexed.
  const id=crypto.randomUUID();
  await jobs.enqueue({id,idempotencyKey:id,projectId:owner.projectId,stage:"animatic",tier:"free",scriptVersion:1,scriptText:script,
    casting:casting!,direction,rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null,totalFrames:121,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:120_000,costCapUsd:0.03});
  await ledger.reserve(id,"animatic",0.03,1);
  const job=(await jobs.claimNext(Date.now(),{},{workerId:"backup-test",leaseMs:120_000}))!;
  const attempt={id:crypto.randomUUID(),projectId:owner.projectId,jobId:id,shotId:"shot-1-1",provider:"fixture",workerId:"backup-test",leaseVersion:job.leaseVersion!,estimateUsd:0.01};
  await ledger.beginAttempt(attempt);
  await ledger.record({eventId:attempt.id+":0",attemptId:attempt.id,projectId:owner.projectId,jobId:id,shotId:"shot-1-1",stage:"animatic",at:new Date().toISOString(),
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
  expect(manifest.objects.length).toBe(2);
  expect(Date.parse(manifest.completedAt)-Date.parse(manifest.snapshotAt)).toBeGreaterThanOrEqual(21_000);
  expect(await retention.drain()).toEqual({projects:1,objects:2});expect(await sourceClient.file(key).exists()).toBe(false);
  expect(await sourceClient.file(referenceKey).exists()).toBe(false);
  if (originalBin===undefined) delete process.env.HV_PG_BIN;else process.env.HV_PG_BIN=originalBin;

  process.env.HV_S3_BUCKET=process.env.HV_S3_BACKUP_TEST_BUCKET;
  try {
    await targetClient.file(key).write("occupied");
    await expect(restoreStorageBackup(target,targetUrl,join(root,"repository"))).rejects.toThrow("empty private bucket");
    await targetClient.file(key).delete();
    expect((await restoreStorageBackup(target,targetUrl,join(root,"repository"))).id).toBe(manifest.id);
    expect(await targetClient.file(key).text()).toBe("durable checkpoint");
    expect(await new PostgresProjectService(target).authorize(owner.token)).not.toBeNull();
    expect((await new PostgresProjectService(target).authorize(owner.token))!.referenceAssets).toEqual([reference.asset]);
    expect(await new ReferenceBlobStore(join(root,"restored-reference"),targetClient).read(reference.asset)).toEqual(reference.data);
    expect(await new PostgresProjectService(target).sharedActor(mintActorToken(share))).toEqual(share);
    expect((await new PostgresJobStore(target).get(id))?.status).toBe("running");
    expect((await new PostgresJobStore(target).get(id))?.direction).toEqual(direction);
    expect((await new PostgresProjectService(target).authorize(owner.token))!.directionHistory).toEqual([direction]);
    const recovered=new PostgresCostLedger(target);
    expect(await recovered.jobSpend(id)).toBe(0.005);expect(await recovered.reservedUsd()).toBeCloseTo(0.005,6);
    expect((await target.sql`select status from hv_provider_attempts where id=${attempt.id}`)[0].status).toBe("unknown");
    await expect(restoreStorageBackup(target,targetUrl,join(root,"repository"))).rejects.toThrow("empty offline database");
  } finally {process.env.HV_S3_BUCKET=originalBucket;for(const value of keys)await targetClient.file(value).delete();}
},60_000);

integration("portable archives restore character sheets and derived references with detached cast history into isolated PostgreSQL and S3",async()=>{
  const projects=new PostgresProjectService(source),owner=await projects.createAnonymousProject(),characterId=crypto.randomUUID();
  await projects.editScript(owner.token,"EXT. GARDEN - DAY\n\nSpud waves.");await projects.saveCharacter(owner.token,characterId,CAST_INPUT,0);
  const frame=await new DeterministicMockImageProvider().generateFrame("A fictional potato",8,{},join(root,"archive-reference.png"));
  const {asset,data}=await normalizeReference(readFileSync(frame.path),owner.projectId),key=referenceObjectKey(asset);keys.add(key);
  await new ReferenceBlobStore(root,sourceClient).put(asset,data);await projects.addCharacterReference(owner.token,characterId,asset,1);
  const casting=(await projects.removeCharacterReference(owner.token,characterId,asset.id,2))!;await projects.attestRights(owner.token);
  const project=(await projects.authorize(owner.token))!,script=project.versions.latest()!.text,id=crypto.randomUUID();
  const characterSheet=createCharacterSheet(casting,parseFountain(script),characterId,{kind:"turnaround",seed:123,sceneNumber:null}),ledger=new PostgresCostLedger(source),jobs=new PostgresJobStore(source);
  await ledger.admit(owner.projectId,{id,projectId:owner.projectId,idempotencyKey:id,stage:"character-sheet",tier:"free",scriptVersion:1,scriptText:script,casting,characterSheet,
    providerPlan:createProviderPlan("character-sheet",1),rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:120,costCapUsd:4,budgetReservedUsd:0,
    retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60_000},500);
  const artifactStore=new PostgresArtifactStore(source,root),sheet=await processNextJob(jobs,root,{projects,ledger,artifacts:artifactStore,reviewQueue:new PostgresReviewQueue(source)});
  expect(sheet?.failureReason).toBeUndefined();expect(sheet?.id).toBe(id);expect(sheet?.status).toBe("done");
  const records=await source.sql`select key,object_key from hv_artifacts where job_id=${id}`;for(const record of records)keys.add(record.object_key);
  for(const object of (await sourceClient.list({prefix:"v1/"+owner.projectId+"/"+id+"/",maxKeys:1000})).contents??[])keys.add(object.key);
  // Shared-storage workers clear their cache after completion; read the durable S3 copy.
  expect(existsSync(join(root,sheet!.output!.sheetPath!))).toBe(false);await artifactStore.restoreCheckpoint(sheet!);
  const anchor=await normalizeReference(data,owner.projectId);anchor.asset.source={kind:"shot-anchor",shotId:"shot-1-1",sourceHash:directionEntry(planShots(parseFountain(script),7000,24)[0]!,{}).sourceHash,label:"Opening garden"};
  keys.add(referenceObjectKey(anchor.asset));await new ReferenceBlobStore(root,sourceClient).put(anchor.asset,anchor.data);
  expect(await projects.storeFrameAnchorAsset(owner.token,anchor.asset,0,1)).toEqual(anchor.asset);
  const direction=(await projects.saveShotDirection(owner.token,"shot-1-1",{frameAnchors:{frames:[{at:0,asset:anchor.asset}],fallback:"storyboard"},durationFrames:121,previewMove:"static",lensMm:35,keyLight:"Soft daylight from the window",framing:{x:5000,y:2500,size:5000},optics:{sensorWidthMm:36,sensorHeightMm:24,squeeze:1,look:"Soft natural contrast"},coverage:{role:"master",subjects:["SPUD"],axis:"garden",cameraSide:"a"}},0,1,directionEntry(planShots(parseFountain(script),7000,24)[0]!,{}).sourceHash))!;
  const previewId=crypto.randomUUID(),filmCasting=(await projects.authorize(owner.token))!.castingHistory.at(-1)!;
  await ledger.admit(owner.projectId,{id:previewId,projectId:owner.projectId,idempotencyKey:previewId,stage:"animatic",tier:"free",scriptVersion:1,scriptText:script,casting:filmCasting,direction,
    providerPlan:withAnchorStoryboard(createProviderPlan("animatic",1),true),rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:121,costCapUsd:4,budgetReservedUsd:0,
    retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60_000},500);
  const preview=await processNextJob(jobs,root,{projects,ledger,references:new ReferenceBlobStore(root,sourceClient),artifacts:artifactStore,reviewQueue:new PostgresReviewQueue(source)});
  expect(preview?.id).toBe(previewId);expect(preview?.failureReason).toBeUndefined();expect(preview?.status).toBe("done");
  const previewRecords=await source.sql`select key,object_key from hv_artifacts where job_id=${previewId}`;for(const record of previewRecords)keys.add(record.object_key);
  for(const object of (await sourceClient.list({prefix:"v1/"+owner.projectId+"/"+previewId+"/",maxKeys:1000})).contents??[])keys.add(object.key);
  await artifactStore.restoreCheckpoint(preview!);
  const previewManifest=JSON.parse(readFileSync(join(root,preview!.output!.manifestPath),"utf8"));expect(previewManifest.direction).toEqual(direction);expect(previewManifest.shots[0].durationSec).toBe(121/30);expect(previewManifest.coverage.scenes[0].inventory.master).toEqual(["shot-1-1"]);
  const takeId=crypto.randomUUID(),shotTakes=createShotTakes(owner.projectId,1,filmCasting,direction,parseFountain(script),{shotId:"shot-1-1",sourceHash:direction.entries[0]!.sourceHash,maxShots:24,takes:[35,85].map((lensMm,i)=>({label:"Take "+"AB"[i],seed:9000+i,settings:{lensMm,...(i===1?{frameAnchors:null,cameraPath:{mode:"screen-space",keyframes:[{at:0,x:0,y:2500,size:5000,easing:"smooth"},{at:10000,x:5000,y:2500,size:5000,easing:"linear"}]}}:{})}}))});
  await ledger.admit(owner.projectId,{id:takeId,projectId:owner.projectId,idempotencyKey:takeId,stage:"take-preview",tier:"free",scriptVersion:1,scriptText:script,casting:filmCasting,direction,shotTakes,
    providerPlan:withAnchorStoryboard(createProviderPlan("animatic",1),true),rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:242,costCapUsd:2,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000},500);
  const takeGroup=await processNextJob(jobs,root,{projects,ledger,references:new ReferenceBlobStore(root,sourceClient),artifacts:artifactStore,reviewQueue:new PostgresReviewQueue(source)});
  expect(takeGroup?.id).toBe(takeId);expect(takeGroup?.failureReason??takeGroup?.cancelReason).toBeUndefined();expect(takeGroup?.status).toBe("done");expect(takeGroup!.output!.takeClips).toHaveLength(2);
  const takeRecords=await source.sql`select key,object_key from hv_artifacts where job_id=${takeId}`;for(const record of takeRecords)keys.add(record.object_key);
  for(const object of (await sourceClient.list({prefix:"v1/"+owner.projectId+"/"+takeId+"/",maxKeys:1000})).contents??[])keys.add(object.key);
  await artifactStore.restoreCheckpoint(takeGroup!);
  const first=sheet!.output!.storyboard![0]!,derived=await normalizeReference(readFileSync(join(root,first.path)),owner.projectId);
  derived.asset.source={kind:"character-sheet",jobId:id,viewId:first.shotId,castingRevision:casting.revision};keys.add(referenceObjectKey(derived.asset));
  await new ReferenceBlobStore(root,sourceClient).put(derived.asset,derived.data);await projects.addCharacterReferences(owner.token,characterId,[derived.asset],3,Date.now(),{expectedScriptVersion:1});
  const donor=await projects.createAnonymousProject(),donorId=crypto.randomUUID();await projects.editScript(donor.token,script);await projects.saveCharacter(donor.token,donorId,CAST_INPUT,0);
  const donorReference=await normalizeReference(data,donor.projectId);keys.add(referenceObjectKey(donorReference.asset));await new ReferenceBlobStore(root,sourceClient).put(donorReference.asset,donorReference.data);
  await projects.addCharacterReference(donor.token,donorId,donorReference.asset,1);const donorShare=(await projects.shareCharacter(donor.token,donorId,2,true))!;
  const copied=copiedActorReferences(donorShare,owner.projectId);for(const reference of copied){keys.add(referenceObjectKey(reference));await new ReferenceBlobStore(root,sourceClient).put(reference,donorReference.data);}
  await projects.importSharedActor(owner.token,mintActorToken(donorShare),copied,4,{name:"GUEST",aliases:[],attested:true});
  const actorShare=(await projects.shareCharacter(owner.token,characterId,5,true))!;
  const archive=join(root,"reference-project.hv.zip");
  const exported=await exportProjectArchive(source,owner.projectId,join(root,"archive-prepared"),archive);
  expect(exported.files).toBe(9+records.length+previewRecords.length+takeRecords.length);expect(exported.jobs).toBe(3);
  process.env.HV_S3_BUCKET=process.env.HV_S3_BACKUP_TEST_BUCKET;
  try {
    const imported=await importProjectArchive(archiveTarget,archive,join(root,"archive-imported"),5000);
    expect(imported.mediaFiles).toBe(4+records.length+previewRecords.length+takeRecords.length);expect(imported.mediaBytes).toBeGreaterThan(asset.bytes+derived.asset.bytes);
    const restored=await new PostgresProjectService(archiveTarget).authorize(owner.token);
    expect(restored!.referenceAssets).toEqual([asset,anchor.asset,derived.asset,...copied]);expect(restored!.castingHistory).toEqual((await projects.authorize(owner.token))!.castingHistory);
    expect(restored!.directionHistory).toEqual([direction]);expect(await new ReferenceBlobStore(join(root,"anchor-cache"),targetClient).read(anchor.asset)).toEqual(anchor.data);
    const recoveredTakes=(await new PostgresJobStore(archiveTarget).get(takeId))!,takeCache=join(root,"takes-restored"),takeStore=new PostgresArtifactStore(archiveTarget,takeCache);expect(recoveredTakes.shotTakes).toEqual(shotTakes);expect(recoveredTakes.output!.cameraPathRenders).toEqual([{shotId:"take-b",mode:"screen-space",keyframes:shotTakes.takes[1]!.settings.cameraPath!.keyframes,outputFrames:121}]);
    await takeStore.restoreCheckpoint(recoveredTakes);
    for(const clip of recoveredTakes.output!.takeClips!)for(const path of [clip.path,clip.hlsPath,clip.posterPath,clip.captionsPath,clip.manifestPath])expect(readFileSync(join(takeCache,path))).toEqual(readFileSync(join(root,path)));
    const corruptTake=structuredClone(recoveredTakes);corruptTake.output!.takeClips![0]!.sha256="0".repeat(64);await expect(takeStore.restoreCheckpoint(corruptTake)).rejects.toThrow("take video checksum");
    await archiveTarget.sql`delete from hv_artifacts where key=${recoveredTakes.output!.takeClips![1]!.captionsPath}`;await expect(takeStore.restoreCheckpoint(recoveredTakes)).rejects.toThrow("stored export media is missing");
    const recoveredPreview=(await new PostgresJobStore(archiveTarget).get(previewId))!,previewCache=join(root,"directed-preview-restored");expect(recoveredPreview.direction).toEqual(direction);
    await new PostgresArtifactStore(archiveTarget,previewCache).restoreCheckpoint(recoveredPreview);
    expect(readFileSync(join(previewCache,recoveredPreview.output!.mp4Path))).toEqual(readFileSync(join(root,preview!.output!.mp4Path)));
    expect(JSON.parse(readFileSync(join(previewCache,recoveredPreview.output!.manifestPath),"utf8"))).toEqual(previewManifest);
    const rawSource=recoveredPreview.output!.storyboard![0]!.sourcePath!;expect(rawSource).toBeTruthy();
    expect(readFileSync(join(previewCache,rawSource))).toEqual(readFileSync(join(root,preview!.output!.storyboard![0]!.sourcePath!)));
    const clips=JSON.parse(readFileSync(join(previewCache,owner.projectId,previewId,"clips/manifest.json"),"utf8"));
    expect(readFileSync(clips[0].sourcePosterPath)).toEqual(readFileSync(join(previewCache,rawSource)));
    await archiveTarget.sql`delete from hv_artifacts where key=${rawSource}`;
    await expect(new PostgresArtifactStore(archiveTarget,previewCache).restoreCheckpoint(recoveredPreview)).rejects.toThrow("stored export media is missing");
    expect(await new PostgresProjectService(archiveTarget).sharedActor(mintActorToken(actorShare))).toEqual(actorShare);
    expect(await new PostgresProjectService(archiveTarget).authorize(donor.token)).toBeNull();
    expect(restored!.castingHistory.at(-1)!.characters[1]!.libraryOrigin?.shareId).toBe(donorShare.id);
    expect(await new ReferenceBlobStore(join(root,"archive-cache"),targetClient).read(copied[0]!)).toEqual(donorReference.data);
    expect(await new ReferenceBlobStore(join(root,"archive-cache"),targetClient).read(asset)).toEqual(data);
    expect(await new ReferenceBlobStore(join(root,"archive-cache"),targetClient).read(derived.asset)).toEqual(derived.data);
    const recovered=(await new PostgresJobStore(archiveTarget).get(id))!,cache=join(root,"sheet-restored");expect(recovered.characterSheet).toEqual(characterSheet);
    await new PostgresArtifactStore(archiveTarget,cache).restoreCheckpoint(recovered);
    expect(readFileSync(join(cache,recovered.output!.sheetPath!))).toEqual(readFileSync(join(root,sheet!.output!.sheetPath!)));
    await archiveTarget.sql`delete from hv_artifacts where key=${recovered.output!.sheetPath!}`;
    await expect(new PostgresArtifactStore(archiveTarget,cache).restoreCheckpoint(recovered)).rejects.toThrow("stored export media is missing");
  } finally {process.env.HV_S3_BUCKET=originalBucket;for(const value of keys)await targetClient.file(value).delete();}
},30_000);

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
