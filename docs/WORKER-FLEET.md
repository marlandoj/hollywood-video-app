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

## The abandoned-lease terminus

A job whose lease lapses stays `running` with an expired lease, and the next
recovery pass returns it to the queue to resume from its checkpoint. That
recovery is bounded: after `MAX_LEASE_RECOVERIES` (5) lapses **on which the job
made no progress**, it stops at a terminal `failed` state with
`failureKind: "dead_letter"`, a reason naming the count, and no lease, claim or
eligibility. Until HV-032-01 it was unbounded, and that matters because the free
tier allows one running job per project: a job that lost its worker every time
was re-claimed for ever and held a project's only concurrency slot while every
honest job behind it waited.

**A lapsed lease does not prove a worker died.** `leaseExpired` reads a status
and a timestamp, and cannot tell a dead worker from a live one whose heartbeat
was late — a database stall, a blocked event loop or a partition longer than the
lease all look identical. So the counter is lapses *without progress*: each
lapse fingerprints the job's checkpoint state and compares it with the
fingerprint taken at the previous lapse, and any forward progress resets the
streak to one. A long assembly or current-film job that checkpoints forward
across a dozen forced terminations is therefore never dead-lettered, which
matters here because the paragraph above says forced termination relies on lease
expiry. What remains, and is not claimed away: a job that makes no checkpoint
between lapses — a single long provider call, or a short job with no checkpoint
at all by design — can still reach the terminus on a flaky host with no worker
having died.

This budget is deliberately not `retryPolicy.maxRetries`, which counts failures
a worker lived long enough to *report*. A host restart, an OOM kill or a
segfault reports nothing, and a job admitted with `maxRetries: 0` — every audio
take and every retained audition — would otherwise be unable to survive a single
deployment. `resumedCount`, which is served to the project owner, counts only
resumes that happened and is not incremented on the terminal pass; the streak
lives in `lapsesWithoutProgress` beside it.

On PostgreSQL a dead-lettered job is written in the same recovery transaction as
the resumed ones and emits `job.dead_lettered` on the outbox rather than
`job.resumed`. Nothing drains either event yet.

Five is a judgement, not a measurement: this repository holds no operational
evidence about how often a worker dies. It is exported from
`packages/queue/src/index.ts` so a later increment with evidence can move it in
one place.

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

This is a complete isolated fleet flow. The live managed studio now runs three
worker slots under supervisor (`rough-cut-staging-worker`, `-2`, `-3`, launched
by `storage-runtime-launch.py --role worker --slot N` as `zo-staging-worker-N`)
on the PostgreSQL/S3 backend. The fleet criterion of the Wave A exit is measured
on that host by `scripts/storage-wave-a-evidence.ts`, which counts the latest
`hv_workers` incarnation per name with a heartbeat inside 45 seconds in the
`idle`, `busy` or `draining` state and cross-checks the three supervisor
programs; stale heartbeats never count. The observed values are in
`docs/evidence/hv040-storage/wave-a-exit.json` (`workers` and
`waveAExit.fleetAtLeastThree`; see `docs/STORAGE-DEPLOYMENT.md`, "Wave A exit
verification (loop)"). GPU classes, hardware capacity and the full operator
observability console remain separate parts of HV-032 and HV-038.

## Provider circuits in the heartbeat

Each worker writes its own router circuit summary into the `providers` field of the `hv_workers` heartbeat body it already sends every five seconds: one row per configured pool slot per stage, with the circuit state, the consecutive-failure streak, the sample count, the EWMA latency the router ranks on, the last recorded outcome and when that was observed. The row carries the stage, the provider category and the pool spec — operator configuration — and no project, job, attempt or request identifier. Since HV-019-02 the category distinguishes a billing lane from a free one (`rich-animatic-paid` beside `rich-animatic`) and gives `anchor-storyboard` a label of its own, and the category set is a single definition in `packages/observability/src/provider-kinds.ts` that this module derives from. That matters more than it sounds: a row whose category is outside the set is skipped here with no counter and no log, so when the set was transcribed separately in each file a half-applied widening would have shown the operator fewer rows than the pool has slots, silently. A summary whose JSON exceeds 8 KiB is dropped rather than truncated, so a heartbeat never fails because of it; 24 rows at the maximum 80-character pool spec stay well inside that cap, so a worker's own summary does not reach it in practice.

This is a per-process view, not a fleet verdict: it is what that worker's own breaker believes, and two workers can disagree. A stale heartbeat is not evidence that a process is still alive, so the operator console reads only the latest incarnation of each worker name with a heartbeat in the last 45 seconds and ignores `stopped` rows entirely.
