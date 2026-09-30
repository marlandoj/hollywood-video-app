# Rough Cut — progress

Updated 2026-09-30 (UTC). The loop board, `docs/loop/STATUS.md`, is the machine-read record; this
page is the human summary. Current release: **Release 2 — "Voice and crew depth"** (`docs/ROADMAP.md`).

## Where things stand

- **Staging:** private desktop staging (`docs/STAGING-LOCAL.md`) is healthy on main and redeployed
  after each batch of merges. Nothing is public (ADR-0020).
- **Spend:** $16.846 of the $500 paid cap. No work since 2026-09-17 has called a paid provider.
- **Pace:** 2026-09-28 to 2026-09-30, more than 60 increments were merged, each its own PR with CI green
  on its exact head. Most were defects found by adversarial review of Release 1 and 2 code:
  - money paths: zero-cost admissions, holds, retry keys that double-charged;
  - safety gates;
  - retention and review-link withdrawal;
  - screenplay parsing;
  - accessibility and focus, and late-reply races in the panels.

## Release 2 slices

The status column is what is on main today. "Gated" means it needs a human gate before the loop may
build it: G3 is a new vendor, G14 is ElevenLabs, G4 is a migration, G6 is the release acknowledgement.

| Epic | Release 2 slice | Status |
|---|---|---|
| HV-016 Writers' Room | FDX and PDF import; crew-suggested revisions accepted line by line | Import done (plus hardening HV-016-12..22). Living-screenplay proposals built. Mixed-film rebuild of PR #83 in progress (below). |
| HV-017 Character Identity | Identity locks beyond per-shot references; a cast library | Locked looks and the actor library are built (10 increments). |
| HV-021 Continuity | Drift detection and one-click repair | Continuity report and repair are built (6 increments). |
| HV-022 Performance | ElevenLabs primary, Azure behind it, on its own $25 line | The vendor line and its accounting across projects are built. Live use needs G14 and the key on the host. |
| HV-024 Sound | Generated music, SFX and ambience | **Gated (G3).** Today the Composer's score is deterministic and uses no vendor. Sound mixing is built. |
| HV-026 Color and Finishing | Grade, LUTs, QC checks (ffmpeg only) | Picture QC is built. **Grade and LUTs are not built yet.** |
| HV-027 Delivery | 9:16/1:1 reframes, burned subtitles, SDH, mezzanine | Reframes and mezzanine are built (14 increments). **Burned subtitles and SDH are not built yet.** |
| HV-029 Collaboration | Timecoded comments, per-stage approvals | Review links with view limits, decisions and withdrawal are built. **Timecoded comments and per-stage approvals are not built yet.** |
| HV-030 AI Crew | Voice meetings (GPT-Live-1); crew memory of a creator's style | **Voice meetings are gated (G3).** The crew conversation and plan are built. **Crew memory is not built yet.** |
| HV-031 Provenance and Rights | Signed C2PA, image and audio moderation, expiry separate from takedown | Takedown, revocation and the retention sweep are built. **C2PA signing needs an operator signing key. Moderation and the expiry/takedown split (G4) are not built yet.** |
| HV-039 Accessibility | WCAG 2.2 AA across the app | 20 increments of focus, announcement and control fixes. **A full audit pass is still to do.** |

## In flight

