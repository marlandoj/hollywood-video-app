import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { archiveSchemaDigest, ARCHIVE_SCHEMA_FILES, canonicalManifestBytes, loadArchiveSchema, validateDocument, type ArchiveSchemaName } from "../src/archive-schema";
import { readStateSnapshot, writeStateSnapshot } from "../src/snapshots";
import { PACKAGE_SCRIPT, packWithPython, readZipEntry } from "./fixtures/archive-golden/generate";
import { GOLDEN_SOURCE, goldenArchiveBytes, goldenDocument, goldenReceipt, mutate, rejectionRows } from "./fixtures/archive-golden/matrix";

// Criterion 5 of HV-040-04 (docs/PROJECT-ARCHIVE.md "Conformance suite"). Offline; it needs only a
// system python for scripts/archive-package.py and, like prepare-object-bucket.test.ts, skips rather
// than passes without one. The evidence file is written from observed values when
// HV_ARCHIVE_SCHEMA_EVIDENCE names a path.
const python = Bun.which("python3") ?? Bun.which("python");
const pytest = python ? test : test.skip;
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const STATE_FILES = ["state/projects.json","queue/jobs.json","state/cost-ledger.json","state/operator-review-queue.json","snapshot.json"];
const evidencePath = process.env.HV_ARCHIVE_SCHEMA_EVIDENCE;
const observed: Record<string,unknown> = {};
async function run(args: string[]): Promise<{status: number; stdout: string; stderr: string}> {
  const child = Bun.spawn([python!,...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});
  const [status,stdout,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  return {status,stdout,stderr};
}
function files(directory: string): string[] { return readdirSync(directory,{recursive:true,withFileTypes:true}).filter(entry => entry.isFile()).map(entry => relative(directory,join(entry.parentPath,entry.name)).replaceAll("\\","/")).sort(); }

test("the golden state files validate and writeStateSnapshot reproduces them byte for byte",() => {
  const snapshot = readStateSnapshot(GOLDEN_SOURCE), receipt = goldenReceipt();
  expect(snapshot.schema).toBe("hv-state/1"); expect(snapshot.projects.projects.map(project => project.id)).toEqual([receipt.projectId]);
  expect(snapshot.projects.reviewLinks).toEqual([]); expect(snapshot.jobs).toHaveLength(1); expect(snapshot.jobs[0]!.checkpointShots).toBe(1); expect(snapshot.jobs[0]!.status).toBe("done");
  expect(Date.parse(snapshot.projects.projects[0]!.deleteAfter)).toBeGreaterThan(Date.parse("2090-01-01T00:00:00Z"));
  const state = JSON.stringify(snapshot.projects) + JSON.stringify(snapshot.jobs); expect(state).not.toMatch(/"token"|secret|reviewLinks":\[\{/i);
  const root = mkdtempSync(join(tmpdir(),"hv-archive-golden-state-"));
  try {
    const rewritten = join(root,"rewritten"); writeStateSnapshot(rewritten,snapshot);
    expect(files(rewritten)).toEqual(STATE_FILES.slice().sort());
    for (const file of STATE_FILES) expect(readFileSync(join(rewritten,file))).toEqual(readFileSync(join(GOLDEN_SOURCE,file)));
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("the committed archive.json is the four-key canonical manifest whose bytes hash to the receipt",() => {
  const bytes = goldenArchiveBytes(), receipt = goldenReceipt(), manifest = JSON.parse(bytes.toString("utf8")) as Record<string,unknown>;
  expect(Object.keys(manifest).sort()).toEqual(["files","projectId","schema","totalBytes"]);
  expect(sha256(bytes)).toBe(receipt.manifestSha256); expect(sha256(canonicalManifestBytes(manifest))).toBe(receipt.manifestSha256);
  expect(Buffer.compare(canonicalManifestBytes(manifest),bytes)).toBe(0);
  expect(manifest.projectId).toBe(receipt.projectId); expect((manifest.files as unknown[]).length).toBe(receipt.files); expect(manifest.totalBytes).toBe(receipt.bytes);
  const text = bytes.toString("utf8");
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/); expect(text).not.toContain(hostname()); expect(text).not.toContain(GOLDEN_SOURCE); expect(text).not.toMatch(/"path":"\//); expect(text).not.toContain("\\\\");
  expect(text).toMatch(/^[\x20-\x7e]+$/); // ASCII by construction, no whitespace outside strings
  expect(validateDocument(loadArchiveSchema("hv-project-archive/1"),manifest)).toEqual({ok:true});
  const listed = (manifest.files as {path: string; bytes: number; sha256: string}[]);
  expect(listed.map(file => file.path)).toEqual(files(GOLDEN_SOURCE));
  for (const file of listed) { const data = readFileSync(join(GOLDEN_SOURCE,file.path)); expect(data.byteLength).toBe(file.bytes); expect(sha256(data)).toBe(file.sha256); }
  expect(listed.reduce((total,file) => total + file.bytes,0)).toBe(receipt.bytes);
  const total = files(GOLDEN_SOURCE).reduce((sum,file) => sum + statSync(join(GOLDEN_SOURCE,file)).size,0) + bytes.byteLength + readFileSync(resolve(GOLDEN_SOURCE,"../receipt.json")).byteLength;
  expect(total).toBeLessThan(64 * 1024);
  observed.manifest = {projectId:receipt.projectId,files:receipt.files,bytes:receipt.bytes,manifestSha256:receipt.manifestSha256};
});

pytest("Python pack of the golden reproduces the committed manifest, survives unpack and re-pack, and packs deterministically",async () => {
  const receipt = goldenReceipt(), root = mkdtempSync(join(tmpdir(),"hv-archive-golden-pack-"));
  try {
    const first = join(root,"first.hv.zip"), packed = await packWithPython(python!,GOLDEN_SOURCE,first,receipt.projectId);
    expect({projectId:packed.projectId,files:packed.files,bytes:packed.bytes,manifestSha256:packed.manifestSha256}).toEqual(receipt);
    const manifest = await readZipEntry(python!,first,"archive.json");
    expect(Buffer.compare(Buffer.from(manifest),goldenArchiveBytes())).toBe(0); expect(sha256(manifest)).toBe(receipt.manifestSha256);
    const firstDigest = sha256(readFileSync(first)); expect(firstDigest).toBe(packed.archiveSha256);
    const extracted = join(root,"extracted"), unpack = await run([PACKAGE_SCRIPT,"unpack","--source",first,"--output",extracted]);
    expect(unpack.stderr).toBe(""); expect(unpack.status).toBe(0); expect(JSON.parse(unpack.stdout)).toEqual({projectId:receipt.projectId,files:receipt.files,bytes:receipt.bytes,archiveSha256:firstDigest});
    for (const file of files(GOLDEN_SOURCE)) expect(readFileSync(join(extracted,file))).toEqual(readFileSync(join(GOLDEN_SOURCE,file)));
    expect(files(extracted)).toEqual(files(GOLDEN_SOURCE));
    const second = join(root,"second.hv.zip"), repacked = await packWithPython(python!,extracted,second,receipt.projectId);
    expect(repacked.manifestSha256).toBe(receipt.manifestSha256); expect(Buffer.compare(Buffer.from(await readZipEntry(python!,second,"archive.json")),goldenArchiveBytes())).toBe(0);
    const secondDigest = sha256(readFileSync(second)); expect(secondDigest).toBe(firstDigest); expect(repacked.archiveSha256).toBe(firstDigest);
    const third = join(root,"third.hv.zip"); await packWithPython(python!,GOLDEN_SOURCE,third,receipt.projectId); expect(Buffer.compare(readFileSync(third),readFileSync(first))).toBe(0);
    observed.pack = {manifestByteIdentical:true,repackByteIdentical:true,containerDeterministic:true,archiveSha256:firstDigest};
  } finally { rmSync(root,{recursive:true,force:true}); }
},120_000);

test("every rejection row is refused by the TypeScript validator at the shared pointer",() => {
  const rejections: string[] = [];
  for (const row of rejectionRows()) {
    const result = validateDocument(loadArchiveSchema(row.document),mutate(goldenDocument(row.document),row));
    expect([row.name,result.ok ? "accepted" : result.pointer]).toEqual([row.name,row.expect]);
    rejections.push(row.expect);
  }
  observed.rejections = rejections;
});

pytest("the evidence file records the observed golden, matrix and toolchain values",async () => {
  if (!evidencePath) return;
  const version = await run(["-c","import platform;print(platform.python_version())"]); expect(version.status).toBe(0);
  const pack = observed.pack as Record<string,unknown> | undefined, manifest = observed.manifest as Record<string,unknown> | undefined, rejections = observed.rejections as string[] | undefined;
  if (!pack || !manifest || !rejections) throw new Error("the evidence run needs the pack, manifest and matrix tests to have passed first");
  const evidence = {schema:"hv-archive-schema-conformance/1",status:"recorded",
    schemas:(Object.keys(ARCHIVE_SCHEMA_FILES) as ArchiveSchemaName[]).map(archiveSchemaDigest),
    golden:{...manifest,...pack},rejections,pythonVersion:version.stdout.trim(),bunVersion:Bun.version,
    publishedTo:"in-repo only; internet publication deferred to HV-033 (gate G7)",newProviderSpendUsd:0,recordedAt:new Date().toISOString()};
  const target = resolve(evidencePath); mkdirSync(dirname(target),{recursive:true}); writeFileSync(target,JSON.stringify(evidence,null,2) + "\n");
  expect(existsSync(target)).toBe(true);
});
