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

`POST` with `{generationApproved: true, worklistRevision, holdApprovedUsd}` does the following:

1. Refuses with 503, holding nothing, when there is no current policy.
2. Refuses a stale list (409).
3. Refuses (409), before anything is held, unless `holdApprovedUsd` is the creator's approval of exactly the hold this list would take now: a number equal to `newHeldUsd` to the micro-dollar (HV-022-24). A missing, malformed or different amount is refused, so `generationApproved` alone queues nothing. The amount a creator was shown goes stale when another run takes a line in between; they are then asked again.
4. Refuses with 503, holding nothing, when there is no PostgreSQL provider service.
5. Checks the sum of the new passes' holds against the film's limit and the monthly cap before the first admission. A list that doesn't fit is refused (429) before anything is held. This check is made first, but the caps are enforced per pass, in step 7. Another admission in between can leave room for only some of the passes, so a list may be partly admitted. No cap is ever exceeded.
6. Decodes each saved frame again and skips one whose hash differs.
7. Admits each remaining line through `admitLipSync`, as an ordinary `hv-lipsync-plan/1` pass of the voiced cut under its fixed key. The ledger re-checks the film's limit and the month under its lock and reserves the hold.

The answer lists:

- `admitted`: passes created by this request.
- `reused`: passes the ledger already held under the same key, from a concurrent request or a retry.
- `skipped`: lines whose frame check failed.

`heldUsd` counts only `admitted`, so it is 0 when nothing new was queued.

When a pass is refused part-way through the list, the answer still lists the passes admitted before it:

- a budget or capacity refusal is a 429 (`budget_exhausted`), and a price policy that changed mid-list is a 409 (`policy_changed`);
- another refusal after at least one admission is a 207, with `error` and `stoppedAt`;
- an unexpected failure after at least one admission, such as a lost database connection, is still a 500, and its answer lists the passes already queued with a plain `error` (its own text stays out of the answer).

The passes are independent versions of the voiced cut. They are not chained, because each pass re-encodes the film and no owner point stands on the result.

**The creator approves the lip-sync hold (HV-022-24).** With the switch on, the studio's run stops after the cast's voices are laid in, on its own step, "Your approval: the lip-sync hold". The step shows:

- the voiced cut;
- the lines the crew would lip-sync;
- the number of passes and the policy's flat hold per pass;
- the exact total the approval holds;
- how many other on-camera lines still need a face point.

Nothing is queued or held until the creator chooses:

- **Approve the $N lip-sync hold** sends `holdApprovedUsd` with that amount. If the server refuses it because the hold has changed, nothing is held, and the step is shown again with the hold as it stands.
- **Keep the voiced cut without lip-sync** asks for nothing, holds nothing, and adds a note saying so.

Either way the run then goes on to the score and the titles, from the voiced cut. A list with no new passes asks the creator nothing. When a reopened feature finishes its earlier sequences, the run does not stop for them, so their lip-sync hold is not asked for: a note says what was ready and that nothing was queued or held.

The studio's run adds a note saying:

- what it queued and held, including part of a list when the answer lists `admitted`;
- that nothing new was queued, when nothing was;
- that the creator kept the voiced cut without lip-sync, when they declined;
- how many lines still need a face point.

It does not choose a pass as the export. A finished voiced cut's job view carries `studioLipSync: true` only while the switch is on, and only when the work list can read it: the selected output, with an applied take.

Not yet built, and needed for full automation:

- choosing a face without the owner, through a detector or Sync's speaker detection, which needs a new capability revision (HV-022-25 builds the contract for fal.ai's detector, closed and off; see "The studio's face-point finder" below);
- one export that lays in every completed pass's retained `provider.mp4`;
- saving a face point without running a pass.

### The owner's decisions (2026-11-11)

The owner, Kevin, answered HV-022-23's open questions on 2026-11-11 (`docs/loop/increments/HV-022-24.md`):

- **Price.** The flat hold per pass stays: the policy's one `heldUsd` per pass, bounded by `maxFrames`. There is no per-second pricing and no new policy schema.
- **Reused face points.** An unreviewed pass keeps offering its face point. A pass reviewed `revise` or `cutaway`, or rated under 3, offers none, as HV-022-23 already built.
- **Approval.** The creator approves the lip-sync hold separately from the film's approval, as described above.
- **The first face point.** It will come from Veo or fal.ai, in a later increment. Nothing here calls either.

See `docs/loop/increments/HV-022-23.md` and `docs/loop/increments/HV-022-24.md`.

### The studio's face-point finder (HV-022-25)

The owner's answer was "First face point: VEO or fal.ai". The finder uses **fal.ai**, because the studio already
works with fal for its picture and stills (`packages/generator/src/fal.ts`, `fal-image.ts`); Veo would need a new
account. The studio never adds an account, a key or a vendor by itself. The finder is a contract with a closed mock
adapter: **nothing calls fal, and no key or policy ships.**

