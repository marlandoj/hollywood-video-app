# Storage backup and recovery

`scripts/storage-backup.ts` creates a private, application-consistent PostgreSQL
and S3 backup while ordinary writes and rendering continue. It uses PostgreSQL's
exported repeatable-read snapshot for both `pg_dump` and the object index. A
dedicated connection retains a shared deletion lock until copying finishes.
Retention still revokes project access and removes database content immediately;
physical object deletion retries on a later sweep. Concurrent backups serialize.

The repository contains a full custom-format database dump per snapshot and a
content-addressed media blob pool shared across snapshots. This is incremental
media storage, not an incremental database dump or continuous WAL/PITR backup.
The repository is bound to its source PostgreSQL cluster and database. Each
manifest records its snapshot time, row counts, recorded spend, object sizes and
SHA-256 checksums. Publication is atomic only after verification and a successful
snapshot transaction. A failed run never advances `latest.json`; incomplete
directories remain available for operator inspection.

## Operator commands

Run from the application checkout with the private environment already loaded:

```sh
bun scripts/storage-backup.ts --create --repository /private/backup-repository
bun scripts/storage-backup.ts --verify --repository /private/backup-repository
bun scripts/storage-backup.ts --restore --repository /private/backup-repository --snapshot SNAPSHOT_ID
```

Creation and restoration use `HV_PG_ADMIN_URL`, `HV_DATABASE_TLS_DIR`, and the
existing `HV_S3_*` configuration. `HV_PG_BIN` and `HV_PG_LIB` optionally select the
PostgreSQL client binaries and shared libraries. Credentials are supplied to
client utilities through a restricted environment, never command-line URLs.
Use a PostgreSQL client compatible with the source and destination servers.
Zo's drill uses PostgreSQL 15 clients and servers; CI also exercises the Ubuntu
24.04 PostgreSQL 16 client against its PostgreSQL 15 service.

Restoration accepts **trusted operator backups only**: PostgreSQL dumps contain
executable schema DDL. Public project imports must use the separately validated
portable project archive format. Checksum files detect damage; they do not
authenticate an attacker-controlled repository. Protect the repository and its
containing directories with operator-only filesystem access.

## Recovery procedure

1. Provision a new offline database with the `hv_admin`, `hv_api`, and `hv_worker`
   roles and required TLS identities. Provision a separate empty private bucket.
   Select those destinations in the recovery environment.
2. Verify the backup. Restore refuses a nonempty database or bucket and verifies
   each copied object before restoring database DDL and rows in one transaction.
   If a transfer fails, keep that destination offline and retry with another
   empty destination. The source remains untouched.
3. Compare counts, checksums, costs and capabilities. Apply any newer application
   migrations only after selecting a compatible release. Run the retention
   sweep before exposing recovered content; a historical snapshot may predate a
   takedown or expiration. Preserve and reapply any newer authoritative deletion
   records when available.
4. Keep paid generation disabled while checking recovered leases, provider
   request receipts and unknown financial holds. Never infer zero cost from an
   absent receipt, and never erase new charges by restoring an older ledger.
   Retain a newer ledger separately if the source survived the incident.
5. Start the private API, verify a capability and media delivery, then enable
   workers only after recovery and accounting checks. Retain the prior storage
   until the cutover and rollback drills pass.

The isolated drill restored seven projects, twelve jobs, 222 cost events and 491
media/archive objects. All twelve application tables were identical. The
original capability returned its project, MP4 ranges, captions and HLS. An
unchanged repeat wrote no new media blobs. A separate integration test delays
`pg_dump` for 22 seconds, changes and purges source content concurrently, then
proves snapshot isolation, deferred deletion, active-job recovery and preserved
unknown provider holds. Corruption, invalid paths and linked blob directories
are rejected. See `docs/evidence/hv040-storage/backup-recovery.json`.

## Remaining reliability work

This checkpoint provides a tested local logical backup and restore, not disaster
recovery across hosts. The live private studio still uses its JSON/local backend.
Scheduled backups, backup expiry/blob pruning, encrypted off-host replication,
continuous recovery monitoring and the full five-minute state RPO remain open.
Near-zero loss for approved media requires an independent durable copy before
claiming that acceptance criterion. Historical backup content also needs a
bounded retention policy; it is not erased by the live-media sweeper.
