# Project paused at the owner's request — 9 September 2026

Development is paused. Resume only when the owner requests it. This branch is a work-in-progress checkpoint, not a completed milestone or a production release. No merge or deployment is authorized by this checkpoint.

## GitHub checkpoint

- Working branch: `codex/HV-current-mixed-source-v4` in `marlandoj/hollywood-video-app`.
- The branch contains the internal mixed-film source implementation (`28f94da`), the parent checkpoint diagnostic (`ba2a962`, equivalent to parent branch `92abf79`), and the saved public editing/recovery overlay.
- Parent work remains on `codex/HV-current-mixed-worker`, draft PR [83](https://github.com/marlandoj/hollywood-video-app/pull/83), head `92abf79f12f32bd436ce9bdde31fb8590d516714`.
- Parent CI [34355859930](https://github.com/marlandoj/hollywood-video-app/actions/runs/34355859930) was cancelled intentionally for this pause. Graphics and telemetry had passed; quality integration had not finished. Cancellation is not qualification.
- All other local worktrees were clean at the pause audit. After fetching all remote branch references, only the two source-four branch commits above were unpublished before this checkpoint push. The existing private local stash is preserved separately.

## Saved implementation and verified behavior

The current overlay adds public mixed-film source editing, library version 2, schema 16 snapshots, nested retained proof ownership, native receipt verification and archive validation. It includes genuine final/legacy/HTTP/service recovery fixtures and an optional local browser capture helper. Queue persistence now writes compact JSON; locking, fresh reads and atomic renames remain intact.

Completed checks before the pause:

| Check | Result |
| --- | --- |
| Public navigation and source inspection | 13 tests, 213 assertions; 728.829 seconds |
| Public owner API | 4 tests, 286 assertions; 151.031 seconds |
| Python archive suites | 77 passes, one Windows symlink skip |
| State/front-end focused checks | 11 tests, 103 assertions |
| Internal native mixed-source checks, earlier internal tree | 22 passes; 859.562 seconds |
| Legacy compatibility, earlier internal tree | 8 tests, 104 assertions; 53.437 seconds |
| Compact durable queue regressions | 27 tests, 132 assertions; 5.579 seconds |
| Final source tree static checks | Typecheck, lint, build and whitespace passed in 26.703 seconds |

These checks cover different recorded trees. The archived result/input manifests identify the exact tested inputs; they do not establish an all-green release tree.

## Current failure and next engineering step

The actual final-source recovery suite failed twice because its prerequisite mixed preview reached the existing 600-second worker deadline. Most recently, run `current-film-source-v4-compact-final-stage-native` took 628.906 seconds, with all 717 recorded source/test inputs unchanged. The real worker returned failed after 601.676 seconds and produced no completed output. The test runner reported 3 passes/28 failures; one of those passes only means the worker returned, and 27 failures are dependent phase guards. No final render, owner capture, archive restore or browser qualification followed.

Measured stages included proof preparation 239.266 seconds, origins copying 135.221 seconds, mixed verification 115.362 seconds and adoption copying 80.234 seconds. Nested stage totals overlap. Fresh authority checks dominate measured work; queue reload/persist work was approximately 26.74 seconds. Compact JSON reduced serialized bytes substantially, but did not solve the worker timeout.

The next candidate removes repeated cast-review validation within one render call while preserving each scene's fresh permission checks. Its draft is **not applied**. Independent review found an aggregate capacity compatibility gap; implement a bounded fallback preserving the existing per-scene accepted domain, add meaningful regressions, and measure the actual effect before promotion or another expensive full run. Do not cache current rights, widen worker deadlines, or replace durable storage with an in-memory fixture to make tests pass.

The attempted standalone authority profile is not a usable baseline: the actual historical proof project deliberately excludes current rights/retention, so authority correctly refused it. Profile rendering metadata independently or capture an actual authorized input during a genuine future run; do not invent authority fields.

## Resume sequence

1. Read this checkpoint and the [draft/evidence manifest](work-in-progress/2026-09-09/manifest.json). Confirm local/remote branch identity and preserve existing private state.
2. Finish, review and measure the cast-validation candidate. Run relevant existing cast/current-render/authority regressions and full static checks after any application.
3. Re-run the genuine final recovery under unchanged deadlines, with one heavy local run at a time. Require actual completed preview and final outputs, native verification, legacy wrapper, HTTP save/restart and independent carrier-only archive results.
4. Obtain a new actual ready A/B capture before using browser launcher/restorer drafts. Neither attempted capture became ready. Review paths and hashes, typecheck the private scripts, use supported archive pack/unpack and the original authenticated owner flow, then qualify browser navigation, saves, conflicts and restart.
5. Re-run parent exact-head PostgreSQL/S3 CI. The preceding failed run's initial service assertion was hidden; `92abf79` preserves that original error for the next run and does not claim to fix it. Qualify the new 17-phase final service fixture, downstream checks and the eventual merge tree before merging.
6. Continue the approved structural screenplay/cut round trip and the full P1–P18 scope. The current editing milestone is only part of that goal; the complete project remains unfinished.

## Local-only material

The original workspace has `work/recovery` diagnostics, raw actual-return payloads and large native media under `H:/CodexTemp`. Credentials, owner-token sidecars, runtime binaries and private identity data are not in GitHub. Preserve the existing original browser fixture and private stash; do not reuse its old state as evidence for the new source-four implementation. Zo access remains deferred under the owner's instruction to continue locally.

The [non-executable draft archive](work-in-progress/2026-09-09/README.md) includes source scripts, exact candidate patches, relevant designs, broad scope/estimate notes and selected safe result manifests. Their old status headers describe when each draft was created; this checkpoint is the authoritative pause status.
