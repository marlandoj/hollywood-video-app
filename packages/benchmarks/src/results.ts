import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { RoutingQuality } from "../../generator/src/quality-routing";
import { routingQualityFrom } from "./routing-results";

/**
 * HV-037-03. A paid pass writes one `hv-benchmark-measured/1` record per model; the quality router
 * (HV-019-14) reads one results file, named by `HV_ROUTING_QUALITY_RESULTS_PATH`. This joins the
 * records into that file, ordered by provider spec, and writes it only if the router's own reader
 * (`routingQualityFrom`) accepts the exact bytes -- so a file that would only ever fall back is
 * refused here, with the reader's reason, rather than committed.
 *
 *   bun run benchmark:results --out <results.json> <record.json> [<record.json> ...]
 */
export class ResultsRefusal extends Error {
  override readonly name = "ResultsRefusal";
}

/** The results file's text: the records as a JSON array, ordered by provider spec. */
export function routingResultsText(records: readonly unknown[]): string {
  const spec = (record: unknown) => String((record as { providerSpec?: unknown })?.providerSpec ?? "");
  return JSON.stringify([...records].sort((a, b) => spec(a).localeCompare(spec(b))), null, 2) + "\n";
}

/** Read the records, join them, check the result as the router will read it, and write it. Never writes over a file. */
export function writeRoutingResults(recordPaths: readonly string[], out: string): { out: string; quality: RoutingQuality } {
  if (!recordPaths.length) throw new ResultsRefusal("Name at least one measured record.");
  if (existsSync(out)) throw new ResultsRefusal(`${out} already exists; a results file is never written over.`);
  const records = recordPaths.map(path => {
    try { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
    catch (error) { throw new ResultsRefusal(`${path} could not be read as JSON (${error instanceof Error ? error.message : String(error)}).`); }
  });
  const text = routingResultsText(records);
  let quality: RoutingQuality;
  try { quality = routingQualityFrom(Buffer.from(text)); }
  catch (error) { throw new ResultsRefusal("The quality router would refuse these records: " + (error instanceof Error ? error.message : String(error))); }
  writeFileSync(out, text, { flag: "wx" });
  return { out, quality };
}

if (import.meta.main) {
  const argv = process.argv.slice(2), flag = argv.indexOf("--out");
  try {
    if (flag < 0 || !argv[flag + 1] || argv[flag + 1]!.startsWith("--")) throw new ResultsRefusal("Usage: bun run benchmark:results --out <results.json> <record.json> [<record.json> ...]");
    const paths = argv.filter((_, index) => index !== flag && index !== flag + 1);
    const { out, quality } = writeRoutingResults(paths, argv[flag + 1]!);
    console.log(JSON.stringify({ out, resultsSha256: quality.resultsSha256, metric: quality.metric, measured: quality.measured }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof ResultsRefusal ? 2 : 1);
  }
}
