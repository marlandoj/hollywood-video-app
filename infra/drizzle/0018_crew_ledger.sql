CREATE TABLE "hv_crew_events" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"project_id" text NOT NULL,
	"persona" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"usd" numeric(16, 6) NOT NULL,
	CONSTRAINT "hv_crew_usd_nonnegative" CHECK ("hv_crew_events"."usd" >= 0),
	CONSTRAINT "hv_crew_tokens_nonnegative" CHECK ("hv_crew_events"."input_tokens" >= 0 and "hv_crew_events"."output_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hv_crew_budget" (
	"id" text PRIMARY KEY NOT NULL,
	"approved_ceiling_usd" numeric(16, 6) NOT NULL,
	"alerts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "hv_crew_budget_singleton" CHECK ("hv_crew_budget"."id" = 'crew')
);
--> statement-breakpoint
ALTER TABLE "hv_crew_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_crew_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_crew_budget" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_crew_budget" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "hv_crew_events_at_idx" ON "hv_crew_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "hv_crew_events_project_idx" ON "hv_crew_events" USING btree ("project_id");--> statement-breakpoint
CREATE POLICY "hv_crew_events_api_read" ON "hv_crew_events" AS PERMISSIVE FOR SELECT TO "hv_api" USING (true);--> statement-breakpoint
CREATE POLICY "hv_crew_events_api_insert" ON "hv_crew_events" AS PERMISSIVE FOR INSERT TO "hv_api" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_crew_events_worker" ON "hv_crew_events" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_crew_budget_api_read" ON "hv_crew_budget" AS PERMISSIVE FOR SELECT TO "hv_api" USING ("hv_crew_budget"."id" = 'crew');--> statement-breakpoint
CREATE POLICY "hv_crew_budget_api_insert" ON "hv_crew_budget" AS PERMISSIVE FOR INSERT TO "hv_api" WITH CHECK ("hv_crew_budget"."id" = 'crew');--> statement-breakpoint
CREATE POLICY "hv_crew_budget_api_update" ON "hv_crew_budget" AS PERMISSIVE FOR UPDATE TO "hv_api" USING ("hv_crew_budget"."id" = 'crew') WITH CHECK ("hv_crew_budget"."id" = 'crew');--> statement-breakpoint
CREATE POLICY "hv_crew_budget_worker" ON "hv_crew_budget" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT ON "hv_crew_events" TO hv_api, hv_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "hv_crew_budget" TO hv_api, hv_worker;
