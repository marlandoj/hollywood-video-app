import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PersistedProject, PersistedState, ReviewLink } from "../../api/src/index";
import type { BudgetReservation, CostEvent, ReviewItem } from "../../operator/src/index";
import type { Job } from "../../queue/src/index";
import { artifactKey } from "./artifacts";
import { StudioDatabase } from "./database";

export interface StateSnapshot {
  schema: "hv-state/1"; projects: PersistedState; jobs: Job[];
  ledger: {events: CostEvent[]; reservations: BudgetReservation[]}; reviews: ReviewItem[];
}
const FILES = ["state/projects.json", "queue/jobs.json", "state/cost-ledger.json", "state/operator-review-queue.json"] as const;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const identifier = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const finite = (value: unknown, max = 1e12): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error("duplicate " + label + " in snapshot");
}
export function validateSnapshot(value: StateSnapshot): StateSnapshot {
  if (value.schema !== "hv-state/1" || value.projects?.version !== 1 || !Array.isArray(value.projects.projects)
    || !Array.isArray(value.projects.reviewLinks) || !Array.isArray(value.projects.takenDown) || !Array.isArray(value.projects.takedownLog)
    || !Array.isArray(value.jobs) || !Array.isArray(value.ledger?.events) || !Array.isArray(value.ledger.reservations)
    || !Array.isArray(value.reviews)) throw new Error("unsupported state snapshot");
  if (value.projects.projects.length > 100_000 || value.jobs.length > 1_000_000 || value.ledger.events.length > 10_000_000) throw new Error("state snapshot exceeds its record limit");
  for (const project of value.projects.projects) {
    if (!identifier(project.id) || !date(project.createdAt) || !date(project.deleteAfter) || !Array.isArray(project.versions)
      || !Array.isArray(project.animaticApprovals) || !Array.isArray(project.operatorExtensions)
      || (project.rightsAttestedAt !== null && !date(project.rightsAttestedAt))) throw new Error("invalid project snapshot");
    let previous = 0;
    for (const version of project.versions) {
      if (!Number.isSafeInteger(version.version) || version.version <= previous || !text(version.text, 200_000)) throw new Error("invalid screenplay version");
      previous = version.version;
    }
    for (const approval of project.animaticApprovals) if (!identifier(approval.animaticJobId)
      || !Number.isSafeInteger(approval.scriptVersion) || !["approved", "changes_requested"].includes(approval.decision)
      || !date(approval.at) || !text(approval.note, 2000)) throw new Error("invalid animatic decision");
  }
  unique(value.projects.projects.map(project => project.id), "project");
  unique(value.projects.takenDown, "takedown");
  const projectIds = new Set(value.projects.projects.map(project => project.id));
  for (const id of value.projects.takenDown) if (!identifier(id) || projectIds.has(id)) throw new Error("invalid project tombstone");
  for (const link of value.projects.reviewLinks) if (!text(link.token, 4096) || !identifier(link.projectId)
    || !projectIds.has(link.projectId) || !["read","approve"].includes(link.permission) || !Number.isSafeInteger(link.views)
    || link.views < 0 || typeof link.revoked !== "boolean") throw new Error("invalid review link");
  unique(value.projects.reviewLinks.map(link => link.token), "review link");
  for (const event of value.projects.takedownLog) if (!identifier(event.projectId) || !date(event.at) || !text(event.reason,2000))
    throw new Error("invalid takedown history");
  for (const item of value.reviews) if (!identifier(item.projectId) || !text(item.shotId,256) || !finite(item.score,1)
    || !date(item.queuedAt) || typeof item.resolved !== "boolean") throw new Error("invalid operator review");
  for (const job of value.jobs) {
    if (!identifier(job.id) || !identifier(job.projectId) || !text(job.idempotencyKey, 512) || !text(job.scriptText, 200_000)
      || !["animatic","final"].includes(job.stage) || !["free","elevated"].includes(job.tier)
      || !["done","failed","cancelled"].includes(job.status) || !finite(job.costUsd) || !finite(job.costCapUsd)
      || !Number.isSafeInteger(job.scriptVersion) || !Number.isSafeInteger(job.checkpointShots) || job.checkpointShots < 0
      || !Number.isSafeInteger(job.checkpointFrame) || job.checkpointFrame < 0 || !Array.isArray(job.notifications))
      throw new Error("snapshot requires valid, drained jobs");
    if (job.output) for (const path of [job.output.mp4Path,job.output.hlsPlaylistPath,job.output.captionsPath,job.output.manifestPath,
      ...(job.output.storyboard ?? []).map(frame => frame.path)]) artifactKey(path, job.projectId, job.id);
  }
  unique(value.jobs.map(job => job.id), "job");
  unique(value.jobs.map(job => job.projectId + ":" + job.idempotencyKey), "job idempotency key");
  for (const event of value.ledger.events) if (!identifier(event.projectId) || !text(event.shotId, 256) || !date(event.at)
    || !text(event.provider, 256) || !text(event.model, 1024) || !finite(event.total_cost_usd, 1e9)
    || !finite(event.gpu_seconds) || !finite(event.prompt_tokens) || !finite(event.output_frames)
    || (event.jobId !== undefined && !identifier(event.jobId))) throw new Error("invalid cost event");
  unique(value.ledger.events.flatMap(event => event.eventId ? [event.eventId] : []), "billing event key");
  if (value.ledger.reservations.length) throw new Error("resolve all budget reservations before snapshot migration");
  return value;
}
export function snapshotSummary(snapshot: StateSnapshot) {
  return {projects: snapshot.projects.projects.length, reviewLinks: snapshot.projects.reviewLinks.length,
    tombstones: snapshot.projects.takenDown.length, jobs: snapshot.jobs.length, costEvents: snapshot.ledger.events.length,
    totalUsd: Number(snapshot.ledger.events.reduce((sum,event) => sum + event.total_cost_usd, 0).toFixed(6)),
    operatorReviews: snapshot.reviews.length};
}
export function readStateSnapshot(directory: string): StateSnapshot {
  const root = resolve(directory);
  const bytes = FILES.map((file,index) => {
    const path = resolve(root,file);
    if (!existsSync(path) && index === 3) return "[]";
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 256 * 1024 ** 2) throw new Error("snapshot state file exceeds 256 MiB or is not a file");
    const data = readFileSync(path);
    return data.toString("utf8");
  });
  const manifestPath = resolve(root,"snapshot.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath,"utf8")) as {schema: string; files: Record<string,string>};
    if (manifest.schema !== "hv-state/1") throw new Error("unknown snapshot schema");
    FILES.forEach((file,index) => { if (manifest.files[file] !== hash(bytes[index]!)) throw new Error("snapshot checksum mismatch"); });
  }
  const cost = JSON.parse(bytes[2]!) as CostEvent[] | StateSnapshot["ledger"];
  return validateSnapshot({schema:"hv-state/1",projects:JSON.parse(bytes[0]!),jobs:JSON.parse(bytes[1]!),
    ledger:Array.isArray(cost) ? {events:cost,reservations:[]} : cost,reviews:JSON.parse(bytes[3]!)});
}
export function writeStateSnapshot(directory: string, snapshot: StateSnapshot): {directory: string; digest: string} {
  validateSnapshot(snapshot);
  const destination = resolve(directory);
  if (existsSync(destination)) throw new Error("snapshot destination already exists");
  mkdirSync(dirname(destination),{recursive:true});
  const temporary = destination + "." + crypto.randomUUID() + ".pending";
  mkdirSync(temporary,{mode:0o700});
  const files: Record<string,string> = {};
  const parts = [snapshot.projects,snapshot.jobs,snapshot.ledger,snapshot.reviews];
  FILES.forEach((file,index) => {
    const path = resolve(temporary,file), bytes = JSON.stringify(parts[index],null,2) + "\n";
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const descriptor = openSync(path,"wx",0o600);
    try { writeFileSync(descriptor,bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    files[file] = hash(bytes);
  });
  const manifest = JSON.stringify({schema:"hv-state/1",files,summary:snapshotSummary(snapshot)},null,2) + "\n";
  const descriptor = openSync(resolve(temporary,"snapshot.json"),"wx",0o600);
  try { writeFileSync(descriptor,manifest); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  for (const path of [resolve(temporary,"state"),resolve(temporary,"queue"),temporary]) {
    const descriptor = openSync(path,"r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  renameSync(temporary,destination);
  const parent = openSync(dirname(destination),"r");
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return {directory:destination,digest:hash(manifest)};
}
export async function importStateSnapshot(database: StudioDatabase, snapshot: StateSnapshot, monthlyCapUsd: number): Promise<ReturnType<typeof snapshotSummary>> {
  validateSnapshot(snapshot);
  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0) throw new Error("invalid operator budget");
  const digest = hash(JSON.stringify(snapshot));
  await database.sql.begin(async transaction => {
    const tx = transaction as unknown as SQL;
    await tx`select pg_advisory_xact_lock(91271, 1)`;
    if ((await tx`select current_user as role`)[0].role !== "hv_admin") throw new Error("state import requires the migration role");
    const count = (await tx`select (select count(*) from hv_projects) + (select count(*) from hv_reviews) +
      (select count(*) from hv_jobs) + (select count(*) from hv_cost_events) + (select count(*) from hv_reservations) +
      (select count(*) from hv_provider_attempts) + (select count(*) from hv_artifacts) + (select count(*) from hv_archives) +
      (select count(*) from hv_operator_reviews) + (select count(*) from hv_workers) + (select count(*) from hv_outbox) as total`)[0].total;
    if (Number(count) !== 0) throw new Error("state import requires an empty destination database");
    for (const project of snapshot.projects.projects) await tx`insert into hv_projects (id,body,created_at,delete_after)
      values (${project.id},${project}::jsonb,${project.createdAt},${project.deleteAfter})`;
    for (const id of snapshot.projects.takenDown) {
      const event = snapshot.projects.takedownLog.find(event => event.projectId === id);
      const at = event?.at ?? new Date().toISOString();
      await tx`insert into hv_projects (id,body,delete_after,taken_down_at,takedown_reason)
        values (${id},'{}'::jsonb,${new Date(Date.parse(at) + 30 * 864e5).toISOString()},${at},${event?.reason ?? "takedown"})`;
    }
    for (const link of snapshot.projects.reviewLinks) await tx`insert into hv_reviews (token_hash,project_id,body)
      values (${hash(link.token)},${link.projectId},${link}::jsonb)`;
    for (const original of snapshot.jobs) {
      const job = {...original,claimedBy:null,leaseExpiresAt:null,leaseVersion:original.leaseVersion ?? 0};
      await tx`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body,lease_version)
        values (${job.id},${job.projectId},${job.idempotencyKey},${job.stage},${job.status},${job.tier},${job}::jsonb,${job.leaseVersion})`;
    }
    for (const [index,event] of snapshot.ledger.events.entries()) await tx`insert into hv_cost_events
      (id,event_key,project_id,job_id,attempt_id,stage,provider,total_usd,body,created_at)
      values (${crypto.randomUUID()},${event.eventId ?? "legacy:" + digest + ":" + index},${event.projectId},${event.jobId ?? null},
        ${event.attemptId ?? null},${event.stage ?? null},${event.provider},${event.total_cost_usd},${event}::jsonb,${event.at})`;
    for (const item of snapshot.reviews) await tx`insert into hv_operator_reviews (id,project_id,shot_id,body,resolved_at)
      values (${crypto.randomUUID()},${item.projectId},${item.shotId},${item}::jsonb,${item.resolved ? new Date().toISOString() : null})`;
    await tx`insert into hv_budget_accounts (id,monthly_cap_usd) values ('operator',${monthlyCapUsd})
      on conflict (id) do update set monthly_cap_usd = excluded.monthly_cap_usd, updated_at = now()`;
  });
  return snapshotSummary(snapshot);
}
export async function exportStateSnapshot(database: StudioDatabase): Promise<StateSnapshot> {
  return await database.sql.begin(async transaction => {
    const tx = transaction as unknown as SQL;
    await tx`set transaction isolation level repeatable read, read only`;
    if ((await tx`select current_user as role`)[0].role !== "hv_admin") throw new Error("state export requires the migration role");
    const pending = await tx`select id from hv_provider_attempts where status in ('running','unknown') limit 1`;
    if (pending.length) throw new Error("provider billing must be reconciled before rollback export");
    const rows = await tx`select id,body,taken_down_at,takedown_reason from hv_projects order by id`;
    const projects: PersistedState = {version:1,projects:[],reviewLinks:[],takenDown:[],takedownLog:[]};
    for (const row of rows) {
      if (row.taken_down_at) {
        projects.takenDown.push(row.id);
        projects.takedownLog.push({projectId:row.id,at:new Date(row.taken_down_at).toISOString(),reason:row.takedown_reason});
      } else projects.projects.push(row.body as PersistedProject);
    }
    projects.reviewLinks = (await tx`select body from hv_reviews order by token_hash`).map((row: {body: ReviewLink}) => row.body);
    const jobs = (await tx`select body from hv_jobs order by queued_at,id`).map((row: {body: Job}) => row.body);
    const events = (await tx`select body,event_key from hv_cost_events order by created_at,id`)
      .map((row: {body: CostEvent;event_key: string}) => ({...row.body,eventId:row.event_key}));
    const reservations = (await tx`select body from hv_reservations order by job_id`).map((row: {body: BudgetReservation}) => row.body);
    const reviews = (await tx`select body from hv_operator_reviews order by id`).map((row: {body: ReviewItem}) => row.body);
    return validateSnapshot({schema:"hv-state/1",projects,jobs,ledger:{events,reservations},reviews});
  }) as StateSnapshot;
}
