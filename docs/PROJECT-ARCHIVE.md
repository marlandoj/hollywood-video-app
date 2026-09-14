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
state files under the `hv-state/<n>` schema, n = 1…13, one manifest layout for
every version (the version selects which payload rules `validateSnapshot`
applies). Readers must validate both layers. Unknown schema versions fail
closed. ZIP is a transport container, not an encryption format: archives
include screenplay text and capability records and must be kept in private
storage. Export files and extraction directories are created with private
permissions.

## Schema files

The three manifest contracts are committed as JSON Schema draft 2020-12 files
in `packages/storage/schemas/`. They are in-repo contracts: the `$id` values are
URNs, the only URL in any file is the `$schema` dialect line, and nothing serves
or resolves them (see "Publication status").

| File | `$id` | Document |
| --- | --- | --- |
| `hv-project-archive.1.schema.json` | `urn:hollywood-video:schema:hv-project-archive:1` | `archive.json` |
| `hv-state.1.schema.json` | `urn:hollywood-video:schema:hv-state:1` | `snapshot.json` (`schema` is an enum of `hv-state/1` … `hv-state/13`) |
| `hv-clips.1.schema.json` | `urn:hollywood-video:schema:hv-clips:1` | `clips/manifest.json` in its `hv-clips/1` object form |

The files use only a bounded keyword subset that two dependency-free validators
implement identically: `type` (`object`, `array`, `string`, `integer`, `number`,
`boolean`, `null`), `required`, `properties`, `additionalProperties` (boolean),
`enum`, `const`, `pattern`, `minimum`, `maximum`, `minLength`, `maxLength`,
`items`, `minItems`, `maxItems`, `uniqueItems` and local `$ref` to
`#/$defs/<name>`; `$schema`, `$id`, `$defs`, `title`, `description`, `$comment`
and `examples` are annotations. Any other keyword anywhere in a file makes both
validators throw `unsupported schema keyword` rather than pass, so the files
cannot outgrow the validators. `integer` means a safe integer in TypeScript and
`int` (never `bool` or `float`) in Python; `1.0` in JSON text is therefore an
integer for the TypeScript reader but a float for the Python reader, so the
Python side is the stricter one and producers must emit plain integers. In
TypeScript an own property whose value is `undefined` counts as absent, exactly
as `JSON.stringify` would drop it. Every `pattern` is `^…$`-anchored and
is applied with `RegExp.test` in TypeScript and `re.fullmatch` on the unanchored
body in Python, so both languages reject strings with trailing line terminators.
A failure is reported from both languages as
`archive schema violation: <json-pointer>: <reason>`; every previously existing
hand-rolled check stays in place as a later layer.

Where each contract is enforced:

- TypeScript (`packages/storage/src/archive-schema.ts`, `assertArchiveDocument`):
  `writeStateSnapshot` validates the `snapshot.json` object against `hv-state/1`
  before serializing it and `readStateSnapshot` validates the parsed manifest
  before the version gate and the checksum comparison (`snapshots.ts`);
  `exportProjectArchive` validates the `hv-clips/1` object before writing it
  (`archives.ts`); `PostgresArtifactStore.checkpoint` validates the `hv-clips/1`
  object before uploading it, `importCompletedJob` validates an object-form
  manifest after parsing and before any upload or database write, and
  `restoreCheckpoint` validates the stored manifest after download
  (`artifacts.ts`). The legacy bare-array local form that `restoreCheckpoint`
  writes is still accepted; `importCompletedJob` maps it to the `hv-clips/1`
  object through the shared `clipsManifest` builder, which validates that
  object before the manifest is uploaded, so both forms meet the same contract.
- Python (`scripts/archive-package.py`, `validate_document`, `assert_document`):
  `pack` validates the manifest it built against `hv-project-archive/1` before
  writing any byte of the ZIP, `inspect` validates the parsed `archive.json`
  before any hand-rolled check, `project_scope` validates `snapshot.json`
  against `hv-state/1` (so both `pack` and `unpack` enforce it) and
  `verify_execution_media` validates an object-form clips manifest.

`importProjectArchive` therefore cannot reach `importStateSnapshot` with a
manifest that fails the contract. The state file payloads themselves
(`state/projects.json`, `queue/jobs.json`, the ledger, the reviews) are the
second layer, validated by the planner and `validateSnapshot`.

