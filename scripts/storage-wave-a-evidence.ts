/**
 * Read-only Wave A exit evidence collector (HV-040-05). Runs on the private staging host against the live
 * runtime and records what it observes into `hv-wave-a-exit/1`; every section is `recorded` or `pending`
 * with a fixed reason, and `waveAExit` is derived from the sections, never asserted. By construction it
 * performs no write: database reads run inside `set transaction read only` with a statement timeout, the
 * object store only answers signed `GET ?lifecycle` and `GET ?uploads&max-uploads=1`, and the only child
 * processes are `storage-readiness.ts`, `supervisorctl status|tail` and `gh run list|view`.
 */
import type { SQL } from "bun";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { StudioDatabase } from "../packages/storage/src/database";
import { S3RequestError, isUnsupportedOperation, objectStoreConfig, parseErrorCode, parseListMultipartUploads, signRequest,
  xmlElement, type ObjectStoreConfig } from "../packages/storage/src/s3-requests";
import { readBackupStatus } from "../packages/observability/src/diagnostics";

export const SCHEMA = "hv-wave-a-exit/1";
export const SECTIONS = ["release", "database", "migrations", "workers", "objectStore", "readiness", "health", "backup", "ci"] as const;
export type Section = typeof SECTIONS[number];
export const WORKER_PROGRAMS = ["rough-cut-staging-worker", "rough-cut-staging-worker-2", "rough-cut-staging-worker-3"] as const;
export const CI_STEPS = ["unit + integration", "three-worker PostgreSQL and S3 flow", "private staging smoke"] as const;
export const SUPERVISOR_CONFIG = "/etc/zo/supervisord-user.conf";
export const FRESH_HEARTBEAT_SECONDS = 45;
const HEX40 = /^[a-f0-9]{40}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKER_NAME = /^[A-Za-z0-9_.:-]{1,80}$/, TAG = /^[0-9]{4}_[a-z0-9_]{1,80}$/, TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Every reason a section can carry. Probes never surface raw error text, URLs or identifiers. */
export const REASONS = [
  "runtime manifest unavailable", "runtime manifest failed shape checks", "release marker disagrees with manifest",
  "admin connection not configured", "admin connection is not hv_admin", "database unreachable", "database query failed",
  "migration journal unreadable", "no migration applied", "migration head not in journal", "supervisor status unavailable",
  "object store not configured", "object bucket does not match the deployment", "object store unreachable",
  "sweeper log unavailable", "sweeper status line missing", "sweeper has not reported incomplete uploads",
  "readiness script missing", "readiness environment unavailable", "readiness probe failed", "readiness output unparsable",
  "edge unreachable", "edge response malformed", "backup status unreadable",
  "gh unavailable", "gh command failed", "ci run not found", "ci run in progress", "ci run not for the release sha",
  "ci quality job missing", "ci quality steps missing",
] as const;
export type Reason = typeof REASONS[number] | `${Section} probe failed` | `${Section} probe timed out` | `${Section} data malformed`;
export const isKnownReason = (value: unknown): value is Reason => typeof value === "string" && ((REASONS as readonly string[]).includes(value)
  || SECTIONS.some(section => [`${section} probe failed`, `${section} probe timed out`, `${section} data malformed`].includes(value)));
export class ProbeFailure extends Error { constructor(readonly reason: Reason) { super(reason); this.name = "ProbeFailure"; } }
function fail(reason: Reason): never { throw new ProbeFailure(reason); }

export interface ReleaseData { sha: string; backend: string; expectedWorkers: number }
export interface DatabaseData { version: string; tables: number; forcedRowSecurity: number; counts: {projects: number; jobs: number; artifacts: number}; queue: {queued: number; running: number} }
export interface MigrationsData { applied: number; journalEntries: number; head: string; inSync: boolean }
export interface WorkersData { registered: number; expected: number; names: string[]; supervisor: Record<string,string>; freshWithinSeconds: number }
export type Lifecycle = "declared" | "absent" | "unsupported" | "pending";
export type MultipartListing = "supported" | "unsupported" | "pending";
export interface IncompleteUploads { aborted: number; retained: number; failed: number; supported: boolean }
export interface SweeperData { status: "recorded" | "pending"; reason?: Reason; sweptAt: string | null; incompleteUploads: IncompleteUploads | null }
export interface ObjectStoreData { endpointScheme: string; bucket: string; lifecycle: Lifecycle; daysAfterInitiation: number | null; multipartListing: MultipartListing; sweeper: SweeperData }
export interface ReadinessData { ready: boolean; databaseRole: string; privateObjectsAuthenticated: boolean; elapsedMs: number }
export interface HealthData { serviceStatus: string; queueDepth: number; runningJobs: number; monthSpendUsd: number }
export interface BackupData { state: string; lastCompletedAt: string | null; objects: number | null; localRepositoryOnly: true }
export interface CiData { runId: number; headSha: string; conclusion: string | null; steps: Record<string,string> }
export interface SectionData { release: ReleaseData; database: DatabaseData; migrations: MigrationsData; workers: WorkersData; objectStore: ObjectStoreData;
  readiness: ReadinessData; health: HealthData; backup: BackupData; ci: CiData }
