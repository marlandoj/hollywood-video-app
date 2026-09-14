import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyStorageBackup } from "../src/backups";
import { referenceObjectKey } from "../../planner/src/references";

// The CI workflow names every Python test file literally and is frozen, so `test_offhost_backup.py`
// would never be discovered by an existing step and a new step is gate G4. The suite is registered
// with the `bun test packages test` run here instead, exactly as prepare-object-bucket.test.ts does.
const checkout=resolve(import.meta.dir,"../../..");
const scripts=resolve(checkout,"scripts");
const python=Bun.which("python3");
const pytest=python?test:test.skip;
const temporaries: string[]=[];
function temporary(prefix: string): string {const path=mkdtempSync(join(tmpdir(),prefix));temporaries.push(path);return path;}
afterAll(()=>{for (const path of temporaries) rmSync(path,{recursive:true,force:true});});

function git(...args: string[]): string {
  const result=Bun.spawnSync(["git",...args],{cwd:checkout,stdout:"pipe",stderr:"pipe"});
  return result.stdout.toString();
}
function runDrill(extra: string[]=[], environment: Record<string,string>={}): {record: any; raw: string; exitCode: number|null} {
  const result=Bun.spawnSync([python!,resolve(scripts,"offhost-drill.py"),...extra],
    {cwd:checkout,env:{...process.env,...environment},stdout:"pipe",stderr:"pipe"});
  const raw=result.stdout.toString();
  if (result.exitCode!==0) throw new Error("offhost-drill.py failed: "+result.stderr.toString().slice(-2000));
  return {record:JSON.parse(raw),raw,exitCode:result.exitCode};
}

pytest("the off-host transport's Python suite passes", () => {
  const result=Bun.spawnSync([python!,"-m","unittest","discover","-s",scripts,"-p","test_offhost_backup.py"],{stdout:"pipe",stderr:"pipe"});
  const output=result.stdout.toString()+result.stderr.toString();
  expect(output).toContain("OK");
  expect(result.exitCode).toBe(0);
}, 180_000);

pytest("the drill packages, reconstructs and re-verifies a repository and measures the packaging lag", async () => {
  const before=git("status","--porcelain");
  const output=join(temporary("hv-offhost-drill-out-"),"drill.json");
  const extracted=join(temporary("hv-offhost-drill-tree-"),"restored");
  const {record}=runDrill(["--output",output,"--keep-extracted",extracted]);

  // The reconstruction leg: the drill already compared snapshot_header(extracted) with the source's
  // field for field and re-digested every blob, and refuses to exit 0 if either differs.
  expect(record.schema).toBe("hv-offhost-drill/1");
  expect(record.reconstruction.headerIdentical).toBe(true);
  expect(record.reconstruction.blobsReVerified).toBe(record.repository.blobs);
  expect(record.negatives.existingDirectoryRefused).toBe(true);
  expect(record.negatives.bitFlipRefused).toBe(true);

  // Deduplication: four object keys, three blobs, the two rendered-shot keys sharing one address.
  expect(record.repository.objects).toBe(4);
  expect(record.repository.blobs).toBe(3);
  expect(record.repository.deduplicatedKeys).toBe(1);
  expect(record.transport.files).toBe(5+record.repository.blobs);

  // The lag is a finite, non-negative number of milliseconds and is exactly the recorded difference.
  expect(Number.isFinite(record.rpo.snapshotToCopyMs)).toBe(true);
  expect(record.rpo.snapshotToCopyMs).toBeGreaterThanOrEqual(0);
  expect(record.rpo.snapshotToCopyMs).toBe(Date.parse(record.rpo.copyDurableAt)-Date.parse(record.rpo.snapshotAt));
  expect(record.rpo.measuredOn).toContain("not a PostgreSQL transaction_timestamp()");

  // The "restore" leg that needs neither PostgreSQL nor S3: main's own verifier, under the shared
  // backup-lock.py hold, against the tree the transport reconstructed.
  const {manifest}=await verifyStorageBackup(extracted);
  expect(manifest.schema).toBe("hv-backup/1");
  expect(manifest.objects.length).toBe(record.repository.objects);
  expect(manifest.snapshotAt).toBe(record.rpo.snapshotAt);
  expect(new Set(manifest.objects.map(object=>object.sha256)).size).toBe(record.repository.blobs);

  // Every key shape backups.ts can index today survives the round trip, including the reference
  // asset key that arrived after the transport branch was cut.
  const keys=manifest.objects.map(object=>object.key);
  expect(keys.some(key=>/^v1\/[A-Za-z0-9_-]+\/reference-[0-9a-f-]{36}\/[a-f0-9]{64}\/reference\.png$/.test(key))).toBe(true);
  expect(keys.some(key=>/^archives\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.zip$/.test(key))).toBe(true);
  expect(referenceObjectKey({schema:"hv-reference/1",id:"6f1d2c8a-9b4e-4f07-8a31-0c5d7e2b9a44",projectId:"drillproject",
    sha256:"a".repeat(64),originalSha256:"b".repeat(64),bytes:4096,width:512,height:512,contentType:"image/png",
    createdAt:"2026-09-06T00:00:00.000Z",attestedAt:"2026-09-06T00:00:00.000Z"}))
    .toBe("v1/drillproject/reference-6f1d2c8a-9b4e-4f07-8a31-0c5d7e2b9a44/"+"a".repeat(64)+"/reference.png");

  // The drill writes only into its temporary root and the paths the caller named.
  expect(git("status","--porcelain")).toBe(before);
  expect(readFileSync(output,"utf8").length).toBeGreaterThan(0);
}, 300_000);

