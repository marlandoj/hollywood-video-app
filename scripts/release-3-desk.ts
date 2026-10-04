/**
 * HV-030-31: the desk steps a feature needs before its look is approved.
 *
 * Release 3's criterion 2 asks that every shot of each locked character, in every sequence, is
 * rendered from that character's lock, and that each continuity finding is repaired or kept before
 * the final. Both have to happen before the first sequence renders, and the front door renders
 * sequence 1 the moment the look is approved. So `scripts/studio-run.ts` stops between the plan and
 * the look approval, as a creator would to open the Director's desk, and drives these routes:
 *
 *   - the cast's permission, the same `POST /crew/approve-cast` the look approval sends, so a sheet
 *     can be rendered for a permitted character;
 *   - `--lock NAME[,NAME]`: each named character's look is locked to its reference images, after a
 *     turnaround character sheet gives it some when it has none (as the desk's "Generate character
 *     sheets" does, and as Release 2's `--sheet` did);
 *   - `--continuity-repair`: the Continuity Supervisor's repair is reviewed and, when it proposes
 *     edits, applied exactly as shown.
 *
 * Every step here is the Director's desk's, so the report names its surface `desk-api`. It never
 * writes or prints the project token.
 */

type Json = Record<string, any>;
export type DeskCall = (path: string, init?: { method?: string; body?: unknown }) => Promise<Json>;
export interface BeforeLookOptions {
  call: DeskCall; projectId: string;
  /** The flow's state at the look step: its cast version and the characters still waiting for permission. */
  state: { casting: { version: number }; pendingCast?: unknown[] };
  locks: string[]; continuity: boolean;
  poll?: { intervalMs: number; limitMs: number };
}
export interface BeforeLookReport {
  surface: "desk-api";
  castApproved: boolean;
  locks: { characterId: string; name: string; revision: string | null; assets: number; sheetJobId: string | null }[];
  continuity: { findings: number; edits: number; applied: boolean; refused: string[]; boundaries: number | null; summary: string | null } | null;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function deskBeforeLook(options: BeforeLookOptions): Promise<BeforeLookReport> {
  const { call } = options, root = `/api/projects/${options.projectId}`, poll = options.poll ?? { intervalMs: 5000, limitMs: 30 * 60 * 1000 };
  const report: BeforeLookReport = { surface: "desk-api", castApproved: false, locks: [], continuity: null };
  // The look approval's own first step, taken now: a character waiting for permission can't be rendered on a sheet.
  if (options.state.pendingCast?.length) {
    await call(root + "/crew/approve-cast", { method: "POST", body: { attested: true, expectedVersion: options.state.casting.version } });
    report.castApproved = true;
  }
  for (const name of options.locks) {
    let casting = (await call(root + "/cast")).casting as Json;
    let character = (casting.characters as Json[]).find(value => value.name === name);
    if (!character) throw new Error("The cast has no character named " + name + " to lock.");
    let sheetJobId: string | null = null;
    if (!character.references?.length) {
      const route = `${root}/cast/${character.id}/sheets`;
      const queued = await call(route, { method: "POST", body: { generationApproved: true, expectedVersion: casting.version,
        idempotencyKey: `release-3-sheet-${character.id.slice(0, 8)}`, settings: { kind: "turnaround", seed: 2026, sceneNumber: null } } });
      const started = Date.now();
      let job: Json | undefined;
      for (;;) {
        job = ((await call(route)).jobs as Json[]).find(value => value.id === queued.jobId);
        if (job && ["done", "failed", "cancelled"].includes(job.status)) break;
        if (Date.now() - started > poll.limitMs) throw new Error("The character sheet for " + name + " did not finish in time.");
        await wait(poll.intervalMs);
      }
      if (job.status !== "done") throw new Error("The character sheet for " + name + " did not finish: " + (job.failureReason ?? job.cancelReason ?? job.status));
      const viewIds = ((job.storyboard ?? []) as Json[]).slice(0, 4).map(frame => frame.shotId as string);
      if (!viewIds.length) throw new Error("The character sheet for " + name + " finished with no view to adopt.");
      casting = (await call(`${route}/${job.id}/adopt`, { method: "POST", body: { viewIds, replaceExisting: false, expectedVersion: casting.version, attested: true } })).casting;
      character = (casting.characters as Json[]).find(value => value.id === character!.id)!;
      sheetJobId = job.id;
    }
    if (!character.references?.length) throw new Error(name + " has no reference image to lock its look to.");
    const saved = await call(`${root}/cast/${character.id}/reference-lock`, { method: "PUT",
      body: { expectedVersion: casting.version, lock: { assetIds: (character.references as Json[]).slice(0, 4).map(reference => reference.id), label: "Release 3 locked look", note: "" } } });
    const lock = (saved.casting.characters as Json[]).find(value => value.id === character!.id)?.referenceLock;
    report.locks.push({ characterId: character.id, name, revision: lock?.revision ?? null, assets: lock?.assets?.length ?? 0, sheetJobId });
  }
  if (options.continuity) {
    const desk = await call(root + "/direction");
    const review = await call(root + "/direction/continuity/repair", { method: "POST", body: {} });
    const edits: unknown[] = review.proposal?.edits ?? [];
    if (edits.length) await call(root + "/direction/continuity/repair/accept", { method: "POST",
      body: { edits, expectedVersion: desk.direction.version, expectedScriptVersion: review.scriptVersion } });
    report.continuity = { findings: ((review.report?.scenes ?? []) as Json[]).reduce((sum, scene) => sum + (scene.findings?.length ?? 0), 0), edits: edits.length,
      applied: edits.length > 0, refused: ((review.proposal?.refused ?? []) as unknown[]).map(value => typeof value === "string" ? value : String((value as Json)?.code ?? "refused")),
      boundaries: Array.isArray(review.report?.boundaries) ? review.report.boundaries.length : null, summary: review.summary ?? null };
  }
  return report;
}
