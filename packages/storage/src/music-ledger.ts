/**
 * HV-024-11: the music line's ledger, in PostgreSQL. The file ledger's interface and decisions
 * (`planMusicReservation`, `nextMusicCue` in packages/operator/src/music-ledger.ts), returning promises.
 *
 * A reservation is **one transaction under the cost ledger's own lock** (the operator budget row,
 * `lockWithin`), the same lock every generation admission takes:
 *
 * 1. the music line: every cue the studio has ever admitted, read across every film;
 * 2. the film's limit (`assertFilmWithin`), as an audio take's hold is checked;
 * 3. the month's generation cap, by admitting the hold as an ordinary reservation (`reserveWithin`,
 *    stage `music-cue`, the film's id and the vendor on it);
 * 4. the cue's own row.
 *
 * So concurrent admissions -- of cues or of anything else -- are decided one after another, and a
 * refusal at any step writes nothing. When a cue ends, the API marks it here; the worker's reconcile
 * (`postMusicCuesWithin` in ledger.ts) turns its cost into a cost event and ends its hold, because
 * the API role may neither write cost events nor end a hold.
 */
import type {SQL} from "bun";
import {BudgetError} from "../../operator/src/index";
import {monthlyBudgetCap} from "../../operator/src/dollar-setting";
import {MUSIC_COST_STAGE, nextMusicCue, planMusicReservation, summarizeMusicCues, validateMusicCueRecord, type MusicCueRecord, type MusicLineAlert, type MusicLineLedger,
  type MusicLineSummary, type MusicReservation, type MusicReserveInput} from "../../operator/src/music-ledger";
import type {StudioDatabase} from "./database";
import {PostgresCostLedger} from "./ledger";

function record(row: Record<string, unknown>): MusicCueRecord {
  // The alerts column is written as an array (see `alertsOf` in crew-ledger.ts); a string here is a
  // ledger written some other way, refused rather than parsed.
  if (!Array.isArray(row.alerts)) throw new BudgetError("The music ledger is unreadable; no cue is admitted until it is repaired.");
  return validateMusicCueRecord({id: String(row.id), projectId: String(row.project_id), at: new Date(String(row.at)).toISOString(),
    provider: String(row.provider), model: String(row.model), status: String(row.status), heldUsd: Number(row.held_usd),
    actualUsd: row.actual_usd === null ? null : Number(row.actual_usd), alerts: (row.alerts as unknown[]).map(Number), assetId: row.asset_id === null ? null : String(row.asset_id)});
}

/** The cost ledger's own lock and checks, lent to the music ledger rather than inherited, so `release` keeps one meaning. */
class MusicHolds extends PostgresCostLedger {
  within<T>(projectId: string, monthlyCapUsd: number, fn: (tx: SQL, storedCap: number) => Promise<T>): Promise<T> {
    return this.database.forProject(projectId, tx => this.lockWithin(tx, fn, monthlyCapUsd));
  }
  async admitWithin(tx: SQL, storedCap: number, cue: MusicCueRecord, input: MusicReserveInput, now: number): Promise<void> {
    await this.assertFilmWithin(tx, input.projectId, cue.heldUsd, input.filmCapUsd);
    await this.reserveWithin(tx, storedCap, cue.id, MUSIC_COST_STAGE, cue.heldUsd, input.monthlyCapUsd, new Date(now), input.projectId, input.provider);
  }
}

export class PostgresMusicLedger implements MusicLineLedger {
  onAlert?: (alert: MusicLineAlert) => void;
  private readonly holds: MusicHolds;
  constructor(private readonly database: StudioDatabase) { this.holds = new MusicHolds(database); }

  async reserve(input: MusicReserveInput): Promise<MusicReservation> {
    const now = input.now ?? Date.now();
    const result = await this.holds.within(input.projectId, input.monthlyCapUsd, async (tx, storedCap) => {
      const existing = (await tx`select * from hv_music_cues where id = ${input.id}`)[0];
      if (existing) {
        const cue = record(existing);
        if (cue.projectId !== input.projectId) throw new BudgetError("This music cue belongs to another film.");
        return {cue, alerts: [], replay: true};
      }
      const planned = planMusicReservation((await tx`select * from hv_music_cues`).map(record), input, now), cue = planned.cue;
      await this.holds.admitWithin(tx, storedCap, cue, input, now);
      await tx`insert into hv_music_cues (id, project_id, at, provider, model, status, held_usd, actual_usd, alerts, asset_id)
        values (${cue.id}, ${cue.projectId}, ${cue.at}, ${cue.provider}, ${cue.model}, ${cue.status}, ${cue.heldUsd}, ${null}, ${JSON.stringify(cue.alerts)}::text::jsonb, ${null})`;
      return {...planned, replay: false};
    });
    // After the transaction commits, never inside it: a refused or rolled-back cue raises nothing.
    for (const alert of result.alerts) this.onAlert?.(alert);
    return result;
  }

  private async transition(id: string, action: Parameters<typeof nextMusicCue>[1]): Promise<MusicCueRecord> {
    const owner = (await this.database.sql`select project_id from hv_music_cues where id = ${id}`)[0];
    if (!owner) throw new BudgetError("Unknown music cue.");
    return this.holds.within(String(owner.project_id), monthlyBudgetCap(process.env), async tx => {
      const row = (await tx`select * from hv_music_cues where id = ${id} for update`)[0];
      if (!row) throw new BudgetError("Unknown music cue.");
      const next = nextMusicCue(record(row), action);
      await tx`update hv_music_cues set status = ${next.status}, actual_usd = ${next.actualUsd}, asset_id = ${next.assetId} where id = ${id}`;
      return next;
    });
  }
  settle(id: string, actualUsd: number, assetId: string | null): Promise<MusicCueRecord> { return this.transition(id, {settle: actualUsd, assetId}); }
  markUnreconciled(id: string): Promise<MusicCueRecord> { return this.transition(id, "unreconciled"); }
  release(id: string): Promise<MusicCueRecord> { return this.transition(id, "release"); }
  async cue(id: string): Promise<MusicCueRecord | undefined> {
    const row = (await this.database.sql`select * from hv_music_cues where id = ${id}`)[0];
    return row ? record(row) : undefined;
  }
  async summary(): Promise<MusicLineSummary> {
    return summarizeMusicCues((await this.database.sql`select * from hv_music_cues`).map(record));
  }
}
