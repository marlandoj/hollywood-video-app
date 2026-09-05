import { StudioDatabase } from "../packages/storage/src/database";
if (process.argv.includes("--help")) {
  process.stdout.write("HV_PG_ADMIN_URL=<private migration connection> bun scripts/migrate-storage.ts\n");
  process.exit(0);
}
const database = new StudioDatabase(process.env.HV_PG_ADMIN_URL ?? "");
try { await database.migrate(); process.stdout.write("Storage migrations applied.\n"); }
finally { await database.close(); }
