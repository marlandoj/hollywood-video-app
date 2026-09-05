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
