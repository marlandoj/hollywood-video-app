/**
 * HV-030-28 — a project's format sets the film limit it is held to (a feature's is $150, G20), so a
 * state snapshot may carry a project's format only if it is one the studio has a limit for. A project
 * never planned has none, and its snapshot is what it was before.
 */
import { expect, test } from "bun:test";
import { readStateSnapshot, validateSnapshot } from "../src/snapshots";
import { GOLDEN_SOURCE } from "./fixtures/archive-golden/matrix";

test("a snapshot carries a reel, a short or a feature, or no format at all; anything else is refused", () => {
  const golden = readStateSnapshot(GOLDEN_SOURCE);
  expect(golden.projects.projects.length).toBeGreaterThan(0);
  expect(golden.projects.projects.every(project => project.format === undefined)).toBe(true);
  expect(validateSnapshot(golden)).toBeTruthy();
  const withFormat = (format: unknown) => {
    const copy = structuredClone(golden);
    (copy.projects.projects[0] as {format?: unknown}).format = format;
    return copy;
  };
  for (const format of ["reel", "short", "feature"] as const) expect(validateSnapshot(withFormat(format)).projects.projects[0]!.format).toBe(format);
  for (const format of ["film", "Feature", "", 1200, null]) expect(() => validateSnapshot(withFormat(format))).toThrow("invalid project format");
});
