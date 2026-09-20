import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { audioPolicy } from "../../planner/src/audio-jobs";
import { createApiServer } from "../src/server";

// HV-022-02: the crew's plan casts production voices in the same cast version as the cast.
const SCRIPT = "INT. LIGHTHOUSE - NIGHT\n\nNORA, the old keeper, trims the wick.\n\nNORA\nOne more night.\n\nEXT. CLIFF - DAWN\n\nHer grandson TEO climbs.\n\nTEO\nGrandma! You kept it burning!\n\nNORA\nAlways.";
const policy = (voiceId: string) => audioPolicy({provider: "azure", voiceId, label: voiceId + " (fixture)", accountRevision: "5".repeat(64), catalogueRevision: "6".repeat(64),
  licenceEvidenceSha256: "7".repeat(64), priceEvidenceSha256: "8".repeat(64), heldUsd: 0.0225, maxCharacters: 1500, validFrom: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z"});
const root = mkdtempSync(join(tmpdir(), "hv-crew-voices-"));
const servers: ReturnType<typeof createApiServer>[] = [];
afterAll(() => { for (const server of servers) server.stop(true); rmSync(root, { recursive: true, force: true }); });

function studio(name: string, audioPolicies: () => ReturnType<typeof policy>[]) {
  process.env.HV_TOKEN_SECRET = "crew-voices-fixture-secret-at-least-thirty-two-characters";
  const server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath: join(root, name, "jobs.json"), artifactRoot: join(root, name, "artifacts"),
    statePath: join(root, name, "projects.json"), costLedgerPath: join(root, name, "cost.json"), rateLimit: { api: { limit: 100000, windowMs: 60000 } },
    crewLedger: new CrewLedger(), crewModel: null, audioPolicies });
  servers.push(server);
  const base = server.url.origin;
  return async () => {
    const created = await (await fetch(base + "/api/projects", { method: "POST" })).json() as { projectId: string; token: string };
    const headers = { authorization: "Bearer " + created.token, "content-type": "application/json" }, path = base + "/api/projects/" + created.projectId;
    await fetch(path + "/script", { method: "PUT", headers, body: JSON.stringify({ text: SCRIPT }) });
    const plan = await (await fetch(path + "/crew/plan", { method: "POST", headers,
      body: JSON.stringify({ format: "reel", tone: "", answers: [], expected: { scriptVersion: 1, castingVersion: 0, directionVersion: 0 } }) })).json() as
      { castingVersion: number; voices: { name: string; voiceId: string }[]; notes: { persona: string; change: string }[] };
    const cast = await (await fetch(path + "/cast", { headers })).json() as { casting: { characters: { name: string; audioVoice?: { voice: { id: string } } }[] } };
    return { plan, cast };
  };
}

test("the plan casts each speaking role's voice in the same cast version, and says so", async () => {
  const { plan, cast } = await studio("voiced", () => [policy("en-US-JaneNeural"), policy("en-US-GuyNeural")])();
  expect(plan.castingVersion).toBe(1);
  expect(plan.voices.map(value => [value.name, value.voiceId])).toEqual([["NORA", "en-US-JaneNeural"], ["TEO", "en-US-GuyNeural"]]);
  expect(cast.casting.characters.map(character => [character.name, character.audioVoice?.voice.id])).toEqual([["NORA", "en-US-JaneNeural"], ["TEO", "en-US-GuyNeural"]]);
  expect(plan.notes.some(note => note.persona === "sound" && note.change.startsWith("Cast voices:"))).toBe(true);
});

test("with no authorized catalogue, or an unreadable one, the plan still works and casts no voice", async () => {
  for (const [name, policies] of [["none", () => []], ["broken", () => { throw new Error("unreadable policy file"); }]] as const) {
    const { plan, cast } = await studio(name, policies)();
    expect(plan.voices).toEqual([]);
    expect(cast.casting.characters.every(character => !character.audioVoice)).toBe(true);
  }
});
