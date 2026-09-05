GRANT USAGE ON SCHEMA public TO hv_api, hv_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON hv_projects, hv_reviews, hv_jobs, hv_provider_attempts, hv_outbox, hv_artifacts, hv_archives TO hv_api, hv_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON hv_budget_accounts, hv_reservations TO hv_api, hv_worker;
--> statement-breakpoint
GRANT SELECT ON hv_cost_events, hv_workers TO hv_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON hv_cost_events, hv_workers, hv_operator_reviews TO hv_worker;
--> statement-breakpoint
ALTER TABLE hv_projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hv_reviews FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hv_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hv_provider_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hv_outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hv_artifacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE hv_archives FORCE ROW LEVEL SECURITY;
