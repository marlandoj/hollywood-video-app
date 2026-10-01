# Retained sound sessions

Optional [per-track noise reduction](SOUND-RESTORATION.md) now retains original, processed and removed audio, reviewed noise references and comparison meters. These version-3 sessions preserve original source performances and can be continued with restoration disabled.

An owner can open **Edit sound session** on a retained film, dialogue/narration version, accepted lip-sync result, or previous sound version. Upload private recordings, place music/ambience/effects cues, review the spotting list, render, compare, and select a separate export. Picture frames, caption bytes, source performances and original provider receipts remain attached to the version. Sound rendering dispatches no generation provider and reserves no provider spend.

Optional reviewed loudness measurement, normalization and peak limiting now retain a separate delivery master and before/after/AAC evidence; see [SOUND-FINISHING.md](SOUND-FINISHING.md). The seven stems remain before master processing. The default leaves processing unchanged.

This is a sound editor over fixed picture timing. It does not complete the P8 multitrack NLE or the P9 sound department. Production listening, generative music/effects licensing, theme automation, noise reduction and professional interchange remain open. Per-scene ambience beds that the studio generates itself, chosen from each scene's heading, are described in [SOUND-AMBIENCE.md](SOUND-AMBIENCE.md). Sample peaks alone do not establish LUFS, true peaks, EBU R128 or ATSC A/85 qualification. Zo deployment remains pending.

## Owner workflow

1. Load an eligible retained cut. Original cuts need isolated, measured speech assets and clean picture; an embedded soundtrack without isolation evidence is not accepted. Lip-sync must carry an accepted review of its exact output.
2. Save WAV recordings with a name, source, optional credit, rights basis, distribution/ownership notes and explicit attestation. Preview each available recording. The library retains the submitted original and a verified mix copy. The name, source, credit and notes pass the prompt safety gate (each alone, then together) before any audio is read; a refusal answers 422 `content_policy` and keeps nothing (HV-031-13). Recordings saved before that check are not re-checked.
3. Add cues to music, ambience or effects. Set the film start, cue duration, source trim, repeat, level, stereo balance, fades and reduction around measured voice windows. Dialogue and narration have separate overall levels. Existing narration ducking carries into the dialogue stem.
4. Review the complete spotting list, source credits and settings. Any edit invalidates the review. Render a new durable job, listen, download its media and JSON cue sheet, and choose the export. Continued edits start from the selected session. Clear all cues explicitly restores a voices-only mix at the chosen voice levels. Retained versions support export rollback.

The browser retains an in-memory draft and warns before leaving it; it does not yet provide durable draft undo/redo or picture edit operations. Submitted jobs retain an idempotency key and can be reopened after refresh. A failed request can be retried with the same reviewed body without creating another render. A failed completed job requires a revised review and a new key.

## Audio contract

Input is bounded little-endian uncompressed WAV: one or two channels, 8–192 kHz, integer 8/16/24/32-bit or finite normalized 32/64-bit float. Compressed WAV, playlists, malformed RIFF chunks and unsupported layouts are rejected before FFmpeg. Limits are 128 MiB and 10 minutes per upload, 64 library recordings and 512 MiB of combined original/canonical library bytes. Uploading is serialized per API process; project version checks arbitrate saves across processes.

