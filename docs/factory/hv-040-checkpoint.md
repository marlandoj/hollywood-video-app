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
