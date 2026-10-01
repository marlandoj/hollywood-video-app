/**
 * The AI crew's language model (G13-202609192200, G16-202610011400). Three vendors, each called
 * with plain fetch (no SDK dependency):
 *
 * - **anthropic**: Claude through the Anthropic Messages API, keyed by ANTHROPIC_API_KEY.
 * - **openrouter** (G16, G3): OpenRouter's OpenAI-compatible chat completions, keyed by
 *   HV_OPENROUTER_API_KEY.
 * - **synthetic** (G16, G3): Synthetic.new's OpenAI-compatible chat completions, keyed by
 *   HV_SYNTHETIC_API_KEY. A flat subscription: no per-token charge.
 *
 * Every completion reports its token usage and its cost, priced from the table below, so the crew
 * budget line (packages/operator/src/crew-ledger.ts) is metered from the vendor's own usage figures
 * rather than estimated. Whichever vendor answers, the spend goes on the ONE crew line, with the
 * same alerts and the same stop (G16). A model not in the table is refused at construction: an
 * unpriced model cannot be metered.
 *
 * The table and the line name a model by its metered id: Anthropic's own ids as they have always
 * been recorded, and `openrouter:<id>` or `synthetic:<id>` for the other two, so the line shows
 * which vendor answered every call.
 *
 * Keys are entered by the operator on the staging host. A key is sent only in its vendor's auth
 * header to the vendor's fixed endpoint and never appears in an error, a log line or a return value.
 */
export interface CrewMessage { role: "user" | "assistant"; content: string }
export interface CrewUsage { inputTokens: number; outputTokens: number }
export interface CrewCompletion { text: string; usage: CrewUsage; model: string; costUsd: number }
export interface CrewRequest { system: string; messages: CrewMessage[]; maxTokens: number; signal?: AbortSignal }
/** The vendors whose models the crew may think with (G13 for Anthropic, G16 for the other two). */
export type CrewVendor = "anthropic" | "openrouter" | "synthetic";
export const CREW_VENDORS: readonly CrewVendor[] = Object.freeze(["anthropic", "openrouter", "synthetic"]);
export interface CrewModel {
  /** The vendor answering for the live crew, or "stand-in" for the deterministic local crew. */
  readonly name: CrewVendor | "stand-in";
  /** The metered id: the key into CREW_MODEL_PRICES, and what the crew line records. */
  readonly model: string;
  complete(request: CrewRequest): Promise<CrewCompletion>;
}

export interface CrewModelPrice {
  /** US$ per million tokens. */
  inputPerMTok: number; outputPerMTok: number;
  /** A flat subscription with no per-token charge: priced at $0 here, never at an invented rate. */
  billing?: "subscription";
}

/**
 * US$ per million tokens.
 * - Anthropic: the Anthropic models overview (checked 2026-09-19).
 * - OpenRouter: its model pages (checked 2026-10-01). OpenRouter also reports each call's own cost,
 *   and the crew is charged the larger of that and this table's price, so it is never under-metered.
 * - Synthetic.new: a flat subscription ($30 a month, 500 requests per 5 hours, one request at a time
 *   per model; checked 2026-10-01). Its answers report tokens and no cost. The marginal cost of a
 *   call is $0, so the tokens are recorded at $0; the subscription itself is not on the crew line.
 */
export const CREW_MODEL_PRICES: Readonly<Record<string, Readonly<CrewModelPrice>>> = Object.freeze({
  "claude-fable-5-1": {inputPerMTok: 10, outputPerMTok: 50},
  "claude-opus-5": {inputPerMTok: 5, outputPerMTok: 25},
  "claude-sonnet-5": {inputPerMTok: 2, outputPerMTok: 10},
  "claude-haiku-4-5-20251001": {inputPerMTok: 1, outputPerMTok: 5},
  "openrouter:anthropic/claude-sonnet-5.5": {inputPerMTok: 2, outputPerMTok: 10},
  "openrouter:anthropic/claude-sonnet-5": {inputPerMTok: 2, outputPerMTok: 10},
  "openrouter:anthropic/claude-haiku-4.5": {inputPerMTok: 1, outputPerMTok: 5},
  "openrouter:anthropic/claude-opus-5.5": {inputPerMTok: 4, outputPerMTok: 20},
  "synthetic:hf:moonshotai/Kimi-K3": {inputPerMTok: 0, outputPerMTok: 0, billing: "subscription"},
  "synthetic:hf:deepseek-ai/DeepSeek-V4.1-Flash": {inputPerMTok: 0, outputPerMTok: 0, billing: "subscription"},
  "synthetic:hf:zai-org/GLM-5.3-Flash": {inputPerMTok: 0, outputPerMTok: 0, billing: "subscription"},
  "synthetic:hf:Qwen/Qwen3.8-27B": {inputPerMTok: 0, outputPerMTok: 0, billing: "subscription"},
  "synthetic:hf:openai/gpt-oss-120b": {inputPerMTok: 0, outputPerMTok: 0, billing: "subscription"},
});
export const DEFAULT_CREW_MODEL = "claude-sonnet-5";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 8192;

