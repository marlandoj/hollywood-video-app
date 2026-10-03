# Rough Cut — progress

Updated 2026-10-03 05:10 (UTC). The loop board, `docs/loop/STATUS.md`, is the machine-read record; this
page is the human summary. **Release 2 — "Voice and crew depth" is done and acknowledged (G6,
2026-10-03).** Next: **Release 3 — "Features"** (`docs/ROADMAP.md`).

## Where things stand

- **Staging:** private desktop staging (`docs/STAGING-LOCAL.md`) is healthy on main. Nothing is
  public (ADR-0020). The repository is public (G17); that isn't a launch.
- **Spend:** about $17.30 of the $500 paid cap is recorded this month: picture $16.85, voice, music
  and crew. The voice line holds $14.44 of its $25.
- **CI:** about 70 minutes per PR (G18, HV-016-36). It runs as four parallel test shards, down from
  about 3.5 hours, and costs nothing on a public repository.

## Release 2: done

The run is `docs/evidence/release-2/release-run.json`. `test/release-2-run.test.ts` holds it to the
seven criteria agreed in G16.

- **Two films by one creator.** Film A is a Fountain reel. Film B is a Final Draft short, pitched
  with A's style card, which the crew read.
- **Reviewed on Kevin's phone** with timecoded comments. Film A got changes requested; film B was
  approved.
- **18 of 21 parts were exercised:**
  - crew style memory, continuity repair, identity locks and the cast library;
  - ElevenLabs voices, generated music and ambience;
  - grade with QC, reframes, captions and SDH, the mezzanine;
  - FDX import and crew line notes;
  - comments and stage approvals;
  - signed C2PA, expiry separate from takedown, and WCAG 2.2 AA.
- **Deferred:** generated SFX and image/audio moderation (G16). Voice meetings were dropped (G19);
  text chat is the crew's interface.
- **$0.33 spent** against $2 declared. Picture ran on mock.

## Release 3: next

Scope, as decided in G19:

- **A Showrunner** splits a feature into sequences and holds continuity across them.
- **Identity and continuity** hold up over hundreds of shots.
- **A second video vendor and the hero-render chain.** The vendor needs Kevin's approval (G3)
  before it spends.
- **Native camera paths, interchange export, the style bible, VFX.**
- **An internal benchmark.**
- **English only.** Multi-language versions moved to later.

**The proof is a 15–20 minute feature**, about 200–240 shots rendered live: about $70–85 of video,
with about $120 declared for the run. A full feature, about $525 of video, is a later decision.

The next increment proposes Release 3's exit criteria for Kevin to agree, as Release 2's did.

## Still open

- **Music line period:** built as lifetime, like the voice line. Say if you meant $10 per month.

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
