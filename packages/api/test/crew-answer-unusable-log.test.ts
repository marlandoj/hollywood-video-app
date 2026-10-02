/**
 * HV-030-25 — the studio says why a paid crew answer was unusable.
 *
 * On the Release 2 exit run the read-through fell back to the stand-in after a paid OpenRouter call,
 * and nothing was logged. Each crew route now logs `crew.answer_unusable` with the step, the vendor,
 * the metered model, a fixed reason code and the cost -- and never the model's text, the prompt or
 * the key. These tests drive the real routes with the real OpenRouter class over a fake fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OPENROUTER, OpenAiCompatibleCrewModel } from "../../generator/src/crew-model";
import { EVENTS, LOG_KEYS, StudioLogger, safeLogFields, type LogFields } from "../../observability/src/logs";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { createApiServer } from "../src/server";

const root = `/tmp/hv-crew-unusable-log-${Date.now()}`;
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };
const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea beside the CANARYKETTLE.\n\nMAYA\nYou came back.";
const KEY = "sk-or-CANARYKEY-fixture";
const lines: string[] = [];
let finish = "length", content = '{"logline": "CANARYANSWER reunites';
let server: ReturnType<typeof createApiServer>, base: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  const fetchImpl = (async () => new Response(JSON.stringify({choices: [{finish_reason: finish, message: {role: "assistant", content}}],
    usage: {prompt_tokens: 1000, completion_tokens: 2000, cost: 0.022}}))) as unknown as typeof fetch;
  const crewModel = new OpenAiCompatibleCrewModel({vendor: OPENROUTER, apiKey: KEY, fetchImpl});
  const logger = new StudioLogger({service: "api", write: (_level, line) => lines.push(line)});
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath: `${root}/jobs.json`, artifactRoot: `${root}/artifacts`, statePath: `${root}/projects.json`,
    costLedgerPath: `${root}/cost.json`, frontendOrigin: "https://staging.example.test", rateLimit: generous, crewLedger: new CrewLedger(), crewModel, logger });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function project() {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: SCRIPT }) });
  return { ...created, headers };
}
const unusable = () => lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === "crew.answer_unusable");

describe("crew.answer_unusable", () => {
  /** A cut-off read-through, plan and line notes each log one line naming the step, vendor, model, reason and cost, and nothing the model or creator wrote. */
  test("each crew route logs the step, vendor, model, reason and cost, and no text, prompt or key", async () => {
    finish = "length"; content = '{"logline": "CANARYANSWER reunites';
    const { projectId, headers } = await project();
    const read = await (await fetch(`${base}/api/projects/${projectId}/crew/read-through`, { method: "POST", headers, body: JSON.stringify({ format: "reel", tone: "CANARYTONE" }) })).json() as Record<string, unknown>;
    expect(read).toMatchObject({ source: "stand-in", fallbackReason: "model_unusable", unusableReason: "cut_off" });
    const planned = await (await fetch(`${base}/api/projects/${projectId}/crew/plan`, { method: "POST", headers,
      body: JSON.stringify({ format: "reel", tone: "quiet", answers: [], expected: { scriptVersion: 1, castingVersion: 0, directionVersion: 0 } }) })).json() as Record<string, unknown>;
    expect(planned).toMatchObject({ source: "stand-in", fallbackReason: "model_unusable", unusableReason: "cut_off" });
    const notes = await (await fetch(`${base}/api/projects/${projectId}/crew/line-notes`, { method: "POST", headers, body: JSON.stringify({}) })).json() as Record<string, unknown>;
    expect(notes).toMatchObject({ source: "stand-in", fallbackReason: "model_unusable", unusableReason: "cut_off" });
    const logged = unusable();
    expect(logged.map(line => [line.level, line.step, line.vendor, line.model, line.reason, line.costUsd, line.projectId])).toEqual(["read-through", "plan", "line-notes"]
      .map(step => ["warn", step, "openrouter", "openrouter:anthropic/claude-sonnet-5.5", "cut_off", 0.022, projectId]));
    for (const line of logged) expect(line.dropped).toBeUndefined();
    const all = lines.join("\n");
    for (const canary of ["CANARYANSWER", "CANARYKETTLE", "CANARYTONE", "CANARYKEY"]) expect(all).not.toContain(canary);
  });

  /** A usable answer logs nothing; an answer the studio couldn't read logs the studio's reason. */
  test("a usable answer logs nothing, and a refused one logs gate_refused", async () => {
    finish = "stop";
    content = JSON.stringify({ logline: "Two people reunite over tea.", summary: "A quiet reunion.", questions: [{ persona: "director", question: "Hopeful?", proposal: "Yes." }] });
    const before = unusable().length;
    const { projectId, headers } = await project();
    const ask = async () => await (await fetch(`${base}/api/projects/${projectId}/crew/read-through`, { method: "POST", headers, body: JSON.stringify({ format: "reel", tone: "" }) })).json() as Record<string, unknown>;
    expect(await ask()).toMatchObject({ source: "openrouter", dropped: 0 });
    expect(unusable().length).toBe(before);
    content = JSON.stringify({ logline: "A portrait of Taylor Swift.", summary: "A quiet reunion.", questions: [{ persona: "director", question: "Hopeful?", proposal: "Yes." }] });
    expect(await ask()).toMatchObject({ source: "stand-in", unusableReason: "gate_refused" });
    expect(unusable().slice(before).map(line => [line.step, line.reason])).toEqual([["read-through", "gate_refused"]]);
    expect(lines.join("\n")).not.toContain("Taylor Swift");
  });

  /** The log schema takes the four fields only from closed sets: free text in any of them is dropped and counted. */
  test("the log schema keeps only closed values for step, vendor, model and reason", () => {
    expect(EVENTS.has("crew.answer_unusable")).toBe(true);
    for (const key of ["step", "vendor", "model", "reason"]) expect(LOG_KEYS.has(key)).toBe(true);
    const valid: LogFields = { step: "plan", vendor: "synthetic", model: "synthetic:hf:moonshotai/Kimi-K3", reason: "unknown_persona", costUsd: 0 };
    expect(safeLogFields({ ...valid })).toEqual({ fields: valid, dropped: 0 });
    const free = { step: "the read-through", vendor: "acme", model: "the model said: no", reason: "The crew model declined to answer." };
    expect(safeLogFields(free)).toEqual({ fields: {}, dropped: 4 });
  });
});
