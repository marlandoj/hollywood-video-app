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


export const projects = pgTable("hv_projects", {
  id: text("id").primaryKey(), body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  createdAt: time("created_at").notNull().defaultNow(), deleteAfter: time("delete_after").notNull(),
  takenDownAt: time("taken_down_at"), takedownReason: text("takedown_reason"), version: integer("version").notNull().default(1),
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
  check("hv_jobs_stage_check", sql`${t.stage} in ('animatic','final')`), ...scopePolicies("hv_jobs", t.projectId)]).enableRLS();

export const budgetAccounts = pgTable("hv_budget_accounts", {
  id: text("id").primaryKey(), monthlyCapUsd: money("monthly_cap_usd").notNull(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, t => [check("hv_budget_positive", sql`${t.monthlyCapUsd} > 0`)]);

export const reservations = pgTable("hv_reservations", {
  jobId: text("job_id").primaryKey(), stage: text("stage").notNull(),
  amountUsd: money("amount_usd").notNull(), remainingUsd: money("remaining_usd").notNull(),
  body: jsonb("body").$type<BudgetReservation>().notNull(), createdAt: time("created_at").notNull().defaultNow(),
}, t => [check("hv_reservation_nonnegative", sql`${t.amountUsd} >= 0 and ${t.remainingUsd} >= 0 and ${t.remainingUsd} <= ${t.amountUsd}`)]);

export const costs = pgTable("hv_cost_events", {
  id: text("id").primaryKey(), eventKey: text("event_key").notNull(), projectId: text("project_id").notNull(),
  jobId: text("job_id"), attemptId: text("attempt_id"), stage: text("stage"), provider: text("provider").notNull(),
  totalUsd: money("total_usd").notNull(), body: jsonb("body").$type<CostEvent>().notNull(),
  createdAt: time("created_at").notNull(),
}, t => [uniqueIndex("hv_cost_event_key_idx").on(t.eventKey), index("hv_cost_window_idx").on(t.createdAt),
  index("hv_cost_job_idx").on(t.jobId), index("hv_cost_project_idx").on(t.projectId),
  check("hv_cost_nonnegative", sql`${t.totalUsd} >= 0`)]);

export const attempts = pgTable("hv_provider_attempts", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), jobId: text("job_id").notNull(),
  shotId: text("shot_id").notNull(), provider: text("provider").notNull(), workerId: text("worker_id").notNull(),
  leaseVersion: integer("lease_version").notNull(), status: text("status").notNull(),
  estimatedUsd: money("estimated_usd").notNull(), actualUsd: money("actual_usd"), requestId: text("request_id"),
  body: jsonb("body").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: time("created_at").notNull().defaultNow(), updatedAt: time("updated_at").notNull().defaultNow(),
}, t => [index("hv_attempts_reconcile_idx").on(t.status, t.updatedAt), index("hv_attempts_job_idx").on(t.jobId),
  check("hv_attempt_estimate_nonnegative", sql`${t.estimatedUsd} >= 0`), ...scopePolicies("hv_provider_attempts", t.projectId)]).enableRLS();

export const workers = pgTable("hv_workers", {
  id: text("id").primaryKey(), classes: jsonb("classes").$type<string[]>().notNull(), activeJobId: text("active_job_id"),
  heartbeatAt: time("heartbeat_at").notNull().defaultNow(), body: jsonb("body").$type<Record<string, unknown>>().notNull().default({}),
});

export const outbox = pgTable("hv_outbox", {
  id: text("id").primaryKey(), projectId: text("project_id"), jobId: text("job_id"),
  eventType: text("event_type").notNull(), body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  createdAt: time("created_at").notNull().defaultNow(), publishedAt: time("published_at"),
}, t => [index("hv_outbox_pending_idx").on(t.publishedAt, t.createdAt), index("hv_outbox_project_idx").on(t.projectId, t.createdAt), ...scopePolicies("hv_outbox", t.projectId)]).enableRLS();

export const artifacts = pgTable("hv_artifacts", {
  key: text("key").primaryKey(), projectId: text("project_id").notNull(), jobId: text("job_id").notNull(),
  sha256: text("sha256").notNull(), bytes: bigint("bytes", { mode: "number" }).notNull(), contentType: text("content_type").notNull(),
  backend: text("backend").notNull(), createdAt: time("created_at").notNull().defaultNow(),
}, t => [index("hv_artifacts_project_idx").on(t.projectId), index("hv_artifacts_job_idx").on(t.jobId),
  check("hv_artifact_bytes_nonnegative", sql`${t.bytes} >= 0`), ...scopePolicies("hv_artifacts", t.projectId)]).enableRLS();

export const operatorReviews = pgTable("hv_operator_reviews", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), shotId: text("shot_id").notNull(),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(), resolvedAt: time("resolved_at"),
}, t => [index("hv_operator_review_pending_idx").on(t.resolvedAt)]);

export const archives = pgTable("hv_archives", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), schemaVersion: text("schema_version").notNull(),
  manifestSha256: text("manifest_sha256").notNull(), objectKey: text("object_key").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, t => [index("hv_archives_project_idx").on(t.projectId), ...scopePolicies("hv_archives", t.projectId)]).enableRLS();
