/**
 * HV-024-11 — the music line's ledger in PostgreSQL.
 *
 * `PostgresMusicLedger.reserve` reads the month's cues, checks the $10 line and writes the cue inside
 * one transaction that holds an advisory lock on the line, so concurrent admissions are decided one
 * after another. The tests that need a cluster run against the API role, through `forProject`, as
 * the studio does; they skip without `HV_PG_ADMIN_URL` and `HV_API_DATABASE_URL`.
 */
import {afterAll, beforeAll, expect, test} from "bun:test";
import {readFileSync, readdirSync} from "node:fs";
import {MusicLedger, type MusicLineAlert} from "../../operator/src/music-ledger";
import {PostgresMusicLedger} from "../src/music-ledger";
import {StudioDatabase} from "../src/database";

const root = new URL("../../../", import.meta.url).pathname;
const SEPT = Date.parse("2026-09-30T12:00:00.000Z"), OCT = Date.parse("2026-10-01T00:00:01.000Z");
const cue = (id: string, heldUsd: number, projectId = "music-p1", now = SEPT) => ({id, projectId, provider: "elevenlabs", model: "music_v1", heldUsd, capUsd: 10, now});

/** The table is declared and created, row-secured, and the API role is granted exactly what it uses: no delete. */
test("the music line's table is declared, created and row-secured, and the API role can read, add and settle but never delete", () => {
  const schema = readFileSync(root + "packages/storage/src/schema.ts", "utf8");
  const migrations = readdirSync(root + "infra/drizzle").filter(name => name.endsWith(".sql")).sort()
    .map(name => readFileSync(root + "infra/drizzle/" + name, "utf8")).join("\n");
  expect(schema).toContain(`pgTable("hv_music_cues"`);
  expect(migrations).toContain(`CREATE TABLE "hv_music_cues"`);
  expect(migrations).toContain(`ALTER TABLE "hv_music_cues" FORCE ROW LEVEL SECURITY`);
  expect(migrations).toContain(`GRANT SELECT, INSERT, UPDATE ON "hv_music_cues" TO hv_api, hv_worker;`);
  expect(migrations).not.toMatch(/GRANT[^;]*DELETE[^;]*hv_music_cues/);
  // Additive: the migration touches no table but its own.
  const own = readFileSync(root + "infra/drizzle/0020_music_line.sql", "utf8");
  const named = own.match(/"hv_[a-z_]+"/g)!.filter(name => !["\"hv_api\"", "\"hv_worker\""].includes(name));
  expect(named.filter(name => name !== `"hv_music_cues"` && !name.startsWith(`"hv_music_cues_`))).toEqual([]);
  expect(own).not.toMatch(/\b(DROP|DELETE|TRUNCATE|ALTER COLUMN|RENAME)\b/);
});

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, api: StudioDatabase;
beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!, 4);
  api = new StudioDatabase(process.env.HV_API_DATABASE_URL!, 8);
  await admin.migrate();
});
afterAll(async () => {if (enabled) {await admin.sql.end(); await api.sql.end();}});
const clear = async () => {await admin.sql`delete from hv_music_cues`;};

/** The same sequence through both stores, every answer compared. */
pgtest("the PostgreSQL ledger answers what the file ledger answers, over the same sequence", async () => {
  await clear();
  const file = new MusicLedger(), database = new PostgresMusicLedger(api), fromFile: MusicLineAlert[] = [], fromDatabase: MusicLineAlert[] = [];
  file.onAlert = alert => fromFile.push(alert); database.onAlert = alert => fromDatabase.push(alert);
  const both = async (step: string, fn: (ledger: MusicLedger | PostgresMusicLedger) => unknown) => {
    let a: unknown, b: unknown;
    try { a = await fn(file); } catch (error) { a = {error: (error as Error).message}; }
    try { b = await fn(database); } catch (error) { b = {error: (error as Error).message}; }
    expect({step, b}).toEqual({step, b: a});
    expect({step, summary: await database.summary(SEPT)}).toEqual({step, summary: file.summary(SEPT)});
  };
  for (const [index, held] of [2.5, 0.75, 0.15, 3.5, 2].entries()) await both("reserve " + index, ledger => ledger.reserve(cue("c" + index, held)));
  await both("over the line", ledger => ledger.reserve(cue("over", 1.2)));
  await both("settle", ledger => ledger.settle("c0", 2.4, "asset-0"));
  await both("settle again", ledger => ledger.settle("c0", 2.4, "asset-0"));
  await both("settle above hold", ledger => ledger.settle("c1", 0.76, null));
  await both("unreconciled", ledger => ledger.markUnreconciled("c2"));
  await both("release", ledger => ledger.release("c3"));
  await both("release unreconciled", ledger => ledger.release("c2"));
  await both("replay", ledger => ledger.reserve(cue("c4", 2)));
  await both("next month", ledger => ledger.reserve(cue("oct", 3, "music-p1", OCT)));
  expect(fromDatabase).toEqual(fromFile);
  expect(fromDatabase.map(alert => [alert.month, alert.thresholdUsd])).toEqual([["2026-09", 3], ["2026-09", 7], ["2026-10", 3]]);
});

/** Twelve admissions at once over separate connections: the line holds, and each alert is raised by exactly one. */
pgtest("concurrent reservations cannot pass the line, and each alert is crossed by exactly one of them", async () => {
  await clear();
  const ledgers = Array.from({length: 4}, () => new PostgresMusicLedger(api)), raised: number[] = [];
  for (const ledger of ledgers) ledger.onAlert = alert => raised.push(alert.thresholdUsd);
  const results = await Promise.allSettled(Array.from({length: 12}, (_, i) => ledgers[i % 4]!.reserve(cue("race" + i, 1.25, "music-p" + (i % 3)))));
  // $1.25 cues on a $10 line, from three films: eight fit, exactly.
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(8);
  expect(results.filter(r => r.status === "rejected").every(r => String((r as PromiseRejectedResult).reason.message).includes("music line has reached its limit"))).toBe(true);
  expect(raised.sort()).toEqual([3, 7]);
  expect(await new PostgresMusicLedger(api).summary(SEPT)).toMatchObject({committedUsd: 10, alerts: [3, 7]});
}, 30000);

/** The API reads every film's cues -- the line is the studio's -- but writes only its own. */
pgtest("the API role counts every film's cues but cannot write another film's", async () => {
  await clear();
  const ledger = new PostgresMusicLedger(api);
  await ledger.reserve(cue("mine", 4, "music-a"));
  await expect(ledger.reserve(cue("theirs", 6.01, "music-b"))).rejects.toThrow("($4.00 spent or held)");
  await expect(api.forProject("music-b", tx => tx`insert into hv_music_cues (id, project_id, at, month, provider, model, status, held_usd)
    values ('forged', 'music-a', now(), '2026-09', 'elevenlabs', 'music_v1', 'held', 1)`)).rejects.toThrow();
  expect(await api.forProject("music-b", tx => tx`update hv_music_cues set held_usd = 0 where id = 'mine' returning id`)).toHaveLength(0);
  await expect(api.forProject("music-a", tx => tx`delete from hv_music_cues where id = 'mine'`)).rejects.toThrow();
  expect((await ledger.cue("mine"))?.heldUsd).toBe(4);
});
