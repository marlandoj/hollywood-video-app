import { StudioDatabase } from "../packages/storage/src/database";
const url = process.env.HV_PG_ADMIN_URL ?? "";
if (new URL(url).pathname !== "/hollywood_video_test") throw new Error("CI role setup requires the disposable hollywood_video_test database");
const database = new StudioDatabase(url);
try {
  await database.sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hv_api') THEN
      CREATE ROLE hv_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'ci-api-fixture-only';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hv_worker') THEN
      CREATE ROLE hv_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'ci-worker-fixture-only';
    END IF;
  END $$;`);
} finally { await database.close(); }
