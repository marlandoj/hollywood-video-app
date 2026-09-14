# Encrypted off-host snapshots

`scripts/offhost-backup.py` copies one complete PostgreSQL/media backup, produced by
`packages/storage/src/backups.ts`, into a single encrypted file that can be held somewhere the
database host cannot reach. This is a snapshot recovery path, not continuous replication or
WAL/PITR. The backup scheduler still writes same-host snapshots only, and `readBackupStatus` in
`packages/observability/src/diagnostics.ts` still reports `localRepositoryOnly: true`. No off-host
destination is configured today: this document describes the tool and the drill that exercises it,
not a copy that exists somewhere. A recovery host that is asleep or disconnected cannot receive a
newer copy.

## Key and storage boundaries

Install the pinned tools with `python3 scripts/install-backup-encryption.py --root ABSOLUTE_DIRECTORY`.
The installer verifies the official age 1.3.2 Windows/Linux amd64 archive's exact size and SHA-256,
extracts only the two named executables, and refuses a changed existing binary. It does not create
keys or start services. `scripts/offhost-backup.py` re-reads `encryption.json` and re-digests the
binary on every use, so a runtime that changed after installation fails closed.

Generate the age identity on the recovery host in a directory restricted to the operator. On
Windows, set and verify the directory ACL before running `age-keygen -o identity.txt`. Derive its
public recipient with `age-keygen -y identity.txt`. Only that public recipient goes to the database
host. Project signing, provider, database and object-store credentials never leave it, and this tool
loads none of them. Protect the recovery identity independently; encrypted copies cannot be read
without it. No identity, recipient, receipt or encrypted copy is ever committed to Git.

Both scripts require Python 3.11 or newer, for `hashlib.file_digest`, and say so rather than raising
`AttributeError`.

## Package and verify a copy

On Linux, `scripts/offhost-backup.py encrypt --repository REPOSITORY --output NEW_FILE.age
--recipient AGE_PUBLIC_RECIPIENT --encryption-runtime PINNED_RUNTIME [--lock-timeout SECONDS]`
verifies the selected snapshot's source, receipt, database dump and complete deduplicated media set
before streaming encryption. It rechecks payload hashes while streaming, so changing a source file
cannot silently produce a valid copy.

Only the files the manifest names travel: `repository.json`, `latest.json`, the snapshot's
`backup.json`, `receipt.json` and `state.dump`, and one blob per distinct content address. The file
list is derived from the manifest rather than from a directory scan, so the writer's and the
scheduler's bookkeeping — `prune-pending.json`, `trash/`, half-written
`blobs/<sha256>.<uuid>.pending` files, `snapshots/<id>.pending` directories and `service-status.json`
— is never read and never copied.

Every object key shape `createStorageBackupUnlocked` can index is accepted:
`v1/<projectId>/<jobId>/<sha256>/<name>`, the reference-asset key
`v1/<projectId>/reference-<uuid>/<sha256>/reference.png` produced by `referenceObjectKey`
(`packages/planner/src/references.ts`), and `archives/<a>/<b>/<sha256>.zip`.

The transport packs at most `MAX_FILES` (100 000) files per copy, deliberately below the writer's
`MAX_OBJECTS` (1 000 000) objects per snapshot: a million records index to far more than the 16 MiB
header bound. A larger repository is refused by a message naming both ceilings rather than failing
obscurely on the header, and must be copied by another means.

`source.database` is accepted only as a plain 63-character PostgreSQL identifier
(`[a-z][a-z0-9_]{0,62}`), narrower than the 256 characters `inspectStorageBackup` allows. That
narrowing is deliberate: a transport source name crosses hosts and lands in shell and SSH context on
the recovery side.

The output receipt is created only after successful encryption and contains the ciphertext
size/hash, manifest and header hashes, snapshot boundary and state summary. A failed run can leave
an incomplete output without a receipt; that file is not a completed backup. Output and receipt
paths must be new, so no older copy is overwritten. The default total payload limit is 4 GiB and can
be explicitly raised up to 72 GiB; header, record-count and path limits remain enforced.

Transfer the encrypted file and its receipt over an authenticated connection. Check the received
ciphertext size and SHA-256 before decryption. On the recovery host, pipe
`age --decrypt --identity identity.txt FILE.age` into `python3 scripts/offhost-backup.py inspect`,
using a binary-safe process pipeline. Check **both** process exit codes, and compare the returned
header/manifest hashes and summary with the source receipt. Successful JSON from the inspector alone
does not establish age authentication. Plaintext need not be written on the recovery host.

The stream is versioned `HV-OFFHOST-BUNDLE/1`: a bounded JSON index followed by exactly the indexed
file bytes. Only the selected repository metadata, database dump and content-addressed blobs are
allowed. Duplicate paths, traversal, excess/truncated data, changed checksums, incomplete media
sets, conflicting source identities and duplicate JSON fields are rejected. Decryption requires the
recovery-host identity; malformed transport metadata never chooses an external destination path.

## Repository locking

The repository lock is the one the application itself uses. `withRepositoryLock`
(`packages/storage/src/backups.ts`) spawns `scripts/backup-lock.py` on `<repository>/repository.lock`
— exclusively for create and prune, shared for verify and restore. `encrypt` takes a **shared**
`flock` on that same inode, opened `O_RDONLY|O_NOFOLLOW`, so it can never run while a snapshot is
being created or a prune is deleting, while several readers may proceed at once. The lock is held
for the whole of header construction and streaming, so a copy can never contain a half-written
snapshot.

