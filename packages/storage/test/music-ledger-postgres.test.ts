/**
 * HV-024-11 — the music line's ledger in PostgreSQL.
 *
 * `PostgresMusicLedger.reserve` is one transaction under the cost ledger's own lock: the lifetime
 * music line, the film's limit, the month's cap (the hold is an ordinary `hv_reservations` row,
 * stage `music-cue`) and the cue's row. When a cue ends the API marks it; the worker's reconcile
 * posts its cost to `hv_cost_events` and ends its hold. The tests that need a cluster run the API
 * side as `hv_api` through `forProject`, as the studio does, and the posting as `hv_worker`; they
 * skip without `HV_PG_ADMIN_URL`, `HV_API_DATABASE_URL` and `HV_WORKER_DATABASE_URL`.
 */
import {afterAll, beforeAll, expect, test} from "bun:test";
import {readFileSync, readdirSync} from "node:fs";
import {CostLedger} from "../../operator/src/index";
import {MusicLedger, type MusicLineAlert} from "../../operator/src/music-ledger";
import {PostgresMusicLedger} from "../src/music-ledger";
import {PostgresCostLedger} from "../src/ledger";
import {StudioDatabase} from "../src/database";

const root = new URL("../../../", import.meta.url).pathname;
const SEPT = Date.parse("2026-09-30T12:00:00.000Z"), NEXT_YEAR = Date.parse("2027-10-01T00:00:00.000Z");
const cue = (id: string, heldUsd: number, projectId = "music-p1", now = SEPT, extra: Record<string, unknown> = {}) =>
  ({id, projectId, provider: "elevenlabs", model: "music_v1", heldUsd, capUsd: 10, monthlyCapUsd: 500, now, ...extra});

/** The table is declared, created and row-secured; the API may read, add and settle cues but never delete one; no other table's privileges change. */
test("the music line's table is declared, created and row-secured, and the migration grants nothing on any other table", () => {
  const schema = readFileSync(root + "packages/storage/src/schema.ts", "utf8");
  const migrations = readdirSync(root + "infra/drizzle").filter(name => name.endsWith(".sql")).sort()
    .map(name => readFileSync(root + "infra/drizzle/" + name, "utf8")).join("\n");
  expect(schema).toContain(`pgTable("hv_music_cues"`);
  expect(migrations).toContain(`CREATE TABLE "hv_music_cues"`);
  expect(migrations).toContain(`ALTER TABLE "hv_music_cues" FORCE ROW LEVEL SECURITY`);
  expect(migrations).toContain(`GRANT SELECT, INSERT, UPDATE ON "hv_music_cues" TO hv_api, hv_worker;`);
  expect(migrations).not.toMatch(/GRANT[^;]*DELETE[^;]*hv_music_cues/);
  // Additive, and its own: the migration names no table but its own.
  const own = readFileSync(root + "infra/drizzle/0020_music_line.sql", "utf8");
  const named = own.match(/"hv_[a-z_]+"/g)!.filter(name => !["\"hv_api\"", "\"hv_worker\""].includes(name));
  expect(named.filter(name => name !== `"hv_music_cues"` && !name.startsWith(`"hv_music_cues_`))).toEqual([]);
  expect(own).not.toMatch(/\b(DROP|DELETE|TRUNCATE|ALTER COLUMN|RENAME|REVOKE)\b/);
});

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, api: StudioDatabase, worker: StudioDatabase, priorCap: string | null = null;
beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!, 4);
  api = new StudioDatabase(process.env.HV_API_DATABASE_URL!, 8);
  worker = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!, 2);
  await admin.migrate();
  priorCap = (await admin.sql`select monthly_cap_usd from hv_budget_accounts where id = 'operator'`)[0]?.monthly_cap_usd ?? null;
});
/** Only the rows these tests write: every cue, every music hold and cost, and the fixture films' costs. */
const clear = async () => {
  await admin.sql`delete from hv_music_cues`;
  await admin.sql`delete from hv_reservations where stage = 'music-cue'`;
  await admin.sql`delete from hv_cost_events where stage = 'music-cue' or project_id like 'music-%'`;
  await admin.sql`insert into hv_budget_accounts (id, monthly_cap_usd) values ('operator', 500) on conflict (id) do update set monthly_cap_usd = 500`;
};
afterAll(async () => {
  if (!enabled) return;
  await clear();
  if (priorCap === null) await admin.sql`delete from hv_budget_accounts where id = 'operator'`;
  else await admin.sql`update hv_budget_accounts set monthly_cap_usd = ${priorCap} where id = 'operator'`;
  await admin.sql.end(); await api.sql.end(); await worker.sql.end();
});
const post = () => new PostgresCostLedger(worker).reconcile(new Set(), 0);
const musicEvents = async () => (await admin.sql`select job_id, total_usd from hv_cost_events where stage = 'music-cue' order by job_id`)
  .map((row: {job_id: string; total_usd: string}) => [row.job_id, Number(row.total_usd)]);

