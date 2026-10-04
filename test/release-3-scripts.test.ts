import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFountain } from "../packages/parser/src/index";
import { castingSnapshot } from "../packages/planner/src/casting";
import { continuityReport } from "../packages/planner/src/continuity";
import { readThroughFacts, readThroughInput } from "../packages/planner/src/crew/read-through";
import { runShowrunner, showrunnerPrompt } from "../packages/planner/src/crew/showrunner";
import { directionSnapshot } from "../packages/planner/src/direction";
import { featureShots, greedySequences, sceneShotCounts, SEQUENCE_SHOT_LIMIT, splitProblem } from "../packages/planner/src/sequences";
import { checkPrompt, namesPublicFigure } from "../packages/safety/src/index";
import { FEATURE_SHOTS } from "./release-3-contract";

/**
 * HV-030-31: the feature Release 3's rehearsal and run pitch, known good before either.
 *
 * "The Tide Clock" is an original screenplay of 34 scenes, five speaking parts and no real person or
 * brand. It is parsed here with the repository's parser, planned with the feature's own shot plan
 * (`featureShots`, one shot per beat), split by the Showrunner's stand-in, and put through the
 * read-through's facts and the safety gate, which is where a pitch is stopped. So a script the studio
 * would refuse, or one that is not the 200-240 shots the criteria ask for, is found here and not on
 * staging.
 */
const REPO = resolve(import.meta.dir, "..");
const SCRIPT = "docs/evidence/release-3/scripts/feature.fountain";
const text = readFileSync(resolve(REPO, SCRIPT), "utf8");
const parsed = parseFountain(text);
const counts = sceneShotCounts(parsed), shots = featureShots(parsed);

describe("the feature screenplay", () => {
  /** Parsed whole; the only warning is the scene count a feature is expected to pass. */
  test("parses cleanly into 34 scenes and five original speaking parts, with no public figure, and passes the safety gate whole", () => {
    expect(parsed.rejected).toBe(false);
    expect(parsed.unparseable).toEqual([]);
    expect(parsed.warnings.map(warning => warning.code)).toEqual(["SCENE_COUNT"]);
    expect(parsed.scenes).toHaveLength(34);
    expect([...new Set(parsed.scenes.flatMap(scene => scene.dialogue.map(line => line.character)))]).toEqual(["WREN", "OSWIN", "DEV", "MARISOL", "HOLLIS"]);
    expect(namesPublicFigure(text)).toBe(false);
    expect(checkPrompt(text).allowed).toBe(true);
  });

  /** What a render sends: every shot's prompt passes the gate on its own, as admission checks it. */
  test("every one of the feature's shot prompts passes the safety gate and names no public figure", () => {
    for (const shot of shots) {
      expect(checkPrompt(shot.prompt).allowed).toBe(true);
      expect(namesPublicFigure(shot.prompt)).toBe(false);
    }
  });

  /** Criterion 1: about 200-240 shots, read as a feature with no concern, within the feature's 1,200 s. */
  test("is read as a feature of 200-240 shots with no concern, within the feature's limit", () => {
    expect(shots.length).toBe(202);
    expect(shots.length).toBeGreaterThanOrEqual(FEATURE_SHOTS.min);
    expect(shots.length).toBeLessThanOrEqual(FEATURE_SHOTS.max);
    const facts = readThroughFacts(text, parsed, readThroughInput({ format: "feature", tone: "warm and hopeful" }), shots);
    expect(facts).toMatchObject({ format: "feature", formatLimitSec: 1200, scenes: 34, shots: 202, concerns: [] });
    expect(facts.estimatedRuntimeSec).toBeLessThanOrEqual(facts.formatLimitSec);
    // No scene is grouped: each fits one render, so the read-through and the plan agree shot for shot (HV-030-29's gap stays closed here).
    expect(Math.max(...counts)).toBeLessThanOrEqual(SEQUENCE_SHOT_LIMIT);
  });

  /** The Showrunner's stand-in splits it into ten sequences of at most 24 shots, covering every scene; its prompt to a live model passes the gate. */
  test("the Showrunner's stand-in splits it into ten valid sequences, and its prompt to a live model passes the gate", async () => {
    const split = greedySequences(counts);
    expect(split).toHaveLength(10);
    expect(splitProblem(split, counts)).toBeNull();
    for (const sequence of split) expect(sequence.shots).toBeLessThanOrEqual(SEQUENCE_SHOT_LIMIT);
    const result = await runShowrunner({ parsed, counts, scriptVersion: 1, projectId: "release-3", model: null, ledger: { summary: async () => ({ spentUsd: 0 }) } as never });
    expect(result.source).toBe("stand-in");
    expect(result.plan.sequences).toEqual(split);
    expect(checkPrompt(showrunnerPrompt(parsed, counts).user).allowed).toBe(true);
  });

  /**
   * Sequence 5 opens CONTINUOUS from sequence 4's last scene, at the same hour, so the Supervisor has a
   * boundary to compare across, and nothing in the screenplay alone contradicts itself.
   */
  test("one sequence opens CONTINUOUS from the one before, and the Supervisor raises no warning from the screenplay alone", () => {
    const split = greedySequences(counts), opening = parsed.scenes[split[4]!.firstScene - 1]!, closing = parsed.scenes[split[3]!.lastScene - 1]!;
    expect(opening.heading).toBe("INT. RUINED CHAPEL - DAWN - CONTINUOUS");
    expect(closing.heading).toBe("EXT. SANDBANK - DAWN");
    const now = Date.UTC(2026, 9, 4);
    const report = continuityReport(shots, castingSnapshot("release-3", 1, [], now), directionSnapshot("release-3", 1, [], now), parsed);
    // Notes (no hand-off directed yet) are expected before the crew directs; no scene contradicts the one before.
    expect(report.scenes.flatMap(scene => scene.findings.filter(finding => finding.severity !== "note").map(finding => finding.code))).toEqual([]);
    expect(report.totals.warnings).toBe(0);
  });
});
