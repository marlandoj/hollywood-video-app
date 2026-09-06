# Native subject motion input packets

The local operator tool compiles identified subjects and timed point trajectories into the exact NumPy input files used by Wan-Move. This is an input preparation and verification tool. It does not run a model, upload images, reserve provider spend, or produce generated video. Native subject-path editing and rendering in the film application remain open; existing digital camera framing is a separate control.

## Compile and verify

Requires the application's Bun runtime and FFmpeg. Prepare a still PNG at exactly 832×480 or 480×832 before placing points. The compiler preserves those bytes without cropping or resizing. Calculate their SHA-256 and put it in a plan:

```json
{
  "schema": "hv-subject-motion/1",
  "source": {"sha256": "REPLACE_WITH_SOURCE_PNG_SHA256", "width": 832, "height": 480},
  "prompt": "A red ball moves across a table.",
  "seed": 7,
  "subjects": [{
    "id": "ball", "label": "Red ball",
    "tracks": [{
      "id": "center",
      "keyframes": [
        {"frame": 0, "x": 1250, "y": 5000, "easing": "smooth", "visible": true},
        {"frame": 40, "x": 8750, "y": 5000, "easing": "linear", "visible": true},
        {"frame": 80, "x": 5000, "y": 5000, "easing": "linear", "visible": true}
      ]
    }]
  }]
}
```

```sh
bun scripts/subject-motion.ts compile --plan plan.json --image source.png --out new-packet
bun scripts/subject-motion.ts verify new-packet
```

The destination must not exist. Its parent must exist. A successful packet contains exactly `source.png`, `plan.json`, `tracks.npy`, `visibility.npy`, and `manifest.json`. Files use private permissions on systems supporting POSIX modes; Windows inherits the destination parent's access rules. A failed filesystem write may leave a partial directory; it has no valid completion manifest and verification refuses it. The tool never overwrites an earlier packet.

The source hash, dimensions, normalized plan, prompt, seed, subject/track order and all input-file hashes are bound to the manifest revision. Verification reconstructs and compares every byte, including the manifest. There is no inferred rights attestation or application render approval in this standalone packet. Existing text safety checks apply, with the same previously documented semantic and image-moderation limitations.

A new refusal probe exposed an existing order-dependent keyword gap for sexual content involving minors. The shared gate now pairs the relevant terms in either order and includes plural terms and explicit under-18 age phrases. Regression checks cover prompt and dialogue text, while ordinary nonsexual childhood scenes remain allowed. This targeted fix does not establish semantic, multilingual or image-moderation coverage.

## Coordinate and timing contract

- One to six labeled subjects, each with one to eight independently positioned tracks. A subject label is a planning identifier; it is not an embedding, segmentation mask, or identity guarantee. Place each track's initial point visibly on its intended subject. Duplicate initial coordinates are rejected.
- Coordinates are integers from 0 to 10000, with top-left origin, x increasing rightward and y downward. They map to floating-point source pixel coordinates spanning `0..width-1` and `0..height-1`. A multi-point subject can translate, deform or rotate through its independently authored tracks; no unrequested rigid transformation is inferred.
- Each track has two to 21 keyframes. Frames increase strictly from 0 to 80 in multiples of four. Linear or smoothstep easing applies to the outgoing segment. Visibility holds until the next keyframe and must start true. Invisible tracks still retain their specified coordinates.
- The packet contains 81 samples at 16 fps: the final sample is at 5 seconds, and 81 encoded frames occupy 5.0625 seconds. The reference model's temporal conditioning stride is four, yielding 21 conditioning positions. This explains the keyframe grid; it does not promise frame-accurate generated motion.
- `tracks.npy` uses C-order little-endian float32 with shape `[1,81,N,2]`. `visibility.npy` uses C-order one-byte booleans with shape `[1,81,N]`. Neither uses pickle/object arrays. Track order is subject order followed by each subject's track order, explicitly recorded in the manifest.

