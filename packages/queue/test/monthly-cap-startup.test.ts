import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorker } from "../src/worker";

/**
 * HV-024-13: the worker reads the monthly cap as plain dollars before anything else, as the API does.
 * It used to read it with `Number()` at each job, where "abc" became NaN.
 */
const saved = {monthly: process.env.HV_MONTHLY_BUDGET_USD, storage: process.env.HV_STORAGE};
const root = mkdtempSync(join(tmpdir(), "hv-worker-monthly-"));
afterEach(() => {
  if (saved.monthly === undefined) delete process.env.HV_MONTHLY_BUDGET_USD; else process.env.HV_MONTHLY_BUDGET_USD = saved.monthly;
  if (saved.storage === undefined) delete process.env.HV_STORAGE; else process.env.HV_STORAGE = saved.storage;
});
afterAll(() => rmSync(root, {recursive: true, force: true}));

/** Each refused value stops the worker before it opens its queue, naming the setting. The signal ends a worker that started anyway. */
test("a monthly cap that is not plain dollars stops the worker at startup", async () => {
  delete process.env.HV_STORAGE;
  for (const raw of ["abc", "0x10", "1e3", "500 ", "", "0"]) {
    process.env.HV_MONTHLY_BUDGET_USD = raw;
    const queuePath = join(root, "jobs-" + encodeURIComponent(raw || "blank") + ".json");
    await expect(runWorker({queuePath, artifactRoot: join(root, "artifacts"), pollMs: 10, signal: AbortSignal.timeout(500)})).rejects.toThrow("Set HV_MONTHLY_BUDGET_USD to a plain dollar amount above zero");
    expect(existsSync(queuePath)).toBe(false);
  }
});
