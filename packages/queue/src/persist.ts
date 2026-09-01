import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2));
  renameSync(temporary, path);
}

export interface FileLockOptions { waitMs?: number; staleMs?: number }

const DEFAULT_LOCK_WAIT_MS = 10_000;
const DEFAULT_LOCK_STALE_MS = 30_000;

/**
 * Interprocess mutual exclusion for a JSON state file shared between the API
 * and worker processes. The lock is a sibling file created with O_EXCL, which
 * is atomic on the local and overlay filesystems the compose volumes use. A
 * lock older than `staleMs` belongs to a process that died mid-write and is
 * broken so the queue does not wedge on a crash.
 */
export function withFileLock<T>(path: string, fn: () => T, options: FileLockOptions = {}): T {
  const lockPath = `${path}.lock`;
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try {
        writeFileSync(descriptor, `${process.pid}\n`);
      } finally {
        closeSync(descriptor);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock on ${path}`);
      Bun.sleepSync(2 + Math.random() * 8);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
