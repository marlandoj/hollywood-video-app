# Storyboard image foundation (HV-018 / ZOU-1587)

The generator package exports an ImageProvider contract and a DeterministicMockImageProvider.
This implements task T1 of the rich-animatic seed. It produces labelled PNG slates for local
development and tests. It does not yet change the worker, approval screen, or staging provider.

```ts
import { DeterministicMockImageProvider } from "../packages/generator/src/index";

const frame = await new DeterministicMockImageProvider().generateFrame(
  "Spud arrives at the zoo",
  42,
  {
    widthxheight: "640x360",
    shotId: "shot-01",
    sceneHeading: "EXT. ZOO ENTRANCE - DAY",
    action: "Spud waves to a giraffe.",
  },
  "/tmp/storyboard/shot-01.png",
);
```

ImageProvider exposes name, model, and generateFrame(prompt, seed, params, outPath).
StillFrame contains the path, provider, model, seed, SHA-256 of the PNG bytes, and a CostRecord.
Each mock frame reports one output frame, zero GPU seconds, and zero dollars.

FrameParams accepts optional referenceFrames and identityLocks. These are reserved hooks for
HV-017: the mock ignores them and never opens or fetches their values. They do not provide
identity consistency or likeness validation.

Rendering requires ffmpeg with drawtext and the DejaVu Sans font. Same inputs are byte-stable
on the same ffmpeg/font stack; cross-version or cross-host font reproducibility is not promised.
The seed, prompt, rendered labels, and dimensions determine the background. Dimensions default
to 640x360 and must be even, at least 320x180, and no larger than 4096x4096.

Visible labels contain the shot identifier, up to 60 scene-heading characters, and the first
80 action characters (the prompt is the action fallback). Controls are replaced with spaces.
Text is passed through a temporary UTF-8 file with ffmpeg expansion disabled, so punctuation
and percent expressions remain literal. Full untruncated text is checked against the existing
content policy before any render or output-directory creation.

AbortSignal cancellation stops the subprocess. A 30-second subprocess limit also bounds render
time. Rendering takes place in an isolated temporary directory; only a completed PNG is
atomically moved over the destination. A refused, aborted, or failed render preserves any
previous output. Temporary render and publish directories are removed.

The fal image adapter (T2) is described in [fal-image-provider.md](fal-image-provider.md).
Remaining HV-018 work: moving clips and optional voice/captions (T3), worker/budget/API/frontend
wiring (T4), and full-feature benchmark and staging evidence (T5). The existing mock video path and seed approval state are unchanged.
