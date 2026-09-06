# Durable line auditions

An `audio-take` job generates one current screenplay line for one saved character.
It retains the effective voice, pronunciation, speed, volume, emotion, notes,
pauses and word/phoneme timing. Audio remains mono 48 kHz signed 16-bit PCM with
an owned WAV and performance JSON; it is not inserted into a film or legacy ADR.
Production listening quality and licence admission remain unqualified.

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

`bun test packages/generator/test/audio-jobs.test.ts packages/generator/test/cartesia-audio.test.ts packages/storage/test/audio-jobs.test.ts`
checks source/policy binding, exact PCM, immutable publication, concurrent RLS
admission, interrupted workers, uncertain dispatch, original-worker late outcomes,
purge, operator-only settlement, cross-project receipt privacy and retained holds.
The storage tests need the repository's PostgreSQL roles and two private CI
object buckets. Their archive drill restores the journal to an empty database
and copies verified audio into a separate bucket before reading it again.
The HTTP fixture uses a dummy key and a synthetic tone, never a paid voice.
Portable archive validation also tests audio liability preservation and rejects
missing/altered holds. Full suite results are recorded by the PR checks.

Persistent production voice profiles, comparison/selection UI, film resampling
provenance, paid ADR and actual listening evaluation remain subsequent work.
