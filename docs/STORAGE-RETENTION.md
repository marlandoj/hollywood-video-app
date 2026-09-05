# PostgreSQL and S3 retention

The PostgreSQL sweeper runs every minute when `HV_STORAGE=postgres`, using the
worker database identity. It finds expired projects and takedowns, then removes
screenplays, review capabilities, job records, operator reviews, artifact/archive
metadata and content-bearing outbox entries in one transaction. A minimal project
tombstone remains with `purged_at`. Job deletion fences any surviving worker.
Admission, provider dispatch and media publication also check project validity.

Known cost events and the minimal provider receipt fields remain. Unresolved
provider liability stays reserved even after job deletion. Late bills remain
idempotent and can reduce a hold without recreating content. Retention never
restores an earlier balance or manufactures a zero-dollar provider receipt.

The same transaction creates a `storage.project.delete` outbox task. S3 deletion
removes both media and archive prefixes. A failed delete leaves that task pending;
the next pass resumes deletion. The public API denies a deleted project regardless
of storage availability. Each deletion pass limits listing pages and never follows
an object key into another project. Partial S3 progress is safe to retry.

Completed worker runs discard their local job cache after shared checkpoints and
exports have been persisted. The sweeper also clears abandoned process caches for
purged projects under the configured artifact root, including `.workers/<id>`.
Cache cleanup refuses parent links and reports failure separately, so an invalid
local cache does not prevent S3 deletion. Exported offline archives and backup
sets have their own retention policy and are not silently erased by this worker.

An hourly orphan pass checks failed uploads and superseded checkpoint objects.
It waits at least 24 hours, keeps every indexed media/archive reference, and skips
projects with queued or running work. Project locking serializes this check with
new admissions. Bounded scans retain their continuation cursor for the life of
the sweeper process. Unknown project namespaces remain for operator investigation.

The PostgreSQL/S3 integration test uses a disposable database and the actual
`hv_worker` role. It covers expired content, takedowns, active-project preservation,
cache erasure, an injected object-store failure, retry, archive deletion,
cross-project preservation, orphan grace periods, referenced objects, and a late
bill after job deletion. It uses fixture media and incurs no provider spend.

The managed JSON/local deployment is not switched by these changes. The PostgreSQL
sweeper will be enabled as part of the verified private staging cutover.
