// HV-024-11: the Composer's generated cue, through the studio's own route, with the mock music
// adapter and the file ledger. What is proved is the order the route keeps: no vendor answers
// honestly; the prompt meets the safety gate before anything is reserved; the hold is reserved
// against the music line and refused past it in the house wording; a failed request releases or
// keeps its hold by whether it was sent; the cue is kept in the sound library and settled at its
// probed cost; and the $3 alert reaches the operator's log -- read, not just computed (HV-022-13).
import {expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {MUSIC_UNAVAILABLE, musicCueId} from "../src/music-cues";
import {MusicLedger} from "../../operator/src/music-ledger";
import {MockMusicProvider, type MusicCueRequest, type MusicProvider} from "../../generator/src/music-provider";
import {StudioLogger} from "../../observability/src/logs";

const SECRET = "music-cue-fixture-secret-at-least-thirty-two-characters";

async function studio(provider: MusicProvider | null) {
  const root = mkdtempSync(join(tmpdir(), "hv-music-cues-")), lines: Record<string, unknown>[] = [], ledger = new MusicLedger(join(root, "music-ledger.json"));
  const prior = process.env.HV_TOKEN_SECRET; process.env.HV_TOKEN_SECRET = SECRET;
  const logger = new StudioLogger({service: "api", write: (_level, line) => lines.push(JSON.parse(line))});
  const server = createApiServer({port: 0, hostname: "127.0.0.1", statePath: join(root, "projects.json"), queuePath: join(root, "jobs.json"), costLedgerPath: join(root, "ledger.json"),
    artifactRoot: join(root, "media"), rateLimit: {api: {limit: 1000, windowMs: 60000}}, musicProvider: provider, musicLedger: ledger, logger});
  const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
    headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId;
  const cue = (body: Record<string, unknown>) => call(base + "/music-cues", "POST", body, owner.token);
  const library = async () => (await (await call(base + "/sounds", "GET", undefined, owner.token)).json() as {library: {version: number; assets: {id: string; rights: {source: string}}[]}; music: unknown});
  const stop = async () => { await server.stop(true); rmSync(root, {recursive: true, force: true}); if (prior === undefined) delete process.env.HV_TOKEN_SECRET; else process.env.HV_TOKEN_SECRET = prior; };
  return {call, owner, base, cue, library, ledger, lines, stop};
}

/** Without a music vendor the studio says so wherever it is asked, and the route reserves nothing. */
test("with no music provider the studio says the Composer writes its own score, and a cue request reserves nothing", async () => {
  const s = await studio(null);
  try {
    await s.call(s.base + "/rights", "POST", {attested: true}, s.owner.token);
    expect((await s.library()).music).toEqual({generated: false, provider: null, note: MUSIC_UNAVAILABLE});
    const response = await s.cue({idempotencyKey: "k", prompt: "A calm cue", durationSec: 30});
    expect(response.status).toBe(409);
    expect(((await response.json()) as {error: string}).error).toBe(MUSIC_UNAVAILABLE);
    expect(s.ledger.summary().committedUsd).toBe(0);
  } finally { await s.stop(); }
}, 30000);

/** The route's whole order, on one film. */
test("a generated cue is gated, reserved against the music line, kept in the library and settled, and the $3 alert is logged", async () => {
  let mode: "ok" | "before-dispatch" | "after-dispatch" = "ok";
  const ok = new MockMusicProvider(), requests: MusicCueRequest[] = [];
  const provider: MusicProvider = {name: ok.name, model: ok.model, rights: ok.rights,
    compose: (request, signal) => { requests.push(request); return mode === "ok" ? ok.compose(request, signal) : new MockMusicProvider({fail: mode}).compose(request, signal); }};
  const s = await studio(provider);
  const id = (key: string) => musicCueId(s.owner.projectId, key);
  try {
    expect((await s.library()).music).toMatchObject({generated: true, provider: "mock"});
    // Rights not yet confirmed: refused before anything is reserved.
    expect((await s.cue({idempotencyKey: "early", prompt: "A calm cue", durationSec: 60})).status).toBe(400);
    expect(s.ledger.cue(id("early"))).toBeUndefined();
    await s.call(s.base + "/rights", "POST", {attested: true}, s.owner.token);

    // The safety gate, before the ledger: nothing reserved, nothing asked, nothing kept.
    for (const prompt of ["A theme in the style of Taylor Swift", "An anthem for Harry\nPotter fans"]) {
      const refused = await s.cue({idempotencyKey: "refused", prompt, durationSec: 60});
      expect(refused.status).toBe(422);
      const body = await refused.json() as {reason: string; error: string};
      expect(body.reason).toBe("content_policy");
      expect(body.error).toContain("nothing was stored or reserved");
    }
    expect(s.ledger.cue(id("refused"))).toBeUndefined();
    expect(requests).toHaveLength(0);
    expect((await s.library()).library.assets).toEqual([]);

    // Someone else's cues have taken the month to $2.90; this one crosses $3.
    s.ledger.reserve({id: "elsewhere", projectId: "another-film", provider: "mock", model: "mock-music/1", heldUsd: 2.9, capUsd: 10});
    const made = await s.cue({idempotencyKey: "k1", prompt: "Slow instrumental underscore in a minor key", durationSec: 60});
    expect(made.status).toBe(201);
    const result = await made.json() as {asset: {id: string; rights: {source: string; basis: string}}; credit: string; cue: {status: string; heldUsd: number; actualUsd: number}};
    expect(result.cue).toMatchObject({status: "settled", heldUsd: 0.15, actualUsd: 0.15});
    expect(result.asset.rights).toMatchObject({basis: "original", source: ok.rights.source});
    expect(result.credit).toBe("Composer (AI crew), mock music adapter");
    expect((await s.library()).library.assets.map(asset => asset.id)).toEqual([result.asset.id]);
    expect(s.ledger.cue(id("k1"))).toMatchObject({status: "settled", actualUsd: 0.15, assetId: result.asset.id, alerts: [3]});
    // Read, not just computed: the warning is a log line under the name the log's closed set admits.
    const alerts = s.lines.filter(line => line.event === "music.budget_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({level: "warn", service: "api", event: "music.budget_alert", provider: "mock", costUsd: 3.05});
    expect(s.lines.some(line => line.event === "log.dropped")).toBe(false);

    // A retried request is the same cue: no second request, no second charge, no second alert.
    const again = await s.cue({idempotencyKey: "k1", prompt: "Slow instrumental underscore in a minor key", durationSec: 60});
    expect(again.status).toBe(200);
    expect(((await again.json()) as {asset: {id: string}}).asset.id).toBe(result.asset.id);
    expect(requests).toHaveLength(1);
    expect(s.ledger.summary().committedUsd).toBe(3.05);

    // Never sent: the hold is released. Possibly sent: the hold stays, unreconciled.
    mode = "before-dispatch";
    expect((await s.cue({idempotencyKey: "k2", prompt: "A calm cue", durationSec: 60})).status).toBe(502);
    expect(s.ledger.cue(id("k2"))?.status).toBe("released");
    mode = "after-dispatch";
    const lost = await s.cue({idempotencyKey: "k3", prompt: "A calm cue", durationSec: 60});
    expect(lost.status).toBe(502);
    expect(((await lost.json()) as {error: string}).error).toContain("its hold is kept until the operator reconciles it");
    expect(s.ledger.cue(id("k3"))?.status).toBe("unreconciled");
    expect(s.ledger.summary().committedUsd).toBe(3.2);
    expect((await s.library()).library.assets).toHaveLength(1);

    // Past the line: the house refusal, and nothing asked of the vendor.
    mode = "ok";
    s.ledger.reserve({id: "elsewhere-2", projectId: "another-film", provider: "mock", model: "mock-music/1", heldUsd: 6.75, capUsd: 10});
    const before = requests.length, over = await s.cue({idempotencyKey: "k4", prompt: "A calm cue", durationSec: 60});
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({error: "The mock music line has reached its limit of $10.00 ($9.95 spent or held). Ask the studio operator to raise it.", reason: "budget_exhausted"});
    expect(requests).toHaveLength(before);
    expect(s.ledger.cue(id("k4"))).toBeUndefined();
    expect(s.lines.filter(line => line.event === "music.budget_alert").map(line => line.costUsd)).toEqual([3.05, 9.95]);
  } finally { await s.stop(); }
}, 60000);
