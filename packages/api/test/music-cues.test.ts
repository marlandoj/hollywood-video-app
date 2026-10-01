// HV-024-11: the Composer's generated cue, through the studio's own route, with the mock music
// adapter and the file ledgers the studio builds for itself. What is proved is the order the route
// keeps: no vendor answers honestly; the prompt meets the safety gate before anything is reserved;
// the hold is reserved against the lifetime music line, the film's limit and the month's cap, each
// refusing in its house wording; a failed request releases its hold or records its cost by whether it
// was sent; the cue is kept in the sound library and settled at its hold, which the film's spend and
// the month's rollup then show; a cue stuck "held" is answered honestly; and the $3 alert reaches the
// operator's log -- read, not just computed (HV-022-13).
import {expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {MUSIC_CUE_STALE_MS, MUSIC_UNAVAILABLE, MusicCueConflict, generateMusicCue, musicCueId} from "../src/music-cues";
import {CostLedger} from "../../operator/src/index";
import {MusicLedger} from "../../operator/src/music-ledger";
import {MockMusicProvider, type MusicCueRequest, type MusicProvider} from "../../generator/src/music-provider";
import {StudioLogger} from "../../observability/src/logs";

const SECRET = "music-cue-fixture-secret-at-least-thirty-two-characters";

async function studio(provider: MusicProvider | null) {
  const root = mkdtempSync(join(tmpdir(), "hv-music-cues-")), lines: Record<string, unknown>[] = [];
  const prior = process.env.HV_TOKEN_SECRET; process.env.HV_TOKEN_SECRET = SECRET;
  const logger = new StudioLogger({service: "api", write: (_level, line) => lines.push(JSON.parse(line))});
  const costLedgerPath = join(root, "ledger.json"), musicPath = join(root, "music-ledger.json");
  const server = createApiServer({port: 0, hostname: "127.0.0.1", statePath: join(root, "projects.json"), queuePath: join(root, "jobs.json"), costLedgerPath,
    artifactRoot: join(root, "media"), rateLimit: {api: {limit: 1000, windowMs: 60000}}, musicProvider: provider, logger});
  // The studio's own files, read and seeded through ledgers of their own: what another process would see.
  const costs = () => new CostLedger(costLedgerPath), ledger = () => new MusicLedger(musicPath, costs());
  const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
    headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const film = async () => {
    const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string};
    const base = "/api/projects/" + owner.projectId;
    return {owner, base, cue: (body: Record<string, unknown>) => call(base + "/music-cues", "POST", body, owner.token),
      library: async () => (await (await call(base + "/sounds", "GET", undefined, owner.token)).json() as {library: {version: number; assets: {id: string; rights: {source: string}}[]}; music: unknown}),
      spend: async () => (await (await call(base + "/spend", "GET", undefined, owner.token)).json() as {spentUsd: number; heldUsd: number; capUsd: number}),
      attest: () => call(base + "/rights", "POST", {attested: true}, owner.token)};
  };
  const stop = async () => { await server.stop(true); rmSync(root, {recursive: true, force: true}); if (prior === undefined) delete process.env.HV_TOKEN_SECRET; else process.env.HV_TOKEN_SECRET = prior; };
  return {call, film, costs, ledger, lines, stop};
}
const seed = (id: string, projectId: string, heldUsd: number) => ({id, projectId, provider: "mock", model: "mock-music/1", heldUsd, capUsd: 10, monthlyCapUsd: 5000});

/** Without a music vendor the studio says so wherever it is asked, and the route reserves nothing. */
test("with no music provider the studio says the Composer writes its own score, and a cue request reserves nothing", async () => {
  const s = await studio(null);
  try {
    const f = await s.film();
    await f.attest();
    expect((await f.library()).music).toEqual({generated: false, provider: null, note: MUSIC_UNAVAILABLE});
    const response = await f.cue({idempotencyKey: "k", prompt: "A calm cue", durationSec: 30});
    expect(response.status).toBe(409);
    expect(((await response.json()) as {error: string}).error).toBe(MUSIC_UNAVAILABLE);
    expect(s.ledger().summary().committedUsd).toBe(0);
    expect(s.costs().reservedUsd()).toBe(0);
  } finally { await s.stop(); }
}, 30000);

