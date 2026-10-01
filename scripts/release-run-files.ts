/**
 * HV-030-22: the files the release drivers write and read beside a run's report.
 *
 * The studio has no accounts (ADR-0018), so a project token and a review link are each the only key
 * to what they open. They go to a file only its owner can read (mode 600), never into a report or onto
 * the terminal. A style card is the creator's own words: it is kept the same way, and a report names
 * it by its SHA-256 alone. Shared by `scripts/studio-run.ts` and `scripts/release-2-run.ts`.
 */
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { parseStyleCard } from "../packages/frontend/src/studio.js";

export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Write a file only its owner can read. `writeFileSync`'s mode applies only to a new file, so an existing one is narrowed too. */
export function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The file beside a report: `film.json` gives `film.token`, unless the operator named one. */
export function besideReport(out: string, suffix: string, named = ""): string {
  return named || (out ? out.replace(/\.json$/, "") + suffix : "");
}

export interface StyleCardFile { card: Record<string, unknown>; sha256: string }

/** A style card file the studio made, or an error that says what it is not. The words are never repeated. */
export function readStyleCardFile(path: string): StyleCardFile {
  const text = readFileSync(path, "utf8"), card = parseStyleCard(text);
  if (!card) throw new Error("--style-card is not a style card the studio made (hv-crew-style-card/1)");
  return { card, sha256: sha256(text) };
}

/** Keep the creator's style card, exactly as the studio offers it for download, and answer its SHA-256. */
export function keepStyleCardFile(path: string, file: { text: string }): { sha256: string } {
  writePrivate(path, file.text);
  return { sha256: sha256(file.text) };
}

export interface ProjectKey { projectId: string; token: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The project token `studio-run.ts` saved. Refused by shape, never by quoting what the file holds. */
export function readProjectKey(path: string): ProjectKey {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("a project token file is not readable JSON"); }
  const key = value as Partial<ProjectKey>;
  if (!key || typeof key !== "object" || typeof key.projectId !== "string" || !UUID.test(key.projectId) || typeof key.token !== "string" || !key.token)
    throw new Error("a project token file does not hold a project id and token");
  return { projectId: key.projectId, token: key.token };
}

export interface OwnerReviewLink { id: string; jobId: string | null; maxViews: number; permission: string; views: number }

/** The link just minted for this cut: the newest the owner's list binds to it. Its id is a digest, not the token. */
export function sharedLink(links: OwnerReviewLink[], jobId: string): { linkId: string; jobId: string; maxViews: number; permission: string } {
  const link = links.filter(value => value.jobId === jobId).at(-1);
  if (!link) throw new Error("The review link was made, but the owner's list does not show it bound to the shared cut.");
  return { linkId: link.id, jobId, maxViews: link.maxViews, permission: link.permission };
}
