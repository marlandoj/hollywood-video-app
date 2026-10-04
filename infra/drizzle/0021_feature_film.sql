-- HV-030-30: a feature's sequences joined into one film are a job of their own stage, `feature-film`.
-- Additive only: the stage check gains one value; no row, column, table or privilege changes.
ALTER TABLE "hv_jobs" DROP CONSTRAINT "hv_jobs_stage_check";--> statement-breakpoint
ALTER TABLE "hv_jobs" ADD CONSTRAINT "hv_jobs_stage_check" CHECK ("hv_jobs"."stage" in ('animatic','final','character-sheet','take-preview','take-final','dialogue-replacement','audio-take','lip-sync','sound-mix','picture-edit','motion-graphic','assembly-edit','delivery','feature-film'));
