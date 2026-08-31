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
