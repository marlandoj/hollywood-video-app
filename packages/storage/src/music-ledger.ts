/**
 * HV-024-11: the music line's ledger, in PostgreSQL. The file ledger's interface and decisions
 * (`planMusicReservation`, `nextMusicCue` in packages/operator/src/music-ledger.ts), returning promises.
 *
 * The reservation reads the month's cues, checks the $10 line and writes the cue **inside one
 * transaction that holds a transaction-scoped advisory lock on the line**, so two API processes
 * admitting at once are decided one after the other: the second reads the first's hold and is
 * refused if the two together would pass the line, and an alert is crossed by exactly one of them.
 * The lock is advisory rather than a row lock because the line has no row of its own: it is the sum
 * of its cues, and a row lock cannot be taken on a row that does not exist yet.
 *
 * The month is read across every project. The API may read every cue (`hv_music_cues_api_read`)
 * but write only its own project's, inside `forProject`.
 */
import type {SQL} from "bun";
import {BudgetError} from "../../operator/src/index";
import {musicMonth, nextMusicCue, planMusicReservation, summarizeMusicMonth, validateMusicCueRecord, type MusicCueRecord, type MusicLineAlert, type MusicLineLedger,
  type MusicLineSummary, type MusicReservation, type MusicReserveInput} from "../../operator/src/music-ledger";
import type {StudioDatabase} from "./database";

/** The line's lock key: one 64-bit number, fixed, so every process takes the same lock. */
export const MUSIC_LINE_LOCK_KEY = 0x48565f4d55534943n; // "HV_MUSIC"

function record(row: Record<string, unknown>): MusicCueRecord {
  // The alerts column is written as an array (see `alertsOf` in crew-ledger.ts); a string here is a
  // ledger written some other way, refused rather than parsed.
  if (!Array.isArray(row.alerts)) throw new BudgetError("The music ledger is unreadable; no cue is admitted until it is repaired.");
  return validateMusicCueRecord({id: String(row.id), projectId: String(row.project_id), at: new Date(String(row.at)).toISOString(), month: String(row.month),
    provider: String(row.provider), model: String(row.model), status: String(row.status), heldUsd: Number(row.held_usd),
    actualUsd: row.actual_usd === null ? null : Number(row.actual_usd), alerts: (row.alerts as unknown[]).map(Number), assetId: row.asset_id === null ? null : String(row.asset_id)});
}

export class PostgresMusicLedger implements MusicLineLedger {
  onAlert?: (alert: MusicLineAlert) => void;
  constructor(private readonly database: StudioDatabase) {}

  private async lock(tx: SQL): Promise<void> { await tx`select pg_advisory_xact_lock(${MUSIC_LINE_LOCK_KEY.toString()}::bigint)`; }

  async reserve(input: MusicReserveInput): Promise<MusicReservation> {
    const now = input.now ?? Date.now();
    const result = await this.database.forProject(input.projectId, async tx => {
      await this.lock(tx);
      const existing = (await tx`select * from hv_music_cues where id = ${input.id}`)[0];
      if (existing) {
        const cue = record(existing);
        if (cue.projectId !== input.projectId) throw new BudgetError("This music cue belongs to another film.");
        return {cue, alerts: [], replay: true};
      }
      const month = (await tx`select * from hv_music_cues where month = ${musicMonth(now)}`).map(record);
      const planned = planMusicReservation(month, input, now), cue = planned.cue;
      await tx`insert into hv_music_cues (id, project_id, at, month, provider, model, status, held_usd, actual_usd, alerts, asset_id)
        values (${cue.id}, ${cue.projectId}, ${cue.at}, ${cue.month}, ${cue.provider}, ${cue.model}, ${cue.status}, ${cue.heldUsd}, ${null}, ${JSON.stringify(cue.alerts)}::text::jsonb, ${null})`;
      return {...planned, replay: false};
    });
    // After the transaction commits, never inside it: a refused or rolled-back cue raises nothing.
    for (const alert of result.alerts) this.onAlert?.(alert);
    return result;
  }

  private async transition(id: string, action: Parameters<typeof nextMusicCue>[1]): Promise<MusicCueRecord> {
    const owner = (await this.database.sql`select project_id from hv_music_cues where id = ${id}`)[0];
    if (!owner) throw new BudgetError("Unknown music cue.");
    return this.database.forProject(String(owner.project_id), async tx => {
      await this.lock(tx);
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
  async summary(now = Date.now()): Promise<MusicLineSummary> {
    const key = musicMonth(now);
    return summarizeMusicMonth((await this.database.sql`select * from hv_music_cues where month = ${key}`).map(record), key);
  }
}
