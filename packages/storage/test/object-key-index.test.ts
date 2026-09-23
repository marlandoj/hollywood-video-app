/**
 * HV-040-08 — the sweeper asked an unindexed question, twice per object, every hour.
 *
 * `PostgresRetention`'s orphan sweep walks the object store and asks, for each key it finds,
 * whether any row still references it (`retention.ts:151-152`):
 *
 *     select key from hv_artifacts where object_key = $1 limit 1
 *     select id  from hv_archives  where object_key = $1 limit 1
 *
 * `0004_artifact_objects.sql` added `object_key` with a bare `ALTER TABLE` and no index was ever
 * added, on either table. Measured against the **staging cluster**, on a temporary table of 200,000
 * rows with the real key shape:
 *
 * ```
 * no index  | hit 15.49 ms | miss 23.01 ms      <- a miss is the sweeper's normal case: an orphan
 * indexed   | hit  0.34 ms | miss  0.15 ms         is a miss in both tables
 * ```
 *
 * ```
 * Seq Scan on t_artifacts  (actual time=15.163..15.164 rows=1)
 *   Rows Removed by Filter: 123455        Buffers: local read=1900 written=1019
 * Index Scan using t_artifacts_object_idx  (actual time=0.028..0.029 rows=1)
 *   Buffers: local read=4
 * ```
 *
 * The sweep runs hourly over up to 200,000 keys and probes both tables per key: about **2.6 hours**
 * of query time per hourly sweep at that size, against roughly a minute with the indexes. And it
 * runs as `hv_worker`, whose RLS policy is `using (true)`, so no project predicate narrows the scan
 * either.
 */
import {afterAll, beforeAll, expect, test} from "bun:test";
import {readFileSync, readdirSync} from "node:fs";
import {StudioDatabase} from "../src/database";

const root = new URL("../../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(root + path, "utf8");

test("every index the schema declares is created by a migration, and every one a migration creates is declared", () => {
  // The defect was a column added by a migration with no index behind it, and nothing said so. This
  // is the general form: the two descriptions of what the database has must agree.
  const schema = read("packages/storage/src/schema.ts");
  const declared = [...schema.matchAll(/(?:unique)?[iI]ndex\("([a-z0-9_]+)"\)/g)].map(match => match[1]!);
  const files = readdirSync(root + "infra/drizzle").filter(name => name.endsWith(".sql")).sort();
  const migrations = files.map(name => read("infra/drizzle/" + name)).join("\n");
  const created = [...migrations.matchAll(/CREATE (?:UNIQUE )?INDEX "([a-z0-9_]+)"/g)].map(match => match[1]!);
  expect({missing: declared.filter(name => !created.includes(name))}).toEqual({missing: []});
  expect({unknown: created.filter(name => !declared.includes(name))}).toEqual({unknown: []});
  // And the two the sweeper needs are among them, by name.
  for (const name of ["hv_artifacts_object_key_idx", "hv_archives_object_key_idx"]) {
    expect({name, declared: declared.includes(name)}).toEqual({name, declared: true});
    expect({name, created: created.includes(name)}).toEqual({name, created: true});
  }
});

test("and the journal names every migration file, in order, once", () => {
  // A migration file the journal does not name is never applied, which is the same defect one step
  // further along: a column or an index that exists in the repo and not in the database.
  const journal = JSON.parse(read("infra/drizzle/meta/_journal.json")) as {entries: {idx: number; tag: string}[]};
  const files = readdirSync(root + "infra/drizzle").filter(name => name.endsWith(".sql")).map(name => name.replace(/\.sql$/, "")).sort();
  expect(journal.entries.map(entry => entry.tag).sort()).toEqual(files);
  // The journal is zero-indexed, and each entry follows the one before it.
  expect(journal.entries.map(entry => entry.idx)).toEqual(journal.entries.map((_, index) => index));
});

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
let admin: StudioDatabase;
beforeAll(async () => {if (enabled) {admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!); await admin.migrate();}});
afterAll(async () => {if (enabled) await admin.sql.end();});

pgtest("and the database the migration produces has them, on the columns the sweeper probes", async () => {
  const rows = await admin.sql`
    select indexname, tablename, indexdef from pg_indexes
    where indexname in (${"hv_artifacts_object_key_idx"}, ${"hv_archives_object_key_idx"}) order by indexname`;
  expect(rows.map((row: {indexname: string}) => row.indexname)).toEqual(["hv_archives_object_key_idx", "hv_artifacts_object_key_idx"]);
  for (const row of rows as {indexname: string; indexdef: string}[]) expect({index: row.indexname, on: row.indexdef.includes("(object_key)")}).toEqual({index: row.indexname, on: true});
  // And the planner uses one for the sweeper's own query rather than scanning the table.
  const plan = (await admin.sql.unsafe(
    "explain select key from hv_artifacts where object_key = $1 limit 1", ["p/j/never-stored.mp4"])) as {"QUERY PLAN": string}[];
  expect(plan.map(row => row["QUERY PLAN"]).join("\n")).toContain("hv_artifacts_object_key_idx");
});