type Nulled<T> = {[K in keyof T]: null};
export type SectionResult<K extends Section> = ({status: "recorded"} & SectionData[K]) | ({status: "pending"; reason: Reason} & Nulled<SectionData[K]>);
export type Sections = {[K in Section]: SectionResult<K>};
export interface WaveAExit { postgresBackend: boolean; s3Backend: boolean; workersRegistered: number | null; workersExpected: number | null;
  fleetAtLeastThree: boolean; migrationsInSync: boolean; readinessPassed: boolean; existingE2ePassing: boolean; satisfied: boolean }
export interface WaveAExitDocument extends Sections { schema: typeof SCHEMA; recordedAt: string; host: {runtimeRoot: string; bootId: string | null}; waveAExit: WaveAExit; newProviderSpendUsd: 0 }

// ---- shape checks: a recorded section carries exactly these non-null fields, nothing a probe happened to return ----
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, pattern = /^[\x20-\x7e]{1,200}$/): value is string => typeof value === "string" && pattern.test(value);
const isTimestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string,unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const SHAPES: {[K in Section]: (value: unknown) => SectionData[K] | null} = {
  release: v => record(v) && isText(v.sha, HEX40) && isText(v.backend, TOKEN) && isCount(v.expectedWorkers)
    ? {sha: v.sha, backend: v.backend, expectedWorkers: v.expectedWorkers} : null,
  database: v => record(v) && isText(v.version) && isCount(v.tables) && isCount(v.forcedRowSecurity) && record(v.counts) && record(v.queue)
    && isCount(v.counts.projects) && isCount(v.counts.jobs) && isCount(v.counts.artifacts) && isCount(v.queue.queued) && isCount(v.queue.running)
    ? {version: v.version, tables: v.tables, forcedRowSecurity: v.forcedRowSecurity, counts: {projects: v.counts.projects, jobs: v.counts.jobs, artifacts: v.counts.artifacts},
      queue: {queued: v.queue.queued, running: v.queue.running}} : null,
  migrations: v => record(v) && isCount(v.applied) && isCount(v.journalEntries) && isText(v.head, TAG) && typeof v.inSync === "boolean"
    ? {applied: v.applied, journalEntries: v.journalEntries, head: v.head, inSync: v.inSync} : null,
  workers: v => record(v) && isCount(v.registered) && isCount(v.expected) && Array.isArray(v.names) && v.names.every(name => isText(name, WORKER_NAME))
    && v.names.length === v.registered && record(v.supervisor) && WORKER_PROGRAMS.every(name => isText((v.supervisor as Record<string,unknown>)[name], /^[A-Z_]{1,32}$/)) && v.freshWithinSeconds === FRESH_HEARTBEAT_SECONDS
    ? {registered: v.registered, expected: v.expected, names: [...v.names as string[]].sort(), supervisor: Object.fromEntries(WORKER_PROGRAMS.map(name => [name, (v.supervisor as Record<string,string>)[name]!])),
      freshWithinSeconds: FRESH_HEARTBEAT_SECONDS} : null,
  objectStore: v => record(v) && ["https", "http"].includes(v.endpointScheme as string) && isText(v.bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    && ["declared", "absent", "unsupported", "pending"].includes(v.lifecycle as string) && (v.daysAfterInitiation === null || isCount(v.daysAfterInitiation))
    && (v.lifecycle === "declared") === (v.daysAfterInitiation !== null) && ["supported", "unsupported", "pending"].includes(v.multipartListing as string) && sweeperShape(v.sweeper)
    ? {endpointScheme: v.endpointScheme as string, bucket: v.bucket, lifecycle: v.lifecycle as Lifecycle, daysAfterInitiation: v.daysAfterInitiation as number | null,
      multipartListing: v.multipartListing as MultipartListing, sweeper: sweeperShape(v.sweeper)!} : null,
  readiness: v => record(v) && typeof v.ready === "boolean" && isText(v.databaseRole, TOKEN) && typeof v.privateObjectsAuthenticated === "boolean" && isCount(v.elapsedMs)
    ? {ready: v.ready, databaseRole: v.databaseRole, privateObjectsAuthenticated: v.privateObjectsAuthenticated, elapsedMs: v.elapsedMs} : null,
  health: v => record(v) && isText(v.serviceStatus, TOKEN) && isCount(v.queueDepth) && isCount(v.runningJobs) && typeof v.monthSpendUsd === "number" && Number.isFinite(v.monthSpendUsd) && v.monthSpendUsd >= 0
    ? {serviceStatus: v.serviceStatus, queueDepth: v.queueDepth, runningJobs: v.runningJobs, monthSpendUsd: v.monthSpendUsd} : null,
  backup: v => record(v) && ["running", "healthy", "degraded", "failed"].includes(v.state as string) && (v.lastCompletedAt === null || isTimestamp(v.lastCompletedAt))
    && (v.objects === null || isCount(v.objects)) && v.localRepositoryOnly === true
    ? {state: v.state as string, lastCompletedAt: v.lastCompletedAt as string | null, objects: v.objects as number | null, localRepositoryOnly: true} : null,
  ci: v => record(v) && isCount(v.runId) && isText(v.headSha, HEX40) && (v.conclusion === null || isText(v.conclusion, TOKEN)) && record(v.steps)
    && CI_STEPS.every(step => isText((v.steps as Record<string,unknown>)[step], TOKEN))
    ? {runId: v.runId, headSha: v.headSha, conclusion: v.conclusion as string | null, steps: Object.fromEntries(CI_STEPS.map(step => [step, (v.steps as Record<string,string>)[step]!]))} : null,
};
function sweeperShape(v: unknown): SweeperData | null {
  if (!record(v)) return null;
  if (v.status === "pending") return isKnownReason(v.reason) && v.sweptAt === null && v.incompleteUploads === null ? {status: "pending", reason: v.reason, sweptAt: null, incompleteUploads: null} : null;
  const u = v.incompleteUploads;
  return v.status === "recorded" && isTimestamp(v.sweptAt) && record(u) && isCount(u.aborted) && isCount(u.retained) && isCount(u.failed) && typeof u.supported === "boolean"
    ? {status: "recorded", sweptAt: v.sweptAt, incompleteUploads: {aborted: u.aborted, retained: u.retained, failed: u.failed, supported: u.supported}} : null;
}
const NULL_FIELDS: {[K in Section]: Nulled<SectionData[K]>} = {
  release: {sha: null, backend: null, expectedWorkers: null},
  database: {version: null, tables: null, forcedRowSecurity: null, counts: null, queue: null},
  migrations: {applied: null, journalEntries: null, head: null, inSync: null},
  workers: {registered: null, expected: null, names: null, supervisor: null, freshWithinSeconds: null},
  objectStore: {endpointScheme: null, bucket: null, lifecycle: null, daysAfterInitiation: null, multipartListing: null, sweeper: null},
  readiness: {ready: null, databaseRole: null, privateObjectsAuthenticated: null, elapsedMs: null},
  health: {serviceStatus: null, queueDepth: null, runningJobs: null, monthSpendUsd: null},
  backup: {state: null, lastCompletedAt: null, objects: null, localRepositoryOnly: null},
  ci: {runId: null, headSha: null, conclusion: null, steps: null},
};
export const pendingSection = <K extends Section>(section: K, reason: Reason): SectionResult<K> => ({status: "pending", reason, ...NULL_FIELDS[section]}) as SectionResult<K>;
/** Re-validates any section object (a probe result or a committed file) into the exact recorded/pending shape, or null. */
export function validateSection<K extends Section>(section: K, value: unknown): SectionResult<K> | null {
  if (!record(value)) return null;
  if (value.status === "pending") {
    if (!isKnownReason(value.reason)) return null;
    for (const key of Object.keys(NULL_FIELDS[section])) if (value[key] !== null) return null;
    return pendingSection(section, value.reason);
  }
  if (value.status !== "recorded") return null;
  const data = SHAPES[section](value);
  return data ? {status: "recorded", ...data} as SectionResult<K> : null;
}

// ---- derivation ----
export function deriveExit(sections: Sections): WaveAExit {
  const {release, database, migrations, workers, objectStore, readiness, ci} = sections;
  const postgresBackend = release.status === "recorded" && release.backend === "postgres" && database.status === "recorded";
  const s3Backend = objectStore.status === "recorded" && objectStore.endpointScheme === "https" && objectStore.lifecycle !== "pending" && objectStore.multipartListing !== "pending";
  const workersRegistered = workers.status === "recorded" ? workers.registered : null, workersExpected = workers.status === "recorded" ? workers.expected : null;
  const fleetAtLeastThree = workers.status === "recorded" && workers.registered >= 3 && workers.registered >= workers.expected
    && WORKER_PROGRAMS.every(name => workers.supervisor[name] === "RUNNING");
  const migrationsInSync = migrations.status === "recorded" && migrations.inSync === true;
  const readinessPassed = readiness.status === "recorded" && readiness.ready === true && readiness.databaseRole === "hv_api" && readiness.privateObjectsAuthenticated === true;
  const existingE2ePassing = ci.status === "recorded" && release.status === "recorded" && ci.headSha === release.sha && CI_STEPS.every(step => ci.steps[step] === "success");
  const satisfied = postgresBackend && s3Backend && fleetAtLeastThree && migrationsInSync && readinessPassed && existingE2ePassing;
  return {postgresBackend, s3Backend, workersRegistered, workersExpected, fleetAtLeastThree, migrationsInSync, readinessPassed, existingE2ePassing, satisfied};
}

// ---- collector ----
export interface ProbeContext { signal: AbortSignal }
export type Probe<T> = (context: ProbeContext) => Promise<T> | T;
export type Probes = {[K in Section]: Probe<SectionData[K]>};
export interface CollectOptions { runtimeRoot: string; bootId?: string | null; timeoutMs?: number; now?: () => number }
async function observe<K extends Section>(section: K, probe: Probe<SectionData[K]>, timeoutMs: number): Promise<SectionResult<K>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempt = Promise.resolve().then(() => probe({signal: controller.signal}));
    attempt.catch(() => {});
    const value = await Promise.race([attempt, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ProbeFailure(`${section} probe timed out`)); }, timeoutMs); })]);
    const data = SHAPES[section](value);
    return data ? {status: "recorded", ...data} as SectionResult<K> : pendingSection(section, `${section} data malformed`);
  } catch (error) {
    return pendingSection(section, error instanceof ProbeFailure ? error.reason : `${section} probe failed`);
  } finally { clearTimeout(timer); }
}
export async function collectWaveAExit(probes: Probes, options: CollectOptions): Promise<WaveAExitDocument> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("invalid probe timeout");
  const sections = {} as Sections;
  for (const section of SECTIONS) (sections as Record<Section,unknown>)[section] = await observe(section, probes[section] as Probe<SectionData[Section]>, timeoutMs);
  if (sections.ci.status === "recorded" && sections.release.status === "recorded" && sections.ci.headSha !== sections.release.sha)
    sections.ci = pendingSection("ci", "ci run not for the release sha");
  const bootId = options.bootId ?? null;
  return {schema: SCHEMA, recordedAt: new Date((options.now ?? Date.now)()).toISOString(),
    host: {runtimeRoot: options.runtimeRoot, bootId: bootId !== null && UUID.test(bootId) ? bootId : null},
    ...sections, waveAExit: deriveExit(sections), newProviderSpendUsd: 0};
}
/** Validates a whole document (e.g. the committed evidence) and returns it in canonical shape, or throws. */
export function validateDocument(value: unknown): WaveAExitDocument {
  if (!record(value) || value.schema !== SCHEMA || !isTimestamp(value.recordedAt) || value.newProviderSpendUsd !== 0 || !record(value.host)
    || !isText(value.host.runtimeRoot, /^\/[A-Za-z0-9_./-]{1,200}$/) || !(value.host.bootId === null || isText(value.host.bootId, UUID))) throw new Error("invalid wave A exit document");
  const sections = {} as Sections;
  for (const section of SECTIONS) {
    const result = validateSection(section, value[section]);
    if (!result) throw new Error("invalid wave A exit section: " + section);
    (sections as Record<Section,unknown>)[section] = result;
  }
  const waveAExit = deriveExit(sections);
  if (JSON.stringify(value.waveAExit) !== JSON.stringify(waveAExit)) throw new Error("wave A exit derivation does not match its sections");
  return {schema: SCHEMA, recordedAt: value.recordedAt, host: {runtimeRoot: value.host.runtimeRoot, bootId: value.host.bootId}, ...sections, waveAExit, newProviderSpendUsd: 0};
}