export class CrewModelError extends Error { override name = "CrewModelError"; }
/** The vendor is rate-limiting the crew (HTTP 429). The crew falls back as for any unavailable model. */
export class CrewModelBusy extends CrewModelError { override name = "CrewModelBusy"; }
/**
 * The vendor answered, and billed, but the answer cannot be used: empty, declined, or cut off at the
 * token limit. It carries the billed completion (with no text), so the spend still goes on the line.
 */
export class CrewModelUnusable extends CrewModelError {
  override name = "CrewModelUnusable";
  constructor(message: string, readonly completion: CrewCompletion) { super(message); }
}

/** The vendor a metered id belongs to. */
export function crewVendorOf(meteredId: string): CrewVendor {
  if (meteredId.startsWith("openrouter:")) return "openrouter";
  if (meteredId.startsWith("synthetic:")) return "synthetic";
  return "anthropic";
}
/** The id the table and the crew line use for a vendor's own model id. */
export const meteredCrewModelId = (vendor: CrewVendor, id: string): string => vendor === "anthropic" ? id : vendor + ":" + id;

const money = (value: number) => Number(value.toFixed(6));
const unpriced = (model: string) => new CrewModelError("The crew model " + JSON.stringify(model) + " has no price, so its spend cannot be metered.");

export function crewCostUsd(model: string, usage: CrewUsage): number {
  const price = CREW_MODEL_PRICES[model];
  if (!price) throw unpriced(model);
  for (const value of [usage.inputTokens, usage.outputTokens])
    if (!Number.isSafeInteger(value) || value < 0) throw new CrewModelError("The crew model reported invalid token usage.");
  return money((usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000);
}

function priced(vendor: CrewVendor, model: string): string {
  if (!CREW_MODEL_PRICES[model]) throw unpriced(model);
  if (crewVendorOf(model) !== vendor) throw new CrewModelError("The crew model " + JSON.stringify(model) + " is not one of " + vendor + "'s.");
  return model;
}

function invalidRequest(request: CrewRequest): boolean {
  return !request.messages.length || request.maxTokens < 1 || request.maxTokens > MAX_OUTPUT_TOKENS;
}

export class AnthropicCrewModel implements CrewModel {
  readonly name = "anthropic" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: {apiKey: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number}) {
    if (!options.apiKey || /\s/.test(options.apiKey)) throw new CrewModelError("ANTHROPIC_API_KEY is required for the live crew.");
    this.model = priced("anthropic", options.model ?? DEFAULT_CREW_MODEL);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }
  async complete(request: CrewRequest): Promise<CrewCompletion> {
    if (invalidRequest(request)) throw new CrewModelError("Invalid crew request.");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: "POST", signal, redirect: "error",
        headers: {"content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION},
        body: JSON.stringify({model: this.model, max_tokens: request.maxTokens, system: request.system, messages: request.messages}),
      });
    } catch {
      throw new CrewModelError(timeout.aborted ? "The crew model did not answer in time." : "The crew model could not be reached.");
    }
    if (!response.ok) throw new CrewModelError("The crew model refused the request (HTTP " + response.status + ").");
    let body: unknown;
    try { body = await response.json(); } catch { throw new CrewModelError("The crew model returned an unreadable answer."); }
    const value = body as {content?: {type?: string; text?: string}[]; usage?: {input_tokens?: number; output_tokens?: number}};
    if (!Array.isArray(value.content) || !value.usage) throw new CrewModelError("The crew model returned an unreadable answer.");
    const text = value.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("");
    const usage = {inputTokens: Number(value.usage.input_tokens), outputTokens: Number(value.usage.output_tokens)};
    return {text, usage, model: this.model, costUsd: crewCostUsd(this.model, usage)};
  }
}

