import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// HV-030-04: Release 1's exit criteria, read from the run record made on private staging.
// The record is written from the staging database and the studio driver's own reports; this test
// holds it to the criteria, so a partial, unreviewed or over-budget run cannot stand as the release.
const REPO = resolve(import.meta.dir, "..");
const run = JSON.parse(readFileSync(resolve(REPO, "docs/evidence/release-1/release-run.json"), "utf8"));
const films: any[] = run.films;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("one reel and one short went from a pasted script to a shared film through the studio flow", () => {
  expect(run.schema).toBe("hv-release-run/1");
  expect(films.map(film => film.format).sort()).toEqual(["reel", "short"]);
  for (const film of films) {
    expect(existsSync(resolve(REPO, film.script))).toBe(true);
    expect(film.driver).toContain("createStudioFlow");
    // The Director's desk stays behind Advanced: the run never opened it (G13).
    expect(film.directorsDesk).toBe(false);
    expect(film.approvals).toEqual(["cast-and-look", "rough-cut", "final"]);
    expect(film.projectId).toMatch(UUID);
    const shared = film.jobs.find((job: any) => job.id === film.shared);
    expect(shared?.status).toBe("done");
    expect(film.jobs.every((job: any) => job.status === "done")).toBe(true);
  }
});

test("what the crew could not finish is said in the film's own notes, and named as a gap", () => {
  for (const film of films) {
    expect(Array.isArray(film.finishNotes)).toBe(true);
    for (const note of film.finishNotes) {
      expect(typeof note).toBe("string");
      // A finishing note is the crew telling the creator what is missing. The record may not carry
      // one the release has not admitted to: every note matches a gap this run reports.
      expect(run.knownGaps.some((gap: string) => gap.includes(note.split(":")[0]!.trim()))).toBe(true);
    }
  }
});

test("a reviewer on a second device watched each film and decided", () => {
  for (const film of films) {
    expect(film.review.permission).toBe("approve");
    expect(film.review.boundJobId).toBe(film.shared);
    expect(film.review.maxViews).toBeGreaterThan(0);
    expect(film.review.views).toBeGreaterThan(0);
    expect(["approved", "changes_requested"]).toContain(film.review.decision);
    expect(Number.isFinite(Date.parse(film.review.decidedAt))).toBe(true);
  }
});

test("everything the crew cast is original and fictional; no real person was given a voice", () => {
  for (const film of films) {
    expect(film.cast.length).toBeGreaterThan(0);
    for (const member of film.cast) expect(member.kind).toBe("original-fictional");
    expect(film.voicing.replaced).toBeLessThanOrEqual(film.voicing.lines);
  }
  expect(run.safety.tests.length).toBeGreaterThan(0);
  for (const path of run.safety.tests) expect(existsSync(resolve(REPO, path))).toBe(true);
});

test("generation spend stays under the $450 alert, and the crew's spend is its own line", () => {
  const { before, after, alertUsd } = run.costLedger;
  expect(alertUsd).toBe(450);
  expect(after.spentUsd).toBeGreaterThanOrEqual(before.spentUsd);
  expect(after.spentUsd + after.heldUsd).toBeLessThan(alertUsd);
  // Every attempt is counted, including the ones that stopped before a film was made.
  const runSpend = [...films, ...run.stoppedAttempts].reduce((sum, attempt) => sum + attempt.spend.spentUsd, 0);
  expect(Math.abs(after.spentUsd - before.spentUsd - runSpend)).toBeLessThan(0.005);
  expect(runSpend).toBeLessThanOrEqual(run.spendUsdDeclared);
  for (const film of films) expect(film.spend.spentUsd + film.spend.heldUsd).toBeLessThanOrEqual(film.spend.capUsd);
  expect(run.crew.source).toBe("stand-in");
  expect(run.crew.spendUsd).toBe(0);
});
