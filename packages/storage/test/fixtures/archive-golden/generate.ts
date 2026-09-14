/** Golden archive generator for the HV-040-04 conformance suite (docs/PROJECT-ARCHIVE.md
 * "Conformance suite"). Not a test. Run once by the builder and again only on a real schema bump:
 *
 *   bun packages/storage/test/fixtures/archive-golden/generate.ts
 *
 * It rebuilds `source/` offline through ProjectService and DurableJobStore (one drained hv-state/1
 * animatic project: no review link, no token, no secret, `deleteAfter` far in the future, one
 * completed job with a checkpoint), writes the state files with writeStateSnapshot, an hv-clips/1
 * `clips/manifest.json`, small ASCII placeholder media, then packs the tree with
 * scripts/archive-package.py to produce the expected `archive.json` bytes and `receipt.json`.
 * The ZIP digest is deliberately not recorded: it depends on the interpreter's zipfile. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectService } from "../../../../api/src/index";
import { DurableJobStore } from "../../../../queue/src/index";
import { assertArchiveDocument, canonicalManifestBytes } from "../../../src/archive-schema";
import { writeStateSnapshot, type StateSnapshot } from "../../../src/snapshots";
import { createHash } from "node:crypto";

export const GOLDEN_DIRECTORY = import.meta.dir;
export const GOLDEN_SOURCE = resolve(GOLDEN_DIRECTORY,"source");
export const PACKAGE_SCRIPT = resolve(GOLDEN_DIRECTORY,"../../../../../scripts/archive-package.py");
const NOW = Date.parse("2026-09-14T12:00:00.000Z"), DELETE_AFTER = "2099-01-01T00:00:00.000Z";

export function goldenSnapshot(): {snapshot: StateSnapshot; projectId: string; jobId: string} {
  process.env.HV_TOKEN_SECRET ??= "archive-golden-generator-secret-with-at-least-thirty-two-characters";
  const projects = new ProjectService(), owner = projects.createAnonymousProject(NOW), script = "EXT. GARDEN - DAY\n\nLeaves turn.";
  projects.editScript(owner.token,script,NOW); projects.attestRights(owner.token,NOW);
  const jobs = DurableJobStore.fromJobs([]), id = crypto.randomUUID();
  jobs.enqueue({id,projectId:owner.projectId,idempotencyKey:"golden",tier:"free",stage:"animatic",scriptVersion:1,scriptText:script,rightsAttestedAt:new Date(NOW).toISOString(),animaticJobId:null,animaticApprovedAt:null,costCapUsd:1,totalFrames:30,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60_000});
  jobs.claimNext(NOW,{},{workerId:"golden"});
  jobs.checkpoint(id,"golden",1,30,NOW + 1000);
  const event = {at:new Date(NOW + 2000).toISOString(),projectId:owner.projectId,jobId:id,shotId:"shot-1",stage:"animatic" as const,provider:"mock",model:"mock-deterministic-v1",prompt_tokens:4,output_frames:30,gpu_seconds:0.5,total_cost_usd:0};
  jobs.recordCost(id,"golden",event,NOW + 2000);
  const root = owner.projectId + "/" + id + "/";
  jobs.complete(id,"golden",{mp4Path:root + "export.mp4",hlsPlaylistPath:root + "hls/index.m3u8",captionsPath:root + "captions.vtt",manifestPath:root + "provenance.json"},NOW + 3000);
  projects.recordAnimaticDecision(owner.projectId,id,1,"approved","",NOW + 4000);
  const state = projects.snapshot(); state.projects[0]!.deleteAfter = DELETE_AFTER;
  return {snapshot:{schema:"hv-state/1",projects:state,jobs:jobs.all(),ledger:{events:[event],reservations:[]},reviews:[]},projectId:owner.projectId,jobId:id};
}
export function goldenMedia(projectId: string, jobId: string): Record<string,Uint8Array> {
  const key = (name: string) => `${projectId}/${jobId}/${name}`, text = (body: string) => new TextEncoder().encode(body);
  const clip = text("placeholder clip bytes for the HV-040-04 golden archive; not a decodable video\n");
  const cost = {provider:"mock",model:"mock-deterministic-v1",prompt_tokens:4,output_frames:30,gpu_seconds:0.5,total_cost_usd:0};
  const manifest = assertArchiveDocument("hv-clips/1",{schema:"hv-clips/1",clips:[{path:key("clips/shot-1.mp4"),provider:"mock",model:"mock-deterministic-v1",seed:7,durationSec:1,fingerprint:createHash("sha256").update(clip).digest("hex"),cost}]});
  return {[key("export.mp4")]:text("placeholder export bytes for the HV-040-04 golden archive; not a decodable video\n"),
    [key("hls/index.m3u8")]:text("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1.0,\nexport.mp4\n#EXT-X-ENDLIST\n"),
    [key("captions.vtt")]:text("WEBVTT\n\n00:00.000 --> 00:01.000\nLeaves turn.\n"),
    [key("provenance.json")]:text(JSON.stringify({schema:"hv-provenance/1",placeholder:true},null,2) + "\n"),
    [key("clips/shot-1.mp4")]:clip,[key("clips/manifest.json")]:text(JSON.stringify(manifest))};
}
/** Write the source tree (state files through writeStateSnapshot, media under artifacts/). */
export function writeGoldenSource(directory: string): {projectId: string; jobId: string} {
  const {snapshot,projectId,jobId} = goldenSnapshot();
  writeStateSnapshot(directory,snapshot);
  for (const [key,bytes] of Object.entries(goldenMedia(projectId,jobId))) { const path = resolve(directory,"artifacts",key); mkdirSync(resolve(path,".."),{recursive:true}); writeFileSync(path,bytes,{mode:0o600}); }
  return {projectId,jobId};
}
export async function packWithPython(python: string, source: string, output: string, projectId: string): Promise<{projectId: string; files: number; bytes: number; archiveSha256: string; manifestSha256: string}> {
  const child = Bun.spawn([python,PACKAGE_SCRIPT,"pack","--source",source,"--output",output,"--project",projectId],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});
  const [status,stdout,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  if (status !== 0) throw new Error("golden pack failed: " + stderr.slice(-2000));
  return JSON.parse(stdout);
}
export async function readZipEntry(python: string, archive: string, name: string): Promise<Uint8Array> {
  const child = Bun.spawn([python,"-c","import sys,zipfile\nsys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))",archive,name],{stdout:"pipe",stderr:"pipe"});
  const [status,bytes,stderr] = await Promise.all([child.exited,new Response(child.stdout).bytes(),new Response(child.stderr).text()]);
  if (status !== 0) throw new Error("zip entry read failed: " + stderr.slice(-2000));
  return bytes;
}
if (import.meta.main) {
  const python = Bun.which("python3") ?? Bun.which("python"); if (!python) throw new Error("the golden generator needs python3 on PATH");
  rmSync(GOLDEN_SOURCE,{recursive:true,force:true});
  const {projectId} = writeGoldenSource(GOLDEN_SOURCE), scratch = mkdtempSync(join(tmpdir(),"hv-archive-golden-"));
  try {
    const output = join(scratch,"golden.hv.zip"), receipt = await packWithPython(python,GOLDEN_SOURCE,output,projectId), manifest = await readZipEntry(python,output,"archive.json");
    const digest = createHash("sha256").update(manifest).digest("hex");
    if (digest !== receipt.manifestSha256 || createHash("sha256").update(canonicalManifestBytes(JSON.parse(new TextDecoder().decode(manifest)))).digest("hex") !== digest) throw new Error("the golden manifest does not hash to the Python receipt");
    writeFileSync(resolve(GOLDEN_DIRECTORY,"archive.json"),manifest,{mode:0o644});
    writeFileSync(resolve(GOLDEN_DIRECTORY,"receipt.json"),JSON.stringify({projectId:receipt.projectId,files:receipt.files,bytes:receipt.bytes,manifestSha256:receipt.manifestSha256},null,2) + "\n",{mode:0o644});
    console.log(JSON.stringify({projectId,files:receipt.files,bytes:receipt.bytes,manifestSha256:receipt.manifestSha256}));
  } finally { rmSync(scratch,{recursive:true,force:true}); }
}
