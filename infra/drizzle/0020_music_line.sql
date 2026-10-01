-- HV-024-11 (G15): the generated-music line's cues. Additive only: one new table, no existing row touched.
CREATE TABLE "hv_music_cues" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"month" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"held_usd" numeric(16, 6) NOT NULL,
	"actual_usd" numeric(16, 6),
	"alerts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asset_id" text,
	CONSTRAINT "hv_music_cues_status_check" CHECK ("hv_music_cues"."status" in ('held','unreconciled','settled','released')),
	CONSTRAINT "hv_music_cues_money_check" CHECK ("hv_music_cues"."held_usd" >= 0 and ("hv_music_cues"."actual_usd" is null or ("hv_music_cues"."actual_usd" >= 0 and "hv_music_cues"."actual_usd" <= "hv_music_cues"."held_usd")))
);
--> statement-breakpoint
ALTER TABLE "hv_music_cues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hv_music_cues" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "hv_music_cues_month_idx" ON "hv_music_cues" USING btree ("month");--> statement-breakpoint
CREATE POLICY "hv_music_cues_api_read" ON "hv_music_cues" AS PERMISSIVE FOR SELECT TO "hv_api" USING (true);--> statement-breakpoint
CREATE POLICY "hv_music_cues_api_insert" ON "hv_music_cues" AS PERMISSIVE FOR INSERT TO "hv_api" WITH CHECK ("hv_music_cues"."project_id" = current_setting('hv.project_id', true) AND coalesce(current_setting('hv.project_id', true), '') <> '');--> statement-breakpoint
CREATE POLICY "hv_music_cues_api_update" ON "hv_music_cues" AS PERMISSIVE FOR UPDATE TO "hv_api" USING ("hv_music_cues"."project_id" = current_setting('hv.project_id', true)) WITH CHECK ("hv_music_cues"."project_id" = current_setting('hv.project_id', true) AND coalesce(current_setting('hv.project_id', true), '') <> '');--> statement-breakpoint
CREATE POLICY "hv_music_cues_worker" ON "hv_music_cues" AS PERMISSIVE FOR ALL TO "hv_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "hv_music_cues" TO hv_api, hv_worker;
