import { expect, test } from "bun:test";
import { resolve } from "node:path";

// The CI workflow lists Python test files explicitly and is frozen, so the bucket preparation
// unit tests are registered with the `bun test packages test` run here. They stub boto3 and need
// only a system python3; without one the check is skipped rather than passed.
const scripts = resolve(import.meta.dir, "../../../scripts");
const python = Bun.which("python3");
const pytest = python ? test : test.skip;
pytest("prepare-object-bucket.py declares one AbortIncompleteMultipartUpload rule and degrades to unsupported truthfully", () => {
  const result = Bun.spawnSync([python!, "-m", "unittest", "discover", "-s", scripts, "-p", "test_prepare_object_bucket.py"], {stdout: "pipe", stderr: "pipe"});
  const output = result.stdout.toString() + result.stderr.toString();
  expect(output).toContain("OK");
  expect(result.exitCode).toBe(0);
}, 60_000);
