# Lip-sync on retained performances

P7 adds an independent `lip-sync` job for a line that already has a saved audition applied in a completed dialogue version. The owner chooses a verified source frame and a face point, reviews the provider and reserved cost, and starts one pass. A completed pass can be the source of another pass (up to 32), with a flat history of original input/output hashes and generation IDs.

The source must be retained H.264 at exactly 30 fps, up to 1920×1080. A frame-aligned window encloses the selected line. Its uploaded mono PCM contains only that line, with silence in the partial boundary frames. Inputs have equal durations, each below 19 MB, and no more than 900 frames (the operator can impose a smaller bound). The source frame's native dimensions and decoded RGB digest bind the manual face selection. The worker verifies the frame and all copied source files again before dispatch.

The `SyncLipSyncProvider` adapter sends multipart video/audio to Sync `sync-3`, with `sync_mode: cut_off` and native-pixel manual speaker selection. It creates no voice and performs no cloning. It does not claim control of semantic video emotion, intensity or gestures: existing performance is inherited from the retained audio and picture. The service model cannot be pinned to immutable weights.

A durable intent and full reservation precede the dispatch boundary. Only one POST is allowed; a saved remote generation is resumed by its original ID. Missing acknowledgement remains an unknown liability requiring reconciliation. Long-poll failures never trigger another paid submission. Output downloads use exact operator-approved HTTPS hosts without API credentials or redirects. Raw signed download URLs and provider error payloads are not retained in the job or ledger.

The returned clip must preserve the measured dimensions and exact frame count. Assembly creates a new full-film encode with the selected window replaced. It retains an independent copy of the entire original dialogue WAV, caption files and audition evidence. The AAC track in the MP4 is a lossy encode of that retained waveform. This output does not claim the encoded-picture preservation provided by dialogue replacement. The source cut remains available for comparison and rollback.

Owner controls live under **Direct lip-sync for applied voices**. They expose source/line selection, a scaled face picker with native-coordinate keyboard fields, reviewed cost, retained request keys, comparison, downloads and version-bound quality reviews. Mouth timing, face stability and expression use a 1–5 owner rubric. An accepted review is required to choose the result as the export. Earlier review links stay bound to their selected output. Cutaway suggestions reference up to three retained shots in the same scene without recorded dialogue; they do not edit the timeline or invent coverage.

## Operation and recovery

Apply migration `0010_lipsync`. The worker requires PostgreSQL, `HV_SYNC_API_KEY`, and a private `HV_LIPSYNC_POLICY_FILE`. The policy is compiled with `lipSyncPolicy` and records account, licence and price evidence hashes, exact output hosts, positive per-pass held USD, duration limit and validity. No key or active production policy ships. Current character/voice/provider permissions gate admission, dispatch, completion, playback and export selection. Provider permission revisions gate retained playback; a price-only policy update does not revoke an existing output.

Input preparation and final output each have fenced, immutable local or S3 checkpoints. A replacement worker restores owned media and resumes the original provider generation. Project deletion removes content while keeping financial receipts and unresolved reservations. Invoice allocation uses the operator database role:

```
bun scripts/reconcile-lipsync.ts allocation.json --check
bun scripts/reconcile-lipsync.ts allocation.json --apply
```

The `hv-lipsync-invoice-allocation/1` worksheet follows the audio worksheet's conserved allocation fields, with a separately hashed schema. Actual spend comes from explicit operator invoice allocations; held USD is never represented as actual spend. Allocation is idempotent by document hash and revision, survives a purged source, and cannot release another attempt's liability.

Snapshots containing lip-sync use `hv-state/2`. Older readers reject that schema. Prepared media, final files, original generation IDs, reviews, invoices and unresolved holds survive PostgreSQL/S3 portable archives. Existing snapshots without lip-sync retain schema 1. JSON rollback refuses lip-sync accounting because it cannot preserve its dispatch journal. Restore through the PostgreSQL migration path.

## Evidence and qualification limits

Local tests exercise real FFmpeg and a closed multipart HTTP provider, including one submission across interruption, exact input bytes, allowed output hosts, tamper refusal, and a visibly changed fixture window placed between retained head and tail footage. API tests exercise owner isolation, source-frame verification, review concurrency, export rollback, permission revocation and schema/hold preservation. Linux CI additionally exercises concurrent PostgreSQL admission, fresh-worker S3 recovery, invoice allocation, portable archive import and liability after purge.

The browser fixtures contain synthetic tones and mock pictures; they do not demonstrate speech acting or accurate mouth animation. No paid inference, production voice/licence qualification, automatic visual scorer qualification or Zo deployment is claimed. Production evaluation must measure mouth timing, face stability, expression, occlusion, profile views and multiple-speaker selection using authorized footage and audio. Broader P7 semantic video performance, localization and sound/editorial integration remain open.

Contract sources inspected 2026-09-07: [multipart creation](https://sync.so/docs/api-reference/api/generate-api/create-with-files), [generation status](https://sync.so/docs/api-reference/api/generate-api/get), [speaker selection](https://sync.so/docs/developer-guides/speaker-selection), [sync modes](https://sync.so/docs/developer-guides/sync-mode), [sync-3](https://sync.so/docs/models/sync-3), and [OpenAPI](https://sync.so/openapi.json). The inspected OpenAPI SHA-256 is `e255042ea0a27845b355adda0ef73c1b7f81e14fea178485727b78b2d0afaf08`.
