# Durable line auditions

An `audio-take` job generates one current screenplay line for one saved character.
It retains the effective voice, pronunciation, speed, volume, emotion, notes,
pauses and word/phoneme timing. Audio remains mono 48 kHz signed 16-bit PCM with
an owned WAV and performance JSON. Explicit owner application can reuse it in
an independent dialogue version; see DIALOGUE-REPLACEMENT.md.
Production listening quality and licence admission remain unqualified.

## Character defaults and owner studio

Choose **Save screenplay and audition voices** to open the three-step studio:
choose a character and line, direct and review its read, then compare saved takes.
Voice, emotion and speed are visible; volume, pronunciations, pauses, acting notes
and character defaults use expandable controls. Notes are retained direction, not
a promise that the provider will follow free-form acting instructions.

`PUT /api/projects/:id/cast/:characterId/audio-voice` saves an authorized catalogue
voice with explicit `expectedVersion`, `voiceId`, `policyRevision`, `controls` and
`pronunciations`. `{expectedVersion, clear:true}` removes the assignment. The API
constructs the voice permission from the current operator policy; owners cannot
submit their own grant. Concurrent changes use the existing cast version lock.
This separate `audioVoice` profile preserves the temporary local `voice` settings,
survives normal cast edits and belongs to cast history and archive validation.
Actor imports require a fresh expressive voice assignment in their destination.

Defaults populate a new line draft. Pauses and notes belong to that audition;
the reviewed request copies all effective settings so subsequent character edits
do not rewrite earlier takes. A/B selectors play owned audio and expose WAV/timing
downloads, original direction and the operator billing state. Reusing A/B settings
creates an unsubmitted draft. **Replace dialogue in a retained cut** lets the
owner apply an eligible saved take to its matching screenplay line and cast
character, review timing, compare versions and choose an export.

Before submission the browser retains the exact request key and body in session
storage. A lost response offers a same-key retry or saved-job lookup; reopening
the studio finds an already-admitted job without generating it again. Background
status refresh preserves playback when only signed URLs change. Explicit refresh
renews expired playback links. Current permission withdrawal hides unavailable
media while retaining its history and unresolved cost information.

Character defaults can be edited with JSON persistence, but actual audition
admission still requires the PostgreSQL audio journal and configured policies.

## Admission and playback

Owners use `GET /api/projects/:id/audio-takes` for current lines, eligible voice
policies and saved jobs. `POST` accepts `idempotencyKey`, explicit
`generationApproved: true`, `sceneIndex`, `lineIndex`, `sourceHash`,
`characterId`, `voiceId`, `policyRevision`, and optional `controls`,
`pronunciations`, `beforeMs`, `afterMs`, `notes`, `alignment`, `operatorGrant`.
Controls are speed, volume and supported emotion; alignment defaults to words
and phonemes. Source indices are zero-based. Dialogue text comes from the saved
screenplay. An existing request key returns its job; a changed request requires
a new key. Current cast permission, script and operator policy are checked during
admission, before HTTP and before attachment. Signed playback also checks current
project, cast and voice permission. A changed script does not erase completed
historical takes; it prevents unfinished old takes from publishing.

The API requires PostgreSQL. Operators supply the same `HV_AUDIO_POLICY_FILE`
to API and workers, and `CARTESIA_API_KEY` only to workers. The file is bounded
to 1 MiB and contains `{schema:"hv-audio-policies/1",policies:[...]}`, with at most
32 canonical policies built by `audioPolicy` in planner/audio-jobs.ts.
Each policy binds the voice, account, catalogue, reviewed licence/price evidence
hashes, validity window, maximum characters and conservative USD reservation.
Hashes identify reviewed evidence; they do not grant consent or prove a licence.
Owner requests cannot introduce a policy. No production policy, key or spending
increase is included. Matching deployment configuration is an operator prerequisite.

## Dispatch, recovery and costs

Migration 0009 adds the stage and a unique audio-attempt-per-job constraint.
Admission reserves capacity and enqueues in one transaction. Before any HTTP,
the journal persists an immutable intent with the exact request hash and original
worker fence. A new worker may recover a saved, checksum-verified audio checkpoint.
If an intent exists without a checkpoint it fails visibly and retains the hold;
it never purchases a second line automatically. The original worker can record a
late outcome after losing its lease or after content is purged.

Every dispatched outcome has unknown actual cost until an explicit operator
invoice allocation. Stream completion is not a zero-dollar bill. Unknown holds
count against capacity and survive cancellation, retention and PostgreSQL
snapshot/archive restoration, including restoration under a lower budget cap.
JSON rollback refuses audio accounting because it cannot preserve this journal.
Other unresolved provider receipts still need reconciliation before migration.

An operator prepares a canonical `hv-audio-invoice-allocation/1` worksheet:
`documentSha256`, `accountRevision`, `totalUsd`, canonical ISO `at`,
`allocations: [{attemptId,usd}]`, and `revision` computed with `contentHash` over
the preceding fields. Every amount has at most six decimal places, entries are
unique, and allocations must conserve the documented total. Retain the original
invoice and full worksheet outside project content. Mixed invoices must include
all costs within the documented audio allocation scope; never label an arbitrary
subset as the full invoice total.

`bun scripts/reconcile-audio.ts worksheet.json --check` validates without writes.
`--apply` requires `HV_PG_ADMIN_URL` and database role `hv_admin`. It atomically
records scoped receipts/costs, consumes or releases holds, and updates job cost.
Concurrent identical submissions are idempotent; conflicting evidence is refused.
Runtime owner/worker code cannot use ordinary cost/attempt completion to settle
audio. Receipts are labelled operator invoice allocations, not vendor per-request
measurements. Each project retains only its own allocation, the document hash and
worksheet revision; other projects' attempts and the full invoice total are absent.

## Verification

`bun test packages/api/test/audio-studio.test.ts packages/generator/test/audio-jobs.test.ts packages/generator/test/cartesia-audio.test.ts packages/storage/test/audio-jobs.test.ts`
checks source/policy binding, exact PCM, immutable publication, concurrent RLS
admission, interrupted workers, uncertain dispatch, original-worker late outcomes,
purge, operator-only settlement, cross-project receipt privacy and retained holds.
The storage tests need the repository's PostgreSQL roles and two private CI
object buckets. Their archive drill restores the journal to an empty database
and copies verified audio into a separate bucket before reading it again.
The HTTP fixture uses a dummy key and a synthetic tone, never a paid voice.
Portable archive validation also tests audio liability preservation and rejects
missing/altered holds. Full suite results are recorded by the PR checks.

Profile tests cover owner isolation, stale versions/catalogues, invalid controls,
ordinary edits, history restoration and actor imports. The PostgreSQL test races
two profile saves, generates with the winning settings, removes the assignment,
then verifies retained playback, archived settings and operator invoice display.
A local browser proxy separately exercised save/reload, two retained A/B tones,
same-key retry after an injected post-save 503, exclusive playback, draft protection
and the 760 px responsive breakpoint. Three submissions produced two synthetic
auditions. This UI proxy uses an in-memory journal and is not production database
or acting-quality evidence; the storage integration test uses real PostgreSQL/S3.

Retained film application preserves the original WAV/report and explicit resampling
provenance, with no new provider call. Original invoice state stays separate from
the zero-cost application job. Production ADR, qualified voice catalogue licences
and actual listening evaluation remain subsequent work.