// ---- pure rules shared by the real probes and the offline tests ----
export interface WorkerRow { name: string; state: string; heartbeatAt: string | number | Date; id: string }
const millis = (value: string | number | Date): number => value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
/** Latest incarnation per name (heartbeat desc, id desc), counted only when fresh and idle/busy/draining. */
export function countWorkers(rows: WorkerRow[], nowMs: number, freshSeconds = FRESH_HEARTBEAT_SECONDS): {registered: number; names: string[]} {
  const latest = new Map<string,WorkerRow>();
  for (const row of rows) {
    const current = latest.get(row.name), beat = millis(row.heartbeatAt);
    if (!current || beat > millis(current.heartbeatAt) || (beat === millis(current.heartbeatAt) && row.id > current.id)) latest.set(row.name, row);
  }
  const names = [...latest.values()].filter(row => { const beat = millis(row.heartbeatAt); return beat <= nowMs && nowMs - beat <= freshSeconds * 1000 && ["idle", "busy", "draining"].includes(row.state); })
    .map(row => row.name).sort();
  return {registered: names.length, names};
}
export interface Journal { entries: {when: number; tag: string}[] }
export function resolveMigrations(journal: Journal, applied: number, latestCreatedAt: number | null): MigrationsData {
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) fail("migration journal unreadable");
  if (latestCreatedAt === null || applied === 0) fail("no migration applied");
  const head = journal.entries.find(entry => entry.when === latestCreatedAt)?.tag ?? fail("migration head not in journal");
  return {applied, journalEntries: journal.entries.length, head, inSync: applied === journal.entries.length && head === journal.entries.at(-1)!.tag};
}
export function readJournal(path: string): Journal {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!record(value) || !Array.isArray(value.entries) || !value.entries.every((entry: unknown) => record(entry) && isCount(entry.when) && isText(entry.tag, TAG))) fail("migration journal unreadable");
    return {entries: (value.entries as {when: number; tag: string}[]).map(entry => ({when: entry.when, tag: entry.tag}))};
  } catch (error) { throw error instanceof ProbeFailure ? error : new ProbeFailure("migration journal unreadable"); }
}
export function classifyLifecycle(status: number, body: string): {lifecycle: Lifecycle; daysAfterInitiation: number | null} {
  const code = parseErrorCode(body);
  if (status === 200) {
    const days = Number(xmlElement(xmlElement(body, "AbortIncompleteMultipartUpload") ?? "", "DaysAfterInitiation"));
    return Number.isSafeInteger(days) && days >= 1 ? {lifecycle: "declared", daysAfterInitiation: days} : {lifecycle: "pending", daysAfterInitiation: null};
  }
  if (status === 404 && code === "NoSuchLifecycleConfiguration") return {lifecycle: "absent", daysAfterInitiation: null};
  if (isUnsupportedOperation(new S3RequestError("", status, code))) return {lifecycle: "unsupported", daysAfterInitiation: null};
  return {lifecycle: "pending", daysAfterInitiation: null};
}
export function classifyMultipartListing(status: number, body: string): MultipartListing {
  if (status === 200) { try { parseListMultipartUploads(body); return "supported"; } catch { return "pending"; } }
  return isUnsupportedOperation(new S3RequestError("", status, parseErrorCode(body))) ? "unsupported" : "pending";
}
/** The last complete JSON status line of the sweeper's stdout; a trailing partial line never counts. */
export function parseSweeperStatus(text: string): SweeperData {
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  for (let index = lines.length - 1; index >= 0; index--) {
    let value: unknown;
    try { value = JSON.parse(lines[index]!); } catch { continue; }
    if (!record(value) || !isTimestamp(value.sweptAt) || !("incompleteUploads" in value)) continue;
    if (value.incompleteUploads === null) return {status: "pending", reason: "sweeper has not reported incomplete uploads", sweptAt: null, incompleteUploads: null};
    const sweeper = sweeperShape({status: "recorded", sweptAt: value.sweptAt, incompleteUploads: value.incompleteUploads});
    return sweeper ?? {status: "pending", reason: "sweeper status line missing", sweptAt: null, incompleteUploads: null};
  }
  return {status: "pending", reason: "sweeper status line missing", sweptAt: null, incompleteUploads: null};
}

