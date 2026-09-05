# HV-018 image foundation post-flight

Scope: T1 of seeds/hv-018-rich-animatic-seed.yaml, implemented directly from desktop Codex.
Base: hollywood-video-app main 1a6c3ba. Branch: codex/ZOU-1587-image-foundation.
No factory dispatch, provider inference, deployment, or merge was performed.

## Delivered

- ImageProvider, FrameParams, IdentityConditioning, StillFrame exports.
- Deterministic labelled PNG mock with zero-cost records and content SHA-256 fingerprints.
- Full prompt/label safety gating; no-op identity hooks.
- Bounded dimensions, safe text rendering, cancellation, temporary-file cleanup, atomic publication.
- Seven contract tests, including actual PNG probing and preservation of existing output on abort.

## Validation

- Zo Bun 1.3.12: 197 tests passing, zero failures, 883 assertions.
- Typecheck, lint (zero warnings), build: pass.
- Runtime smoke: healthy, 22 responses, zero cookies, signed artifacts, playable review link,
  stale animatic refusal, project resume and restart survival, zero spend.
- Sample 640x360 frame visually inspected on desktop: shot, scene and action legible.
- Persona consult: web-app@1.0.0, shadow advise/review only. No specialist model executed.
- Benchmark: 3-round same-host A/B passes the actual 5% gate (latency floor +1.0%, total +0.7%).
- CI uses Bun 1.4.0 and remains the authority for that runtime and container checks.

## Gap audit

Reachability: library exported and exercised by contract tests; not wired into worker or UI yet.
Data prerequisites: ffmpeg drawtext and DejaVu Sans are required; no keys or references needed.
Cross-boundary environment: the existing staging provider configuration is untouched.
Evaluation/production parity: mock contract verified; no claim of paid-image or full-animatic parity.
Dangling identifiers: identity hooks are intentionally no-op and documented; T2-T5 remain open.
Rollback: revert this additive foundation commit; no data migration or configuration rollback needed.
