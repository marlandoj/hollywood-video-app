import { describe, expect, test } from "bun:test";
import { parseFountain } from "../../parser/src/index";
import { attestRights, generateBible, planShots } from "../src/index";

const SCRIPT = `INT. KITCHEN - DAY\n\nA kettle whistles.\n\nMARLA\nTea time.\n\nEXT. GARDEN - DUSK\n\nWind moves the hedge.\n`;

describe("shot planner", () => {
  test("plans deterministic shots in script order", () => {
    const shots = planShots(parseFountain(SCRIPT), 100);
    expect(shots.length).toBe(2);
    expect(shots[0].id).toBe("shot-1-1");
    expect(shots[0].seed).toBe(100);
    expect(shots[1].seed).toBe(101);
    expect(shots[0].dialogue[0].character).toBe("MARLA");
  });

  test("condenses an over-budget script to the shot cap while covering every scene", () => {
    const beatCounts = [7, 12, 8, 6, 12, 6, 7, 5, 9, 2, 8, 5, 8, 18, 6, 16];
    const script = beatCounts.map((count, si) =>
      `INT. ROOM ${si + 1} - DAY\n\n${Array.from({ length: count }, (_, bi) => `Beat ${si + 1}-${bi + 1} happens.`).join("\n\n")}\n\nNARRATOR\nScene ${si + 1}.\n`,
    ).join("\n");
    const parsed = parseFountain(script);
    expect(planShots(parsed, 1).length).toBe(135);

    const shots = planShots(parsed, 7000, 24);
    expect(shots.length).toBe(24);
    expect(new Set(shots.map((s) => s.sceneIndex)).size).toBe(16);
    expect(shots.map((s, i) => s.seed === 7000 + i).every(Boolean)).toBe(true);
    expect(shots.filter((s) => s.dialogue.length > 0).length).toBe(16);
    const beatsCovered = shots.reduce((total, s) => total + (s.prompt.match(/Beat \d+-\d+ happens\./g) ?? []).length, 0);
    expect(beatsCovered).toBe(135);
    expect(shots[0].id).toBe("shot-1-1");
    expect(shots[1].id).toBe("shot-2-1");
    expect(shots[2].id).toBe("shot-2-2");
    expect(planShots(parsed, 7000, 24)).toEqual(shots);
    expect(planShots(parsed, 7000, 60).length).toBe(60);
    expect(planShots(parsed, 7000, 135)).toEqual(planShots(parsed, 7000));
  });

  test("never merges across scenes: a script with more scenes than the cap still plans one shot per scene", () => {
    const script = Array.from({ length: 30 }, (_, i) => `EXT. PLACE ${i + 1} - DAY\n\nSomething happens.\nSomething else happens.\n`).join("\n");
    const shots = planShots(parseFountain(script), 1, 24);
    expect(shots.length).toBe(30);
    expect(shots.every((s) => s.id.endsWith("-1"))).toBe(true);
  });
});

describe("creative bible + rights attestation (AC-007)", () => {
  test("bible auto-generates characters and locations; attestation is captured", () => {
    const b = generateBible("proj-1", parseFountain(SCRIPT));
    expect(b.characters).toEqual(["MARLA"]);
    expect(b.locations).toContain("KITCHEN");
    expect(b.rightsAttestation.attested).toBe(false);
    const a = attestRights(b, "2026-08-31T00:00:00.000Z");
    expect(a.rightsAttestation.attested).toBe(true);
    expect(a.rightsAttestation.attestedAt).toBe("2026-08-31T00:00:00.000Z");
    expect(() => attestRights(b, "")).toThrow(/rights attestation requires/);
  });
});