**When it is on.** All five of these, or the work list is exactly as before, to its revision:

1. `HV_STUDIO_LIPSYNC=1`;
2. a current lip-sync policy;
3. the PostgreSQL provider service;
4. a detector passed to the API server (`faceDetector`). Only the tests pass one; nothing in the studio builds
   a live one;
5. a current operator policy for the finder, `HV_FACE_DETECTION_POLICY_FILE`, compiled with `faceDetectionPolicy`
   (`hv-face-detection-policy/1`). It records the account and price evidence hashes, a flat `heldUsd` per
   detection and a validity window.

**The capability** (`packages/generator/src/face-detection-capability.ts`, `hv-face-detection-capability/1`)
pins `fal-ai/moondream-next/detection` at `https://fal.run/fal-ai/moondream-next/detection` and the request:
`task_type: "point_detection"`, `detection_prompt: "face"`, `combine_points: false` (two faces are never merged
into one point), `show_visualization: false` and `use_ensemble: false`, with the frame sent as a PNG data URI.
fal lists $0.0011 per second of compute. Its revision is pinned by its own test. It is not a performance lane
(voice or lip-sync), so it is not in `PERFORMANCE_REGISTRY` and needs no entry in
`capability-revision-pins.json`.

**Reading the answer.** `text_output` is undocumented, so `parseFaceDetection` accepts exactly one shape,
`{"points":[{"x":…,"y":…},…]}`, with each coordinate a number in [0, 1] of the frame. Any other key, shape, value
or text is `unparseable`. A point is the frame's own pixel, `floor(x × width)`, `floor(y × height)`, and must lie
inside the frame. Exactly one face gives a point. Every other answer gives none:

| outcome | detail shown |
|---|---|
| `one-face` | One face found; its point is the studio's suggestion until the owner chooses one. |
| `several-faces` | 2 faces found; choose the speaker under Direct lip-sync. |
| `no-face` | No face found; choose the speaker under Direct lip-sync. |
| `out-of-bounds` | The face found lies outside the frame; choose the speaker under Direct lip-sync. |
| `unparseable` | The detection's answer could not be read with certainty; choose the speaker under Direct lip-sync. |
| `failed` | The face detection did not answer; choose the speaker under Direct lip-sync. |

The studio never guesses which face speaks.

**In the work list.** A line with no owner point (`no-face-point`) is planned for one detection
(`faceDetection: {status: "planned", frame}`). The frame is the middle of the line's window, decoded and verified
by `previewLipSyncFrame`, as the owner's own frames are. A settled detection with one face is a suggestion. It
makes its line `ready`, with `facePointJobId: null` and `detectedPoint` giving its provenance:

- `source: "detected"`;
- the provider and model;
- the frame hash;
- the request hash;
- the policy and capability revisions.

The pass made from it is a studio pass like any other. Its request hash names the detection.

- **The owner's point always wins**, whenever it was chosen.
- **HV-022-23/24's reuse rules apply to suggestions.** A suggestion whose studio pass failed, was cancelled, or
  was last reviewed as anything but an accept rating 3 or more is not offered again.
- **A line is never detected twice on the same picture**, under any policy. Its earlier result stands, and every
  outcome but a usable point leaves the line to the owner, with its detail.

**Money.** Each detection holds the finder policy's flat `heldUsd`, in the one amount the creator approves on
the lip-sync step. The most the approval can hold is:

- each ready pass;
- plus, for each planned detection, its own hold and the pass it may make possible.

For example: one ready pass at $5.00, plus one detection at $0.02, plus its possible pass at $5.00, is
$10.02. `holdApprovedUsd` must equal that amount to the micro-dollar. The studio's step shows the detection as
its own line: "Face detection: 1 frame at $0.02 each ($0.02), spent even if no face is found." A detection is
spent whether or not it finds a face; its line's pass is held only when exactly one face is found. Declined,
nothing is detected or spent.

**The ledger.** `PostgresLipSyncLedger.admitFaceDetection`, beside `admitLipSync`, works under the ledger's own
lock:

- it re-checks that the film is open and that the finder policy is the one the detection names (otherwise
  "policy changed", 409);
- it re-checks the film's limit (`assertFilmWithin`);
- it re-checks the month's cap, by reserving the hold as an ordinary `hv_reservations` row (stage
  `face-detection`);
- it writes the detection's `hv_face_detections` row (migration `0022_face_detections`) in the same
  transaction.

The row's id is its **detection key**: the cut, shot, line, decoded frame hash and policy revision. A replay
returns the row already held and holds nothing new, and the detector is never asked again for it. The detector is
asked once, after the hold commits. Its result is recorded once (`settleFaceDetection`), and the record is sealed
by its own revision. The worker's reconcile posts a settled detection's whole hold as its cost event
(`face-detection:<id>`) and ends the hold.

