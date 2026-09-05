# HV-018 fal image adapter post-flight

Scope: T2 of the HV-018 seed, extending T1 in draft PR #9 on
codex/ZOU-1587-image-foundation. Parent foundation commit: 5b01e97.
This is direct desktop development, not a factory dispatch or staging promotion.

## Delivered

- FalImageProvider for fal-ai/flux/schnell; explicit resolver and paid-provider detection.
- Single-image PNG request, seed/custom size, local safety gate, required provider safety verdict.
- Per-rounded-megapixel estimates and explicit per-image override; conservative sunk-cost
  reporting for abandoned, lost-receipt, failed-download, and failed-normalization requests.
- HTTPS origin checks for credential-bearing requests, credential-free fal.media downloads,
  disabled redirects, bounded streams and deadlines, decoded normalized PNG, atomic output.
- Nonempty identity inputs rejected until HV-017 supplies a supported implementation.
- Fourteen simulated-provider tests; zero live model calls.

## Verification

- Full suite: 211 pass / 0 fail on Zo Bun 1.3.12.
- Follow-up adapter tests after final model-name/pixel-accounting hardening: 14 pass, 99 assertions.
- Typecheck, lint (zero warnings), build, and runtime smoke: pass.
- Runtime smoke: 22 responses, signed URLs, reachable HLS, stale approval refused, session
  resume and restart survival, zero cookies, zero spend.
- Benchmark: three-round same-host A/B passes the 5% gate: latency floor +0.3%, total -0.3%.
- Persona consult: web-app@1.0.0 shadow advice/review; no specialist model invocation or verdict.

## Gap audit

Reachability: exported library contract tested with simulated HTTP; worker remains video-only
until T4. No claim that image:fal is usable as a staging worker configuration yet.
Data prerequisites: server-side FAL_KEY is needed for live use; never read for this work.
Cross-boundary environment: new image-only price/wait overrides are documented and validated.
Evaluation/production parity: real PNG decoding is tested; queue, pricing and safety responses
are synthetic fixtures matching official docs, not recorded live traffic.
Dangling identifiers: model registry is explicit; prototype-property names rejected. Unsupported
identity hooks fail closed rather than pretending to condition generated images.

Costs are estimates, not invoices; uncertain submissions can overestimate spend. GPU seconds
are unavailable and remain a documented zero placeholder. T4 must integrate budget admission,
reservations and ledger-stage accounting before paid staging, and consider fairness telemetry.
T3 moving clips, T4 application integration, and T5 live proof are still open.

Rollback: revert this additive T2 commit; no migration or service configuration changes.
