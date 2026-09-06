# Encrypted off-host snapshots

The transport in PR 19 copies one complete PostgreSQL/media backup to an independently held, encrypted file. This is a snapshot recovery path, not continuous replication or WAL/PITR. The existing backup scheduler still writes on Zo. A desktop that is asleep or disconnected cannot receive a newer copy.

## Key and storage boundaries

Install the pinned tools with `python scripts/install-backup-encryption.py --root ABSOLUTE_DIRECTORY`. The installer verifies the official age 1.3.2 Windows/Linux amd64 archive's exact size and SHA-256, extracts only the two named executables, and refuses a changed existing binary. It does not create keys or start services.

Generate the age identity on the recovery host in a directory restricted to the operator. On Windows, set and verify the directory ACL before running `age-keygen -o identity.txt`. Derive its public recipient with `age-keygen -y identity.txt`. Only that public recipient goes to Zo. Project signing, provider, database, and object-store credentials remain on Zo. Protect the recovery identity independently; encrypted copies cannot be read without it.

The configured desktop copy is under this task's private recovery directory with inherited access limited to the operator and SYSTEM. It is not a public deliverable or a repository file. No identity or encrypted backup is committed to Git.

## Package and verify a copy

On Linux, `scripts/offhost-backup.py encrypt --repository REPOSITORY --output NEW_FILE.age --recipient AGE_PUBLIC_RECIPIENT --encryption-runtime PINNED_RUNTIME` takes the same repository lock used by backup maintenance. Lock acquisition is bounded to 30 seconds. It verifies the selected snapshot's source, receipt, database dump, and complete deduplicated media set before streaming encryption. It rechecks payload hashes while streaming, so changing a source file cannot silently produce a valid copy. It loads no application or storage-role credential.

The output receipt is created only after successful encryption and contains the ciphertext size/hash, manifest and header hashes, snapshot boundary, and state summary. A failed run can leave an incomplete output without a receipt; that file is not a completed backup. Output and receipt paths must be new. No older copy is overwritten. The default total payload limit is 4 GiB and can be explicitly raised up to 72 GiB; header, record-count and path limits remain enforced.

Transfer the encrypted file and its receipt over the authenticated SSH connection. Check the received ciphertext size and SHA-256 before decryption. On the recovery host, pipe `age --decrypt --identity identity.txt FILE.age` into `python scripts/offhost-backup.py inspect`, using a binary-safe process pipeline. Check **both** process exit codes, and compare the returned header/manifest hashes and summary with the source receipt. Successful JSON from the inspector alone does not establish age authentication. Plaintext need not be written on the recovery host.

The stream is versioned `HV-OFFHOST-BUNDLE/1`: a bounded JSON index followed by exactly the indexed file bytes. Only the selected repository metadata, database dump, and content-addressed blobs are allowed. Duplicate paths, traversal, excess/truncated data, changed checksums, incomplete media sets, conflicting source identities and duplicate JSON fields are rejected. Decryption requires the recovery-host identity; malformed transport metadata never chooses an external destination path.

## Restore from the off-host bytes

Pipe decrypted bytes from the recovery host across SSH to `python scripts/offhost-backup.py inspect --extract NEW_ABSOLUTE_DIRECTORY` on the restore host. The directory must not already exist. Check both the decryption and remote inspection exit codes and compare the returned hashes with the desktop receipt before proceeding. An interrupted extraction can leave an incomplete private directory; do not treat directory existence as completion.

Run the application's `scripts/storage-backup.ts --verify` against that reconstructed repository, then its `--restore` with a separate empty offline database and private bucket. The restore path verifies uploaded media checksums and database totals. It executes trusted database DDL, so it remains an operator-only operation. Never expose it as a public upload route. Do not point the live deployment at the restore destination until its data, financial records, and capability-authorized playback are verified.

## Current evidence

The [first desktop copy](evidence/hv038-observability/offhost-copy-20260906.json) contains the 2026-09-06 02:47:11.044 UTC snapshot: 15 projects, 31 jobs, 254 cost events, $0.144 recorded spend, and 672 object keys represented by 446 distinct media blobs. The complete package has 451 files and 399,330,276 payload bytes; its encrypted file is 399,506,057 bytes. Desktop decryption and every payload checksum passed at 02:50:32.995 UTC without writing plaintext to the desktop. Linux CI also verifies native age roundtrip, wrong keys and modified ciphertext.

The live restore is still pending. Zo became unreachable over SSH before its independent restore database or bucket was created. The encrypted desktop copy remains available. These facts do not establish a recovery-time promise, a five-minute off-host RPO, full host-loss recovery, automatic desktop collection, or escrow of Zo's existing role/TLS/project-signing configuration.
