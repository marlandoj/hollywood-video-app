# Frame anchors

HV-020 lets a shot pin private first, last and intermediate images. The source-bound direction revision records image checksums and normalized times; previews and final approvals bind that revision. Changing the anchor list, timing or fallback requires a new preview and approval.

## Editor and private storage

Open **Save screenplay and direct shots**, edit a shot, then expand **Frame anchors**. Add up to five images. The first time is 0%; 100% means the last output frame. Other times locate intermediate images. Automatic or Static storyboard motion is compatible; pan/zoom motion must be removed before using these anchors.

Upload a PNG/JPEG with permission attestation, or reuse an image already stored for that shot. Uploading stores the image but does not save the direction draft. Choose its anchor time and save shot direction afterward. Reloading the plan preserves the editable list, images, fallback and other shot settings. The editor shows thumbnails through authenticated blob reads, never publicly accessible reference URLs.

The owner-only upload route is `POST /api/projects/:id/direction/:shotId/anchors?maxShots=24&label=Opening`. Its binary body uses the same bounded raster normalizer as cast references: at most 10 MiB input, dimensions at most 4096 per side, decoded PNG at most 1024 per side and 4 MiB. Headers `x-hv-direction-version`, `x-hv-script-version`, `x-hv-source-hash` and `x-hv-reference-attested: true` bind the current source and permission declaration. Commit rechecks the source and versions under the project lock.

Images share the project's historical 96-image catalog with cast references. Unused uploads and prior revisions count toward that limit and follow project retention. Direction metadata must match a catalog entry exactly, including project ownership, checksum and source. Worker reads verify the actual bytes; PostgreSQL admission and dispatch recheck catalog membership. Backup and portable-archive validation preserve project and job anchor references alongside their private objects.

## Rendering contracts

`frameAnchors.frames` contains `{at, asset}` records, ordered by integer `at` from 0 to 10000, starting at zero. A fixed duration maps those positions to `round(at * (outputFrames - 1) / 10000)`. Colliding positions refuse admission. Optional fields are absent from older direction/capability records, preserving their existing revisions.

| Mode | Behavior | Limits |
| --- | --- | --- |
| Preview | The free `anchor-storyboard` adapter dissolves between supplied images and holds the final image. | No generated subject motion; cast-reference images are not reapplied. |
| Native final | A configured provider must support every requested anchor. | The initial native adapter supports first and optional last images, not intermediate frames. |
| Explicit final fallback | `fallback: "storyboard"` permits the provided-image presenter when no native candidate can satisfy the request or an eligible native request fails through ordinary failover. | Native candidates rank first even under cost routing. Hard policy, accounting, cancellation and completed-media failures stop rather than repeat paid work. |

The default fallback is `stop`. No paid provider is added to operator configuration automatically. The local presenter is added only to anchor-aware preview plans or an explicitly allowed final fallback; ordinary jobs retain their configured pools. An explicitly configured `anchor-storyboard` adapter also refuses unanchored shots. Render requirements such as identity locks, native resolution, audio, region and determinism remain admission gates. Provided-image storyboards disclose that cast-reference bytes are not reapplied; current cast permissions still gate dispatch.

Local transitions use FFmpeg `xfade`, H.264 output and AAC temporary speech or silence. The existing narration duration gate runs before rendering. Crops apply once to each image before dissolves and captions; the raw first image remains available to the viewfinder. Preview and export screens identify storyboard and native anchor shots. Per-shot provenance records the actual control mode and positions, not merely the requested settings.

## Opt-in native adapter

Configure `fal:kling-o3-standard-keyframes` in `HV_PROVIDER_POOL` to enable Kling O3 Standard reference-to-video first/last guidance. This separate capability preserves the existing `fal:kling-o3-standard-reference` contract. Private PNG bytes reach `start_image_url` and optional `end_image_url`; up to four cast reference images separately use `image_urls`. No intermediate image is substituted into an unsupported field.

The vendor contract checked on 2026-09-06 supports whole-second 3–15 second requests with audio off. The configured estimate is $0.084 per billed second; it is not an invoice reconciliation. A 121-frame, 30 fps request therefore submits five seconds and estimates $0.42. Endpoint-preserving normalization maps the decoded generated first and last frames to the requested first and last frames, rather than trimming off the generated ending. This preserves generated endpoints; it does not promise they exactly match the supplied images. Completed but unreadable/download-failed/normalization-failed native output retains its known bill once and stops retry/failover.

Sources: [Fal O3 input schema](https://fal.ai/docs/model-api-reference/video-generation-api/kling-video-o3-standard-reference-to-video), [model pricing](https://fal.ai/models/fal-ai/kling-video/o3/standard/reference-to-video), [file input documentation](https://fal.ai/models/fal-ai/kling-video/o3/standard/reference-to-video/api).

## Validation and remaining scope

Tests exercise actual decoded first/middle/last frames, timing changes, deterministic local output, crop/caption ordering, temporary speech, private upload admission, approval invalidation, native request bytes, routing and known-cost failures. Native HTTP uses a closed fixture, with no paid inference. PostgreSQL and S3 CI exercises worker catalog access, holds, and portable archive restoration. Browser checks cover image reuse, draft reload, mobile layout and preview/final playback and download.

This is part of P4. It does not complete camera/subject curves, native intermediate anchors, physical scene/optics simulation, synchronized take comparison, coverage proposals or selective regeneration. Vendor image adherence, likeness moderation and paid visual-quality evaluation remain unverified. Zo rollout and live Linear reconciliation await access; local development continues separately.
