import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CrewModel } from "../../generator/src/crew-model";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { createApiServer } from "../src/server";

// HV-030-01: POST /api/projects/:id/crew/read-through, the crew's first answer to a script.
const root = `/tmp/hv-crew-route-${Date.now()}`;
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };
const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea.\n\nMAYA\nYou came back.";
const ledger = new CrewLedger();
let calls = 0;
const model: CrewModel = {name: "anthropic", model: "claude-sonnet-5", async complete() {
  calls++;
  return {text: JSON.stringify({logline: "A reunion over tea.", summary: "One quiet scene.", questions: [{persona: "director", question: "Hopeful ending?", proposal: "Yes."}]}),
    usage: {inputTokens: 900, outputTokens: 200}, model: "claude-sonnet-5", costUsd: 0.0038};
}};
const servers: ReturnType<typeof createApiServer>[] = [];
let live: string, standIn: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  const common = { port: 0, hostname: "127.0.0.1", frontendOrigin: "https://staging.example.test", rateLimit: generous };
  servers.push(createApiServer({ ...common, queuePath: `${root}/a/jobs.json`, artifactRoot: `${root}/a/artifacts`, statePath: `${root}/a/projects.json`, costLedgerPath: `${root}/a/cost.json`, crewLedger: ledger, crewModel: model }));
  servers.push(createApiServer({ ...common, queuePath: `${root}/b/jobs.json`, artifactRoot: `${root}/b/artifacts`, statePath: `${root}/b/projects.json`, costLedgerPath: `${root}/b/cost.json`, crewModel: null }));
  [live, standIn] = servers.map(server => `http://127.0.0.1:${server.port}`) as [string, string];
});
afterAll(() => { for (const server of servers) server.stop(true); });

async function project(base: string, script = SCRIPT) {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: script }) });
  return { ...created, headers };
}
const readThrough = (base: string, id: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${base}/api/projects/${id}/crew/read-through`, { method: "POST", headers, body: JSON.stringify(body) });

describe("the read-through route", () => {
  test("answers with the crew's voice and the studio's facts, and meters the spend", async () => {
    const { projectId, headers } = await project(live);
    const response = await readThrough(live, projectId, headers, { format: "reel", tone: "warm" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as { source: string; logline: string; facts: { characters: string[] }; crewSpend: { usd: number } };
    expect(body).toMatchObject({ source: "anthropic", logline: "A reunion over tea.", facts: { characters: ["MAYA"] }, crewSpend: { usd: 0.0038 } });
    expect(ledger.summary().spentUsd).toBeGreaterThanOrEqual(0.0038);
  });

  test("without a key the stand-in crew answers and nothing is spent", async () => {
    const { projectId, headers } = await project(standIn);
    const body = await (await readThrough(standIn, projectId, headers, { format: "short", tone: "" })).json() as { source: string; questions: unknown[]; crewSpend: { usd: number } };
    expect(body.source).toBe("stand-in");
    expect(body.questions.length).toBeGreaterThan(0);
    expect(body.crewSpend.usd).toBe(0);
  });

  test("only the project's owner may ask, and only with a valid format", async () => {
    const { projectId, headers } = await project(live);
    const other = await project(live);
    expect((await readThrough(live, projectId, { "content-type": "application/json" }, { format: "reel", tone: "" })).status).toBe(401);
    expect((await readThrough(live, projectId, other.headers, { format: "reel", tone: "" })).status).toBe(401);
    expect((await readThrough(live, projectId, headers, { format: "feature", tone: "" })).status).toBe(400);
  });

  test("a script naming a public figure is flagged and never sent to the model", async () => {
    const before = calls;
    const { projectId, headers } = await project(live, "INT. STAGE - NIGHT\n\nTaylor Swift sings.");
    const body = await (await readThrough(live, projectId, headers, { format: "reel", tone: "" })).json() as { facts: { concerns: { kind: string }[] } };
    expect(body.facts.concerns.map(concern => concern.kind)).toContain("public_figure");
    expect(calls).toBe(before);
  });

  test("at the ceiling the crew stops with 429", async () => {
    ledger.record({ at: new Date().toISOString(), projectId: "p0", persona: "producer", model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, usd: 1000 });
    const { projectId, headers } = await project(live);
    const response = await readThrough(live, projectId, headers, { format: "reel", tone: "" });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ reason: "crew_budget" });
  });
});
