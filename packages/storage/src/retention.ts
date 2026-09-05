import type { SQL, S3Client } from "bun";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { objectClient } from "./artifacts";
import { StudioDatabase } from "./database";

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const projectFromKey = (key: string): string | null => {
  const parts = key.split("/");
  return ["v1","archives"].includes(parts[0] ?? "") && idPattern.test(parts[1] ?? "") ? parts[1]! : null;
};
export class PostgresRetention {
  private readonly cursors = new Map<string,string>();
  constructor(private readonly database: StudioDatabase, private readonly client?: Pick<S3Client,"list"|"file">) {}
  /** Revoke access and erase content atomically; financial receipts and unknown holds survive. */
  async purgeProject(projectId: string, now = Date.now()): Promise<boolean> {
    if (!idPattern.test(projectId)) throw new Error("invalid retention project");
    return this.database.forProject(projectId,async tx => {
      // Billing always locks this row before project/job rows. Keep that lock order.
      await tx`select id from hv_budget_accounts where id = 'operator' for update`;
      const rows = await tx`select id from hv_projects where id = ${projectId} and purged_at is null
        and (taken_down_at is not null or delete_after <= ${new Date(now).toISOString()}) for update`;
      if (!rows.length) return false;
      const jobs = await tx`select id from hv_jobs where project_id = ${projectId} for update`;
      await tx`delete from hv_reviews where project_id = ${projectId}`;
      await tx`delete from hv_operator_reviews where project_id = ${projectId}`;
      await tx`delete from hv_outbox where project_id = ${projectId}`;
      await tx`delete from hv_artifacts where project_id = ${projectId}`;
      await tx`delete from hv_archives where project_id = ${projectId}`;
      // Request ids, provider names and numeric costs remain for late-bill reconciliation.
      await tx`update hv_provider_attempts set body = '{}'::jsonb where project_id = ${projectId}`;
      for (const job of jobs) {
        const liability = Number((await tx`select coalesce(sum(greatest(0,estimated_usd-coalesce(actual_usd,0))),0) as total
          from hv_provider_attempts where job_id = ${job.id} and status in ('running','unknown')`)[0].total);
        if (liability === 0) await tx`delete from hv_reservations where job_id = ${job.id}`;
        else await tx`update hv_reservations set remaining_usd = least(remaining_usd,${liability}),
          body = jsonb_set(body,'{remainingUsd}',to_jsonb(least(remaining_usd,${liability}))) where job_id = ${job.id}`;
      }
      await tx`delete from hv_jobs where project_id = ${projectId}`;
      await tx`update hv_projects set body = '{}'::jsonb, taken_down_at = coalesce(taken_down_at,${new Date(now).toISOString()}),
        takedown_reason = 'content removed', purged_at = ${new Date(now).toISOString()}, version = version+1 where id = ${projectId}`;
      await tx`insert into hv_outbox (id,project_id,event_type,body)
        values (${crypto.randomUUID()},${projectId},'storage.project.delete',${{projectId}}::jsonb)`;
      return true;
    });
  }
  async sweep(now = Date.now(), limit = 100): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid retention batch limit");
    const rows = await this.database.sql`select id from hv_projects where purged_at is null
      and (taken_down_at is not null or delete_after <= ${new Date(now).toISOString()}) order by delete_after,id limit ${limit}`;
    const removed: string[] = [];
    for (const row of rows) if (await this.purgeProject(row.id,now)) removed.push(row.id);
    return removed;
  }
  /** Clear abandoned process caches for purged projects; never follow a worker-directory link. */
  async clearLocalCaches(cacheRoot: string): Promise<number> {
    if (!existsSync(cacheRoot)) return 0;
    const root = realpathSync(cacheRoot), roots = [root], workers = resolve(root,".workers");
    if (existsSync(workers)) {
      if (lstatSync(workers).isSymbolicLink()) throw new Error("worker cache root is a symbolic link");
      for (const entry of readdirSync(workers,{withFileTypes:true})) {
        if (entry.isSymbolicLink()) throw new Error("worker cache directory is a symbolic link");
        if (entry.isDirectory() && idPattern.test(entry.name)) roots.push(resolve(workers,entry.name));
      }
    }
    const projects = await this.database.sql`select id from hv_projects where purged_at is not null`;
    let removed = 0;
    for (const project of projects) {
      if (!idPattern.test(project.id)) throw new Error("invalid purged project id");
      for (const directory of roots) {
        const path = resolve(directory,project.id);
        if (!path.startsWith(root+sep) || !path.startsWith(directory+sep)) throw new Error("cache deletion escaped its root");
        if (existsSync(path)) {rmSync(path,{recursive:true,force:true});removed++;}
      }
    }
    return removed;
  }
  /** A failed S3 delete leaves the outbox task pending, so retry never restores access. */
  async drain(limit = 10): Promise<{projects: number; objects: number}> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid deletion batch limit");
    const client = this.client ?? objectClient();
    let projects = 0, objects = 0;
    for (let index = 0; index < limit; index++) {
      const result = await this.database.sql.begin(async transaction => {
        const tx = transaction as unknown as SQL;
        const task = (await tx`select id,project_id from hv_outbox where event_type = 'storage.project.delete'
          and published_at is null order by created_at,id for update skip locked limit 1`)[0];
        if (!task) return null;
        if (!idPattern.test(task.project_id)) throw new Error("invalid storage deletion task");
        const project = (await tx`select purged_at from hv_projects where id = ${task.project_id}`)[0];
        if (!project?.purged_at) throw new Error("refusing to delete media for an unpurged project");
        let deleted = 0;
        for (const prefix of [`v1/${task.project_id}/`,`archives/${task.project_id}/`]) {
          // Re-list from the start after deleting each bounded page.
          for (let pageIndex = 0; ; pageIndex++) {
            if (pageIndex >= 1000) throw new Error("project deletion batch reached its page limit; retry the pending task");
            const page = await client.list({prefix,maxKeys:1000});
            const entries = page.contents ?? [];
            if (!entries.length) break;
            for (const entry of entries) {
              if (!entry.key.startsWith(prefix) || projectFromKey(entry.key) !== task.project_id) throw new Error("storage listing escaped the project prefix");
              await client.file(entry.key).delete(); deleted++;
            }
          }
        }
        await tx`update hv_outbox set published_at = now() where id = ${task.id}`;
        return deleted;
      });
      if (result === null) break;
      projects++; objects += Number(result);
    }
    return {projects,objects};
  }
  /** Collect superseded/failed uploads only after a grace period and with no active job. */
  async collectOrphans(now = Date.now(), graceMs = 864e5, maxPages = 100): Promise<number> {
    if (graceMs < 3600e3 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error("invalid orphan collection bounds");
    const client = this.client ?? objectClient();
    let removed = 0;
    for (const prefix of ["v1/","archives/"]) {
      let continuationToken = this.cursors.get(prefix);
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
        const page = await client.list({prefix,maxKeys:1000,continuationToken});
        for (const entry of page.contents ?? []) {
          const projectId = projectFromKey(entry.key), modified = Date.parse(entry.lastModified ?? "");
          if (!projectId || !Number.isFinite(modified) || modified > now-graceMs) continue;
          const deleted = await this.database.forProject(projectId,async tx => {
            // Admission also locks the project. Existing rendering work blocks orphan deletion.
            const project = (await tx`select id from hv_projects where id = ${projectId} for update`)[0];
            if (!project) return false; // Unknown namespaces require a separate operator investigation.
            if ((await tx`select id from hv_jobs where project_id = ${projectId} and status in ('queued','running') limit 1`).length) return false;
            if ((await tx`select key from hv_artifacts where object_key = ${entry.key} limit 1`).length
              || (await tx`select id from hv_archives where object_key = ${entry.key} limit 1`).length) return false;
            await client.file(entry.key).delete();
            return true;
          });
          if (deleted) removed++;
        }
        continuationToken = page.nextContinuationToken;
        if (!page.isTruncated || !continuationToken) {this.cursors.delete(prefix);break;}
        this.cursors.set(prefix,continuationToken);
      }
    }
    return removed;
  }
}
