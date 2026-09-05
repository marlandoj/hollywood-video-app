CREATE TABLE "hv_archives" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"object_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hv_artifacts" (
	"key" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"job_id" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"backend" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hv_artifact_bytes_nonnegative" CHECK ("hv_artifacts"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hv_provider_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"job_id" text NOT NULL,
	"shot_id" text NOT NULL,
	"provider" text NOT NULL,
	"worker_id" text NOT NULL,
	"lease_version" integer NOT NULL,
	"status" text NOT NULL,
	"estimated_usd" numeric(16, 6) NOT NULL,
	"actual_usd" numeric(16, 6),
	"request_id" text,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hv_attempt_estimate_nonnegative" CHECK ("hv_provider_attempts"."estimated_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hv_budget_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"monthly_cap_usd" numeric(16, 6) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hv_budget_positive" CHECK ("hv_budget_accounts"."monthly_cap_usd" > 0)
);
--> statement-breakpoint
CREATE TABLE "hv_cost_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"project_id" text NOT NULL,
	"job_id" text,
	"attempt_id" text,
	"stage" text,
	"provider" text NOT NULL,
	"total_usd" numeric(16, 6) NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hv_cost_nonnegative" CHECK ("hv_cost_events"."total_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hv_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"tier" text NOT NULL,
	"body" jsonb NOT NULL,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"lease_expires_at" timestamp with time zone,
	"next_eligible_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hv_jobs_status_check" CHECK ("hv_jobs"."status" in ('queued','running','done','failed','cancelled')),
	CONSTRAINT "hv_jobs_stage_check" CHECK ("hv_jobs"."stage" in ('animatic','final'))
);
--> statement-breakpoint
CREATE TABLE "hv_operator_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"shot_id" text NOT NULL,
	"body" jsonb NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hv_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"job_id" text,
	"event_type" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hv_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"taken_down_at" timestamp with time zone,
	"takedown_reason" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hv_reservations" (
	"job_id" text PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"amount_usd" numeric(16, 6) NOT NULL,
	"remaining_usd" numeric(16, 6) NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hv_reservation_nonnegative" CHECK ("hv_reservations"."amount_usd" >= 0 and "hv_reservations"."remaining_usd" >= 0 and "hv_reservations"."remaining_usd" <= "hv_reservations"."amount_usd")
);
--> statement-breakpoint
CREATE TABLE "hv_reviews" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hv_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"classes" jsonb NOT NULL,
	"active_job_id" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hv_archives_project_idx" ON "hv_archives" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "hv_artifacts_project_idx" ON "hv_artifacts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "hv_artifacts_job_idx" ON "hv_artifacts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "hv_attempts_reconcile_idx" ON "hv_provider_attempts" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "hv_attempts_job_idx" ON "hv_provider_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hv_cost_event_key_idx" ON "hv_cost_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "hv_cost_window_idx" ON "hv_cost_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "hv_cost_job_idx" ON "hv_cost_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "hv_cost_project_idx" ON "hv_cost_events" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hv_jobs_idempotency_idx" ON "hv_jobs" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "hv_jobs_claim_idx" ON "hv_jobs" USING btree ("status","next_eligible_at","queued_at");--> statement-breakpoint
CREATE INDEX "hv_jobs_project_idx" ON "hv_jobs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "hv_operator_review_pending_idx" ON "hv_operator_reviews" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "hv_outbox_pending_idx" ON "hv_outbox" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX "hv_outbox_project_idx" ON "hv_outbox" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "hv_projects_retention_idx" ON "hv_projects" USING btree ("delete_after");--> statement-breakpoint
CREATE INDEX "hv_reviews_project_idx" ON "hv_reviews" USING btree ("project_id");