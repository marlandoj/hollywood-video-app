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

## A shot's reference budget (HV-019-17)

Both models take at most four images, and a locked look holds up to four, so two locked characters in
one shot carry eight. A render therefore sends at most the pool's largest reference count
(`poolReferenceBudget`: four for the pools at the top of this page, none for a pool with no reference model, which keeps
refusing a shot with images as before). Past it (`allocateReferences`, packages/planner/src/reference-budget.ts):

- The budget is split evenly across the shot's characters that hold images: two each for two at four;
  three at four get 2, 1, 1, the extra going to the more prominent. A character with fewer images than
  its share passes the rest on.
- Prominence is the shot's: characters who speak in it, in speaking order; then those its action names;
  then the scene's others; ties in cast order.
- Each character sends the front of its own order: a locked look's order (the creator's; the desk locks a
  turnaround front view first), else its images' order.
- With more characters than images, the most prominent send one each and the rest none. They stay in
  the shot's written cast direction and in the record, with every image listed as dropped.

The shot's numbered reference map in the prompt names only what is sent. The shot's `provenance.json`
entry gains `referenceBudget` (`hv-reference-budget/1`: the budget, how many images the characters
held, and per character `sent` and `dropped`), and each cut lock in its `identityLocks` keeps the
whole lock in `assets` and adds `sent` and `dropped`. A shot within budget is unchanged and has
neither. Admission, the worker and shot reuse read the budget from the same pool, so they cut the
same way. The mock declares 32 (HV-019-16), so on the `mock` profile, or in a pool mixing the mock
with a reference vendor, the budget is 32 and the rehearsal's eight-image shots are not cut.

The budget and the mock's `referenceRecord` describe one set of images from two sides: the budget
says which of the characters' images the studio chose to send, and the record says what the mock did
with the images it was sent. They are not two copies to drift apart: where a shot has both, the
assembler checks that the record's images are exactly the budget's sent images in the shot's order,
and refuses the export before encoding otherwise (`assertBudgetMatchesRecord`).

Staging selects these pools with the `live-film-referenced` profile (docs/STAGING-LOCAL.md). Its
read-through quote (HV-030-28) prices each shot on the lane its images route to and adds the rough
cut's stills.

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
