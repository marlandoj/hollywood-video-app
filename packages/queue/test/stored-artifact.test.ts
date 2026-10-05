/**
 * HV-030-34 — copying one artifact out of the object store (`copyStoredArtifact`).
 *
 * The cause of the staging hang, reproduced on the pinned Bun (1.4.0): `Bun.write(path, response)`
 * never settles for the Response `PostgresArtifactStore.response` returns, whose body is the S3
 * client's stream, and writes nothing. The copy streams the same Response into a writer, checks it and
 * renames it into place; a stream that sends nothing for the stall bound fails it.
 */
import {afterAll, expect, test} from "bun:test";
import {existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {copyStoredArtifact} from "../src/stored-artifact";
import {objectStore} from "./fixtures/object-store";

const TMP = mkdtempSync(join(realpathSync(tmpdir()), "hv-stored-artifact-"));
afterAll(() => rmSync(TMP, {recursive: true, force: true}));
const BYTES = new Uint8Array(300_000).map((_, index) => index % 251), KEY = "p1/final-1/export/export.mp4";
const copy = (target: string, extra: {stallMs?: number; signal?: AbortSignal} = {}) =>
  ({projectId: "p1", jobId: "final-1", key: KEY, target, name: "Sequence 1's film", signal: extra.signal ?? new AbortController().signal, deadline: Date.now() + 60_000, now: Date.now, ...extra});

/** The staging hang: the store's streamed Response never finishes through `Bun.write`, and the same Response copies through a writer. */
test("Bun.write never settles on the object store's Response, and the streamed copy lands checked", async () => {
  const store = objectStore(join(TMP, "cache-write"));
  try {
    const record = store.put("p1", "final-1", KEY, BYTES), stuck = join(TMP, "stuck.mp4");
    const written = Bun.write(stuck, (await store.artifacts.response("p1", "final-1", KEY, new Request("http://worker.invalid/")))!);
    expect(await Promise.race([written.then(() => "settled"), Bun.sleep(2_000).then(() => "pending")])).toBe("pending");
    expect(existsSync(stuck) ? Bun.file(stuck).size : 0).toBe(0);
    const target = join(TMP, "film-1.mp4");
    expect(await copyStoredArtifact(store.artifacts, copy(target))).toEqual({bytes: record.bytes, sha256: record.sha256});
    expect(new Uint8Array(readFileSync(target))).toEqual(BYTES);
    expect(readdirSync(TMP).filter(name => name.includes(".download"))).toEqual([]);
  } finally { store.close(); }
}, 20_000);

/** A stream that stops sending fails after the stall bound, with nothing left behind, though the job's signal and deadline are far off. */
test("a stream that sends nothing for the stall bound fails the copy", async () => {
  const store = objectStore(join(TMP, "cache-stall"));
  try {
    store.put("p1", "final-1", KEY, BYTES);
    store.object("p1", "final-1", KEY).stall = true;
    const target = join(TMP, "stalled.mp4"), started = Date.now();
    await expect(copyStoredArtifact(store.artifacts, copy(target, {stallMs: 500}))).rejects.toThrow("The object store sent nothing of Sequence 1's film for 0.5 s.");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect([existsSync(target), readdirSync(TMP).filter(name => name.startsWith("stalled.mp4."))]).toEqual([false, []]);
  } finally { store.close(); }
}, 20_000);
