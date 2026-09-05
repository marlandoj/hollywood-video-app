# Provider request tracking

Paid image and video adapters await an `onProviderRequest` acknowledgement hook
after queue submission and before polling. PostgreSQL stores the request ID,
model endpoint, validated queue URLs and a cost quotation on the original
`hv_provider_attempts` row. It does not store the prompt, credential or output URL
in this receipt. Receipt URLs must belong to `https://queue.fal.run`, identify
the same request, and contain no credentials, query parameters or fragments.

Each generator attempt receives its own callback closure. A delayed callback
after failover can attach only to the original worker/fence pair. Repeated
identical receipts are harmless; a changed receipt, mismatched worker or request
already assigned to another attempt is rejected. A late acknowledgement remains
useful after lease loss and after project content has been purged. Retention
keeps only the validated request/billing fields needed for reconciliation.

If receipt persistence fails, the worker pauses generation and the adapter
attempts bounded cancellation. It cannot silently dispatch the secondary
provider. Existing costs and unresolved liability remain accounted for.
fal video queue requests also reject cross-origin URLs and redirects and have
bounded request/cancellation timeouts.

The quotation in this receipt is not a provider invoice. fal exposes a separate
per-request Billing Events API with request IDs and cost totals. A read-only probe
against the current Zo `FAL_KEY` returned HTTP 403; only that fal credential
variable was present. The probe queried a nonexistent fixture request and did
not dispatch inference or retrieve unrelated billing records.

Automated billing reconciliation remains a subsequent storage task. It must use
a key authorized for the Billing Events API, preserve holds when a receipt is
missing or access is denied, and avoid booking the same provider request twice.
Never infer zero cost from an empty result, cancellation acceptance, or an HTTP
error. Existing recorded provider costs are based on the configured model rates;
the new billing API has not independently verified those historical totals.

There is still an unavoidable acknowledgement gap if a process dies after fal
accepts a submission but before the response is persisted. Such an attempt must
remain unresolved; the current fal queue assigns its own request ID. Do not
invent a provider idempotency guarantee or release that hold without evidence.

Validation covers trusted receipt fields, saving before image polling, failed
receipt persistence, delayed acknowledgements during failover, immutable binding,
late attachment after lease loss, and receipt preservation through retention.
All tests use fixture responses and incur zero provider spend.

References:
- https://fal.ai/docs/platform-apis/v1/models/billing-events
- https://fal.ai/docs/documentation/model-apis/inference/queue
- https://fal.ai/docs/documentation/model-apis/common-parameters
- https://fal.ai/docs/documentation/development/handle-cancellations
