import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VideoClip } from "../../generator/src/index";
import { artifactKey, objectClient, PostgresArtifactStore } from "./artifacts";
import { StudioDatabase } from "./database";
import { exportStateSnapshot, importStateSnapshot, readStateSnapshot, snapshotSummary, writeStateSnapshot } from "./snapshots";

interface ArchiveReceipt {projectId: string; files: number; bytes: number; archiveSha256: string; manifestSha256?: string}
async function packageArchive(args: string[]): Promise<ArchiveReceipt> {
  const child = Bun.spawn(["python3",fileURLToPath(new URL("../../../scripts/archive-package.py",import.meta.url)),...args],
    {stdout:"pipe",stderr:"pipe"});
  const [output,error,status] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if (status !== 0) throw new Error("archive verification failed: " + error.slice(-4000));
  return JSON.parse(output) as ArchiveReceipt;
}
function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry => {
    const path = resolve(directory,entry.name);
    if (entry.isSymbolicLink()) throw new Error("archive refuses symbolic links");
    if (entry.isDirectory()) return files(path);
    if (!entry.isFile()) throw new Error("archive requires regular files");
    return [path];
  });
}
export async function exportProjectArchive(database: StudioDatabase, projectId: string, prepared: string, output: string, publish = false) {
  if (existsSync(prepared) || existsSync(output)) throw new Error("archive export requires new preparation and output paths");
  const snapshot = await exportStateSnapshot(database,projectId);
  if (snapshot.projects.projects.length !== 1 || snapshot.projects.takenDown.length
    || Date.parse(snapshot.projects.projects[0]!.deleteAfter) <= Date.now()) throw new Error("archive requires an active project");
  writeStateSnapshot(prepared,snapshot);
  const root = resolve(prepared,"artifacts"), artifacts = new PostgresArtifactStore(database,root);
  for (const job of snapshot.jobs) {
    await artifacts.restoreCheckpoint(job);
    if (job.checkpointShots) {
      const path = resolve(root,job.projectId,job.id,"clips/manifest.json");
      const clips = JSON.parse(readFileSync(path,"utf8")) as VideoClip[];
      const relative = (path: string) => artifactKey(path.slice(root.length+1),job.projectId,job.id);
      writeFileSync(path,JSON.stringify({schema:"hv-clips/1",clips:clips.map(clip => ({...clip,path:relative(clip.path),
        posterPath:clip.posterPath ? relative(clip.posterPath) : undefined}))}),{mode:0o600});
    }
  }
  const receipt = await packageArchive(["pack","--source",resolve(prepared),"--output",resolve(output),"--project",projectId]);
  let archiveId: string | undefined;
  if (publish) {
    archiveId = crypto.randomUUID();
    const key = `archives/${projectId}/${archiveId}/${receipt.archiveSha256}.zip`;
    const object = objectClient().file(key);
    await object.write(new Response(Bun.file(output).stream()),{type:"application/zip",partSize:8*1024**2,queueSize:2,retry:2});
    const hash = createHash("sha256");
    for await (const chunk of object.stream()) hash.update(chunk);
    if (hash.digest("hex") !== receipt.archiveSha256) throw new Error("stored project archive failed checksum verification");
    await database.forProject(projectId,async tx => {
      const project = (await tx`select id from hv_projects where id = ${projectId} and taken_down_at is null and delete_after > now() for update`)[0];
      if (!project) throw new Error("project expired or was removed during archive creation");
      await tx`insert into hv_archives (id,project_id,schema_version,manifest_sha256,object_key)
        values (${archiveId!},${projectId},'hv-project-archive/1',${receipt.manifestSha256!},${key})`;
    });
  }
  return {...receipt,...snapshotSummary(snapshot),archiveId};
}
/** The destination must be an offline, empty database with its own private bucket. */
export async function importProjectArchive(database: StudioDatabase, source: string, extracted: string, monthlyCapUsd: number) {
  const client = objectClient();
  if ((await client.list({maxKeys:1})).contents?.length) throw new Error("archive import requires a separate empty bucket");
  const receipt = await packageArchive(["unpack","--source",resolve(source),"--output",resolve(extracted)]);
  const snapshot = readStateSnapshot(extracted);
  if (snapshot.projects.projects.length !== 1 || snapshot.projects.projects[0]!.id !== receipt.projectId)
    throw new Error("archive project identity mismatch");
  await importStateSnapshot(database,snapshot,monthlyCapUsd);
  const root = resolve(extracted,"artifacts"), artifacts = new PostgresArtifactStore(database,root);
  let mediaFiles = 0, mediaBytes = 0;
  for (const job of snapshot.jobs) {
    const paths = files(resolve(root,job.projectId,job.id));
    if (!paths.length && !job.output && !job.checkpointShots) continue;
    const imported = await artifacts.importCompletedJob(job,paths);
    mediaFiles += imported.files; mediaBytes += imported.bytes;
  }
  return {...receipt,...snapshotSummary(snapshot),mediaFiles,mediaBytes};
}
