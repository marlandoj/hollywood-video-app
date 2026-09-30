# PostgreSQL and S3 retention

The PostgreSQL sweeper runs every minute when `HV_STORAGE=postgres`, using the
worker database identity. It finds expired projects and takedowns, then removes
screenplays, review capabilities, job records, operator reviews, artifact/archive
metadata and content-bearing outbox entries in one transaction. A minimal project
tombstone remains with `purged_at`. Job deletion fences any surviving worker.
Admission, provider dispatch and media publication also check project validity.

**Expiry is not a takedown (HV-031-12, G4 approved 2026-09-30 as G15).** A project
purged because its retention ended is recorded in `expired_at` (migration 0019); its
`taken_down_at` and `takedown_reason` stay empty. Before this, the sweeper stamped
`taken_down_at` with the sweep time and the reason "content removed", because that
column doubled as the "this project is gone" marker, so history said the project was
taken down. Every read that asks whether a project still exists now requires both
columns to be empty, and an expired row reads as no project at all -- nothing writes
to it or deletes it. A takedown is unchanged: its own date and reason are kept.

Whole-state snapshots carry expired projects in `projects.expired`
(`{projectId, at}`), which needs state schema **17**; a state with no expiry record
keeps its old schema and bytes. Billing records that outlive an expired project point
at that record rather than at a takedown. A single-project archive never carries one:
both archive packagers refuse `hv-state/17`. The file store records its sweeps the
same way.

Rows the old sweeper already stamped are **not rewritten**. They are reported,
read-only, by `bun scripts/report-expiry-takedowns.ts` (with `HV_WORKER_DATABASE_URL`
set): its rule is `takedown_reason = 'content removed' and purged_at = taken_down_at
and expired_at is null`, the old sweeper's signature, since a real takedown is
recorded before it is purged. Correcting those rows rewrites the record and is a
separate operator decision.

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

## Incomplete multipart uploads

Artifacts upload as 8 MiB multipart objects. An upload that was initiated but never
completed, for example after a worker crash or lease loss mid-upload, leaves parts that
`ListObjectsV2` never shows and that no `hv_artifacts` or `hv_archives` row references,
so the object orphan pass above cannot reach them. `PostgresRetention.collectIncompleteUploads`
runs on the same hourly cadence as the orphan pass and aborts those uploads with
`AbortMultipartUpload`.

Grace and protections. The default grace is 24 hours, measured from the store's `Initiated`
time against the pass clock; a grace below one hour is refused, and `maxPages` must be an
integer from 1 to 1000 exactly as `collectOrphans` requires. Only the `v1/` and `archives/`
namespaces are listed. An upload is aborted only when its key parses to a project id, that
project row exists in this database (purged tombstones included), and the project has no
`queued` or `running` job; the check runs under the project scope with the same advisory
lock as orphan collection so it serializes with admission. Uploads younger than the grace,
uploads without a parsable `Initiated` time, keys outside the two namespaces or that do not
parse, projects unknown to this database (another environment or another test run's
per-run project) and projects with active work are retained and counted, never aborted.

Bounds, markers and failures. Listing uses `key-marker` / `upload-id-marker` continuation
with at most `maxPages` pages per namespace per pass; the markers of a truncated listing stay
in the process, like the object cursors, so the next pass resumes where the previous one
stopped and a completed listing clears them. A second pass immediately after the first aborts
nothing further. If aborting one upload fails, the pass counts it as `failed`, continues with
the rest, and lists it again once the listing has completed and the markers are cleared (on the
next pass when the listing was not truncated); an upload that no longer exists
(`NoSuchUpload`) is treated as already gone. The pass returns
`{aborted, retained, failed, supported}`.

Unsupported stores. Bun's `S3Client` has no multipart listing or abort call, so
`packages/storage/src/s3-requests.ts` signs `GET /{bucket}?uploads&prefix=…` and
`DELETE /{bucket}/{key}?uploadId=…` with AWS Signature Version 4 using `node:crypto`,
reading endpoint, region, bucket and credentials from the same `HV_S3_*` variables and the
same HTTPS-or-loopback rule as `objectClient()` (a private CA is trusted through
`NODE_EXTRA_CA_CERTS`, as for every other object call). When `ListMultipartUploads` answers
HTTP 501, 405 or an unsupported-operation code, the pass returns
`{aborted: 0, retained: 0, failed: 0, supported: false}` without throwing; other errors
propagate to the sweeper, which logs `retention.incomplete_uploads_failed` and retries a
minute later without stopping project purge, cache cleanup, S3 deletion or object orphan
collection.

Sweeper log fields. The per-minute status line carries `incompleteUploads` with the most
recent hourly result (`null` before the first pass, `{"supported": false}` alongside zero
counts on a store without the API). Evidence for the drill lives in
`docs/evidence/hv040-storage/object-lifecycle.json`, written only by running
`packages/storage/test/incomplete-uploads.test.ts` against a real PostgreSQL and object store
with `HV_OBJECT_LIFECYCLE_EVIDENCE` pointing at that path (and, optionally,
`HV_OBJECT_LIFECYCLE_BUCKET_REPORT` holding the `prepare-object-bucket.py` output line and
`HV_OBJECT_LIFECYCLE_STORE_VERSION` naming the store image). The bucket-level rule that the
object store enforces independently is declared at bucket preparation; see
`docs/STORAGE-DEPLOYMENT.md`.

The PostgreSQL/S3 integration test uses a disposable database and the actual
`hv_worker` role. It covers expired content, takedowns, active-project preservation,
cache erasure, an injected object-store failure, retry, archive deletion,
cross-project preservation, orphan grace periods, referenced objects, and a late
bill after job deletion. It uses fixture media and incurs no provider spend.

The managed JSON/local deployment is not switched by these changes. The PostgreSQL
sweeper will be enabled as part of the verified private staging cutover.
