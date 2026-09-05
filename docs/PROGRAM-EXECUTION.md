# Hollywood Video execution record

Operator authorization, 2026-09-05: proceed with all aspects end to end from desktop Codex,
including implementation, integration, checks, merges and deployment. Routine development
and rollout decisions no longer await separate per-step confirmation. Existing safety,
free anonymous access, cost caps and truthful evidence requirements remain product requirements.
Legal name clearance and counsel review require actual external evidence.

Canonical scope is the full AAA studio program copied to FULL-SCOPE.md, not merely HV-018.
The $500 Wave B evaluation envelope is retained as the current explicit spending allocation.
No user charges, account requirements, safety weakening, or fabricated launch evidence.

## Current execution

- PR #9 (T1/T2 image providers) merged into main 39ae2b6 after quality and benchmark passed.
- HV-018 T1-T5 delivered through PRs #9, #10 and #11; deployed main 12bde2a.
- Full Spud mock and live-image evaluations pass in isolation and managed staging.
  Rich preview: 24 clips, 601.967 seconds; recorded spend $0.144 total, no open reservations.
  Browser playback/captions, storyboard navigation, request-changes and final approval/export verified.
- Rollback drill retained all spending events; private rollout uses immutable release pointers.
- Storage foundation PR #12 merged as 02e550f after quality and benchmark checks passed.
- Backups restored all 12 tables and 491 objects; manual service recovery passed after a Zo reset.
- Worker lifecycle PR #13 merged as af67a44 after quality and benchmark checks passed.
- Private staging now runs af67a44 with its existing JSON/local backend; managed mock and original Spud delivery pass.
- Active branch: codex/ZOU-1609-cutover.
- Active milestone: Wave A HV-040 PostgreSQL/S3 storage, with HV-038 observability and HV-032 three-worker foundation.
- Intake acceptance, rollback, observability and cost contract: docs/factory/hv-040-storage-seed.yaml.
- Next wave B: HV-019 capability router, HV-017 character identity, HV-020 cinematography.
- Wave C: HV-022 voices/performance, HV-024 sound, HV-028 localization.
- Wave D: HV-023 editorial timeline, HV-016 screenplay, HV-021 continuity, HV-026 color.
- Wave E: HV-025 VFX/titles, HV-027 delivery, HV-031 provenance/rights, HV-039 accessibility.
- Wave F: HV-029 collaboration, HV-030 director loop, HV-034 universe, HV-037 benchmarks.
- Wave G: HV-033 API/CLI/MCP/SDK, HV-032 GPU lane, HV-035 previs, HV-036 immersive.
- Wave H: launch preparation and external gates, public free access once all launch evidence exists.

Do not mark epics complete for contracts or scaffolding alone. Each milestone needs exercised
application routes, persisted state, failure behavior, tests and user-facing evidence.
Commit progress in the application repository: standalone Zo notes can be lost on restart.
