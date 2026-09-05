import { StudioDatabase } from "./database";

export type WorkerState = "idle" | "busy" | "draining" | "stopped";
/** A new process gets a new id; a stale incarnation cannot overwrite its replacement. */
export class PostgresWorkerRegistry {
  private readonly startedAt = new Date().toISOString();
  constructor(private readonly database: StudioDatabase, readonly id: string, private readonly name: string) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || !/^[A-Za-z0-9_.:-]{1,80}$/.test(name)) throw new Error("invalid worker identity");
  }
  async heartbeat(state: WorkerState, activeJobId: string | null = null): Promise<void> {
    await this.database.sql`insert into hv_workers (id,classes,active_job_id,heartbeat_at,body)
      values (${this.id},${["animatic","final"]}::jsonb,${activeJobId},now(),${{name:this.name,state,startedAt:this.startedAt}}::jsonb)
      on conflict (id) do update set active_job_id=excluded.active_job_id,heartbeat_at=excluded.heartbeat_at,body=excluded.body`;
  }
}
