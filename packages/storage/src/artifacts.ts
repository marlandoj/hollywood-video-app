import {assertProvenanceSidecarsBeside,provenanceSidecarAgrees} from "../../planner/src/provenance";
import { S3Client, type SQL } from "bun";
import {assertGraphicPermission,validateGraphicOutput,type GraphicOutput} from "../../planner/src/graphic-jobs";
import {verifyGraphicMedia} from "../../generator/src/graphic-media";
import {assertDeliveryPermission,deliveryRetainedFiles,type DeliveryResult} from "../../planner/src/delivery-jobs";
import {verifyDeliveryMedia} from "../../generator/src/delivery-media";
import {validateDeliveryOutput} from "../../planner/src/delivery-jobs";
import { createHash } from "node:crypto";
import {contentHash} from "../../generator/src/capabilities";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { DEFAULT_LEASE_MS, DurableJobStore, LeaseError, type Job } from "../../queue/src/index";
import type { VideoClip } from "../../generator/src/index";
import {validateRenderRecord,type RenderFile} from "../../planner/src/shot-reuse";
import {validateJobExecutionCheckpoint,validateShotExecutionClips,validateShotExecutionOutput,type ShotExecutionInventoryRow} from "../../planner/src/shot-execution-inventory";
import {assertLivingScriptIdempotency,validateLivingScriptJob,validateLivingScriptOutput,validateLivingScriptClips} from "../../planner/src/living-script-job-context";
import {assertLivingScriptTransaction} from "./living-script-context";
import {assertCurrentFilmTransaction} from "./current-film-context";
import {assertCurrentFilmMixedLockedTransaction} from "./current-film-mixed-context";
import {verifyCurrentFilmMedia} from "../../queue/src/current-film-media";
import {assertCurrentFilmMode,validateCurrentFilmJob,validateCurrentFilmOutput,validateCurrentFilmClips,advanceCurrentFilmCheckpoint,type CurrentFilmCheckpoint} from "../../planner/src/current-film-job-context";
import {currentFilmRuntimeMode,currentFilmV3Job,assertCurrentFilmRuntimeHeldInputs,validateCurrentFilmRuntimeOutput} from "../../planner/src/current-film-runtime-context";
import {editValidationKey} from "../../planner/src/edit-validation-key";
import {advanceCurrentFilmOrigins,currentFilmMixedRecordedFiles,type CurrentFilmMixedJob,type CurrentFilmMixedJobOutput} from "../../planner/src/current-film-mixed-job-context";
import {advanceCurrentFilmMixedCheckpoint,validateCurrentFilmMixedCheckpoint,currentFilmMixedRowFrames,type CurrentFilmMixedCheckpoint} from "../../planner/src/current-film-mixed-context";
import type {CurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {verifyCurrentFilmMixedMedia} from "../../queue/src/current-film-mixed-media";
import {withEditSourceAccess} from "../../generator/src/edit-source-media";
import {currentFilmAccess} from "../../generator/src/current-film-access";
import {prepareCurrentFilmProofCopies} from "../../generator/src/current-film-proof-copy";
import {verifyCurrentFilmProofMedia} from "../../generator/src/current-film-proof-media";
import {compileCurrentFilmProofTarget} from "../../planner/src/current-film-proof-target";
import {compileCurrentFilmProofCopies,type CurrentFilmProofCopies,type CurrentFilmProofCopy} from "../../planner/src/current-film-proof-copies";
import {createCurrentFilmPreparedProof,advanceCurrentFilmPreparedProof,validateCurrentFilmPreparedProof,currentFilmPreparedProofFiles,assertCurrentFilmProofProjectPrefix,assertCurrentFilmProofRetainedCapacity,type CurrentFilmPreparedProof} from "../../planner/src/current-film-prepared-proof";
import {resolveCurrentFilmProofContext} from "./current-film-proof-context";
import {sqlResultRows} from "./sql-result-rows";
import {ReferenceBlobStore} from "./references";
import {audioAbortable} from "../../generator/src/audio-stream";
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
import { assertArchiveDocument, clipsManifest } from "./archive-schema";

const TYPES: Record<string,string> = {".wav":"audio/wav",".mp4":"video/mp4",".png":"image/png",".m3u8":"application/vnd.apple.mpegurl",
  ".ts":"video/mp2t",".vtt":"text/vtt; charset=utf-8",".srt":"application/x-subrip",".json":"application/json",
  /** HV-031-15: the C2PA manifest store's registered media type, stored on the object and served from it. */
  ".c2pa":"application/c2pa"};
/** The content type an artifact is stored and served with, by its extension. */
export function artifactContentType(key:string):string {return TYPES[extname(key)] ?? "application/octet-stream";}
export interface ArtifactRecord {
  key: string; objectKey: string; projectId: string; jobId: string; sha256: string; bytes: number; contentType: string;
}
/**
 * HV-025-12. A checkpoint is two very different halves and only one of them was ever visible.
 * Verification does not read the retained files and agree with them: it **reproduces the conform**
 * and compares content hashes, so it costs about what the render cost. On the object-store path both
 * halves happened inside one unspanned call, which is why an editorial job that logged 241 s showed
 * 105 s of render and nothing else. The caller decides how to record a phase; this only names them.
 */
export type CheckpointPhase=<T>(name:"verify"|"store",files:number,step:()=>Promise<T>)=>Promise<T>;
export const UNRECORDED_CHECKPOINT_PHASE:CheckpointPhase=(_name,_files,step)=>step();
export async function checkpointMedia<F extends {path:string;sha256:string;bytes:number}>(
  files:readonly F[],verify:()=>Promise<void>,upload:(file:F)=>Promise<ArtifactRecord>,
  access:()=>Promise<void>,phase:CheckpointPhase,changed:string):Promise<ArtifactRecord[]>{
  await phase("verify",files.length,verify);
  return await phase("store",files.length,async()=>{
    const records:ArtifactRecord[]=[];
    for(const file of files){await access();const record=await upload(file);if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error(changed);records.push(record);}
    return records;
  });
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
    const maximum=this.artifactLimit(job,key);
    if(source.size>maximum)throw new Error("Artifact exceeds its admitted object limit.");
    const digest = await checksum(source.stream(), signal);
    if (digest.bytes > maximum) throw new Error("Artifact exceeds its admitted object limit.");
    const objectKey = `v1/${job.projectId}/${job.id}/${digest.sha256}/${basename(key)}`;
    const object = this.client.file(objectKey);
    if (!await object.exists()) {
      await object.write(new Response(source.stream()), {type: artifactContentType(key), partSize: 8 * 1024 ** 2, queueSize: 2, retry: 2});
    }
    const verified = await checksum(object.stream(), signal);
    if (verified.sha256 !== digest.sha256 || verified.bytes !== digest.bytes) throw new Error("uploaded artifact failed checksum verification");
    return {key, objectKey, projectId: job.projectId, jobId: job.id, ...digest, contentType: artifactContentType(key)};
  }
  private async held(tx: SQL, job: Job, workerId: string): Promise<Job> {
    const project = (await tx`select id,body from hv_projects where id = ${job.projectId} and taken_down_at is null and expired_at is null and delete_after > now() for share`)[0];
    if (!project) throw new LeaseError(job.id,"not_running",null);
    const rows = await tx`select body, lease_version from hv_jobs where id = ${job.id} for update`;
    const current = rows[0]?.body as Job | undefined;
    if (!current || current.status !== "running") throw new LeaseError(job.id, "not_running", current?.claimedBy ?? null);
    if (current.claimedBy !== workerId) throw new LeaseError(job.id, "wrong_worker", current.claimedBy);
    if (rows[0].lease_version !== job.leaseVersion) throw new LeaseError(job.id, "fence_changed", current.claimedBy);
    if (!current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.now()) throw new LeaseError(job.id, "lease_expired", current.claimedBy);
    // Select only the internal validator here: it checks both complete envelopes,
    // including conflicting modes and hidden/accessor fields. The public runtime
    // discriminator would hash this same potentially large proof envelope again.
    const plan=Object.getOwnPropertyDescriptor(current,"currentFilm")?.value;
    if(plan&&typeof plan==="object"&&Object.getOwnPropertyDescriptor(plan,"schema")?.value==="hv-current-film-job/3")
      return assertCurrentFilmMixedLockedTransaction(tx,current,job,project.body as PersistedProject);
    assertLivingScriptIdempotency(current,job);await assertLivingScriptTransaction(tx,current,project.body as PersistedProject);
    assertCurrentFilmRuntimeHeldInputs(current,job);await assertCurrentFilmTransaction(tx,current,project.body as PersistedProject);
    return current;
  }
  private async persist(tx: SQL, record: ArtifactRecord): Promise<void> {
    await tx`insert into hv_artifacts (key, object_key, project_id, job_id, sha256, bytes, content_type, backend)
      values (${record.key}, ${record.objectKey}, ${record.projectId}, ${record.jobId}, ${record.sha256}, ${record.bytes}, ${record.contentType}, 's3')
      on conflict (key) do update set object_key = excluded.object_key, sha256 = excluded.sha256, bytes = excluded.bytes,
        content_type = excluded.content_type, backend = 's3', created_at = now()`;
  }
  async checkpoint(job: Job, workerId: string, clips: VideoClip[], frames: number, leaseMs: number, signal?: AbortSignal,inventory?:ShotExecutionInventoryRow[]|CurrentFilmCheckpoint): Promise<void> {
    if(currentFilmRuntimeMode(job)==="v3")throw new Error("Publish mixed current-film progress through its exact private checkpoint.");
    validateLivingScriptClips(job,clips);
    if(job.currentFilm?Array.isArray(inventory):inventory!==undefined&&!Array.isArray(inventory))throw new Error("The checkpoint evidence belongs to another film mode.");
    const execution=job.currentFilm?validateCurrentFilmClips(job,clips,inventory as CurrentFilmCheckpoint|undefined):validateShotExecutionClips(job,clips,inventory as ShotExecutionInventoryRow[]|undefined);
    if((job.livingScript||execution)&&frames!==clips.reduce((total,clip)=>total+Math.round(clip.durationSec*30),0))throw new Error("Film checkpoint frames differ from its exact clip prefix.");
    const latest = clips.at(-1)!;
    const paths = [latest.path,...(latest.audioPath?[latest.audioPath]:[]), ...(latest.posterPath ? [latest.posterPath] : []),...(latest.sourcePosterPath?[latest.sourcePosterPath]:[])];
    const records: ArtifactRecord[] = [];
    for (const path of paths) records.push(await this.upload(job, this.keyFor(path, job), Bun.file(path), signal));
    const manifest = clipsManifest(clips,path => this.keyFor(path,job));
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
  private async mixedIndex(tx:SQL,job:Job):Promise<Pick<ArtifactRecord,"key"|"sha256"|"bytes">[]> {
    const rows=await tx`select key,sha256,bytes from hv_artifacts where project_id=${job.projectId} and job_id=${job.id} order by key limit 100001 for share`;
    if(rows.length>100000)throw new Error("Mixed current-film artifacts exceed the complete job inventory limit.");
    return rows.map((row:{key:string;sha256:string;bytes:number|string})=>({key:row.key,sha256:row.sha256,bytes:Number(row.bytes)}));
  }
  /** Large pictures are admitted only by their exact measured owner or one
   * declared current-film preview copy. Other artifact roles retain 8 GiB. */
  private measuredArtifact(job:Job,key:string):RenderFile|undefined {
    if(extname(key)!==".mp4")return undefined;
    if(job.currentFilm&&job.output?.mp4Path===key){
      validateCurrentFilmRuntimeOutput(job,job.output);return {path:key,...job.output.currentFilm!.assembly.video};
    }
    if(job.currentFilmProof){
      const mixed=currentFilmV3Job(job),proof=validateCurrentFilmPreparedProof(job.currentFilmProof,mixed).specification;
      for(const group of proof.previews){
        const preview=proof.frozenContext.jobs.find(value=>value.id===group.jobId);
        if(!preview?.currentFilm)continue;
        const copy=group.copies.find(value=>value.owned.path===key&&value.original.path===preview.output?.mp4Path);
        if(copy)return copy.owned;
      }
    }
    return undefined;
  }
  private artifactLimit(job:Job,key:string):number {
    const expected=this.measuredArtifact(job,key);if(!expected)return 8*1024**3;
    if(expected.bytes>128*1024**3)throw new Error("The current-film picture exceeds its exact measured media limit.");return expected.bytes;
  }
  private async storedArtifactLimit(row:Record<string,unknown>,projectId:string,jobId:string):Promise<number> {
    if(Number(row.bytes)<=8*1024**3)return 8*1024**3;
    const job=(await this.database.forProject(projectId,async tx=>await tx`select body from hv_jobs where project_id=${projectId} and id=${jobId}`))[0]?.body as Job|undefined;
    if(!job||job.id!==jobId||job.projectId!==projectId)throw new Error("The large current-film artifact lost its exact owning output.");
    const expected=this.measuredArtifact(job,String(row.key)),maximum=this.artifactLimit(job,String(row.key));
    if(!expected||maximum<=8*1024**3||Number(row.bytes)!==maximum||row.sha256!==expected.sha256)
      throw new Error("The large current-film artifact differs from its exact measured output.");
    return maximum;
  }
  /**
   * HV-016-30: a held mixed transaction re-verifies owned media before it publishes, and on the real
   * PostgreSQL lifecycle that verification ran for minutes. Two things then failed:
   *
   * - Bun SQL's `idleTimeout` closed the reserved connection mid-transaction ("Idle timeout reached
   *   after 20s"). A trivial `select 1` every 5 s keeps it live; it takes no lock.
   * - The lease ran out. `held` locks the job row `for update`, which also blocks this worker's own
   *   heartbeat, so the final completion's fence failed with `lease_expired` and the film came back
   *   still `running`. So every third of a lease the transaction renews the lease itself, as the
   *   blocked heartbeat would have. It renews only the row this worker still holds, with the same
   *   lease version and a lease that has not yet run out (by the database's wall clock), so it never
   *   revives an expired lease; the commit fence (`held`, then the domain write) is unchanged. A short
   *   transaction never renews, so a lease that expires inside one still refuses its commit.
   */
  private heldMixedTransaction<T>(job:Job,workerId:string,leaseMs:number,fn:(tx:SQL)=>Promise<T>):Promise<T> {
    return this.database.forProject(job.projectId,async tx=>{
      const renewEvery=Math.max(1,Math.floor(leaseMs/3/5000));let pending:Promise<unknown>=Promise.resolve(),ticks=0;
      const timer=setInterval(()=>{
        const renew=++ticks%renewEvery===0;
        pending=pending.then(()=>renew?this.renewHeldLease(tx,job,workerId,leaseMs):tx`select 1`).catch(()=>undefined);
      },5000);
      try{return await fn(tx);}finally{clearInterval(timer);await pending;}
    });
  }
  /**
   * HV-016-30: the held job as read at the start of the transaction, with the lease the row holds now.
   * `heldMixedTransaction` renews the row's lease while it runs, but the domain write and the staged
   * origins body were built from the start-of-transaction job, so they still carried the original
   * expiry. A transaction that outlived that expiry (lease remaining at its start < its duration: a
   * 200 s origins or checkpoint verification begun more than ~100 s after the last heartbeat) was
   * refused `lease_expired` by the domain, and the film came back still `running` with no reason.
   * Only the expiry is taken from the fresh read; `held` has just checked it and the fence.
   */
  private renewedLease<T extends Job>(current:T,held:Job):T {
    return {...current,leaseExpiresAt:held.leaseExpiresAt};
  }
  private async renewHeldLease(tx:SQL,job:Job,workerId:string,leaseMs:number):Promise<void> {
    const expires=new Date(Date.now()+leaseMs).toISOString();
    await tx`update hv_jobs set lease_expires_at=${expires}::timestamptz,body=jsonb_set(body,'{leaseExpiresAt}',to_jsonb(${expires}::text))
      where id=${job.id} and lease_version=${job.leaseVersion} and body->>'claimedBy'=${workerId} and body->>'status'='running'
      and (body->>'leaseExpiresAt')::timestamptz>clock_timestamp()`;
  }
  private async mixedAccess(job:CurrentFilmMixedJob,workerId:string):Promise<void> {
    await this.database.forProject(job.projectId,async tx=>{await this.held(tx,job,workerId);});
  }
  private async uploadMixedFiles(job:CurrentFilmMixedJob,files:RenderFile[],access:()=>Promise<void>,signal?:AbortSignal):Promise<ArtifactRecord[]> {
    if(files.length>100000||new Set(files.map(file=>file.path)).size!==files.length)throw new Error("Retain a bounded distinct mixed current-film file inventory.");
    return withEditSourceAccess(access,signal,async active=>{
      const records:ArtifactRecord[]=[];
      for(const file of files){
        await access();active.throwIfAborted();const path=this.local(file.path);
        if(this.keyFor(path,job)!==file.path)throw new Error("Mixed current-film media changed its owned path.");
        const record=await this.upload(job,file.path,Bun.file(path),active);
        if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Mixed current-film media changed before its held checkpoint.");records.push(record);
      }
      await access();active.throwIfAborted();return records;
    });
  }
  private async resolveProof(tx:SQL,job:CurrentFilmMixedJob):Promise<CurrentFilmProofCopies> {
    const project=(await tx`select body from hv_projects where id=${job.projectId} for share`)[0]?.body as PersistedProject|undefined;
    if(!project)throw new Error("The current-film proof project is unavailable.");
    const resolved=await resolveCurrentFilmProofContext(tx,job.currentFilm,project,compileCurrentFilmProofTarget(job));
    return compileCurrentFilmProofCopies(job.currentFilm,job.id,{frozenContext:resolved.frozenContext,carriers:resolved.carriers,previews:resolved.previews,target:resolved.target!});
  }
  /** Inspect dense SQL row descriptors before detaching driver metadata. The
   * exact selected set is bounded independently of unrelated project rows. */
  private proofRows(value:unknown,max:number,bytes:number):Record<string,unknown>[] {
    // HV-016-30: Bun returns SQLResultArray, an Array subclass. The PR required
    // Array.prototype here, so every real PostgreSQL proof publication refused
    // ("Retain actual bounded proof query rows."). Normalize the transport container
    // with the same dense-row reader the proof and mixed-context modules use.
    const selected=sqlResultRows(value,max,"Retain a bounded complete proof query result without accessors or holes.");
    if(!editValidationKey(selected,bytes)||selected.some(row=>!row||typeof row!=="object"||Array.isArray(row)))throw new Error("Retain bounded portable proof query bodies.");
    return structuredClone(selected) as Record<string,unknown>[];
  }
  private async assertProofSelection(tx:SQL,job:CurrentFilmMixedJob,specification:CurrentFilmProofCopies):Promise<void> {
    const projectRows=this.proofRows(await tx`select body from hv_projects where id=${job.projectId} for share`,1,256*1024**2);
    if(projectRows.length!==1)throw new Error("The selected proof project disappeared before publication.");
    assertCurrentFilmProofProjectPrefix(specification,projectRows[0]!.body as PersistedProject);
    const ids=specification.frozenContext.jobs.map(value=>value.id).sort();
    for(const id of ids){
      const rows=this.proofRows(await tx`select id,body from hv_jobs where project_id=${job.projectId} and id=${id} for share`,1,256*1024**2);
      const previous=specification.frozenContext.jobs.find(value=>value.id===id)!;
      if(rows.length!==1||rows[0]!.id!==id||contentHash(JSON.parse(JSON.stringify(rows[0]!.body)))!==contentHash(previous))
        throw new Error("A selected proof job changed before publication.");
    }
    let totalFiles=0,totalMetadata=0;
    for(const id of ids){
      const rows=this.proofRows(await tx`select key,sha256,bytes from hv_artifacts where project_id=${job.projectId} and job_id=${id} order by key limit 100001 for share`,100000,64*1024**2);
      totalFiles+=rows.length;totalMetadata+=Buffer.byteLength(JSON.stringify(rows));
      if(totalFiles>100000||totalMetadata>64*1024**2)throw new Error("The selected proof indexes exceed their aggregate capacity.");
      const indexed=new Map<string,RenderFile>();
      for(const row of rows){
        const amount=typeof row.bytes==="string"&&/^(0|[1-9][0-9]{0,11})$/.test(row.bytes)?Number(row.bytes):row.bytes;
        if(Object.keys(row).sort().join(",")!=="bytes,key,sha256"||typeof row.key!=="string"||typeof row.sha256!=="string"||!/^[a-f0-9]{64}$/.test(row.sha256)
          ||typeof amount!=="number"||!Number.isSafeInteger(amount)||Object.is(amount,-0)||amount<0||amount>128*1024**3||indexed.has(row.key))
          throw new Error("The selected proof index changed its exact metadata.");
        artifactKey(row.key,job.projectId,id);indexed.set(row.key,{path:row.key,sha256:row.sha256,bytes:amount});
      }
      const required=specification.carriers.filter(row=>row.jobId===id).flatMap(row=>row.copies.map(copy=>copy.carrier));
      for(const file of required)if(contentHash(indexed.get(file.path))!==contentHash(file))throw new Error("A selected proof carrier changed its required artifact inventory.");
      const preview=specification.previews.find(row=>row.jobId===id);
      if(preview){
        const order=(a:RenderFile,b:RenderFile)=>a.path.localeCompare(b.path);
        if(contentHash([...indexed.values()].sort(order))!==contentHash(preview.copies.map(copy=>copy.carrier).sort(order)))
          throw new Error("The complete selected preview index changed before proof publication.");
      }
    }
  }
  /** Resolve exact held metadata once, then copy and verify its independent owned
   * roots. A saved marker resumes without rediscovering deleted historical jobs.
   * Per-I/O access still reads fresh lease, target, review and permission state. */
  async prepareCurrentFilmProof(job:CurrentFilmMixedJob,workerId:string,leaseMs:number,signal?:AbortSignal):Promise<CurrentFilmPreparedProof> {
    signal?.throwIfAborted();job=structuredClone(currentFilmV3Job(job));
    const initial=await this.database.forProject(job.projectId,async tx=>{
      const current=currentFilmV3Job(await this.held(tx,job,workerId));
      return {current,specification:current.currentFilmProof?.specification??await this.resolveProof(tx,current)};
    }),access=currentFilmAccess(()=>this.mixedAccess(job,workerId));
    if(initial.current.currentFilmProof){
      const retained=validateCurrentFilmPreparedProof(initial.current.currentFilmProof,initial.current);
      await verifyCurrentFilmProofMedia(retained.specification,initial.current.currentFilm,job.id,this.root,access,signal);
      await access();signal?.throwIfAborted();return retained;
    }
    const specification=initial.specification;assertCurrentFilmProofRetainedCapacity(initial.current,specification);
    const references=new ReferenceBlobStore(this.root,this.client),
      byOwned=new Map<string,{copy:CurrentFilmProofCopy;ownerId:string}>();
    for(const group of [...specification.carriers,...specification.previews])for(const copy of group.copies)byOwned.set(copy.owned.path,{copy,ownerId:group.jobId});
    const referenceByOwned=new Map(specification.references.map(row=>[row.copy.owned.path,row]));
    await prepareCurrentFilmProofCopies(specification,initial.current.currentFilm,job.id,this.root,async(copy,active)=>{
      await access();active.throwIfAborted();const reference=referenceByOwned.get(copy.owned.path);
      if(reference){
        if(contentHash(reference.copy)!==contentHash(copy))throw new Error("The proof reference read changed its exact copy identity.");
        const asset=specification.frozenContext.project.referenceAssets?.find(value=>value.id===reference.assetId);
        if(!asset)throw new Error("The proof reference lost its exact frozen catalog identity.");
        const data=await audioAbortable(references.read(asset),active);await access();active.throwIfAborted();
        return new Response(new Uint8Array(data),{headers:{etag:'"'+copy.carrier.sha256+'"',"content-length":String(copy.carrier.bytes),"content-type":"image/png"}});
      }
      const selected=byOwned.get(copy.owned.path);
      if(!selected||contentHash(selected.copy)!==contentHash(copy))throw new Error("The proof read is not an exact selected carrier role.");
      const response=await this.response(job.projectId,selected.ownerId,copy.carrier.path,new Request("https://current-film-proof.invalid/artifact",{signal:active}));
      if(!response)throw new Error("The selected proof artifact is unavailable.");return response;
    },access,signal);
    await access();signal?.throwIfAborted();
    return this.checkpointCurrentFilmProof(job,workerId,createCurrentFilmPreparedProof(initial.current,specification),leaseMs,signal);
  }
  /** Proof index and immutable preparation share the target's held transaction.
   * Uploads or local no-clobber copies alone never establish durable custody. */
  async checkpointCurrentFilmProof(job:CurrentFilmMixedJob,workerId:string,raw:CurrentFilmPreparedProof,leaseMs:number,signal?:AbortSignal):Promise<CurrentFilmPreparedProof> {
    signal?.throwIfAborted();job=structuredClone(currentFilmV3Job(job));raw=validateCurrentFilmPreparedProof(raw,job);
    const initial=currentFilmV3Job(await this.database.forProject(job.projectId,tx=>this.held(tx,job,workerId))),
      prepared=advanceCurrentFilmPreparedProof(initial,raw),candidate={...initial,currentFilmProof:prepared},access=currentFilmAccess(()=>this.mixedAccess(job,workerId));
    await verifyCurrentFilmProofMedia(prepared.specification,initial.currentFilm,job.id,this.root,access,signal);
    if(initial.currentFilmProof){await access();signal?.throwIfAborted();return initial.currentFilmProof;}
    const records=await this.uploadMixedFiles(candidate,currentFilmPreparedProofFiles(prepared,candidate),access,signal);
    return this.heldMixedTransaction(job,workerId,leaseMs,async tx=>{
      const current=currentFilmV3Job(await this.held(tx,job,workerId)),next=advanceCurrentFilmPreparedProof(current,prepared);
      if(current.currentFilmProof)return current.currentFilmProof;
      await this.assertProofSelection(tx,current,next.specification);
      await verifyCurrentFilmProofMedia(next.specification,current.currentFilm,job.id,this.root,currentFilmAccess(async()=>{await this.held(tx,job,workerId);}),signal);
      signal?.throwIfAborted();const leased=this.renewedLease(current,await this.held(tx,job,workerId));
      const domain=DurableJobStore.fromJobs([leased]);domain.checkpointCurrentFilmProof(job.id,workerId,next,Date.now(),leaseMs);
      for(const record of records)await this.persist(tx,record);
      const updated=currentFilmV3Job(domain.get(job.id)!);this.assertCurrentFilmFiles(updated,await this.mixedIndex(tx,updated));
      signal?.throwIfAborted();await this.held(tx,job,workerId);
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'current-film.proof',${{revision:next.revision,files:records.length}}::jsonb)`;
      return next;
    });
  }
  /** Preparation is published only after full media verification and current
   * carrier checks. Uploaded objects alone never establish the saved phase. */
  async checkpointCurrentFilmOrigins(job:CurrentFilmMixedJob,workerId:string,origins:CurrentFilmOrigins,leaseMs:number,signal?:AbortSignal):Promise<void> {
    currentFilmV3Job(job);const initial=currentFilmV3Job(await this.database.forProject(job.projectId,tx=>this.held(tx,job,workerId)));
    const prepared=advanceCurrentFilmOrigins(initial,origins),candidate={...initial,currentFilmOrigins:prepared};
    const access=currentFilmAccess(()=>this.mixedAccess(job,workerId));
    await verifyCurrentFilmMixedMedia(candidate,this.root,access,signal);
    const records=await this.uploadMixedFiles(job,prepared.origins.flatMap(origin=>origin.copies.map(copy=>copy.owned)),access,signal);
    await this.heldMixedTransaction(job,workerId,leaseMs,async tx=>{
      const current=currentFilmV3Job(await this.held(tx,job,workerId)),next={...current,currentFilmOrigins:advanceCurrentFilmOrigins(current,prepared)};
      await verifyCurrentFilmMixedMedia(next,this.root,currentFilmAccess(async()=>{await this.held(tx,job,workerId);}),signal);
      signal?.throwIfAborted();const leased=this.renewedLease(current,await this.held(tx,job,workerId));
      const domain=DurableJobStore.fromJobs([leased]);domain.checkpointCurrentFilmOrigins(job.id,workerId,prepared,Date.now(),leaseMs);
      for(const record of records)await this.persist(tx,record);
      const updated=domain.get(job.id)!;this.assertCurrentFilmFiles(updated,await this.mixedIndex(tx,updated));
      // The final held check must see matching custody and index rows inside this
      // transaction. Keep the original lease until it passes: publishing the
      // renewed expiry first could hide a lease that expired during the writes.
      const staged={...updated,leaseExpiresAt:leased.leaseExpiresAt};
      await tx`update hv_jobs set body=${staged}::jsonb,lease_expires_at=${staged.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      signal?.throwIfAborted();await this.held(tx,job,workerId);
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'current-film.origins',${{revision:prepared.revision,files:records.length}}::jsonb)`;
    });
  }
  /** V3 reconstructs actual clips from its private generated/adopted rows; no
   * legacy clip manifest or invented new source render record is published. */
  async checkpointCurrentFilmMixed(job:CurrentFilmMixedJob,workerId:string,checkpoint:CurrentFilmMixedCheckpoint,leaseMs:number,signal?:AbortSignal):Promise<void> {
    currentFilmV3Job(job);const initial=currentFilmV3Job(await this.database.forProject(job.projectId,tx=>this.held(tx,job,workerId)));
    const supplied=validateCurrentFilmMixedCheckpoint(initial,checkpoint),frames=supplied.rows.reduce((sum,row)=>sum+currentFilmMixedRowFrames(row),0),next=advanceCurrentFilmMixedCheckpoint(initial,supplied,supplied.rows.length,frames);
    const candidate={...initial,currentFilmCheckpoint:next,checkpointShots:next.rows.length,checkpointFrame:frames},access=currentFilmAccess(()=>this.mixedAccess(job,workerId));
    await verifyCurrentFilmMixedMedia(candidate,this.root,access,signal);
    const files=next.rows.slice(initial.checkpointShots).flatMap(row=>row.kind==="generated"?Object.values(row.record.files):row.adoption.copies.map(copy=>copy.owned));
    const records=await this.uploadMixedFiles(job,files,access,signal);
    await this.heldMixedTransaction(job,workerId,leaseMs,async tx=>{
      const current=currentFilmV3Job(await this.held(tx,job,workerId)),checked=advanceCurrentFilmMixedCheckpoint(current,next,next.rows.length,frames);
      const complete={...current,currentFilmCheckpoint:checked,checkpointShots:checked.rows.length,checkpointFrame:frames};
      await verifyCurrentFilmMixedMedia(complete,this.root,currentFilmAccess(async()=>{await this.held(tx,job,workerId);}),signal);
      signal?.throwIfAborted();const leased=this.renewedLease(current,await this.held(tx,job,workerId));
      const domain=DurableJobStore.fromJobs([leased]);domain.checkpoint(job.id,workerId,checked.rows.length,frames,Date.now(),leaseMs,checked);
      for(const record of records)await this.persist(tx,record);
      const updated=domain.get(job.id)!;this.assertCurrentFilmFiles(updated,await this.mixedIndex(tx,updated));
      signal?.throwIfAborted();await this.held(tx,job,workerId);
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'current-film.checkpoint',${{revision:checked.revision,checkpointShots:checked.rows.length,checkpointFrame:frames,files:records.length}}::jsonb)`;
    });
  }
  /** Delivery files are content addressed by the held artifact index, while
   * MP4/caption expectations additionally come from the measured output seal. */
  private async mixedDeliveryFiles(job:CurrentFilmMixedJob,signal?:AbortSignal):Promise<RenderFile[]> {
    if(!job.output)return [];validateCurrentFilmRuntimeOutput(job,job.output);
    const playlistKey=job.output.hlsPlaylistPath,playlist=this.local(playlistKey);
    if(this.keyFor(playlist,job)!==playlistKey||!playlistKey.endsWith("/index.m3u8")||Bun.file(playlist).size<1||Bun.file(playlist).size>1024*1024)throw new Error("Retain the bounded owned mixed current-film playlist.");
    const lines=(await Bun.file(playlist).text()).split(/\r?\n/).map(line=>line.trim()),segments=lines.filter(line=>line&&!line.startsWith("#"));
    if(lines[0]!=="#EXTM3U"||!lines.includes("#EXT-X-ENDLIST")||!segments.length||segments.length>10000||new Set(segments).size!==segments.length
      ||segments.some(name=>!/^segment-\d{3,5}\.ts$/.test(name))||lines.some(line=>line.includes("URI=")||line.startsWith("#EXT-X-KEY")))throw new Error("The mixed current-film playlist lost its exact owned segments.");
    const keys=[job.output.manifestPath,...(job.output.c2paPath?[job.output.c2paPath]:[]),playlistKey,...segments.map(name=>playlistKey.slice(0,-"index.m3u8".length)+name)],files:RenderFile[]=[];
    for(const key of keys){signal?.throwIfAborted();const path=this.local(key);if(this.keyFor(path,job)!==key)throw new Error("Mixed delivery escaped its owned path.");
      const size=Bun.file(path).size;if(size<1||size>8*1024**3||(key===job.output.manifestPath||key===job.output.c2paPath)&&size>16*1024**2)throw new Error("Mixed delivery media is empty or exceeds its capacity.");
      const digest=await checksum(Bun.file(path).stream(),signal);if(digest.bytes!==size)throw new Error("Mixed delivery changed while being verified.");files.push({path:key,...digest});
    }
    return files;
  }
  private async assertMixedDeliveryIndex(job:CurrentFilmMixedJob,records:Pick<ArtifactRecord,"key"|"sha256"|"bytes">[],signal?:AbortSignal):Promise<void> {
    const indexed=new Map(records.map(row=>[row.key,row])),delivery=await this.mixedDeliveryFiles(job,signal),expected=new Set([...currentFilmMixedRecordedFiles(job),...delivery].map(file=>file.path));
    for(const file of delivery){const row=indexed.get(file.path);if(!row||row.sha256!==file.sha256||row.bytes!==file.bytes)throw new Error("The mixed current-film delivery differs from its actual indexed playlist, segments or provenance.");}
    if(records.some(row=>!expected.has(row.key)))throw new Error("The mixed current-film artifact index contains unreviewed delivery or media files.");
  }
  /** Delivery inventory and the completed job share one transaction. A failed
   * commit leaves the resumable prefix; a lost response leaves a complete job.
   * Reservation release remains the worker/reconciler's existing ledger duty. */
  async completeCurrentFilmMixedExport(job:CurrentFilmMixedJob,workerId:string,paths:string[],output:CurrentFilmMixedJobOutput,signal?:AbortSignal):Promise<CurrentFilmMixedJob> {
    if(!output)throw new Error("Publish the exact completed mixed current-film output.");
    // A caller still owns its objects while upload/verification awaits. Bind this
    // operation to descriptor-checked detached inputs; DB reads stay authoritative.
    job=structuredClone(currentFilmV3Job(job));
    if(!editValidationKey({output,paths},256*1024**2))throw new Error("Retain bounded portable mixed current-film export inputs.");
    ({output,paths}=structuredClone({output,paths}));
    const initial=currentFilmV3Job(await this.database.forProject(job.projectId,tx=>this.held(tx,job,workerId)));
    validateCurrentFilmRuntimeOutput(initial,output);const candidate=currentFilmV3Job({...initial,output}),access=currentFilmAccess(()=>this.mixedAccess(job,workerId));
    const delivery=await this.mixedDeliveryFiles(candidate,signal),retained=new Set(currentFilmMixedRecordedFiles(initial).map(file=>file.path)),required=[...currentFilmMixedRecordedFiles(candidate).filter(file=>!retained.has(file.path)),...delivery];
    if(!Array.isArray(paths)||paths.length!==required.length)throw new Error("Publish every exact mixed-film output, caption, playlist segment and provenance file.");
    const offered=new Set(paths.map(path=>this.keyFor(path,job)));if(offered.size!==paths.length||required.some(file=>!offered.has(file.path)))throw new Error("Publish every exact mixed-film output, caption, playlist segment and provenance file.");
    await verifyCurrentFilmMixedMedia(candidate,this.root,access,signal);
    const records=await this.uploadMixedFiles(candidate,required,access,signal);
    return this.heldMixedTransaction(job,workerId,DEFAULT_LEASE_MS,async tx=>{
      const current=currentFilmV3Job(await this.held(tx,job,workerId));validateCurrentFilmRuntimeOutput(current,output);const complete=currentFilmV3Job({...current,output});
      await verifyCurrentFilmMixedMedia(complete,this.root,currentFilmAccess(async()=>{await this.held(tx,job,workerId);}),signal);
      signal?.throwIfAborted();await this.held(tx,job,workerId);
      const replacement=new Set(records.map(row=>row.key)),combined=[...(await this.mixedIndex(tx,current)).filter(row=>!replacement.has(row.key)),...records];
      this.assertCurrentFilmFiles(complete,combined);await this.assertMixedDeliveryIndex(complete,combined,signal);
      for(const record of records)await this.persist(tx,record);
      signal?.throwIfAborted();const finishing=currentFilmV3Job(await this.held(tx,job,workerId));
      const domain=DurableJobStore.fromJobs([finishing]),updated=currentFilmV3Job(domain.complete(job.id,workerId,output,Date.now()));
      await tx`update hv_jobs set body = ${updated}::jsonb, status = ${updated.status},
        claimed_by = ${updated.claimedBy}, lease_expires_at = ${updated.leaseExpiresAt},
        next_eligible_at = ${updated.nextEligibleAt}, lease_version = ${updated.leaseVersion ?? 0},
        updated_at = now() where id = ${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'artifacts.exported',${{artifacts:records.map(record=>({key:record.key,sha256:record.sha256,bytes:record.bytes}))}}::jsonb)`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'job.completed',${{status:updated.status,workerId,leaseVersion:updated.leaseVersion??0,checkpointShots:updated.checkpointShots}}::jsonb)`;
      return updated;
    });
  }
  async publishExport(job: Job, workerId: string, paths: string[], signal?: AbortSignal,output?:NonNullable<Job["output"]>): Promise<void> {
    if(currentFilmRuntimeMode(job)==="v3")throw new Error("Complete mixed current-film delivery and job state atomically with completeCurrentFilmMixedExport.");
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
    if(!row)throw new Error("The retained source artifact is unavailable.");const r=this.record(row,projectId,jobId,await this.storedArtifactLimit(row,projectId,jobId));return {path:r.key,sha256:r.sha256,bytes:r.bytes};
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
    await this.database.forProject(job.projectId,async tx=>{const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null and expired_at is null`)[0]?.body as PersistedProject|undefined;
      const source=(await tx`select body from hv_jobs where id=${job.soundMix!.source.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertSoundSourceAvailable(current.soundMix!,source);assertSoundPermission(current.soundMix!,project);
      const domain=DurableJobStore.fromJobs([current]);domain.checkpointSound(job.id,workerId,output,Date.now(),leaseMs);for(const record of records)await this.persist(tx,record);const updated=domain.get(job.id)!;
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'sound.checkpoint',${{revision:output.sound!.revision,files:records.length}}::jsonb)`;
    });
  }
  async checkpointEdit(job:Job,workerId:string,output:NonNullable<Job["output"]>,leaseMs:number,signal?:AbortSignal,access:()=>Promise<void>=async()=>{},phase:CheckpointPhase=UNRECORDED_CHECKPOINT_PHASE):Promise<void>{
    const records=await checkpointMedia(output.editorial!.files,()=>verifyEditMedia(job,output,this.root,access,signal),
      file=>this.upload(job,file.path,Bun.file(this.local(file.path)),signal),access,phase,"Editorial media changed before checkpointing.");
    await this.database.forProject(job.projectId,async tx=>{
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null and expired_at is null`)[0]?.body as PersistedProject|undefined;assertEditPermission(current.pictureEdit!,project);
      for(const binding of current.pictureEdit!.bindings){const source=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;assertEditBindingAvailable(binding,source);}
      const domain=DurableJobStore.fromJobs([current]);domain.checkpointEdit(job.id,workerId,output,Date.now(),leaseMs);for(const record of records)await this.persist(tx,record);const updated=domain.get(job.id)!;
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'editorial.checkpoint',${{revision:output.editorial!.revision,files:records.length}}::jsonb)`;
    });
  }
  /** Publish independently verified assembly media and original copies under the current worker fence. */
  async checkpointAssembly(job:Job,workerId:string,output:NonNullable<Job["output"]>,leaseMs:number,signal?:AbortSignal,access:()=>Promise<void>=async()=>{},phase:CheckpointPhase=UNRECORDED_CHECKPOINT_PHASE):Promise<void>{
    const records=await checkpointMedia(output.assembly!.files,()=>verifyEditAssemblyMedia({...job,assemblyEdit:job.assemblyEdit!},{...output,assembly:output.assembly!},this.root,access,signal),
      file=>this.upload(job,file.path,Bun.file(this.local(file.path)),signal),access,phase,"Assembly media changed before checkpointing.");
    await access();signal?.throwIfAborted();
    await this.database.forProject(job.projectId,async tx=>{
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null and expired_at is null`)[0]?.body as PersistedProject|undefined;assertEditAssemblyPermission(current.assemblyEdit!,project);
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
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null and expired_at is null`)[0]?.body as PersistedProject|undefined;
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
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null and expired_at is null`)[0]?.body as PersistedProject|undefined;assertGraphicPermission(current.graphicRender!,project);
      const domain=DurableJobStore.fromJobs([current]);domain.checkpointGraphic(job.id,workerId,output,Date.now(),leaseMs);for(const record of records)await this.persist(tx,record);const updated=domain.get(job.id)!;
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'graphic.checkpoint',${{revision:output.revision,files:records.length}}::jsonb)`;
    });
  }
  /**
   * HV-027-05: retain the one file a deliverable is, and checkpoint it under the current fence.
   *
   * A deliverable is a single file, so `checkpointMedia`'s phases have one file to name -- the value
   * here is that the verification and the upload are recorded separately, as they are for editorial,
   * rather than disappearing into one unspanned call.
   */
  async checkpointDelivery(job:Job,workerId:string,output:DeliveryResult,leaseMs:number,signal?:AbortSignal,access:()=>Promise<void>=async()=>{},phase:CheckpointPhase=UNRECORDED_CHECKPOINT_PHASE):Promise<void>{
    // HV-019-15: a hero render retains each stage's file, its record and its sidecar; a cut's deliverable one file.
    const records=await checkpointMedia(deliveryRetainedFiles(output),()=>verifyDeliveryMedia(job,output,this.root,access,signal),
      file=>this.upload(job,file.path,Bun.file(this.local(file.path)),signal),access,phase,"The deliverable changed before checkpointing.");
    await this.database.forProject(job.projectId,async tx=>{
      const current=await this.held(tx,job,workerId),project=(await tx`select body from hv_projects where id=${job.projectId} and taken_down_at is null and expired_at is null`)[0]?.body as PersistedProject|undefined;
      assertDeliveryPermission(current.delivery!,project);
      const domain=DurableJobStore.fromJobs([current]);domain.checkpointDelivery(job.id,workerId,output,Date.now(),leaseMs);
      for(const record of records)await this.persist(tx,record);const updated=domain.get(job.id)!;
      await tx`update hv_jobs set body=${updated}::jsonb,lease_expires_at=${updated.leaseExpiresAt},updated_at=now() where id=${job.id}`;
      await tx`insert into hv_outbox(id,project_id,job_id,event_type,body) values (${crypto.randomUUID()},${job.projectId},${job.id},'delivery.checkpoint',${{revision:output.revision,files:records.length}}::jsonb)`;
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
    const mode=currentFilmRuntimeMode(job);
    const keys = new Set(paths.map(path => this.keyFor(path,job)));
    if(mode==="v3"){
      const mixed=currentFilmV3Job(job);
      if(mixed.currentFilmProof)await verifyCurrentFilmProofMedia(mixed.currentFilmProof.specification,mixed.currentFilm,mixed.id,this.root,async()=>{});
      if(mixed.currentFilmOrigins)await verifyCurrentFilmMixedMedia(mixed,this.root,async()=>{});
    }
    else if(job.currentFilm&&(job.currentFilmCheckpoint||job.output))await verifyCurrentFilmMedia(job,this.root);
    if(job.dialogueReplacement){const output=job.output??job.dialogueCheckpoint;if(output)await verifyDialogueMedia(job,output,this.root,undefined,retainedDialogueTime(job));}
    if(job.soundMix){const output=job.output??job.soundCheckpoint;if(output){await verifySoundMedia(job,output,this.root);if(output.sound!.files.some(f=>!keys.has(f.path)))throw new Error("Imported sound media is missing.");}}
    if(job.graphicRender){const output=job.graphicOutput??job.graphicCheckpoint;if(output){await verifyGraphicMedia(job,output,this.root);if(output.files.some(f=>!keys.has(f.path)))throw new Error("Imported graphic media is missing.");}}
    if(job.pictureEdit){const output=job.output??job.editCheckpoint;if(output){await verifyEditMedia(job,output,this.root,async()=>{});if(output.editorial!.files.some(f=>!keys.has(f.path)))throw new Error("Imported editorial media is missing.");}}
    if(job.assemblyEdit){const output=job.output??job.assemblyCheckpoint;if(output){await verifyEditAssemblyMedia({...job,assemblyEdit:job.assemblyEdit},{...output,assembly:output.assembly!},this.root,async()=>{});if(output.assembly!.files.some(f=>!keys.has(f.path)))throw new Error("Imported assembly media is missing.");}}
    if(job.audioTake){const output=job.audioOutput??job.audioCheckpoint;if(output)verifyAudioMedia(job,output,this.root);}
    if(job.lipSync){if(job.lipSyncPrepared)await verifyLipSyncPrepared(job,job.lipSyncPrepared,this.root);const output=job.output??job.lipSyncCheckpoint;if(output)await verifyLipSyncMedia(job,output,this.root);const required=[...(job.lipSyncPrepared?lipSyncPreparedFiles(job.lipSyncPrepared):[]),...(output?.lipSync?.files??[])];if(required.some(f=>!keys.has(f.path)))throw new Error("Imported lip-sync media is missing.");}
    if(job.delivery){const output=job.deliveryOutput??job.deliveryCheckpoint;if(output&&!keys.has(output.file.path))throw new Error("Imported deliverable media is missing.");}
    if (mode!=="v3"&&job.checkpointShots && !keys.has(`${job.projectId}/${job.id}/clips/manifest.json`)) throw new Error("imported checkpoint manifest is missing");
    if (job.output) assertProvenanceSidecarsBeside(job.output);
    if (job.output) for (const key of [job.output.mp4Path,job.output.hlsPlaylistPath,job.output.captionsPath,job.output.manifestPath,...(job.output.c2paPath?[job.output.c2paPath]:[]),
      ...(job.output.sheetPath ? [job.output.sheetPath] : []),...(job.output.takeClips??[]).flatMap(clip=>[clip.path,clip.hlsPath,clip.posterPath,clip.captionsPath,clip.manifestPath,...(clip.c2paPath?[clip.c2paPath]:[])]), ...(job.output.storyboard ?? []).flatMap(frame => [frame.path,...(frame.sourcePath?[frame.sourcePath]:[])])]) {
      if (!keys.has(artifactKey(key,job.projectId,job.id))) throw new Error("imported export media is missing");
    }
    const records: ArtifactRecord[] = [];let pendingClips:VideoClip[]|undefined;
    // Object-form manifests meet the hv-clips/1 contract before any upload or database write;
    // the legacy bare-array local form that restoreCheckpoint writes is accepted exactly as before.
    const manifests = new Map<string,VideoClip[] | {schema: string; clips: VideoClip[]}>();
    for (const path of paths) if (this.keyFor(path,job).endsWith("/clips/manifest.json")) {
      const source = JSON.parse(readFileSync(path,"utf8")) as VideoClip[] | {schema: string; clips: VideoClip[]};
      manifests.set(path,Array.isArray(source) ? source : assertArchiveDocument("hv-clips/1",source));
    }
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
      if (mode!=="v3"&&key.endsWith("/clips/manifest.json")) {
        const source = manifests.get(path)!;
        const clips = Array.isArray(source) ? source : source.clips;
        if (!Array.isArray(clips) || clips.length !== job.checkpointShots) throw new Error("imported clip manifest does not match the checkpoint");
        const manifest = clipsManifest(clips,portable);
        if(job.livingScript||job.executionCheckpoints!==undefined||job.currentFilm){validateLivingScriptClips(job,manifest.clips);if(job.currentFilm)validateCurrentFilmClips(job,manifest.clips);else validateShotExecutionClips(job,manifest.clips);pendingClips=manifest.clips;}
        records.push(await this.upload(job,key,new Blob([JSON.stringify(manifest)])));
      } else records.push(await this.upload(job,key,Bun.file(path)));
    }
    for(const clip of job.output?.takeClips??[])if(records.find(r=>r.key===clip.path)?.sha256!==clip.sha256)throw new Error("imported take video checksum differs from its provenance");
    this.assertRenderedFiles(job,records);
    if(mode==="v3"&&job.currentFilmOrigins){const mixed=currentFilmV3Job(job);await verifyCurrentFilmMixedMedia(mixed,this.root,async()=>{});await this.assertMixedDeliveryIndex(mixed,records);}
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
  private record(row: Record<string,unknown>, projectId: string, jobId: string,maximum=8*1024**3): ArtifactRecord {
    const key = artifactKey(String(row.key), projectId, jobId);
    const sha256 = String(row.sha256), bytes = Number(row.bytes);
    if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum)
      throw new Error("invalid stored artifact metadata");
    const objectKey = `v1/${projectId}/${jobId}/${sha256}/${basename(key)}`;
    if (row.object_key !== objectKey || row.backend !== "s3") throw new Error("invalid stored artifact reference");
    return {key, objectKey, sha256, bytes, projectId, jobId, contentType: String(row.content_type)};
  }
  private assertRenderedFiles(job:Job,records:ArtifactRecord[]):void {
    this.assertCurrentFilmFiles(job,records);
    if(currentFilmRuntimeMode(job)==="v3")return;
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
    // HV-040-07: a deliverable is the one media a job may hold *without* a `job.output` --
    // `validateDeliveryJob` forbids one, because "a deliverable retains its own single file and
    // nothing else". Eight stages are checked above by the field that carries their media and this
    // one was checked by none of them, so a finished deliverable could round-trip through a project
    // archive as a `done` job whose file nothing had ever looked for.
    if(job.delivery)for(const output of [job.deliveryCheckpoint,job.deliveryOutput].filter(Boolean)){
      validateDeliveryOutput(job,output!);
      // HV-019-15: every file a hero render retains, not just its result.
      for(const file of deliveryRetainedFiles(output!)){const record=records.find(value=>value.key===file.path);
        if(!record||record.sha256!==file.sha256||record.bytes!==file.bytes)throw new Error("Stored deliverable differs from its checkpoint.");}
    }
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
    if(currentFilmRuntimeMode(job)==="v3"){
      const mixed=currentFilmV3Job(job);
      if(!mixed.currentFilmOrigins&&(mixed.checkpointShots!==0||mixed.checkpointFrame!==0||mixed.currentFilmCheckpoint||mixed.output))throw new Error("Mixed current-film media has no complete saved original preparation.");
      if(!mixed.currentFilmOrigins&&!mixed.currentFilmProof){if(records.length)throw new Error("Mixed current-film media has no saved preparation.");return;}
      if(records.length>100000||new Set(records.map(row=>row.key)).size!==records.length)throw new Error("Retain a bounded distinct mixed current-film artifact index.");
      const indexed=new Map(records.map(row=>[row.key,row])),required=currentFilmMixedRecordedFiles(mixed),paths=new Set(required.map(file=>file.path));
      for(const file of required){const row=indexed.get(file.path);if(!row||row.sha256!==file.sha256||row.bytes!==file.bytes)throw new Error("Stored mixed current-film bytes differ from their complete original, selected-role or output evidence.");}
      const output=mixed.output,prefix=output?.hlsPlaylistPath.slice(0,-"index.m3u8".length);
      for(const row of records)if(!paths.has(row.key)&&!(output&&(row.key===output.manifestPath||row.key===output.c2paPath||row.key===output.hlsPlaylistPath||row.key.startsWith(prefix!)&&/^segment-\d{3,5}\.ts$/.test(row.key.slice(prefix!.length)))))throw new Error("The mixed current-film artifact index contains an unowned media role.");
      if(output)for(const path of [output.hlsPlaylistPath,output.manifestPath,...(output.c2paPath?[output.c2paPath]:[])])if(!indexed.has(path))throw new Error("Stored mixed current-film delivery artifacts are missing.");
      return;
    }
    assertCurrentFilmMode(job);
    if(!job.currentFilm){if(job.currentFilmCheckpoint||job.output?.currentFilm)throw new Error("Current-film media has no owning job context.");return;}
    assertCurrentFilmMode(job);validateCurrentFilmJob(job);
    const requireFile=(path:string,digest:{sha256:string;bytes:number}):void=>{const actual=records.find(row=>row.key===path);if(!actual||actual.sha256!==digest.sha256||actual.bytes!==digest.bytes)throw new Error("Stored current-film bytes differ from their measured evidence.");};
    if(job.currentFilmCheckpoint){const checked=advanceCurrentFilmCheckpoint(job,job.currentFilmCheckpoint,job.checkpointShots,job.checkpointFrame);for(const row of checked.rows)for(const file of Object.values(row.record.files))requireFile(file.path,file);}
    else if(job.checkpointShots!==0||job.checkpointFrame!==0)throw new Error("Current-film progress lost its private custody.");
    if(job.output){validateCurrentFilmOutput(job,job.output);const clock=job.output.currentFilm!.assembly;
      for(const path of [job.output.mp4Path,job.output.hlsPlaylistPath,job.output.captionsPath,job.output.manifestPath,...(job.output.c2paPath?[job.output.c2paPath]:[])])if(!records.some(row=>row.key===path))throw new Error("The current-film export is missing a published artifact.");
      if(!job.output.captionsPath.endsWith(".vtt"))throw new Error("Retain the actual current-film caption formats.");
      requireFile(job.output.mp4Path,clock.video);requireFile(job.output.captionsPath,clock.captions.vtt);requireFile(job.output.captionsPath.slice(0,-4)+".srt",clock.captions.srt);
    }
  }
  async restoreCheckpoint(job: Job, signal?: AbortSignal): Promise<void> {
    const mode=currentFilmRuntimeMode(job);
    const records: ArtifactRecord[] = await this.database.forProject(job.projectId, async tx => (await tx`select * from hv_artifacts
      where project_id = ${job.projectId} and job_id = ${job.id}`).map((row: Record<string,unknown>) => this.record(row, job.projectId, job.id,this.artifactLimit(job,String(row.key)))));
    const keys = new Set(records.map(record => record.key));
    const manifestKey = `${job.projectId}/${job.id}/clips/manifest.json`;
    if (mode!=="v3"&&job.checkpointShots && !keys.has(manifestKey)) throw new Error("the stored checkpoint manifest is missing");
    if (job.output) assertProvenanceSidecarsBeside(job.output);
    if (job.output) for (const key of [job.output.mp4Path,job.output.hlsPlaylistPath,job.output.captionsPath,job.output.manifestPath,...(job.output.c2paPath?[job.output.c2paPath]:[]),
      ...(job.output.sheetPath ? [job.output.sheetPath] : []),...(job.output.takeClips??[]).flatMap(clip=>[clip.path,clip.hlsPath,clip.posterPath,clip.captionsPath,clip.manifestPath,...(clip.c2paPath?[clip.c2paPath]:[])]), ...(job.output.storyboard ?? []).flatMap(frame => [frame.path,...(frame.sourcePath?[frame.sourcePath]:[])])]) {
      if (!keys.has(artifactKey(key,job.projectId,job.id))) throw new Error("the stored export media is missing");
    }
    for(const clip of job.output?.takeClips??[])if(records.find(r=>r.key===clip.path)?.sha256!==clip.sha256)throw new Error("stored take video checksum differs from its provenance");
    this.assertRenderedFiles(job,records);
    const editDisk=job.pictureEdit||job.assemblyEdit||mode==="v3"?editWorkspaceGuard(this.root,()=>[resolve(this.root,job.projectId,job.id)]):undefined;if(editDisk)assertEditFreeSpace(this.root,records.reduce((n,r)=>n+r.bytes,0)*3);
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
    // HV-031-15: a restored signed export's record names its sidecar's exact bytes, here the
    // checksum-verified bytes just downloaded. Unsigned exports have no sidecar to compare.
    for(const value of job.output?[job.output,...(job.output.takeClips??[])]:[])if(value.c2paPath){
      const record=JSON.parse(readFileSync(this.local(value.manifestPath),"utf8")) as unknown,sidecar=records.find(row=>row.key===value.c2paPath)!.sha256;
      if(!provenanceSidecarAgrees(record,sidecar))throw new Error("the stored C2PA sidecar differs from the bytes its provenance record names");
    }
    if(mode==="v3"){
      const mixed=currentFilmV3Job(job);
      if(mixed.currentFilmProof)await verifyCurrentFilmProofMedia(mixed.currentFilmProof.specification,mixed.currentFilm,mixed.id,this.root,async()=>{},signal);
      if(mixed.currentFilmOrigins)await verifyCurrentFilmMixedMedia(mixed,this.root,async()=>{},signal);
      if(mixed.currentFilmOrigins||mixed.currentFilmProof)await this.assertMixedDeliveryIndex(mixed,records,signal);
      return;
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
    const manifest = assertArchiveDocument("hv-clips/1",JSON.parse(readFileSync(this.local(manifestKey), "utf8")) as {schema: string; clips: VideoClip[]});
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
    const record = this.record(rows[0], projectId, jobId,await this.storedArtifactLimit(rows[0],projectId,jobId));
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
