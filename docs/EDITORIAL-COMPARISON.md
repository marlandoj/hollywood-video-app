# Compare frozen editorial versions

The owner editor compares two completed editorial exports with one playhead, one 48 kHz AudioContext and one stereo AudioWorklet. The owner can choose A, B or split-screen picture, listen to either soundtrack, play/pause/stop, seek and step individual frames. Frame controls sit behind a disclosure. On narrow screens the two pictures stack vertically. Comparison uses reduced-resolution originals and saved composition settings.

## Frozen version identity

`GET /api/projects/:projectId/editorial/versions/:jobId?outputRevision=…` returns the export's saved sequence and timeline. Editing the current sequence does not change that version. The version preview routes mirror saved-sequence preview routes under `/versions/:jobId/preview`; POST carries `outputRevision` and `historyRevision`, and subsequent requests carry both in the query. Current ownership, project retention, original permissions and the exact retained output remain required. Changed outputs are refused. Cleanup accepts the originally captured scope after an output changes.

A version prepares media from its export's independent retained copies, including when earlier source jobs are gone. It does not fall back to the current sequence. Session identity includes target kind, retained output, timeline and requested window, so equal raw job/sequence IDs and simultaneous requests for different windows cannot exchange sessions. The browser retains the owner client and version revisions that created each lease for cleanup after rebinding.

## Shared transport

Both streams use the same sample address and device presentation clock. The worklet advances only when both pictures cover the requested block and both soundtracks contain its complete samples. A delayed side holds both sides without skipping source time. A soundtrack choice changes the selected stream at a worklet block boundary without moving the playhead. There is no crossfade or click-suppression qualification.

The comparison duration is the longer timeline. A shorter version holds its last composed picture, and its soundtrack is padded with silence at the exact final sample. Picture frames are drawn together at the common frame. Pause holds the transport; seek resets its epoch and aborts obsolete requests. Stop, completion, page hiding, another preview taking audio focus, and leaving the comparison release both streams and the audio context. Soundtrack choices made during setup remain selected when playback becomes ready.

## Resource bounds

Each side retains at most two source windows, 12 encoded packets totaling 32 MiB, 96 decoded images and 24 completed frames. A comparison therefore retains at most four windows, 24 packets totaling 64 MiB, 192 decoded images and 48 completed frames. The worklet holds at most three audio pages per side. In-flight fetch/decode buffers and canvas surfaces are additional working storage. Existing packet, request, preparation, renewal and cleanup deadlines apply independently to each side.

Saved-sequence and version previews share the same process pool. Its per-project session allowance is four to accommodate two windows on each side; global session allowance remains eight. Source count, preparation concurrency, disk/workspace bounds and current access checks are unchanged. This does not reserve resources across an entire fleet. Browser cache revocation still occurs on server access or scheduled renewal, rather than an instantaneous push.

## Verification and limits

Controller and worklet tests cover a delayed side, shared sample positions, soundtrack selection during playback/setup, unequal final pages, silent tails, final-picture holds, stale seeks, version identities and captured-owner cleanup. API tests decode real picture/audio packets from retained exports after current history changes and the earlier source directory disappears. They reject changed outputs, wrong owners, revoked originals and cross-kind session access. The PostgreSQL/S3 integration suite additionally exercises version preview through a fresh restored API and an independent archive bucket.

A private Chromium fixture exercised 90- and 330-frame exports, playback completion, window rollover, keyboard frame selection, stepping across the shorter cut's boundary, all three picture modes, soundtrack choice and Stop. Desktop and 390-pixel views were inspected; controls measured at least 44 pixels and the mobile document stayed within the viewport. The initial completed run released every owned media cache, lease and audio context. Synthetic audio was muted at the output. These observations establish browser behavior, not listening quality, physical display/audio synchronization, pixel identity with full-resolution exports or sustained realtime performance.

Production listening, long-duration/dense-overlap qualification and deployment remain open. Broader editorial operations, proposed assemblies, script linkage, overlays/adjustment layers and interchange remain in the approved P8 scope.
