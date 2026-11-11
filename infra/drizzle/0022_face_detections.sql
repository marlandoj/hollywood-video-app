-- HV-022-25: the studio's face detections. Additive only: one new table, no existing row touched, and no
-- privilege on any other table changes. A detection's hold and cost live in hv_reservations and hv_cost_events
-- like any other (stage `face-detection`); the worker posts a settled detection's cost there (`posted_at`).
CREATE TABLE "hv_face_detections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text NOT NULL,
	"held_usd" numeric(16, 6) NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone,
	CONSTRAINT "hv_face_detections_status_check" CHECK ("hv_face_detections"."status" in ('held','settled')),
	CONSTRAINT "hv_face_detections_money_check" CHECK ("hv_face_detections"."held_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "hv_face_detections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_face_detections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "hv_face_detections_project_idx" ON "hv_face_detections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "hv_face_detections_unposted_idx" ON "hv_face_detections" USING btree ("posted_at");--> statement-breakpoint
CREATE POLICY "hv_face_detections_api_read" ON "hv_face_detections" AS PERMISSIVE FOR SELECT TO "hv_api" USING ("hv_face_detections"."project_id" = current_setting('hv.project_id', true));--> statement-breakpoint
CREATE POLICY "hv_face_detections_api_insert" ON "hv_face_detections" AS PERMISSIVE FOR INSERT TO "hv_api" WITH CHECK ("hv_face_detections"."project_id" = current_setting('hv.project_id', true) AND coalesce(current_setting('hv.project_id', true), '') <> '');--> statement-breakpoint
CREATE POLICY "hv_face_detections_api_update" ON "hv_face_detections" AS PERMISSIVE FOR UPDATE TO "hv_api" USING ("hv_face_detections"."project_id" = current_setting('hv.project_id', true)) WITH CHECK ("hv_face_detections"."project_id" = current_setting('hv.project_id', true) AND coalesce(current_setting('hv.project_id', true), '') <> '');--> statement-breakpoint
CREATE POLICY "hv_face_detections_worker" ON "hv_face_detections" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "hv_face_detections" TO hv_api, hv_worker;