// ---- runtime manifest (the same shape checks as storage-runtime-launch.py:deployment()) ----
export interface Manifest { schema: string; backend: string; workers: number; database: string; bucket: string; releaseSha: string; platformRoot: string; backupRepository: string }
function regular(path: string, privateFile = false): number {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (privateFile && (metadata.mode & 0o077) !== 0)) fail("runtime manifest failed shape checks");
  return metadata.size;
}
export function readDeployment(runtime: string): {manifest: Manifest; app: string} {
  let text: string;
  try { if (regular(join(runtime, "storage-deployment.json"), true) > 8192) fail("runtime manifest failed shape checks"); text = readFileSync(join(runtime, "storage-deployment.json"), "utf8"); }
  catch (error) { throw error instanceof ProbeFailure ? error : new ProbeFailure("runtime manifest unavailable"); }
  try {
    const value: unknown = JSON.parse(text);
    if (!record(value) || value.schema !== "hv-storage-deployment/1" || value.backend !== "postgres" || value.workers !== 3
      || !isText(value.database, /^[a-z][a-z0-9_]{0,62}$/) || !isText(value.bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/) || !isText(value.releaseSha, HEX40)
      || !isText(value.platformRoot, /^\/.{1,400}$/) || !isText(value.backupRepository, /^\/.{1,400}$/)) fail("runtime manifest failed shape checks");
    const platform = realpathSync(value.platformRoot);
    let backup = resolve(value.backupRepository);
    try { backup = realpathSync(backup); } catch {}
    if (!backup.startsWith(join(platform, "backups") + "/")) fail("runtime manifest failed shape checks");
    regular(join(runtime, "active-release.txt"));
    const app = realpathSync(readFileSync(join(runtime, "active-release.txt"), "utf8").trim());
    if (!app.startsWith(join(realpathSync(runtime), "releases") + "/")) fail("runtime manifest failed shape checks");
    regular(join(app, ".deployed-sha"));
    for (const name of ["run-api.sh", "run-worker.sh", "run-sweeper.sh", "run-backup.sh", "bin/bun"]) regular(join(runtime, name));
    if (readFileSync(join(app, ".deployed-sha"), "utf8").trim() !== value.releaseSha) fail("release marker disagrees with manifest");
    return {manifest: {schema: value.schema, backend: value.backend, workers: value.workers, database: value.database, bucket: value.bucket,
      releaseSha: value.releaseSha, platformRoot: value.platformRoot, backupRepository: value.backupRepository}, app};
  } catch (error) { throw error instanceof ProbeFailure ? error : new ProbeFailure("runtime manifest failed shape checks"); }
}
export const releaseProbe = (runtime: string): ReleaseData => { const {manifest} = readDeployment(runtime); return {sha: manifest.releaseSha, backend: manifest.backend, expectedWorkers: manifest.workers}; };
export function readBootId(runtime: string): string | null {
  try {
    if (regular(join(runtime, "storage-ready.json")) > 4096) return null;
    const value: unknown = JSON.parse(readFileSync(join(runtime, "storage-ready.json"), "utf8"));
    return record(value) && value.schema === "hv-storage-ready/1" && isText(value.bootId, UUID) ? value.bootId : null;
  } catch { return null; }
}

