import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qualityFallback, validateRoutingQuality, ROUTING_QUALITY_MAX_MEASURED, ROUTING_QUALITY_SCHEMA, type RoutingQuality } from "../../generator/src/quality-routing";
import { corpusShots, MEASURED_FIXTURE_VERSION, readMeasuredRecord, type MeasuredRecord } from "./measured";

/**
 * HV-019-14. The one place the `quality` routing strategy reads benchmark scores from.
 *
 * The operator names one committed results file in `HV_ROUTING_QUALITY_RESULTS_PATH` (a relative
 * path is read from the repository root, so `docs/evidence/...` names the committed file). It holds
 * one `hv-benchmark-measured/1` record, or a JSON array of them, one per provider spec. The file is
 * used only if every record passes HV-037-02's `readMeasuredRecord` -- every shot score recomputed
 * from its frame and reference fingerprints, every aggregate recomputed, and stand-in (synthetic)
 * records refused -- and only if the records can be compared with one another: one metric, the
 * frozen corpus this build plans, one frame size and one set of reference images.
 *
 * A file that fails any check is refused as a whole: a stand-in or edited record says the file is
 * not evidence, and the scores beside it are not trusted either. The refusal never throws at
 * admission. It returns a fallback block that names the reason, and the router then keeps the
 * configured order. No score is ever defaulted or invented here.
 */
export const ROUTING_RESULTS_ENV = "HV_ROUTING_QUALITY_RESULTS_PATH";
export const ROUTING_RESULTS_MAX_BYTES = 4 * 1024 * 1024;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let corpus: string | undefined;
/** The sha256 of the frozen 24-shot corpus this build plans; a record measured on another corpus is not comparable. */
function corpusSha256(): string {return corpus ??= corpusShots().fixtureSha256;}

const SPEC = /^[A-Za-z0-9_.:/-]{1,200}$/;

/** Validate a results file's bytes into the block a plan pins. Throws with the reason on any refusal. */
export function routingQualityFrom(bytes: Uint8Array): RoutingQuality {
  if (bytes.length > ROUTING_RESULTS_MAX_BYTES) throw new Error("the results file is larger than " + ROUTING_RESULTS_MAX_BYTES + " bytes");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("the results file is not JSON"); }
  const records = (Array.isArray(parsed) ? parsed : [parsed]) as unknown[];
  if (!records.length || records.length > ROUTING_QUALITY_MAX_MEASURED) throw new Error(`the results file must hold 1 to ${ROUTING_QUALITY_MAX_MEASURED} measured records`);
  const read: MeasuredRecord[] = records.map(record => readMeasuredRecord(record));
  const first = read[0]!, references = (record: MeasuredRecord) => JSON.stringify(record.references.map(({ character, sha256, fingerprint }) => [character, sha256, fingerprint]).sort());
  for (const record of read) {
    if (typeof record.providerSpec !== "string" || !SPEC.test(record.providerSpec)) throw new Error("a record does not name its provider spec");
    if (record.fixtureVersion !== MEASURED_FIXTURE_VERSION || record.fixtureSha256 !== corpusSha256()) throw new Error(`${record.providerSpec} was not measured on the frozen corpus this build plans`);
    if (record.metric.id !== first.metric.id || record.frameSize !== first.frameSize) throw new Error(`${record.providerSpec} was measured with a different metric or frame size, so its score is not comparable`);
    if (references(record) !== references(first)) throw new Error(`${record.providerSpec} was measured against different reference images, so its score is not comparable`);
    if (!/^[0-9a-f]{64}$/.test(record.capabilityRevision ?? "")) throw new Error(`${record.providerSpec} lacks its capability revision`);
  }
  if (new Set(read.map(record => record.providerSpec)).size !== read.length) throw new Error("a provider spec is measured twice");
  return validateRoutingQuality({
    schema: ROUTING_QUALITY_SCHEMA, resultsSha256: createHash("sha256").update(bytes).digest("hex"), metric: first.metric.id, fixtureSha256: first.fixtureSha256, fallback: null,
    measured: read.map(record => ({ spec: record.providerSpec, provider: record.provider, model: record.model, capabilityRevision: record.capabilityRevision,
      score: record.aggregate.identityMean, scoredShots: record.aggregate.scoredShots })),
  });
}

/** The configured results file as a plan's quality block: accepted, or a fallback that says why not. */
export function readRoutingResults(env: Record<string, string | undefined> = process.env): RoutingQuality {
  const configured = env[ROUTING_RESULTS_ENV]?.trim();
  if (!configured) return qualityFallback(`no benchmark results file is configured (${ROUTING_RESULTS_ENV})`);
  let bytes: Buffer;
  try { bytes = readFileSync(isAbsolute(configured) ? configured : resolve(REPOSITORY_ROOT, configured)); }
  catch (error) { return qualityFallback(`the configured results file could not be read (${(error as NodeJS.ErrnoException)?.code ?? "unreadable"})`); }
  try { return routingQualityFrom(bytes); }
  catch (error) { return qualityFallback("the results file was refused: " + (error instanceof Error ? error.message : String(error))); }
}
