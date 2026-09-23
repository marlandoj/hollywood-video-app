import { sql } from "drizzle-orm";
import { pgTable, text, jsonb, timestamp, integer, numeric, bigint, index, uniqueIndex, check, pgPolicy, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { Job } from "../../queue/src/index";
import type { CostEvent, BudgetReservation } from "../../operator/src/index";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });
const money = (name: string) => numeric(name, { precision: 16, scale: 6 });
const scopePolicies = (name: string, projectId: AnyPgColumn) => [
  pgPolicy(name + "_capability", { for: "all", to: "hv_api",
    using: sql`${projectId} = current_setting('hv.project_id', true)`,
    withCheck: sql`${projectId} = current_setting('hv.project_id', true)` }),
  pgPolicy(name + "_worker", { for: "all", to: "hv_worker", using: sql`true`, withCheck: sql`true` }),
];
/** Accounting tables: hv_api holds only the commands it uses, each one policed (0015_accounting_capabilities); hv_worker is unconditional. */
const workerPolicy = (name: string) => pgPolicy(name + "_worker", { for: "all", to: "hv_worker", using: sql`true`, withCheck: sql`true` });
const readPolicy = (name: string) => pgPolicy(name + "_api_read", { for: "select", to: "hv_api", using: sql`true` });


export const projects = pgTable("hv_projects", {
  id: text("id").primaryKey(), body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  createdAt: time("created_at").notNull().defaultNow(), deleteAfter: time("delete_after").notNull(),
  takenDownAt: time("taken_down_at"), purgedAt: time("purged_at"), takedownReason: text("takedown_reason"), version: integer("version").notNull().default(1),
}, t => [index("hv_projects_retention_idx").on(t.deleteAfter), ...scopePolicies("hv_projects", t.id)]).enableRLS();

export const reviews = pgTable("hv_reviews", {
  tokenHash: text("token_hash").primaryKey(), projectId: text("project_id").notNull(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
}, t => [index("hv_reviews_project_idx").on(t.projectId), ...scopePolicies("hv_reviews", t.projectId)]).enableRLS();

export const jobs = pgTable("hv_jobs", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), idempotencyKey: text("idempotency_key").notNull(),
  stage: text("stage").notNull(), status: text("status").notNull(), tier: text("tier").notNull(),
  body: jsonb("body").$type<Job>().notNull(), leaseVersion: integer("lease_version").notNull().default(0),
  claimedBy: text("claimed_by"), leaseExpiresAt: time("lease_expires_at"), nextEligibleAt: time("next_eligible_at"),
  queuedAt: time("queued_at").notNull().defaultNow(), updatedAt: time("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("hv_jobs_idempotency_idx").on(t.projectId, t.idempotencyKey),
  index("hv_jobs_claim_idx").on(t.status, t.nextEligibleAt, t.queuedAt),
  index("hv_jobs_project_idx").on(t.projectId, t.status),
  check("hv_jobs_status_check", sql`${t.status} in ('queued','running','done','failed','cancelled')`),
  check("hv_jobs_stage_check", sql`${t.stage} in ('animatic','final','character-sheet','take-preview','take-final','dialogue-replacement','audio-take','lip-sync','sound-mix','picture-edit','motion-graphic','assembly-edit','delivery')`), ...scopePolicies("hv_jobs", t.projectId)]).enableRLS();

