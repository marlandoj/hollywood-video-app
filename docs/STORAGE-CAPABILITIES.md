# Row-level capability coverage

Every `public.hv_*` table on PostgreSQL carries `ENABLE` and `FORCE ROW LEVEL SECURITY`,
a policy for each role and command the code actually issues, and no privilege for a
command without a policy. Migrations `0001_project_capabilities` and
`0002_runtime_privileges` established that regime for the seven project-scoped tables;
`0015_accounting_capabilities` (increment HV-040-03) extends it to the five accounting and
operations tables and narrows the API's grants to the commands it uses. This document is
the contract; `packages/storage/test/capability-coverage.test.ts` is the guard that keeps
the catalog, `packages/storage/src/schema.ts` and this table from drifting apart.

## Database identities

| Identity | Process | Where it is constructed |
| --- | --- | --- |
| `hv_api` | the API server (`HV_API_DATABASE_URL`): project, review and artifact routes, job admission, diagnostics, the readiness probe | `packages/api/src/server.ts` (`PostgresCostLedger`, `PostgresAudioLedger`, `PostgresLipSyncLedger`, `PostgresProjectService`), `packages/storage/src/diagnostics.ts`, `scripts/storage-readiness.ts` |
| `hv_worker` | worker slots and the retention sweeper (`HV_WORKER_DATABASE_URL`): claim, dispatch, cost recording, release, reconcile, worker heartbeats, operator review queue, purge | `packages/queue/src/worker.ts`, `scripts/sweep-expired.ts` via `packages/storage/src/retention.ts`, `packages/storage/src/workers.ts`, `packages/storage/src/reviews.ts` |
| `hv_admin` | migrations, backups, snapshot import/export, invoice settlement (`HV_PG_ADMIN_URL`) | `scripts/migrate-storage.ts`, `packages/storage/src/backups.ts`, `packages/storage/src/snapshots.ts`, `scripts/reconcile-audio.ts`, `scripts/reconcile-lipsync.ts` |

`hv_api` and `hv_worker` are `NOSUPERUSER NOBYPASSRLS` (`scripts/storage-ci-roles.ts`,
`scripts/prepare-postgres.py`). `hv_admin` is the cluster superuser today and therefore
bypasses row security entirely; `FORCE ROW LEVEL SECURITY` binds table owners, not
superusers. Nothing in this document constrains `hv_admin`; its protection is that only
migrations, backups and operator scripts ever hold that connection.

## Scope contract

`StudioDatabase.forProject(projectId, fn)` (`packages/storage/src/database.ts`) opens a
transaction and runs `select set_config('hv.project_id', $1, true)` before `fn`. The third
argument makes the setting transaction-local: it is visible to every policy evaluated inside
the transaction and is reset at commit or rollback. Callers invoke `forProject` only after a
project, review or artifact capability token has been validated.

Outside a scope, `current_setting('hv.project_id', true)` reads `NULL` on a session that has
never set it and `''` on a pooled session whose earlier transaction did. Both values mean
"no scope": the seven `*_capability` policies compare a `NOT NULL` project id with the
setting, which is false for `NULL` and false for `''`; the `hv_reservations_api_admit`
policy compares the new row's `project_id` the same way, so a `NULL` project id never
matches either; and the two `hv_budget_accounts` write policies spell it out with
`coalesce(current_setting('hv.project_id', true), '') <> ''`. The guard test exercises both
states on a single-connection pool.

## Privilege and policy matrix

Privileges are what `has_table_privilege` reports after migration 0015; each policy is
`PERMISSIVE` and named exactly as in `schema.ts`. `PUBLIC` holds nothing on any table.

