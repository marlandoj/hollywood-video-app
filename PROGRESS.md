# Hollywood Video — Factory Build Progress (ZOU-1566 / HV-000)

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
- [ ] Re-run the ZOU-1566 persona diversity review on this head; merge PR #1 only on a genuine pass
- [ ] External gates (operator/human): name clearance, counsel review, beta, load/pen test, GA — fail-closed per ADR-0020
