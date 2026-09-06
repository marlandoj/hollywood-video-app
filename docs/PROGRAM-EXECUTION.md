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

Local continuation, 2026-09-06 UTC: the operator requested continued local work while Zo is unreachable. The last verified live application release was PR 18 merge `dbc766fa2efd16bb9bd3caff51d9dbbfd5e66d4d`. Protected trace/metric exploration merged through PR 20 as `4f91b7569409d5070e06d6025055dad7edae036a` after quality, benchmark and real telemetry-backend contract CI passed. Deployment and Linear reconciliation wait for Zo access. PR 19 separately holds encrypted off-host backup transport and verified copy evidence; an independent database/media restore from that desktop copy is still pending. No restored database/bucket has been created for that drill. The older storage checkpoint below records its contemporaneous release and counts.

- PR #9 (T1/T2 image providers) merged into main 39ae2b6 after quality and benchmark passed.
- HV-018 T1-T5 delivered through PRs #9, #10 and #11.
- Full Spud mock and live-image evaluations pass in isolation and managed staging.
  Rich preview: 24 clips, 601.967 seconds; recorded spend $0.144 total, no open reservations.
  Browser playback/captions, storyboard navigation, request-changes and final approval/export verified.
- Rollback drill retained all spending events; private rollout uses immutable release pointers.
- Storage foundation PR #12 merged as 02e550f after quality and benchmark checks passed.
- Backups restored all 12 tables and 491 objects; manual service recovery passed after a Zo reset.
- Worker lifecycle PR #13 merged as af67a44 after quality and benchmark checks passed.
- Operational storage PR #14 merged as 7036fd6; rollback/release preservation fixes in PR #15 merged as 489621e. Full CI passed for both.
- Private staging now runs immutable 489621edd1ffe9027228ee230dd2e390490ac445 on PostgreSQL/S3 with three managed workers and scheduled 120-second backups.
- Final storage: hollywood_video_staging_v4 / rough-cut-staging-v4. It contains 12 projects, 24 jobs, 240 cost events and 601 artifact records; recorded spend remains $0.144, reservations $0.
- Three managed processes completed three animatics and three approved mock finals. Original Spud and new MP4 ranges/HLS/captions passed after migration and service recovery.
- Current-state rollback, new work on JSON, immutable-snapshot isolation, storage-aware code upgrade and return to PostgreSQL all passed. Historical source directories/databases remain intact.
- A simulated loss of five owned service registrations recovered through API startup in 22.69 seconds with unchanged data totals. This was not a host/disk-loss test.
- Two live scheduled backup cycles and dump/object checksums passed for the final 601-object data set. Backups remain on this host; off-host recovery, continuous WAL and production RPO/availability evidence remain open.
- HV-019 admitted capability plans, per-attempt routing, circuit health, exact dispatch binding, per-shot accounting and export provenance merged through PR 21 as `f4726acc6f26ca8a5122cffe69ed8c87c7005826`. Quality, telemetry-contract and benchmark CI passed (run 34011662490; 288 unit/integration tests passed). See PROVIDER-ROUTING.md for remaining scope. The existing Veo 3 Fast endpoint is marked retired following the vendor documentation check; no replacement paid endpoint is substituted. This release has not been deployed to Zo.
- HV-017 versioned fictional-character direction, scoped permission, cast-bound previews/approvals/finals and per-dispatch revocation merged through PR 22 as `d1b55db8ded2282693c1ecc754f7ef6dde8a7db5`. Source CI 34013922069 passed quality, telemetry and benchmark checks, including 306 unit/integration tests. This release has not been deployed to Zo.
- HV-017 private reference intake, hashed cast assets, backup/archive preservation and opt-in FLUX.2/Kling O3 reference transport merged through PR 23 as `b008808d8ea2ce18ee856ce3b6ae7d42c8f962e9`. CI 34016000089 passed quality, telemetry and benchmark checks, including 315 unit/integration tests. Closed HTTP fixtures and browser checks preserve reference bytes through preview/approval/final with no paid inference. See CASTING.md and REFERENCE-PROVIDERS.md. A named-person probe exposed a gap in the existing keyword safety filter; evaluated semantic/likeness and image moderation remain launch requirements. This release is not deployed to Zo.
- HV-017 generated sheets and explicit batch adoption merged through PR 24 as `78af687b1f94a44372c6262cc85bda561803e361`. CI 34018052382 passed all checks, including 325 unit/integration tests. See CHARACTER-SHEETS.md for migration 0006 and evaluation limits. This release is not deployed to Zo.
- HV-017 private actor sharing/import merged through PR 25 as `4e56afe031e7cf7f83c65dbeb755aed879737835`. CI 34020068421 passed all checks, including 336 unit/integration tests. Independent image copies, fresh destination permission and explicit costume presets are verified in ACTOR-LIBRARY.md. This does not complete the identity epic or provide permanent global actor storage, and is not deployed to Zo.
- HV-020 source-bound shot direction merged through PR 26 as `2ff4658e97e7aa5de9f1cc69c4d608212522b1d3`. CI 34022029857 passed all checks, including 346 tests. SHOT-DIRECTION.md records fixed timing, storyboard motion, creative camera/lighting/performance instructions, approval and recovery boundaries. This release is not deployed to Zo.
- HV-020 declared coverage and advisory axis/eyeline checks merged through PR 27 as `38806586ab59ad89cbaa114db182c99daaf64c36`. CI 34023086119 passed all checks, including 350 tests. COVERAGE.md records unknowns, deliberate-change notes and immutable provenance. This release is not deployed to Zo.
- HV-020 viewfinder and editable camera presets merged through PR 28 as `9416b0f9b235c6e681321f6e776aa685d5211e93`. CI 34025138673 passed all checks, including 360 tests. VIEWFINDER.md records actual crops, modeled optical angles and preserved source images. This release is not deployed to Zo.
- HV-020 private frame anchors merged through PR 29 as `4a4772a75d9d9415cda002fc81c9b015d53e0508`. CI 34028232150 passed all checks, including 373 tests. FRAME-ANCHORS.md records provided-image storyboards, opt-in native first/last dispatch, endpoint-preserving timing and explicit fallback. This release is not deployed to Zo.
- PR 30 merged A/B/C shot take plans, independent preview/final exports, per-take costs, synchronized comparison and explicit direction/seed adoption as `bce467f239d6cafc2c97ccd0172b06df9acb6bf9` after 379 tests passed. See SHOT-TAKES.md.
- PR 31 merged timed screen-space camera framing as `32d668a7186824a788bc78395bc37a5196fa7bc1` after 387 tests passed. See CAMERA-PATHS.md.
- PR 32 merged the local Wan-Move input compiler/verifier and targeted safety-gate regression fix as `24ef7fdb3fb0773cea70326c45a50e749816ba1c` after 397 tests passed (CI 34034886436), including independent NumPy interoperability.
- The next subject-motion increment adds private source preparation, a point/keyframe editor, project persistence and owner-only native-input exports. Plans bind source, script, cast and direction revisions and remain separate from film rendering. See SUBJECT-MOTION.md for contracts, rollback cautions and the provider investigation. Native subject rendering, native camera trajectories, native intermediate anchors, automatic coverage proposals/selective regeneration and physical optics simulation remain open. Live rollout and actual paid quality evaluation await access.
  This increment merged through PR 33 as `759d7e9b8d13992658bc4fa968ecd27834bc932e` after 403 tests passed (CI 34037233159).
- Selective regeneration now adds verified reuse of unchanged film shots, explicit forced fresh IDs, independent media copies, per-shot provenance and recovery checks. See SELECTIVE-RENDERING.md for admission, permissions, accounting and archive contracts. Automatic coverage generation still needs ordered screenplay beats and proposal acceptance; it must not rearrange action/dialogue or silently invent coverage declarations.
- Selective regeneration merged through PR 34 as `2263798ea1673351fad2bdfcdd16b91424809939`; CI 34039122411 passed 409 tests. The next increment adds ordered scene-cut proposals, editable/replayable directing notes, explicit owner acceptance and a shared source compiler across film generation and recovery. See SCENE-CUTS.md. This addresses scene coverage and selective edits; native rendering and the wider studio program remain open.
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
