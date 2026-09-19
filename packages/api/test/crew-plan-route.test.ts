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

  test("the look approval permits the crew's original characters in one version, only with the creator's attestation", async () => {
    const { projectId, headers } = await project();
    await plan(projectId, headers, { scriptVersion: 1, castingVersion: 0, directionVersion: 0 });
    const approve = (body: unknown) => fetch(`${base}/api/projects/${projectId}/crew/approve-cast`, { method: "POST", headers, body: JSON.stringify(body) });
    expect((await approve({ attested: false, expectedVersion: 1 })).status).toBeGreaterThanOrEqual(400);
    expect((await approve({ attested: true })).status).toBe(400);
    expect((await approve({ attested: true, expectedVersion: 0 })).status).toBe(409);
    const approved = await (await approve({ attested: true, expectedVersion: 1 })).json() as { casting: { version: number; characters: { permission: { status: string; attestedAt: string | null } }[] } };
    expect(approved.casting.version).toBe(2);
    expect(approved.casting.characters.every(character => character.permission.status === "permitted" && character.permission.attestedAt)).toBe(true);
    // Nothing pending: a second approval changes nothing.
    expect((await (await approve({ attested: true, expectedVersion: 2 })).json() as { casting: { version: number } }).casting.version).toBe(2);
  });

  test("the read-through reports the versions it answered", async () => {
    const { projectId, headers } = await project();
    const body = await (await fetch(`${base}/api/projects/${projectId}/crew/read-through`, { method: "POST", headers, body: JSON.stringify({ format: "reel", tone: "" }) })).json() as { expected: unknown };
    expect(body.expected).toEqual({ scriptVersion: 1, castingVersion: 0, directionVersion: 0 });
  });
});

test("the look approval never gives a real person's consent", async () => {
  const { ProjectService } = await import("../src/index");
  const { CAST_INPUT } = await import("../../../test/fixtures/casting");
  const service = new ProjectService(), owner = service.createAnonymousProject();
  service.editScript(owner.token, "INT. ROOM - DAY\n\nKevin waves.\n\nKEVIN\nHi.");
  const pendingSelf = {...CAST_INPUT, name: "KEVIN", aliases: [], kind: "consented-real-person", permission: {status: "pending", scope: "project", sceneNumbers: [], expiresAt: null, attested: false}};
  service.saveCharacter(owner.token, crypto.randomUUID(), pendingSelf, 0);
  const result = service.permitPendingCast(owner.token, true, 1)!;
  expect(result.characters[0]!.permission.status).toBe("pending");
});

// HV-017-05: with a paid final pool the Editor holds each shot to what the provider bills.
test("the plan paces shots to a paid final pool, and leaves mock timing alone", async () => {
  const keys = ["HV_PROVIDER_PRIMARY", "HV_PROVIDER_SECONDARY"] as const, saved = keys.map(key => process.env[key]);
  const durations = async (id: string, headers: Record<string, string>) =>
    ((await (await fetch(`${base}/api/projects/${id}/direction`, { headers })).json()) as { direction: { entries: { settings: { durationFrames: number | null } }[] } })
      .direction.entries.map(entry => entry.settings.durationFrames);
  try {
    process.env.HV_PROVIDER_PRIMARY = process.env.HV_PROVIDER_SECONDARY = "fal:kling-v2.5-turbo-pro";
    const paid = await project();
    const body = await (await plan(paid.projectId, paid.headers, { scriptVersion: 1, castingVersion: 0, directionVersion: 0 })).json() as { notes: { persona: string; change: string }[] };
    expect(await durations(paid.projectId, paid.headers)).toEqual([150, 150]);
    expect(body.notes.find(note => note.persona === "editor" && note.change.startsWith("Held each shot"))).toBeDefined();
    process.env.HV_PROVIDER_PRIMARY = process.env.HV_PROVIDER_SECONDARY = "mock";
    const free = await project();
    await plan(free.projectId, free.headers, { scriptVersion: 1, castingVersion: 0, directionVersion: 0 });
    expect(await durations(free.projectId, free.headers)).toEqual([null, null]);
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
  }
});
