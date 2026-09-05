import { parseArgs } from "node:util";
import { StudioDatabase } from "../packages/storage/src/database";
import { exportProjectArchive, importProjectArchive } from "../packages/storage/src/archives";
const {values} = parseArgs({args:process.argv.slice(2),options:{help:{type:"boolean"},export:{type:"boolean"},import:{type:"boolean"},
  project:{type:"string"},work:{type:"string"},output:{type:"string"},source:{type:"string"},publish:{type:"boolean"},"monthly-cap":{type:"string"}},strict:true});
if (values.help) {
  console.log("Export: --export --project ID --work NEW_DIRECTORY --output NEW_ARCHIVE [--publish]\nImport: --import --source ARCHIVE --work NEW_DIRECTORY [--monthly-cap USD]\nUses HV_PG_ADMIN_URL, database TLS and HV_S3_* configuration. Drain the selected project before export. Import into an offline, empty database and a separate private bucket. Start the destination app only after successful completion.");
  process.exit(0);
}
if (Boolean(values.export) === Boolean(values.import) || !values.work) throw new Error("choose import or export and a new work directory; use --help");
if ((values.export && (!values.project || !values.output)) || (values.import && !values.source)) throw new Error("missing archive source, output or project");
if (values.import && values.publish) throw new Error("publish is an export option");
const database = new StudioDatabase(process.env.HV_PG_ADMIN_URL ?? "");
try {
  await database.migrate();
  const result = values.export
    ? await exportProjectArchive(database,values.project!,values.work,values.output!,values.publish)
    : await importProjectArchive(database,values.source!,values.work,Number(values["monthly-cap"] ?? process.env.HV_MONTHLY_BUDGET_USD ?? 5000));
  console.log(JSON.stringify({complete:true,...result}));
} finally { await database.close(); }
