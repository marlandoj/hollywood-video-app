# Shared render workers

Workers use PostgreSQL for claims, leases and budgets, and S3 for media. Each
process receives its own claim identity and cache directory; a restarted process
cannot inherit another process's in-memory lease fence. `HV_WORKER_ID` is an
operator-readable name (at most 80 letters, digits, underscores, periods, colons
or hyphens); the runtime appends a random process-incarnation identifier.

PostgreSQL workers register in `hv_workers` at startup and refresh their heartbeat
every five seconds. Records distinguish idle, busy, draining and stopped
processes and identify their active job. A stale heartbeat is not evidence that
a process is still alive; job ownership remains governed by the job's fenced
lease. Current process records and job events are operator data. No public
endpoint exposes worker identities or project ids.

`SIGTERM` and `SIGINT` stop new claims and allow the current job to finish. The
worker then records its stopped state and closes database connections. Supervisor
must allow enough time for a running job to drain; deployment should close
admission and wait for an idle queue before stopping workers. A forced process
termination still relies on lease expiry, persisted checkpoints and conservative
provider-cost holds. Graceful shutdown never settles an unknown provider bill.

Lifecycle logs contain event names, process/job/project ids, stages, terminal
statuses and numeric costs. They omit scripts, capability tokens and provider
credentials. Claim and completion outbox events retain the worker identity so
an operator can connect a finished export to its executing process.

## Exercised fleet flow

`bun scripts/storage-fleet-smoke.ts` runs three independent Bun worker processes
against a fresh test database and dedicated private test bucket. A fixture
barrier proves three distinct concurrent claims before rendering starts. The
flow then exercises three animatics, approval-gated final exports, termination
of one worker while busy, successful draining, a replacement worker, an API
restart, and MP4/HLS/caption delivery from an independent cache. A wrong project
capability and an unapproved final are refused. Six completed jobs leave zero
spend and no open reservations. The report is committed under
`docs/evidence/hv040-storage/worker-fleet.json`.

The fixture requires `HV_PG_ADMIN_URL`, `HV_API_DATABASE_URL`,
`HV_WORKER_DATABASE_URL`, existing S3 configuration, and
`HV_S3_FLEET_TEST_BUCKET=rough-cut-fleet-test` (or the `-ci` variant). It refuses a
nonempty bucket and creates/drops a uniquely named test database. Providers are
forced to mock, the fal key is cleared in worker environments, and fixture
artifacts are removed afterward. `HV_FLEET_REPORT` optionally saves the report.

This is a complete isolated fleet flow. The live managed studio still needs the
three-worker service configuration and PostgreSQL/S3 cutover. GPU classes,
hardware capacity and the full operator observability console remain separate
parts of HV-032 and HV-038.