| Table | `hv_api` privileges | `hv_api` policies | `hv_worker` |
| --- | --- | --- | --- |
| `hv_projects` | SELECT, INSERT, UPDATE, DELETE | `hv_projects_capability` FOR ALL: `id = current_setting('hv.project_id', true)` | `hv_projects_worker` FOR ALL (true) |
| `hv_reviews` | SELECT, INSERT, UPDATE, DELETE | `hv_reviews_capability` FOR ALL on `project_id` | `hv_reviews_worker` FOR ALL (true) |
| `hv_jobs` | SELECT, INSERT, UPDATE, DELETE | `hv_jobs_capability` FOR ALL on `project_id` | `hv_jobs_worker` FOR ALL (true) |
| `hv_provider_attempts` | SELECT, INSERT, UPDATE, DELETE | `hv_provider_attempts_capability` FOR ALL on `project_id` | `hv_provider_attempts_worker` FOR ALL (true) |
| `hv_outbox` | SELECT, INSERT, UPDATE, DELETE | `hv_outbox_capability` FOR ALL on `project_id` | `hv_outbox_worker` FOR ALL (true) |
| `hv_artifacts` | SELECT, INSERT, UPDATE, DELETE | `hv_artifacts_capability` FOR ALL on `project_id` | `hv_artifacts_worker` FOR ALL (true) |
| `hv_archives` | SELECT, INSERT, UPDATE, DELETE | `hv_archives_capability` FOR ALL on `project_id` | `hv_archives_worker` FOR ALL (true) |
| `hv_budget_accounts` | SELECT, INSERT, UPDATE | `hv_budget_accounts_api_read` FOR SELECT USING `id = 'operator'`; `hv_budget_accounts_api_insert` FOR INSERT WITH CHECK `id = 'operator' AND coalesce(current_setting('hv.project_id', true), '') <> ''`; `hv_budget_accounts_api_update` FOR UPDATE USING `id = 'operator'` WITH CHECK (same predicate as insert) | `hv_budget_accounts_worker` FOR ALL (true) |
| `hv_reservations` | SELECT, INSERT | `hv_reservations_api_read` FOR SELECT USING (true); `hv_reservations_api_admit` FOR INSERT WITH CHECK `project_id = current_setting('hv.project_id', true)` | `hv_reservations_worker` FOR ALL (true) |
| `hv_cost_events` | SELECT | `hv_cost_events_api_read` FOR SELECT USING (true) | `hv_cost_events_worker` FOR ALL (true) |
| `hv_workers` | SELECT | `hv_workers_api_read` FOR SELECT USING (true) | `hv_workers_worker` FOR ALL (true) |
| `hv_operator_reviews` | none | none | `hv_operator_reviews_worker` FOR ALL (true) |