pytest("an unavailable age runtime skips the encrypt legs instead of failing the drill", () => {
  const empty=temporary("hv-offhost-no-age-");
  const {record}=runDrill([],{HV_ENCRYPTION_RUNTIME:empty});
  expect(record.encryption.exercised).toBe(false);
  expect(typeof record.encryption.reason).toBe("string");
  expect(record.encryption.reason.length).toBeGreaterThan(0);
  expect(record.rpo.encrypted).toBe(false);
  // Everything that does not need age still runs.
  expect(record.reconstruction.headerIdentical).toBe(true);
  expect(record.reconstruction.blobsReVerified).toBe(3);
  expect(record.negatives.bitFlipRefused).toBe(true);
  expect(record.negatives.wrongIdentityRefused).toBe(null);
  expect(record.rpo.snapshotToCopyMs).toBeGreaterThanOrEqual(0);
}, 300_000);

// The age binary is not on the ubuntu-24.04 runner image and adding an apt step is gate G4, so the
// runtime is fetched by the same checksum-pinned installer pattern as install-observability-runtime.py.
// A failed install (no network, GitHub unavailable, non-amd64) must skip, never redden the job.
let runtime: string|null=null,installReason="python3 is unavailable";
if (python) {
  const root=process.env.HV_ENCRYPTION_RUNTIME || temporary("hv-offhost-age-");
  const install=Bun.spawnSync([python,resolve(scripts,"install-backup-encryption.py"),"--root",root],{stdout:"pipe",stderr:"pipe",timeout:180_000});
  if (install.exitCode===0) runtime=root;
  else installReason=(install.stderr.toString()||"the pinned age release could not be installed").slice(-300);
}
const agetest=runtime?test:test.skip;
agetest("with age available the drill encrypts, decrypts and refuses a wrong identity or a flipped bit", () => {
  const {record}=runDrill([],{HV_ENCRYPTION_RUNTIME:runtime!});
  expect(record.encryption.exercised).toBe(true);
  expect(record.encryption.tool).toBe("age");
  expect(record.encryption.version).toBe("1.3.2");
  expect(record.encryption.recipientCommitted).toBe(false);
  expect(record.encryption.identity).toContain("destroyed in-process");
  expect(record.rpo.encrypted).toBe(true);
  expect(record.negatives.wrongIdentityRefused).toBe(true);
  expect(record.negatives.bitFlipRefused).toBe(true);
  expect(record.negatives.bitFlipRefusedBy).toContain("age");
  expect(record.transport.ciphertextBytes).toBeGreaterThan(record.transport.payloadBytes);
}, 300_000);
if (!runtime) console.log(JSON.stringify({event:"offhost.encryption.skipped",reason:installReason}));

pytest("a drill record never carries a credential, a recipient or a path outside its temporary root", () => {
  const {raw}=runDrill();
  for (const pattern of [/postgres:\/\//,/AKIA/,/age1[ac-hj-np-z02-9]{58}/,/BEGIN [A-Z ]*PRIVATE KEY/,/AGE-SECRET-KEY-/]) expect(raw).not.toMatch(pattern);
  // No absolute filesystem path at all, so no temporary root, runtime root or identity file leaks.
  for (const value of JSON.stringify(JSON.parse(raw)).match(/"[^"]*"/g) ?? []) expect(value).not.toMatch(/(^"|[ (])\/[A-Za-z0-9_.-]+\//);
  expect(raw).not.toMatch(/\/[a-f0-9]{64}(?![a-f0-9])/);
}, 300_000);

test("the committed drill evidence states its arithmetic and the limits of what it proves", () => {
  const record=JSON.parse(readFileSync(resolve(checkout,"docs/evidence/hv038-observability/offhost-drill.json"),"utf8"));
  expect(record.schema).toBe("hv-offhost-drill/1");
  expect(Number.isFinite(Date.parse(record.recordedAt))).toBe(true);
  expect(record.transport.schema).toBe("hv-offhost-bundle/1");
  expect([record.transport.files,record.transport.payloadBytes,record.transport.ciphertextBytes].every(Number.isSafeInteger)).toBe(true);
  for (const field of [record.transport.headerSha256,record.transport.manifestSha256]) expect(field).toMatch(/^[a-f0-9]{64}$/);
  expect(record.repository.deduplicatedKeys).toBe(record.repository.objects-record.repository.blobs);
  expect(record.reconstruction.headerIdentical).toBe(true);
  expect(record.reconstruction.verifyStorageBackup).toBe("passed");
  expect(record.rpo.snapshotToCopyMs).toBe(Date.parse(record.rpo.copyDurableAt)-Date.parse(record.rpo.snapshotAt));
  expect(record.rpo.snapshotToCopyMs).toBeGreaterThanOrEqual(0);
  expect(record.rpo.definition).toContain("fsync");
  expect(record.rpo.measuredOn).toContain("synthetic fixture repository");
  // The honesty fields. None of them may drift to true without a real destination and a real restore.
  expect(record.provesOffHostRpo).toBe(false);
  expect(record.provesHostLossRecovery).toBe(false);
  expect(record.continuousReplication).toBe(false);
  expect(record.restoredIntoLiveDatabase).toBe(false);
  expect(record.operatorIdentityUsed).toBe(false);
  expect(record.independentDestination).toBe("none (same filesystem, temp directory)");
  expect(record.newProviderSpendUsd).toBe(0);
});

test("the 2026-09-05 desktop copy evidence is preserved as a past recording, not a live claim", () => {
  const record=JSON.parse(readFileSync(resolve(checkout,"docs/evidence/hv038-observability/offhost-copy-20260906.json"),"utf8"));
  expect(record.schema).toBe("hv-offhost-copy-evidence/1");
  expect(record.independentlyRestored).toBe(false);
  expect(record.continuousReplication).toBe(false);
  expect(record.privateKeyTransferred).toBe(false);
});
