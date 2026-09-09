# Private same-call cast-current batch candidate

Unapplied, untyped, and unexecuted. The builder reads two product files and writes only this private directory. No permission cache, checked-value export, deadline change, skipped scene, or direction/materialization optimization.

`renderCurrentScreenplay` currently validates the complete cast review initially and again for each scene. Each per-scene guard also clones and traverses the complete review/current snapshot. This candidate retains the initial render validation and replaces the per-scene loop with one bounded complete-scene batch. For N scenes, historical review validation inside this path falls from N+1 invocations to two. This is a source-level count, not a measured speedup.

The existing standalone `assertLivingScriptCastRebindCurrent` keeps its original portable envelope, validation order, error strings, and fresh per-character permission checks. Its common validation and scene checks are factored into private synchronous helpers. The new batch validates/detaches the full inputs once, requires every after-document scene exactly once in order, and runs the same proposed/current grant checks for each scene at this call's supplied `now`. It returns no reusable checked state. The renderer still derives character membership from actual cast shots, retains empty-character scenes, and does not mutate the source/current snapshots.

## Targeted qualification plan (not run)

1. Keep the existing standalone `living-script-cast-rebind.test.ts` tests unchanged, especially pending/accepted moved-scene grants, same-text introduced scenes, revocation/expiry, stale casting, wrong physical heading, duplicate character IDs, and getter refusal.
2. Reuse its actual pure constructor fixture (two scenes with ALICE and a moved scene). Compare standalone-loop and batch outcomes for pending and accepted baselines, including a character present only in the last scene. Removing/moving a scene entry, duplicating a scene number, or changing a last-scene character must refuse.
3. Warm a successful batch, then call again with fresh revoked casting, expired time, changed document revision, or changed current scene heading; all must refuse. No previous success grants subsequent authority.
4. Introduce accessors/hidden fields in the review, current casting, scene row, and character array; invocation count stays zero. Sparse arrays, own undefined, capacity overflow and malformed scene shapes remain refused by the existing portable boundary.
5. Compare complete `renderCurrentScreenplay` outputs against the original implementation using existing current-film compiler/authority fixtures. Check input/current objects remain unchanged on both success and refusal. Run the existing current-plan/direction/cast and mixed-authority suites after application, then whole-tree typecheck/lint under root's serial test schedule.

The batch envelope adds the bounded scene list to the same 128 MiB/2.5M-node/depth180 portable budget. Near an exact capacity ceiling it may refuse sooner than separate per-scene calls; it never truncates or raises limits. No whole-worker improvement is claimed before profiling.
