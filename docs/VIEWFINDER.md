# Storyboard viewfinder and camera presets

Open **Save screenplay and direct shots**, choose a shot, then open **Viewfinder and camera**. A completed matching preview supplies its uncropped storyboard image. The framed still updates immediately as the user drags the source rectangle or adjusts the width and position sliders. Arrow keys move one percentage point; Shift+Arrow moves ten. Home/End select the slider bounds. Reset restores the full frame in the draft. Save shot direction persists it and requires a new preview and approval.

The source label identifies its direction version. Matching uses the original planned action, scene grouping, dialogue and current cast; an unrelated screenplay change can keep a matching shot. An older direction version can supply an image for reframing, with an explicit reminder that generation may change it. No matching source, an expired link or a load failure leaves the crop editable. Plan reload preserves the draft, including crop and optics, even if its shot disappears. Source links require owner access to discover and use the existing private, expiring job artifact capability to load.

## Crop and render contract

Optional direction field `framing: {x,y,size}` uses integer ten-thousandths of the uncropped frame. Both dimensions share `size`, from 2500 to 10000; x/y are nonnegative and must keep the rectangle inside the source. Output aspect ratio stays fixed. A 50% width/height crop gives 2× zoom and retains 25% of source pixels. The FFmpeg crop rounds dimensions and offsets down to even pixels, then uses Lanczos scaling to the requested dimensions. The browser shows the continuous rectangle; edge rounding can differ by less than two source pixels.

Rich animatics crop the image before storyboard motion and captions. The original PNG remains a separate source asset, while the poster and video use the cropped image. Other video adapters pass their normalized output through the local crop after a successful provider request and before quality review. Frame count, output dimensions and audio are retained; encoded audio is copied without re-encoding. Final provenance records `appliedFraming` and routing records `digital-crop`. Native-resolution requirements reject a digital crop during admission before a reservation or provider call.

A local framing failure stops provider fallback and worker retry. It drains all known costs, including the successful provider request, before cancelling the job. It does not claim that the provider request was free or refund an incurred cost. Uncropped jobs keep their existing generation path.

## Modeled optics and editable presets

Four starting points copy focal length, lens type, movement intent/speed and modeled optics into the existing draft: Observational 16 mm, Large-format wide, Anamorphic drama, and Large-format portrait. Other shot fields and the crop are retained. Settings remain editable, and applying a preset does not save automatically. These are declared creative packages, not manufacturer camera profiles or measured image-quality simulations.

Optional `optics` contains sensorWidthMm/sensorHeightMm (1–100), squeeze (1–2), and look (up to 400 characters). Sensor dimensions, squeeze and look enter the generation prompt as creative intent. The field-of-view calculator needs a focal length (8–1000 mm). It is a rectilinear infinity-focus model; for full centered width H and focal length f its angular span is `2 atan(H/(2f))`. This relationship is described in [Edmund Optics’ field-of-view guide](https://www.edmundoptics.com/knowledge-center/application-notes/imaging/understanding-focal-length-and-field-of-view). The implementation extends that geometry to an off-center crop by subtracting the angles of rays to its two sensor boundaries. Horizontal modeled width includes the declared squeeze; vertical height does not.

The estimate does not measure the generated image. Focal length and presets do not alter perspective in the displayed still. There is no distortion, depth of field, parallax, bokeh, physical camera response or anamorphic de-squeeze simulation. Camera paths/keyframes, synchronized take comparison, coverage proposals and selective regeneration remain separate HV-020 work.

## Persistence, deployment and verification

Absent framing/optics stay absent in existing snapshots, preserving old direction hashes. Raw source PNGs are included in clip checkpoints, job storyboard output, durable artifact indexes, project exports and archive restores. Recovery validates their paths and checksums and refuses a missing indexed source. They follow project retention and deletion; they are not permanent external media.

Deploy API, workers and frontend together. No SQL migration is required. Older application releases do not understand these optional crop/optics fields or raw-source assets; use a compatible release and a current storage snapshot for rollback.

Tests decode actual left/right crop pixels, exact 121-frame output, unchanged AAC, captions after crop, invalid geometry, optical angles, paid local failures, source/cast isolation and approval invalidation. Closed FLUX.2/Kling O3 fixtures exercise the crop through production adapters without paid inference. Linux PostgreSQL/S3 tests round-trip a cropped preview and its raw PNG through a portable archive and reject missing source media. Browser checks cover presets, keyboard framing, draft reload, mobile layout, preview/final playback and export. Zo rollout and paid creative-quality evaluation remain pending during local-only operation.