**A detection that never finished.** If the API process stops, or the result's write fails, after a detection was
held, its row stays `held`. The detector may already have been asked, so the money is treated as spent. The worker's
reconcile settles any detection still held `FACE_DETECTION_STALE_MS` (10 minutes) after it was admitted as
`failed`: no point, and the line left to the owner. It then posts the whole hold as cost, as for any other detection.
The detector is never asked again for it, and a late answer from the request that held it changes nothing. Until
then the hold counts against the month and the film. The line is not planned again on the same picture; the owner
chooses its face under Direct lip-sync.

**Repairing a detection by hand.** The reconcile leaves a row held only when its record no longer validates (its
`body` was edited, or its seal does not match). The work list then refuses to read the film's detections ("The face
detection ledger is unreadable"), and the hold keeps counting. To repair it, as the operator, with the worker
stopped:

1. Read the row: `select id, project_id, status, held_usd, body from hv_face_detections where posted_at is null`.
2. If its `body` can be restored from a backup, restore it, and the next reconcile settles and posts it as above.
3. Otherwise, in one transaction: insert its cost event as the reconcile would (`event_key` `face-detection:<id>`,
   stage `face-detection`, provider `fal`, `total_usd` the row's `held_usd`), delete its `hv_reservations` row
   (stage `face-detection`), and delete the `hv_face_detections` row. The money stays spent, and its line is
   planned again on the next approval, as a new, separately held detection.

**What a request does, in order.** On approval (`POST …/work-list`), after the approval and the pre-check of the
caps:

1. **The ready lines' passes first.** Their frames are verified, the film and the cut are read again, and each pass
   is admitted as in HV-022-23. So slow detections never keep an approved ready pass from being queued.
2. **Then the detections.** The film, the owner's session and the selected cut are read again (the same check as
   before a pass: the retained source, the selected output and its revision). For each planned line, its frame is
   decoded and verified. Its permission is then checked on the plan its pass would be queued under, before anything
   is held: the cast's permission and every retained voice's permission (`studioLipSyncDetectionPlan`, with the
   frame's centre standing in for the point not yet known). A line it refuses is skipped (`skipped`, with
   `stage: "face-detection"` and the reason). No detection is held for it, and its frame is never sent. A permission
   withdrawn for the whole film refuses the request at its first read, before anything is held.
3. **Then the passes the detections made possible**, admitted as in step 1.

Every stop after something was held answers with what was held: 207, 429 for the budget, or 500 for an unexpected error. A detection is listed
in `detections` as soon as it is held, before the detector is asked. A stop while it is asked, or while its result
is recorded, still reports its hold, with `outcome: null`.

**The answer.** `POST …/work-list` gains:

- `detections`: each line's outcome, faces, detail and whether it was a replay. A replay was run, and paid for, by
  an earlier request: it is not counted in `detectionHeldUsd`, and the studio does not say it was checked or spent
  now. Its outcome is `null` while that request is still asking;
- `detectionHeldUsd`.

`heldUsd` counts the new detection holds with the new passes. With the finder off none of these fields appear.

The studio counts the lines it will look at by the route's own `faceDetection.newDetections`. The list's
`faceDetection.planned` also counts a planned line that already holds a pass, which the route does not look at.

**Snapshots and restores.** Like music cues (HV-024-11), face detections are not in state snapshots or project
archives: `hv_face_detections` is not exported. A posted detection's cost is, as an ordinary cost event, so a restore
keeps the money and forgets which detections it paid for. After a restore:

- each line detected before has no record, so it is planned again, and a new approval holds and pays for a new
  detection;
- a suggestion is gone, so its line is `no-face-point` again, unless a studio pass on it was restored. That pass
  keeps its plan, with its point;
- a detection still held when the snapshot was taken has no record, so nothing posts its hold. A whole-studio
  snapshot carries its `hv_reservations` row, which then keeps counting against the month until the operator
  removes it. A film's own snapshot carries neither.

Before taking a snapshot, let the worker's reconcile post every detection: no row of
`select id from hv_face_detections where posted_at is null` should be left.

**Known gaps:**

- The `text_output` format and the data-URI size limit are to be confirmed on the first live call.
- Nothing builds a live detector, and the key's home is not decided.
- The detector runs inside the API request (one call, up to 60 s each), after the ready passes are admitted.
- A detection that never finished is settled as `failed` by the worker after 10 minutes, so its line waits for the
  owner's point.

## Operation and recovery

Apply migration `0010_lipsync` (and `0022_face_detections` for the studio's face-point finder, which also needs `HV_FACE_DETECTION_POLICY_FILE` and an injected detector; neither ships). The worker requires PostgreSQL, `HV_SYNC_API_KEY`, and a private `HV_LIPSYNC_POLICY_FILE`. The policy is compiled with `lipSyncPolicy` and records account, licence and price evidence hashes, exact output hosts, positive per-pass held USD, duration limit and validity. No key or active production policy ships. Current character/voice/provider permissions gate admission, dispatch, completion, playback and export selection. Provider permission revisions gate retained playback; a price-only policy update does not revoke an existing output.

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
