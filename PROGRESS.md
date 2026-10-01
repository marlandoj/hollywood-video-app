# Rough Cut — progress

Updated 2026-10-01 (UTC). The loop board, `docs/loop/STATUS.md`, is the machine-read record; this
page is the human summary. Current release: **Release 2 — "Voice and crew depth"** (`docs/ROADMAP.md`).

## Where things stand

- **Staging:** private desktop staging (`docs/STAGING-LOCAL.md`) is healthy on main and redeployed
  after each batch of merges. Nothing is public (ADR-0020).
- **Spend:** $16.846 of the $500 paid cap. No work since 2026-09-17 has called a paid provider.
- **Pace:** on 2026-09-30 and 2026-10-01, 26 more pull requests were merged (24 of them increments),
  each with CI green on its exact head. Most were reviewed adversarially before their PR was opened.
- **CI is now about 3 hours per head**, up from about 80 minutes. The mixed-film suites that
  HV-016-30 added take about 2 of those hours. HV-016-34 profiled why: about 88% is the worker's
  repeated access checks, which are production behaviour, not test waste. A refactor would save
  about 25%; it was not done (see `docs/loop/increments/HV-016-34.blocked.md`).

## Release 2 slices

The status column is what is on main today, plus open PRs where noted.

| Epic | Release 2 slice | Status |
|---|---|---|
| HV-016 Writers' Room | FDX and PDF import; crew-suggested revisions accepted line by line | **Built.** Import done. The crew suggests line notes and the writer takes them one at a time (HV-016-32); the desk panel is in PR #331. The PR #83 mixed-film rebuild is finished (HV-016-23 to 31). |
| HV-017 Character Identity | Identity locks beyond per-shot references; a cast library | **Built.** Locked looks travel with shared actors (HV-017-15); locking from the cast desk is in PR #332. |
| HV-021 Continuity | A continuity persona: drift detection and one-click repair | **Built.** The report and repair are on the Director's desk (HV-021-07), CONTINUOUS scenes are checked against the scene before (HV-021-08). The Continuity Supervisor persona (PR #333) and the desk's wording (PR #334) are open. |
| HV-022 Performance | ElevenLabs primary, Azure behind it, on its own $25 line | **Built, with the live voiced proof** (HV-022-11, run on staging 2026-09-22, PR #160; about $0.004 billed). Earlier notes that listed the proof as outstanding missed it. |
| HV-024 Sound | Generated music, SFX and ambience | The $10 music line is built. The ElevenLabs Music contract, adapter and admission are in PR #335 (off by default, no live call). **Left: the live music proof; SFX and ambience.** |
| HV-026 Color and Finishing | Grade, LUTs, QC checks (ffmpeg only) | **Built.** Picture QC, a grade with studio LUTs as a deliverable, and the studio's grade panel. |
| HV-027 Delivery | 9:16/1:1 reframes, burned subtitles, SDH, mezzanine | **Built.** Reframes, mezzanine, burned captions and SDH. |
| HV-029 Collaboration | Timecoded comments, per-stage approvals | **Built.** Timecoded comments and approvals per stage, on the API and the pages. |
| HV-030 AI Crew | Voice meetings (GPT-Live-1); crew memory of a creator's style | Crew memory is **built** (the style card, kept by the creator). **Voice meetings are deferred** (G15). |
| HV-031 Provenance and Rights | Signed C2PA, image and audio moderation, expiry separate from takedown | Expiry is separate from takedown. The words on uploaded sounds pass the safety gate, and the gate now reads any whitespace between words as a space. **Signed C2PA sidecars are in PR #336** (needs two operator steps on the host). **Image and audio moderation needs a decision** (below). |
| HV-039 Accessibility | WCAG 2.2 AA across the app | The full audit is done (`docs/ACCESSIBILITY-AUDIT.md`). With PR #330 there are **no failing cells**; 11 cells need a person with a browser and a screen reader. |

## Open PRs (CI running)

#330 HV-039-25, #331 HV-016-33, #332 HV-017-16, #333 HV-021-09, #334 HV-021-10,
#335 HV-024-11, #336 HV-031-15.

## What is left, and how long

These are estimates, not commitments. CI now takes about 3 hours per head.

1. **Merge the open PRs:** about half a day, mostly CI.
2. **The live music proof, inside the $10 line,** after #335 merges. About half a day; it declares
   its spend. (The voiced proof is already done: HV-022-11.)
3. **C2PA on staging:** after #336 merges, the operator re-issues the host certificate with the
   document-signing EKU if it lacks one and sets two paths in the secrets file. Then a verification
   run.
4. **SFX and ambience (HV-024):** about 1–2 days, on the same ElevenLabs account if approved.
5. **Release 2 exit:** a release run on staging and then G6, the operator's acknowledgement.

Engineering completion of the ungated Release 2 scope is estimated at **1–2 days** from
2026-10-01, plus the decisions below.

## Decisions needed from Kevin

- **Image and audio moderation (HV-031):** no configured vendor offers it. Today uploaded images rely
  on the rights attestation, and generated images use fal's own safety checker. Options: (a) accept
  attestation plus the text gate for Release 2 and move moderation to a later release; (b) approve a
  moderation vendor (a G3-class decision).
- **Music line period:** the $10 music line is built as lifetime, like the $25 voice line, which is
  the conservative reading of G15. Say if you meant $10 per month.
- **CI time:** accept about 3 hours per PR, or approve the validator refactor (about 25% faster).

## Decisions (answered 2026-09-30)

Kevin approved all of these on 2026-09-30; the record is `docs/loop/HUMAN-GATES.md` (G15).

- **G14 / ElevenLabs key:** already in place since 2026-09-21 (key on the host, catalogue valid to
  2027-09-21). Left: the live voiced proof, inside the $25 line.
- **G3 music:** ElevenLabs Music on the existing account, its own $10 line with alerts at $3 and $7.
- **G3 GPT-Live-1:** deferred. Open question for Kevin: an Anthropic API key for the crew.
- **C2PA:** a self-issued ES256 key generated on the host; a trust-list certificate at Release 4.
- **G4 expiry/takedown:** approved as an additive `expired_at`; mislabelled rows are flagged, not
  rewritten.
- **`reviewViewerId`:** tell the reviewer reloads will count in this browser.
- **CI:** the push trigger ignores `docs/loop/**` and `docs/PROGRAM-EXECUTION.md` (not `docs/**`,
  which would skip the tests that read `docs/evidence/**`).

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
