/**
 * HV-022-16 — a screenplay revision's generation ignored the film's spending limit on the local
 * backend.
 *
 * Every paid admission checks the film's own limit (`HV_FILM_SPEND_CAP_USD`) before it reserves: the
 * render route with `assertFilmBudget` on the local ledger, PostgreSQL inside `admit`'s lock. HV-022-14
 * carried the limit into the living-script generation route's PostgreSQL `admit` call, and its test
 * checks that the fourth argument is passed. The route's local branch went straight to
 *
 *     await ledger.reserve(submitted.id,submitted.stage,submitted.budgetReservedUsd??0,monthlyBudgetUsd);
 *
 * so on the JSON store a film whose limit was $0.03 admitted a paid preview holding $5.00 and was then
 * refused its next ordinary render as over its limit -- the limit had been passed by the one route
 * that never asked. Screenplay revisions can be generated again and again; only the monthly cap bound
 * them.
 */
import {afterEach, expect, test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {readFileSync} from "node:fs";
import {renderHold} from "../../operator/src/film-budget";

const KEYS = ["HV_PROVIDER_POOL", "HV_FILM_SPEND_CAP_USD", "HV_ANIMATIC_PROVIDER_POOL"] as const;
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
afterEach(() => {for (const key of KEYS) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];});

/** A rendered film, a saved screenplay revision of one of its lines, and that revision's preview quote. */
async function revision(filmCapUsd: string) {
  process.env.HV_PROVIDER_POOL = '["mock"]'; process.env.HV_FILM_SPEND_CAP_USD = filmCapUsd;
  const studio = await dubStudio();
  const call = async (path: string, method = "GET", body?: unknown) => {const r = await studio.call(path, method, body, studio.owner.token); return {status: r.status, body: await r.json() as Record<string, any>};};
  expect((await call(studio.base + "/animatic/decision", "POST", {animaticJobId: studio.film.id, decision: "approved"})).status).toBe(201);
  expect((await call(studio.base + "/jobs", "POST", {idempotencyKey: "living-cap-original", stage: "final", animaticJobId: studio.film.id})).status).toBe(202);
  const original = (await studio.worker())!;
  expect(original.status).toBe("done");
  const source = await inspectEditSource(original, "Original final", studio.paths.artifactRoot, async () => {}), binding = bindOriginalEditSource(source), project = studio.projects.peekProject(studio.owner.projectId)!;
  const library = studio.projects.createEditSequence(studio.owner.token, [source], "pending-parent", "Original cut", source.facts.id, 320, 180, 0, Date.now(), [binding])!;
  const parent = deriveEditAssemblyParent(project.id, library, "pending-parent"), index = compileEditScriptSource(source), line = index.entries.find(entry => entry.kind === "dialogue")!;
  const navigation = projectEditScriptNavigation(parent.sequenceId, parent.historyRevision, parent.timeline, [index]);
  const patch = compileLivingScriptPatch(source, {entryId: line.id, indexRevision: index.revision, currentScript: {version: original.scriptVersion, text: original.scriptText}, replacement: "Welcome back to the garden."});
  const impact = compileLivingScriptGenerationImpact(source, patch, {...original, scriptVersion: patch.after.version, scriptText: patch.after.text});
  studio.projects.createLivingScriptProposal(studio.owner.token, {id: "http-line", label: "Revised greeting", sequenceId: parent.sequenceId, historyRevision: parent.historyRevision,
    editorialRevision: library.revision, navigationRevision: navigation.revision, patch, candidate: impact.candidateInputs,
    baseline: {casting: currentCasting(project.id, project.castingHistory), direction: currentDirection(project.id, project.directionHistory)}}, 0, [{binding, current: original}]);
  const route = studio.base + "/editorial/screenplay/proposals/http-line/generation";
  // A paid storyboard pool, as film-budget-route.test.ts configures one, so the preview holds money.
  process.env.HV_ANIMATIC_PROVIDER_POOL = '["image:fal:flux-schnell"]';
  const quote = await call(route + "/quote", "POST", {role: "preview"});
  expect(quote.status).toBe(200);
  expect(quote.body.quote.budgetReservedUsd).toBeGreaterThan(0);
  const admit = () => call(route + "/jobs", "POST", {quote: quote.body.quote, idempotencyKey: "paid-preview-1", generationApproved: true, animaticJobId: null});
  const spend = async () => (await call(studio.base + "/spend")).body;
  return {studio, admit, spend, reserve: quote.body.quote.budgetReservedUsd as number, quote: quote.body.quote};
}

test("a revision's paid preview that would pass the film's limit is refused before anything is held", async () => {
  // HV-022-18: the preview now holds what it can spend (two cents here), so the limit is a cent.
  const r = await revision("0.01");
  try {
    const before = await r.spend();
    const refused = await r.admit();
    expect(refused.status).toBe(429);
    expect(refused.body.error).toContain("This film has reached its spending limit of $0.01");
    expect(await r.spend()).toEqual(before);
    expect(r.studio.store.all().filter(job => job.livingScript)).toEqual([]);
  } finally {await r.studio.close();}
}, 300_000);

test("and one that fits the limit is admitted and holds its reservation, as before", async () => {
  const r = await revision("40");
  try {
    const admitted = await r.admit();
    expect(admitted.status).toBe(202);
    expect((await r.spend()).heldUsd).toBeCloseTo(r.reserve, 6);
  } finally {await r.studio.close();}
}, 300_000);

/**
 * HV-022-18 — a revision's generation held its whole stage cap.
 *
 * HV-019-06 made every render hold what it can actually spend: the dearest eligible provider for each
 * shot, times the three attempts its retry policy allows, never more than its cap. The living-script
 * quote was left holding the cap itself -- $5 for a preview whose two stills cost $0.006 at the
 * dearest provider -- so a few screenplay revisions filled a film's $40 limit and its ordinary renders
 * were then refused as over it. The quote now holds what the revision can spend.
 */
test("a revision's paid preview holds what it can spend, not its stage cap", async () => {
  const r = await revision("40");
  try {
    expect(r.quote).toMatchObject({costCapUsd: 5, maximumEstimateUsd: 0.006, budgetReservedUsd: 0.02});
    expect((await r.admit()).status).toBe(202);
    expect((await r.spend()).heldUsd).toBeCloseTo(0.02, 6);
  } finally {await r.studio.close();}
}, 300_000);

test("and the hold is the estimate for every attempt, rounded up to the cent, at least a cent and at most the cap", () => {
  expect(renderHold(0.006, 5)).toBe(0.02);
  expect(renderHold(0.0001, 5)).toBe(0.01);
  // 0.4 * 3 * 100 is 120.00000000000001 in floating point; the render route's own copy held $1.21.
  expect(renderHold(0.4, 5)).toBe(1.2);
  expect(renderHold(4, 5)).toBe(5);
});

test("and both routes that hold for a render hold through that one function", () => {
  for (const file of ["server.ts", "living-script-generation-api.ts"]) {
    const source = readFileSync(new URL("../src/" + file, import.meta.url), "utf8");
    expect({file, holds: /renderHold\(maximumEstimateUsd, ?costCapUsd\)/.test(source)}).toEqual({file, holds: true});
  }
});
