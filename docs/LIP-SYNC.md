# Lip-sync on retained performances

P7 adds an independent `lip-sync` job for a line that already has a saved audition applied in a completed dialogue version. The owner chooses a verified source frame and a face point, reviews the provider and reserved cost, and starts one pass. A completed pass can be the source of another pass (up to 32), with a flat history of original input/output hashes and generation IDs.

The source must be retained H.264 at exactly 30 fps, up to 1920×1080. A frame-aligned window encloses the selected line. Its uploaded mono PCM contains only that line, with silence in the partial boundary frames. Inputs have equal durations, each below 19 MB, and no more than 900 frames (the operator can impose a smaller bound). The source frame's native dimensions and decoded RGB digest bind the manual face selection. The worker verifies the frame and all copied source files again before dispatch.

The `SyncLipSyncProvider` adapter sends multipart video/audio to Sync `sync-3`, with `sync_mode: cut_off` and native-pixel manual speaker selection. It creates no voice and performs no cloning. It does not claim control of semantic video emotion, intensity or gestures: existing performance is inherited from the retained audio and picture. The service model cannot be pinned to immutable weights.

A durable intent and full reservation precede the dispatch boundary. Only one POST is allowed; a saved remote generation is resumed by its original ID. Missing acknowledgement remains an unknown liability requiring reconciliation. Long-poll failures never trigger another paid submission. Output downloads use exact operator-approved HTTPS hosts without API credentials or redirects. Raw signed download URLs and provider error payloads are not retained in the job or ledger.

The returned clip must preserve the measured dimensions and exact frame count. Assembly creates a new full-film encode with the selected window replaced. It retains an independent copy of the entire original dialogue WAV, caption files and audition evidence. The AAC track in the MP4 is a lossy encode of that retained waveform. This output does not claim the encoded-picture preservation provided by dialogue replacement. The source cut remains available for comparison and rollback.

Owner controls live under **Direct lip-sync for applied voices**. They expose source/line selection, a scaled face picker with native-coordinate keyboard fields, reviewed cost, retained request keys, comparison, downloads and version-bound quality reviews. Mouth timing, face stability and expression use a 1–5 owner rubric. An accepted review is required to choose the result as the export. Earlier review links stay bound to their selected output. Cutaway suggestions reference up to three retained shots in the same scene without recorded dialogue; they do not edit the timeline or invent coverage.

## Studio lip-sync (HV-022-23)

The studio's film run can queue lip-sync passes for a voiced cut's on-camera lines. It is off unless the operator sets `HV_STUDIO_LIPSYNC=1`. The switch is not part of the policy, the project or any job, so off, every route, view, plan and hash is as before, and `…/work-list` is an unknown route. Two things hold whether it is on or off:

- The request log and metrics label `work-list` as a route word (`PROJECT_ROUTE_WORDS`), so an unknown `…/work-list` request is logged under that pattern rather than as `:id`.
- The owner's submit route refuses a request key that starts `studio-lipsync-` (409). That prefix belongs to the studio's passes, so an owner key never stands for one or collides with one.

`lipSyncWorkList` (`packages/planner/src/lipsync-worklist.ts`) lists every line of a voiced cut with its shot, speaker, window, held cost and one reason it is in or out. In order, the reasons are:

- `no-applied-voice`: the line has no applied take.
- `no-window`: the line's picture timing on this cut gives no lip-sync window. The other lines are still listed.
- `unplaced`: the sequence plan is not `dialoguePlacement: "speaker"`.
- `off-camera`: V.O., O.S., or a device or door voice (`Scene.offCameraDialogue`).
- `not-framed`: the shot's prompt has no speaking sentence naming this speaker.
- `already-synced`: the cut already has a pass for the line.
- `pass-limit`: the cut has 32 passes.
- `too-long`: the window is longer than the policy's `maxFrames`.
- `failed-pass`: the studio's own pass for the line, under its key, failed or was cancelled.
- `no-face-point`: no saved face point applies.
- `ready`.

Nothing detects a face. A line is ready only when the owner already chose a face point for that shot and cast character on the same picture. A point applies only if its frame lies inside the new window:

- Every voiced cut of one final is the same picture, named by its `videoStreamSha256`, because dialogue replacement copies the picture packets.
- A lip-sync output is its own picture, because it is a new encode.

These passes offer no point:

- failed, cancelled and studio-queued passes;
- any pass whose latest owner review is not `accept`, or rates anything under 3.

A pass not yet reviewed still offers its point: the owner chose it on a decoded frame, and the review rates the provider's output, not that choice.

**Retries.** The studio never buys a line twice by itself. A studio pass's key is fixed by the cut, the line and the policy revision, and any existing job under that key counts:

- A live or finished pass is listed under `queued`.
- A failed or cancelled one is listed under `failed`, with the reason `failed-pass`.

The owner retries a failed line under Direct lip-sync, with their own key and face point. A new policy revision is a new key, so the studio may queue that line once more under it.

`GET /api/projects/:projectId/lip-sync/:jobId/work-list` returns:

- the list, with `enabled` and the reason it is unavailable;
- `queued` and `failed`, as above;
- the new passes' total hold.

`POST` with `{generationApproved: true, worklistRevision}` does the following:

1. Refuses with 503, holding nothing, when there is no current policy or no PostgreSQL provider service.
2. Refuses a stale list.
3. Checks the sum of the new passes' holds against the film's limit and the monthly cap before the first admission. A list that doesn't fit is refused (429) before anything is held. This check is made first, but the caps are enforced per pass, in step 5. Another admission in between can leave room for only some of the passes, so a list may be partly admitted. No cap is ever exceeded.
4. Decodes each saved frame again and skips one whose hash differs.
5. Admits each remaining line through `admitLipSync`, as an ordinary `hv-lipsync-plan/1` pass of the voiced cut under its fixed key. The ledger re-checks the film's limit and the month under its lock and reserves the hold.

The answer lists:

- `admitted`: passes created by this request.
- `reused`: passes the ledger already held under the same key, from a concurrent request or a retry.
- `skipped`: lines whose frame check failed.

`heldUsd` counts only `admitted`, so it is 0 when nothing new was queued.

When a pass is refused part-way through the list, the answer still lists the passes admitted before it:

- a budget or capacity refusal is a 429 (`budget_exhausted`), and a price policy that changed mid-list is a 409 (`policy_changed`);
- another refusal after at least one admission is a 207, with `error` and `stoppedAt`;
- an unexpected failure after at least one admission, such as a lost database connection, is still a 500, and its answer lists the passes already queued with a plain `error` (its own text stays out of the answer).

The passes are independent versions of the voiced cut. They are not chained, because each pass re-encodes the film and no owner point stands on the result. The studio's run adds a note saying:

- what it queued and held, including part of a list when the answer lists `admitted`;
- that nothing new was queued, when nothing was;
- how many lines still need a face point.

It does not choose a pass as the export. A finished voiced cut's job view carries `studioLipSync: true` only while the switch is on, and only when the work list can read it: the selected output, with an applied take.

Not yet built, and needed for full automation:

- choosing a face without the owner, through a detector or Sync's speaker detection, which needs a new capability revision;
- one export that lays in every completed pass's retained `provider.mp4`;
- saving a face point without running a pass.

See `docs/loop/increments/HV-022-23.md`.

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
