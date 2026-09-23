/**
 * Carry a JSON crew ledger into the database, once (HV-030-11).
 *
 * The operator runs this after a deployment gains a database, naming the file it has been spending
 * through. It refuses a database whose crew ledger is not empty, because importing twice would
 * double the crew's budget line — so it is safe to run again after a failure and pointless to run
 * again after a success.
 *
 * It reads the file with the file ledger's own validator, so a ledger that ledger would refuse to
 * open is not carried across either.
 */
import {readFileSync} from "node:fs";
import {validateCrewLedger} from "../packages/operator/src/crew-ledger";
import {PostgresCrewLedger} from "../packages/storage/src/crew-ledger";
import {StudioDatabase} from "../packages/storage/src/database";

if (process.argv.includes("--help") || process.argv.length < 3) {
  process.stdout.write("HV_PG_ADMIN_URL=<private migration connection> bun scripts/crew-ledger-import.ts <crew-ledger.json>\n");
  process.exit(process.argv.includes("--help") ? 0 : 2);
}

const path = process.argv[2]!;
let state;
try { state = validateCrewLedger(JSON.parse(readFileSync(path, "utf8"))); }
catch (error) {
  process.stderr.write("This is not a crew ledger this studio can read: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
}

const database = new StudioDatabase(process.env.HV_PG_ADMIN_URL ?? "");
try {
  const carried = await new PostgresCrewLedger(database).importFrom(state);
  process.stdout.write(JSON.stringify({carried: "hv-crew-ledger/1", ...carried}) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
} finally { await database.close(); }
