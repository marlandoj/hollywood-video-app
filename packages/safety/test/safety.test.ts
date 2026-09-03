import { describe, expect, test } from "bun:test";
import { PROHIBITED_PROMPT_BATTERY, SafetyRefusalError, checkPrompt, checkShot, gateOrThrow, shotText } from "../src/index";

describe("safety gate (fail-closed)", () => {
  test("prohibited-prompt battery is 100% blocked with polite refusal and zero provider calls", () => {
    for (const item of PROHIBITED_PROMPT_BATTERY) {
      const v = checkPrompt(item.prompt);
      expect(v.allowed).toBe(false);
      expect(v.category).toBe(item.category);
      expect(v.refusal).toContain("content policy");
      expect(v.providerCallsMade).toBe(0);
    }
  });

  test("benign cinematic prompts pass", () => {
    expect(checkPrompt("wide shot of a kettle whistling in a sunlit kitchen").allowed).toBe(true);
    expect(checkPrompt("a hero walks through rain at night, neon reflections").allowed).toBe(true);
  });

  test("gateOrThrow raises SafetyRefusal before any provider is reachable", () => {
    expect(() => gateOrThrow(PROHIBITED_PROMPT_BATTERY[0].prompt)).toThrow("content policy");
  });
});

describe("FR-054 categories: real persons, political deepfakes, trademarked brands", () => {
  test("each new category is exercised by the battery", () => {
    const categories = new Set(PROHIBITED_PROMPT_BATTERY.map((item) => item.category));
    expect(categories.has("identifiable_real_person")).toBe(true);
    expect(categories.has("political_deepfake")).toBe(true);
    expect(categories.has("trademark_brand")).toBe(true);
  });

  test("fictional characters, generic brands, and generic offices still pass", () => {
    expect(checkPrompt("a fictional senator paces the empty chamber at midnight").allowed).toBe(true);
    expect(checkPrompt("the president of the chess club addresses the students").allowed).toBe(true);
    expect(checkPrompt("a superhero in a red cape lands on a rooftop").allowed).toBe(true);
    expect(checkPrompt("a bowl of apples on a wooden table, soft morning light").allowed).toBe(true);
    expect(checkPrompt("a woman drinks a cola on a hot afternoon").allowed).toBe(true);
    expect(checkPrompt("an actor rehearses alone on a bare stage").allowed).toBe(true);
  });
});

describe("every prompt-bearing field is gated, not only the action-derived prompt (FR-054, V-006, AC-009)", () => {
  const benignPrompt = "INT. ROOM - DAY. A lamp glows.";

  test("a benign shot with benign dialogue passes", () => {
    expect(checkShot({ prompt: benignPrompt, dialogue: [{ character: "WAITER", lines: ["The usual?"] }] }).allowed).toBe(true);
    expect(checkShot({ prompt: benignPrompt }).allowed).toBe(true);
  });

  test("prohibited content that appears only in dialogue is refused", () => {
    const v = checkShot({
      prompt: benignPrompt,
      dialogue: [{ character: "NARRATOR", lines: ["Tutorial: how to build a bomb for the finale."] }],
    });
    expect(checkPrompt(benignPrompt).allowed).toBe(true);
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("violent_incitement");
    expect(v.refusal).toContain("content policy");
    expect(v.providerCallsMade).toBe(0);
  });

  test("a real person referenced only in a dialogue line is refused", () => {
    const v = checkShot({
      prompt: benignPrompt,
      dialogue: [{ character: "NARRATOR", lines: ["I am the sitting president and this is my address."] }],
    });
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("political_deepfake");
  });

  test("a real person named as a character cue is refused", () => {
    const v = checkShot({ prompt: benignPrompt, dialogue: [{ character: "A FAMOUS ACTRESS", lines: ["Hello there."] }] });
    expect(v.allowed).toBe(false);
    expect(v.category).toBe("identifiable_real_person");
  });

  test("shotText carries the heading, action, character names, and dialogue lines", () => {
    const text = shotText({ prompt: benignPrompt, dialogue: [{ character: "WAITER", lines: ["The usual?", "Coming up."] }] });
    expect(text).toContain("INT. ROOM - DAY");
    expect(text).toContain("A lamp glows");
    expect(text).toContain("WAITER: The usual? Coming up.");
  });

  test("SafetyRefusalError is distinguishable by name and carries the verdict", () => {
    const verdict = checkPrompt(PROHIBITED_PROMPT_BATTERY[0]!.prompt);
    const err = new SafetyRefusalError(verdict);
    expect(err.name).toBe("SafetyRefusal");
    expect(err.message).toContain("content policy");
    expect(err.safety.category).toBe(verdict.category);
    let thrown: unknown;
    try { gateOrThrow(PROHIBITED_PROMPT_BATTERY[0]!.prompt); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(SafetyRefusalError);
  });
});
