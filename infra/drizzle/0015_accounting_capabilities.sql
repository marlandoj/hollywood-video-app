ALTER TABLE "hv_reservations" ADD COLUMN "project_id" text;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "hv_reservations" FROM "hv_api";--> statement-breakpoint
REVOKE DELETE ON "hv_budget_accounts" FROM "hv_api";--> statement-breakpoint
ALTER TABLE "hv_budget_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_budget_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_cost_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_cost_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_workers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_workers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_operator_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_operator_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hv_budget_accounts_api_read" ON "hv_budget_accounts" AS PERMISSIVE FOR SELECT TO "hv_api" USING ("hv_budget_accounts"."id" = 'operator');--> statement-breakpoint
CREATE POLICY "hv_budget_accounts_api_insert" ON "hv_budget_accounts" AS PERMISSIVE FOR INSERT TO "hv_api" WITH CHECK ("hv_budget_accounts"."id" = 'operator' AND coalesce(current_setting('hv.project_id', true), '') <> '');--> statement-breakpoint
CREATE POLICY "hv_budget_accounts_api_update" ON "hv_budget_accounts" AS PERMISSIVE FOR UPDATE TO "hv_api" USING ("hv_budget_accounts"."id" = 'operator') WITH CHECK ("hv_budget_accounts"."id" = 'operator' AND coalesce(current_setting('hv.project_id', true), '') <> '');--> statement-breakpoint
CREATE POLICY "hv_budget_accounts_worker" ON "hv_budget_accounts" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_reservations_api_read" ON "hv_reservations" AS PERMISSIVE FOR SELECT TO "hv_api" USING (true);--> statement-breakpoint
CREATE POLICY "hv_reservations_api_admit" ON "hv_reservations" AS PERMISSIVE FOR INSERT TO "hv_api" WITH CHECK ("hv_reservations"."project_id" = current_setting('hv.project_id', true));--> statement-breakpoint
CREATE POLICY "hv_reservations_worker" ON "hv_reservations" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_cost_events_api_read" ON "hv_cost_events" AS PERMISSIVE FOR SELECT TO "hv_api" USING (true);--> statement-breakpoint
CREATE POLICY "hv_cost_events_worker" ON "hv_cost_events" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_workers_api_read" ON "hv_workers" AS PERMISSIVE FOR SELECT TO "hv_api" USING (true);--> statement-breakpoint
CREATE POLICY "hv_workers_worker" ON "hv_workers" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_operator_reviews_worker" ON "hv_operator_reviews" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);
