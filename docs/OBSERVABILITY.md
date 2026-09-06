# Private studio observability

Implementation status: API and worker instrumentation, operator diagnostics, and managed private collector/trace/metric services were merged in PR 16; PR 18 corrected immutable release permissions. Stored trace and metric exploration is implemented locally, with deployment pending Zo access. Independent recovery verification remains open. This document is not evidence that the full HV-038 or HV-040 epic is finished.

## Traces and metrics

Set `HV_TELEMETRY_ENABLED=1` and `HV_OTLP_ENDPOINT` to a verified HTTPS or loopback HTTP OTLP base URL. Trace sampling defaults to 1; `HV_TRACE_SAMPLE_RATE` can reduce it. `HV_RELEASE_SHA` must be a 40-character hexadecimal commit identifier to appear in the resource. Unset or invalid telemetry configuration leaves rendering functional and disables export.

API actions create new root traces. Anonymous incoming trace headers are ignored. Admitted jobs store a validated W3C carrier, which workers use for job, provider, accounting, checkpoint, assembly, and publication spans. The carrier grants no access. Events, exception bodies, screenplay text, capability URLs, headers, filenames, provider credentials, and raw external errors are excluded. Operational identifiers are allowed in traces; metric labels exclude identifiers and use bounded operation, stage, provider category, outcome, method, route template, and HTTP status class.

Export is asynchronous with bounded queues and deadlines. Failed and timed-out exports increment sanitized process counters. Those counters describe delivery attempts; they do not prove that stored traces, metrics, or other worker processes are queryable. Manual API/worker instrumentation is tested with pinned Bun 1.4.0 on Windows and Linux; this is not a claim of official OpenTelemetry support for every Bun API.

## Operator access

Configure a distinct `HV_OPERATOR_DIAGNOSTICS_SECRET` of at least 32 random characters on the API. The managed role launcher removes it from workers, retention, and backup processes. Do not reuse a project signing secret or capacity-grant secret.

On Zo, run the following with the API's private signing configuration loaded into the process environment:

```sh
bun scripts/operator-diagnostics.ts /private/new-operator-link.json https://modal.taile8ba2a.ts.net
```

The CLI creates a new file with mode 0600, refuses to overwrite an existing path, and prints no credential. The file contains a link to `/api/operator/console` with a 15-minute, read-only token in its fragment. Keep the file on the trusted operator host. The page consumes and removes the fragment, keeps the credential only in memory, and sends it in the Authorization header. It uses no cookies or browser storage. Reopening an operator link initializes a new page session; a plain reload requires the original link again.

`GET /api/operator/status` rejects invalid, missing, future, expired, wrong-purpose, and oversized credentials before it initializes any dependency probes. A diagnostics token cannot access a project or mint capacity. The static console shell contains no operational readings and is public; its data endpoint is protected and non-cacheable. The page uses a restrictive content security policy and a no-referrer policy.

## Meaning of the readings

### Stored telemetry explorer

Expand **Stored traces and metrics** in the operator console. Runtime readings continue to refresh every 15 seconds while visible; stored telemetry loads on expansion, search, or **Refresh readings**, so an inspection does not lose keyboard focus or its span page to background polling.

- `GET /api/operator/traces` searches `rough-cut-worker` / `job.process` over the previous 24 hours, at most 20 results. An optional `jobId` must be a UUID. Entering a 32-character nonzero lowercase trace ID opens `GET /api/operator/traces/:traceId` directly. This direct lookup is useful outside the search window while the trace remains retained.
- Trace detail includes only approved operation/service names, trace/span IDs, same-trace parent references, timestamps, durations, job/stage correlation, and bounded outcome/failure categories. Raw tags, log events, exception messages, arbitrary operation names, process metadata and backend warnings are never returned. A detail view shows at most 500 of the stored approved spans, in pages of 50, and states when it is limited. Partial traces cannot establish a job's current or final state.
- `GET /api/operator/metrics` evaluates one fixed PromQL expression over the previous 30 minutes, at one-minute steps. It returns 5-minute average completed API request and worker job rates per minute, split by success/error. Operator diagnostic routes are excluded from request activity. The four possible series do not include project, job, process, provider request, or URL labels. Missing series/samples remain missing; they are never filled with zero. The chart has an equivalent sample table.
- Query/evaluation timestamps establish when the backend was read, not worker liveness or fresh exporter delivery. The collector expires inactive metric series after two minutes; Prometheus lookback/rate windows can retain historical values longer. Continue to use runtime heartbeat checks for worker health. Sampling, dropped exports and retention can leave incomplete or empty traces.

All three endpoints require the same distinct, short-lived diagnostics token **before** initializing a query client. Project tokens are rejected. Caller-supplied PromQL, hosts, arbitrary filters, ranges and limits are rejected. The only query destinations are the managed loopback Jaeger and Prometheus ports. Redirects and credential forwarding are disabled. `HV_TELEMETRY_ENABLED=1` enables this managed-backend view; remote OTLP export alone does not imply a matching remote query backend.

