import { describe, expect, test } from "bun:test";
import { PROHIBITED_PROMPT_BATTERY, checkPrompt, gateOrThrow } from "../src/index";

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
