import {createHash} from "node:crypto";
import {checkPrompt, type SafetyVerdict} from "../../safety/src/index";
import {BudgetError} from "../../operator/src/index";
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
 * 3. **The hold is reserved against the $10 line** inside the ledger's own transaction (or file
 *    lock), which refuses past the line in the house wording and decides the $3 and $7 alerts.
 * 4. **One request.** A provider that failed before sending releases the hold; one that may have
 *    sent keeps it counted, unreconciled, until the operator reconciles it.
 * 5. **The cost is ours** -- the probed length at the declared rate, never above the hold -- and it
 *    is settled whether or not the cue can then be kept, because the vendor was paid either way.
 *
 * A cue's id comes from its film and its request key, so a retried request finds its own cue.
 */
export class MusicUnavailable extends Error { override name = "MusicUnavailable"; }
export class MusicRefused extends Error {
  override name = "SafetyRefusal";
  constructor(readonly safety: SafetyVerdict) {
    super("We can't make this music: its description names a real person or falls outside the content policy. Reword it and ask again -- nothing was stored or reserved.");
  }
}
export class MusicCueFailed extends Error { override name = "MusicCueFailed"; }

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
  const reservation = await deps.ledger.reserve({id, projectId: input.projectId, provider: provider.name, model: provider.model, heldUsd, capUsd: deps.capUsd, now: deps.now?.()});
  if (reservation.replay) {
    const cue = reservation.cue;
    if (cue.status === "settled" && cue.assetId) return {cue, assetId: cue.assetId, replay: true, credit: provider.rights.credit};
    throw new BudgetError(cue.status === "held" ? "This cue is still being made. Try again shortly."
      : cue.status === "released" ? "This cue's request was never sent. Ask again with a new request key."
      : cue.status === "unreconciled" ? "This cue's request may have been charged and did not return a cue. Its hold stays until the operator reconciles it; ask again with a new request key."
      : "This cue was charged but could not be kept in the sound library. Ask again with a new request key.");
  }
  let delivery: MusicCueDelivery;
  try { delivery = await provider.compose(request, signal); }
  catch (error) {
    const sent = !(error instanceof MusicProviderError) || error.dispatched;
    if (sent) await deps.ledger.markUnreconciled(id); else await deps.ledger.release(id);
    throw new MusicCueFailed(sent ? "The music provider did not return a usable cue (" + (error as Error).message + "). The request may have been charged, so its hold is kept until the operator reconciles it."
      : "The music request was not sent (" + (error as Error).message + "), so its hold was released.");
  }
  const costUsd = musicCueCostUsd(delivery.durationSec, heldUsd);
  let assetId: string;
  try { assetId = await deps.keep(delivery, "Composer music cue " + id.slice(6, 14), {...provider.rights, attested: true}); }
  catch (error) {
    await deps.ledger.settle(id, costUsd, null);
    throw new MusicCueFailed("The cue was made and charged $" + costUsd.toFixed(2) + ", but could not be kept in the sound library (" + (error as Error).message + ").");
  }
  const cue = await deps.ledger.settle(id, costUsd, assetId);
  return {cue, assetId, replay: false, credit: provider.rights.credit};
}
