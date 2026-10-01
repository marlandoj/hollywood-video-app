import {createHash} from "node:crypto";
import {checkPrompt, type SafetyVerdict} from "../../safety/src/index";
import {musicCueHoldUsd} from "../../operator/src/music-vendor-budget";
import type {MusicCueRecord, MusicLineLedger} from "../../operator/src/music-ledger";
import {MusicProviderError, musicCueCostUsd, validateMusicCueRequest, type MusicCueDelivery, type MusicProvider} from "../../generator/src/music-provider";

/**
 * HV-024-11: one generated music cue, admitted against the music line (G15) -- the order is the point.
 *
 * 1. **No vendor, no cue.** Without a music provider the Composer writes its own score, and this
 *    says so rather than pretending to have made music.
 * 2. **The prompt meets the safety gate before anything is reserved.** A refusal stores nothing and
 *    holds nothing: the ledger is not touched.
 * 3. **The hold is reserved** in one transaction (or under one pair of file locks): against the
 *    $10 lifetime music line, the film's limit and the month's generation cap. Each refuses in its
 *    house wording; the line decides the $3 and $7 alerts.
 * 4. **One request.** A provider that failed before sending releases the hold; one that may have
 *    sent records its cost at the hold, unreconciled, until the operator reconciles it.
 * 5. **The cost is the hold**: the vendor bills the length asked for (`music_length_ms`), so a cue
 *    that came back shorter costs no less, and nothing costs more. It is settled whether or not the
 *    cue can then be kept, because the vendor was paid either way.
 *
 * A cue's id comes from its film and its request key, so a retried request finds its own cue. A cue
 * still "held" long after any request could have finished -- the process stopped between reserving
 * and settling -- is recorded as unreconciled when it is asked for again, and the retry is told so.
 */
export class MusicUnavailable extends Error { override name = "MusicUnavailable"; }
export class MusicRefused extends Error {
  override name = "SafetyRefusal";
  constructor(readonly safety: SafetyVerdict) {
    super("We can't make this music: its description names a real person or falls outside the content policy. Reword it and ask again -- nothing was stored or reserved.");
  }
}
export class MusicCueFailed extends Error { override name = "MusicCueFailed"; }
/** A request key whose cue is in flight, stuck or spent: not a budget refusal, and never tagged as one. */
export class MusicCueConflict extends Error { override name = "MusicCueConflict"; }
/** The live adapter gives up after four minutes; past ten, a held cue's request cannot still be running. */
export const MUSIC_CUE_STALE_MS = 10 * 60_000;

export const MUSIC_UNAVAILABLE = "Generated music is not enabled on this studio, so the Composer writes its own score.";

/** What the studio says about music, wherever it is asked. */
export function musicStatus(provider: MusicProvider | undefined): {generated: boolean; provider: string | null; note: string} {
  return provider ? {generated: true, provider: provider.name, note: "The Composer can ask " + (provider.name === "elevenlabs" ? "ElevenLabs Music" : "the " + provider.name + " music adapter") + " for a cue, within the studio's music line."}
    : {generated: false, provider: null, note: MUSIC_UNAVAILABLE};
}

/** The gate, as the sound library reads creator text: alone, then with its whitespace collapsed. */
export function gateMusicPrompt(prompt: string): void {
  const verdict = checkPrompt(prompt), folded = verdict.allowed ? checkPrompt(prompt.replace(/\s+/g, " ")) : verdict;
  if (!folded.allowed) throw new MusicRefused(folded);
}

export const musicCueId = (projectId: string, key: string) => "music-" + createHash("sha256").update(projectId + "\n" + key).digest("hex").slice(0, 32);

