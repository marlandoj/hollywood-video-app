import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createStorageBackup, pruneStorageBackups } from "./backups";

export interface BackupServiceStatus {
  schema: "hv-backup-service/1"; state: "running" | "healthy" | "degraded" | "failed";
  startedAt: string; finishedAt?: string; durationMs?: number;
  lastSnapshotId?: string; lastSnapshotAt?: string; lastCompletedAt?: string;
  lastRecordedCostUsd?: number; objects?: number;
  failureStage?: "backup" | "retention";
  retention?: Awaited<ReturnType<typeof pruneStorageBackups>>;
  localRepositoryOnly: true;
}
interface Operations {create: typeof createStorageBackup;prune: typeof pruneStorageBackups}
function previousStatus(root: string): Partial<BackupServiceStatus> {
  const file=resolve(root,"service-status.json");
  if (!existsSync(file)) return {};
  const metadata=lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size>8192) throw new Error("unsafe backup status file");
  try {
    const value=JSON.parse(readFileSync(file,"utf8")) as BackupServiceStatus;
    if (value.schema!=="hv-backup-service/1") return {};
    return {lastSnapshotId:value.lastSnapshotId,lastSnapshotAt:value.lastSnapshotAt,lastCompletedAt:value.lastCompletedAt,
      lastRecordedCostUsd:value.lastRecordedCostUsd,objects:value.objects};
  } catch {return {};}
}
function publish(root: string, status: BackupServiceStatus): void {
  const temporary=resolve(root,"service-status."+crypto.randomUUID()+".pending"),descriptor=openSync(temporary,"wx",0o600);
  try {writeFileSync(descriptor,JSON.stringify(status,null,2)+"\n");fsyncSync(descriptor);} finally {closeSync(descriptor);}
  renameSync(temporary,resolve(root,"service-status.json"));
  const directory=openSync(root,"r");try {fsyncSync(directory);} finally {closeSync(directory);}
}
/** Failure preserves the previous successful snapshot time and recorded accounting. */
export async function runBackupCycle(url: string,path: string,operations: Operations={create:createStorageBackup,prune:pruneStorageBackups}): Promise<BackupServiceStatus> {
  mkdirSync(path,{recursive:true,mode:0o700});const root=realpathSync(path),started=Date.now();
  const status: BackupServiceStatus={...previousStatus(root),schema:"hv-backup-service/1",state:"running",startedAt:new Date(started).toISOString(),localRepositoryOnly:true};
  publish(root,status);
  try {
    const manifest=await operations.create(url,root);
    Object.assign(status,{state:"healthy",lastSnapshotId:manifest.id,lastSnapshotAt:manifest.snapshotAt,lastCompletedAt:manifest.completedAt,
      lastRecordedCostUsd:manifest.summary.recordedCostUsd,objects:manifest.objects.length});
    try {status.retention=await operations.prune(root);}
    catch {status.state="degraded";status.failureStage="retention";}
  } catch {status.state="failed";status.failureStage="backup";}
  status.finishedAt=new Date().toISOString();status.durationMs=Date.now()-started;
  publish(root,status);return status;
}