- **PR #83 rebuild (mixed films), as agreed:**
  - HV-016-23 to 29 are merged (#291–#293, #300–#303).
  - HV-016-30 (worker dispatch and turning V3 admission on) is next.
  - #83 is closed with the plan in its last comment.
- **HV-019-13 (#299), merged:** the real cause of the lease-loss CI flake. A wall-clock sweep
  elsewhere in the suite reclaimed the test's job.

## What is left, and how long

These are estimates, not commitments. CI takes about 45 minutes per head, and merges go in order.

1. **Finish the PR #83 rebuild (HV-016-30):** about 1 day, including the CI-only PostgreSQL/S3
   lifecycle test.
2. **Ungated Release 2 slices still to build:**
   - grade and LUTs (HV-026);
   - burned subtitles and SDH (HV-027);
   - timecoded comments and per-stage approvals (HV-029);
   - crew memory (HV-030);
   - image and audio moderation using the existing safety gate, with no new vendor (HV-031);
   - the WCAG 2.2 AA audit pass (HV-039).

   About 4–6 working days in total.
3. **Gated slices:** generated music (G3), voice meetings (G3), live ElevenLabs (G14), signed C2PA
   (an operator signing key), and the expiry/takedown migration (G4). Each can start once its gate
   is answered. Each is roughly 1–2 days of work after that.
4. **Release 2 exit:** a release run on staging and then G6, the operator's acknowledgement.

Engineering completion of the ungated scope is estimated at about **one week** from 2026-09-30. The
whole of Release 2 also depends on when the gates above are answered.

## Decisions waiting on Kevin

- G3 for the music vendor and for GPT-Live-1; G14 and the ElevenLabs key on the host; a C2PA
  signing key; G4 for the expiry/takedown migration.
- What `reviewViewerId` should do when `sessionStorage` throws.
- CI `paths-ignore: ['docs/**']`. The workflow file is frozen.

## History: factory build (ZOU-1566 / HV-000)

status: in_progress
watchdog: off

- [x] Seed adopted from docs/spec/factory-seed.yaml (source hash 612c3811…) + deterministic seed eval
- [x] M1 core: 10-package monorepo, parser conformance, safety gate, signed 72h tokens, version history
- [x] M2 core: mock provider, failover, cost cap, capacity tiers, fair share, continuity repair loop
- [x] M3 core: assembly (0.5s crossfade), captions SRT/VTT, ffprobe gate, byte-identical export, review links
- [x] M0: 24-shot benchmark fixture v1.0.0 + baseline + >5% CI regression gate
- [x] 12-shot E2E integration test (script → validated MP4)
- [x] Round-4 remediation: all 11 confirmed production-path defects closed (see `evaluations/hv000-round4-remediation-postflight-2026-08-31.md`)
  - [x] HLS media segments authenticate via a path-scoped HttpOnly cookie instead of a query-string token
  - [x] Project, script, attestation, approval, and review-link state persisted to disk; survives an API restart
  - [x] `GET /api/reviews/:token` returns the finished cut so a review link can display it
  - [x] Rights attestation captured from the user and enforced by both the API and the worker
  - [x] Animatic stage plus approval gate; final generation refused without an approved, still-current animatic
  - [x] Capacity tier is server-decided; elevated requires an operator-signed grant
  - [x] Cost ledger persisted and wired: per-shot events, per-job cap, real month-to-date budget throttle
  - [x] Worker uses provider failover, per-job timeout, exponential retry backoff, and fair-share claim order
  - [x] Crashed jobs resume from their checkpoint without regenerating completed shots
  - [x] Benchmark gate split into deterministic (5%) and host-calibrated latency (35%) lanes
  - [x] Frontend resolves its own origin; nginx proxies the API; no token in any query string
- [x] ZOU-1575 defect 5: `git diff --check` now runs over the committed range in CI, not a clean working tree
- [x] Round-5 remediation: all 5 substantiated findings closed (see `evaluations/hv000-round5-remediation-postflight-2026-08-31.md`)
  - [x] Approval binds to the animatic's screenplay version; editing after the animatic renders invalidates approval at the API and the worker
  - [x] Project URL embeds the signed token in its fragment; `GET /api/projects/:id` resumes the project; review links use the fragment too
  - [x] Artifacts served through signed URLs; no cookie anywhere, no token in any query string, HLS segments inherit the signed prefix
  - [x] Latency gate is an interleaved same-host A/B against the merge base at 5%; deterministic metrics gate at 5% against the baseline; CI runs the gate on every PR
  - [x] `bun run benchmark:compare` runs the full gate with no arguments
- [x] Round-6 remediation: all 9 substantiated findings closed (see `evaluations/hv000-round6-remediation-postflight-2026-09-01.md`)
  - [x] Download links are valid for 30 days from completion and bound to one cut, capped at the project's retention date (AC-013 / FR-040)
  - [x] Abandoned `running` jobs resume: leased claims, per-shot heartbeats, recovery at worker start and on every claim (AC-024)
  - [x] Queue-behind is honoured: a throttled job waits for the jobs that were ahead of it; the worker enforces tier concurrency at claim time (AC-011 / FR-032)
  - [x] Queue claims and writes are interprocess-atomic under a file lock; four workers draining one queue claim every job exactly once
  - [x] Provenance records the real project id
  - [x] ffprobe gate checks codec, resolution, frame rate, duration, bitrate, and audio (FR-044)
  - [x] mTLS between the proxy and the API; the API port is no longer published on the host (NFR-004, C-008)
  - [x] Per-address rate limiting with hashed, 30-day-retained records (FR-053, FR-059)
  - [x] Frontend API origin cannot be overridden from the URL or a global
  - [x] Safety gate covers identifiable real persons, political deepfakes, and trademarked brands (FR-054)
- [ ] Re-run the ZOU-1566 persona diversity review on this head; merge PR #1 only on a genuine pass
- [ ] External gates (operator/human): name clearance, counsel review, beta, load/pen test, GA — fail-closed per ADR-0020
