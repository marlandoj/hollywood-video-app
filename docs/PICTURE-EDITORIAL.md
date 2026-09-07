# Picture editorial implementation in progress

The timeline and conform core is implemented locally. It is **not yet connected to the owner editor, project persistence, durable jobs, export selection or independent archive recovery**. This document records current semantics and the remaining integration work; P8 remains open.

The model retains up to 16 immutable source descriptions, 256 clips and 256 markers at 30 fps. Audio addresses 1600 stereo 48 kHz samples per picture frame. Picture has four layers; source mix, dialogue, narration, music, ambience, effects and captions have independent lanes. Source mix can preserve a previously mastered nonlinear soundtrack; separate pre-master stems do not reconstruct that master automatically.

Linked clips share source and timing. Split, move, trim, ripple removal/insertion/reorder, slip, roll and slide operate on linked ranges together. An explicit unlink allows independent audio movement for L/J cuts. Ripple boundaries that cross unrelated clips are refused with a correction message. Split clips retain source-relative fade envelopes, preserving their samples and picture output. Deliberate trim/settings edits reanchor envelopes. A slip can move the virtual envelope origin before source zero; processing discards any padding used to preserve that fade phase. Markers move with reordered/rippled ranges.

Edit history records immutable edit nodes and separate cursor events. Undo, redo and branch selection append events; they do not erase abandoned edits. Every node replays its operation from its recorded parent. Expected history revisions detect concurrent writes. The current limit is 1000 events per history. Durable project transactions are still needed around these domain operations.

The conform engine verifies input hashes and decoded picture dimensions/frame counts, trims by source frame index, renders layers over black, retains an FFV1 full-resolution master and per-frame hashes, and produces H.264/AAC MP4 plus HLS. Audio is mixed in bounded chunks with Q20 gains and source-relative linear fades. It retains each lane and the summed final WAV, rejecting lane or final overload. Plain WebVTT captions move with their source ranges. Delivery timestamps floor starts and ceil ends to milliseconds so even a very short retained cue has positive duration; original sample positions remain in the timeline. Unsupported styled/region/markup source captions are refused rather than discarded.

Measured dialogue/narration windows are separate from caption coverage. Cutting a voice window yields an explicit review item even if captions are removed. Trimmed audio whose speech timing is unknown is separately identified. Admission still needs to derive these source facts from retained job receipts and require review of the resulting warnings; the media core alone is not an authorization boundary.

## Evidence so far

Ten local tests exercise hand-checked edit ranges, linked caption/marker movement, branch restoration, stale writes, voice cuts independent of captions, exact sample/frame reorder, unchanged split fades, upper-layer boundaries, slipped source addresses, silent/black gaps, source mismatch, overload, cancellation and withdrawn access. A separate local Spud fixture reorders its two retained shots with the previous restored/mastered soundtrack, proving exact decoded source-frame order and exact original master-sample order. These are local engine checks, not owner workflow, production listening or deployment evidence.

## Required before this increment can be integrated

- Source admission must bind original job provenance, current project/cast/voice/recording permissions, source files, measured voices, caption language and any burned-caption limitations. Continued edits must flatten original source references without cumulative lossy processing or nested edit jobs.
- Project persistence must save edit histories and branches atomically; the browser must load, edit, undo/redo, review speech cuts, compare/play and select independent versions. Proxy preview and full-resolution conform must agree.
- Dedicated provider-free jobs need admission/idempotency, cancellation, lease fences, checkpoints, current permission checks, S3 inventories and original invoice conservation. Snapshots/archives need schema-aware validation and complete owned-media restoration.
- The current single filter graph shares source decoders across clip branches. Large or heavily reordered timelines can buffer substantial decoded media. Bound that behavior and validate long/high-resolution sources before exposing the advertised clip/duration limits; short fixture success is insufficient.
- Run appropriate integration/failure tests, full Linux CI and existing benchmark rules, then owner desktop/mobile checks and exact merged-tree verification. No PR merge or Zo rollout has occurred for editorial yet.

The complete P8 scope also requires proxies, freeze frames and retiming/speed ramps, full track/transition operations, take swaps and synchronized comparisons, proposed alternate assemblies, titles/overlays/adjustment layers, script-linked editing, and OTIO/EDL/FCPXML/AAF interchange. These remain explicit requirements. P7/P9 production voice, sound and licensing qualification and all other studio waves remain open.

Filter references: [FFmpeg 8.0.1 documentation](https://github.com/FFmpeg/FFmpeg/blob/n8.0.1/doc/filters.texi), including frame-index trims, alpha fades, overlay end-of-file handling and frame synchronization. The concrete generated filter and runtime fingerprint accompany each local conform.
