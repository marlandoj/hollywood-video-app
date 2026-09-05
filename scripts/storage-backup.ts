import { parseArgs } from "node:util";
import { StudioDatabase } from "../packages/storage/src/database";
import { createStorageBackup, restoreStorageBackup, verifyStorageBackup } from "../packages/storage/src/backups";
const {values}=parseArgs({args:process.argv.slice(2),options:{help:{type:"boolean"},create:{type:"boolean"},restore:{type:"boolean"},verify:{type:"boolean"},repository:{type:"string"},snapshot:{type:"string"}},strict:true});
if (values.help) {
  console.log("Create: --create --repository DIRECTORY\nVerify: --verify --repository DIRECTORY [--snapshot ID]\nRestore: --restore --repository DIRECTORY [--snapshot ID]\nUses HV_PG_ADMIN_URL, HV_DATABASE_TLS_DIR, HV_S3_*, optional HV_PG_BIN/HV_PG_LIB. Restores require an empty offline database and separate private bucket. Only trusted operator backups may be restored.");process.exit(0);
}
if (!values.repository || [values.create,values.restore,values.verify].filter(Boolean).length!==1) throw new Error("choose create, restore or verify and a repository; use --help");
if (values.verify) {
  const {manifest}=await verifyStorageBackup(values.repository,values.snapshot);
  console.log(JSON.stringify({verified:true,snapshot:manifest.id,snapshotAt:manifest.snapshotAt,objects:manifest.objects.length,...manifest.summary}));
} else {
  const url=process.env.HV_PG_ADMIN_URL ?? "",database=new StudioDatabase(url);
  try {
    const manifest=values.create?await createStorageBackup(url,values.repository):await restoreStorageBackup(database,url,values.repository,values.snapshot);
    console.log(JSON.stringify({complete:true,operation:values.create?"backup":"restore",snapshot:manifest.id,snapshotAt:manifest.snapshotAt,completedAt:manifest.completedAt,objects:manifest.objects.length,...manifest.summary}));
  } finally {await database.close();}
}
