# PostgreSQL integration checkpoint

The private platform runs PostgreSQL 15.19 at 127.0.0.1:55432 with SCRAM authentication, a separate
OS service account and data checksums. Binaries were extracted from Debian repository packages
into persistent workspace after a Zo restart interrupted the package installation.
Package hashes are retained at the runtime's postgres-packages.json; credentials stay on Zo.

Drizzle 0.45.2 / drizzle-kit 0.31.10 define 12 tables. Four tracked migrations cover tables,
forced project RLS, role grants and a counts-only queue health function. API transactions receive
project scope after capability validation; pooled scope does not leak. The API cannot assume the worker role.

The PostgreSQL adapters now cover projects, versioned screenplays, review links and decisions,
queue transitions, fenced worker leases, operator review items, reservations and cost events.
Admission checks the locked project version, reserves capacity and inserts an idempotent job in
one transaction. Six separate worker processes contend safely for jobs: three distinct projects
are claimed, with the free tier's one-running-job limit enforced. Reclaimed jobs retain checkpoints,
and an old instance cannot update a job even if its replacement has the same worker name.

Provider dispatch checks the current fence and reserves the attempt's estimate. Unknown charges
retain a hold; stable event keys prevent duplicate costs. Accounting errors drain known costs and
stop failover. Late charges update billing without replacing the current worker's progress.
Worker lease loss propagates cancellation to the provider. Export assembly runs asynchronously
so the lease timer remains active through FFmpeg and streamed checksumming.

A real PostgreSQL API/worker integration test completes create, save, rights, preview, API restart,
approval, final export and caption download. Project capabilities survive restart; another project
cannot read the job; takedown blocks artifact access. Explicit HV_STORAGE=postgres selects the
backend. Managed staging still uses the verified JSON/local release pending migration and rollback evidence.

Remaining before the storage milestone is complete: S3 media and cross-worker resume, validated
portable archives, JSON migration and reverse export preserving all bills, private database transport,
persistent service bootstrap, backup/restore evidence and three workers rendering complete jobs.
Supervisor registration must be restored after a Zo restart before the database backend is deployed.

## Shared media and transport verification

RustFS 1.0.0-rc.5 runs as a separate non-login service user at https://127.0.0.1:59000.
The release archive SHA256 is 8ca1f87fbef513c9c664d034622541fe9ec7e97cb999997d64c09b337b5e6e9c.
This is a private evaluation service on the existing Zo filesystem; production redundancy is not
claimed. The S3 bucket blocks public ACLs and policies. A 10 MiB multipart object was uploaded,
downloaded and checksum-verified; anonymous access returned 403.

Artifacts use content-addressed physical object keys and logical project/job paths in PostgreSQL.
Clip files, portable clip manifests and checkpoint progress commit together under a lease fence.
The recovery test deletes the original worker cache, expires its lease and resumes in a new cache.
Only the remaining shot is generated. Artifact delivery stays behind the existing capability proxy;
range requests, VTT, HLS and takedown denial pass without exposing an object URL.

All 232 tests passed with PostgreSQL and S3 enabled (1161 assertions). The 12 storage tests then
passed again through verified database mTLS (119 assertions). PostgreSQL requires both SCRAM
credentials and a certificate whose common name matches the role. Cleartext, absent-certificate
and wrong-role-certificate probes all failed as required.

A Zo reset exposed a roughly 150-second PostgreSQL crash-recovery file sync. Startup now permits
a bounded recovery window and resumes stopped services. Signing keys and credentials remain on Zo.
A local Windows recovery copy of generated source changes protects development work from host resets.
The application deployment remains the verified JSON/local release until migration, rollback and
backup/restore evidence are complete.

Current remaining storage work: migration and reverse export, portable project archives, retention
and orphan-object cleanup, durable provider receipt reconciliation, persistent bootstrap plus
backup/restore, and three worker processes completing full jobs. CI now includes the private S3
integration test alongside PostgreSQL; its current run must pass before merging.

References:
- https://bun.com/docs/runtime/s3
- https://docs.rustfs.com/en/installation/linux/single-node-single-disk
- https://docs.rustfs.com/en/integration/tls-configured
- https://www.postgresql.org/docs/15/ssl-tcp.html

