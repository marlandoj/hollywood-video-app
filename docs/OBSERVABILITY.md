# Private studio observability

Implementation status: API and worker instrumentation, operator diagnostics, and a read-only operator page are implemented on PR 16. The private collector, trace/metric storage, managed recovery, and independent backup destination are still being integrated. This document is not evidence that the full HV-038 or HV-040 epic is finished.

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

- Database observations include counts and financial aggregates only. The API still cannot read unscoped project/job bodies. A separate one-connection, read-only pool with statement and connection timeouts keeps monitoring away from admission connections.
- Worker readiness counts the latest incarnation of each worker name, with a heartbeat in the last 45 seconds. Busy workers count toward the expected fleet; draining or stopped processes do not. JSON fallback cannot independently observe worker liveness.
- Media storage performs an authenticated, one-key S3 list request. This proves connectivity and list permission, not every media checksum.
- Spending uses the same trailing 30-day window as admission. Reservations remain visible. A failed read retains the last verified figures and timestamp while marking current capacity unknown. Recorded prices have not been reconciled with provider invoices.
- Backup freshness uses the actual snapshot time, requires successful completion, and becomes stale after five minutes. A fresh snapshot can coexist with a failed retention cycle; that combination is degraded. The current scheduler writes same-host backups, so freshness does not establish off-host RPO or availability.

Each dependency has at most one pending probe. Concurrent page requests share a collection and short cache; a hung operation has a response deadline without spawning more requests. Failure responses contain fixed operational categories, not source error payloads.

## Verification

Targeted tests cover API-to-worker trace correlation, OTLP trace and metric payloads, exporter outages, capability isolation, stale/failed dependencies, retained cost facts, bounded probe concurrency, backup status validation, and the real API role's PostgreSQL aggregates/RLS boundary. The browser fixture is `scripts/fixtures/operator-console.ts`; all of its figures and credentials are synthetic. Healthy, degraded, and missing-link states have been inspected in the in-app browser.

The first live read-only diagnostics check found a backup retention failure while confirming PostgreSQL/S3 connectivity, three fresh workers, 0 queued/running jobs, $0.144 recorded spend, and $0 reservations. PR 17 repairs that filesystem-dependent pruning failure separately from telemetry rollout.