// ---- database: one read-only transaction with a statement timeout; hv_admin only ----
export async function withReadOnly<T>(url: string | undefined, fn: (tx: SQL) => Promise<T>, statementTimeoutMs = 10_000): Promise<T> {
  if (!url) fail("admin connection not configured");
  let user = "";
  try { user = new URL(url).username; } catch { fail("admin connection is not hv_admin"); }
  if (user !== "hv_admin") fail("admin connection is not hv_admin");
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 100 || statementTimeoutMs > 600_000) throw new Error("invalid statement timeout");
  let database: StudioDatabase;
  try { database = new StudioDatabase(url, 1, {connectionTimeout: 10}); await database.sql`select 1`; } catch { return fail("database unreachable"); }
  try {
    return await database.sql.begin(async tx => {
      try { await tx`set transaction read only`; await tx.unsafe("set local statement_timeout = '" + statementTimeoutMs + "ms'"); }
      catch { fail("database query failed"); }
      return fn(tx as unknown as SQL);
    }) as T;
  } finally { await database.close(); }
}
/** Runs several reads inside one read-only transaction; each is settled independently behind a savepoint. */
export async function readOnlyReads<T extends Record<string,(tx: SQL) => Promise<unknown>>>(url: string | undefined, reads: T, statementTimeoutMs = 10_000):
  Promise<{[K in keyof T]: () => Promise<Awaited<ReturnType<T[K]>>>}> {
  const settled: Record<string,{value?: unknown; error?: unknown}> = {};
  try {
    await withReadOnly(url, async tx => {
      for (const [name, read] of Object.entries(reads)) {
        await tx`savepoint probe`;
        try { settled[name] = {value: await read(tx)}; await tx`release savepoint probe`; }
        catch (error) { settled[name] = {error: error instanceof ProbeFailure ? error : new ProbeFailure("database query failed")}; await tx`rollback to savepoint probe`; }
      }
    }, statementTimeoutMs);
  } catch (error) { for (const name of Object.keys(reads)) settled[name] ??= {error: error instanceof ProbeFailure ? error : new ProbeFailure("database unreachable")}; }
  return Object.fromEntries(Object.keys(reads).map(name => [name, async () => { const outcome = settled[name] ?? {error: new ProbeFailure("database query failed")}; if (outcome.error) throw outcome.error; return outcome.value; }])) as
    {[K in keyof T]: () => Promise<Awaited<ReturnType<T[K]>>>};
}
const count = (value: unknown): number => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) fail("database query failed"); return result; };
export async function databaseProbe(tx: SQL): Promise<DatabaseData> {
  const [row] = await tx`select version() as version,
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'hv\\_%') as tables,
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'hv\\_%' and c.relrowsecurity and c.relforcerowsecurity) as forced,
    (select count(*) from hv_projects) as projects, (select count(*) from hv_jobs) as jobs, (select count(*) from hv_artifacts) as artifacts,
    q.queued, q.running from public.hv_queue_counts() q`;
  if (!row || !isText(row.version)) fail("database query failed");
  return {version: row.version, tables: count(row.tables), forcedRowSecurity: count(row.forced),
    counts: {projects: count(row.projects), jobs: count(row.jobs), artifacts: count(row.artifacts)}, queue: {queued: count(row.queued), running: count(row.running)}};
}
export async function migrationsProbe(tx: SQL, journalPath: string): Promise<MigrationsData> {
  const journal = readJournal(journalPath);
  const [row] = await tx`select count(*) as applied, max(created_at)::text as latest from drizzle.__drizzle_migrations`;
  if (!row) fail("database query failed");
  return resolveMigrations(journal, count(row.applied), row.latest === null ? null : count(row.latest));
}
export async function workerRows(tx: SQL): Promise<{rows: WorkerRow[]; observedAt: number}> {
  const rows = await tx`select distinct on (body->>'name') body->>'name' as name, body->>'state' as state, id,
    (extract(epoch from heartbeat_at) * 1000)::bigint::text as heartbeat_ms, (extract(epoch from now()) * 1000)::bigint::text as observed_ms
    from hv_workers where body->>'name' is not null order by body->>'name', heartbeat_at desc, id desc`;
  const observedAt = rows.length ? count(rows[0].observed_ms) : Date.now();
  return {observedAt, rows: rows.map((row: Record<string,unknown>) => ({name: String(row.name), state: String(row.state ?? ""), heartbeatAt: count(row.heartbeat_ms), id: String(row.id)}))};
}
export function workersProbe(observed: {rows: WorkerRow[]; observedAt: number}, expected: number, supervisor: Record<string,string>): WorkersData {
  const {registered, names} = countWorkers(observed.rows, observed.observedAt);
  return {registered, expected, names, supervisor: Object.fromEntries(WORKER_PROGRAMS.map(name => [name, supervisor[name] ?? "MISSING"])), freshWithinSeconds: FRESH_HEARTBEAT_SECONDS};
}

