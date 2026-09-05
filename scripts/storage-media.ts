import { parseArgs } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { StudioDatabase } from "../packages/storage/src/database";
import { PostgresArtifactStore } from "../packages/storage/src/artifacts";
import { PostgresJobStore } from "../packages/storage/src/jobs";
const {values} = parseArgs({args:process.argv.slice(2),options:{help:{type:"boolean"},source:{type:"string"},output:{type:"string"},
  import:{type:"boolean"},export:{type:"boolean"}},strict:true});
if (values.help) {
  console.log("Media import: --import --source ARTIFACT_ROOT\nVerified media export: --export --output NEW_CACHE_ROOT\nUses HV_PG_ADMIN_URL, database TLS and HV_S3_* configuration. Only drained jobs are eligible.");
  process.exit(0);
}
if (Boolean(values.import) === Boolean(values.export)) throw new Error("choose import or export; use --help");
const root = resolve(values.import ? values.source ?? "" : values.output ?? "");
if ((values.import && !values.source) || (values.export && !values.output)) throw new Error("specify the source or output directory");
if (values.export && existsSync(root)) throw new Error("media export requires a new cache directory");
const database = new StudioDatabase(process.env.HV_PG_ADMIN_URL ?? "");
try {
  const jobs = await new PostgresJobStore(database).all();
  if (jobs.some(job => ["queued","running"].includes(job.status))) throw new Error("drain all jobs before media migration");
  const artifacts = new PostgresArtifactStore(database,root);
  let count = 0, bytes = 0;
  const walk = (directory: string): string[] => readdirSync(directory,{withFileTypes:true}).flatMap(entry => {
    const path = resolve(directory,entry.name);
    if (entry.isSymbolicLink()) throw new Error("media migration refuses symbolic links");
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
  for (const job of jobs) {
    if (!job.output && !job.checkpointShots) continue;
    if (values.import) {
      const directory = resolve(root,job.projectId,job.id);
      if (!directory.startsWith(root+sep)) throw new Error("invalid job media directory");
      const files = walk(directory);
      const receipt = await artifacts.importCompletedJob(job,files);
      count += receipt.files; bytes += receipt.bytes;
      console.log(JSON.stringify({jobId:job.id,imported:true,...receipt}));
    } else {
      await artifacts.restoreCheckpoint(job);
      console.log(JSON.stringify({jobId:job.id,exported:true}));
    }
  }
  console.log(JSON.stringify({complete:true,jobs:jobs.filter(job=>job.output || job.checkpointShots).length,files:count,bytes}));
} finally { await database.close(); }
