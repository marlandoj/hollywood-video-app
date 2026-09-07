# HyperFrames motion graphics

The local rendering pipeline compiles reviewed title, lower-third, credits, slate, watermark and kinetic-text fields into a seekable HyperFrames composition. It renders real PNG frames and an FFV1 BGRA master, retains font files and their licence, and verifies every decoded RGBA frame and its 30 fps timestamp. This is the rendering foundation for P8/P10. Saved owner controls, timeline overlay admission, preview/conform integration, worker checkpoints and project archives are still required before these graphics are available in the studio application.

## Local rendering

Install dependencies with the checked-in Bun lockfile. Browser installation is explicit; a render never downloads a runtime or contacts a provider.

```sh
bun scripts/install-graphics-runtime.ts /absolute/browser-cache
bun scripts/render-graphic.ts docs/examples/lower-third.json /absolute/output-directory /absolute/chrome-headless-shell
```

The installer prints the executable path for Chrome Headless Shell 152.0.7977.75. HyperFrames engine 0.8.31 performs capture, using software rendering and its transparent screenshot path. The engine's generic `window.__hf` protocol receives exact frame times; no GSAP or external animation assets are needed for these authored templates. The worker serves only the compiled composition and retained font bytes on an ephemeral loopback route. CSP and request interception restrict resources to those files. User fields never supply executable HTML, JavaScript, CSS or URLs.

Inter 5.2.8 supplies regular and bold faces across its seven packaged subsets. Fontkit 2.0.4 checks the actual glyph mapping for every non-whitespace code point and weight. Unsupported scripts produce an explicit error. Installed font bytes, Unicode ranges and the SIL Open Font License are retained in each bundle. Additional fonts and language coverage remain future catalogue work.

The compiler records text, credit roles/names, colors, alignment, safe inset, dimensions and frame timing. Text is measured after font loading; overflowing static layouts fail with a correction. Credits roll through the viewport, and their actual pixel speed is reported. A separate canvas element preserves explicitly requested backgrounds during transparent capture. Watermarks are generated only when requested; this pipeline does not add them to films automatically.

## Retained evidence and limits

`graphic.json` binds the composition, fonts, licence, PNG sequence, decoded frame index, master and runtime identities to one revision. Verification requires the expected revision from the caller and rejects changed, reordered or extra files. Actual master decoding must match each PNG's RGBA checksum, dimensions, frame duration and timestamp. Bitexact FFmpeg options make repeated masters byte-identical on the exercised runtime. Cross-platform or cross-version pixel identity is not claimed.

Rendering uses one isolated browser and one frame buffer at a time. Plans support up to ten minutes at 30 fps, with dimensions up to 1920×1080. Actual PNG storage and the master share an 8 GiB ceiling, further bounded by available disk; current free space is checked throughout. Master output has an explicit file-size limit and a truncated result fails frame verification. Rendering stops on cancellation, withdrawn permission or a 30-minute deadline, releases the browser/server and removes its own incomplete directory. Durable distributed reservations and recovery are part of the pending application integration.

Real-media tests cover transparent animation, independent repeat renders, exact alpha and requested backgrounds, source font retention, supported scripts, watermark position, text overflow, altered bundles, cancellation and permission withdrawal. A separate Linux CI job installs the pinned browser and exercises these tests; green unit checks with that job skipped do not qualify the runtime.

## Remaining full-scope work

The next increment must expose saved owner graphics, integrate overlays into editorial history, playback and full-resolution conform, retain them through PostgreSQL/S3 recovery, and verify the desktop/mobile user flow. Maps, data callouts, broader animation direction, masks/compositing and the rest of P10 remain open. No Zo deployment, live application integration or completion of the full studio program is claimed by this rendering foundation.

Implementation references: [HyperFrames engine](https://github.com/heygen-com/hyperframes/tree/main/packages/engine), [Fontkit glyph mapping](https://github.com/foliojs/fontkit#character-to-glyph-mapping).
