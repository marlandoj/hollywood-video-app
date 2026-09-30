# Mixed current-film assembly and custody

A mixed (V3) current film combines freshly generated slots with takes it keeps from earlier
completed V2 films. It keeps each of those takes by explicit selection. It was built in PR #83 and
rebuilt on main as HV-016-23 to HV-016-31. HV-016-30 turns it on: the local and PostgreSQL queues
admit and claim V3 jobs, and the worker runs them. HV-016-31 settles how a mixed preview is
approved and what a finished mixed film cannot be used for.

Historical V2 entry points keep their strict version boundary. A separate runtime switch
(`current-film-runtime-context.ts`) dispatches ordinary, V2 and V3 bodies, and refuses mismatched
markers.

## Original identity and target identity

An adopted slot keeps its original render record, execution capture, native speech samples and
selected repair attempt. Its target slot, physical screenplay correspondence and owned paths are
separate metadata. Adoption does not manufacture a new provider attempt, render record or cost
receipt. A generated slot needs a real target-owned record and capture, and its routing decisions
must exist in the held journal.

The target keeps each direct origin's complete file inventory once. That includes unselected media
and the original provenance. Selected role copies have their own target-owned paths. Catalog metadata
alone, or a copy helper's returned receipt alone, does not establish durable custody.

## Assembly and verification

`assembleCurrentFilmMixedAsync` takes the explicit mixed checkpoint, an artifact root, a
current-access callback and the caller's `assembledAt`.

1. It verifies the owned roles and the native line PCM.
2. It measures decoded frames.
3. It assembles with the admitted overlap policy.
4. It returns a V3 clock.

Recorded performance and target intent stay separate in the compact `hv-provenance/3.0` manifest.
Private source catalogs, complete captures and routing journals are left out.

- **Assembly time.** The manifest's time comes from the caller and is checked by
  `provenanceAssembledAt` before any media is read. A placeholder or an impossible date is refused.
- **Credentials.** They come from `provenanceCredentials`.
- **Restore.** `validateCurrentFilmMixedProvenance` rebuilds everything except the time exactly. It
  requires the time to be a real instant. The manifest's bytes are pinned by the artifact index.

`verifyCurrentFilmMixedMedia` checks a prepared prefix or a completed export from target-owned bytes
alone. It covers:

- every complete direct original;
- every generated or adopted role;
- native speech reports;
- the final picture;
- caption digests;
- the decoded output clock;
- the compact provenance.

It needs no old carrier directory and no local clip manifest. HLS playlists must be bounded and name
present, non-empty, owned segments. Exact HLS and segment digests are checked by the held artifact
index at publication and restore.

Completed output binds:

- the complete original inventory;
- the immutable checkpoint;
- the measured assembly;
- the bounded IDs of shots with a continuity outcome.

A review binds that exact output. A V3 final can use an explicitly reviewed V2 or V3 preview of the
same canonical target, with the exact saved decision, cast, direction and lifetime.

## Approving a mixed preview

The owner's decision goes through the same project service call as a V2 preview,
`recordCurrentFilmDecision` (local `ProjectService` and `PostgresProjectStore`).

- `AnimaticApproval.currentFilmReview` is a V2 or V3 review.
  `validateCurrentFilmRuntimePreviewReview` picks the version from the preview's own plan, so a
  V2-shaped review of a mixed preview is refused.
- The review is rebuilt from the completed preview and must match exactly. A review opened on other
  output is refused: "The mixed current-film preview changed after its review was opened."
- The same decision again replays the saved one and appends nothing. A different decision is
  appended, and the latest decision for the preview is the one a final reads.
- A mixed final names the preview and the decision time at admission. The worker (and PostgreSQL
  admission) refuses it unless the latest decision is an exact approval with that time, before any
  proof preparation, original copy or provider dispatch.
- An approved final's prepared proof records the preview and the approval time, and keeps a copy of
  the reviewed preview's media as part of its proof.

