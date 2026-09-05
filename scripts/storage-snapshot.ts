import { parseArgs } from "node:util";
import { StudioDatabase } from "../packages/storage/src/database";
import { exportStateSnapshot, importStateSnapshot, readStateSnapshot, snapshotSummary, writeStateSnapshot } from "../packages/storage/src/snapshots";
const {values} = parseArgs({args:process.argv.slice(2),options:{
  help:{type:"boolean"},source:{type:"string"},output:{type:"string"},import:{type:"boolean"},export:{type:"boolean"},
  "monthly-cap":{type:"string"}},strict:true});
if (values.help) {
  console.log("State migration: --source DIRECTORY --import [--monthly-cap USD]\nRollback snapshot: --export --output NEW_DIRECTORY\nRead-only validation: --source DIRECTORY\nDatabase access uses HV_PG_ADMIN_URL and optional HV_DATABASE_TLS_DIR. Sources must be drained; imports require an empty database.");
  process.exit(0);
}
if (values.import && values.export) throw new Error("choose import or export");
if (values.source) {
  const snapshot = readStateSnapshot(values.source);
  if (!values.import) { console.log(JSON.stringify({validated:true,...snapshotSummary(snapshot)})); process.exit(0); }
  const database = new StudioDatabase(process.env.HV_PG_ADMIN_URL ?? "");
  try { await database.migrate(); console.log(JSON.stringify({imported:true,...await importStateSnapshot(database,snapshot,Number(values["monthly-cap"] ?? process.env.HV_MONTHLY_BUDGET_USD ?? 5000))})); }
  finally { await database.close(); }
} else if (values.export && values.output) {
  const database = new StudioDatabase(process.env.HV_PG_ADMIN_URL ?? "");
  try {
    const snapshot = await exportStateSnapshot(database);
    console.log(JSON.stringify({...writeStateSnapshot(values.output,snapshot),...snapshotSummary(snapshot)}));
  } finally { await database.close(); }
} else throw new Error("use --help for snapshot migration commands");
