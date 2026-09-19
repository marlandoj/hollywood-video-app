/**
 * The AI crew's language model (G13-202609192200): Claude through the Anthropic
 * Messages API, called with plain fetch (no SDK dependency).
 *
 * Every completion reports its token usage and its cost, priced from the table below,
 * so the crew budget line (packages/operator/src/crew-ledger.ts) is metered from the
 * API's own usage figures rather than estimated. A model not in the table is refused
 * at construction: an unpriced model cannot be metered.
 *
 * The key is read from ANTHROPIC_API_KEY, which the operator enters on the staging
 * host. It is sent only in the x-api-key header to the fixed endpoint and never
 * appears in an error, a log line or a return value.
 */
export interface CrewMessage { role: "user" | "assistant"; content: string }
export interface CrewUsage { inputTokens: number; outputTokens: number }
export interface CrewCompletion { text: string; usage: CrewUsage; model: string; costUsd: number }
export interface CrewRequest { system: string; messages: CrewMessage[]; maxTokens: number; signal?: AbortSignal }
export interface CrewModel {
  /** "anthropic" for the live model, "stand-in" for the deterministic local crew. */
  readonly name: "anthropic" | "stand-in";
  readonly model: string;
  complete(request: CrewRequest): Promise<CrewCompletion>;
}

/** US$ per million tokens, from the Anthropic models overview (checked 2026-09-19). */
export const CREW_MODEL_PRICES: Readonly<Record<string, {inputPerMTok: number; outputPerMTok: number}>> = Object.freeze({
  "claude-fable-5-1": {inputPerMTok: 10, outputPerMTok: 50},
  "claude-opus-5": {inputPerMTok: 5, outputPerMTok: 25},
  "claude-sonnet-5": {inputPerMTok: 2, outputPerMTok: 10},
  "claude-haiku-4-5-20251001": {inputPerMTok: 1, outputPerMTok: 5},
});
export const DEFAULT_CREW_MODEL = "claude-sonnet-5";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 8192;

export class CrewModelError extends Error { override name = "CrewModelError"; }

export function crewCostUsd(model: string, usage: CrewUsage): number {
  const price = CREW_MODEL_PRICES[model];
  if (!price) throw new CrewModelError("The crew model " + JSON.stringify(model) + " has no price, so its spend cannot be metered.");
  for (const value of [usage.inputTokens, usage.outputTokens])
    if (!Number.isSafeInteger(value) || value < 0) throw new CrewModelError("The crew model reported invalid token usage.");
  return Number(((usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000).toFixed(6));
}

export class AnthropicCrewModel implements CrewModel {
  readonly name = "anthropic" as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: {apiKey: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number}) {
    if (!options.apiKey || /\s/.test(options.apiKey)) throw new CrewModelError("ANTHROPIC_API_KEY is required for the live crew.");
    this.model = options.model ?? DEFAULT_CREW_MODEL;
    if (!CREW_MODEL_PRICES[this.model]) throw new CrewModelError("The crew model " + JSON.stringify(this.model) + " has no price, so its spend cannot be metered.");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }
  async complete(request: CrewRequest): Promise<CrewCompletion> {
    if (!request.messages.length || request.maxTokens < 1 || request.maxTokens > MAX_OUTPUT_TOKENS) throw new CrewModelError("Invalid crew request.");
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

/** The live crew when the operator has entered a key; otherwise null, and the caller uses the stand-in crew. */
export function crewModelFromEnvironment(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): AnthropicCrewModel | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  return new AnthropicCrewModel({apiKey: key, model: env.HV_CREW_MODEL?.trim() || DEFAULT_CREW_MODEL, fetchImpl});
}