The exact supported source dimensions avoid the reference model's aspect-dependent resizing changing the coordinate frame. The reference model also quantizes positions to its spatial latent grid. Nearby or crossing visible tracks can share cells; packet validity is not evidence that the model follows them or preserves identity.

## Renderer handoff and evidence boundary

The manifest pins the inspected [Wan-Move source](https://github.com/ali-vilab/Wan-Move/tree/80c58a7d2ad175fa82a4d57f79f2a1415317dcfa) and names its checkpoint. `inputArguments` is an argument array for that version's `generate.py`, relative to the packet directory. A separately configured runner must supply the verified model installation, checkpoint directory and an output path outside the immutable packet. It must run packet verification before dispatch and use argument-array execution, never concatenate the prompt into shell code. This tool neither installs nor executes third-party model code.

The contract was checked against `generate.py` (NumPy load and CLI arguments), `wan/wan_move.py` (batch shapes and image/track scaling), `wan/modules/trajectory.py` (top-left coordinates, visibility and stride), and `wan/configs/shared_config.py` (16 fps) at the pinned commit. Source inspection and NumPy interoperability do not constitute a GPU inference test.

Validation covers input bounds and revisions, smooth/linear timing, explicit visibility, full PNG checksum/decoding, source mismatch, deterministic bytes, packet tampering, overwrite refusal and the actual CLI using paths with spaces. `scripts/subject-motion-smoke.ts` uses NumPy 2.4.3 to independently load the emitted files and check analytic points, multi-point translation, stationary subjects and the 21 native conditioning positions. It uses synthetic geometry and no paid inference.

Remaining integration: a private source-bound editor and asset catalog, project/cast permission checks, native provider capability and cost admission, durable request recovery/cancellation, renderer output validation, film/take provenance and actual generated-motion evaluation. No subject-motion provider is enabled in the film router by this change.

## Provider investigation — 2026-09-06

- [Kling 1.5 image-to-video](https://kling.ai/document-api/api/video/1-5/image-to-video) announces retirement on September 15, 2026. Its mask/trajectory contract uses bottom-left pixel coordinates, unlike Wan-Move. The [current capability matrix](https://kling.ai/document-api/guides/capability-map/video) lists no motion brush on the displayed newer models. The shared API field table alone is not evidence that every model supports those fields.
- [Fal's Kling 1.5 API](https://fal.ai/models/fal-ai/kling-video/v1.5/pro/image-to-video/api) exposes dynamic masks, but the 1.6 endpoint's actual input schema omits them. Retiring 1.5 was not selected as a new production adapter. [Fal's Wan-Move endpoint](https://fal.ai/models/fal-ai/wan-move/api) is marked deprecated and unsupported.
- [SandBase's Wan-Move documentation](https://www.sandbase.ai/docs/model-api-reference/video-generation/alibaba/wan/move) lists nested trajectories, but the inspected page does not specify their point fields or a verified price. Availability, private-image transport, charging/cancellation and a live request remain unverified. No credentials were requested or submitted.
- [Vercel's Kling 2.6 API page](https://vercel.com/ai-gateway/models/kling-v2.6-i2v/api) shows motion-brush options, in tension with Kling's current matrix. Treat support as unresolved until a compatible endpoint is exercised; no paid call was made.
- [LightX recamera](https://fal.ai/models/fal-ai/lightx/recamera/api) exposes camera angle/distance trajectories over an input video. It is a camera transformation candidate, not evidence of subject-point control.
- The local NVIDIA GTX 1080 Ti reports 11,264 MiB. The [Wan-Move README](https://github.com/ali-vilab/Wan-Move/blob/80c58a7d2ad175fa82a4d57f79f2a1415317dcfa/README.md) documents a 40 GB BF16 configuration. A compatible reference-model execution is not available here. Alternative low-memory community implementations have not been evaluated.

Zo deployment, Linear reconciliation and actual paid/GPU quality evaluation remain pending the relevant access. Local work continues under the operator's instruction.