export const budgetAccounts = pgTable("hv_budget_accounts", {
  id: text("id").primaryKey(), monthlyCapUsd: money("monthly_cap_usd").notNull(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, t => [check("hv_budget_positive", sql`${t.monthlyCapUsd} > 0`),
  pgPolicy("hv_budget_accounts_api_read", { for: "select", to: "hv_api", using: sql`${t.id} = 'operator'` }),
  pgPolicy("hv_budget_accounts_api_insert", { for: "insert", to: "hv_api", withCheck: sql`${t.id} = 'operator' AND coalesce(current_setting('hv.project_id', true), '') <> ''` }),
  pgPolicy("hv_budget_accounts_api_update", { for: "update", to: "hv_api", using: sql`${t.id} = 'operator'`,
    withCheck: sql`${t.id} = 'operator' AND coalesce(current_setting('hv.project_id', true), '') <> ''` }),
  workerPolicy("hv_budget_accounts")]).enableRLS();

export const reservations = pgTable("hv_reservations", {
  jobId: text("job_id").primaryKey(), stage: text("stage").notNull(),
  amountUsd: money("amount_usd").notNull(), remainingUsd: money("remaining_usd").notNull(),
  body: jsonb("body").$type<BudgetReservation>().notNull(), createdAt: time("created_at").notNull().defaultNow(),
  projectId: text("project_id"),
}, t => [check("hv_reservation_nonnegative", sql`${t.amountUsd} >= 0 and ${t.remainingUsd} >= 0 and ${t.remainingUsd} <= ${t.amountUsd}`),
  readPolicy("hv_reservations"),
  pgPolicy("hv_reservations_api_admit", { for: "insert", to: "hv_api", withCheck: sql`${t.projectId} = current_setting('hv.project_id', true) AND coalesce(current_setting('hv.project_id', true), '') <> ''` }),
  workerPolicy("hv_reservations")]).enableRLS();

export const costs = pgTable("hv_cost_events", {
  id: text("id").primaryKey(), eventKey: text("event_key").notNull(), projectId: text("project_id").notNull(),
  jobId: text("job_id"), attemptId: text("attempt_id"), stage: text("stage"), provider: text("provider").notNull(),
  totalUsd: money("total_usd").notNull(), body: jsonb("body").$type<CostEvent>().notNull(),
  createdAt: time("created_at").notNull(),
}, t => [uniqueIndex("hv_cost_event_key_idx").on(t.eventKey), index("hv_cost_window_idx").on(t.createdAt),
  index("hv_cost_job_idx").on(t.jobId), index("hv_cost_project_idx").on(t.projectId),
  check("hv_cost_nonnegative", sql`${t.totalUsd} >= 0`), readPolicy("hv_cost_events"), workerPolicy("hv_cost_events")]).enableRLS();

export const attempts = pgTable("hv_provider_attempts", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), jobId: text("job_id").notNull(),
  shotId: text("shot_id").notNull(), provider: text("provider").notNull(), workerId: text("worker_id").notNull(),
  leaseVersion: integer("lease_version").notNull(), status: text("status").notNull(),
  estimatedUsd: money("estimated_usd").notNull(), actualUsd: money("actual_usd"), requestId: text("request_id"),
  body: jsonb("body").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: time("created_at").notNull().defaultNow(), updatedAt: time("updated_at").notNull().defaultNow(),
}, t => [index("hv_attempts_reconcile_idx").on(t.status, t.updatedAt), index("hv_attempts_job_idx").on(t.jobId),
  uniqueIndex("hv_audio_attempt_job_idx").on(t.jobId).where(sql`${t.body} ? 'audio'`),
  uniqueIndex("hv_lipsync_attempt_job_idx").on(t.jobId).where(sql`${t.body} ? 'lipSync'`),
  check("hv_attempt_estimate_nonnegative", sql`${t.estimatedUsd} >= 0`), ...scopePolicies("hv_provider_attempts", t.projectId)]).enableRLS();

export const workers = pgTable("hv_workers", {
  id: text("id").primaryKey(), classes: jsonb("classes").$type<string[]>().notNull(), activeJobId: text("active_job_id"),
  heartbeatAt: time("heartbeat_at").notNull().defaultNow(), body: jsonb("body").$type<Record<string, unknown>>().notNull().default({}),
}, () => [readPolicy("hv_workers"), workerPolicy("hv_workers")]).enableRLS();

export const outbox = pgTable("hv_outbox", {
  id: text("id").primaryKey(), projectId: text("project_id"), jobId: text("job_id"),
  eventType: text("event_type").notNull(), body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  createdAt: time("created_at").notNull().defaultNow(), publishedAt: time("published_at"),
}, t => [index("hv_outbox_pending_idx").on(t.publishedAt, t.createdAt), index("hv_outbox_project_idx").on(t.projectId, t.createdAt), ...scopePolicies("hv_outbox", t.projectId)]).enableRLS();

