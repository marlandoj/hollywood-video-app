import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pruneStorageBackups, verifyStorageBackup } from "../src/backups";

const now=Date.UTC(2026,8,5,12,30),sha=(text:string)=>createHash("sha256").update(text).digest("hex");
function fixture() {
  const root=mkdtempSync(resolve(tmpdir(),"hv-backup-prune-"));
  mkdirSync(resolve(root,"blobs"));mkdirSync(resolve(root,"snapshots"));return root;
}
function snapshot(root:string,id:string,at:number,contents:string[],latest=false) {
  const directory=resolve(root,"snapshots",id);mkdirSync(directory);
  writeFileSync(resolve(directory,"state.dump"),"dump-"+id);
  const objects=contents.map(text=>{
    const path=resolve(root,"blobs",sha(text));writeFileSync(path,text);utimesSync(path,(now-2*864e5)/1000,(now-2*864e5)/1000);
    return {key:`v1/project/job/${sha(text)}/media.bin`,sha256:sha(text),bytes:text.length};
  });
  const manifest={schema:"hv-backup/1",id,source:{cluster:"123",database:"fixture"},snapshotAt:new Date(at).toISOString(),completedAt:new Date(at).toISOString(),
    database:{file:"state.dump",bytes:("dump-"+id).length,sha256:sha("dump-"+id)},objects,summary:{projects:1,jobs:1,costEvents:0,recordedCostUsd:0}};
  writeFileSync(resolve(directory,"backup.json"),JSON.stringify(manifest));
  writeFileSync(resolve(directory,"receipt.json"),JSON.stringify({schema:"hv-backup-receipt/1",manifestSha256:sha(JSON.stringify(manifest))}));
  if (latest) writeFileSync(resolve(root,"latest.json"),JSON.stringify({id}));
}
test("pruning keeps recent recovery points and shared blobs while collecting only unreferenced old data",async()=>{
  const root=fixture();
  try {
    snapshot(root,"latest",now-600e3,["A"],true);
    snapshot(root,"hour-new",Date.UTC(2026,8,5,10,20),["A","B"]);
    snapshot(root,"hour-old",Date.UTC(2026,8,5,10,10),["B","C"]);
    snapshot(root,"expired",now-8*864e5,["D"]);
    const fresh=resolve(root,"blobs",sha("E"));writeFileSync(fresh,"E");utimesSync(fresh,now/1000,now/1000);
    expect(await pruneStorageBackups(root,now)).toEqual({snapshotsRemoved:2,blobsRemoved:2,bytesRemoved:2,snapshotsRetained:2});
    for (const text of ["A","B","E"]) expect(existsSync(resolve(root,"blobs",sha(text)))).toBe(true);
    for (const text of ["C","D"]) expect(existsSync(resolve(root,"blobs",sha(text)))).toBe(false);
    expect((await verifyStorageBackup(root,"hour-new")).manifest.objects.length).toBe(2);
    expect((await verifyStorageBackup(root)).manifest.id).toBe("latest");
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("pruning preserves the latest recovery point even when stale and aborts before deletion on corruption",async()=>{
  const root=fixture();
  try {
    snapshot(root,"latest",now-20*864e5,["A"],true);
    snapshot(root,"older",now-21*864e5,["B"]);
    writeFileSync(resolve(root,"snapshots/latest/state.dump"),"corrupt");
    await expect(pruneStorageBackups(root,now)).rejects.toThrow("size mismatch");
    expect(existsSync(resolve(root,"snapshots/older"))).toBe(true);
    expect(existsSync(resolve(root,"blobs",sha("B")))).toBe(true);
    writeFileSync(resolve(root,"snapshots/latest/state.dump"),"dump-latest");
    expect((await pruneStorageBackups(root,now)).snapshotsRetained).toBe(1);
    expect((await verifyStorageBackup(root)).manifest.id).toBe("latest");
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("a shared repository reader blocks pruning but allows concurrent verification",async()=>{
  const root=fixture();snapshot(root,"latest",now,["A"],true);snapshot(root,"expired",now-8*864e5,["B"]);
  const child=Bun.spawn(["python3",resolve(import.meta.dir,"../../../scripts/backup-lock.py"),"--root",root,"--shared"],{stdin:"pipe",stdout:"pipe",stderr:"inherit"});
  const reader=child.stdout.getReader();
  try {
    const acknowledgement=await reader.read();expect(new TextDecoder().decode(acknowledgement.value)).toBe("locked\n");
    expect((await verifyStorageBackup(root)).manifest.id).toBe("latest");
    child.kill("SIGTERM");await Bun.sleep(50);expect(child.exitCode).toBeNull();
    let completed=false;
    const prune=pruneStorageBackups(root,now).then(result=>{completed=true;return result;});
    await Bun.sleep(250);
    expect(completed).toBe(false);expect(existsSync(resolve(root,"snapshots/expired"))).toBe(true);
    await child.stdin.end();await child.exited;
    expect((await prune).snapshotsRemoved).toBe(1);
  } finally {reader.releaseLock();await child.stdin.end();await child.exited;rmSync(root,{recursive:true,force:true});}
},10_000);
