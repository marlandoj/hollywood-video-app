ALTER TABLE "hv_jobs" DROP CONSTRAINT "hv_jobs_stage_check";--> statement-breakpoint
ALTER TABLE "hv_jobs" ADD CONSTRAINT "hv_jobs_stage_check" CHECK ("hv_jobs"."stage" in ('animatic','final','character-sheet','take-preview','take-final','dialogue-replacement','audio-take','lip-sync'));--> statement-breakpoint
CREATE UNIQUE INDEX "hv_lipsync_attempt_job_idx" ON "hv_provider_attempts" ("job_id") WHERE "body" ? 'lipSync';
