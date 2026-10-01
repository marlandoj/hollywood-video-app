/**
 * HV-030-24 — the crew can think through OpenRouter or Synthetic.new, on the one crew line.
 *
 * G16-202610011400 (G3) approved both as the crew's language-model vendors, with the crew's spending
 * limits standard across providers. Both speak OpenAI's chat-completions shape, so one class calls
 * them; each vendor is its endpoint, its key's variable, its default model and its concurrency.
 * Every call is metered: OpenRouter at the larger of the price table and its own reported cost,
 * Synthetic at $0 with its tokens, because it is a flat subscription. No live call is made: every
 * test answers through a fake fetch, and no test key is real.
 */
import { describe, expect, test } from "bun:test";
import {
  AnthropicCrewModel, CREW_BUSY_DEFAULT_MS, CREW_BUSY_MAX_MS, CREW_MAX_WAITING, CREW_MODEL_PRICES, CrewModelBusy, CrewModelUnusable,
  OPENROUTER, OpenAiCompatibleCrewModel, SYNTHETIC, crewModelFromEnvironment, crewVendorOf, type CrewRequest,
} from "../src/crew-model";

const OR_KEY = "sk-or-fixture-not-a-real-key-0123456789";
const SYN_KEY = "syn-fixture-not-a-real-key-0123456789";
const ask: CrewRequest = {system: "You are the crew.", messages: [{role: "user", content: "Read this."}, {role: "assistant", content: "Read."}, {role: "user", content: "Plan it."}], maxTokens: 700};
const answer = (content: unknown, usage: Record<string, unknown> = {prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200}, extra: Record<string, unknown> = {}) =>
  ({id: "gen-1", choices: [{index: 0, finish_reason: "stop", message: {role: "assistant", content, ...extra}}], usage});
type Seen = {url: string; init: RequestInit};
function fake(...responses: (() => Response | Promise<Response>)[]): typeof fetch & {seen: Seen[]} {
  const seen: Seen[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({url, init});
    const next = responses[Math.min(seen.length, responses.length) - 1]!;
    return next();
  }) as unknown as typeof fetch & {seen: Seen[]};
  impl.seen = seen;
  return impl;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", ...headers}});
const failure = (promise: Promise<unknown>) => promise.then(() => new Error("resolved"), (error: Error) => error);

