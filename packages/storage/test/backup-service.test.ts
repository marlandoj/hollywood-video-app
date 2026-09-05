import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runBackupCycle } from "../src/backup-service";
import type { BackupManifest } from "../src/backups";

test("backup service preserves the last success through an outage and distinguishes retention failure",async()=>{
  const root=mkdtempSync(resolve(tmpdir(),"hv-backup-service-"));
  const manifest: BackupManifest={schema:"hv-backup/1",id:"snapshot-one",source:{cluster:"123",database:"fixture"},snapshotAt:"2026-09-05T10:00:00.000Z",completedAt:"2026-09-05T10:00:01.000Z",
    database:{file:"state.dump",bytes:1,sha256:"a".repeat(64)},objects:[],summary:{projects:1,jobs:1,costEvents:1,recordedCostUsd:0.144}};
  let creates=0,prunes=0;
  const operations={create:async()=>{creates++;return manifest;},prune:async()=>{prunes++;return {snapshotsRemoved:0,blobsRemoved:0,bytesRemoved:0,snapshotsRetained:1};}};
  try {
    const first=await runBackupCycle("postgres://hv_admin:SECRET@localhost/fixture",root,operations);
    expect(first.state).toBe("healthy");expect(first.lastSnapshotId).toBe("snapshot-one");
    const outage=await runBackupCycle("unused",root,{...operations,create:async()=>{throw new Error("SECRET connection detail");}});
    expect(outage.state).toBe("failed");expect(outage.failureStage).toBe("backup");
    expect(outage.lastSnapshotAt).toBe(first.lastSnapshotAt);expect(outage.lastRecordedCostUsd).toBe(0.144);expect(prunes).toBe(1);
    const degraded=await runBackupCycle("unused",root,{...operations,prune:async()=>{throw new Error("retention failure");}});
    expect(degraded.state).toBe("degraded");expect(degraded.failureStage).toBe("retention");expect(degraded.lastSnapshotId).toBe("snapshot-one");
    expect(creates).toBe(2);
    const saved=readFileSync(resolve(root,"service-status.json"),"utf8");expect(saved).not.toContain("SECRET");expect(JSON.parse(saved)).toEqual(degraded);
    expect((await runBackupCycle("unused",root,operations)).state).toBe("healthy");
  } finally {rmSync(root,{recursive:true,force:true});}
});
