/** Shared rejection matrix (rejections.json) applied to the committed golden manifests. The Python
 * class SchemaConformanceTests in scripts/test_archive_package.py applies the same rows with the
 * same operations, so both validators are checked against one table. */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ArchiveSchemaName } from "../../../src/archive-schema";

export interface RejectionRow {name: string; document: ArchiveSchemaName; op: "set"|"delete"|"replicate"; pointer: string; value?: unknown; count?: number; expect: string; entry?: string}
export const GOLDEN = import.meta.dir;
export const GOLDEN_SOURCE = resolve(GOLDEN,"source");
export const goldenReceipt = (): {projectId: string; files: number; bytes: number; manifestSha256: string} => JSON.parse(readFileSync(resolve(GOLDEN,"receipt.json"),"utf8"));
export const goldenArchiveBytes = (): Buffer => readFileSync(resolve(GOLDEN,"archive.json"));
export function goldenJobId(projectId: string): string {
  const jobs = readdirSync(resolve(GOLDEN_SOURCE,"artifacts",projectId)); if (jobs.length !== 1) throw new Error("the golden holds exactly one job");
  return jobs[0]!;
}
export const goldenClipsManifestPath = (): string => { const {projectId} = goldenReceipt(); return resolve(GOLDEN_SOURCE,"artifacts",projectId,goldenJobId(projectId),"clips/manifest.json"); };
export function goldenDocument(name: ArchiveSchemaName): unknown {
  const path = name === "hv-project-archive/1" ? resolve(GOLDEN,"archive.json") : name === "hv-state/1" ? resolve(GOLDEN_SOURCE,"snapshot.json") : goldenClipsManifestPath();
  return JSON.parse(readFileSync(path,"utf8"));
}
export const rejectionRows = (): RejectionRow[] => (JSON.parse(readFileSync(resolve(GOLDEN,"rejections.json"),"utf8")) as {rows: RejectionRow[]}).rows;
const unescape = (token: string): string => token.replaceAll("~1","/").replaceAll("~0","~");
const expand = (value: unknown): unknown => value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as {$repeat?: unknown}).$repeat) ? String((value as {$repeat: [string,number]}).$repeat[0]).repeat((value as {$repeat: [string,number]}).$repeat[1]) : value;
/** Apply one row to a deep copy of its base document and return the mutated document. */
export function mutate(base: unknown, row: RejectionRow): unknown {
  const document = structuredClone(base), tokens = row.pointer.split("/").slice(1).map(unescape), last = tokens.pop()!;
  let parent: any = document; for (const token of tokens) parent = Array.isArray(parent) ? parent[Number(token)] : parent[token];
  const key: string | number = Array.isArray(parent) ? Number(last) : last;
  if (row.op === "set") parent[key] = expand(row.value);
  else if (row.op === "delete") { if (Array.isArray(parent)) parent.splice(key as number,1); else delete parent[key]; }
  else if (row.op === "replicate") { const template = parent[key][0]; parent[key] = Array.from({length:row.count!},(_,index) => ({...structuredClone(template),path:template.path + "-" + index})); }
  else throw new Error("unknown matrix operation " + String(row.op));
  return document;
}