Canonical audio is 48 kHz stereo, 24-bit signed PCM with a fixed 44-byte WAV header. Mono is copied to both channels. Conversion records the exact FFmpeg runtime and recipe: native `swr`, filter size 64, phase shift 10, exact rational ratios, no dither, nearest rational output frame count, explicit padding/trim. The settings follow the [FFmpeg resampler interface](https://www.ffmpeg.org/ffmpeg-resampler.html). Original audio and metadata remain available beside the normalized copy. No inference about production licence validity is made from an owner's attestation.

Cue positions, lengths, trim endpoints and envelopes are integer frames at 48 kHz. The source trim interval is half-open. Non-repeating cues cannot exceed that interval; repeating cues wrap it without stretching. Fade-in starts at zero; fade-out ends at zero. Stereo balance attenuates the opposite channel without cross-feeding it. Ducking uses measured dialogue and narration speech windows and linear amplitude attack/release; overlapping windows choose the strongest reduction once.

Mixing streams 65,536-frame chunks and sums quantized Q20 coefficients before final 24-bit rounding. Each stem and the final mix rejects out-of-range samples instead of silently clipping. Gains and balance use explicit 0.1 steps. Limits are 64 cues, one hour of picture and one hour of combined cue duration. Sample order, trimmed loop phase and duck envelopes continue across chunk boundaries. Workers check cancellation, deadline, lease and current permissions throughout processing.

Each output owns seven WAV stems: dialogue, narration, music, ambience, effects, M&E, and final mix. It also owns the original base picture/voice/provenance files, canonical base voices, and original/canonical recordings used by its cues. M&E is music plus ambience plus effects. AAC stereo 48 kHz is muxed with the exact retained encoded picture; HLS and captions accompany the MP4. Voice auditions are not synthesized again. Re-normalization uses the newly reviewed runtime; original performance samples and timing are retained.

## Generated music cues (HV-024-11)

`POST /api/projects/<id>/music-cues` with `{idempotencyKey, prompt, durationSec, seed?}` asks the
studio's music vendor for one instrumental cue and keeps it in the project's sound library. The
operator approved ElevenLabs Music on the existing ElevenLabs account, with its own line (G15).

- **The vendor is off unless the operator names it.** `HV_MUSIC_PROVIDER=elevenlabs` and the
  `HV_ELEVENLABS_API_KEY` the voice adapter already uses are both required. With neither set, the
  route answers 409 and `GET /sounds` says *"Generated music is not enabled on this studio, so the
  Composer writes its own score."* Any other value of `HV_MUSIC_PROVIDER` stops the API at startup.
  Tests use the deterministic mock adapter (`MockMusicProvider`), handed to the studio directly.
- **The order.**
  1. The prompt meets the content gate, alone and with its whitespace collapsed. A refusal is 422
     `content_policy`, and nothing is stored or reserved.
  2. Project rights, the library's size and the one-at-a-time import slot are checked.
  3. The hold is reserved, in one transaction, against three limits: the music line, the film's
     limit, and the month's generation cap.
  4. The vendor is asked once.
  5. The delivery is probed with ffprobe and decoded to 48 kHz stereo 16-bit WAV by a fixed recipe
     (`hv-music-decode/1`). It is refused if it is not the provider's declared format, or is more
     than 2 s from the length asked for.
  6. The decoded cue is imported like an uploaded recording.
  7. The cue is settled.
- **The music line** (`packages/operator/src/music-ledger.ts`; a JSON file at `HV_MUSIC_LEDGER_PATH`
  beside the cost ledger by default, or `hv_music_cues` in PostgreSQL when the studio has a database):
  - **$10 for the life of the studio**, from `HV_MUSIC_VENDOR_CAP_USD`. It is lifetime, like the voice
    line and the crew's line: it does not reset with the month.
    The setting is plain dollars (`10`, `7.50`), never above `HV_MONTHLY_BUDGET_USD`; anything else, or
    a monthly cap that is not plain dollars, stops the API at startup (HV-024-13).
  - A cue counts its hold ($0.15 per minute asked for, rounded up to the cent) until it ends, then its
    recorded cost. A cue never sent counts nothing. The hold is worked in whole cents, so 7.4 minutes
    holds exactly $1.11 (HV-024-13).
  - **The cost is the hold.** The vendor bills the length asked for (`music_length_ms`), so a cue
    that came back shorter costs no less, and nothing costs more. A vendor's own figure is never used.
  - Past the line the refusal is 429 `budget_exhausted`: *"The elevenlabs music line has reached its
    limit of $10.00 (… spent or held). Ask the studio operator to raise it."*
- **It is generation spend too.** The same hold is an ordinary generation reservation (stage
  `music-cue`, with the film and the vendor on it), so it counts against:
  - **the film's limit**, refused as *"This film has reached its spending limit …"*;
  - **the month's generation cap**, refused as *"generation capacity is reserved …"*.

  Its cost becomes an ordinary cost event (`music:<cue id>`), so the film's spend, the month-to-date
  rollup and the operator's diagnostics all show music.
  - **The JSON store** takes the music ledger's lock around the cost ledger's own and ends the hold
    at once.
  - **PostgreSQL** checks the line, the film and the month in one transaction under the cost ledger's
    budget-row lock. The API marks the cue settled. The worker's reconcile then writes the cost event
    and ends the hold (`postMusicCuesWithin`), because the API role may neither write cost events nor
    end a hold. Until then the hold, which is never less than the cost, still counts.
  - The worker never sweeps a cue's hold as a finished job's.
- **Alerts.** Crossing $3 and $7 logs `music.budget_alert` (provider, committed total). Each is
  raised **once, ever**, by the cue that crosses it, after its hold is committed.
- **Failures.**
  - A request that was never sent releases its hold.
  - One that may have been sent records its cost at the hold, unreconciled, until the operator
    reconciles it.
  - A cue that was made but could not be kept is still settled, because the vendor was paid.
  - A retried request key returns its cue. If that cue is still being made, the answer is 409
    *"still being made"*.
  - If a cue is still held more than ten minutes after it was reserved, its process stopped before
    settling. A retry records it as unreconciled and says so (409). Neither answer is a budget refusal.
- **Rights.** The library record says who made the cue: *"Generated by ElevenLabs Music (music_v1) on
  the studio operator's account"*, basis `licensed`, its use governed by that account's terms.
- **Unverified until the live proof.** The repository documents no part of ElevenLabs Music's API.
  The request — `POST /v1/music?output_format=mp3_44100_128` with `prompt`, `music_length_ms`,
  `model_id: "music_v1"`, `force_instrumental: true`, answering MP3 bytes — is written against the
  public description, and the 10–300 s bounds are the contract's own. No live cue has been made.

## Version, permission and recovery contract

`sound-mix` is a separate queue stage with an immutable reviewed source/session/runtime plan, zero provider reservation and fenced checkpoint/complete operations. All source file sizes and hashes are pinned before admission. Continued sessions retain one original non-sound base and their own copies; they do not recursively embed prior sound jobs. Sound after accepted lip-sync preserves its transformed picture, quality review, dry voice inputs, narration and original provider history. Applying lip-sync after a sound session is not yet exposed.

Project rights, current character/voice permissions, lip-sync policy permission and active recording receipts gate rendering, completion, playback, selection and review. A changed source lip-sync review invalidates in-flight source admission. Withdrawing a recording appends an availability event and blocks versions using it. The owner can still inspect that sound version to remove the withdrawn cue and render another version. History and original bytes are retained until project retention/purge.

PostgreSQL admission serializes budget and project updates, verifies S3 source inventory, and enqueues one job per reviewed idempotency key. S3 checkpoints upload every owned file before publication. A fresh worker verifies and completes a checkpoint under a new lease without another mix. Generic provider dispatch/cost recording is forbidden for sound jobs. Original voice and lip-sync liabilities remain on their original provider attempts; a sound render neither settles nor duplicates them.

Snapshots containing the sound library or sound jobs require **hv-state/3**. Earlier schemas are rejected instead of dropping recording rights/history. Archives include indexed original and canonical library media plus all independent job files; import requires an empty destination bucket and verifies hashes, source evidence, picture identity, captions, seven reproduced stem hashes and sample peaks. Verification uses retained canonical conversions instead of changing them with a newer decoder. Orphan collection protects indexed library media, including withdrawn recordings. Project purge removes their content under the existing retention contract.

## Verification

Numerical tests exercise stereo balance, fades, overlapping duck windows, clipping, mono resampling and non-constant loop phase across chunk boundaries. Owner API/media tests cover admission, immutable original bytes, same-size tampering, zero provider costs, continued editing, clearing, export selection, revocation, Spanish dialogue/narration and accepted lip-sync. PostgreSQL/S3 tests exercise concurrent saves/admission, interrupted checkpoint recovery, independent archive restore, schema downgrade rejection and late original invoice settlement. Browser checks exercise the owner flow and responsive layout with explicitly synthetic recordings and mock picture. They establish software/media contracts, not production sound quality.
