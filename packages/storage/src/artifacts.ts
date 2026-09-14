import { S3Client, type SQL } from "bun";
import {assertGraphicPermission,validateGraphicOutput,type GraphicOutput} from "../../planner/src/graphic-jobs";
import {verifyGraphicMedia} from "../../generator/src/graphic-media";
import { createHash } from "node:crypto";
import {contentHash} from "../../generator/src/capabilities";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { DurableJobStore, LeaseError, type Job } from "../../queue/src/index";
import type { VideoClip } from "../../generator/src/index";
import {validateRenderRecord} from "../../planner/src/shot-reuse";
import {validateJobExecutionCheckpoint,validateShotExecutionClips,validateShotExecutionOutput,type ShotExecutionInventoryRow} from "../../planner/src/shot-execution-inventory";
import {assertLivingScriptIdempotency,validateLivingScriptJob,validateLivingScriptOutput,validateLivingScriptClips} from "../../planner/src/living-script-job-context";
import {assertLivingScriptTransaction} from "./living-script-context";
import {assertCurrentFilmTransaction} from "./current-film-context";
import {verifyCurrentFilmMedia} from "../../queue/src/current-film-media";
import {assertCurrentFilmHeldInputs,validateCurrentFilmJob,validateCurrentFilmOutput,validateCurrentFilmClips,advanceCurrentFilmCheckpoint,type CurrentFilmCheckpoint} from "../../planner/src/current-film-job-context";
import {retainedDialogueTime,validateDialogueOutput} from "../../planner/src/dialogue-jobs";
import {verifyDialogueMedia} from "../../generator/src/dialogue-replacement";
import {assertSoundPermission,assertSoundSourceAvailable,validateSoundOutput} from "../../planner/src/sound-jobs";
import {verifySoundMedia} from "../../generator/src/sound-media";
import {verifyEditMedia} from "../../generator/src/edit-media";
import {verifyEditAssemblyMedia} from "../../generator/src/edit-assembly-media";
import {assertEditAssemblyPermission,validateEditAssemblyOutput} from "../../planner/src/edit-assembly-jobs";
import {assertEditFreeSpace,editWorkspaceGuard} from "../../generator/src/edit-workspace";
import {assertEditBindingAvailable,assertEditPermission,validateEditOutput} from "../../planner/src/edit-jobs";
import {verifyAudioMedia} from "../../generator/src/audio-media";
import {assertAudioTakePermission,validateAudioTakeOutput,type AudioTakeOutput} from "../../planner/src/audio-jobs";
import {assertLipSyncPermission,assertLipSyncSourceAvailable,lipSyncPreparedFiles,validateLipSyncPrepared,validateLipSyncOutput,type LipSyncPrepared} from "../../planner/src/lipsync";
import {configuredLipSyncPolicy,validateLipSyncPolicy,lipSame} from "../../planner/src/lipsync-policy";
import {verifyLipSyncPrepared,verifyLipSyncMedia} from "../../generator/src/lipsync-media";
import type {PersistedProject} from "../../api/src/index";
import { writeJsonFile } from "../../queue/src/persist";
import { StudioDatabase } from "./database";
import { objectStoreConfig } from "./s3-requests";

const TYPES: Record<string,string> = {".wav":"audio/wav",".mp4":"video/mp4",".png":"image/png",".m3u8":"application/vnd.apple.mpegurl",
  ".ts":"video/mp2t",".vtt":"text/vtt; charset=utf-8",".srt":"application/x-subrip",".json":"application/json"};
