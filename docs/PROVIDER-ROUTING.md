# Provider capability routing (HV-019)

This increment replaces model-name selection in new job execution with an admitted provider plan. It implements routing for the existing video and rich-animatic adapters. HV-019 and the wider P5 scope remain in progress: additional modalities, quality presets, calibrated visual evaluation, production canaries, self-hosted inference, and a complete reproducible film package are separate work.

## Admission and execution

The API saves a versioned, SHA-256-addressed plan in the job body: stage, strategy, per-shot cap, render requirements, normalized operator-approved pool, and each adapter's capability and configured price snapshot. Metadata construction requires no inference key. Only the worker receives FAL_KEY.

At claim time, the worker verifies the saved plan against the current allowed pool and adapter definitions. Removing an admitted provider or changing its model, price or capability definition prevents execution and asks for a new render. Reordering or adding current pool entries cannot silently change the admitted pool. Environment settings shared by API and workers must match.

Before every dispatch, the router matches requested dimensions, frame rate, duration, reference/identity counts, camera move, audio, native resolution, deterministic output, region and synthetic-output policy. Unknown or unsupported features are explicit rejections. Retired endpoints cannot be selected. Capability definitions describe the actual adapter path, including post-processing; an endpoint supporting a feature does not imply this adapter implements it.

The lease holder saves a routing decision before inference. Decisions contain eligibility/rejection reasons, configured quotes, capability and price revisions, and bounded worker-local health observations. They contain no prompt, reference URL, credential or provider response body. PostgreSQL persists these through the existing job row lock, lease fence and RLS scope; no database migration is required.

New jobs always enforce their saved plan. Older jobs use registered built-in adapters when available. The legacy injected-adapter contract is retained only for pre-plan jobs whose custom adapters have no capability snapshot.

## Configuration

Set these on both the API and workers. Existing primary/secondary selectors remain the defaults.

| Setting | Behavior |
| --- | --- |
| HV_PROVIDER_POOL | Optional JSON array of 1–8 final adapter specs; overrides primary/secondary. Duplicates normalize to one entry. |
| HV_ANIMATIC_PROVIDER_POOL | Optional JSON array of 1–8 animatic adapter specs; overrides HV_ANIMATIC_PROVIDER. |
| HV_ROUTING_STRATEGY | configured (default), cost, or latency. |
| HV_COST_CAP_PER_SHOT_USD | Final per-shot cap, default $5. Admission reserves the aggregate job cap for pools containing paid providers. |
| HV_ANIMATIC_COST_CAP_USD | Whole-animatic cap, default $5; also the maximum for an individual animatic shot. |
| HV_FAL_USD_PER_BILLED_SECOND | Optional positive configured video rate override, applied on both roles. |
| HV_FAL_IMAGE_USD_PER_IMAGE | Optional positive configured per-image override, applied on both roles. |

Supported final specs: mock, fal (normalized to the existing Kling adapter), fal:kling-v2.5-turbo-pro, and historical fal:veo3-fast (retired; never eligible). Animatic specs: mock / image:mock, legacy-mock, image:fal / image:fal:flux-schnell. See the catalog for normalized identifiers.

The API's jobs POST accepts optional renderRequirements with audio (any, temporary-dialogue, native-dialogue), deterministic, nativeResolution, allowSynthetic and region (any, local). Unsupported keys are refused; callers cannot add an endpoint, model or price. Defaults preserve the existing silent/synthetic-compatible flow. Native dialogue is currently unsupported. Temporary dialogue requires the rich animatic narration option.

Cost strategy ranks eligible configured quotes; video quotes round up to supported billed durations and image quotes use the adapter's configured megapixel ceiling or per-image rate. Latency strategy uses observed successful durations only after three samples; unknown providers keep configured order behind observed providers. Neither strategy fabricates quality scores or live vendor health.

## Accounting and failure behavior

The router re-reads remaining shot/job capacity before each candidate. PostgreSQL atomically checks the saved route's model, capability revision and quote, rejects reuse of a route for another dispatch, and reserves the attempt under the existing budget lock. Known shot spending plus outstanding running/unknown liabilities must fit the shot cap. Other shots retain their own limits within the shared job reservation.

Each bill carries the attempt and route IDs. Paid failures, discarded repairs and cancellations retain their costs. An invoice above the quote is still recorded; exceeding a shot cap cancels further job work even when the overall job cap has room. A failed route write, lease loss, budget error or safety refusal stops inference. Unknown liabilities remain held through the existing reconciliation path.

The JSON ledger supports the local single-worker path and checks known per-shot spending. PostgreSQL remains the supported shared-worker accounting path with atomic concurrent attempt holds.

Three provider failures open that worker process's circuit for 30 seconds. One recovery probe may run after the interval; successful generation closes the circuit. Observations expire after ten minutes of inactivity, while an active recovery probe stays exclusive. This is process-local operational evidence, not a fleet-wide health service or a quality evaluation.

Completed clip checkpoints and the protected provenance download include the selected capability snapshot, requirements, adaptation notes and route decision IDs. Existing model/seed/fingerprint fields remain. The manifest still uses the existing c2pa-style claim; this work does not create signed C2PA credentials.

## Provider facts checked

- [Kling v2.5 Turbo Pro text-to-video API](https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/text-to-video/api): this adapter uses the text-only endpoint, supported billed durations and aspect ratios; no reference conditioning is implemented.
- [Veo 3 Fast API](https://fal.ai/models/fal-ai/veo3/fast/api): checked 2026-09-06; the vendor marks the endpoint deprecated and unsupported. The registry retains its historical descriptor but marks it retired. It is not automatically migrated to another paid model.
- [FLUX Schnell API](https://fal.ai/models/fal-ai/flux/schnell/api): single-frame text-to-image path; the current adapter rejects identity/reference conditioning.

Prices are configured estimates with invoiceReconciled=false. Region for hosted adapters is unspecified. Local fixtures do not establish live vendor availability, regional execution, visual quality or current invoices. No paid inference was dispatched for this increment.

## Validation and rollout

Router tests cover metadata without credentials, unsupported requirements, configured prices, plan integrity, ordering, persistence failure, paid failover, cancellation costs, circuit recovery, retired models, and capability drift. Worker/API tests cover admitted-plan execution, provenance and cost correlation, refusal before enqueue, and unexpected per-shot invoices. PostgreSQL tests exercise concurrent shot holds, unknown liability, exact dispatch binding and route replay.

Desktop targeted tests and static checks run on Windows. The complete Linux CI suite additionally supplies PostgreSQL, S3, ffmpeg, espeak-ng and shell tooling. Desktop full-suite limitations include existing Unix path/script assumptions and absent espeak-ng; these do not substitute for the Linux checks.

Deploy only after CI passes. Existing active jobs with no plan remain readable. Keep shared nonsecret provider configuration consistent across roles, retain worker-only inference keys, and perform a private mock animatic/final smoke after rollout. Live Zo deployment and provider evaluation remain pending while Zo is unavailable.