There is no HTTP route for current-film decisions, V2 or V3; the caller is the project service.

## What a finished mixed film cannot be used for yet

- **An editorial source.** `editOriginalJob` refuses a mixed film by name:
  - "A mixed film, one that keeps takes from earlier films, cannot be used as an editorial source
    yet."
  - The refusal comes before any V2 check, so every source-inspection and binding path reports it.
  - `provenanceMatches` accepts only `hv-provenance/1.0`, so dialogue and sound reuse cannot pass a
    mixed export either.
  - Editorial support needs a V3 source receipt contract, inspection and save flow, and conform
    integration.
- **A deliverable.** A deliverable is cut from the conform of a picture edit or an assembly, and a
  mixed film cannot become either yet. The delivery route and `deliveryBindingForJob` refuse a mixed
  film by name, before the generic checks and before the kind is read, so HV-027-15's burned-caption
  kinds are refused too: "A mixed film, one that keeps takes from earlier films, cannot be delivered
  from yet." (It used to reach "The film this deliverable is made from is no longer available.")
  Supporting it needs mixed films as editorial sources first.
- **The API job view** never shows a mixed film's plan, checkpoint, originals or proof, as for V2.

## Storage phases

**Before preparation.** Until proof or originals are durably prepared,
`assertCurrentFilmMixedTransaction` requires current source and carrier availability.

**After preparation.** It uses only the authoritative saved target and its complete exact artifact
index to select the owned-custody phase.

- A claimed marker cannot select that phase.
- Missing or inconsistent saved index entries fail without falling back to a carrier.
- Both phases need fresh permissions for the target and the original sources, and a final job needs
  the exact preview decision.

**Publication.** The transaction guard checks metadata and index custody. The artifact adapter
checks the real bytes, then publishes the held job, the artifact index and the outbox event
atomically. `completeCurrentFilmMixedExport` freezes its inputs before awaiting transport. It
commits the delivery rows, the completed domain job and both completion events in one held
transaction, and the worker does not complete a second time.

**Long held transactions.** A held transaction re-verifies media for minutes while it holds the job
row `for update`, which blocks the worker's own heartbeat. So it sends `select 1` every 5 s (Bun
SQL's idle timeout would otherwise close the connection), and every third of a lease it renews the
lease itself. It renews only a row this worker still holds, at the same lease version, whose lease
has not yet run out. A short transaction never renews, so a lease that expires inside one still
refuses its commit. The blocked heartbeat carries the time it was sent, so once the transaction
commits it would write an earlier, possibly already expired, lease; a PostgreSQL heartbeat therefore
never shortens the lease its holder already has, and the transaction's own domain write uses the
lease the row holds after its last `held` check, not the one it began with.

**Retry and reuse.** A job with only origins keeps its original start time across retry and
restore. Selected reuse slots skip provider generation and new cost records, and the provider ledger
refuses attempts for those slots.

**Admission.** New V3 admission:

- resolves the saved historical screenplay and source dependencies, including the target final's own
  approved preview;
- locks the exact selected job bodies and artifact inventories;
- compiles a complete, bounded copy specification before reservation and enqueue.

An exact replay of the request returns its earlier result. This is an index and metadata gate. It
persists no proof marker and does not establish that remote objects exist.

**Proof before originals.** The worker saves a separate `currentFilmProof` checkpoint before it
prepares direct originals or dispatches selected slots. Its specification binds:

- the target job;
- the target approval envelope;
- the frozen historical context;
- the complete owned proof inventory.

Exact preparation retries use the saved proof and owned inventory, and never rediscover an old
carrier. Provider dispatch needs both proof and originals to be prepared.

**Proof verification.** `verifyCurrentFilmProofMedia` checks these owned historical copies
independently. That covers source facts, native line PCM, preview captions, decoded picture and HLS
clocks, the exact playlist segment inventory, and normalized reference images.

