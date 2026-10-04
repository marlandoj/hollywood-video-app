# Reference-capable image and video adapters

These adapters are opt-in. Existing default provider configuration is unchanged.
Use a mixed pool when some screenplay scenes have references and others do not:

```sh
HV_ANIMATIC_PROVIDER_POOL='["image:fal:flux-2-edit","image:fal:flux-schnell"]'
HV_PROVIDER_POOL='["fal:kling-o3-standard-reference","fal:kling-v2.5-turbo-pro"]'
```

Only the worker needs the existing FAL_KEY. The API describes capabilities and
quotes without an inference credential. The admission plan pins model, price
and capability revisions; changing configuration requires new admission.

| Adapter | Implemented request | Configured estimate |
| --- | --- | --- |
| image:fal:flux-2-edit | `fal-ai/flux-2/edit`, 1–4 private PNG data URIs, 28 steps, one safe PNG output, seed, prompt expansion off | $0.012 × (reference count + output megapixels rounded up) |
| fal:kling-o3-standard-reference | `fal-ai/kling-video/o3/standard/reference-to-video`, 1–4 private PNG data URIs, numbered @Image references, audio off, no seed | $0.084 × billed seconds, rounded up to 3–15 seconds |

FLUX.2 requests each output dimension at a minimum of 512 and maximum of 2048,
then scales/pads the result to the requested preview canvas. Its quote applies
that 512-pixel floor. Each normalized input is charged as one megapixel; output
uses conservative whole 1,000,000-pixel units. This may overestimate the vendor's
1024-square examples. A 640-by-360 preview with one image quotes $0.024. The
fixed per-image override is refused for this model because it would omit input
image costs. Rates remain configured estimates, not reconciled invoices.

Kling rounds a two-second planned shot to three billed seconds ($0.252), then
normalizes the returned video to the export dimensions/frame rate and trims it.
The adapter does not implement video elements, native dialogue, embeddings,
first/last-frame controls or a visual identity guarantee.

The router includes reference counts in eligibility and admission estimates.
The worker verifies asset metadata, project scope, hashes and PNG bytes before
dispatch, then rechecks cast permission at each provider attempt. Raw data URIs
and prompts are absent from routing diagnostics. Export provenance retains the
cast and reference metadata. Provider request, cancellation, failure billing,
lease fencing and cost caps reuse the existing adapters' accounting path.

## The mock records references (HV-019-16)

The mock adapters (`mock`, `legacy-mock` and `image:mock` on every stage) accept a
shot's reference images, up to the 32 a shot can carry, so a film with locked or
referenced characters can be rehearsed on the `mock` profile at $0. They check the
images as the vendors do (private PNG data URIs) and record each one in the shot's
`referenceRecord`: its SHA-256 and size, in the request's order, with
`use: "recorded-not-rendered"`. The picture is not rendered from them; it is the
same picture the mock makes without references. The capability says so
(`referenceUse: "recorded-not-rendered"`), and every match of a shot with references
names the adaptation. The mock still takes no identity lock.

The router takes the first eligible provider in configured order, and the mock is
now eligible for a shot with references. In a pool that mixes the mock with a
reference vendor, put the vendor first; it takes no shot without references, so
those still go to the mock:

```sh
HV_ANIMATIC_PROVIDER_POOL='["image:fal:flux-2-edit","mock"]'
HV_PROVIDER_POOL='["fal:kling-o3-standard-reference","mock"]'
```

No staging profile mixes them: `mock` is mock everywhere, and the live profiles
have no mock.

## Verification and limits

Closed HTTP fixtures exercise the actual image/video request contracts and the
API → real worker → rich preview → approval → final media assembly. Tests cover
absent/excessive references, malformed or remote inputs, input-image cost,
billed video duration, budget refusal, text-only provider rejection and pinned
provenance. Existing fal adapter failure/accounting tests also pass locally.
Browser checks are recorded in CASTING.md.

Linux CI additionally exercises real PostgreSQL/S3 backup restoration, portable
archive round trips, historical-reference retention and a greater-than-1-MiB
upload through nginx and mTLS. A green fixture test proves the implemented
contract and persistence behavior; it does not prove current vendor acceptance,
creative quality, ownership, likeness safety or eight-shot identity consistency.
Paid vendor evaluation and Zo rollout remain pending.

## Vendor sources

Schemas and rates checked on 2026-09-06 UTC:

- [FLUX.2 edit API](https://fal.ai/models/fal-ai/flux-2/edit/api): image_urls,
  four-image limit, output dimensions and data URI input.
- [FLUX.2 edit pricing](https://fal.ai/models/fal-ai/flux-2/edit): $0.012 per
  input/output megapixel; input references resized to one megapixel.
- [Kling O3 Standard reference-to-video API](https://fal.ai/models/fal-ai/kling-video/o3/standard/reference-to-video/api):
  numbered image references, 3–15-second duration and audio controls.
- [Kling O3 Standard reference-to-video pricing](https://fal.ai/models/fal-ai/kling-video/o3/standard/reference-to-video):
  $0.084 per second with audio off.
