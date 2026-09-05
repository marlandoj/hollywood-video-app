# fal image adapter (HV-018 T2)

FalImageProvider implements the existing ImageProvider contract for one FLUX Schnell frame.
It is exported alongside resolveImageProvider and FAL_IMAGE_MODELS. This adapter is library-only
until T4 wires the worker, animatic reservations, and approval UI.

## Selection and estimates

- `mock` or `image:mock`: deterministic labelled PNG.
- `image:fal` or `image:fal:flux-schnell`: fal-ai/flux/schnell.
- Server-side `FAL_KEY` is required for the paid adapter.
- `HV_FAL_IMAGE_USD_PER_IMAGE` overrides the **estimated total price of one image**; it must be
  positive and finite. It is not a spending cap and cannot override the provider's billing.
- `HV_FAL_IMAGE_MAX_WAIT_MS` overrides the complete submission/poll/download/normalization
  deadline (default 120 seconds). Every network request also has a 15-second deadline.
- Default estimate: $0.003 per rounded-up megapixel, verified 2026-09-05. A 640x360 request is
  estimated at $0.003; 1920x1080 is $0.009. Returned dimensions can raise the estimate.
- `providerUsesPaidInference` recognizes the image:fal family. Unknown names fail resolution.
  `resolveProvider` remains video-only; do not set the existing worker to image:fal yet.

## Contract and failure behavior

Requests specify one PNG, seeded generation, custom dimensions, and enabled provider safety.
Prompt and label metadata are checked before any network traffic. Nonempty identity hooks
are rejected until an adapter supports them; they are never silently discarded by the paid path.

The result must have exactly one image and an explicit false safety flag. A flagged or absent
verdict becomes a terminal SafetyRefusal carrying its estimated sunk cost. This differs from a
local pre-submission refusal, which has no provider cost.

Queue credentials are sent only to the configured HTTPS API origin, with redirects rejected.
Downloads carry no credentials and accept only HTTPS fal.media hosts, also without redirects.
JSON and media bodies are bounded (256 KB and 32 MiB). Downloaded PNGs are decoded, resized
with aspect-preserving padding, stripped of metadata, and atomically published. Malformed,
aborted, or failed images preserve any previous destination.

Queued cancellation must be positively accepted and checked before its estimate can be
released. In-progress, completed, or uncertain requests retain an estimated cost. A lost
submission receipt also conservatively retains the estimate, because submission may have
succeeded even when its response was lost. There are no automatic submission retries.
Cleanup gets a separate five-second deadline. Errors retain the FalProviderError/sunkCost
contract consumed by the existing worker; the video adapter was not refactored.

These are estimates, not reconciled invoices. Unknown billing can be overestimated and needs
operator reconciliation. GPU seconds are unavailable from this adapter and remain zero in
the legacy CostRecord; this must not be interpreted as evidence of zero provider compute.
The adapter does not reserve or enforce a budget: T4 must do so before paid staging use.

## Evidence and remaining work

Tests use a simulated queue and locally generated PNG fixture. No paid request, provider-key
retrieval, or live image-quality evaluation was performed. Live promotion still requires the
recorded seed approval, explicit provider selection, and budget controls. T3 moving clips,
T4 worker/cost/frontend integration, and T5 full-feature staging proof remain open.

Official references, checked 2026-09-05:
- [Model schema](https://fal.ai/models/fal-ai/flux/schnell/api)
- [Megapixel pricing](https://fal.ai/models/fal-ai/flux/schnell)
- [Queue and cancellation semantics](https://fal.ai/docs/documentation/model-apis/inference/queue)