**Query results.** Bun returns PostgreSQL results as `SQLResultArray`, an `Array` subclass with
transport fields, and returns bigint byte counts as strings. Every storage reader of mixed and proof
rows normalizes the container with `sqlResultRows` before its own portable checks. In the PR,
`artifacts.ts` proof selection instead required `Array.prototype`, and so refused every real proof
publication. HV-016-30 fixed that. The artifact test's transport double now returns the Bun shape so
the gap cannot reopen.

`currentFilmMixedSourceClock` derives target physical line identities and film-wide timing from
completed V3 evidence. It is private historical metadata and creates no editable receipt.

## Snapshots and archives

**State schema.** Mixed films and their prepared proof use state schema `hv-state/16`. The PR
numbered them 14 and 15, but main had used both numbers for deliverables. Any mixed or proof marker
needs 16, even an orphaned, nested or abandoned one. Older schemas refuse it, in both the TypeScript
validator and the Python packager. A whole-state snapshot that also records an expired project is
`hv-state/17` (HV-031-12), which accepts mixed and proof markers too; a project archive never
carries `/17`, so a mixed project's archive stays at 16. The outer archive format stays
`hv-project-archive/1`.

**What an archive keeps.** A proof's frozen historical jobs are validated as their own scopes and
never become top-level jobs. The packager keeps V3 originals and proof carriers. Only an exact
measured V3 MP4 or proof-preview MP4 may exceed 8 GiB per file. The packager's Bun bridges for
`hv-state/16` (full snapshot validation and the mixed media check) allow 900 s, because a mixed
final's snapshot carries its whole proof; every older bridge keeps 60 s.

## Workspace and access

**Access checks.** Nested media timers share only an access check that is in flight at that moment,
and never keep a completed permission result. Provider dispatch and the final checkpoint and
publication fences read fresh authority directly.

**Copying.** Copying uses private staging and atomic publication, which cannot overwrite an existing
destination. It works in logical blocks of at most 1 MiB, with an access check per block.

**Workspace limits.** The V3 worker watches its whole job workspace through generation and assembly.
The existing 128 GiB and 240,000-file limits and the free-space reserve still apply.

**Cache.** A finishing V3 worker does not evict the shared job directory, because a replacement lease
holder may already be using it. Completed caches stay until project retention cleanup.

## Validation

**PR #83 results.** On its own branch, in September 2026, the PR recorded passing local worker,
artifact, proof and archive lifecycles:

- local worker cases took 330 to 555 seconds each;
- the artifact lifecycle took about 1,600 seconds;
- the proof-only lifecycle took about 620 seconds;
- the archive suite took about 860 seconds.

Its real PostgreSQL and S3 lifecycle never passed CI. That lifecycle is now known to have been
blocked by the proof-row container check described above.

**Rebuilt results (HV-016-30 and HV-016-31).** Measured on a 2-core host, sometimes with two suites
running at once:

- `current-film-v3-worker.test.ts`: 9 cases, 2,291 s;
- `current-film-mixed-artifacts.test.ts`: 24 cases, 2,079 s alone;
- `current-film-mixed-archive.test.ts`: 4 cases, 884 s;
- `current-film-mixed-approval.test.ts`: 4 cases, 2,330 s, of which the approved final took about
  1,800 s;
- the real PostgreSQL and S3 lifecycle (`current-film-mixed-worker.test.ts`), against PostgreSQL 16
  and a moto S3 stand-in: all 9 phases in each of the three latest runs, 5,757 to 5,930 s. In
  2 of 9 runs of its final phase, the final lost its lease and came back `running`. The cause was
  a checkpoint transaction whose domain write still used the lease it began with, despite
  renewing it; HV-016-30's follow-up fixes that (see its increment note).

**Why a mixed final is slow.** Its proof holds the whole mixed preview, and every verification of
the final re-verifies that preview and the preview's own proof. On PostgreSQL a held publication
verifies twice, before upload and inside the transaction. One verification of the final took 3 to 6
minutes here. Caching a verified proof per job, or pinning it by the artifact index once prepared,
would remove most of it.
