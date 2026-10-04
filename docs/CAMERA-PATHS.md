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

Provider routing requirements include the full canonical curve and disclose local screen-space framing in adaptations. Camera-path fields reach a vendor request only through a declared native camera control (below); no model in today's pool declares one. Per-shot export manifests record `cameraPathControl` with the applied mode, keyframes, output frame count and which path was used (`applied`). Job output records `cameraPathRenders`; take manifests, checkpoints and portable archives retain the same controls and original poster pixels. Snapshot validation rejects missing or altered completed-render provenance. Take adoption copies the selected curve with the other settings and seed.

Deploy API, frontend and workers together. No database migration is required. Older releases cannot interpret these optional fields; rollback requires a compatible release and snapshot. Local fixtures and CI do not establish paid model quality or live deployment.

## Native camera control (HV-020-01)

A path is read as moves, one per axis: the crop's centre moving right is `pan-right` (left `pan-left`), moving down `tilt-down` (up `tilt-up`), and the crop shrinking `zoom-in` (growing `zoom-out`). A screen-space crop cannot tell a dolly from a zoom, so it is a zoom. A net change under 1% of the frame (100) on an axis is no move on it. A path that turns back on any axis (pans right then left) is not a move: a provider's camera control takes a move, not keyframe times, easing or an exact extent.

A capability may declare `nativeCamera: {moves: [...]}`. Absent is `camera: none`. It is absent rather than an empty list so every capability revision admitted before it existed is unchanged. Declaring or changing the moves is a capability revision change: a plan pinned to the old revision is refused with `capability-changed`, as for any other change.

When the selected provider declares every move the path makes, the fal adapter adds the model's own camera-control fields (`FalModelSpec.cameraControl`) to the request and the attempt does not crop the result. Otherwise the request is unchanged and the path is cropped locally as before. A provider that declares a move but does not report it as sent, or reports one it does not declare, stops the attempt with a `FramingError`; a completed render's cost is kept once and failover does not run.

Each completed report records the path used: `applied: "native"` with `moves`, or `applied: "local-crop"` with a `reason` (`provider-has-no-native-camera`, `move-not-supported`, `path-reverses` or `path-has-no-move`). Route adaptations say "native camera control: pan-right" in place of the local-framing note. Snapshot validation and mixed current-film rows reject a native claim whose moves are not the path's own. Reports written before HV-020-01 carry no `applied` and were all local crops.

Eligibility, price and routing order are unchanged. Native support never makes a provider eligible or ineligible, and is not a routing preference: `configured` is the operator's order, and `cost`, `latency` and `quality` break their own ties by that order. A camera preference would be a new routing decision, and it would also have to be mirrored in the shot-execution capture's ranking check.

| Model | Native camera |
| --- | --- |
| `fal:kling-v2.5-turbo-pro` | none |
| `fal:kling-o3-standard-reference` | none |
| `fal:kling-o3-standard-keyframes` | none |
| `fal:veo3-fast` (retired) | none |

The vendor sources this repository cites for these models ([REFERENCE-PROVIDERS.md](REFERENCE-PROVIDERS.md)) document no camera-control input, so none is declared. A model's control is added only from a cited vendor schema.

## Native paths still pending

Every model in today's pool is `camera: none`, so `HV-020.native-camera` can't be exercised by Release 3's run until a model with a cited camera-control input joins the pool. Identified subject paths remain open HV-020 work. The [Kling 1.5 Pro input schema](https://fal.ai/models/fal-ai/kling-video/v1.5/pro/image-to-video/api) exposes dynamic masks and integer x/y trajectories. The [1.6 Pro input schema](https://fal.ai/models/fal-ai/kling-video/v1.6/pro/image-to-video/api) omits those inputs; similarly named types elsewhere on that page are not the endpoint contract. Coordinate units, mask constraints, timing and reference compatibility still need verification before an adapter is enabled. The [hosted Wan-Move endpoint](https://fal.ai/models/fal-ai/wan-move/api) is marked deprecated and unsupported, so it is excluded.

## Verification

Tests decode actual path pixels at first, intermediate and last frames, including changing zoom; verify exact output frame counts, preserved AAC and source PNG bytes, and captions drawn after the path. Closed FLUX.2/Kling O3 HTTP fixtures exercise the path through production adapters with private actor references and account for synthetic invoice records without paid requests. Film and take routes exercise quotes, adoption, stale approval rejection and recovery integrity. PostgreSQL/S3 CI restores a mixed anchored/path take group and its media through a portable project archive. HV-020-01's tests send a path through the production fal adapter and router over a fake transport: a fixture model with a declared control (its `fixture_camera_moves` field is not a vendor parameter) receives it in the request body and its first frame is uncropped, while Kling 2.5 Turbo Pro's request is unchanged and its frame is cropped. No paid render has shown that any vendor honours a camera control.