`--lock-timeout` bounds the wait: 30 seconds by default, 1 to 3600 seconds accepted. The expected
contender is the scheduler in `scripts/storage-backup-service.ts`, which takes the exclusive lock
every 120 seconds, and the expiry message says so — a timeout below one scheduler cycle will lose
the race on a busy repository. Expiry fails closed; nothing is packaged and no output or receipt is
written. `repository.lock` must already exist; `scripts/backup-lock.py` creates it on the first
scheduler cycle, and a repository without one is refused with that explanation rather than a
confusing file-type error.

## Restore from the off-host bytes

Pipe decrypted bytes from the recovery host to
`python3 scripts/offhost-backup.py inspect --extract NEW_ABSOLUTE_DIRECTORY` on the restore host.
The directory must not already exist. Check both the decryption and the inspection exit codes and
compare the returned hashes with the source receipt before proceeding. An interrupted extraction can
leave an incomplete private directory; do not treat directory existence as completion.

Run `bun scripts/storage-backup.ts --verify --repository RECONSTRUCTED_DIRECTORY` against that tree —
it needs neither PostgreSQL nor an object store — then `--restore` with a separate empty offline
database and private bucket. The restore path verifies uploaded media checksums and database totals.
It executes trusted database DDL, so it remains an operator-only operation; never expose it as a
public upload route. Do not point a deployment at the restore destination until its data, financial
records and capability-authorized playback have been verified.

## What the CI drill does and does not establish

The drill runs on one machine, against a synthetic repository it invents in a temporary directory,
with an age key created and destroyed in the same process, so it measures format and pipeline
correctness plus a packaging lag — it does not establish an off-host RPO, does not establish the
durability of an independent copy, does not establish recovery from the loss of the host, and does
not establish that any live copy exists anywhere.

`scripts/offhost-drill.py` builds a fixture repository containing two object keys that share one
blob, a reference-asset key, an archive key and the bookkeeping decoys listed above; packages it
under a throwaway identity; decrypts it; extracts it; and then checks that the reconstructed
`snapshot_header` equals the source's field for field, that every extracted blob re-digests to its
content address, that no decoy travelled, and that `verifyStorageBackup` accepts the reconstructed
tree. It also records three negatives: a wrong identity, a single flipped ciphertext bit and an
extraction into an existing directory are all refused.

The recorded figure is `rpo.snapshotToCopyMs = copyDurableAt - snapshotAt`, where `copyDurableAt` is
the wall-clock instant at which the encrypted copy **and** its receipt have both been `fsync`ed. On a
real repository `snapshotAt` is the PostgreSQL `transaction_timestamp()` of the exported
repeatable-read snapshot; in the drill it is the stamp the drill itself wrote into its fixture
manifest, which `rpo.measuredOn` states in the record so the number is never read as a measurement
of any database. The figure is therefore a lower bound on the packaging component alone. A complete
off-host RPO would also include the scheduler's 120-second cycle, the transfer, the remote
verification and the remote durability, against a destination that survives the loss of this host.
A CI job is one ephemeral machine, and its "off-host" destination is itself.

`age` is not on the `ubuntu-24.04` runner image, and adding an install step to
`.github/workflows/ci.yml` is a frozen path. `packages/storage/test/offhost-recovery.test.ts`
therefore invokes `scripts/install-backup-encryption.py` itself. If that install fails — no network,
GitHub unavailable, non-amd64 — the encrypt and decrypt legs record `encryption.exercised: false`
with the reason, the package, extract, re-verify and lag legs still run, and the job stays green.

## Current evidence

`docs/evidence/hv038-observability/offhost-drill.json` (schema `hv-offhost-drill/1`) is the unedited
output of one real drill run and is the reproducible figure. It carries `provesOffHostRpo: false`,
`provesHostLossRecovery: false`, `continuousReplication: false`, `restoredIntoLiveDatabase: false`,
`operatorIdentityUsed: false`, `independentDestination: "none (same filesystem, temp directory)"` and
`newProviderSpendUsd: 0`. Reproduce it with
`python3 scripts/offhost-drill.py --output docs/evidence/hv038-observability/offhost-drill.json`;
`recordedAt`, `rpo.copyDurableAt` and the digests change on every run, which is expected.

[`offhost-copy-20260906.json`](evidence/hv038-observability/offhost-copy-20260906.json) is a
2026-09-05 recording from the pre-loop environment, preserved here byte for byte. It records that
one encrypted copy of a 2026-09-06 02:47:11.044 UTC snapshot — 15 projects, 31 jobs, 254 cost
events, $0.144 recorded spend, 672 object keys over 446 distinct media blobs, 451 files and
399,330,276 payload bytes in a 399,506,057-byte encrypted file — was decrypted and checksum-verified
on an operator desktop at 02:50:32.995 UTC without writing plaintext there. Neither that desktop nor
the host it copied from is reachable from this environment, so it is a record of one past run rather
than a re-verifiable claim, and nothing in it is re-checked by any test beyond its own honesty
fields.

No live restore has been run. These facts establish no recovery-time promise, no five-minute
off-host RPO, no host-loss recovery, no automatic collection by any recovery host, and no escrow of
the database host's role, TLS or project-signing configuration. A real independent destination, a
persistent operator identity and a restore against live storage are deferred; see the "Deferred from
HV-040" register in `docs/STORAGE-DEPLOYMENT.md`.
