import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { objectClient } from "./artifacts";
import { StudioDatabase } from "./database";

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_OBJECT_BYTES = 72 * 1024 ** 3;
const MAX_OBJECTS = 1_000_000;
export interface BackupObject {key: string; sha256: string; bytes: number}
export interface BackupManifest {
  schema: "hv-backup/1"; id: string; source: {cluster: string; database: string}; snapshotAt: string; completedAt: string;
  database: {file: "state.dump"; bytes: number; sha256: string}; objects: BackupObject[];
  summary: {projects: number; jobs: number; costEvents: number; recordedCostUsd: number};
}
function syncDirectory(path: string): void {
  const descriptor = openSync(path,"r");try {fsyncSync(descriptor);} finally {closeSync(descriptor);}
}
function privateJson(path: string, value: unknown): void {
  const descriptor = openSync(path,"wx",0o600);
  try {writeFileSync(descriptor,JSON.stringify(value,null,2)+"\n");fsyncSync(descriptor);} finally {closeSync(descriptor);}
}
async function digest(stream: ReadableStream<Uint8Array>, expectedBytes?: number): Promise<{sha256: string; bytes: number}> {
  const hash = createHash("sha256");let bytes = 0;
  for await (const chunk of stream) {bytes+=chunk.byteLength;if (bytes>(expectedBytes ?? MAX_OBJECT_BYTES)) throw new Error("backup payload exceeded its size limit");hash.update(chunk);}
  if (expectedBytes !== undefined && bytes !== expectedBytes) throw new Error("backup payload size mismatch");
  return {sha256:hash.digest("hex"),bytes};
}
function validateObject(object: BackupObject): BackupObject {
  if (!SHA.test(object.sha256) || !Number.isSafeInteger(object.bytes) || object.bytes<0 || object.bytes>MAX_OBJECT_BYTES
    || object.key.length>1024 || !/^[A-Za-z0-9_./-]+$/.test(object.key)) throw new Error("invalid backup object metadata");
  const parts = object.key.split("/");
  if (parts.some(part=>!part||part==="."||part==="..") || !ID.test(parts[1] ?? "") || !ID.test(parts[2] ?? "")) throw new Error("invalid backup object path");
  if (!((parts[0]==="v1" && parts.length===5 && parts[3]===object.sha256)
    || (parts[0]==="archives" && parts.length===4 && parts[3]===object.sha256+".zip"))) throw new Error("backup object does not match its content address");
  return object;
}
function repository(path: string): string {
  mkdirSync(path,{recursive:true,mode:0o700});const root=realpathSync(path);
  for (const folder of ["blobs","snapshots"]) {
    const directory=resolve(root,folder);
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error("backup repository directory is unsafe");
    mkdirSync(directory,{recursive:true,mode:0o700});
  }
  return root;
}
function regular(path: string): void {
  const stat=lstatSync(path);if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("backup payload must be a regular file");
}
function pgEnvironment(url: string): Record<string,string> {
  const connection=new URL(url),role=decodeURIComponent(connection.username),tls=process.env.HV_DATABASE_TLS_DIR;
  if (role!=="hv_admin") throw new Error("database backup/restore requires the migration role");
  const env: Record<string,string> = {PATH:process.env.PATH ?? "/usr/bin:/bin",PGHOST:connection.hostname,
    PGPORT:connection.port||"5432",PGDATABASE:decodeURIComponent(connection.pathname.slice(1)),PGUSER:role,
    PGPASSWORD:decodeURIComponent(connection.password),PGCONNECT_TIMEOUT:"10",PGAPPNAME:"rough-cut-backup",PGOPTIONS:"-c statement_timeout=180000 -c lock_timeout=10000"};
  if (process.env.HV_PG_LIB) env.LD_LIBRARY_PATH=process.env.HV_PG_LIB;
  if (tls) Object.assign(env,{PGSSLMODE:"verify-full",PGSSLROOTCERT:resolve(tls,"ca.pem"),PGSSLCERT:resolve(tls,role+".pem"),PGSSLKEY:resolve(tls,role+"-key.pem")});
  else env.PGSSLMODE=["127.0.0.1","localhost","[::1]"].includes(connection.hostname)?"disable":"verify-full";
  return env;
}
async function pg(command: "pg_dump"|"pg_restore", args: string[], url: string): Promise<void> {
  const binary=process.env.HV_PG_BIN?resolve(process.env.HV_PG_BIN,command):command;
  const child=Bun.spawn([binary,...args],{env:pgEnvironment(url),stdout:"ignore",stderr:"pipe"});
  let forced: ReturnType<typeof setTimeout> | undefined;
  const timeout=setTimeout(()=>{child.kill("SIGTERM");forced=setTimeout(()=>child.kill("SIGKILL"),5000);},180_000);
  try {
    const [code,error]=await Promise.all([child.exited,new Response(child.stderr).text()]);
    if (code!==0) throw new Error(command+" failed: "+error.slice(-2000));
  } finally {clearTimeout(timeout);clearTimeout(forced);}
}
async function copyObject(object: BackupObject, root: string, client: ReturnType<typeof objectClient>): Promise<void> {
  validateObject(object);
  const path=resolve(root,"blobs",object.sha256);
  if (existsSync(path)) {
    regular(path);const result=await digest(Bun.file(path).stream(),object.bytes);
    if (result.sha256!==object.sha256) throw new Error("existing backup blob is corrupt");
    return;
  }
  const temporary=path+"."+crypto.randomUUID()+".pending";
  const descriptor=openSync(temporary,"wx",0o600);closeSync(descriptor);
  const stream=client.file(object.key).stream(),reader=stream.getReader(),writer=Bun.file(temporary).writer();
  const signal=AbortSignal.timeout(300_000),abort=()=>{void reader.cancel(signal.reason).catch(()=>{});};
  signal.addEventListener("abort",abort,{once:true});
  let bytes=0;const hash=createHash("sha256");
  try {
    while (true) {
      const next=await reader.read();signal.throwIfAborted();if (next.done) break;
      bytes+=next.value.byteLength;if (bytes>object.bytes) throw new Error("backup object exceeds its indexed size");
      hash.update(next.value);writer.write(next.value);await writer.flush();
    }
    await writer.end();
    if (bytes!==object.bytes || hash.digest("hex")!==object.sha256) throw new Error("backup media checksum mismatch");
  } catch (error) {await writer.end();unlinkSync(temporary);throw error;}
  finally {signal.removeEventListener("abort",abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
  const fd=openSync(temporary,"r");try {fsyncSync(fd);} finally {closeSync(fd);}
  renameSync(temporary,path);syncDirectory(dirname(path));
}
export async function createStorageBackup(url: string, path: string): Promise<BackupManifest> {
  const root=repository(path),client=objectClient();
  // Media copying can exceed the ordinary pool idle timeout. This dedicated
  // connection must retain both the exported snapshot and session locks.
  const database=new StudioDatabase(url,1,{idleTimeout:0}),connection=await database.sql.reserve();
  const id=new Date().toISOString().replaceAll(/[-:.]/g,"")+"-"+crypto.randomUUID();
  const temporary=resolve(root,"snapshots",id+".pending"),destination=resolve(root,"snapshots",id);
  mkdirSync(temporary,{mode:0o700});
  let transaction=false;
  try {
    // Session locks are acquired BEFORE beginning the snapshot transaction.
    // This avoids capturing rows for media that a preceding cleanup is still deleting.
    await connection`select pg_advisory_lock(91377,2)`;
    await connection`select pg_advisory_lock_shared(91377,1)`;
    await connection`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`;transaction=true;
    if ((await connection`select current_user as role`)[0].role!=="hv_admin") throw new Error("backup requires the migration role");
    const sourceRow=(await connection`select system_identifier::text as cluster,current_database() as database from pg_control_system()`)[0];
    const source={cluster:String(sourceRow.cluster),database:String(sourceRow.database)};
    const marker=resolve(root,"repository.json");
    if (!existsSync(marker)) {privateJson(marker,{schema:"hv-backup-repository/1",source});syncDirectory(root);}
    else {
      regular(marker);const previous=JSON.parse(readFileSync(marker,"utf8"));
      if (previous.schema!=="hv-backup-repository/1" || previous.source?.cluster!==source.cluster || previous.source?.database!==source.database)
        throw new Error("backup repository belongs to another database");
    }
    const snapshot=(await connection`select pg_export_snapshot() as id,transaction_timestamp() as at`)[0];
    const rows=await connection`select object_key,sha256,bytes from hv_artifacts order by object_key`;
    const archiveRows=await connection`select object_key from hv_archives order by object_key`;
    if (rows.length+archiveRows.length>MAX_OBJECTS) throw new Error("backup object index exceeds its record limit");
    const objects: BackupObject[]=rows.map((row: {object_key:string;sha256:string;bytes:number})=>validateObject({key:row.object_key,sha256:row.sha256,bytes:Number(row.bytes)}));
    for (const archive of archiveRows) {
      const sha256=String(archive.object_key).split("/").at(-1)?.replace(/\.zip$/,"") ?? "";
      validateObject({key:archive.object_key,sha256,bytes:0});
      objects.push(validateObject({key:archive.object_key,sha256,bytes:(await client.file(archive.object_key).stat()).size}));
    }
    const counts=(await connection`select (select count(*) from hv_projects) as projects,(select count(*) from hv_jobs) as jobs,
      (select count(*) from hv_cost_events) as costs,(select coalesce(sum(total_usd),0) from hv_cost_events) as total`)[0];
    const summary={projects:Number(counts.projects),jobs:Number(counts.jobs),costEvents:Number(counts.costs),recordedCostUsd:Number(counts.total)};
    const dump=resolve(temporary,"state.dump");
    await pg("pg_dump",["--format=custom","--compress=6","--no-owner","--snapshot="+snapshot.id,"--file="+dump],url);
    chmodSync(dump,0o600);
    const descriptor=openSync(dump,"r");try {fsyncSync(descriptor);} finally {closeSync(descriptor);}
    for (const object of objects) await copyObject(object,root,client);
    const manifest: BackupManifest={schema:"hv-backup/1",id,source,snapshotAt:new Date(snapshot.at).toISOString(),completedAt:new Date().toISOString(),
      database:{file:"state.dump",...await digest(Bun.file(dump).stream())},objects,summary};
    privateJson(resolve(temporary,"backup.json"),manifest);
    const receipt=await digest(Bun.file(resolve(temporary,"backup.json")).stream());
    privateJson(resolve(temporary,"receipt.json"),{schema:"hv-backup-receipt/1",manifestSha256:receipt.sha256});
    // Fail before publishing if the snapshot or its deletion lock was lost.
    await connection`select 1`;
    await connection`COMMIT`;transaction=false;
    syncDirectory(temporary);renameSync(temporary,destination);syncDirectory(dirname(destination));
    const latest=resolve(root,"latest."+crypto.randomUUID()+".pending");
    privateJson(latest,{schema:"hv-backup-latest/1",id,snapshotAt:manifest.snapshotAt,completedAt:manifest.completedAt,manifestSha256:receipt.sha256});
    renameSync(latest,resolve(root,"latest.json"));syncDirectory(root);
    return manifest;
  } finally {
    if (transaction) await connection`ROLLBACK`.catch(()=>{});
    try {await connection`select pg_advisory_unlock_shared(91377,1),pg_advisory_unlock(91377,2)`.catch(()=>{});}
    finally {connection.release();await database.close();}
  }
}
export async function verifyStorageBackup(path: string, id?: string): Promise<{manifest: BackupManifest; root: string; directory: string}> {
  const root=realpathSync(path);
  for (const folder of ["blobs","snapshots"]) {
    const directory=resolve(root,folder);
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error("backup repository directory is unsafe");
  }
  if (!id) {const latest=resolve(root,"latest.json");regular(latest);if (statSync(latest).size>4096) throw new Error("invalid latest backup pointer");id=JSON.parse(readFileSync(latest,"utf8")).id;}
  if (typeof id!=="string" || !ID.test(id)) throw new Error("invalid backup snapshot identifier");
  const directory=resolve(root,"snapshots",id);
  if (lstatSync(directory).isSymbolicLink()) throw new Error("backup snapshot is a symbolic link");
  const file=resolve(directory,"backup.json"),receiptFile=resolve(directory,"receipt.json");regular(file);regular(receiptFile);
  if (statSync(file).size>256*1024**2 || statSync(receiptFile).size>4096) throw new Error("backup manifest is too large");
  const raw=readFileSync(file),receipt=JSON.parse(readFileSync(receiptFile,"utf8"));
  if (receipt.schema!=="hv-backup-receipt/1" || createHash("sha256").update(raw).digest("hex")!==receipt.manifestSha256) throw new Error("backup manifest checksum mismatch");
  const manifest=JSON.parse(raw.toString("utf8")) as BackupManifest;
  if (manifest.schema!=="hv-backup/1" || manifest.id!==id || manifest.database?.file!=="state.dump" || !SHA.test(manifest.database.sha256)
    || !Number.isSafeInteger(manifest.database.bytes) || manifest.database.bytes<0 || manifest.database.bytes>MAX_OBJECT_BYTES
    || !manifest.source || !/^\d+$/.test(manifest.source.cluster) || typeof manifest.source.database!=="string" || manifest.source.database.length>256
    || !Number.isFinite(Date.parse(manifest.snapshotAt)) || !Number.isFinite(Date.parse(manifest.completedAt))
    || !manifest.summary || [manifest.summary.projects,manifest.summary.jobs,manifest.summary.costEvents].some(value=>!Number.isSafeInteger(value)||value<0)
    || !Number.isFinite(manifest.summary.recordedCostUsd) || manifest.summary.recordedCostUsd<0
    || !Array.isArray(manifest.objects) || manifest.objects.length>MAX_OBJECTS) throw new Error("invalid backup manifest");
  if (new Set(manifest.objects.map(object=>object.key)).size!==manifest.objects.length) throw new Error("duplicate backup object keys");
  const dump=resolve(directory,"state.dump");regular(dump);
  if ((await digest(Bun.file(dump).stream(),manifest.database.bytes)).sha256!==manifest.database.sha256) throw new Error("backup database checksum mismatch");
  const verified=new Set<string>();
  for (const object of manifest.objects) {
    validateObject(object);const blob=resolve(root,"blobs",object.sha256);regular(blob);
    if (statSync(blob).size!==object.bytes) throw new Error("backup blob size mismatch");
    if (!verified.has(object.sha256) && (await digest(Bun.file(blob).stream(),object.bytes)).sha256!==object.sha256) throw new Error("backup media checksum mismatch");
    verified.add(object.sha256);
  }
  return {manifest,root,directory};
}
/** Operator-created backups only: pg_restore executes schema DDL. Never accept public uploads here. */
export async function restoreStorageBackup(database: StudioDatabase, url: string, path: string, id?: string): Promise<BackupManifest> {
  const {manifest,root,directory}=await verifyStorageBackup(path,id),client=objectClient();
  if ((await database.sql`select current_user as role`)[0].role!=="hv_admin") throw new Error("restore requires the migration role");
  const count=Number((await database.sql`select count(*) as count from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'`)[0].count);
  if (count!==0) throw new Error("backup restore requires an empty offline database");
  if ((await client.list({maxKeys:1})).contents?.length) throw new Error("backup restore requires a separate empty private bucket");
  for (const object of manifest.objects) {
    const target=client.file(object.key);
    await target.write(new Response(Bun.file(resolve(root,"blobs",object.sha256)).stream()),{type:"application/octet-stream",partSize:8*1024**2,queueSize:2,retry:2});
    if ((await digest(target.stream(),object.bytes)).sha256!==object.sha256) throw new Error("restored object checksum mismatch");
  }
  await pg("pg_restore",["--exit-on-error","--single-transaction","--no-owner","--dbname="+pgEnvironment(url).PGDATABASE,resolve(directory,"state.dump")],url);
  const countRow=(await database.sql`select (select count(*) from hv_projects) as projects,(select count(*) from hv_jobs) as jobs,
    (select count(*) from hv_cost_events) as costs,(select coalesce(sum(total_usd),0) from hv_cost_events) as total`)[0];
  if (Number(countRow.projects)!==manifest.summary.projects || Number(countRow.jobs)!==manifest.summary.jobs
    || Number(countRow.costs)!==manifest.summary.costEvents || Number(countRow.total)!==manifest.summary.recordedCostUsd) throw new Error("restored database summary mismatch");
  return manifest;
}
