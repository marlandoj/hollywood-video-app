/**
 * HV-031-12 (G4, G15): list projects the retention sweeper recorded as taken down when their
 * retention had only ended. Read-only: it changes nothing. Correcting these rows is a separate,
 * operator-approved step, because it rewrites the record.
 *
 *   HV_WORKER_DATABASE_URL=... bun scripts/report-expiry-takedowns.ts
 */
import { StudioDatabase } from "../packages/storage/src/database";
import { findSweeperStampedTakedowns } from "../packages/storage/src/retention";

if (import.meta.main) {
  const database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL ?? "");
  try {
    const rows = await findSweeperStampedTakedowns(database);
    console.log(JSON.stringify({ rule: "takedown_reason = 'content removed' and purged_at = taken_down_at and expired_at is null", count: rows.length, rows }, null, 2));
  } finally {
    await database.close();
  }
}
