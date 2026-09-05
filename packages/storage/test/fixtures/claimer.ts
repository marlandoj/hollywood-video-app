import { StudioDatabase } from "../../src/database";
import { PostgresJobStore } from "../../src/jobs";
const database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!, 1);
try {
  const job = await new PostgresJobStore(database).claimNext(Date.now(), {}, {workerId: process.argv[2], leaseMs: 60_000});
  console.log(JSON.stringify(job ?? null));
} finally { await database.close(); }
