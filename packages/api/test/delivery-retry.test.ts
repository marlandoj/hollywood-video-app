/**
 * HV-027-10 — a deliverable that failed once could never be asked for again.
 *
 * `DeliveryApi` treats "the same deliverable of the same sealed output" as one job, whatever request
 * key asks for it, so that two keys asking for one file do not render it twice:
 *
 *     const made=mine.find(job=>job.delivery?.idempotencyKey===plan.idempotencyKey);
 *     if(made)return {status:202,body:{jobId:made.id}};
 *
 * It did not ask what had become of that job. A 1:1 reframe the worker refused for disk headroom (or
 * that ran out of retries, or was cancelled) stayed "the same job" for good: the creator freed space,
 * asked again with a new request key, and got 202 with the failed job's id. Nothing was queued and
 * the worker had nothing to pick up. The only way to get that file was to render the film again.
 *
 * A job is reused now only while it is making the file, or once it has made one that can still be
 * fetched. A failed or cancelled one is asked for again as a new job.
 */
import {expect, test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";

/** A rendered picture edit of the fixture's film, and a way to ask for its deliverables. */
async function renderedCut() {
  const f = await dubStudio();
  const editorial = f.base + "/editorial", deliveries = f.base + "/deliveries";
  const call = (path: string, method = "GET", body?: unknown) => f.call(path, method, body, f.owner.token);
  const json = async (path: string, method = "GET", body?: unknown) => {const r = await call(path, method, body); const t = await r.text(); if (!r.ok) throw new Error(path + " " + r.status + " " + t); return JSON.parse(t);};
  const source = (await inspectedSource(async s => await (await call(editorial + s)).json() as never, "/sources/" + f.film.id)).sources[0];
  const id = crypto.randomUUID(), sequence = editorial + "/sequences/" + id;
  let state = await json(editorial + "/sequences", "POST", {id, label: "cut", sources: [{jobId: f.film.id, sourceRevision: source.sourceRevision}], firstSourceId: f.film.id, width: 640, height: 360, expectedVersion: 0});
  state = await json(sequence, "PATCH", {expectedVersion: state.libraryVersion, expectedHistoryRevision: state.sequence.history.revision,
    change: {kind: "edit", label: "trim", operation: {kind: "trim", clipId: "initial-0", linked: true, edge: "out", delta: 30 - state.timeline.frames, ripple: true}}});
  const quote = await json(sequence + "/renders");
  await json(sequence + "/renders", "POST", {idempotencyKey: crypto.randomUUID(), generationApproved: true, historyRevision: quote.sequence.historyRevision,
    sourceBindingsRevision: quote.sourceBindingsRevision, engineVersion: quote.engineVersion, review: {...quote.review, accepted: true}});
  const film = (await f.worker())!;
  expect(film.status).toBe("done");
  const ask = async () => (await json(deliveries + "/" + film.id, "POST", {idempotencyKey: crypto.randomUUID(), kind: "reframe-1:1"})).jobId as string;
  const deliverables = () => f.store.all().filter(job => job.delivery).map(job => job.status);
  return {f, ask, deliverables};
}

test("a deliverable the worker refused is queued again when the creator asks again", async () => {
  const {f, ask, deliverables} = await renderedCut();
  try {
    const first = await ask();
    const claimed = f.store.claimNext(Date.now(), {}, {workerId: "test"})!;
    expect(claimed.id).toBe(first);
    f.store.refuse(claimed.id, "test", "Not enough free disk for this deliverable.");
    expect(f.store.get(first)!.status).toBe("failed");
    const again = await ask();
    expect(again).not.toBe(first);
    expect(deliverables()).toEqual(["failed", "queued"]);
    expect(f.store.get(again)!.delivery!.idempotencyKey).toBe(f.store.get(first)!.delivery!.idempotencyKey);
  } finally {await f.close();}
}, 300_000);

test("and a deliverable still being made is still the one job, whatever key asks for it", async () => {
  const {f, ask, deliverables} = await renderedCut();
  try {
    const first = await ask();
    expect(await ask()).toBe(first);
    f.store.claimNext(Date.now(), {}, {workerId: "test"});
    expect(f.store.get(first)!.status).toBe("running");
    expect(await ask()).toBe(first);
    expect(deliverables()).toEqual(["running"]);
  } finally {await f.close();}
}, 300_000);
