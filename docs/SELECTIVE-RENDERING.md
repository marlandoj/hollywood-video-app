# Selective film regeneration

Film previews and finals can reuse verified unchanged shots from earlier completed renders in the same project. The private creator's **Render options** enable reuse by default and accept comma-separated shot IDs to force fresh rendering. Turning reuse off requests fresh shots throughout. The API opts in with `reuseUnchanged: true` and an optional `forceShotIds` array on the existing job route. Existing callers that omit the option keep fresh-render behavior. Sheet and take-group jobs retain their separate workflows.

The new cut still requires the normal current-screenplay preview and explicit approval before final generation. Reuse does not adopt or approve an earlier whole cut. The result identifies fresh and reused shot counts and lists reused shot IDs. Requested points from the subject-motion workbench remain input preparation only and are not applied to film generation by this feature.

## Eligibility and evidence

New film renders with an admitted provider plan record a per-shot input hash and exact video/poster/source-poster checksums. The hash includes the project, render stage, tier, provider-plan revision, scene heading, source and directed prompts, dialogue, seed, duration, character IDs, private reference entries and normalized shot settings. Global screenplay/cast/direction version numbers do not invalidate otherwise identical shot inputs; changing their effective per-shot content does. Preview clips cannot substitute for final video, and another project's clips cannot be selected. Legacy results without verified shot records are rendered fresh.

`SHOT_RENDER_ENGINE` in `packages/planner/src/shot-reuse.ts` versions rendering behavior not represented by a provider capability snapshot. Bump it when changing prompt assembly, narration, captioning, camera/image processing or other clip-generation semantics. The hash is an input-comparison contract, not a promise of deterministic external model execution or a visual quality score. Reusing an existing result deliberately preserves those earlier bytes.

At admission, `hv-shot-reuse/1` pins exact source render records and explicitly forced IDs. Each source must be a finished, unexpired film job in the same project, contain the selected record, and reproduce the recorded input hash from its immutable render context. The worker checks those bindings again. It checks current project retention, cast permission and frame-anchor catalog before and after copying, and before publishing/completing the assembled cut. PostgreSQL checks use project scope, job lease fencing and current permission data.

Each reused file is streamed into an independent file under the destination job, bounded by its recorded byte count and checked against SHA-256. S3 reads require matching database/object metadata and streamed checksums. Local sources must be regular files inside their own job directory. No cross-project path, symlink or arbitrary remote URL is admitted. If selected media is missing or fails verification, the job stops with instructions to disable reuse and retry; it does not silently dispatch a replacement paid request. Checkpointed copies are verified again after worker recovery.

## Provenance, costs and continuity

`hv-shot-render/1` records are stored with clips, completed job output and export provenance. They bind the actual clip metadata and all owned media paths/hashes. Reused records preserve the originating job/shot and the immediate source record revision. Each destination owns its copied media, so completed output has no playback dependency on the source job's files. Original billing events stay with the original job. Reuse creates no provider attempt or new generation cost event; assembly and storage still consume local resources.

Admission excludes selected reusable shots from generation estimates. A fully reused job reserves zero generation spend. Mixed jobs retain the existing conservative stage reservation/cap to cover repairs of freshly rendered shots; they do not reserve zero for those remaining requests. Existing capacity, queue, monthly budget and free/elevated shot limits remain in force.

Assembly rebuilds transitions, captions, HLS and the film manifest for the current cut. The existing advisory continuity check runs across reused clips and their current neighbors. A changed neighbor does not silently regenerate an otherwise unchanged shot; a failing advisory check is flagged for review. This check compares existing synthetic fingerprints and does not establish calibrated visual continuity.

## Persistence and verification

No SQL migration is needed: the admission plan and completed records live in existing job JSON. PostgreSQL/S3 checkpoints preserve independent copied media and provenance. Snapshot validation checks each completed record against the admitted shot inputs and reuse origin. Artifact restore/import compares recorded media hashes with storage metadata. Portable project archives carry both source and reused jobs, plans and copied files. Use a reuse-aware API/worker release together; older workers do not execute this admission contract and must not consume newly admitted reuse jobs.

Tests cover changed-shot preview/final generation, current approval, forced fresh IDs, unrelated screenplay revisions, incompatible tiers, owner isolation, exact media copying, zero new provider events for reused shots, malformed inputs, source corruption, permission changes during copy, interrupted-worker resume and checkpoint tampering. PostgreSQL/S3 archive integration exercises reuse after the source worker cache has been removed and restores exact independently owned bytes.

Browser validation and full CI evidence are recorded in the execution checkpoint. Fixtures use mock media; paid inference and Zo rollout remain pending access. This completes the selective reuse workflow for the existing shot plan. Automatic scene coverage proposals, ordered screenplay beats, proposal acceptance/replay and calibrated visual continuity remain within the full studio scope.