/** The route's whole order, on one film, then the film's limit and the month's cap on two more. */
test("a generated cue is gated, reserved against the line, the film and the month, kept, settled at its hold, and the $3 alert is logged", async () => {
  let mode: "ok" | "before-dispatch" | "after-dispatch" = "ok";
  const ok = new MockMusicProvider(), requests: MusicCueRequest[] = [];
  const provider: MusicProvider = {name: ok.name, model: ok.model, rights: ok.rights,
    compose: (request, signal) => { requests.push(request); return mode === "ok" ? ok.compose(request, signal) : new MockMusicProvider({fail: mode}).compose(request, signal); }};
  const s = await studio(provider), f = await s.film();
  const id = (key: string) => musicCueId(f.owner.projectId, key);
  try {
    expect((await f.library()).music).toMatchObject({generated: true, provider: "mock"});
    // Rights not yet confirmed: refused before anything is reserved.
    expect((await f.cue({idempotencyKey: "early", prompt: "A calm cue", durationSec: 60})).status).toBe(400);
    expect(s.ledger().cue(id("early"))).toBeUndefined();
    await f.attest();

    // The safety gate, before the ledger: nothing reserved, nothing asked, nothing kept.
    for (const prompt of ["A theme in the style of Taylor Swift", "An anthem for Harry\nPotter fans"]) {
      const refused = await f.cue({idempotencyKey: "refused", prompt, durationSec: 60});
      expect(refused.status).toBe(422);
      const body = await refused.json() as {reason: string; error: string};
      expect(body.reason).toBe("content_policy");
      expect(body.error).toContain("nothing was stored or reserved");
    }
    expect(s.ledger().cue(id("refused"))).toBeUndefined();
    expect(s.costs().reservedUsd()).toBe(0);
    expect(requests).toHaveLength(0);
    expect((await f.library()).library.assets).toEqual([]);

    // Other films' cues have taken the line to $2.90; this one crosses $3.
    s.ledger().reserve(seed("elsewhere", "another-film", 2.9));
    const made = await f.cue({idempotencyKey: "k1", prompt: "Slow instrumental underscore in a minor key", durationSec: 60});
    expect(made.status).toBe(201);
    const result = await made.json() as {asset: {id: string; rights: {source: string; basis: string}}; credit: string; cue: {status: string; heldUsd: number; actualUsd: number}};
    expect(result.cue).toMatchObject({status: "settled", heldUsd: 0.15, actualUsd: 0.15});
    expect(result.asset.rights).toMatchObject({basis: "original", source: ok.rights.source});
    expect(result.credit).toBe("Composer (AI crew), mock music adapter");
    expect((await f.library()).library.assets.map(asset => asset.id)).toEqual([result.asset.id]);
    expect(s.ledger().cue(id("k1"))).toMatchObject({status: "settled", actualUsd: 0.15, assetId: result.asset.id, alerts: [3]});
    // Read, not just computed: the warning is a log line under the name the log's closed set admits.
    const alerts = s.lines.filter(line => line.event === "music.budget_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({level: "warn", service: "api", event: "music.budget_alert", provider: "mock", costUsd: 3.05});
    expect(s.lines.some(line => line.event === "log.dropped")).toBe(false);
    // Generation spend, where the film and the operator look for it.
    expect(await f.spend()).toMatchObject({spentUsd: 0.15, heldUsd: 0});
    expect(s.costs().rollup("month").byProvider).toEqual({mock: 0.15});

    // A retried request is the same cue: no second request, no second charge, no second alert.
    const again = await f.cue({idempotencyKey: "k1", prompt: "Slow instrumental underscore in a minor key", durationSec: 60});
    expect(again.status).toBe(200);
    expect(((await again.json()) as {asset: {id: string}}).asset.id).toBe(result.asset.id);
    expect(requests).toHaveLength(1);
    expect(s.ledger().summary().committedUsd).toBe(3.05);

    // Never sent: the hold is released. Possibly sent: its cost is recorded at the hold, unreconciled.
    mode = "before-dispatch";
    expect((await f.cue({idempotencyKey: "k2", prompt: "A calm cue", durationSec: 60})).status).toBe(502);
    expect(s.ledger().cue(id("k2"))?.status).toBe("released");
    mode = "after-dispatch";
    const lost = await f.cue({idempotencyKey: "k3", prompt: "A calm cue", durationSec: 60});
    expect(lost.status).toBe(502);
    expect(((await lost.json()) as {error: string}).error).toContain("its cost is counted at its hold until the operator reconciles it");
    expect(s.ledger().cue(id("k3"))).toMatchObject({status: "unreconciled", actualUsd: 0.15});
    expect(s.ledger().summary().committedUsd).toBe(3.2);
    expect(await f.spend()).toMatchObject({spentUsd: 0.3, heldUsd: 0});
    expect((await f.library()).library.assets).toHaveLength(1);

    // A cue another request is still making: a plain conflict, never a budget refusal.
    s.ledger().reserve(seed(id("k5"), f.owner.projectId, 0.15));
    const busy = await f.cue({idempotencyKey: "k5", prompt: "A calm cue", durationSec: 60});
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({error: "This cue is still being made. Try again shortly."});

    // Past the line: the house refusal, and nothing asked of the vendor.
    mode = "ok";
    s.ledger().reserve(seed("elsewhere-2", "another-film", 6.6));
    const before = requests.length, over = await f.cue({idempotencyKey: "k4", prompt: "A calm cue", durationSec: 60});
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({error: "The mock music line has reached its limit of $10.00 ($9.95 spent or held). Ask the studio operator to raise it.", reason: "budget_exhausted"});
    expect(requests).toHaveLength(before);
    expect(s.ledger().cue(id("k4"))).toBeUndefined();
    for (const seeded of ["elsewhere-2", id("k5")]) s.ledger().release(seeded);

    // The film's limit ($40 by default): this film has spent $39.90 on pictures.
    const full = await s.film();
    await full.attest();
    s.costs().record({eventId: "picture", at: new Date().toISOString(), projectId: full.owner.projectId, shotId: "s1", jobId: "picture-job", stage: "final", provider: "fal", model: "m",
      prompt_tokens: 0, output_frames: 0, gpu_seconds: 0, total_cost_usd: 39.9});
    const filmRefused = await full.cue({idempotencyKey: "f1", prompt: "A calm cue", durationSec: 60});
    expect(filmRefused.status).toBe(429);
    expect(((await filmRefused.json()) as {error: string}).error).toBe("This film has reached its spending limit of $40.00 ($39.90 spent or held). Shorten the film, or ask the studio operator to raise the limit.");
    expect(s.ledger().cue(musicCueId(full.owner.projectId, "f1"))).toBeUndefined();

    // The month's cap ($5,000 by default): every film's spend counts.
    const third = await s.film();
    await third.attest();
    s.costs().record({eventId: "month", at: new Date().toISOString(), projectId: "a-fourth-film", shotId: "s1", jobId: "month-job", stage: "final", provider: "fal", model: "m",
      prompt_tokens: 0, output_frames: 0, gpu_seconds: 0, total_cost_usd: 4959.9});
    const monthRefused = await third.cue({idempotencyKey: "m1", prompt: "A calm cue", durationSec: 60});
    expect(monthRefused.status).toBe(429);
    expect(((await monthRefused.json()) as {error: string}).error).toBe("generation capacity is reserved; try again when current jobs finish");
    expect(s.ledger().cue(musicCueId(third.owner.projectId, "m1"))).toBeUndefined();
    expect(requests).toHaveLength(before);
  } finally { await s.stop(); }
}, 60000);

/** A cue left "held" by a process that stopped between reserving and settling: still in flight for a while, then honestly unreconciled. */
test("a cue stuck held past the vendor's timeout is recorded as unreconciled when asked for again, and the retry is told so", async () => {
  const costs = new CostLedger(), ledger = new MusicLedger(undefined, costs), provider = new MockMusicProvider(), at = Date.parse("2026-10-01T09:00:00.000Z");
  const id = musicCueId("p1", "crew-music-cut1"), deps = (now: number) => ({provider, ledger, capUsd: 10, monthlyCapUsd: 5000, keep: async () => "asset", now: () => now});
  const input = {projectId: "p1", idempotencyKey: "crew-music-cut1", prompt: "calm", durationSec: 120};
  ledger.reserve({...seed(id, "p1", 0.3), now: at});
  const fresh = await generateMusicCue(deps(at + 60_000), input).catch(error => error);
  expect(fresh).toBeInstanceOf(MusicCueConflict);
  expect(fresh.message).toBe("This cue is still being made. Try again shortly.");
  expect(ledger.cue(id)?.status).toBe("held");
  const stuck = await generateMusicCue(deps(at + MUSIC_CUE_STALE_MS + 1), input).catch(error => error);
  expect(stuck).toBeInstanceOf(MusicCueConflict);
  expect(stuck.message).toBe("This cue's request started at 2026-10-01T09:00:00.000Z and never finished, so it may have been charged. Its cost is now counted at its hold ($0.30) until the operator reconciles it. Ask again with a new request key.");
  expect(ledger.cue(id)).toMatchObject({status: "unreconciled", actualUsd: 0.3});
  expect(costs.all().map(event => [event.jobId, event.total_cost_usd])).toEqual([[id, 0.3]]);
  expect(costs.reservedUsd()).toBe(0);
  expect(provider.requests).toHaveLength(0);
});
