# ADR-0021: fal.ai as the First Paid Video Generation Provider

**Date:** 2026-09-03
**Status:** accepted
**Confidence:** 0.8 *(revisit the default model once the 24-shot benchmark has run against both fal models and at least one non-fal provider)*
**Supersedes:** —

## Context

The vertical slice shipped with a single deterministic placeholder provider
(ADR-0020). Every generated film was a sequence of flat colour cards, which
proves the pipeline but shows nothing of the script. The operator already holds
a fal.ai key used elsewhere in the workspace, and fal.ai fronts several
text-to-video models behind one queue API, so it is the cheapest path to real
pictures without committing to a single model vendor.

## Decision

- Add `FalVideoProvider` (`packages/generator/src/fal.ts`) implementing the
  existing `ProviderAdapter` contract against `https://queue.fal.run`:
  submit, poll, download, then normalise with ffmpeg to the exact shot length,
  frame size, and frame rate the assembler validates.
- Model table: `kling-v2.5-turbo-pro` (default, $0.07 per billed second, 5 s
  minimum) and `veo3-fast` ($0.10 per billed second with audio off, 4 s
  minimum). Cost records carry billed seconds as `gpu_seconds`, so the per-job
  cap and monthly budget apply unchanged.
- `HV_PROVIDER_PRIMARY` / `HV_PROVIDER_SECONDARY` are now honoured by the
  worker (`mock`, `fal`, or `fal:<model>`). `HV_ANIMATIC_PROVIDER` defaults to
  `mock` so the human review gate (FR-5.4) never spends money.
- Each provider attempt carries an `AbortSignal`; a timed-out fal request is
  cancelled remotely. fal honours a cancel only while the request is still
  queued: a request that has reached `IN_PROGRESS` renders to the end and is
  billed regardless (observed 2026-09-03: a request cancelled at 240 s
  completed after 360 s of inference). The adapter therefore re-reads the
  status after cancelling and reports a still-billed request as a sunk cost on
  the error; the failover generator and repair loop carry sunk costs (including
  discarded repair attempts) to the worker, which charges them to the job so
  the per-shot cap, job cost, and ledger stay honest. The fal wait budget
  defaults to 15 minutes (`HV_FAL_MAX_WAIT_MS`) and the worker's provider
  timeout defaults to one minute more, so the adapter, not the outer race,
  decides when to give up. The worker refreshes its lease on a timer during
  generation and assembly, and the API job timeout is configurable
  (`HV_JOB_TIMEOUT_MS`; allow about seven minutes per shot on fal).

## Consequences

- A free-tier 24-shot final on Kling costs about $8.40 before repairs; the
  default $5 per-shot cap gives a $120 per-job ceiling. Operators should lower
  `HV_COST_CAP_PER_SHOT_USD` when enabling fal on a shared deployment.
- Shots are 2 s but the cheapest billable clip is 5 s, so roughly 60% of paid
  seconds are trimmed. A future planner change (longer shots, or image-to-video
  from a shared keyframe for continuity) would reduce that waste.
- Kling exposes no seed, so fal renders are not reproducible byte-for-byte;
  provenance still records model, seed, fingerprint, and cost per shot.
- Prices are hard-coded from fal.ai list prices on 2026-09-03 with an
  `HV_FAL_USD_PER_BILLED_SECOND` override; a price change without an override
  under-reports spend until the constant is updated.
