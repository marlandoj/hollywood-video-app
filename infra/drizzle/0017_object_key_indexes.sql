CREATE INDEX "hv_artifacts_object_key_idx" ON "hv_artifacts" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "hv_archives_object_key_idx" ON "hv_archives" USING btree ("object_key");
