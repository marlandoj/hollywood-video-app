// HV-016-37: the API's database connections outlast decoding a feature's joined film.
//
// Release 3's joined film is one job of 47 MiB of JSON. `GET /api/jobs/:id` reads it in a short
// transaction, and decoding the row took 15 s on an idle host and over 20 s on a loaded one, which
// is past Bun SQL's default idle timeout (20 s). The resumed live run's poll of its finished join was
// answered "400 Idle timeout reached after 20s", and the run stopped.
import {expect,test} from "bun:test";
import {API_DATABASE_IDLE_TIMEOUT_SECONDS,WORKER_DATABASE_IDLE_TIMEOUT_SECONDS,StudioDatabase,apiDatabase} from "../src/database";

// No connection is opened: Bun SQL connects on the first query.
const DATABASE_URL="postgres://hv_api:unused@127.0.0.1:1/hv";

test("the API's pool allows the worker's idle bound, not Bun SQL's 20 s default", () => {
  expect(API_DATABASE_IDLE_TIMEOUT_SECONDS).toBe(WORKER_DATABASE_IDLE_TIMEOUT_SECONDS);
  const options=(apiDatabase(DATABASE_URL).sql as unknown as {options:{idleTimeout:number;max:number}}).options;
  expect(options.idleTimeout).toBe(API_DATABASE_IDLE_TIMEOUT_SECONDS*1000);
  expect(options.max).toBe(8);
  // The default it replaces, for contrast.
  expect((new StudioDatabase(DATABASE_URL).sql as unknown as {options:{idleTimeout:number}}).options.idleTimeout).toBe(20_000);
});

test("the API server builds its database with apiDatabase", async () => {
  const source=await Bun.file(new URL("../../api/src/server.ts",import.meta.url)).text();
  expect(source).toContain('? apiDatabase(options.databaseUrl ?? process.env.HV_API_DATABASE_URL ?? "") : undefined;');
  expect(source).not.toContain("new StudioDatabase(");
});