The `hv_budget_accounts` update policy keeps its `USING` clause unconditional on the
singleton so that `select … for update` (which needs the UPDATE privilege and the UPDATE
policy's `USING`) works both inside admission and for a future unscoped reader; the scope
requirement lives only in `WITH CHECK`, which PostgreSQL evaluates for the written row.
`INSERT … ON CONFLICT DO NOTHING` evaluates the INSERT `WITH CHECK` on the proposed row
before the conflict path, so the unscoped upsert is refused even when the row exists.

## Why `hv_api` reads reservations, cost events and workers whole-table

Admission decides against the operator's monthly cap: `reserveWithin`
(`packages/storage/src/ledger.ts`) sums `total_usd` over the last thirty days of
`hv_cost_events` and `remaining_usd` over every open `hv_reservations` row, regardless of
project, because the cap is shared by every anonymous project. Diagnostics
(`packages/storage/src/diagnostics.ts`) reports the same aggregates plus worker heartbeats.
Those rows carry no project content: a reservation is a job id, a stage, two money columns
and its own JSON copy; a cost event is provider, model, token and frame counts and money; a
worker row is an id, its classes and a heartbeat. Per-project cost is delivered through
`hv_jobs.body.costUsd`, which is scoped. Narrowing these reads would break the budget
invariant admission depends on, so they stay `USING (true)` by design.

## Code paths by identity

| Path | Identity | Statements on the accounting tables |
| --- | --- | --- |
| `PostgresCostLedger.admit`, `PostgresAudioLedger.admitAudio`, `PostgresLipSyncLedger.admitLipSync` (`packages/storage/src/ledger.ts`, `audio-ledger.ts`, `lipsync-ledger.ts`) | `hv_api` inside `forProject(projectId)` | `lockWithin`: `insert into hv_budget_accounts … on conflict do nothing`, `select … for update`; `reserveWithin`: `update hv_budget_accounts` (cap lowering only), `select … from hv_reservations`, aggregate reads of `hv_cost_events` and `hv_reservations`, `insert into hv_reservations (…, project_id)` with the scoped project id |
| `StorageDiagnostics` (`packages/storage/src/diagnostics.ts`), `scripts/storage-readiness.ts` | `hv_api`, no scope | SELECT on `hv_budget_accounts` (`id = 'operator'`), `hv_reservations`, `hv_cost_events`, `hv_workers` |
| `PostgresCostLedger.reserve`, `release`, `reconcile`, `beginAttempt`, `attachRequest`, `finishAttempt`, `record`, `assertCanSpend`, `shotCapacity` (`packages/queue/src/worker.ts`) | `hv_worker`, no scope | INSERT (`project_id` NULL), UPDATE, DELETE on `hv_reservations`; INSERT on `hv_cost_events`; SELECT and UPDATE on `hv_budget_accounts` |
| `PostgresWorkerRegistry.heartbeat`, `PostgresReviewQueue.flag/pending/resolve` | `hv_worker` | upsert `hv_workers`; upsert, select, update `hv_operator_reviews` |
| `PostgresRetention` (`packages/storage/src/retention.ts`) | `hv_worker` | `select … for update` on `hv_budget_accounts`; DELETE/UPDATE `hv_reservations`; DELETE `hv_operator_reviews` |
| snapshot import/export, backups, invoice settlement | `hv_admin` | all tables; bypasses row security |

The API's JSON-ledger branches (`ledger.reserve`/`ledger.release` in `packages/api/src`) run
only when `PostgresCostLedger` is not in use; on PostgreSQL the API never updates or deletes
a reservation, which is why those privileges are revoked rather than policed.

## `FORCE` semantics and the superuser caveat

`ENABLE ROW LEVEL SECURITY` applies policies to every role except the table owner and
superusers; `FORCE ROW LEVEL SECURITY` extends them to the owner. Tables are owned by
`hv_admin`, so `FORCE` would matter only if `hv_admin` lost `SUPERUSER`; today it bypasses
every policy. A role with `BYPASSRLS` would as well, which is why the guard asserts
`rolsuper = false` and `rolbypassrls = false` for `hv_api` and `hv_worker`. Policies never
substitute for privileges: a revoked command fails with SQLSTATE `42501` ("permission
denied") before any policy is consulted, and a policed command that fails its `WITH CHECK`
raises the same SQLSTATE ("new row violates row-level security policy"). A `USING` clause
that excludes a row silently filters it; the API therefore sees zero rows, not an error,
when it reads outside its scope.

## The guard test

`packages/storage/test/capability-coverage.test.ts` runs in the CI storage lane against a
real PostgreSQL with the roles from `scripts/storage-ci-roles.ts` (the `pgtest` cases skip
without `HV_PG_ADMIN_URL`, `HV_API_DATABASE_URL` and `HV_WORKER_DATABASE_URL`). The
offline case always runs and checks the `schema.ts` half alone through `getTableConfig`.
The invariant, asserted per `public.hv_*` relation of kind `r`:

- `relrowsecurity` and `relforcerowsecurity` are true;
- for each role in `{hv_api, hv_worker}` and command in `{SELECT, INSERT, UPDATE, DELETE}`
  that `has_table_privilege` grants, a `pg_policies` row names that role with `cmd` equal to
  the command or `ALL`;
- `PUBLIC` holds no privilege;
- the `hv_api` privilege set equals the literal map in the test;
- the policy names in `pg_policies` equal the `pgPolicy` names declared in `schema.ts`, and
  `enableRLS` is true on every exported table;
- both roles are `rolsuper = false`, `rolbypassrls = false`.

The behavioural cases then prove the refusals (`42501`) and admissions listed in the
increment: unscoped and post-scope writes by `hv_api`, cross-project and `NULL` reservation
inserts inside a scope, the revoked update/delete, unscoped reads, unconditional
`hv_worker` access, and a real `PostgresCostLedger.admit` as `hv_api` that stores
`project_id`.

To add a table: declare it in `schema.ts` with `.enableRLS()` and a `pgPolicy` per role
and command (reuse `scopePolicies`, `readPolicy` or `workerPolicy`); write the matching
`ENABLE`/`FORCE`/`CREATE POLICY`/`GRANT` statements in a new migration with the same
policy names; add the table's `hv_api` command list to `API_PRIVILEGES` and its policy
names to `API_POLICIES` in the test. A grant without a policy, a policy without a schema
declaration, or a widened `hv_api` privilege fails the lane.

## Migrations

- `0001_project_capabilities`: `ENABLE ROW LEVEL SECURITY` and the `*_capability` /
  `*_worker` policies on the seven project-scoped tables.
- `0002_runtime_privileges`: schema usage and table grants for `hv_api` and `hv_worker`;
  `FORCE ROW LEVEL SECURITY` on the seven tables.
- `0015_accounting_capabilities`: `hv_reservations.project_id` (nullable, no default, no
  backfill); `REVOKE UPDATE, DELETE ON hv_reservations` and `REVOKE DELETE ON
  hv_budget_accounts` from `hv_api`; `ENABLE` and `FORCE` on the five accounting tables;
  the twelve policies in the matrix above. Additive only; existing reservation rows keep
  `project_id NULL` and are touched only by `hv_worker` and `hv_admin`.

Migrations apply through `scripts/migrate-storage.ts` as `hv_admin` after the API is
stopped and drained (`docs/STORAGE-DEPLOYMENT.md`).

## Evidence

`docs/evidence/hv040-storage/capability-coverage.json` (schema `hv-capability-coverage/1`)
is written only by the guard test's final case when `HV_CAPABILITY_COVERAGE_EVIDENCE` names
that path: the PostgreSQL version actually exercised, the per-table catalog observations,
every refusal with its SQLSTATE, `admissionWritesProjectId` and `newProviderSpendUsd: 0`.
The CI storage lane log is the PostgreSQL 15 evidence; the committed file records the build
host's cluster.