/** The same sequence through both stores, every answer compared, then the costs each leaves in its generation ledger. */
pgtest("the PostgreSQL ledger answers what the file ledger answers, and posts the same costs", async () => {
  await clear();
  const costs = new CostLedger(), file = new MusicLedger(undefined, costs), database = new PostgresMusicLedger(api), fromFile: MusicLineAlert[] = [], fromDatabase: MusicLineAlert[] = [];
  file.onAlert = alert => fromFile.push(alert); database.onAlert = alert => fromDatabase.push(alert);
  const both = async (step: string, fn: (ledger: MusicLedger | PostgresMusicLedger) => unknown) => {
    let a: unknown, b: unknown;
    try { a = await fn(file); } catch (error) { a = {error: (error as Error).message}; }
    try { b = await fn(database); } catch (error) { b = {error: (error as Error).message}; }
    expect({step, b}).toEqual({step, b: a});
    expect({step, summary: await database.summary()}).toEqual({step, summary: file.summary()});
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
  await both("a year on, the line remembers", ledger => ledger.reserve(cue("later", 4.71, "music-p1", NEXT_YEAR)));
  await both("a year on, what fits", ledger => ledger.reserve(cue("later-fits", 1.5, "music-p1", NEXT_YEAR)));
  expect(fromDatabase).toEqual(fromFile);
  expect(fromDatabase.map(alert => alert.thresholdUsd)).toEqual([3, 7]);
  // The holds: still held in PostgreSQL until the worker posts; the file store ends them at once.
  expect(await post()).toBeUndefined();
  expect(await musicEvents()).toEqual(costs.all().map(event => [event.jobId, event.total_cost_usd]).sort());
  expect(Number((await admin.sql`select coalesce(sum(remaining_usd), 0) as held from hv_reservations where stage = 'music-cue'`)[0].held)).toBeCloseTo(costs.reservedUsd(), 6);
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
  expect(await new PostgresMusicLedger(api).summary()).toMatchObject({committedUsd: 10, alerts: [3, 7]});
  expect(Number((await admin.sql`select sum(remaining_usd) as held from hv_reservations where stage = 'music-cue'`)[0].held)).toBe(10);
}, 30000);

/** A cue is generation spend: refused by the film's limit and by the month's cap, writing nothing; once posted, the month and the film show it. */
pgtest("a cue counts against the film's limit and the month's cap, and once posted the month-to-date spend shows it", async () => {
  await clear();
  const ledger = new PostgresMusicLedger(api), costs = new PostgresCostLedger(api);
  const event = (projectId: string, usd: number) => admin.sql`insert into hv_cost_events (id, event_key, project_id, stage, provider, total_usd, body, created_at)
    values (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${projectId}, 'final', 'fal', ${usd}, '{}'::jsonb, now())`;
  await event("music-film", 39.9);
  await expect(ledger.reserve(cue("film", 0.15, "music-film", Date.now(), {filmCapUsd: 40}))).rejects.toThrow("This film has reached its spending limit of $40.00 ($39.90 spent or held).");
  await ledger.reserve(cue("fits", 0.1, "music-film", Date.now(), {filmCapUsd: 40}));
  expect(await costs.filmSpend("music-film")).toEqual({spentUsd: 39.9, heldUsd: 0.1});
  // Whatever else this database already holds this month counts too; the fixture fills the rest.
  const baseline = Number((await admin.sql`select
    (select coalesce(sum(total_usd), 0) from hv_cost_events where created_at >= now() - interval '30 days') +
    (select coalesce(sum(remaining_usd), 0) from hv_reservations) as total`)[0].total);
  await event("music-other", Number((499.9 - baseline).toFixed(6)));
  await expect(ledger.reserve(cue("month", 0.15, "music-third", Date.now()))).rejects.toThrow("generation capacity is reserved; try again when current jobs finish");
  expect(await ledger.cue("film")).toBeUndefined();
  expect(await ledger.cue("month")).toBeUndefined();
  expect(await admin.sql`select job_id from hv_reservations where job_id in ('film', 'month')`).toHaveLength(0);
  // Settled by the API; held until the worker posts; then a cost event and no hold.
  await ledger.settle("fits", 0.1, "asset");
  expect(await costs.filmSpend("music-film")).toEqual({spentUsd: 39.9, heldUsd: 0.1});
  // A cue still in flight is never released by the worker's sweep, however old.
  await ledger.reserve(cue("flight", 0.05, "music-fourth", Date.now()));
  const monthBefore = await costs.monthSpend();
  await post();
  expect(await costs.filmSpend("music-film")).toEqual({spentUsd: 40, heldUsd: 0});
  expect((await costs.rollup("month")).byProvider).toMatchObject({elevenlabs: 0.1});
  expect(await costs.monthSpend() - monthBefore).toBeCloseTo(0.1, 6);
  expect((await admin.sql`select job_id, remaining_usd from hv_reservations where stage = 'music-cue'`).map((row: {job_id: string}) => row.job_id)).toEqual(["flight"]);
  // Posting is once: a second reconcile adds nothing.
  await post();
  expect(await musicEvents()).toEqual([["fits", 0.1]]);
});

/** The API reads every film's cues -- the line is the studio's -- but writes only its own, and cannot delete one. */
pgtest("the API role counts every film's cues but cannot write another film's", async () => {
  await clear();
  const ledger = new PostgresMusicLedger(api);
  await ledger.reserve(cue("mine", 4, "music-a"));
  await expect(ledger.reserve(cue("theirs", 6.01, "music-b"))).rejects.toThrow("($4.00 spent or held)");
  await expect(api.forProject("music-b", tx => tx`insert into hv_music_cues (id, project_id, at, provider, model, status, held_usd)
    values ('forged', 'music-a', now(), 'elevenlabs', 'music_v1', 'held', 1)`)).rejects.toThrow();
  expect(await api.forProject("music-b", tx => tx`update hv_music_cues set held_usd = 0 where id = 'mine' returning id`)).toHaveLength(0);
  await expect(api.forProject("music-a", tx => tx`delete from hv_music_cues where id = 'mine'`)).rejects.toThrow();
  expect((await ledger.cue("mine"))?.heldUsd).toBe(4);
});