export interface MusicCueDeps {
  provider: MusicProvider | undefined;
  ledger: MusicLineLedger;
  capUsd: number;
  /** The month's generation cap and the film's limit, which a cue's hold also counts against. */
  monthlyCapUsd: number;
  filmCapUsd?: number;
  /** The film's jobs, for the file store's film limit; PostgreSQL reads them itself. */
  filmJobIds?: () => Promise<ReadonlySet<string>>;
  /** Keeps the delivered cue in the film's sound library and answers the new asset's id. */
  keep(delivery: MusicCueDelivery, label: string, rights: MusicProvider["rights"] & {attested: true}): Promise<string>;
  now?: () => number;
}
export interface MusicCueInput {projectId: string; idempotencyKey: unknown; prompt: unknown; durationSec: unknown; seed?: unknown}
export interface MusicCueResult {cue: MusicCueRecord; assetId: string; replay: boolean; credit: string}

export async function generateMusicCue(deps: MusicCueDeps, input: MusicCueInput, signal?: AbortSignal): Promise<MusicCueResult> {
  const provider = deps.provider;
  if (!provider) throw new MusicUnavailable(MUSIC_UNAVAILABLE);
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.idempotencyKey)) throw new Error("Include a request key of up to 128 letters, digits, dots, colons, dashes or underscores.");
  const request = validateMusicCueRequest({prompt: input.prompt, durationSec: input.durationSec, seed: input.seed ?? 0});
  gateMusicPrompt(request.prompt);
  const id = musicCueId(input.projectId, input.idempotencyKey), heldUsd = musicCueHoldUsd(request.durationSec);
  const now = deps.now?.() ?? Date.now();
  const reservation = await deps.ledger.reserve({id, projectId: input.projectId, provider: provider.name, model: provider.model, heldUsd, capUsd: deps.capUsd,
    monthlyCapUsd: deps.monthlyCapUsd, filmCapUsd: deps.filmCapUsd, filmJobIds: await deps.filmJobIds?.(), now});
  if (reservation.replay) {
    let cue = reservation.cue;
    if (cue.status === "settled" && cue.assetId) return {cue, assetId: cue.assetId, replay: true, credit: provider.rights.credit};
    if (cue.status === "held" && now - Date.parse(cue.at) <= MUSIC_CUE_STALE_MS) throw new MusicCueConflict("This cue is still being made. Try again shortly.");
    if (cue.status === "held") {
      cue = await deps.ledger.markUnreconciled(id);
      throw new MusicCueConflict("This cue's request started at " + cue.at + " and never finished, so it may have been charged. Its cost is now counted at its hold ($"
        + cue.heldUsd.toFixed(2) + ") until the operator reconciles it. Ask again with a new request key.");
    }
    throw new MusicCueConflict(cue.status === "released" ? "This cue's request was never sent. Ask again with a new request key."
      : cue.status === "unreconciled" ? "This cue's request may have been charged and did not return a cue. Its cost is counted at its hold until the operator reconciles it; ask again with a new request key."
      : "This cue was charged but could not be kept in the sound library. Ask again with a new request key.");
  }
  let delivery: MusicCueDelivery;
  try { delivery = await provider.compose(request, signal); }
  catch (error) {
    const sent = !(error instanceof MusicProviderError) || error.dispatched;
    if (sent) await deps.ledger.markUnreconciled(id); else await deps.ledger.release(id);
    throw new MusicCueFailed(sent ? "The music provider did not return a usable cue (" + (error as Error).message + "). The request may have been charged, so its cost is counted at its hold until the operator reconciles it."
      : "The music request was not sent (" + (error as Error).message + "), so its hold was released.");
  }
  const costUsd = musicCueCostUsd(request.durationSec, heldUsd);
  let assetId: string;
  try { assetId = await deps.keep(delivery, "Composer music cue " + id.slice(6, 14), {...provider.rights, attested: true}); }
  catch (error) {
    await deps.ledger.settle(id, costUsd, null);
    throw new MusicCueFailed("The cue was made and charged $" + costUsd.toFixed(2) + ", but could not be kept in the sound library (" + (error as Error).message + ").");
  }
  const cue = await deps.ledger.settle(id, costUsd, assetId);
  return {cue, assetId, replay: false, credit: provider.rights.credit};
}
