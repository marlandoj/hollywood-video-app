/**
 * HV-030-38 — an upload to the object store is verified and never hangs (Release 3's live run).
 *
 * On staging a dialogue replacement rendered its 46 MB export and then sat for 40 minutes with no
 * connection open to the object store: its checkpoint's upload never settled. On the pinned Bun (1.4.0),
 * `S3File.write(new Response(stream))` stops after its first two parts once the upload is multipart
 * (over 8 MiB) and never settles. These tests upload through the real `publishExport` and Bun's own S3
 * client to an S3-compatible stand-in on loopback: a multipart export uploads and is read back and
 * checked; a part that never answers, an existence check that never answers and a read back that
 * stalls are each tried again and then fail the upload, saying so; the job's abort stops it at once.
 */
import {afterAll, expect, test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PostgresArtifactStore, type ObjectTransferLimits} from "../src/artifacts";
import type {StudioDatabase} from "../src/database";
import type {Job} from "../../queue/src/index";
import {s3StandIn, type StandInFaults} from "./fixtures/s3-stand-in";

const TMP = mkdtempSync(join(realpathSync(tmpdir()), "hv-object-upload-"));
afterAll(() => rmSync(TMP, {recursive: true, force: true}));
const MiB = 1024 ** 2, PROJECT = "p1", JOB = {id: "dialogue-1", projectId: PROJECT, stage: "dialogue-replacement", status: "running"} as unknown as Job;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** A 46 MiB export, as on staging (six parts), and its small captions. */
const EXPORT = new Uint8Array(46 * MiB).map((_, index) => (index * 7) % 251), CAPTIONS = new TextEncoder().encode("WEBVTT\n\n00:00:00.200 --> 00:00:00.900\nHello.\n");

/** A worker cache holding the export, a store over the stand-in, and the record of what reached the database step. */
function worker(name: string, faults: StandInFaults = {}, limits: ObjectTransferLimits = {}) {
  const root = join(TMP, name), directory = join(root, PROJECT, JOB.id, "export"), s3 = s3StandIn(faults);
  mkdirSync(directory, {recursive: true});
  const paths = [join(directory, "export.mp4"), join(directory, "captions.vtt")];
  writeFileSync(paths[0]!, EXPORT); writeFileSync(paths[1]!, CAPTIONS);
  let recorded = 0;
  // Uploads come first; the database step is reached only once every file is uploaded and verified.
  const database = {forProject: async () => { recorded++; }} as unknown as StudioDatabase;
  const store = new PostgresArtifactStore(database, root, s3.client, limits);
  return {s3, paths, store, get recorded() { return recorded; }, publish: (signal?: AbortSignal) => store.publishExport(JOB, "worker-2", paths, signal)};
}
/** Settles `work` or says it is still pending after `ms`: a hang shows as a failed assertion, not a stuck run. */
const within = async <T>(work: Promise<T>, ms: number) => Promise.race([work.then(() => ({settled: "done"}), (error: Error) => ({error: error.message})), Bun.sleep(ms).then(() => ({pending: ms}))]);
const stored = (s3: ReturnType<typeof s3StandIn>, bytes: Uint8Array) => [...s3.objects.entries()].find(([key]) => key.includes(sha(bytes)))?.[1];

/** A 46 MiB export goes up in parts, is read back and checked, and only then reaches the database. */
test("a multipart export uploads, is read back and checked, and is recorded", async () => {
  const w = worker("healthy");
  try {
    expect(await within(w.publish(), 20_000)).toEqual({settled: "done"});
    expect(stored(w.s3, EXPORT)).toEqual(EXPORT);
    expect(stored(w.s3, CAPTIONS)).toEqual(CAPTIONS);
    expect(w.s3.calls.filter(call => call.startsWith("part ")).length).toBe(6);
    expect(w.s3.calls.filter(call => call === "get").length).toBe(2);
    expect(w.recorded).toBe(1);
  } finally { w.s3.close(); }
}, 30_000);

/** A part that hangs once is abandoned at the stall limit and the upload is tried again, which verifies. */
test("a part that hangs once is tried again and the second attempt is verified", async () => {
  const w = worker("hang-once", {hangPart: {number: 2, times: 1}}, {stallMs: 1_000});
  try {
    expect(await within(w.publish(), 20_000)).toEqual({settled: "done"});
    expect(stored(w.s3, EXPORT)).toEqual(EXPORT);
    expect(w.s3.calls.filter(call => call === "create").length).toBe(2);
    expect(w.recorded).toBe(1);
  } finally { w.s3.close(); }
}, 30_000);

/** A store that never answers a part, the existence check, or the read back fails the upload after its attempts, and nothing is recorded. */
test("a part, an existence check or a read back that never finishes fails the upload after three attempts", async () => {
  const cases: [string, StandInFaults, string][] = [
    ["part", {hangPart: {number: 2, times: Infinity}}, "uploading"],
    ["head", {hangHead: true}, "checking"],
    ["read", {stallRead: true}, "reading back"],
  ];
  for (const [name, faults, doing] of cases) {
    const w = worker("stalled-" + name, faults, {stallMs: 500}), started = Date.now(), key = `${PROJECT}/${JOB.id}/export/export.mp4`;
    try {
      expect([name, await within(w.publish(), 20_000)]).toEqual([name, {error: `The object store stalled on ${key} in all 3 attempts; the upload was abandoned. The object store made no progress ${doing} ${key} for 0.5 s.`}]);
      expect([name, Date.now() - started < 10_000, w.recorded]).toEqual([name, true, 0]);
      if (name === "part") expect(w.s3.calls.filter(call => call === "create").length).toBe(3);
    } finally { w.s3.close(); }
  }
}, 60_000);

/** With the default two-minute stall limit, the job's abort still stops a hung upload at once. */
test("the job's abort stops a hung upload at once", async () => {
  const w = worker("aborted", {hangPart: {number: 2, times: Infinity}}), lease = new AbortController(), lost = new Error("The worker lost the job's lease.");
  try {
    setTimeout(() => lease.abort(lost), 500);
    const started = Date.now();
    expect(await within(w.publish(lease.signal), 10_000)).toEqual({error: lost.message});
    expect([Date.now() - started < 5_000, w.recorded]).toEqual([true, 0]);
  } finally { w.s3.close(); }
}, 20_000);
