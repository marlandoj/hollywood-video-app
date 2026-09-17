/**
 * HV-032-02, the PostgreSQL half.
 *
 * The fair-share horizon is computed twice: once over a JSON array in
 * `packages/operator/src/index.ts`, once in SQL here. Sharing the constant
 * stops the two *numbers* diverging and does nothing about the two
 * *expressions* — the JSON side filters on the event body's `at`, this side on
 * the `created_at` column, and an inclusive `>=` on one side with an exclusive
 * `>` on the other would put a job in a different order depending only on which
 * storage backend the deployment runs. So this seeds the same events into both
 * ledgers and requires the same answer, at the window's edge as well as inside
 * it. That equality is the assertion; the individual sums are incidental.
 *
 * Gated on a PostgreSQL test environment like every other PostgreSQL suite
 * here; CI supplies the three database URLs at the job level, so it runs there.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresCostLedger } from "../src/ledger";
import { StudioDatabase } from "../src/database";
import { CostLedger } from "../../operator/src/index";
import { FAIR_SHARE_WINDOW_MS } from "../../queue/src/index";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
const projects: string[] = [];
const root = mkdtempSync(join(tmpdir(), "hv-fair-share-pg-"));
let admin: StudioDatabase, database: StudioDatabase;

beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "fair-share-window-fixture-secret-of-at-least-thirty-two";
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate();
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  if (!enabled) return;
  for (const id of projects) {
    await admin.sql`delete from hv_cost_events where project_id = ${id}`;
    await admin.sql`delete from hv_projects where id = ${id}`;
  }
  await Promise.all([admin.close(), database.close()]);
});

const NOW = Date.parse("2026-09-17T12:00:00.000Z");

pgtest("both cost ledgers answer the same fair-share weights for the same events", async () => {
  const inside = crypto.randomUUID(), edge = crypto.randomUUID(), outside = crypto.randomUUID();
  projects.push(inside, edge, outside);
  for (const id of [inside, edge, outside]) {
    await admin.sql`insert into hv_projects (id, body, delete_after)
      values (${id}, ${{ id, createdAt: new Date(NOW).toISOString(), deleteAfter: new Date(NOW + 86_400_000).toISOString(), versions: [] }}::jsonb, now() + interval '1 day')`;
  }

  const events = [
    { projectId: inside, seconds: 12.5, at: NOW - 3_600_000 },
    { projectId: inside, seconds: 30, at: NOW - 60_000 },
    { projectId: edge, seconds: 7, at: NOW - FAIR_SHARE_WINDOW_MS },
    { projectId: outside, seconds: 5_000, at: NOW - FAIR_SHARE_WINDOW_MS - 1 },
  ].map((item, index) => ({
    eventId: `fair-share-${index}-${item.projectId}`,
    jobId: `${item.projectId}-${index}`, at: new Date(item.at).toISOString(),
    projectId: item.projectId, shotId: "s", stage: "animatic" as const,
    provider: "test", model: "m", prompt_tokens: 1, output_frames: 1,
    gpu_seconds: item.seconds, total_cost_usd: 0,
  }));

  const json = new CostLedger(join(root, "ledger.json"));
  const postgres = new PostgresCostLedger(database);
  for (const item of events) {
    json.record(item);
    await postgres.record(item);
  }

  // Three sampled instants: inside the window, exactly on the edge's boundary,
  // and a millisecond past it. Equal at all three, or the claim order depends
  // on the backend.
  for (const [label, at] of [["inside", NOW], ["edge", NOW + 1], ["past", NOW + FAIR_SHARE_WINDOW_MS + 1]] as const) {
    const [fromJson, fromPostgres] = [json.fairShareWeights(at), await postgres.fairShareWeights(at)];
    expect({ label, fromPostgres }).toEqual({ label, fromPostgres: fromJson });
  }

  // And the answer is the one the horizon implies, so "equal" is not two
  // implementations agreeing on the same mistake.
  expect(json.fairShareWeights(NOW)).toEqual({ [inside]: 42.5, [edge]: 7 });
  expect(await postgres.fairShareWeights(NOW)).toEqual({ [inside]: 42.5, [edge]: 7 });

  // The events are all still recorded; only the weight is windowed.
  let total = 0;
  for (const id of [inside, edge, outside]) {
    const rows = await admin.sql`select coalesce(sum((body->>'gpu_seconds')::numeric), 0) as seconds
      from hv_cost_events where project_id = ${id}`;
    total += Number((rows as { seconds: string }[])[0]!.seconds);
  }
  expect(total).toBe(5_049.5);
});
