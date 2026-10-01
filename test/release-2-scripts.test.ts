import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importFinalDraft } from "../packages/parser/src/final-draft";
import { parseFountain, type ParseResult } from "../packages/parser/src/index";
import { castingSnapshot } from "../packages/planner/src/casting";
import { continuityReport } from "../packages/planner/src/continuity";
import { continuityRepair } from "../packages/planner/src/continuity-repair";
import { readThroughFacts, readThroughInput } from "../packages/planner/src/crew/read-through";
import { directionSnapshot } from "../packages/planner/src/direction";
import { planShots } from "../packages/planner/src/index";
import { checkPrompt, namesPublicFigure } from "../packages/safety/src/index";

/**
 * HV-030-23: the two screenplays Release 2's run pitches, known good before the run.
 *
 * Film A is a reel in Fountain, pasted at the front door. Film B is a short written in Final Draft:
 * the run reads it with the studio's own importer (the one behind the desk's script import) and
 * pitches the Fountain that gives, and the desk's import step reads the same file back. Both are
 * parsed here with the repository's parser and put through the read-through's own facts, which is
 * where the safety gate stops a pitch, so a script the studio would refuse is found now and not on
 * staging. Film A also carries one deliberate contradiction for the Continuity Supervisor to find.
 */
const REPO = resolve(import.meta.dir, "..");
const SCRIPTS = "docs/evidence/release-2/scripts/";
const filmA = readFileSync(resolve(REPO, SCRIPTS, "film-a.fountain"), "utf8");
const filmB = readFileSync(resolve(REPO, SCRIPTS, "film-b.fdx"), "utf8");
const speakers = (parsed: ParseResult) => [...new Set(parsed.scenes.flatMap(scene => scene.dialogue.map(line => line.character)))];
/** What the read-through says about a script, read as the pitch reads it. */
const facts = (text: string, format: "reel" | "short") => readThroughFacts(text, parseFountain(text), readThroughInput({ format, tone: "warm and hopeful" }));

describe("film A, the reel", () => {
  /** Parsed whole, nothing refused or left over, and the read-through raises no concern at all: no public figure, no policy, not over a reel. */
  test("film A parses cleanly, passes the read-through's safety gate, fits a reel, and has three speaking parts", () => {
    const parsed = parseFountain(filmA);
    expect(parsed.rejected).toBe(false);
    expect(parsed.unparseable).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.scenes).toHaveLength(4);
    expect(speakers(parsed)).toEqual(["NELL", "AUGUST", "PIP"]);
    expect(namesPublicFigure(filmA)).toBe(false);
    expect(checkPrompt(filmA).allowed).toBe(true);
    const read = facts(filmA, "reel");
    expect(read.concerns).toEqual([]);
    expect(read.estimatedRuntimeSec).toBeLessThanOrEqual(read.formatLimitSec);
  });

  /**
   * Scene 2 is headed DAY and CONTINUOUS after a NIGHT scene that NELL is also in. The Supervisor
   * reports it from the screenplay alone, and its repair refuses to pick a side, so the run's
   * continuity step has a real finding to review and nothing to apply.
   */
  test("film A's CONTINUOUS scene contradicts the time of the scene before it, and the Supervisor finds it and refuses to pick", () => {
    const parsed = parseFountain(filmA), shots = planShots(parsed, 7000, 24), now = Date.UTC(2026, 9, 1);
    expect(parsed.scenes[1]!.heading).toBe("INT. LOCK-KEEPER'S HUT - DAY - CONTINUOUS");
    expect(speakers({ ...parsed, scenes: [parsed.scenes[0]!] })).toContain("NELL");
    expect(speakers({ ...parsed, scenes: [parsed.scenes[1]!] })).toContain("NELL");
    const report = continuityReport(shots, castingSnapshot("project-1", 1, [], now), directionSnapshot("project-1", 1, [], now), parsed);
    const found = report.scenes.flatMap(scene => scene.findings.map(finding => ({ scene: scene.sceneNumber, code: finding.code })));
    expect(found).toContainEqual({ scene: 2, code: "time-contradicts-previous" });
    const repair = continuityRepair(report);
    expect(repair.refused).toContain("time-contradicts-previous");
    expect(repair.edits).toEqual([]);
  });
});

describe("film B, the short", () => {
  /** The studio's Final Draft importer takes the file; only the title page is set aside, and the Fountain it gives passes the same gate. */
  test("film B's Final Draft file is accepted by the studio's importer, and the Fountain it gives passes the safety gate and fits a short", () => {
    const imported = importFinalDraft(filmB);
    expect(imported.notes.map(note => note.code)).toEqual(["title-page"]);
    const parsed = parseFountain(imported.text);
    expect(parsed.rejected).toBe(false);
    expect(parsed.unparseable).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.scenes).toHaveLength(6);
    expect(speakers(parsed)).toEqual(["NELL", "MARGIT", "OSCAR"]);
    expect(namesPublicFigure(imported.text)).toBe(false);
    expect(checkPrompt(imported.text).allowed).toBe(true);
    const read = facts(imported.text, "short");
    expect(read.concerns).toEqual([]);
    expect(read.estimatedRuntimeSec).toBeLessThanOrEqual(read.formatLimitSec);
  });

  /** The actor the run shares from film A plays the one part the two films have in common. */
  test("films A and B share exactly one speaking part, NELL, the actor the run shares between them", () => {
    const a = speakers(parseFountain(filmA)), b = speakers(parseFountain(importFinalDraft(filmB).text));
    expect(a.filter(name => b.includes(name))).toEqual(["NELL"]);
  });
});
