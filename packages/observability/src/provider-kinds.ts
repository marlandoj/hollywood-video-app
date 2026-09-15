// The closed provider label set, and nothing else.
//
// This module has no imports on purpose. `packages/generator/src/router.ts` needs
// the set to decide which heartbeat rows it may publish, and importing it from
// `packages/observability/src/index.ts` would pull @opentelemetry/sdk-trace-base,
// sdk-metrics and two OTLP exporters into the generator's module graph — loaded by
// every generator test.
//
// Before HV-019-02 this set was transcribed in six places across five files:
// PROVIDER_KINDS here, the `provider` union in logs.ts, ProviderHealthEntry.provider
// and the runtime KINDS array in diagnostics.ts, and HealthSummaryRow.provider with
// HEALTH_PROVIDERS in generator/src/router.ts. Six copies of one closed set is how a
// widening goes half-applied, and the half that matters fails silently:
// ProviderHealth.summary drops a row whose provider is outside its copy with no
// counter and no log, so the operator's circuit table would simply show fewer rows
// than there are pool slots. Everything now derives from here.

/**
 * The provider categories the operator console, the metric attributes and the
 * structured logs may carry. Bounded on purpose — a label set that grows with the
 * provider list is unbounded cardinality, which ADR-0018 and the metric allow-list
 * both refuse.
 *
 * `rich-animatic` and `rich-animatic-paid` are one adapter on two lanes. Nine of the
 * seventeen registered providers are rich animatics and six of those bill, so without
 * the split the console cannot tell a billing lane from a free one — which is the
 * question an operator watching spend is actually asking.
 *
 * `other` is a tripwire, not a bucket: after the split no registered adapter reaches
 * it, so a row labelled `other` means this build met an adapter it does not enumerate.
 *
 * The size of this set bounds the operator metric queries' row limits; see
 * PROVIDER_LIMIT in explorer.ts. Widening it without widening that limit makes a
 * complete result exceed its `limit`, and `TelemetryExplorer.metrics()` fails closed
 * as a bundle — taking the latency and failure readings down with it.
 */
export const PROVIDER_KINDS = ["mock", "fal", "rich-animatic", "rich-animatic-paid", "anchor-storyboard", "other"] as const;
export type ProviderKind = typeof PROVIDER_KINDS[number];

/**
 * The label for an adapter name.
 *
 * `billed` is the adapter's own price unit, not a guess: pass `true` when the
 * capability snapshot says this lane bills, `false` when it says it does not, and
 * leave it out when there is no snapshot to ask. Omitted means "not known" and
 * yields the unsplit `rich-animatic` label, because an adapter whose price is
 * unknown must not be reported as paid or as free.
 */
export function providerKind(name: string, billed?: boolean): ProviderKind {
  if (name === "mock") return "mock";
  if (name === "fal") return "fal";
  if (name === "anchor-storyboard") return "anchor-storyboard";
  if (name === "rich-animatic") return billed === true ? "rich-animatic-paid" : "rich-animatic";
  return "other";
}