describe("OpenRouter", () => {
  /** The chat-completions endpoint, the key only as a bearer token, the system prompt as the first message, and no URL naming the host. */
  test("sends the system prompt and messages in chat-completions form, with the key only in its bearer header", async () => {
    const fetchImpl = fake(json(answer("{\"ok\":true}", {prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cost: 0.004})));
    const model = new OpenAiCompatibleCrewModel({vendor: OPENROUTER, apiKey: OR_KEY, fetchImpl});
    const result = await model.complete(ask);
    const {url, init} = fetchImpl.seen[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({"content-type": "application/json", authorization: "Bearer " + OR_KEY, "x-title": "Rough Cut"});
    expect(JSON.stringify(init.headers)).not.toMatch(/referer|http:|https:/i);
    expect(JSON.parse(String(init.body))).toEqual({model: "anthropic/claude-sonnet-5.5", max_tokens: 700, messages: [
      {role: "system", content: "You are the crew."}, {role: "user", content: "Read this."}, {role: "assistant", content: "Read."}, {role: "user", content: "Plan it."}]});
    expect(String(init.body)).not.toContain(OR_KEY);
    expect(result).toEqual({text: "{\"ok\":true}", usage: {inputTokens: 1000, outputTokens: 200}, model: "openrouter:anthropic/claude-sonnet-5.5", costUsd: 0.004});
    expect(model.name).toBe("openrouter");
  });

  /** The larger of the table's price and OpenRouter's reported cost, so a call is never under-metered; a missing or invalid cost falls back to the table. */
  test("charges the larger of the price table and the reported cost", async () => {
    // Table: 1,000 in at $2/M plus 200 out at $10/M = $0.004.
    for (const [cost, charged] of [[0.009, 0.009], [0.001, 0.004], [undefined, 0.004], [-5, 0.004], ["0.5", 0.004], [Number.NaN, 0.004]] as const) {
      const usage: Record<string, unknown> = {prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200};
      if (cost !== undefined) usage.cost = cost;
      const model = new OpenAiCompatibleCrewModel({vendor: OPENROUTER, apiKey: OR_KEY, fetchImpl: fake(json(answer("ok", usage)))});
      expect((await model.complete(ask)).costUsd).toBe(charged);
    }
  });

  /** HV_CREW_MODEL picks among OpenRouter's priced models by OpenRouter's own id; an unpriced one, or another vendor's, is refused before any call. */
  test("a model must be in OpenRouter's part of the price table", () => {
    expect(new OpenAiCompatibleCrewModel({vendor: OPENROUTER, apiKey: OR_KEY, model: "anthropic/claude-haiku-4.5"}).model).toBe("openrouter:anthropic/claude-haiku-4.5");
    expect(CREW_MODEL_PRICES["openrouter:anthropic/claude-opus-5.5"]).toEqual({inputPerMTok: 4, outputPerMTok: 20});
    expect(() => new OpenAiCompatibleCrewModel({vendor: OPENROUTER, apiKey: OR_KEY, model: "openai/gpt-9"})).toThrow("no price");
    expect(() => new OpenAiCompatibleCrewModel({vendor: OPENROUTER, apiKey: OR_KEY, model: "claude-sonnet-5"})).toThrow("no price");
    expect(() => new AnthropicCrewModel({apiKey: OR_KEY, model: "openrouter:anthropic/claude-sonnet-5.5"})).toThrow("not one of anthropic's");
  });
});

describe("Synthetic.new", () => {
  /** Synthetic's endpoint and bearer key, an hf: model id, no attribution header. */
  test("sends a chat-completions request with an hf: model and the key only in its bearer header", async () => {
    const fetchImpl = fake(json(answer("hello", {prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000})));
    const model = new OpenAiCompatibleCrewModel({vendor: SYNTHETIC, apiKey: SYN_KEY, fetchImpl});
    const result = await model.complete(ask);
    expect(fetchImpl.seen[0]!.url).toBe("https://api.synthetic.new/openai/v1/chat/completions");
    expect(fetchImpl.seen[0]!.init.headers).toEqual({"content-type": "application/json", authorization: "Bearer " + SYN_KEY});
    expect(JSON.parse(String(fetchImpl.seen[0]!.init.body)).model).toBe("hf:moonshotai/Kimi-K3");
    expect(String(fetchImpl.seen[0]!.init.body)).not.toContain(SYN_KEY);
    expect(result).toEqual({text: "hello", usage: {inputTokens: 900, outputTokens: 100}, model: "synthetic:hf:moonshotai/Kimi-K3", costUsd: 0});
  });

  /** A flat subscription: every Synthetic model is priced $0 and marked as subscription, never given an invented per-token rate. */
  test("every Synthetic model is priced at $0 and marked as a subscription", () => {
    const synthetic = Object.entries(CREW_MODEL_PRICES).filter(([id]) => crewVendorOf(id) === "synthetic");
    expect(synthetic.map(([id]) => id).sort()).toEqual(["synthetic:hf:Qwen/Qwen3.8-27B", "synthetic:hf:deepseek-ai/DeepSeek-V4.1-Flash",
      "synthetic:hf:moonshotai/Kimi-K3", "synthetic:hf:openai/gpt-oss-120b", "synthetic:hf:zai-org/GLM-5.3-Flash"]);
    for (const [, price] of synthetic) expect(price).toEqual({inputPerMTok: 0, outputPerMTok: 0, billing: "subscription"});
    for (const [id, price] of Object.entries(CREW_MODEL_PRICES)) if (crewVendorOf(id) !== "synthetic") expect(price.billing).toBeUndefined();
  });

  /** Synthetic allows one request at a time per model: a second call waits for the first instead of drawing a 429, and only a few may wait. */
  test("one request at a time: the next waits its turn, and a full queue is told the crew is busy", async () => {
    const releases: (() => void)[] = [];
    let open = 0, most = 0;
    const fetchImpl = (async () => {
      open++; most = Math.max(most, open);
      await new Promise<void>(resolve => releases.push(resolve));
      open--;
      return new Response(JSON.stringify(answer("ok")));
    }) as unknown as typeof fetch;
    const model = new OpenAiCompatibleCrewModel({vendor: SYNTHETIC, apiKey: SYN_KEY, fetchImpl});
    const calls = Array.from({length: CREW_MAX_WAITING + 1}, () => model.complete(ask));
    const overflow = await failure(model.complete(ask));
    expect(overflow).toBeInstanceOf(CrewModelBusy);
    for (let index = 0; index < calls.length; index++) {
      await Bun.sleep(1);
      expect(releases.length).toBe(index + 1);
      releases[index]!();
    }
    expect((await Promise.all(calls)).map(result => result.text)).toEqual(Array(CREW_MAX_WAITING + 1).fill("ok"));
    expect(most).toBe(1);
  });
});

describe("both vendors", () => {
  const vendors = [[OPENROUTER, OR_KEY], [SYNTHETIC, SYN_KEY]] as const;

  /** Non-200, unreachable, unreadable and timed-out calls fail with the vendor's status at most: never its body, never the key. */
  test("failures name what happened and never carry the key or the vendor's body", async () => {
    for (const [vendor, key] of vendors) {
      for (const [fetchImpl, message] of [
        [json({error: {message: "bad key " + key}}, 401), "HTTP 401"],
        [json({error: {message: "upstream " + key}}, 502), "HTTP 502"],
        [() => { throw new Error("socket " + key); }, "could not be reached"],
        [() => new Response("not json " + key), "unreadable"],
        [json({choices: [{message: {content: "x"}}]}), "unreadable"],
        [json({error: {message: key}}), "unreadable"],
      ] as [() => Response, string][]) {
        const model = new OpenAiCompatibleCrewModel({vendor, apiKey: key, fetchImpl: fake(fetchImpl)});
        const error = await failure(model.complete(ask));
        expect(error.message).toContain(message);
        expect(error.message).not.toContain(key);
        expect(error).not.toBeInstanceOf(CrewModelUnusable);
      }
      const slow = new OpenAiCompatibleCrewModel({vendor, apiKey: key, timeoutMs: 20, fetchImpl: ((_: string, init: RequestInit) => new Promise((_, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted " + key)));
      })) as unknown as typeof fetch});
      expect((await failure(slow.complete(ask))).message).toBe("The crew model did not answer in time.");
    }
  });

  /** A billed answer with no usable text -- no choice, empty, declined, cut off at the limit, filtered -- is an error that still carries its spend. */
  test("an empty, declined or cut-off answer is an error that carries what it cost", async () => {
    const usage = {prompt_tokens: 1000, completion_tokens: 700, cost: 0.02};
    for (const [body, message] of [
      [{choices: [], usage}, "no answer"],
      [answer("", usage), "empty answer"],
      [answer("   \n", usage), "empty answer"],
      [answer(null, usage), "empty answer"],
      [answer([{type: "text", text: "parts"}], usage), "empty answer"],
      [answer(null, usage, {refusal: "I can't help with that."}), "declined"],
      [{choices: [{finish_reason: "length", message: {content: "{\"logline\": \"half"}}], usage}, "cut off"],
      [{choices: [{finish_reason: "content_filter", message: {content: ""}}], usage}, "withheld"],
    ] as [unknown, string][]) {
      const model = new OpenAiCompatibleCrewModel({vendor: OPENROUTER, apiKey: OR_KEY, fetchImpl: fake(json(body))});
      const error = await failure(model.complete(ask));
      expect(error).toBeInstanceOf(CrewModelUnusable);
      expect(error.message).toContain(message);
      expect((error as CrewModelUnusable).completion).toEqual({text: "", usage: {inputTokens: 1000, outputTokens: 700}, model: "openrouter:anthropic/claude-sonnet-5.5", costUsd: 0.02});
    }
  });

  /** A 429 is "busy": the crew stops asking that vendor for its Retry-After (bounded), so it never retries into the limit; then it asks again. */
  test("a 429 makes the crew wait out the vendor's limit without calling it again", async () => {
    for (const [vendor, key] of vendors) {
      let clock = 1_000_000;
      const fetchImpl = fake(json({error: {message: "rate limited " + key}}, 429, {"retry-after": "12"}), json(answer("back")));
      const model = new OpenAiCompatibleCrewModel({vendor, apiKey: key, fetchImpl, now: () => clock});
      const first = await failure(model.complete(ask));
      expect(first).toBeInstanceOf(CrewModelBusy);
      expect(first.message).not.toContain(key);
      clock += 11_999;
      expect(await failure(model.complete(ask))).toBeInstanceOf(CrewModelBusy);
      expect(fetchImpl.seen.length).toBe(1);
      clock += 1;
      expect((await model.complete(ask)).text).toBe("back");
      expect(fetchImpl.seen.length).toBe(2);
    }
    // No Retry-After waits the default; a huge one is capped.
    for (const [header, wait] of [[undefined, CREW_BUSY_DEFAULT_MS], ["86400", CREW_BUSY_MAX_MS], ["soon", CREW_BUSY_DEFAULT_MS]] as const) {
      let clock = 0;
      const fetchImpl = fake(json({}, 429, header ? {"retry-after": header} : {}), json(answer("back")));
      const model = new OpenAiCompatibleCrewModel({vendor: SYNTHETIC, apiKey: SYN_KEY, fetchImpl, now: () => clock});
      await failure(model.complete(ask));
      clock = wait - 1;
      expect(await failure(model.complete(ask))).toBeInstanceOf(CrewModelBusy);
      clock = wait;
      expect((await model.complete(ask)).text).toBe("back");
    }
  });
});

describe("choosing the vendor from the environment", () => {
  /** Unset, today's behaviour: Anthropic with its key, otherwise the stand-in. */
  test("with HV_CREW_PROVIDER unset, the crew is Anthropic with a key and the stand-in without", () => {
    expect(crewModelFromEnvironment({})).toBeNull();
    expect(crewModelFromEnvironment({HV_OPENROUTER_API_KEY: OR_KEY, HV_SYNTHETIC_API_KEY: SYN_KEY})).toBeNull();
    expect(crewModelFromEnvironment({ANTHROPIC_API_KEY: "sk-ant-fixture"})?.name).toBe("anthropic");
  });

  /** Each provider with its own key, its default model, and HV_CREW_MODEL choosing within its own table. */
  test("HV_CREW_PROVIDER picks OpenRouter or Synthetic with its own key and model", () => {
    const openrouter = crewModelFromEnvironment({HV_CREW_PROVIDER: "openrouter", HV_OPENROUTER_API_KEY: OR_KEY, ANTHROPIC_API_KEY: "sk-ant-fixture"});
    expect([openrouter?.name, openrouter?.model]).toEqual(["openrouter", "openrouter:anthropic/claude-sonnet-5.5"]);
    const synthetic = crewModelFromEnvironment({HV_CREW_PROVIDER: " Synthetic ", HV_SYNTHETIC_API_KEY: SYN_KEY});
    expect([synthetic?.name, synthetic?.model]).toEqual(["synthetic", "synthetic:hf:moonshotai/Kimi-K3"]);
    expect(crewModelFromEnvironment({HV_CREW_PROVIDER: "synthetic", HV_SYNTHETIC_API_KEY: SYN_KEY, HV_CREW_MODEL: "hf:zai-org/GLM-5.3-Flash"})?.model).toBe("synthetic:hf:zai-org/GLM-5.3-Flash");
    expect(crewModelFromEnvironment({HV_CREW_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-fixture"})?.model).toBe("claude-sonnet-5");
    expect(() => crewModelFromEnvironment({HV_CREW_PROVIDER: "synthetic", HV_SYNTHETIC_API_KEY: SYN_KEY, HV_CREW_MODEL: "anthropic/claude-sonnet-5.5"})).toThrow("no price");
  });

  /** A provider without its key, or an unknown provider, stops startup with a message naming the variable and never a value. */
  test("a provider named without its key fails at startup, naming the variable and never a key", () => {
    for (const [env, variable] of [
      [{HV_CREW_PROVIDER: "openrouter", HV_SYNTHETIC_API_KEY: SYN_KEY, ANTHROPIC_API_KEY: "sk-ant-fixture"}, "HV_OPENROUTER_API_KEY"],
      [{HV_CREW_PROVIDER: "synthetic", HV_OPENROUTER_API_KEY: OR_KEY, HV_SYNTHETIC_API_KEY: "  "}, "HV_SYNTHETIC_API_KEY"],
      [{HV_CREW_PROVIDER: "anthropic", HV_OPENROUTER_API_KEY: OR_KEY}, "ANTHROPIC_API_KEY"],
    ] as [Record<string, string>, string][]) {
      const error = (() => { try { crewModelFromEnvironment(env); return new Error("built"); } catch (value) { return value as Error; } })();
      expect(error.message).toContain(variable + " is not set");
      for (const secret of [OR_KEY, SYN_KEY, "sk-ant-fixture"]) expect(error.message).not.toContain(secret);
    }
    expect(() => crewModelFromEnvironment({HV_CREW_PROVIDER: "kimi", HV_OPENROUTER_API_KEY: OR_KEY})).toThrow("must be anthropic, openrouter or synthetic");
    expect(() => crewModelFromEnvironment({HV_CREW_PROVIDER: "openrouter", HV_OPENROUTER_API_KEY: "two words"})).toThrow("HV_OPENROUTER_API_KEY is required");
  });
});
