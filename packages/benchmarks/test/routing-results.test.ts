import { expect, test } from "bun:test";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readRoutingResults, routingQualityFrom } from "../src/routing-results";
import { IDENTITY_METRIC } from "../src/identity";
import { aggregateOf, corpusShots } from "../src/measured";
import { measuredRecord, resultsFile } from "./measured-records";

const A = { spec: "fal:model-a", provider: "fal", model: "model-a", capabilityRevision: "a".repeat(64) };
const B = { spec: "fal:model-b", provider: "fal", model: "model-b", capabilityRevision: "b".repeat(64) };
const read = (records: unknown) => readRoutingResults({ HV_ROUTING_QUALITY_RESULTS_PATH: resultsFile(records).path });

test("a valid results file is pinned with its digest, metric, corpus and each provider's measured mean", () => {
  const file = resultsFile([measuredRecord(A, 8), measuredRecord(B, 64)]);
  const quality = readRoutingResults({ HV_ROUTING_QUALITY_RESULTS_PATH: file.path });
  expect(quality).toEqual({
    schema: "hv-routing-quality/1", resultsSha256: file.sha256, metric: IDENTITY_METRIC.id, fixtureSha256: corpusShots().fixtureSha256, fallback: null,
    measured: [
      { ...A, score: 1 - 8 / 256, scoredShots: 6 },
      { ...B, score: 1 - 64 / 256, scoredShots: 6 },
    ],
  });
  // A single record is a one-provider file; a relative path is read from the repository root.
  const root = fileURLToPath(new URL("../../../", import.meta.url)), single = resultsFile(measuredRecord(A, 8));
  expect(readRoutingResults({ HV_ROUTING_QUALITY_RESULTS_PATH: relative(root, single.path) })).toMatchObject({ resultsSha256: single.sha256, fallback: null, measured: [{ spec: A.spec }] });
});

test("a pass that scored no shot is carried as measured-with-no-score, never as a number", () => {
  const quality = read([measuredRecord(A, 8, { scored: false })]);
  expect(quality.fallback).toBeNull();
  expect(quality.measured).toEqual([{ ...A, score: null, scoredShots: 0 }]);
});

test("a tampered, stand-in or incomparable results file is refused whole, with the reason, and carries no score", () => {
  const editedShot = measuredRecord(B, 64), firstScored = editedShot.shots.find(shot => shot.identityScore !== null)!;
  firstScored.identityScore = 0.99; firstScored.identity[0]!.score = 0.99;
  const editedAggregate = measuredRecord(B, 64); editedAggregate.aggregate.identityMean = 0.99;
  const recomputedButEdited = measuredRecord(B, 64); recomputedButEdited.shots.forEach(shot => { if (shot.identityScore !== null) { shot.identityScore = 0.99; shot.identity[0]!.score = 0.99; } });
  recomputedButEdited.aggregate = aggregateOf(recomputedButEdited.shots);
  const otherCorpus = measuredRecord(B, 64); otherCorpus.fixtureSha256 = "c".repeat(64);
  const otherReferences = measuredRecord(B, 64); otherReferences.references[0]!.sha256 = "d".repeat(64);
  const cases: [unknown, RegExp][] = [
    [[measuredRecord(A, 8), editedShot], /score does not follow from its fingerprints/],
    [[measuredRecord(A, 8), editedAggregate], /aggregate identityMean does not follow/],
    [[recomputedButEdited], /score does not follow from its fingerprints/],
    [[measuredRecord(A, 8), measuredRecord(B, 64, { synthetic: true })], /synthetic stand-in/],
    [[measuredRecord(A, 8), otherCorpus], /not measured on the frozen corpus/],
    [[measuredRecord(A, 8), otherReferences], /different reference images/],
    [[measuredRecord(A, 8), measuredRecord(A, 9)], /measured twice/],
    [[{ ...measuredRecord(A, 8), schema: "hv-benchmark-measured/0" }], /schema is not/],
    [[], /1 to 16 measured records/],
    [Array.from({ length: 17 }, (_, index) => measuredRecord({ ...A, spec: "fal:m" + index }, 8)), /1 to 16 measured records/],
  ];
  for (const [records, reason] of cases) {
    const quality = read(records);
    expect(quality.fallback).toMatch(reason);
    expect(quality.fallback).toStartWith("the results file was refused: ");
    expect(quality).toMatchObject({ resultsSha256: null, metric: null, fixtureSha256: null, measured: [] });
  }
  expect(() => routingQualityFrom(Buffer.from("{not json"))).toThrow("not JSON");
  expect(readRoutingResults({}).fallback).toBe("no benchmark results file is configured (HV_ROUTING_QUALITY_RESULTS_PATH)");
  expect(readRoutingResults({ HV_ROUTING_QUALITY_RESULTS_PATH: "  " }).fallback).toMatch(/no benchmark results file is configured/);
  expect(readRoutingResults({ HV_ROUTING_QUALITY_RESULTS_PATH: "/nonexistent/hv-routing-results.json" }).fallback).toBe("the configured results file could not be read (ENOENT)");
});