export interface ArtifactRecord {
  key: string; objectKey: string; projectId: string; jobId: string; sha256: string; bytes: number; contentType: string;
}
export function artifactKey(key: string, projectId: string, jobId: string): string {
  if (key.length > 1024 || !/^[A-Za-z0-9._/-]+$/.test(key) || key.split("/").some(part => !part || part === "." || part === "..")
    || !key.startsWith(projectId + "/" + jobId + "/")) throw new Error("invalid artifact path");
  return key;
}
export function byteRange(header: string | null, size: number): {start: number; end: number} | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new Error("invalid byte range");
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) throw new Error("invalid byte range");
  return {start, end};
}
async function checksum(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<{sha256: string; bytes: number}> {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of stream) { signal?.throwIfAborted(); hash.update(chunk); bytes += chunk.byteLength; }
  return {sha256: hash.digest("hex"), bytes};
}
export function objectClient(env: Record<string,string|undefined> = process.env): S3Client {
  // The endpoint rule and variable set live in s3-requests.ts so signed multipart calls share them.
  const config = objectStoreConfig(env);
  return new S3Client({endpoint: config.endpoint.href.replace(/\/$/, ""), bucket: config.bucket,
    accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region, virtualHostedStyle: false});
}
export class PostgresArtifactStore {
  private readonly root: string;
  constructor(private readonly database: StudioDatabase, cacheRoot: string, private readonly client = objectClient()) {
    mkdirSync(cacheRoot, {recursive: true});
    this.root = realpathSync(cacheRoot);
  }
  private local(key: string): string {
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error("artifact escaped its cache");
    return path;
  }
  private keyFor(path: string, job: Job): string {
    const actual = realpathSync(path);
    if (!actual.startsWith(this.root + sep) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
      throw new Error("artifact must be a regular file in the worker cache");
    return artifactKey(actual.slice(this.root.length + 1).split(sep).join("/"), job.projectId, job.id);
  }
  private async upload(job: Job, key: string, source: Bun.BunFile | Blob, signal?: AbortSignal): Promise<ArtifactRecord> {
    artifactKey(key, job.projectId, job.id);
    const digest = await checksum(source.stream(), signal);
    if (digest.bytes > 8 * 1024 ** 3) throw new Error("artifact exceeds the 8 GiB object limit");
    const objectKey = `v1/${job.projectId}/${job.id}/${digest.sha256}/${basename(key)}`;
    const object = this.client.file(objectKey);
    if (!await object.exists()) {
      await object.write(new Response(source.stream()), {type: TYPES[extname(key)] ?? "application/octet-stream", partSize: 8 * 1024 ** 2, queueSize: 2, retry: 2});
    }
    const verified = await checksum(object.stream(), signal);
    if (verified.sha256 !== digest.sha256 || verified.bytes !== digest.bytes) throw new Error("uploaded artifact failed checksum verification");
    return {key, objectKey, projectId: job.projectId, jobId: job.id, ...digest, contentType: TYPES[extname(key)] ?? "application/octet-stream"};
  }
  private async held(tx: SQL, job: Job, workerId: string): Promise<Job> {
    const project = (await tx`select id,body from hv_projects where id = ${job.projectId} and taken_down_at is null and delete_after > now() for share`)[0];
    if (!project) throw new LeaseError(job.id,"not_running",null);
    const rows = await tx`select body, lease_version from hv_jobs where id = ${job.id} for update`;
    const current = rows[0]?.body as Job | undefined;
    if (!current || current.status !== "running") throw new LeaseError(job.id, "not_running", current?.claimedBy ?? null);
    if (current.claimedBy !== workerId) throw new LeaseError(job.id, "wrong_worker", current.claimedBy);
    if (rows[0].lease_version !== job.leaseVersion) throw new LeaseError(job.id, "fence_changed", current.claimedBy);
    if (!current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.now()) throw new LeaseError(job.id, "lease_expired", current.claimedBy);
    assertLivingScriptIdempotency(current,job);await assertLivingScriptTransaction(tx,current,project.body as PersistedProject);
    assertCurrentFilmHeldInputs(current,job);await assertCurrentFilmTransaction(tx,current,project.body as PersistedProject);
    return current;
  }
  private async persist(tx: SQL, record: ArtifactRecord): Promise<void> {
    await tx`insert into hv_artifacts (key, object_key, project_id, job_id, sha256, bytes, content_type, backend)
      values (${record.key}, ${record.objectKey}, ${record.projectId}, ${record.jobId}, ${record.sha256}, ${record.bytes}, ${record.contentType}, 's3')
      on conflict (key) do update set object_key = excluded.object_key, sha256 = excluded.sha256, bytes = excluded.bytes,
        content_type = excluded.content_type, backend = 's3', created_at = now()`;
  }
  async checkpoint(job: Job, workerId: string, clips: VideoClip[], frames: number, leaseMs: number, signal?: AbortSignal,inventory?:ShotExecutionInventoryRow[]|CurrentFilmCheckpoint): Promise<void> {
    validateLivingScriptClips(job,clips);
    if(job.currentFilm?Array.isArray(inventory):inventory!==undefined&&!Array.isArray(inventory))throw new Error("The checkpoint evidence belongs to another film mode.");
    const execution=job.currentFilm?validateCurrentFilmClips(job,clips,inventory as CurrentFilmCheckpoint|undefined):validateShotExecutionClips(job,clips,inventory as ShotExecutionInventoryRow[]|undefined);
    if((job.livingScript||execution)&&frames!==clips.reduce((total,clip)=>total+Math.round(clip.durationSec*30),0))throw new Error("Film checkpoint frames differ from its exact clip prefix.");
    const latest = clips.at(-1)!;
    const paths = [latest.path,...(latest.audioPath?[latest.audioPath]:[]), ...(latest.posterPath ? [latest.posterPath] : []),...(latest.sourcePosterPath?[latest.sourcePosterPath]:[])];
    const records: ArtifactRecord[] = [];
    for (const path of paths) records.push(await this.upload(job, this.keyFor(path, job), Bun.file(path), signal));
    const manifest = {schema: "hv-clips/1", clips: clips.map(clip => ({...clip, path: this.keyFor(clip.path, job),
      audioPath:clip.audioPath?this.keyFor(clip.audioPath,job):undefined,posterPath: clip.posterPath ? this.keyFor(clip.posterPath, job) : undefined,sourcePosterPath:clip.sourcePosterPath?this.keyFor(clip.sourcePosterPath,job):undefined}))};
    records.push(await this.upload(job, `${job.projectId}/${job.id}/clips/manifest.json`, new Blob([JSON.stringify(manifest)]), signal));
    await this.database.forProject(job.projectId, async tx => {
      const current = await this.held(tx, job, workerId);
      const domain = DurableJobStore.fromJobs([current]);
      domain.checkpoint(job.id, workerId, clips.length, frames, Date.now(), leaseMs,execution);
      const updated = domain.get(job.id)!;
      for (const record of records) await this.persist(tx, record);
      if(job.livingScript||execution){
        const saved=await tx`select key,sha256,bytes from hv_artifacts where job_id=${job.id} and project_id=${job.projectId} for share`;
        this.assertPendingClips(updated,clips,saved.map((value:{key:string;sha256:string;bytes:number})=>({...value,bytes:Number(value.bytes)})));
      }
      await tx`update hv_jobs set body = ${updated}::jsonb, lease_expires_at = ${updated.leaseExpiresAt}, updated_at = now() where id = ${job.id}`;
      await tx`insert into hv_outbox (id, project_id, job_id, event_type, body) values
        (${crypto.randomUUID()}, ${job.projectId}, ${job.id}, 'job.checkpoint',
        ${{checkpointShots: clips.length, checkpointFrame: frames, artifacts: records.map(record => ({key: record.key, sha256: record.sha256, bytes: record.bytes}))}}::jsonb)`;
    });
  }
  async publishExport(job: Job, workerId: string, paths: string[], signal?: AbortSignal,output?:NonNullable<Job["output"]>): Promise<void> {
    if(job.currentFilm&&!output)throw new Error("Publish the exact completed current-film output with its measured artifacts.");
    const records: ArtifactRecord[] = [];
    for (const path of paths) records.push(await this.upload(job, this.keyFor(path, job), Bun.file(path), signal));
    await this.database.forProject(job.projectId, async tx => {
      const current=await this.held(tx, job, workerId);
      if(current.currentFilm){
        validateCurrentFilmOutput(current,output!);
        await verifyCurrentFilmMedia({...current,output},this.root,signal);
        signal?.throwIfAborted();await this.held(tx,job,workerId);
        const saved=await tx`select key,sha256,bytes from hv_artifacts where job_id=${job.id} and project_id=${job.projectId} for share`;
        const combined=[...saved.map((row:{key:string;sha256:string;bytes:number})=>({...row,bytes:Number(row.bytes)})).filter((row:{key:string})=>!records.some(record=>record.key===row.key)),...records];
        this.assertCurrentFilmFiles({...current,output},combined);
      }
      for (const record of records) await this.persist(tx, record);
      await tx`insert into hv_outbox (id, project_id, job_id, event_type, body) values
        (${crypto.randomUUID()}, ${job.projectId}, ${job.id}, 'artifacts.exported',
        ${{artifacts: records.map(record => ({key: record.key, sha256: record.sha256, bytes: record.bytes}))}}::jsonb)`;
    });
  }
  async fileInfo(projectId:string,jobId:string,key:string):Promise<import("../../planner/src/shot-reuse").RenderFile>{
    artifactKey(key,projectId,jobId);
    const row=await this.database.forProject(projectId,async tx=>(await tx`select * from hv_artifacts where project_id=${projectId} and job_id=${jobId} and key=${key}`)[0]);
    if(!row)throw new Error("The retained source artifact is unavailable.");const r=this.record(row,projectId,jobId);return {path:r.key,sha256:r.sha256,bytes:r.bytes};
  }
  /** Files and the immutable media checkpoint become visible in the same fenced transaction. */
  async checkpointDialogue(job:Job,workerId:string,output:NonNullable<Job["output"]>,leaseMs:number,signal?:AbortSignal):Promise<void>{
    validateDialogueOutput(job,output);const records:ArtifactRecord[]=[];
    for(const file of output.dialogue!.files){const path=this.local(file.path);if(this.keyFor(path,job)!==file.path)throw new Error("Dialogue artifact escaped its job.");const record=await this.upload(job,file.path,Bun.file(path),signal);if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Dialogue artifact changed before its checkpoint.");records.push(record);}
    await this.database.forProject(job.projectId,async tx=>{
      const current=await this.held(tx,job,workerId),domain=DurableJobStore.fromJobs([current]);domain.checkpointDialogue(job.id,workerId,output,Date.now(),leaseMs);
      for(const record of records)await this.persist(tx,record);
      const updated=domain.get(job.id)!;await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox (id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'dialogue.checkpoint',${{revision:output.dialogue!.revision,files:records.length}}::jsonb)`;
    });
  }
  async checkpointSound(job:Job,workerId:string,output:NonNullable<Job["output"]>,leaseMs:number,signal?:AbortSignal):Promise<void>{
    await verifySoundMedia(job,output,this.root,signal);const records:ArtifactRecord[]=[];
    for(const file of output.sound!.files){const record=await this.upload(job,file.path,Bun.file(this.local(file.path)),signal);if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Sound media changed before checkpointing.");records.push(record);}
    await this.database.forProject(job.projectId,async tx=>{const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null`)[0]?.body as PersistedProject|undefined;
      const source=(await tx`select body from hv_jobs where id=${job.soundMix!.source.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertSoundSourceAvailable(current.soundMix!,source);assertSoundPermission(current.soundMix!,project);
      const domain=DurableJobStore.fromJobs([current]);domain.checkpointSound(job.id,workerId,output,Date.now(),leaseMs);for(const record of records)await this.persist(tx,record);const updated=domain.get(job.id)!;
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'sound.checkpoint',${{revision:output.sound!.revision,files:records.length}}::jsonb)`;
    });
  }
  async checkpointEdit(job:Job,workerId:string,output:NonNullable<Job["output"]>,leaseMs:number,signal?:AbortSignal,access:()=>Promise<void>=async()=>{}):Promise<void>{
    await verifyEditMedia(job,output,this.root,access,signal);const records:ArtifactRecord[]=[];
    for(const file of output.editorial!.files){await access();const record=await this.upload(job,file.path,Bun.file(this.local(file.path)),signal);if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Editorial media changed before checkpointing.");records.push(record);}
    await this.database.forProject(job.projectId,async tx=>{
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null`)[0]?.body as PersistedProject|undefined;assertEditPermission(current.pictureEdit!,project);
      for(const binding of current.pictureEdit!.bindings){const source=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertEditBindingAvailable(binding,source);}
      const domain=DurableJobStore.fromJobs([current]);domain.checkpointEdit(job.id,workerId,output,Date.now(),leaseMs);for(const record of records)await this.persist(tx,record);const updated=domain.get(job.id)!;
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'editorial.checkpoint',${{revision:output.editorial!.revision,files:records.length}}::jsonb)`;
    });
  }
  /** Publish independently verified assembly media and original copies under the current worker fence. */
  async checkpointAssembly(job:Job,workerId:string,output:NonNullable<Job["output"]>,leaseMs:number,signal?:AbortSignal,access:()=>Promise<void>=async()=>{}):Promise<void>{
    await verifyEditAssemblyMedia({...job,assemblyEdit:job.assemblyEdit!},{...output,assembly:output.assembly!},this.root,access,signal);const records:ArtifactRecord[]=[];
    for(const file of output.assembly!.files){await access();const record=await this.upload(job,file.path,Bun.file(this.local(file.path)),signal);if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Assembly media changed before checkpointing.");records.push(record);}
    await access();signal?.throwIfAborted();
    await this.database.forProject(job.projectId,async tx=>{
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null`)[0]?.body as PersistedProject|undefined;assertEditAssemblyPermission(current.assemblyEdit!,project);
      if(current.assemblyCheckpoint)validateEditAssemblyOutput(current,current.assemblyCheckpoint);else for(const binding of current.assemblyEdit!.bindings.slice().sort((a,b)=>a.owner.jobId.localeCompare(b.owner.jobId))){
        const source=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertEditBindingAvailable(binding,source);
        const files=await tx`select key,sha256,bytes from hv_artifacts where project_id=${job.projectId} and job_id=${binding.owner.jobId}`;for(const file of binding.files)if(!files.some((f:{key:string;sha256:string;bytes:number})=>f.key===file.path&&f.sha256===file.sha256&&Number(f.bytes)===file.bytes))throw new Error("An assembly source artifact changed before checkpointing.");
      }
      signal?.throwIfAborted();const domain=DurableJobStore.fromJobs([current]);domain.checkpointAssembly(job.id,workerId,output,Date.now(),leaseMs);for(const record of records)await this.persist(tx,record);const updated=domain.get(job.id)!;
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'assembly.checkpoint',${{revision:output.assembly!.revision,files:records.length}}::jsonb)`;
    });
  }
  /** Publish verified lip-sync inputs under the current worker fence. */
  async checkpointLipSyncPrepared(job:Job,workerId:string,prepared:LipSyncPrepared,leaseMs:number,signal?:AbortSignal):Promise<void>{
    await verifyLipSyncPrepared(job,prepared,this.root,signal);await this.checkpointLipSyncMedia(job,workerId,prepared,undefined,leaseMs,signal);
  }
  async checkpointLipSync(job:Job,workerId:string,output:NonNullable<Job["output"]>,leaseMs:number,signal?:AbortSignal):Promise<void>{
    await verifyLipSyncMedia(job,output,this.root,signal);await this.checkpointLipSyncMedia(job,workerId,undefined,output,leaseMs,signal);
  }
  private async checkpointLipSyncMedia(job:Job,workerId:string,prepared:LipSyncPrepared|undefined,output:NonNullable<Job["output"]>|undefined,leaseMs:number,signal?:AbortSignal):Promise<void>{
    const files=prepared?lipSyncPreparedFiles(prepared):output!.lipSync!.files,records:ArtifactRecord[]=[];
    for(const file of files){const record=await this.upload(job,file.path,Bun.file(this.local(file.path)),signal);if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Lip-sync media changed before its checkpoint.");records.push(record);}
    await this.database.forProject(job.projectId,async tx=>{
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null`)[0]?.body as PersistedProject|undefined;
      assertLipSyncPermission(current.lipSync!,project);const policy=configuredLipSyncPolicy();if(!policy||!lipSame(validateLipSyncPolicy(policy,Date.now()),job.lipSync!.policy))throw new Error("The lip-sync policy changed before checkpointing.");
      const source=(await tx`select body from hv_jobs where id=${job.lipSync!.source.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertLipSyncSourceAvailable(job.lipSync!,source);
      if(output){const delivery=output.lipSync!.report.delivery,attempt=(await tx`select body from hv_provider_attempts where id=${delivery.attemptId} and project_id=${job.projectId} and job_id=${job.id} for share`)[0]?.body.lipSync;
        if(!attempt?.receipt?.delivery||!lipSame(attempt.receipt.delivery,delivery))throw new Error("Lip-sync checkpoint has no matching provider delivery.");}
      const domain=DurableJobStore.fromJobs([current]);if(prepared)domain.checkpointLipSyncPrepared(job.id,workerId,prepared,Date.now(),leaseMs);else domain.checkpointLipSync(job.id,workerId,output!,Date.now(),leaseMs);
      for(const record of records)await this.persist(tx,record);const updated=domain.get(job.id)!;await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox (id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},${prepared?"lipsync.prepared":"lipsync.checkpoint"},${{revision:prepared?.revision??output!.lipSync!.revision,files:records.length}}::jsonb)`;
    });
  }
  /** Retain graphic files and checkpoint metadata atomically under the current fence. */
  async checkpointGraphic(job:Job,workerId:string,output:GraphicOutput,leaseMs:number,signal?:AbortSignal,access:()=>Promise<void>=async()=>{}):Promise<void>{
    await verifyGraphicMedia(job,output,this.root,access,signal);const records:ArtifactRecord[]=[];
    for(const file of output.files){await access();const record=await this.upload(job,file.path,Bun.file(this.local(file.path)),signal);if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Graphic media changed before checkpointing.");records.push(record);}
    await this.database.forProject(job.projectId,async tx=>{
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null`)[0]?.body as PersistedProject|undefined;assertGraphicPermission(current.graphicRender!,project);
      const domain=DurableJobStore.fromJobs([current]);domain.checkpointGraphic(job.id,workerId,output,Date.now(),leaseMs);for(const record of records)await this.persist(tx,record);const updated=domain.get(job.id)!;
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'graphic.checkpoint',${{revision:output.revision,files:records.length}}::jsonb)`;
    });
  }
  async checkpointAudio(job:Job,workerId:string,output:AudioTakeOutput,leaseMs:number,signal?:AbortSignal):Promise<void>{
    validateAudioTakeOutput(job,output);verifyAudioMedia(job,output,this.root);const records:ArtifactRecord[]=[];
    for(const file of output.files){const record=await this.upload(job,file.path,Bun.file(this.local(file.path)),signal);if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Audio changed before its checkpoint.");records.push(record);}
    await this.database.forProject(job.projectId,async tx=>{
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId}`)[0]?.body as PersistedProject|undefined;
      assertAudioTakePermission(current,project);
      const attempt=(await tx`select body from hv_provider_attempts where id=${output.report.attemptId} and project_id=${job.projectId} and job_id=${job.id} for share`)[0]?.body.audio;
      if(!attempt||attempt.intent.planRevision!==job.audioTake!.line.revision||attempt.outcome?.providerState!=="completed"||attempt.outcome?.deliveryState!=="ready"||attempt.outcome?.deliveryRevision!==output.report.revision)throw new Error("Audio checkpoint has no matching completed provider outcome.");
      const domain=DurableJobStore.fromJobs([current]);domain.checkpointAudio(job.id,workerId,output,Date.now(),leaseMs);
      for(const record of records)await this.persist(tx,record);
      const updated=domain.get(job.id)!;await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox (id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'audio.checkpoint',${{revision:output.revision,files:records.length}}::jsonb)`;
    });
  }
  /** Offline migration only: the runtime API/worker roles cannot use this path. */
  async importCompletedJob(job: Job, paths: string[]): Promise<{files: number; bytes: number}> {
    if ((await this.database.sql`select current_user as role`)[0].role !== "hv_admin") throw new Error("media import requires the migration role");
    if (["queued","running"].includes(job.status)) throw new Error("media import requires a drained job");
    if (paths.length > 100_000) throw new Error("job media exceeds its file limit");
    const keys = new Set(paths.map(path => this.keyFor(path,job)));
    if(job.currentFilm&&(job.currentFilmCheckpoint||job.output))await verifyCurrentFilmMedia(job,this.root);
    if(job.dialogueReplacement){const output=job.output??job.dialogueCheckpoint;if(output)await verifyDialogueMedia(job,output,this.root,undefined,retainedDialogueTime(job));}
    if(job.soundMix){const output=job.output??job.soundCheckpoint;if(output){await verifySoundMedia(job,output,this.root);if(output.sound!.files.some(f=>!keys.has(f.path)))throw new Error("Imported sound media is missing.");}}
    if(job.graphicRender){const output=job.graphicOutput??job.graphicCheckpoint;if(output){await verifyGraphicMedia(job,output,this.root);if(output.files.some(f=>!keys.has(f.path)))throw new Error("Imported graphic media is missing.");}}
    if(job.pictureEdit){const output=job.output??job.editCheckpoint;if(output){await verifyEditMedia(job,output,this.root,async()=>{});if(output.editorial!.files.some(f=>!keys.has(f.path)))throw new Error("Imported editorial media is missing.");}}
    if(job.assemblyEdit){const output=job.output??job.assemblyCheckpoint;if(output){await verifyEditAssemblyMedia({...job,assemblyEdit:job.assemblyEdit},{...output,assembly:output.assembly!},this.root,async()=>{});if(output.assembly!.files.some(f=>!keys.has(f.path)))throw new Error("Imported assembly media is missing.");}}
    if(job.audioTake){const output=job.audioOutput??job.audioCheckpoint;if(output)verifyAudioMedia(job,output,this.root);}
    if(job.lipSync){if(job.lipSyncPrepared)await verifyLipSyncPrepared(job,job.lipSyncPrepared,this.root);const output=job.output??job.lipSyncCheckpoint;if(output)await verifyLipSyncMedia(job,output,this.root);const required=[...(job.lipSyncPrepared?lipSyncPreparedFiles(job.lipSyncPrepared):[]),...(output?.lipSync?.files??[])];if(required.some(f=>!keys.has(f.path)))throw new Error("Imported lip-sync media is missing.");}
    if (job.checkpointShots && !keys.has(`${job.projectId}/${job.id}/clips/manifest.json`)) throw new Error("imported checkpoint manifest is missing");
    if (job.output) for (const key of [job.output.mp4Path,job.output.hlsPlaylistPath,job.output.captionsPath,job.output.manifestPath,
      ...(job.output.sheetPath ? [job.output.sheetPath] : []),...(job.output.takeClips??[]).flatMap(clip=>[clip.path,clip.hlsPath,clip.posterPath,clip.captionsPath,clip.manifestPath]), ...(job.output.storyboard ?? []).flatMap(frame => [frame.path,...(frame.sourcePath?[frame.sourcePath]:[])])]) {
      if (!keys.has(artifactKey(key,job.projectId,job.id))) throw new Error("imported export media is missing");
    }
    const records: ArtifactRecord[] = [];let pendingClips:VideoClip[]|undefined;
    const portable = (path: string): string => {
      const marker = "/" + job.projectId + "/" + job.id + "/";
      const normalized = path.replaceAll("\\","/");
      const index = normalized.indexOf(marker);
      const key = artifactKey(index >= 0 ? normalized.slice(index+1) : normalized,job.projectId,job.id);
      if (!keys.has(key)) throw new Error("an imported clip is missing its media file");
      return key;
    };
    for (const path of paths) {
      const key = this.keyFor(path,job);
      if (key.endsWith("/clips/manifest.json")) {
        const source = JSON.parse(readFileSync(path,"utf8")) as VideoClip[] | {schema: string; clips: VideoClip[]};
        const clips = Array.isArray(source) ? source : source.clips;
        if (!Array.isArray(clips) || clips.length !== job.checkpointShots) throw new Error("imported clip manifest does not match the checkpoint");
        const manifest = {schema:"hv-clips/1",clips:clips.map(clip => ({...clip,path:portable(clip.path),
          audioPath:clip.audioPath?portable(clip.audioPath):undefined,posterPath:clip.posterPath ? portable(clip.posterPath) : undefined,sourcePosterPath:clip.sourcePosterPath?portable(clip.sourcePosterPath):undefined}))};
        if(job.livingScript||job.executionCheckpoints!==undefined||job.currentFilm){validateLivingScriptClips(job,manifest.clips);if(job.currentFilm)validateCurrentFilmClips(job,manifest.clips);else validateShotExecutionClips(job,manifest.clips);pendingClips=manifest.clips;}
        records.push(await this.upload(job,key,new Blob([JSON.stringify(manifest)])));
      } else records.push(await this.upload(job,key,Bun.file(path)));
    }
    for(const clip of job.output?.takeClips??[])if(records.find(r=>r.key===clip.path)?.sha256!==clip.sha256)throw new Error("imported take video checksum differs from its provenance");
    this.assertRenderedFiles(job,records);
    if(pendingClips)this.assertPendingClips(job,pendingClips,records);
    await this.database.forProject(job.projectId,async tx => {
      const current = (await tx`select body from hv_jobs where id = ${job.id} and project_id = ${job.projectId} for update`)[0]?.body as Job | undefined;
      if (!current || ["queued","running"].includes(current.status)) throw new Error("the job changed during media import");
      if(job.executionCheckpoints!==undefined||current.executionCheckpoints!==undefined||job.currentFilm||current.currentFilm){
        // JSONB omits optional own-undefined fields present in an in-memory worker
        // result. Compare its persisted representation after the evidence checks above.
        const retained=(value:Job)=>JSON.parse(JSON.stringify({...value,claimedBy:null,leaseExpiresAt:null,leaseVersion:0}));
        if(contentHash(retained(current))!==contentHash(retained(job)))throw new Error("The private execution job changed during media import.");
      }
      for (const record of records) await this.persist(tx,record);
    });
    return {files:records.length,bytes:records.reduce((sum,record)=>sum+record.bytes,0)};
  }
  private record(row: Record<string,unknown>, projectId: string, jobId: string): ArtifactRecord {
    const key = artifactKey(String(row.key), projectId, jobId);
    const sha256 = String(row.sha256), bytes = Number(row.bytes);
    if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8 * 1024 ** 3)
      throw new Error("invalid stored artifact metadata");
    const objectKey = `v1/${projectId}/${jobId}/${sha256}/${basename(key)}`;
    if (row.object_key !== objectKey || row.backend !== "s3") throw new Error("invalid stored artifact reference");
    return {key, objectKey, sha256, bytes, projectId, jobId, contentType: String(row.content_type)};
  }
  private assertRenderedFiles(job:Job,records:ArtifactRecord[]):void {
    this.assertCurrentFilmFiles(job,records);
    validateLivingScriptJob(job);if(job.output)validateLivingScriptOutput(job,job.output);
    if(job.output)validateShotExecutionOutput(job,job.output);
    if(job.lipSync){const files=[];if(job.lipSyncPrepared){validateLipSyncPrepared(job,job.lipSyncPrepared);files.push(...lipSyncPreparedFiles(job.lipSyncPrepared));}for(const output of [job.lipSyncCheckpoint,job.output].filter(Boolean)){validateLipSyncOutput(job,output!);files.push(...output!.lipSync!.files);}for(const file of files){const record=records.find(r=>r.key===file.path);if(!record||record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Stored lip-sync differs from its checkpoint.");}}
    if(job.soundMix)for(const output of [job.soundCheckpoint,job.output].filter(Boolean)){validateSoundOutput(job,output!);for(const file of output!.sound!.files){const record=records.find(r=>r.key===file.path);if(!record||record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Stored sound differs from its checkpoint.");}}
    if(job.graphicRender)for(const output of [job.graphicCheckpoint,job.graphicOutput].filter(Boolean)){validateGraphicOutput(job,output!);for(const file of output!.files){const record=records.find(r=>r.key===file.path);if(!record||record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Stored graphic media differs from its checkpoint.");}}
    if(job.pictureEdit)for(const output of [job.editCheckpoint,job.output].filter(Boolean)){validateEditOutput(job,output!);for(const file of output!.editorial!.files){const record=records.find(r=>r.key===file.path);if(!record||record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Stored editorial media differs from its checkpoint.");}}
    if(job.assemblyEdit)for(const output of [job.assemblyCheckpoint,job.output].filter(Boolean)){validateEditAssemblyOutput(job,output!);for(const file of output!.assembly!.files){const record=records.find(r=>r.key===file.path);if(!record||record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Stored assembly media differs from its checkpoint.");}}
    for(const output of [job.audioCheckpoint,job.audioOutput].filter(Boolean)){
      validateAudioTakeOutput(job,output!);for(const file of output!.files){const record=records.find(r=>r.key===file.path);if(!record||record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Stored audio differs from its checkpoint.");}
    }
    for(const output of [job.dialogueCheckpoint,job.output].filter(value=>value?.dialogue)){
      validateDialogueOutput(job,output!,retainedDialogueTime(job));
      for(const file of output!.dialogue!.files){const record=records.find(r=>r.key===file.path);if(!record||record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Stored dialogue media differs from its checkpoint.");}
    }
    for(const render of job.output?.shotRenders??[]){validateRenderRecord(render,job);for(const file of Object.values(render.files)){const record=records.find(r=>r.key===file.path);if(!record||record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Stored shot media differs from its render provenance.");}}
  }
  private assertPendingClips(job:Job,clips:VideoClip[],records:Pick<ArtifactRecord,"key"|"sha256"|"bytes">[]):void {
    if(!job.livingScript&&job.executionCheckpoints===undefined&&!job.currentFilm)return;validateLivingScriptClips(job,clips);
    if(job.currentFilm){const checkpoint=validateCurrentFilmClips(job,clips);advanceCurrentFilmCheckpoint(job,checkpoint,job.checkpointShots,job.checkpointFrame);}
    else {const execution=validateShotExecutionClips(job,clips);if(execution)validateJobExecutionCheckpoint(job,execution);}
    if(clips.length!==job.checkpointShots||clips.reduce((frames,clip)=>frames+Math.round(clip.durationSec*30),0)!==job.checkpointFrame)throw new Error("The pending media checkpoint changed its exact shot prefix or frame count.");
    for(const clip of clips)for(const [field,kind]of [["path","video"],["audioPath","audio"],["posterPath","poster"],["sourcePosterPath","sourcePoster"]] as const){
      const path=clip[field],file=clip.renderRecord!.files[kind];if(Boolean(path)!==Boolean(file))throw new Error("The pending checkpoint lost a rendered media role.");
      if(file){const key=this.keyFor(path!.startsWith(job.projectId+"/"+job.id+"/")?this.local(path!):path!,job),stored=records.find(record=>record.key===key);if(key!==file.path||!stored||stored.sha256!==file.sha256||stored.bytes!==file.bytes)throw new Error("The pending checkpoint media differs from its sealed shot receipt.");}
    }
  }
  private assertCurrentFilmFiles(job:Job,records:Pick<ArtifactRecord,"key"|"sha256"|"bytes">[]):void {
    if(!job.currentFilm){if(job.currentFilmCheckpoint||job.output?.currentFilm)throw new Error("Current-film media has no owning job context.");return;}
    validateCurrentFilmJob(job);
    const requireFile=(path:string,digest:{sha256:string;bytes:number}):void=>{const actual=records.find(row=>row.key===path);if(!actual||actual.sha256!==digest.sha256||actual.bytes!==digest.bytes)throw new Error("Stored current-film bytes differ from their measured evidence.");};
    if(job.currentFilmCheckpoint){const checked=advanceCurrentFilmCheckpoint(job,job.currentFilmCheckpoint,job.checkpointShots,job.checkpointFrame);for(const row of checked.rows)for(const file of Object.values(row.record.files))requireFile(file.path,file);}
    else if(job.checkpointShots!==0||job.checkpointFrame!==0)throw new Error("Current-film progress lost its private custody.");
    if(job.output){validateCurrentFilmOutput(job,job.output);const clock=job.output.currentFilm!.assembly;
      for(const path of [job.output.mp4Path,job.output.hlsPlaylistPath,job.output.captionsPath,job.output.manifestPath])if(!records.some(row=>row.key===path))throw new Error("The current-film export is missing a published artifact.");
      if(!job.output.captionsPath.endsWith(".vtt"))throw new Error("Retain the actual current-film caption formats.");
      requireFile(job.output.mp4Path,clock.video);requireFile(job.output.captionsPath,clock.captions.vtt);requireFile(job.output.captionsPath.slice(0,-4)+".srt",clock.captions.srt);
    }
  }
  async restoreCheckpoint(job: Job, signal?: AbortSignal): Promise<void> {
    const records: ArtifactRecord[] = await this.database.forProject(job.projectId, async tx => (await tx`select * from hv_artifacts
      where project_id = ${job.projectId} and job_id = ${job.id}`).map((row: Record<string,unknown>) => this.record(row, job.projectId, job.id)));
    const keys = new Set(records.map(record => record.key));
    const manifestKey = `${job.projectId}/${job.id}/clips/manifest.json`;
    if (job.checkpointShots && !keys.has(manifestKey)) throw new Error("the stored checkpoint manifest is missing");
    if (job.output) for (const key of [job.output.mp4Path,job.output.hlsPlaylistPath,job.output.captionsPath,job.output.manifestPath,
      ...(job.output.sheetPath ? [job.output.sheetPath] : []),...(job.output.takeClips??[]).flatMap(clip=>[clip.path,clip.hlsPath,clip.posterPath,clip.captionsPath,clip.manifestPath]), ...(job.output.storyboard ?? []).flatMap(frame => [frame.path,...(frame.sourcePath?[frame.sourcePath]:[])])]) {
      if (!keys.has(artifactKey(key,job.projectId,job.id))) throw new Error("the stored export media is missing");
    }
    for(const clip of job.output?.takeClips??[])if(records.find(r=>r.key===clip.path)?.sha256!==clip.sha256)throw new Error("stored take video checksum differs from its provenance");
    this.assertRenderedFiles(job,records);
    const editDisk=job.pictureEdit||job.assemblyEdit?editWorkspaceGuard(this.root,()=>[resolve(this.root,job.projectId,job.id)]):undefined;if(editDisk)assertEditFreeSpace(this.root,records.reduce((n,r)=>n+r.bytes,0)*3);
    for (const record of records) {
      signal?.throwIfAborted();
      const path = this.local(record.key);
      mkdirSync(dirname(path), {recursive: true});
      if (!realpathSync(dirname(path)).startsWith(this.root + sep)) throw new Error("artifact cache directory escaped its root");
      const temporary = path + "." + crypto.randomUUID() + ".download";
      const writer = Bun.file(temporary).writer();
      try {
        const hash = createHash("sha256"); let bytes = 0;
        for await (const chunk of this.client.file(record.objectKey).stream()) {
          signal?.throwIfAborted();
          editDisk?.();
          bytes += chunk.byteLength;
          if (bytes > record.bytes) throw new Error("downloaded artifact exceeds its recorded size");
          hash.update(chunk); writer.write(chunk); await writer.flush();
        }
        await writer.end();
        if (bytes !== record.bytes || hash.digest("hex") !== record.sha256) throw new Error("downloaded artifact failed checksum verification");
        renameSync(temporary, path);
      } catch (error) { await writer.end(); try { unlinkSync(temporary); } catch {} throw error; }
    }
    if(job.currentFilm&&(job.currentFilmCheckpoint||job.output))await verifyCurrentFilmMedia(job,this.root,signal);
    if(job.dialogueReplacement){const output=job.output??job.dialogueCheckpoint;if(output)await verifyDialogueMedia(job,output,this.root,signal,retainedDialogueTime(job));}
    if(job.soundMix){const output=job.output??job.soundCheckpoint;if(output)await verifySoundMedia(job,output,this.root,signal);}
    if(job.graphicRender){const output=job.graphicOutput??job.graphicCheckpoint;if(output)await verifyGraphicMedia(job,output,this.root,async()=>{},signal);}
    if(job.pictureEdit){const output=job.output??job.editCheckpoint;if(output)await verifyEditMedia(job,output,this.root,async()=>{},signal);}
    if(job.assemblyEdit){const output=job.output??job.assemblyCheckpoint;if(output)await verifyEditAssemblyMedia({...job,assemblyEdit:job.assemblyEdit},{...output,assembly:output.assembly!},this.root,async()=>{},signal);}
    if(job.audioTake){const output=job.audioOutput??job.audioCheckpoint;if(output)verifyAudioMedia(job,output,this.root);}
    if(job.lipSync){if(job.lipSyncPrepared)await verifyLipSyncPrepared(job,job.lipSyncPrepared,this.root,signal);const output=job.output??job.lipSyncCheckpoint;if(output)await verifyLipSyncMedia(job,output,this.root,signal);}
    if (!job.checkpointShots) return;
    const manifest = JSON.parse(readFileSync(this.local(manifestKey), "utf8")) as {schema: string; clips: VideoClip[]};
    if (manifest.schema !== "hv-clips/1" || !Array.isArray(manifest.clips) || manifest.clips.length !== job.checkpointShots)
      throw new Error("stored clip manifest does not match the job checkpoint");
    const clips = manifest.clips.map(clip => {
      const path = artifactKey(clip.path, job.projectId, job.id);
      const audioPath=clip.audioPath?artifactKey(clip.audioPath,job.projectId,job.id):undefined;
      const posterPath = clip.posterPath ? artifactKey(clip.posterPath, job.projectId, job.id) : undefined;
      const sourcePosterPath=clip.sourcePosterPath?artifactKey(clip.sourcePosterPath,job.projectId,job.id):undefined;
      if (!keys.has(path) || (audioPath&&!keys.has(audioPath)) || (posterPath && !keys.has(posterPath)) || (sourcePosterPath&&!keys.has(sourcePosterPath))) throw new Error("stored clip media is missing");
      return {...clip, path: this.local(path),audioPath:audioPath?this.local(audioPath):undefined, posterPath: posterPath ? this.local(posterPath) : undefined,sourcePosterPath:sourcePosterPath?this.local(sourcePosterPath):undefined};
    });
    this.assertPendingClips(job,clips,records);
    writeJsonFile(this.local(manifestKey), clips);
  }
  removeCache(job: Pick<Job,"projectId"|"id">): void {
    const key = artifactKey(`${job.projectId}/${job.id}/cache`,job.projectId,job.id);
    const path = dirname(this.local(key));
    if (!existsSync(dirname(path))) return;
    if (!realpathSync(dirname(path)).startsWith(this.root+sep)) throw new Error("worker cache parent escaped its root");
    rmSync(path,{recursive:true,force:true});
  }
  async response(projectId: string, jobId: string, key: string, request: Request, headers: HeadersInit = {}): Promise<Response | null> {
    artifactKey(key, projectId, jobId);
    const rows = await this.database.forProject(projectId, async tx => tx`select * from hv_artifacts
      where key = ${key} and project_id = ${projectId} and job_id = ${jobId}`);
    if (!rows.length) return null;
    const record = this.record(rows[0], projectId, jobId);
    let range: ReturnType<typeof byteRange>;
    try { range = byteRange(request.headers.get("range"), record.bytes); }
    catch { return new Response(null, {status: 416, headers: {"content-range": `bytes */${record.bytes}`}}); }
    const resultHeaders = new Headers(headers);
    resultHeaders.set("content-type", record.contentType);
    resultHeaders.set("content-length", String(range ? range.end - range.start + 1 : record.bytes));
    resultHeaders.set("accept-ranges", "bytes");
    resultHeaders.set("cache-control", "private, no-store");
    resultHeaders.set("x-content-type-options", "nosniff");
    resultHeaders.set("referrer-policy", "no-referrer");
    resultHeaders.set("etag", '"' + record.sha256 + '"');
    if (range) resultHeaders.set("content-range", `bytes ${range.start}-${range.end}/${record.bytes}`);
    const file = this.client.file(record.objectKey);
    return new Response(request.method === "HEAD" ? null : (range ? file.slice(range.start, range.end + 1) : file).stream(),
      {status: range ? 206 : 200, headers: resultHeaders});
  }
}
