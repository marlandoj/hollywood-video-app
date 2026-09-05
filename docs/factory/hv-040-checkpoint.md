# PostgreSQL foundation checkpoint

The private platform runs PostgreSQL 15.19 at 127.0.0.1:55432 with SCRAM authentication, a separate
OS service account and data checksums. Binaries were extracted from Debian-signed repository
packages into the persistent workspace after a Zo restart interrupted the package installation.
Package hashes are retained at the runtime's postgres-packages.json; no credentials are committed.

Drizzle 0.45.2 / drizzle-kit 0.31.10 define 12 tables for projects, reviews, jobs, budgets, attempts,
workers, outbox, artifacts and archives. Three tracked migrations apply successfully.
Project tables use forced row-level security: API queries receive a transaction-local project
scope only after capability verification; the worker role has the cross-project access required
for scheduling. The API cannot assume the worker role.

Real PostgreSQL tests pass for concurrent scope isolation, pool cleanup, rejected cross-project
writes and transaction rollback. Native Bun SQL queries are lazy: rejection tests must execute
the query inside an async function. Bind JSON objects directly to JSONB; passing JSON.stringify
through native tagged SQL produces a JSON string value.

The app still uses its verified JSON/local storage backend. Remaining work: domain stores and
API/worker wiring, transactional reservations and attempt fencing, object storage, import/export,
private DB transport hardening, restore/backup automation and three-worker evaluation.
The supervisor registration must be restored by deployment bootstrap after a Zo restart before
the database backend is enabled in managed staging.