`archive.json` is serialized canonically: recursively sorted keys, compact
separators, no timestamps, host names or absolute paths, and ASCII by
construction (`path` and `projectId` are pattern-limited to ASCII, the rest are
integers). Python `json.dumps(manifest, sort_keys=True, separators=(",", ":"))`
and TypeScript `canonicalManifestBytes` produce the same bytes, so
`manifestSha256` (stored in `hv_archives.manifest_sha256`) is reproducible from
the manifest alone on any instance. `archiveSha256` is the digest of the whole
ZIP; every entry, including `archive.json`, is written through a fixed-date
`ZipInfo`, so two packs by the same interpreter produce identical bytes, but the
container layout depends on the interpreter's `zipfile` (ZIP64 records, extra
fields) and is not part of the contract.

## Conformance suite

`packages/storage/test/fixtures/archive-golden/` is the committed oracle: one
drained `hv-state/1` project (no review links, no tokens, no secrets,
`deleteAfter` far in the future, one completed `animatic` job with a checkpoint)
under `source/`, with state files written by `writeStateSnapshot`, an
`hv-clips/1` `clips/manifest.json` and small ASCII placeholder media under
`artifacts/<projectId>/<jobId>/`; `archive.json` is the expected manifest and
`receipt.json` records `{projectId, files, bytes, manifestSha256}`.
`rejections.json` is the shared rejection matrix.

The suites prove that `readStateSnapshot(source)` validates and that
`writeStateSnapshot` of the result reproduces the state files byte for byte;
that Python `pack` of `source` produces an `archive.json` entry byte-identical
to the committed file with the committed `manifestSha256`; that `unpack` then
`pack` of the extracted tree produces the identical manifest and, on the same
interpreter, the identical ZIP; that the manifest contains exactly `files`,
`projectId`, `schema` and `totalBytes`; and that `canonicalManifestBytes` of the
committed manifest hashes to the receipt. The rejection matrix mutates the
golden manifests one operation at a time (unknown schema versions, missing or
extra keys, wrong types, out-of-range `bytes` and `totalBytes`, malformed
digests and paths, 100,001 file entries, a fifth or missing state path,
malformed summaries, malformed clip fields) and every row must be refused by
both validators with the same JSON pointer and by the real entry points
(`inspect` through a rewritten ZIP, `readStateSnapshot`, `project_scope`,
`verify_execution_media`, the object branch of `importCompletedJob` through a
stub store) without leaving a `restored.*.pending` directory.

- `packages/storage/test/archive-schema.test.ts` (offline, always runs)
- `packages/storage/test/archive-golden.test.ts` (offline; skips only without a
  system python)
- `SchemaConformanceTests` in `scripts/test_archive_package.py` (the CI
  "portable archive validation" step)

Regenerate the golden only on a real schema bump with
`bun packages/storage/test/fixtures/archive-golden/generate.ts`, then commit
`source/`, `archive.json` and `receipt.json` together. Evidence of a real run is
`docs/evidence/hv040-storage/archive-schema-conformance.json`, written by
`HV_ARCHIVE_SCHEMA_EVIDENCE=docs/evidence/hv040-storage/archive-schema-conformance.json bun test packages/storage/test/archive-golden.test.ts`.

## Publication status

The schemas are in-repo, versioned contracts. No URL resolves them, no HTTP
route serves them, no bucket holds them and no SDK is generated from them.
Internet publication of the archive schema is HV-033 work behind gate G7
(ADR-0020) and is not claimed here.

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

Limits expressed in `hv-project-archive.1.schema.json`: 100,000 file entries
(`files.maxItems`), 8 GiB per file (`bytes.maximum`), 64 GiB total payload
(`totalBytes.maximum`), 1,024-character paths and 128-character project ids.
Container limits enforced by the readers and documented here rather than in the
schema: an 8 MiB manifest, 256 MiB per state file and a compression ratio of
200. `ARCHIVE_LIMITS` in `archive-schema.ts` and `MAX_FILES`, `MAX_FILE_BYTES`,
`MAX_TOTAL_BYTES` in `archive-package.py` are asserted equal to the schema
numbers by the conformance suites.

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
