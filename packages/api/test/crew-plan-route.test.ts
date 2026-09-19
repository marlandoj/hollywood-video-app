import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { createApiServer } from "../src/server";

// HV-030-02: POST /api/projects/:id/crew/plan -- the crew applies the creator's answers.
const root = `/tmp/hv-crew-plan-${Date.now()}`;
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };
const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - NIGHT\n\nLeo waits in the rain.\n\nLEO\nI never left.";
const ledger = new CrewLedger();
let server: ReturnType<typeof createApiServer>, base: string;
beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath: `${root}/jobs.json`, artifactRoot: `${root}/artifacts`, statePath: `${root}/projects.json`,
    costLedgerPath: `${root}/cost.json`, frontendOrigin: "https://staging.example.test", rateLimit: generous, crewLedger: ledger, crewModel: null });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function project() {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: SCRIPT }) });
  return { ...created, headers };
}
const plan = (id: string, headers: Record<string, string>, expected: Record<string, number>, answers: unknown[] = []) =>
  fetch(`${base}/api/projects/${id}/crew/plan`, { method: "POST", headers, body: JSON.stringify({ format: "reel", tone: "quiet", answers, expected }) });
const cast = async (id: string, headers: Record<string, string>) => (await (await fetch(`${base}/api/projects/${id}/cast`, { headers })).json()) as { casting: { version: number; characters: { name: string; permission: { status: string } }[] } };

describe("the crew applies its plan", () => {
  test("one new cast version and one new direction version; cast waits for permission", async () => {
    const { projectId, headers } = await project();
    const response = await plan(projectId, headers, { scriptVersion: 1, castingVersion: 0, directionVersion: 0 },
      [{ id: "q1", persona: "director", question: "Hopeful ending?", proposal: "Yes.", accepted: true }]);
    expect(response.status).toBe(200);
    const body = await response.json() as { source: string; castingVersion: number; directionVersion: number; addedCharacters: number; directedShots: number; notes: { persona: string }[] };
    expect(body).toMatchObject({ source: "stand-in", castingVersion: 1, directionVersion: 1, addedCharacters: 2 });
    expect(body.directedShots).toBeGreaterThan(0);
    expect(body.notes.map(note => note.persona)).toContain("cinematographer");
    const current = await cast(projectId, headers);
    expect(current.casting.characters.map(character => [character.name, character.permission.status])).toEqual([["MAYA", "pending"], ["LEO", "pending"]]);
  });

  test("a second pass changes nothing the first set, and stale versions are refused", async () => {
    const { projectId, headers } = await project();
    await plan(projectId, headers, { scriptVersion: 1, castingVersion: 0, directionVersion: 0 });
    expect((await plan(projectId, headers, { scriptVersion: 1, castingVersion: 0, directionVersion: 0 })).status).toBe(409);
    const again = await (await plan(projectId, headers, { scriptVersion: 1, castingVersion: 1, directionVersion: 1 })).json() as { addedCharacters: number; directedShots: number; castingVersion: number; directionVersion: number };
    expect(again).toMatchObject({ addedCharacters: 0, directedShots: 0, castingVersion: 1, directionVersion: 1 });
  });

  test("owner only, and malformed answers are refused", async () => {
    const { projectId, headers } = await project();
    const other = await project();
    expect((await plan(projectId, other.headers, { scriptVersion: 1, castingVersion: 0, directionVersion: 0 })).status).toBe(401);
    expect((await plan(projectId, headers, { scriptVersion: 1, castingVersion: 0, directionVersion: 0 }, [{ id: "q1", persona: "gaffer", question: "?", proposal: "", accepted: true }])).status).toBe(400);
    expect((await fetch(`${base}/api/projects/${projectId}/crew/plan`, { method: "POST", headers, body: JSON.stringify({ format: "reel", tone: "", answers: [] }) })).status).toBe(400);
  });

  test("at the crew's ceiling a live crew would stop; the stand-in spends nothing", async () => {
    const { projectId, headers } = await project();
    ledger.record({ at: new Date().toISOString(), projectId: "p0", persona: "producer", model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, usd: 1000 });
    const body = await (await plan(projectId, headers, { scriptVersion: 1, castingVersion: 0, directionVersion: 0 })).json() as { crewSpend: { usd: number } };
    expect(body.crewSpend.usd).toBe(0);
  });
});