/** An OpenAI-compatible vendor the crew may call (G16). */
export interface OpenAiCrewVendor {
  name: "openrouter" | "synthetic";
  url: string;
  /** The environment variable holding the key: named in errors, never the value. */
  keyVariable: string;
  /** The vendor's own model id used when the operator chooses none. */
  defaultModel: string;
  /** Extra request headers. Nothing that names the private staging host. */
  headers: Readonly<Record<string, string>>;
  /** Requests the vendor allows at once per model; more wait their turn here instead of drawing a 429. */
  concurrent: number;
}
export const OPENROUTER: OpenAiCrewVendor = Object.freeze({
  name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", keyVariable: "HV_OPENROUTER_API_KEY",
  defaultModel: "anthropic/claude-sonnet-5.5", headers: Object.freeze({"x-title": "Rough Cut"}), concurrent: Number.POSITIVE_INFINITY,
});
export const SYNTHETIC: OpenAiCrewVendor = Object.freeze({
  name: "synthetic", url: "https://api.synthetic.new/openai/v1/chat/completions", keyVariable: "HV_SYNTHETIC_API_KEY",
  defaultModel: "hf:moonshotai/Kimi-K3", headers: Object.freeze({}), concurrent: 1,
});
/** How many calls may wait for a vendor's one slot before the next is told the crew is busy. */
export const CREW_MAX_WAITING = 4;
/** After a 429, how long the crew stops asking that vendor: its Retry-After, within these bounds. */
export const CREW_BUSY_DEFAULT_MS = 30_000;
export const CREW_BUSY_MAX_MS = 300_000;

export class OpenAiCompatibleCrewModel implements CrewModel {
  readonly name: "openrouter" | "synthetic";
  readonly model: string;
  /** The vendor's own id, as sent in the request. */
  readonly vendorModel: string;
  private readonly vendor: OpenAiCrewVendor;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private busyUntil = 0;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(options: {vendor: OpenAiCrewVendor; apiKey: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number}) {
    this.vendor = options.vendor;
    this.name = options.vendor.name;
    if (!options.apiKey || /\s/.test(options.apiKey)) throw new CrewModelError(options.vendor.keyVariable + " is required for the live crew.");
    this.vendorModel = options.model ?? options.vendor.defaultModel;
    this.model = priced(this.name, meteredCrewModelId(this.name, this.vendorModel));
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.now = options.now ?? Date.now;
  }

