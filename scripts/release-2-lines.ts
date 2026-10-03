/**
 * HV-030-23: read Release 2's four spend lines from the staging database, once before the run and
 * once after it. Read-only: every query is a `select`, and nothing is locked or written.
 *
 *   set -a; . $RC_RUNTIME/storage-api.env; set +a
 *   bun scripts/release-2-lines.ts --out lines-before.json
 *
 * Each dollar is counted on exactly one line, so the record's run total (the four lines' differences
 * added up) is the run's spend and is never counted twice:
 *   - voice: ElevenLabs takes, spent and held, by the query the studio's own $25 check runs
 *     (`PostgresAudioLedger.voiceVendorSpend`);
 *   - music: the music line's own summary (`PostgresMusicLedger.summary`), the figure its $10 check uses;
 *   - crew: the crew line's own summary (`PostgresCrewLedger.summary`), every vendor on one line (G16);
 *   - generation: the rest of the cost ledger. Its spent and held, less the music-cue stage and the
 *     ElevenLabs takes, which are the two lines above.
 *
 * Every line is read over the life of this database, as the vendor lines are kept. The $450 alert
 * is a month's figure, and a lifetime figure is never smaller, so a lifetime reading within $450 is
 * within the month's too.
 */
import { writeFileSync } from "node:fs";
import type { StudioDatabase } from "../packages/storage/src/database";
import type { LinesReading } from "./release-2-run";

export const VOICE_PROVIDER = "elevenlabs";
export const BASIS: Readonly<Record<string, string>> = Object.freeze({
  generation: "the cost ledger over the life of the staging database, less the music-cue stage and ElevenLabs takes (scripts/release-2-lines.ts)",
  voice: "ElevenLabs takes spent and held, as PostgresAudioLedger.voiceVendorSpend reads them for the $25 line (scripts/release-2-lines.ts)",
  music: "the music line's own summary, PostgresMusicLedger.summary (scripts/release-2-lines.ts)",
  crew: "the crew line's own summary, PostgresCrewLedger.summary, every vendor on one line (scripts/release-2-lines.ts)",
});

export interface LineFigures { spentUsd: number; heldUsd: number }
const micros = (value: number) => Math.round(value * 1e6) / 1e6;
const figure = (value: LineFigures, name: string): LineFigures => {
  for (const amount of [value.spentUsd, value.heldUsd]) if (!Number.isFinite(amount) || amount < 0) throw new Error("the " + name + " line read a figure that is not money");
  return { spentUsd: micros(value.spentUsd), heldUsd: micros(value.heldUsd) };
};

/** The four lines as the record holds them, from what the database answered. */
export function linesReading(at: Date, read: { generation: LineFigures; voice: LineFigures; music: LineFigures; crewSpentUsd: number }): LinesReading {
  return { schema: "hv-release-lines/1", at: at.toISOString(), basis: { ...BASIS },
    lines: { generation: figure(read.generation, "generation"), voice: figure(read.voice, "voice"), music: figure(read.music, "music"),
      // The crew is paid as it answers; nothing on its line is ever held.
      crew: figure({ spentUsd: read.crewSpentUsd, heldUsd: 0 }, "crew") } };
}

/** The generation line: the cost ledger outside the two vendor lines, with holds found the way the voice line finds its own. */
export async function generationFigures(database: StudioDatabase): Promise<LineFigures> {
  const row = (await database.sql`select
    (select coalesce(sum(e.total_usd), 0) from hv_cost_events e
      where e.stage is distinct from 'music-cue' and not (e.stage = 'audio-take' and e.provider = ${VOICE_PROVIDER})) as spent,
    (select coalesce(sum(r.remaining_usd), 0) from hv_reservations r
      where r.stage <> 'music-cue' and not (r.stage = 'audio-take' and (
        r.body->>'provider' = ${VOICE_PROVIDER}
        or exists (select 1 from hv_jobs j where j.id = r.job_id and j.body->'audioTake'->'policy'->>'provider' = ${VOICE_PROVIDER})
        or exists (select 1 from hv_provider_attempts a where a.job_id = r.job_id and a.provider = ${VOICE_PROVIDER})))) as held`)[0];
  return { spentUsd: Number(row.spent), heldUsd: Number(row.held) };
}

if (import.meta.main) {
  // The ledgers are loaded only here: they bring the studio's storage, which the reading above does not need.
  const [{ StudioDatabase }, { PostgresAudioLedger }, { PostgresMusicLedger }, { PostgresCrewLedger }] = await Promise.all([import("../packages/storage/src/database"),
    import("../packages/storage/src/audio-ledger"), import("../packages/storage/src/music-ledger"), import("../packages/storage/src/crew-ledger")]);
  const at = process.argv.indexOf("--out"), out = at >= 0 ? process.argv[at + 1] : undefined;
  const database = new StudioDatabase(process.env.HV_API_DATABASE_URL ?? "", 2);
  try {
    const [generation, voice, music, crew] = await Promise.all([generationFigures(database), new PostgresAudioLedger(database).voiceVendorSpend(VOICE_PROVIDER),
      new PostgresMusicLedger(database).summary(), new PostgresCrewLedger(database).summary()]);
    const text = JSON.stringify(linesReading(new Date(), { generation, voice, music: { spentUsd: music.spentUsd, heldUsd: music.heldUsd }, crewSpentUsd: crew.spentUsd }), null, 2) + "\n";
    if (out) writeFileSync(out, text, { mode: 0o600 }); else process.stdout.write(text);
  } finally {
    await database.close();
  }
}
