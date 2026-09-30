-- HV-031-12 (G4, approved 2026-09-30 as G15): ordinary retention expiry is recorded as expiry,
-- not as a takedown. Additive only: the takedown columns are untouched, and no existing row is
-- rewritten -- rows the sweeper already stamped "content removed" are reported read-only by
-- scripts/report-expiry-takedowns.ts, and correcting them is a separate decision.
ALTER TABLE "hv_projects" ADD COLUMN "expired_at" timestamp with time zone;