  async complete(request: CrewRequest): Promise<CrewCompletion> {
    if (invalidRequest(request)) throw new CrewModelError("Invalid crew request.");
    this.assertNotBusy();
    // One request at a time per model where the vendor says so (Synthetic): the rest wait, a few deep.
    if (this.running >= this.vendor.concurrent) {
      if (this.waiting.length >= CREW_MAX_WAITING) throw new CrewModelBusy("The crew model is busy with other requests.");
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else this.running++;
    try {
      this.assertNotBusy();
      return await this.send(request);
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.running--;
    }
  }

  private assertNotBusy(): void {
    // After a 429 the crew does not ask again until the vendor's wait is over: no retry storm.
    if (this.now() < this.busyUntil) throw new CrewModelBusy("The crew model is busy; it asked the crew to wait.");
  }

  private async send(request: CrewRequest): Promise<CrewCompletion> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(this.vendor.url, {
        method: "POST", signal, redirect: "error",
        headers: {"content-type": "application/json", authorization: "Bearer " + this.apiKey, ...this.vendor.headers},
        body: JSON.stringify({model: this.vendorModel, max_tokens: request.maxTokens,
          messages: [{role: "system", content: request.system}, ...request.messages.map(message => ({role: message.role, content: message.content}))]}),
      });
    } catch {
      throw new CrewModelError(timeout.aborted ? "The crew model did not answer in time." : "The crew model could not be reached.");
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, CREW_BUSY_MAX_MS) : CREW_BUSY_DEFAULT_MS;
      this.busyUntil = this.now() + waitMs;
      throw new CrewModelBusy("The crew model is busy (HTTP 429).");
    }
    if (!response.ok) throw new CrewModelError("The crew model refused the request (HTTP " + response.status + ").");
    let body: unknown;
    try { body = await response.json(); } catch { throw new CrewModelError("The crew model returned an unreadable answer."); }
    const value = body as {
      choices?: {finish_reason?: string | null; message?: {content?: unknown; refusal?: unknown}}[];
      usage?: {prompt_tokens?: number; completion_tokens?: number; cost?: unknown};
    };
    if (!value || typeof value !== "object" || !value.usage || typeof value.usage !== "object") throw new CrewModelError("The crew model returned an unreadable answer.");
    const usage = {inputTokens: Number(value.usage.prompt_tokens), outputTokens: Number(value.usage.completion_tokens)};
    // Never under-metered: the table's price, or the vendor's own reported cost if that is more.
    const reported = typeof value.usage.cost === "number" && Number.isFinite(value.usage.cost) && value.usage.cost >= 0 ? money(value.usage.cost) : 0;
    const costUsd = Math.max(crewCostUsd(this.model, usage), reported);
    const spent = (message: string) => new CrewModelUnusable(message, {text: "", usage, model: this.model, costUsd});
    const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
    if (!choice || typeof choice !== "object" || !choice.message) throw spent("The crew model returned no answer.");
    if (typeof choice.message.refusal === "string" && choice.message.refusal.trim()) throw spent("The crew model declined to answer.");
    if (choice.finish_reason === "length") throw spent("The crew model's answer was cut off at its length limit.");
    if (choice.finish_reason === "content_filter") throw spent("The crew model's answer was withheld by its vendor's filter.");
    const text = choice.message.content;
    if (typeof text !== "string" || !text.trim()) throw spent("The crew model returned an empty answer.");
    return {text, usage, model: this.model, costUsd};
  }
}

/**
 * The live crew the operator has configured; otherwise null, and the caller uses the stand-in crew.
 *
 * HV_CREW_PROVIDER picks the vendor: anthropic, openrouter or synthetic. Unset, it is today's
 * behaviour: Anthropic when ANTHROPIC_API_KEY is set, else the stand-in. A vendor chosen without its
 * key is a startup error that names the variable. HV_CREW_MODEL picks the vendor's model by the
 * vendor's own id, and must be in the price table for that vendor.
 */
export function crewModelFromEnvironment(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): CrewModel | null {
  const provider = env.HV_CREW_PROVIDER?.trim().toLowerCase();
  const model = env.HV_CREW_MODEL?.trim() || undefined;
  if (!provider) {
    const key = env.ANTHROPIC_API_KEY?.trim();
    return key ? new AnthropicCrewModel({apiKey: key, model, fetchImpl}) : null;
  }
  if (!(CREW_VENDORS as readonly string[]).includes(provider)) throw new CrewModelError("HV_CREW_PROVIDER must be anthropic, openrouter or synthetic.");
  const vendor = provider === "openrouter" ? OPENROUTER : provider === "synthetic" ? SYNTHETIC : null;
  const variable = vendor?.keyVariable ?? "ANTHROPIC_API_KEY";
  const key = env[variable]?.trim();
  if (!key) throw new CrewModelError("HV_CREW_PROVIDER is " + provider + ", but " + variable + " is not set. The operator enters it in the staging host's runtime secrets.");
  return vendor ? new OpenAiCompatibleCrewModel({vendor, apiKey: key, model, fetchImpl}) : new AnthropicCrewModel({apiKey: key, model, fetchImpl});
}

/**
 * One crew call, as every crew path makes it: the answer and whether it can be used, or null when
 * the model could not be asked or would not answer (unreachable, busy, refused) and nothing was
 * billed. A billed answer that cannot be used comes back with `usable: false`, so its spend still
 * goes on the crew line before the stand-in takes over.
 */
export async function askCrewModel(model: CrewModel, request: CrewRequest): Promise<{completion: CrewCompletion; usable: boolean} | null> {
  try { return {completion: await model.complete(request), usable: true}; }
  catch (error) { return error instanceof CrewModelUnusable ? {completion: error.completion, usable: false} : null; }
}