## Migration and portable archive checkpoint

JSON-to-PostgreSQL migration and reverse export preserve seven projects, two
review links, twelve completed jobs and 222 cost events totaling $0.144. Media
migration restores 478 byte-identical media files and twelve equivalent portable
clip manifests. The original Spud capability works against the migrated instance.

The v1 project archive packages one project's state and indexed media with two
checksum layers and bounded streaming extraction. Twelve hostile-input and
round-trip tests pass. The PostgreSQL/S3 regressions pass with scoped snapshot
export even while another project has an active job. A real Spud archive restored
to an isolated database and bucket preserves all 127 media hashes, state, and
$0.072 of known billing. MP4 ranges, WebVTT, HLS and original capability checks pass.
No new provider spend was incurred. See PROJECT-ARCHIVE.md and the committed
state-migration, media-migration and project-archive evidence files.

Remaining Wave A work: retention and orphan-object cleanup, provider receipt
reconciliation, persistent bootstrap, backup/restore with an evidenced RPO,
observability, three workers rendering full jobs, and the private staging cutover.
The managed application still runs its verified JSON/local release.

## Retention checkpoint

PostgreSQL retention now erases project content and authorizations, fences deleted
jobs, and records a retryable S3 deletion task. Known billing receipts and unknown
provider holds survive cleanup; a late bill can still settle after the job is gone.
Expired projects cannot dispatch providers or publish new media. Worker caches
clear after each shared-storage job, with abandoned caches covered by the sweeper.
Orphan collection preserves indexed objects, active projects and fresh uploads.

The storage integration suite passes with real PostgreSQL and S3. An injected S3
failure leaves deletion pending, and retry removes both artifacts and archives.
The drill also verifies cross-project preservation and cache cleanup. See
STORAGE-RETENTION.md. Source and recovery scripts were recovered after another Zo
reset; deployed JSON/local staging remained healthy at $0.144 total provider spend.

Remaining Wave A work: durable provider request reconciliation, persistent service
bootstrap and tested backups, observability, three workers completing full jobs,
then the PostgreSQL/S3 private staging cutover and rollback drill.

## Provider request acknowledgement checkpoint

Image/video submission receipts now persist before polling, bound to their
original provider attempt and lease fence. Callbacks remain bound correctly even
when an earlier provider acknowledges after failover. Receipt failures stop
secondary dispatch, and retention preserves the minimal reconciliation fields.
Thirty-nine targeted provider/storage tests pass (232 assertions), with no new
inference spend. See PROVIDER-RECEIPTS.md.

The existing fal key receives HTTP 403 from the per-request Billing Events API.
An authorized billing key is an external dependency for live reconciliation;
fixture-backed reconciliation and the other Wave A work can proceed. Historical
recorded costs have not been independently verified with that API.

CI for the retention checkpoint passed 234 tests but exposed a pre-existing
four-process queue test scheduling assumption: one process could drain the queue
before peers started. The fixture now synchronizes startup and first claims.
Its 27 queue tests pass. A new full CI run is required before this PR can merge.

## Backup recovery checkpoint

Added an operator-only PostgreSQL/S3 backup repository with a full database dump
per snapshot and deduplicated media blobs. The snapshot and deletion lock survive
long copies; cleanup retries without blocking while backup holds the lock. Every
payload is bounded and checksummed, publication is atomic, and recovery requires
an empty offline database and separate private bucket.

The isolated recovery drill restored all twelve tables identically: seven
projects, twelve jobs, 222 cost records, $0.144 recorded spend and 491 objects.
The original private project capability and MP4/VTT/HLS delivery passed. A repeat
backup reused all existing blobs. The slow-concurrency, corruption and retention
tests pass: three tests, 57 assertions, including unknown financial holds.
See STORAGE-BACKUPS.md and evidence/hv040-storage/backup-recovery.json.

The preceding provider-request commit passed both CI quality and benchmark gates.
This backup checkpoint needs its own CI run. Remaining Wave A work includes
scheduled and off-host recovery, persistent service bootstrap, observability,
three full render workers, then private PostgreSQL/S3 cutover and rollback.
The fal Billing Events API still requires a key with billing access. This is
not a claim that the five-minute RPO or full project launch requirements are met.