// ---- subprocesses ----
export interface RunOptions { cwd?: string; env?: Record<string,string>; signal?: AbortSignal }
export interface RunResult { exitCode: number | null; stdout: string; stderr: string }
export type Runner = (command: string[], options: RunOptions) => Promise<RunResult>;
const inherited = (...keys: string[]): Record<string,string> => Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
/** Bun.spawn with a minimal environment; a missing executable surfaces as an error with code ENOENT. */
export const spawnRunner: Runner = async (command, options) => {
  let child: ReturnType<typeof Bun.spawn>;
  try { child = Bun.spawn(command, {cwd: options.cwd, env: options.env ?? inherited("PATH"), stdin: "ignore", stdout: "pipe", stderr: "pipe"}); }
  catch (error) { throw Object.assign(new Error("spawn failed"), {code: (error as {code?: string}).code ?? "ENOENT"}); }
  const abort = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", abort, {once: true});
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited]);
    return {exitCode, stdout, stderr};
  } finally { options.signal?.removeEventListener("abort", abort); }
};
const missing = (error: unknown): boolean => (error as {code?: string}).code === "ENOENT";
export async function supervisorProbe(run: Runner, signal?: AbortSignal): Promise<Record<string,string>> {
  let result: RunResult;
  try { result = await run(["supervisorctl", "-c", SUPERVISOR_CONFIG, "status"], {env: inherited("PATH", "HOME"), signal}); }
  catch { return fail("supervisor status unavailable"); }
  const states: Record<string,string> = {};
  for (const line of result.stdout.split("\n")) { const match = /^(\S+)\s+([A-Z_]+)/.exec(line); if (match) states[match[1]!] = match[2]!; }
  if (Object.keys(states).length === 0) fail("supervisor status unavailable");
  return states;
}
export async function sweeperProbe(run: Runner, signal?: AbortSignal): Promise<SweeperData> {
  try {
    const result = await run(["supervisorctl", "-c", SUPERVISOR_CONFIG, "tail", "-65536", "rough-cut-staging-sweeper", "stdout"], {env: inherited("PATH", "HOME"), signal});
    if (result.exitCode !== 0 || !result.stdout) fail("sweeper log unavailable");
    return parseSweeperStatus(result.stdout);
  } catch (error) { return {status: "pending", reason: error instanceof ProbeFailure ? error.reason : "sweeper log unavailable", sweptAt: null, incompleteUploads: null}; }
}
export type FetchLike = (url: string, init: {method: "GET"; headers?: Record<string,string>; signal?: AbortSignal}) => Promise<Response>;
export interface ObjectStoreProbeInput { config: ObjectStoreConfig; expectedBucket?: string; fetchImpl?: FetchLike; signal?: AbortSignal; sweeper: () => Promise<SweeperData> }
/** Two signed bucket-level GETs and the sweeper's last status line; nothing is created, changed or deleted. */
export async function objectStoreProbe(input: ObjectStoreProbeInput): Promise<ObjectStoreData> {
  const {config} = input, fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));
  if (input.expectedBucket !== undefined && config.bucket !== input.expectedBucket) fail("object bucket does not match the deployment");
  const get = async (query: Record<string,string>): Promise<{status: number; body: string}> => {
    const signed = signRequest(config, {method: "GET", query});
    try { const response = await fetchImpl(signed.url, {method: "GET", headers: signed.headers, signal: input.signal}); return {status: response.status, body: await response.text()}; }
    catch { return fail("object store unreachable"); }
  };
  const lifecycle = await get({lifecycle: ""}), uploads = await get({uploads: "", "max-uploads": "1"});
  return {endpointScheme: config.endpoint.protocol.replace(/:$/, ""), bucket: config.bucket, ...classifyLifecycle(lifecycle.status, lifecycle.body),
    multipartListing: classifyMultipartListing(uploads.status, uploads.body), sweeper: await input.sweeper()};
}
export interface ReadinessInput { runtime: string; app: string; run: Runner; signal?: AbortSignal; bun?: string }
/** `storage-readiness.ts` under the hv_api role file, exactly as the launcher runs it; the admin connection never reaches it. */
export async function readinessProbe(input: ReadinessInput): Promise<ReadinessData> {
  const script = join(input.app, "scripts/storage-readiness.ts"), envFile = join(input.runtime, "storage-api.env"), bun = input.bun ?? join(input.runtime, "bin/bun");
  try { if (!lstatSync(script).isFile()) fail("readiness script missing"); } catch (error) { throw error instanceof ProbeFailure ? error : new ProbeFailure("readiness script missing"); }
  try { if (!lstatSync(envFile).isFile() || !lstatSync(bun).isFile()) fail("readiness environment unavailable"); } catch (error) { throw error instanceof ProbeFailure ? error : new ProbeFailure("readiness environment unavailable"); }
  const shell = 'set -a; . "$0"; set +a; export HV_STORAGE=postgres HV_ARTIFACT_STORAGE=s3; cd "$1" && exec "$2" "$3"';
  const started = Date.now();
  let result: RunResult;
  try { result = await input.run(["bash", "-c", shell, envFile, input.app, bun, script], {cwd: input.app, env: inherited("PATH"), signal: input.signal}); }
  catch { return fail("readiness probe failed"); }
  if (input.signal?.aborted) fail("readiness probe timed out");
  if (result.exitCode !== 0) fail("readiness probe failed");
  let value: unknown;
  try { value = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? ""); } catch { fail("readiness output unparsable"); }
  if (!record(value) || typeof value.ready !== "boolean" || !isText(value.databaseRole, TOKEN) || typeof value.privateObjectsAuthenticated !== "boolean") fail("readiness output unparsable");
  return {ready: value.ready, databaseRole: value.databaseRole, privateObjectsAuthenticated: value.privateObjectsAuthenticated, elapsedMs: Date.now() - started};
}
export async function healthProbe(fetchImpl: FetchLike = (url, init) => fetch(url, init), origin = "http://127.0.0.1:8081", timeoutMs = 5000): Promise<HealthData> {
  let value: unknown;
  try { const response = await fetchImpl(origin + "/health", {method: "GET", signal: AbortSignal.timeout(timeoutMs)}); if (!response.ok) fail("edge unreachable"); value = await response.json(); }
  catch (error) { throw error instanceof ProbeFailure ? error : new ProbeFailure("edge unreachable"); }
  return SHAPES.health(record(value) ? {serviceStatus: value.status, queueDepth: value.queueDepth, runningJobs: value.runningJobs, monthSpendUsd: value.monthSpendUsd} : null) ?? fail("edge response malformed");
}
export async function backupProbe(path: string): Promise<BackupData> {
  try { const status = await readBackupStatus(path); return {state: status.state, lastCompletedAt: status.lastCompletedAt, objects: status.objects, localRepositoryOnly: true}; }
  catch { return fail("backup status unreadable"); }
}
export interface CiInput { sha: string; runId?: number; run: Runner; cwd: string; signal?: AbortSignal }
/** `gh run list`/`gh run view` for the ci workflow on main; the quality job's three named steps, pinned to the sha. */
export async function ciProbe(input: CiInput): Promise<CiData> {
  const env = inherited("PATH", "HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "GH_HOST");
  const gh = async (args: string[], fallback?: string[]): Promise<unknown> => {
    let result: RunResult;
    try { result = await input.run(["gh", ...args], {cwd: input.cwd, env, signal: input.signal}); } catch (error) { return fail(missing(error) ? "gh unavailable" : "gh command failed"); }
    if (result.exitCode !== 0) return fallback ? gh(fallback) : fail("gh command failed"); // an older gh without --commit lists the branch instead; the sha filter below still applies
    try { return JSON.parse(result.stdout); } catch { return fail("gh command failed"); }
  };
  let runId = input.runId;
  if (runId === undefined) {
    const fields = "databaseId,status,conclusion,headSha,event";
    const runs = await gh(["run", "list", "--workflow", "ci", "--branch", "main", "--commit", input.sha, "--limit", "10", "--json", fields],
      ["run", "list", "--workflow", "ci", "--branch", "main", "--limit", "100", "--json", fields]);
    const match = Array.isArray(runs) ? runs.find(run => record(run) && run.headSha === input.sha && run.event === "push" && isCount(run.databaseId)) : undefined; // only the push-to-main run counts as the E2E evidence
    if (!match) fail("ci run not found");
    runId = (match as {databaseId: number}).databaseId;
  }
  if (!isCount(runId)) fail("ci run not found");
  const view = await gh(["run", "view", String(runId), "--json", "headSha,status,conclusion,jobs"]);
  if (!record(view) || !isText(view.headSha, HEX40) || !isText(view.status, TOKEN)) fail("ci run not found");
  if (view.headSha !== input.sha) fail("ci run not for the release sha");
  if (view.status !== "completed") fail("ci run in progress");
  const quality = Array.isArray(view.jobs) ? view.jobs.find(job => record(job) && job.name === "quality") : undefined;
  if (!record(quality)) fail("ci quality job missing");
  const steps: Record<string,string> = {};
  for (const step of Array.isArray(quality.steps) ? quality.steps : []) if (record(step) && isText(step.name) && (CI_STEPS as readonly string[]).includes(step.name) && isText(step.conclusion, TOKEN)) steps[step.name] = step.conclusion;
  if (!CI_STEPS.every(step => step in steps)) fail("ci quality steps missing");
  return {runId, headSha: view.headSha, conclusion: isText(view.conclusion, TOKEN) ? view.conclusion : null, steps};
}

// ---- entry point ----
export function writeAtomically(path: string, text: string): void {
  const pending = join(dirname(path), "." + crypto.randomUUID() + ".pending");
  try { writeFileSync(pending, text, {flag: "wx"}); renameSync(pending, path); }
  finally { try { unlinkSync(pending); } catch {} }
}
if (import.meta.main) {
  const {values} = parseArgs({args: process.argv.slice(2), options: {help: {type: "boolean"}, runtime: {type: "string"}, repo: {type: "string"}, output: {type: "string"},
    "ci-run": {type: "string"}, "require-satisfied": {type: "boolean"}, "timeout-ms": {type: "string"}}, strict: true});
  if (values.help || !values.runtime || !values.repo) {
    console.log("Read-only Wave A exit evidence: --runtime RUNTIME_ROOT --repo CHECKOUT [--output FILE] [--ci-run ID] [--require-satisfied] [--timeout-ms 120000]\n"
      + "Sources hv_admin and object credentials only from the environment (set -a; source RUNTIME/storage-backup.env). Never writes to staging.");
    process.exit(values.help ? 0 : 2);
  }
  const timeoutMs = Number(values["timeout-ms"] ?? "120000"), url = process.env.HV_PG_ADMIN_URL;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) { console.error("invalid --timeout-ms"); process.exit(2); }
  const ciRun = values["ci-run"] === undefined ? undefined : Number(values["ci-run"]);
  if (ciRun !== undefined && !isCount(ciRun)) { console.error("invalid --ci-run"); process.exit(2); }
  if (url !== undefined) { let user = ""; try { user = new URL(url).username; } catch {} if (user !== "hv_admin") { console.error("refusing to run: HV_PG_ADMIN_URL must name the hv_admin role"); process.exit(2); } }
  const runtime = resolve(values.runtime), repo = resolve(values.repo), journalPath = join(repo, "infra/drizzle/meta/_journal.json");
  let deployment: {value?: ReturnType<typeof readDeployment>; error?: ProbeFailure};
  try { deployment = {value: readDeployment(runtime)}; } catch (error) { deployment = {error: error instanceof ProbeFailure ? error : new ProbeFailure("runtime manifest unavailable")}; }
  const need = () => { if (deployment.error) throw deployment.error; return deployment.value!; };
  const reads = await readOnlyReads(url, {database: databaseProbe, migrations: tx => migrationsProbe(tx, journalPath), workers: workerRows});
  const probes: Probes = {
    release: () => releaseProbe(runtime),
    database: reads.database,
    migrations: reads.migrations,
    workers: async ({signal}) => workersProbe(await reads.workers(), need().manifest.workers, await supervisorProbe(spawnRunner, signal)),
    objectStore: ({signal}) => { let config: ObjectStoreConfig; try { config = objectStoreConfig(process.env); } catch { return fail("object store not configured"); }
      return objectStoreProbe({config, expectedBucket: need().manifest.bucket, signal, sweeper: () => sweeperProbe(spawnRunner, signal)}); },
    readiness: ({signal}) => readinessProbe({runtime, app: need().app, run: spawnRunner, signal}),
    health: () => healthProbe(),
    backup: () => backupProbe(join(need().manifest.backupRepository, "service-status.json")),
    ci: ({signal}) => ciProbe({sha: need().manifest.releaseSha, runId: ciRun, run: spawnRunner, cwd: repo, signal}),
  };
  const document = await collectWaveAExit(probes, {runtimeRoot: runtime, bootId: readBootId(runtime), timeoutMs});
  const text = JSON.stringify(document, null, 2) + "\n";
  if (values.output) writeAtomically(resolve(values.output), text);
  process.stdout.write(text);
  if (values["require-satisfied"] && !document.waveAExit.satisfied) process.exitCode = 1;
}
