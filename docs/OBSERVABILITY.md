# Private studio observability

The API creates a new trace for each request. Job admission persists an internal W3C trace parent in the job body; workers continue that trace through provider generation, each attempt, cost recording, media checkpoints, assembly and object publication. The trace carrier never grants project access. Incoming anonymous trace headers and baggage are not propagated.

The implementation uses the OpenTelemetry JavaScript SDK, manual spans and OTLP HTTP/JSON exporters. Each API or worker instance owns its provider and asynchronous context, so concurrent tests and jobs do not depend on global SDK registration. Bun's native HTTP server is instrumented explicitly. See the official [instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/), [context](https://opentelemetry.io/docs/languages/js/context/) and [exporter](https://opentelemetry.io/docs/languages/js/exporters/) documentation.

Telemetry is disabled unless HV_TELEMETRY_ENABLED=1 and a valid HV_OTLP_ENDPOINT is configured. The endpoint must use HTTPS or loopback HTTP, with no credentials, query or fragment in its URL. HV_TRACE_SAMPLE_RATE controls root sampling; HV_RELEASE_SHA supplies the verified release identity. Invalid optional telemetry configuration disables export and emits a fixed configuration error code, while the application remains available.

Only an explicit set of operation names, route templates, stage/provider categories, UUIDs and bounded numeric fields reaches the SDK. Screenplay text, prompts, capability tokens/URLs, request/response bodies, arbitrary headers, filenames and raw error messages/stacks are excluded. Errors use fixed categories. Metric views remove project, job and attempt identifiers and limit each stream to 256 attribute combinations.

Spans use a bounded queue (1024 by default), batches of 16 and a one-second export deadline. Application operations enqueue telemetry without awaiting network delivery. Metrics export periodically. Shutdown flushes within a bounded wait. These signals are diagnostic; PostgreSQL cost events and reservations remain the accounting authority.

Current validation covers asynchronous isolation, propagation into a separate Bun process, real OTLP trace/metric payloads, data filtering, an unresponsive exporter, and the actual API-to-preview-to-approved-final pipeline. The private collector, protected operator diagnostics, operational dashboards and off-host recovery are still being implemented. Telemetry is not enabled in live staging yet.
