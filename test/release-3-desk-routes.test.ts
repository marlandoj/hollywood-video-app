/**
 * HV-030-35: the run driver's two new desk steps against the real API and worker, on the mock
 * providers, at $0. `scripts/release-3-run.ts` is otherwise tested against a fake studio
 * (`test/release-3-driver.test.ts`); these two prove that the calls it sends are the ones the desk's
 * real routes accept: HV-025-13's composite through the editorial desk, and HV-023-05's export of a
 * joined feature's cut.
 */
import { expect, test } from "bun:test";
import { dubStudio } from "./fixtures/dub-studio";
import { VFX_COMPOSITE, deskClient, exportFeatureCut, makeVfxComposite } from "../scripts/release-3-run";

/**
 * The composite is made the way `--vfx` makes it, over the studio's own film: inspected, saved as a
 * sequence, edited, rendered by the worker on the studio's machine, and read back from the job view.
 * It costs nothing on the ledger. Run again, it reuses the same sequence and the same render. A
 * caller without the project's token is refused before anything is saved, and the error carries no
 * token.
 */
test("the driver's composite is accepted by the real editorial routes, rendered by the worker at $0, and read back from the job view", async () => {
  const f = await dubStudio();
  try {
    const desk = deskClient(f.server.url.origin, f.owner.token), shotId = f.film.output!.shotRenders![0]!.shotId;
    const make = async () => {
      let settled = false;
      const pumping = (async () => { while (!settled) { await f.worker(); await Bun.sleep(20); } })();
      try { return await makeVfxComposite(desk, f.owner.projectId, { jobId: f.film.id, sequence: 1, shotId }, { intervalMs: 50, limitMs: 180000 }); }
      finally { settled = true; await pumping; }
    };
    const made = await make();
    expect(made.note).toBeUndefined();
    expect(made).toMatchObject({ parts: ["HV-025.vfx-composite"], ids: [made.vfx!.jobId] });
    expect(made.vfx).toMatchObject({ stage: "picture-edit", status: "done", costUsd: 0, sourceJobId: f.film.id, sequence: 1, failureReason: null,
      composite: { window: { at: VFX_COMPOSITE.at, frames: VFX_COMPOSITE.frames }, plate: { jobId: f.film.id, layer: 0 }, element: { jobId: f.film.id, layer: 1 },
        matte: [{ kind: "rectangle", keys: 1 }], opacity: VFX_COMPOSITE.opacity, operation: "Editor (AI crew): VFX composite of Sequence 1's film, frame " + made.vfx!.composite.element.from + " over Sequence 1's film, " + shotId } });
    expect(f.ledger.monthSpend()).toBe(0);
    const again = await make();
    expect(again.vfx!.jobId).toBe(made.vfx!.jobId);
    const library = await desk.call(`/api/projects/${f.owner.projectId}/editorial`);
    expect((library.sequences as { id: string }[]).filter(sequence => sequence.id.startsWith("release-3-vfx-"))).toHaveLength(1);
    const stranger = await (await f.call("/api/projects", "POST")).json() as { projectId: string; token: string };
    const refused = makeVfxComposite(deskClient(f.server.url.origin, stranger.token), f.owner.projectId, { jobId: f.film.id }, { intervalMs: 50, limitMs: 5000 });
    await expect(refused).rejects.toThrow(/^\/api\/projects\/:id\/editorial -> 40[134]/);
    await refused.catch((error: Error) => { expect(error.message).not.toContain(stranger.token); expect(error.message).not.toContain(f.owner.token); });
  } finally {
    await f.close();
  }
}, 240000);

/**
 * The feature's cut is asked for at the route the real server serves (HV-023-05): a project that is
 * not a feature is refused there with the studio's own reason (409), not with "not found", and the
 * step records it as unavailable.
 */
test("the driver asks the real server's feature-cut route, and a project that is not a feature is refused there by name", async () => {
  const f = await dubStudio();
  try {
    const exported = await exportFeatureCut(deskClient(f.server.url.origin, f.owner.token), f.owner.projectId, { jobId: f.film.id, films: [f.film.id], credits: null });
    expect(exported).toMatchObject({ outcome: "unavailable", note: "the studio refused the joined feature's cut: Only a feature the Showrunner split into sequences has a joined film to export.", interchange: null });
  } finally {
    await f.close();
  }
}, 120000);
