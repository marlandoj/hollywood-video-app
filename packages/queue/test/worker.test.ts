import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DurableJobStore } from "../src/index";
import { processNextJob } from "../src/worker";

describe("reachable generation worker", () => {
  test("claims a persisted job and produces MP4, HLS, captions, and provenance", async () => {
    const root = `/tmp/hv-worker-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    store.enqueue({
      id: "job-1",
      idempotencyKey: "job-1",
      projectId: "project-1",
      tier: "free",
      totalFrames: 60,
      retryPolicy: { maxRetries: 1, backoffMs: 10 },
      timeoutMs: 120000,
      costCapUsd: 5,
      scriptText: "INT. ROOM - DAY\n\nA lamp glows.",
    });

    const completed = await processNextJob(store, `${root}/artifacts`);
    expect(completed?.status).toBe("done");
    expect(completed?.checkpointFrame).toBe(1);
    expect(existsSync(`${root}/artifacts/${completed?.output?.mp4Path}`)).toBe(true);
    expect(existsSync(`${root}/artifacts/${completed?.output?.hlsPlaylistPath}`)).toBe(true);
    expect(existsSync(`${root}/artifacts/${completed?.output?.captionsPath}`)).toBe(true);
    expect(existsSync(`${root}/artifacts/${completed?.output?.manifestPath}`)).toBe(true);
  }, 60000);
});
