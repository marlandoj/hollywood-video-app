import { afterAll, beforeAll, expect, test } from "bun:test";
import { StudioDatabase } from "../src/database";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
const first = crypto.randomUUID(), second = crypto.randomUUID();
let admin: StudioDatabase, api: StudioDatabase, worker: StudioDatabase;
beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  api = new StudioDatabase(process.env.HV_API_DATABASE_URL!);
  worker = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate();
  for (const id of [first, second]) {
    await admin.sql`insert into hv_projects (id, body, delete_after) values (${id}, ${{ id, marker: "original" }}::jsonb, now() + interval '1 day')`;
  }
});
afterAll(async () => {
  if (!enabled) return;
  await admin.sql`delete from hv_projects where id in (${first}, ${second})`;
  await Promise.all([admin.close(), api.close(), worker.close()]);
});

pgtest("PostgreSQL capability scope is enforced on reads and cannot leak through pooled connections", async () => {
  expect(await api.sql`select id from hv_projects`).toHaveLength(0);
  const read = (id: string) => api.forProject(id, async tx => tx`select id from hv_projects order by id`);
  const [a, b] = await Promise.all([read(first), read(second)]);
  expect(a.map((r: { id: string }) => r.id)).toEqual([first]);
  expect(b.map((r: { id: string }) => r.id)).toEqual([second]);
  expect(await api.sql`select id from hv_projects`).toHaveLength(0);
  const all = await worker.sql`select id from hv_projects where id in (${first}, ${second})`;
  expect(all).toHaveLength(2);
  await expect((async () => { await api.sql`set role hv_worker`; })()).rejects.toThrow();
});

pgtest("PostgreSQL refuses cross-project writes and rolls back changes with the transaction", async () => {
  await api.forProject(first, async tx => {
    expect(await tx`update hv_projects set version = version + 1 where id = ${second} returning id`).toHaveLength(0);
  });
  await expect(api.forProject(first, async tx => {
    await tx`insert into hv_projects (id, body, delete_after) values (${crypto.randomUUID()}, '{}'::jsonb, now())`;
  })).rejects.toThrow();
  await expect(api.forProject(first, async tx => {
    await tx`update hv_projects set body = '{"marker":"changed"}'::jsonb where id = ${first}`;
    throw new Error("abort migration fixture");
  })).rejects.toThrow("abort migration fixture");
  const rows = await api.forProject(first, async tx => tx`select body from hv_projects where id = ${first}`);
  expect(rows[0].body.marker).toBe("original");
});
