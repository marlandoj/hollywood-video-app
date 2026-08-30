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