Each backend allows one pending request, with a two-second response deadline, a 4 MiB decoded body limit and up to eight five-second cached readings. Concurrent identical queries share the pending request; a different query fails promptly while it is busy. Even a transport that ignores cancellation cannot create an accumulating queue. A late aborted reply cannot become a successful cached reading. Failed queries contain no prior value; the UI clearly labels any retained display as stale. Empty available results and an unconfigured backend are distinct states.

The Jaeger search contract follows its [pinned v2.20.0 query parser](https://github.com/jaegertracing/jaeger/blob/v2.20.0/cmd/jaeger/internal/extension/jaegerquery/internal/query_parser.go); metric range parsing follows the [Prometheus HTTP API](https://prometheus.io/docs/prometheus/latest/querying/api/). `scripts/telemetry-explorer-smoke.ts` runs only with explicit disposable Linux CI authorization and exercises the actual checksum-pinned Jaeger 2.20.0, Collector 0.160.0 and Prometheus 3.14.0 binaries. It emits synthetic API/worker operations, checks persisted parent correlation and job search, and requires all four positive rate series. It uses no provider, storage, or deployment credentials and incurs no inference cost.

### Runtime and recovery

- Database observations include counts and financial aggregates only. The API still cannot read unscoped project/job bodies. A separate one-connection, read-only pool with statement and connection timeouts keeps monitoring away from admission connections.
- Worker readiness counts the latest incarnation of each worker name, with a heartbeat in the last 45 seconds. Busy workers count toward the expected fleet; draining or stopped processes do not. JSON fallback cannot independently observe worker liveness.
- Media storage performs an authenticated, one-key S3 list request. This proves connectivity and list permission, not every media checksum.
- Spending uses the same trailing 30-day window as admission. Reservations remain visible. A failed read retains the last verified figures and timestamp while marking current capacity unknown. Recorded prices have not been reconciled with provider invoices.
- Backup freshness uses the actual snapshot time, requires successful completion, and becomes stale after five minutes. A fresh snapshot can coexist with a failed retention cycle; that combination is degraded. The current scheduler writes same-host backups, so freshness does not establish off-host RPO or availability.

Each dependency has at most one pending probe. Concurrent page requests share a collection and short cache; a hung operation has a response deadline without spawning more requests. Failure responses contain fixed operational categories, not source error payloads.

## Verification

Targeted tests cover API-to-worker trace correlation, OTLP trace and metric payloads, exporter outages, capability isolation, stale/failed dependencies, retained cost facts, bounded probe concurrency, backup status validation, and the real API role's PostgreSQL aggregates/RLS boundary. The browser fixture is `scripts/fixtures/operator-console.ts`; all of its figures and credentials are synthetic. Healthy, degraded, and missing-link states have been inspected in the in-app browser.

The first live read-only diagnostics check found a backup retention failure while confirming PostgreSQL/S3 connectivity, three fresh workers, 0 queued/running jobs, $0.144 recorded spend, and $0 reservations. PR 17 repairs that filesystem-dependent pruning failure separately from telemetry rollout.

## Private runtime and restart behavior

The checksum-pinned installer provides Jaeger 2.20.0, OpenTelemetry Collector Contrib 0.160.0, and Prometheus 3.14.0 from their official GitHub release assets. Configuration is copied from an immutable source commit and checked by each binary's own validator. The dedicated `hv-observability` identity runs the three services; their process environments contain only PATH, the observability root, and the Go memory limit. PostgreSQL, S3, signing, and provider credentials are absent.

All nine listeners bind to IPv4 loopback. Application OTLP uses port 15418, Jaeger storage ingestion 15419, Jaeger query 15686/15685, Prometheus query 15909, and local scrape/health endpoints 15464/15888/15889/15333. Collector queues and application exports are bounded. Jaeger retains traces for 48 hours; Prometheus uses two-day and 2 GB retention settings. Heap targets are not hard process or filesystem quotas.

`scripts/observability-canary.ts` emits synthetic telemetry under a separate canary service identity. A live canary's two spans and matching metrics were queried successfully. After restarting Jaeger and Prometheus, both the trace and metrics evaluated at the pre-restart timestamp remained queryable. This verifies service restart persistence, not redundant storage or host-loss recovery.

Zo restarted during installation and discarded the newly created observability directory, while the existing PostgreSQL/S3 deployment and repaired backup scheduler recovered. The pinned installer restored the missing directory. Managed API startup can prepare and restore the optional observability services from the active immutable release in a detached process. Storage readiness and worker progress do not wait for that process. Missing or invalid optional settings disable export; enabling settings takes effect on the next managed process start. A fresh installation cannot reconstruct telemetry data that the host discarded.

Use `scripts/configure-observability.py --runtime RUNTIME --enable` (or `--disable`) to stage the owned settings and separate API diagnostics key, then apply the normal managed release/start workflow. This command does not restart a running job. Startup restoration is separate from ongoing dependency monitoring.