export const artifacts = pgTable("hv_artifacts", {
  key: text("key").primaryKey(), objectKey: text("object_key").notNull(), projectId: text("project_id").notNull(), jobId: text("job_id").notNull(),
  sha256: text("sha256").notNull(), bytes: bigint("bytes", { mode: "number" }).notNull(), contentType: text("content_type").notNull(),
  backend: text("backend").notNull(), createdAt: time("created_at").notNull().defaultNow(),
}, t => [index("hv_artifacts_project_idx").on(t.projectId), index("hv_artifacts_job_idx").on(t.jobId),
  // HV-040-08: the orphan sweeper asks "does any row still reference this object key" once per
  // stored object, hourly, over up to 200,000 keys, and there was no index to answer it with.
  // Measured on the staging cluster with 200,000 rows: 23.01 ms for a miss -- which is the sweeper's
  // normal case, since an orphan is a miss in both tables -- against 0.15 ms indexed.
  index("hv_artifacts_object_key_idx").on(t.objectKey),
  check("hv_artifact_bytes_nonnegative", sql`${t.bytes} >= 0`), ...scopePolicies("hv_artifacts", t.projectId)]).enableRLS();

export const operatorReviews = pgTable("hv_operator_reviews", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), shotId: text("shot_id").notNull(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(), resolvedAt: time("resolved_at"),
}, t => [index("hv_operator_review_pending_idx").on(t.resolvedAt), workerPolicy("hv_operator_reviews")]).enableRLS();

export const archives = pgTable("hv_archives", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), schemaVersion: text("schema_version").notNull(),
  manifestSha256: text("manifest_sha256").notNull(), objectKey: text("object_key").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, t => [index("hv_archives_project_idx").on(t.projectId), index("hv_archives_object_key_idx").on(t.objectKey),
  ...scopePolicies("hv_archives", t.projectId)]).enableRLS();

/**
 * The crew's own budget line, in the database rather than in a file on one host (HV-030-09).
 *
 * `docs/CREW.md` named this: *"The crew ledger lives on one host, in a JSON file. Moving it into
 * PostgreSQL with the rest of the accounting needs a migration and is Release 2 work."* The file
 * version guards itself with an interprocess file lock, which is a lock on one filesystem: two API
 * processes on two hosts could each read a spend below a threshold, each record, and each miss the
 * alert — or both raise it. The budget row below is locked `FOR UPDATE` instead, so the crossing is
 * decided once.
 *
 * Events are append-only and never trimmed, so the spend is `sum(usd)` rather than a running total
 * carried beside the events — which is what the file version had to keep, because it drops events
 * past five thousand.
 */
export const crewEvents = pgTable("hv_crew_events", {
  id: text("id").primaryKey(), at: time("at").notNull(), projectId: text("project_id").notNull(),
  persona: text("persona").notNull(), model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(), outputTokens: integer("output_tokens").notNull(),
  usd: money("usd").notNull(),
}, t => [index("hv_crew_events_at_idx").on(t.at), index("hv_crew_events_project_idx").on(t.projectId),
  check("hv_crew_usd_nonnegative", sql`${t.usd} >= 0`),
  check("hv_crew_tokens_nonnegative", sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0`),
  readPolicy("hv_crew_events"),
  pgPolicy("hv_crew_events_api_insert", { for: "insert", to: "hv_api", withCheck: sql`true` }),
  workerPolicy("hv_crew_events")]).enableRLS();

/** One row, `id = 'crew'`: the ceiling the operator has approved and the alerts already raised. */
export const crewBudget = pgTable("hv_crew_budget", {
  id: text("id").primaryKey(), approvedCeilingUsd: money("approved_ceiling_usd").notNull(),
  alerts: jsonb("alerts").$type<{thresholdUsd: number; at: string; spentUsd: number}[]>().notNull().default([]),
}, t => [check("hv_crew_budget_singleton", sql`${t.id} = 'crew'`),
  pgPolicy("hv_crew_budget_api_read", { for: "select", to: "hv_api", using: sql`${t.id} = 'crew'` }),
  pgPolicy("hv_crew_budget_api_insert", { for: "insert", to: "hv_api", withCheck: sql`${t.id} = 'crew'` }),
  pgPolicy("hv_crew_budget_api_update", { for: "update", to: "hv_api", using: sql`${t.id} = 'crew'`, withCheck: sql`${t.id} = 'crew'` }),
  workerPolicy("hv_crew_budget")]).enableRLS();
