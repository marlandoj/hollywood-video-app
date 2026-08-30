import { describe, expect, test } from "bun:test";
import { parseFountain, VersionStore } from "../src/index";

const SHORT = `Title: Test Short

INT. KITCHEN - DAY

A kettle whistles.

MARLA
Tea time.

EXT. GARDEN - DUSK

Wind moves through the hedge.

CUT TO:
`;

describe("fountain parser conformance", () => {
  test("parses scenes, action, dialogue, transitions", () => {
    const r = parseFountain(SHORT);
    expect(r.rejected).toBe(false);
    expect(r.scenes.length).toBe(2);
    expect(r.scenes[0].dialogue[0].character).toBe("MARLA");
    expect(r.scenes[0].dialogue[0].lines[0]).toBe("Tea time.");
    expect(r.scenes[1].transitions).toContain("CUT TO:");
  });

  test("protected text ([[notes]] and /* boneyard */) is excluded", () => {
    const r = parseFountain("INT. LAB - DAY\n\n[[private note DO NOT RENDER]]\n\n/* cut\nmaterial */\n\nVisible action.");
    expect(r.scenes[0].action).toEqual(["Visible action."]);
  });

  test("rejects scripts over 30 pages", () => {
    const long = "INT. VOID - DAY\n" + Array(31 * 55).fill("Action line.").join("\n");
    const r = parseFountain(long);
    expect(r.rejected).toBe(true);
    expect(r.rejectionReason).toContain("30");
  });

  test("warns above 20 scenes", () => {
    const many = Array.from({ length: 21 }, (_, i) => `INT. ROOM ${i} - DAY\n\nBeat.\n`).join("\n");
    const r = parseFountain(many);
    expect(r.rejected).toBe(false);
    expect(r.warnings.some((w) => w.code === "SCENE_COUNT")).toBe(true);
  });

  test("flags unparseable constructs", () => {
    const r = parseFountain("INT. HALL - DAY\n\n>>>~~~ broken markup ~~~<<<\n");
    expect(r.unparseable.length).toBe(1);
    expect(r.warnings.some((w) => w.code === "UNPARSEABLE")).toBe(true);
  });
});

describe("per-edit version history", () => {
  test("each edit creates a version and prior versions stay addressable", () => {
    const s = new VersionStore();
    s.commit("draft one");
    s.commit("draft two");
    const v3 = s.commit("draft three");
    expect(v3.version).toBe(3);
    expect(s.get(1)?.text).toBe("draft one");
    expect(s.get(2)?.parentVersion).toBe(1);
    expect(s.history().length).toBe(3);
  });
});
