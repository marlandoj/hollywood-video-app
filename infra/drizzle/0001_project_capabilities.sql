ALTER TABLE "hv_archives" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_provider_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hv_archives_capability" ON "hv_archives" AS PERMISSIVE FOR ALL TO "hv_api" USING ("hv_archives"."project_id" = current_setting('hv.project_id', true)) WITH CHECK ("hv_archives"."project_id" = current_setting('hv.project_id', true));--> statement-breakpoint
CREATE POLICY "hv_archives_worker" ON "hv_archives" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_artifacts_capability" ON "hv_artifacts" AS PERMISSIVE FOR ALL TO "hv_api" USING ("hv_artifacts"."project_id" = current_setting('hv.project_id', true)) WITH CHECK ("hv_artifacts"."project_id" = current_setting('hv.project_id', true));--> statement-breakpoint
CREATE POLICY "hv_artifacts_worker" ON "hv_artifacts" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_provider_attempts_capability" ON "hv_provider_attempts" AS PERMISSIVE FOR ALL TO "hv_api" USING ("hv_provider_attempts"."project_id" = current_setting('hv.project_id', true)) WITH CHECK ("hv_provider_attempts"."project_id" = current_setting('hv.project_id', true));--> statement-breakpoint
CREATE POLICY "hv_provider_attempts_worker" ON "hv_provider_attempts" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_jobs_capability" ON "hv_jobs" AS PERMISSIVE FOR ALL TO "hv_api" USING ("hv_jobs"."project_id" = current_setting('hv.project_id', true)) WITH CHECK ("hv_jobs"."project_id" = current_setting('hv.project_id', true));--> statement-breakpoint
CREATE POLICY "hv_jobs_worker" ON "hv_jobs" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_outbox_capability" ON "hv_outbox" AS PERMISSIVE FOR ALL TO "hv_api" USING ("hv_outbox"."project_id" = current_setting('hv.project_id', true)) WITH CHECK ("hv_outbox"."project_id" = current_setting('hv.project_id', true));--> statement-breakpoint
CREATE POLICY "hv_outbox_worker" ON "hv_outbox" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_projects_capability" ON "hv_projects" AS PERMISSIVE FOR ALL TO "hv_api" USING ("hv_projects"."id" = current_setting('hv.project_id', true)) WITH CHECK ("hv_projects"."id" = current_setting('hv.project_id', true));--> statement-breakpoint
CREATE POLICY "hv_projects_worker" ON "hv_projects" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "hv_reviews_capability" ON "hv_reviews" AS PERMISSIVE FOR ALL TO "hv_api" USING ("hv_reviews"."project_id" = current_setting('hv.project_id', true)) WITH CHECK ("hv_reviews"."project_id" = current_setting('hv.project_id', true));--> statement-breakpoint
CREATE POLICY "hv_reviews_worker" ON "hv_reviews" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);