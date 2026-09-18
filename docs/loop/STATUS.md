# Program status board

Machine-read by `scripts/loop/status.ts`. Status values: `todo`, `in_progress`, `review` (all increments merged, awaiting operator ack, gate G6), `done`, `deferred`. Foundation epics HV-000..HV-015 are treated as satisfied. Order is execution priority.

| Epic | Title | Depends on | Status | Increments merged | Last commit | Evidence |
|---|---|---|---|---|---|---|
| HV-040 | Storage and Archive at Scale | - | done | 5 | 22f0113 | STORAGE-*.md (deferred register in STORAGE-DEPLOYMENT.md), docs/evidence/hv040-storage (wave-a-exit.json: satisfied) |
| HV-038 | Observability, Reliability, Multi-region | - | done | 5 | 5ac93f1 | OBSERVABILITY.md (deferred register), docs/evidence/hv038-observability (observability-exit.json 2026-09-18: 7/9 blocks recorded, telemetryRuntime and metrics pending, `instrumented: false` -- the exit claim is withdrawn while Prometheus is down on staging, G9-202609181900; availability SLI defined, not claimed) |
| HV-019 | Multi-provider Generation Router | - | in_progress | 3 | b11d6b5 | PROVIDER-ROUTING.md (P5 gap register), PROVIDER-RECEIPTS.md, docs/evidence/hv019-router (adapter-conformance.json), docs/evidence/hv019-performance (capability-revision-pins.json) |
| HV-017 | Character Identity Engine and Digital Actors | HV-019 | in_progress | 0 | | CASTING.md, CHARACTER-SHEETS.md, ACTOR-LIBRARY.md |
| HV-018 | Storyboard and Rich Animatic | HV-019 | in_progress | 0 | | docs/evidence/hv018-rich-animatic |
| HV-020 | Cinematography Control | HV-019 | in_progress | 0 | | SHOT-DIRECTION.md, COVERAGE.md, VIEWFINDER.md, FRAME-ANCHORS.md, SHOT-TAKES.md, CAMERA-PATHS.md |
| HV-023 | Editorial NLE | - | in_progress | 0 | | PICTURE-EDITORIAL.md, EDITORIAL-*.md, SCENE-CUTS.md |
| HV-016 | Writers' Room and Living Screenplay | HV-023 | in_progress | 0 | | LIVING-SCREENPLAY*.md, CURRENT-FILM-*.md |
| HV-022 | Performance: Voice, Dialogue, Lip-sync, ADR | HV-017, HV-019 | in_progress | 0 | | CHARACTER-VOICES.md, LIP-SYNC.md, NATIVE-VOICE-PERFORMANCE.md, DIALOGUE-REPLACEMENT.md |
| HV-024 | Sound Department | HV-023 | in_progress | 1 | 4582e7e | SOUND-*.md, NARRATION-MIX.md, docs/evidence/hv024-sound |
| HV-025 | VFX and Motion Graphics | HV-023 | in_progress | 2 | b7f104a | MOTION-GRAPHICS.md, GRAPHIC-STUDIO.md, EDITORIAL-MASKS.md, docs/evidence/hv025-graphics, packages/generator/test/fixtures/graphic-receipt-foreign-runtime.json, packages/generator/test/graphic-runtime-binding.test.ts (a retained graphic receipt is validated as evidence, not re-bound to the validating host at every read; host qualification moved to render admission through one exercised seam) |
| HV-021 | Continuity Supervisor | HV-017 | todo | 0 | | |
| HV-026 | Color and Finishing | HV-023 | todo | 0 | | |
| HV-027 | Delivery Suite | HV-026 | todo | 0 | | |
| HV-028 | Localization and Dubbing | HV-022 | in_progress | 0 | | MULTILINGUAL-DIALOGUE.md |
| HV-031 | Provenance and Rights | - | in_progress | 3 | 1a86ded | packages/queue/test/generation-revocation.test.ts, packages/storage/test/generation-revocation.test.ts (takedown stops queued and running generation in one transaction), packages/planner/src/provenance.ts, packages/planner/test/provenance.test.ts (the provenance manifest carries the real assembly instant, refused at the write boundary if absent or a placeholder; spec, issuer, credential type and claim declared once), packages/storage/test/takedown-record.test.ts (a tombstoned project keeps a takedown record with a non-empty reason through export, validation, restore and the retention sweep; five refusals cross-check the tombstones against the log in both directions) |
| HV-029 | Collaboration Studio | - | in_progress | 4 | 93b5095 | packages/api/test/review-binding.test.ts (one permission gate for every review link, not only for links that happen to name a cut; the first passing view fixes the link to what it showed; a decision needs a cut to be about), packages/api/test/artifact-permission.test.ts (the media path asks one question answered by the job's stage, total at compile time and denying at run time, instead of six gates each reached only when the job carried a particular optional field; a silent cut's media was served with no permission check at all), packages/api/test/job-view-permission.test.ts (the views that hand out those links ask the same question by stage, through a parameter no display path can forget; a revoked cut's view carries no /artifacts/ link at any depth and says why; the take, sheet and graphic listings had no check of any kind) |
| HV-039 | Accessibility and Mobile Review | HV-029 | in_progress | 3 | b65e667 | packages/frontend/src/tokens.css, packages/frontend/test/contrast.test.ts (1.4.3 and 1.4.11 on 22 token pairs), packages/frontend/src/busy.js, packages/frontend/test/busy.test.js, packages/api/test/frontend-modules.test.ts (4.1.3 status messages: aria-busy no longer covers any live region, in one helper for eleven call sites), packages/frontend/src/mask-viewport.js, packages/frontend/test/mask-viewport-a11y.test.js (4.1.2: the mask viewport is a widget with a name, a description and a live value, not a role="img" canvas operated by arrow keys; no frontend element may pair a static role with keyboard interaction; the rest of 2.2 AA is unaudited) |
| HV-034 | Universe and Library | HV-017 | in_progress | 1 | 39bfb24 | packages/planner/test/actor-share-presets.test.ts (an imported costume preset's name is built by the one function both the share mint and the import use, and the mint asks the validator that will read it back rather than counting; a scene heading carrying a control character used to mint a share no one could ever import, permanently) |
| HV-037 | Studio Benchmark and Public Leaderboard | HV-019 | in_progress | 1 | 3462a6c | packages/benchmarks/test/metric-classification.test.ts (every metric classified in one table beside the type; compare.ts derives its four key arrays from it and names no metric as a literal; cost and quality gates carry an absolute floor as well as the 5% band) |
| HV-032 | Capacity and Render Farm | HV-040 | in_progress | 2 | 16b0123 | docs/WORKER-FLEET.md, packages/queue/test/dead-letter.test.ts, packages/storage/test/dead-letter.test.ts (stalled-lease terminus at 5 lapses without progress; notification list bounded at 256 in one writer), packages/operator/test/fair-share-window.test.ts, packages/queue/test/fair-share-wiring.test.ts, packages/storage/test/fair-share-window.test.ts (fair-share weight windowed at 24h in one declaration, equal across both cost ledgers, and proved to reach both job stores) |
| HV-033 | Platform SDK | HV-032 | todo | 0 | | |
| HV-030 | AI Crew Agents and Director Loop | HV-016, HV-020, HV-023 | todo | 0 | | |
| HV-035 | 3D Previs and Virtual Production Export | HV-020 | todo | 0 | | |
| HV-036 | Interactive and Immersive Formats | HV-027 | todo | 0 | | |

"Increments merged" counts only loop increments (docs/loop/increments/). Work merged before the loop (PR #1–#82) is credited in the Evidence column and re-verified by the first planner pass for each epic.

## External gates (ADR-0020, outside loop authority)

| Gate | Status | Evidence |
|---|---|---|
| Name clearance | open | docs/adr/ADR-HV-001-name-clearance-status.md |
| Counsel review of TOS / content policy | open | docs/legal/*-DRAFT.md |
| Beta cohort | open | |
| Load / penetration test | open | |
| Public deployment approval | open | |
