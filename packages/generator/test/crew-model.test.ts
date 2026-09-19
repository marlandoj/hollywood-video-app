import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MESSAGES_URL, ANTHROPIC_VERSION, AnthropicCrewModel, CREW_MODEL_PRICES, DEFAULT_CREW_MODEL, crewCostUsd, crewModelFromEnvironment } from "../src/crew-model";

const KEY = "sk-ant-fixture-not-a-real-key-0123456789";
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}});

describe("the crew's language model (HV-030-01)", () => {
  test("calls the Messages API with the key only in its header, and reports usage and cost", async () => {
    let seen: {url: string; init: RequestInit} | undefined;
    const model = new AnthropicCrewModel({apiKey: KEY, fetchImpl: (async (url: string, init: RequestInit) => {
      seen = {url, init};
      return new Response(JSON.stringify({content: [{type: "text", text: "{\"ok\":"}, {type: "tool_use"}, {type: "text", text: "true}"}], usage: {input_tokens: 1200, output_tokens: 300}}));
    }) as unknown as typeof fetch});
    const result = await model.complete({system: "sys", messages: [{role: "user", content: "hi"}], maxTokens: 500});
    expect(seen!.url).toBe(ANTHROPIC_MESSAGES_URL);
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(seen!.init.redirect).toBe("error");
    const body = JSON.parse(String(seen!.init.body));
    expect(body).toEqual({model: DEFAULT_CREW_MODEL, max_tokens: 500, system: "sys", messages: [{role: "user", content: "hi"}]});
    expect(String(seen!.init.body)).not.toContain(KEY);
    expect(result).toEqual({text: "{\"ok\":true}", usage: {inputTokens: 1200, outputTokens: 300}, model: "claude-sonnet-5", costUsd: 0.0054});
  });

  test("prices are per million tokens, and an unpriced model is refused before any call", () => {
    expect(crewCostUsd("claude-sonnet-5", {inputTokens: 1_000_000, outputTokens: 1_000_000})).toBe(CREW_MODEL_PRICES["claude-sonnet-5"]!.inputPerMTok + CREW_MODEL_PRICES["claude-sonnet-5"]!.outputPerMTok);
    expect(() => crewCostUsd("gpt-5", {inputTokens: 1, outputTokens: 1})).toThrow("no price");
    expect(() => new AnthropicCrewModel({apiKey: KEY, model: "claude-imaginary"})).toThrow("no price");
    expect(() => crewCostUsd("claude-sonnet-5", {inputTokens: -1, outputTokens: 0})).toThrow("invalid token usage");
  });

  test("failures never carry the key or the provider's body", async () => {
    for (const [fetchImpl, message] of [
      [reply({error: {message: "invalid x-api-key " + KEY}}, 401), "HTTP 401"],
      [async () => { throw new Error("socket " + KEY); }, "could not be reached"],
      [async () => new Response("not json"), "unreadable"],
      [reply({content: "nope"}), "unreadable"],
    ] as unknown as [typeof fetch, string][]) {
      const model = new AnthropicCrewModel({apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch});
      const error = await model.complete({system: "s", messages: [{role: "user", content: "x"}], maxTokens: 10}).then(() => new Error("resolved"), (value: Error) => value);
      expect(error.message).toContain(message);
      expect(error.message).not.toContain(KEY);
    }
  });

  test("a slow model times out", async () => {
    const model = new AnthropicCrewModel({apiKey: KEY, timeoutMs: 20, fetchImpl: ((_: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch});
    await expect(model.complete({system: "s", messages: [{role: "user", content: "x"}], maxTokens: 10})).rejects.toThrow("did not answer in time");
  });

  test("the live crew exists only when the operator has entered a key", () => {
    expect(crewModelFromEnvironment({})).toBeNull();
    expect(crewModelFromEnvironment({ANTHROPIC_API_KEY: "  "})).toBeNull();
    expect(crewModelFromEnvironment({ANTHROPIC_API_KEY: KEY})?.model).toBe(DEFAULT_CREW_MODEL);
    expect(crewModelFromEnvironment({ANTHROPIC_API_KEY: KEY, HV_CREW_MODEL: "claude-haiku-4-5-20251001"})?.model).toBe("claude-haiku-4-5-20251001");
    expect(() => crewModelFromEnvironment({ANTHROPIC_API_KEY: KEY, HV_CREW_MODEL: "claude-imaginary"})).toThrow("no price");
    expect(() => new AnthropicCrewModel({apiKey: "has space"})).toThrow("required");
  });
});
