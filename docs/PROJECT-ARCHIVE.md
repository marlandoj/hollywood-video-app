# Portable project archive v1

An `hv-project-archive/1` file is a ZIP64 archive containing `archive.json`, five
state files, and media under `artifacts/<project-id>/<job-id>/...`. It contains the
current project's screenplay versions, rights attestation, approvals, review-link
state, drained jobs, known billing events, operator review items, and all media
referenced by the storage index. Clip manifests use `hv-clips/1` logical paths;
they contain no worker-cache dependency. Provider credentials and signing keys
are excluded. Original external sources that were never uploaded to the project
are not materialized by this format.

`archive.json` has `schema`, `projectId`, `totalBytes`, and a sorted `files` array.
Each file record has `path`, `bytes`, and lowercase hexadecimal `sha256`. The
manifest is UTF-8 JSON. `snapshot.json` independently checksums the four JSON
state files under the `hv-state/1` schema. Readers must validate both layers.
Unknown schema versions fail closed. ZIP is a transport container, not an
encryption format: archives include screenplay text and capability records and
must be kept in private storage. Export files and extraction directories are
created with private permissions.

The reader permits at most 100,000 payload files, 8 GiB per media file, 256 MiB
per state file, 64 GiB total payload, and an 8 MiB manifest. It rejects duplicate
entries, encryption, links, special files, traversal, cross-project/job media,
unlisted or missing payloads, checksum mismatches, and compression ratios over
200. Extraction streams into a private temporary directory, verifies checksums,
syncs the files and directories, then publishes the directory. Failed extraction
removes only its own temporary directory. Existing outputs are never reused.

## Export

Load the source instance's private database/S3 configuration into the environment.
Use the `hv_admin` migration identity with its TLS certificate. The selected
project must be active, its jobs drained, and provider charges reconciled.
Other projects may continue rendering.

```sh
bun scripts/storage-archive.ts --export --project PROJECT_ID \
  --work NEW_PREPARATION_DIRECTORY --output NEW_ARCHIVE.hv.zip --publish
```

`--publish` uploads the archive to the configured private S3 bucket, verifies its
SHA-256, and records the object key and manifest hash in `hv_archives`. It does
not publish the archive to the internet. Keep the archive receipt with backups.

## Restore on another instance

Provision an offline, empty PostgreSQL database and a separate empty private S3
bucket, then load that destination's configuration. Migration and import use
the destination's own credentials. Start its runtime only after import succeeds.

```sh
bun scripts/storage-archive.ts --import --source PROJECT.hv.zip \
  --work NEW_EXTRACTION_DIRECTORY --monthly-cap 500
```

Import validates the complete archive and state before inserting records. It
then uploads and checksum-verifies all media. A database import is atomic;
the database-plus-object transfer is an offline operation. If media transfer
fails, keep the destination offline and retry into another empty database and
bucket. The failed destination remains available for diagnosis. No source data
or billing is rolled back. Import does not dispatch a provider or charge money.

State, retention dates and known billing events are preserved. Existing links
remain valid only while unexpired and when the destination uses the same signing
secret. For an instance with its own signing secret, issue a new owner link:

```sh
bun scripts/storage-owner-link.ts --project PROJECT_ID \
  --origin https://studio.example --output NEW_PRIVATE_LINK_FILE
```

The command writes a 72-hour owner capability to a mode-600 file and never prints
the link. It refuses expired or removed projects. The owner can create new review
links using the destination UI. An archive does not reset retention dates or
resurrect a takedown. Deployments needing extended retention must apply their
operator policy before expiration.

## Evidence and limits

`docs/evidence/hv040-storage/project-archive.json` records a 320,983,952-byte Spud
archive restored into `hollywood_video_archive_eval` and `rough-cut-archive-eval`.
All 127 media hashes and the project state match the source. Original capability
access, MP4 range delivery, WebVTT and HLS pass. The restore preserves 24 cost
events totaling $0.072 and incurs $0 in new provider spend.

The service currently runs on one Zo host. This archive drill establishes
logical portability and recovery, not off-host disaster recovery, an RPO, or
multi-region availability. Those require separate backup and infrastructure
evidence. The broader delivery formats and external sources introduced by later
program milestones will extend this versioned schema.
