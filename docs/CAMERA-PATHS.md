# Timed camera framing (HV-020)

The shot editor can move and zoom a digital crop over time. This is applied to rendered pixels in rich storyboards and final video. It uses the uncropped source and temporarily replaces the static viewfinder crop. Removing the path restores that retained crop. It does not simulate a physical camera, parallax, subject motion, focus or lens optics.

## Editing and timing

Under **Viewfinder and camera → Timed camera framing**, add a path, select a keyframe, then drag the existing crop rectangle or use its keyboard-accessible position controls. Add intermediate keyframes and edit their normalized time. The first and last keyframes stay at 0% and 100%. Linear interpolation moves at a constant rate within an interval; smooth interpolation uses `t*t*(3-2*t)` to ease its start and stop. The final point's easing has no following interval.

The preview scrubber shows the interpolated crop over the retained still. A fixed duration uses the same rounded output-frame positions as rendering. Automatic duration uses a normalized illustrative preview until rendering determines the duration, including any temporary dialogue expansion. This preview does not predict generated subjects or image quality. A new image may differ from the retained source.

Valid edits enter the draft immediately. Reloading the shot plan retains the path and original static crop; full page reload retains saved directions only. Invalid intermediate times remain visible and block save/reload until corrected. Removing a path or point changes the draft; Cancel discards those edits. Save creates a new direction revision and requires a new preview and approval.

## Canonical contract

Optional `ShotDirection.cameraPath` contains `mode: "screen-space"` and 2–8 `keyframes`. Each point has exactly `at`, `x`, `y`, `size`, and `easing`. Coordinates and times are integer ten-thousandths. Crop width and height share `size`, ranging from 2500 to 10000, and must remain inside the uncropped frame. Times increase strictly from 0 to 10000. Easing is `linear` or `smooth`.

For N output frames, point time maps to `round(at*(N-1)/10000)`. Points that collide at a requested duration are refused. Interpolation stays within the valid crop region. ffmpeg samples the curve for each output frame; chroma/pixel alignment can produce small subpixel rounding differences from the browser rectangle. No requested frame is dropped to make the path fit.

The path belongs to the exact screenplay source, cast and direction context already pinned by the direction and take plans. Absent paths remain absent, preserving old hashes. `cameraPath: null` removes an inherited path in a take override. `frameAnchors: null` can similarly remove inherited anchors when authoring an alternative that uses a path.

## Dispatch and provenance

Frame anchors and camera paths cannot currently be combined: transforming an anchored frame would change its pixels. Admission refuses that combination, explicit non-static storyboard moves, native-resolution requirements, invalid geometry and colliding keyframes before provider dispatch or budget reservation. Automatic or Static storyboard motion is compatible. The path replaces the built-in still pan/zoom and runs before captions. Final-video framing preserves encoded audio. A completed paid inference remains accounted for if local framing fails; such a failure stops automatic failover.

Provider routing requirements include the full canonical curve and disclose local screen-space framing in adaptations. No camera-path fields are added to vendor requests. Per-shot export manifests record `cameraPathControl` with the applied mode, keyframes and output frame count. Job output records `cameraPathRenders`; take manifests, checkpoints and portable archives retain the same controls and original poster pixels. Snapshot validation rejects missing or altered completed-render provenance. Take adoption copies the selected curve with the other settings and seed.

Deploy API, frontend and workers together. No database migration is required. Older releases cannot interpret these optional fields; rollback requires a compatible release and snapshot. Local fixtures and CI do not establish paid model quality or live deployment.

## Native paths still pending

This change implements the explicit digital framing mode. Native camera trajectories and identified subject paths remain open HV-020 work. The [Kling 1.5 Pro input schema](https://fal.ai/models/fal-ai/kling-video/v1.5/pro/image-to-video/api) exposes dynamic masks and integer x/y trajectories. The [1.6 Pro input schema](https://fal.ai/models/fal-ai/kling-video/v1.6/pro/image-to-video/api) omits those inputs; similarly named types elsewhere on that page are not the endpoint contract. Coordinate units, mask constraints, timing and reference compatibility still need verification before an adapter is enabled. The [hosted Wan-Move endpoint](https://fal.ai/models/fal-ai/wan-move/api) is marked deprecated and unsupported, so it is excluded.

## Verification

Tests decode actual path pixels at first, intermediate and last frames, including changing zoom; verify exact output frame counts, preserved AAC and source PNG bytes, and captions drawn after the path. Closed FLUX.2/Kling O3 HTTP fixtures exercise the path through production adapters with private actor references and account for synthetic invoice records without paid requests. Film and take routes exercise quotes, adoption, stale approval rejection and recovery integrity. PostgreSQL/S3 CI restores a mixed anchored/path take group and its media through a portable project archive.
