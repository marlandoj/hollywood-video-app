import { S3Client, type SQL } from "bun";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { DurableJobStore, LeaseError, type Job } from "../../queue/src/index";
import type { VideoClip } from "../../generator/src/index";
import { writeJsonFile } from "../../queue/src/persist";
import { StudioDatabase } from "./database";

const TYPES: Record<string,string> = {".mp4":"video/mp4",".png":"image/png",".m3u8":"application/vnd.apple.mpegurl",
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
  if (!env.HV_S3_ENDPOINT || !env.HV_S3_BUCKET || !env.HV_S3_ACCESS_KEY_ID || !env.HV_S3_SECRET_ACCESS_KEY)
    throw new Error("shared artifact storage is not configured");
  const endpoint = new URL(env.HV_S3_ENDPOINT);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(endpoint.hostname)))
    throw new Error("shared artifact storage requires HTTPS");
  return new S3Client({endpoint: endpoint.href.replace(/\/$/, ""), bucket: env.HV_S3_BUCKET,
    accessKeyId: env.HV_S3_ACCESS_KEY_ID, secretAccessKey: env.HV_S3_SECRET_ACCESS_KEY,
    region: env.HV_S3_REGION ?? "us-east-1", virtualHostedStyle: false});
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
    const rows = await tx`select body, lease_version from hv_jobs where id = ${job.id} for update`;
    const current = rows[0]?.body as Job | undefined;
    if (!current || current.status !== "running") throw new LeaseError(job.id, "not_running", current?.claimedBy ?? null);
    if (current.claimedBy !== workerId) throw new LeaseError(job.id, "wrong_worker", current.claimedBy);
    if (rows[0].lease_version !== job.leaseVersion) throw new LeaseError(job.id, "fence_changed", current.claimedBy);
    if (!current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.now()) throw new LeaseError(job.id, "lease_expired", current.claimedBy);
    return current;
  }
  private async persist(tx: SQL, record: ArtifactRecord): Promise<void> {
    await tx`insert into hv_artifacts (key, object_key, project_id, job_id, sha256, bytes, content_type, backend)
      values (${record.key}, ${record.objectKey}, ${record.projectId}, ${record.jobId}, ${record.sha256}, ${record.bytes}, ${record.contentType}, 's3')
      on conflict (key) do update set object_key = excluded.object_key, sha256 = excluded.sha256, bytes = excluded.bytes,
        content_type = excluded.content_type, backend = 's3', created_at = now()`;
  }
  async checkpoint(job: Job, workerId: string, clips: VideoClip[], frames: number, leaseMs: number, signal?: AbortSignal): Promise<void> {
    const latest = clips.at(-1)!;
    const paths = [latest.path, ...(latest.posterPath ? [latest.posterPath] : [])];
    const records: ArtifactRecord[] = [];
    for (const path of paths) records.push(await this.upload(job, this.keyFor(path, job), Bun.file(path), signal));
    const manifest = {schema: "hv-clips/1", clips: clips.map(clip => ({...clip, path: this.keyFor(clip.path, job),
      posterPath: clip.posterPath ? this.keyFor(clip.posterPath, job) : undefined}))};
    records.push(await this.upload(job, `${job.projectId}/${job.id}/clips/manifest.json`, new Blob([JSON.stringify(manifest)]), signal));
    await this.database.forProject(job.projectId, async tx => {
      const current = await this.held(tx, job, workerId);
      for (const record of records) await this.persist(tx, record);
      const domain = DurableJobStore.fromJobs([current]);
      domain.checkpoint(job.id, workerId, clips.length, frames, Date.now(), leaseMs);
      const updated = domain.get(job.id)!;
      await tx`update hv_jobs set body = ${updated}::jsonb, lease_expires_at = ${updated.leaseExpiresAt}, updated_at = now() where id = ${job.id}`;
      await tx`insert into hv_outbox (id, project_id, job_id, event_type, body) values
        (${crypto.randomUUID()}, ${job.projectId}, ${job.id}, 'job.checkpoint',
        ${{checkpointShots: clips.length, checkpointFrame: frames, artifacts: records.map(record => ({key: record.key, sha256: record.sha256, bytes: record.bytes}))}}::jsonb)`;
    });
  }
  async publishExport(job: Job, workerId: string, paths: string[], signal?: AbortSignal): Promise<void> {
    const records: ArtifactRecord[] = [];
    for (const path of paths) records.push(await this.upload(job, this.keyFor(path, job), Bun.file(path), signal));
    await this.database.forProject(job.projectId, async tx => {
      await this.held(tx, job, workerId);
      for (const record of records) await this.persist(tx, record);
      await tx`insert into hv_outbox (id, project_id, job_id, event_type, body) values
        (${crypto.randomUUID()}, ${job.projectId}, ${job.id}, 'artifacts.exported',
        ${{artifacts: records.map(record => ({key: record.key, sha256: record.sha256, bytes: record.bytes}))}}::jsonb)`;
    });
  }
  /** Offline migration only: the runtime API/worker roles cannot use this path. */
  async importCompletedJob(job: Job, paths: string[]): Promise<{files: number; bytes: number}> {
    if ((await this.database.sql`select current_user as role`)[0].role !== "hv_admin") throw new Error("media import requires the migration role");
    if (["queued","running"].includes(job.status) || !job.output) throw new Error("media import requires a completed export");
    if (paths.length > 100_000) throw new Error("job media exceeds its file limit");
    const keys = new Set(paths.map(path => this.keyFor(path,job)));
    const records: ArtifactRecord[] = [];
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
          posterPath:clip.posterPath ? portable(clip.posterPath) : undefined}))};
        records.push(await this.upload(job,key,new Blob([JSON.stringify(manifest)])));
      } else records.push(await this.upload(job,key,Bun.file(path)));
    }
    await this.database.forProject(job.projectId,async tx => {
      const current = (await tx`select body from hv_jobs where id = ${job.id} and project_id = ${job.projectId} for update`)[0]?.body as Job | undefined;
      if (!current || ["queued","running"].includes(current.status)) throw new Error("the job changed during media import");
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
  async restoreCheckpoint(job: Job, signal?: AbortSignal): Promise<void> {
    if (!job.checkpointShots) return;
    const records: ArtifactRecord[] = await this.database.forProject(job.projectId, async tx => (await tx`select * from hv_artifacts
      where project_id = ${job.projectId} and job_id = ${job.id}`).map((row: Record<string,unknown>) => this.record(row, job.projectId, job.id)));
    const keys = new Set(records.map(record => record.key));
    const manifestKey = `${job.projectId}/${job.id}/clips/manifest.json`;
    if (!keys.has(manifestKey)) throw new Error("the stored checkpoint manifest is missing");
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
          bytes += chunk.byteLength;
          if (bytes > record.bytes) throw new Error("downloaded artifact exceeds its recorded size");
          hash.update(chunk); writer.write(chunk); await writer.flush();
        }
        await writer.end();
        if (bytes !== record.bytes || hash.digest("hex") !== record.sha256) throw new Error("downloaded artifact failed checksum verification");
        renameSync(temporary, path);
      } catch (error) { await writer.end(); try { unlinkSync(temporary); } catch {} throw error; }
    }
    const manifest = JSON.parse(readFileSync(this.local(manifestKey), "utf8")) as {schema: string; clips: VideoClip[]};
    if (manifest.schema !== "hv-clips/1" || !Array.isArray(manifest.clips) || manifest.clips.length !== job.checkpointShots)
      throw new Error("stored clip manifest does not match the job checkpoint");
    const clips = manifest.clips.map(clip => {
      const path = artifactKey(clip.path, job.projectId, job.id);
      const posterPath = clip.posterPath ? artifactKey(clip.posterPath, job.projectId, job.id) : undefined;
      if (!keys.has(path) || (posterPath && !keys.has(posterPath))) throw new Error("stored clip media is missing");
      return {...clip, path: this.local(path), posterPath: posterPath ? this.local(posterPath) : undefined};
    });
    writeJsonFile(this.local(manifestKey), clips);
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
