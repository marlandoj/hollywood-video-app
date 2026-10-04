/**
 * HV-037-03. The paid benchmark pass's evidence, once the operator's run is copied into
 * `docs/evidence/release-3/benchmark/` (the runbook in docs/loop/increments/HV-037-03.md).
 *
 * Until those files exist these tests are skipped: nothing here is evidence, and nothing is
 * invented in its place. The follow-up evidence commit adds the files and runs this file; it is
 * committed only once this passes (CLAUDE.md).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMeasuredRecord, type MeasuredRecord } from "../src/measured";
import { declaredSpendOf, PAID_SUMMARY_SCHEMA } from "../src/paid";
import { CORPUS_REFERENCES_DIR, type ReferencesManifest } from "../src/references";
import { readRoutingResults } from "../src/routing-results";
import { routingResultsText } from "../src/results";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const RELEASE_3_BENCHMARK_DIR = "docs/evidence/release-3/benchmark";
const RESULTS = join(RELEASE_3_BENCHMARK_DIR, "routing-results.json");
const SPECS = ["fal:kling-o3-standard-reference", "fal:kling-v2.5-turbo-pro"] as const;
const present = existsSync(join(REPO_ROOT, RESULTS)), evidence = present ? test : test.skip;
const read = (name: string) => JSON.parse(readFileSync(join(REPO_ROOT, RELEASE_3_BENCHMARK_DIR, name), "utf8")) as unknown;
const recordOf = (spec: string) => read(spec.slice(4) + ".json") as MeasuredRecord;

describe("the release 3 paid benchmark evidence", () => {
  evidence("the results file is what the quality router reads, built from exactly the two committed records", () => {
    const quality = readRoutingResults({ HV_ROUTING_QUALITY_RESULTS_PATH: RESULTS });
    expect(quality.fallback).toBeNull();
    expect(quality.measured.map(entry => entry.spec)).toEqual([...SPECS]);
    expect(readFileSync(join(REPO_ROOT, RESULTS), "utf8")).toBe(routingResultsText(SPECS.map(recordOf)));
  });

  evidence("each record is a vendor pass under HV-037-03, on the committed references", () => {
    const manifest = JSON.parse(readFileSync(join(CORPUS_REFERENCES_DIR, "references.json"), "utf8")) as ReferencesManifest;
    for (const spec of SPECS) {
      const record = readMeasuredRecord(recordOf(spec));
      expect(record).toMatchObject({ providerSpec: spec, provider: "fal", synthetic: false, increment: "HV-037-03" });
      expect(record.references.map(reference => [reference.character, reference.sha256]))
        .toEqual(manifest.references.map(reference => [reference.character, reference.sha256]));
    }
  });

  evidence("each pass's spend was recorded in the PostgreSQL ledger, and together they stay inside the declaration", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs/loop/increments/HV-037-03.md"), "utf8");
    let total = 0;
    for (const spec of SPECS) {
      const record = recordOf(spec), summary = read(spec.slice(4) + ".summary.json") as Record<string, unknown>;
      expect(summary).toMatchObject({ schema: PAID_SUMMARY_SCHEMA, ledger: "postgres", providerSpec: spec, increment: "HV-037-03", declaredUsd: record.declaredUsd, aggregate: record.aggregate });
      expect(String(summary.jobId)).toStartWith(`benchmark:HV-037-03:${spec}:`);
      expect(summary.recordedUsd).toBeCloseTo(record.aggregate.totalCostUsd, 6);
      total += record.aggregate.totalCostUsd;
    }
    expect(total).toBeLessThanOrEqual(declaredSpendOf(doc)!);
  });
});
