import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as schema from "./schema";

/**
 * HV-016-30: how long a worker's reserved connection may sit without a statement.
 *
 * Bun SQL's `idleTimeout` also closes a connection reserved by an open transaction.
 * A held worker transaction legitimately does synchronous validation between
 * statements, and a V3 mixed film's envelope (its frozen proof context included) is
 * large enough that one heartbeat or checkpoint could go 20 s -- the default --
 * without a statement on a loaded host. The real PostgreSQL lifecycle then failed
 * with "Idle timeout reached after 20s" mid-transaction. Pool size is unchanged.
 */
export const WORKER_DATABASE_IDLE_TIMEOUT_SECONDS = 300;
/**
 * HV-016-37: the same bound for the API's connections. A feature's joined film is one job whose body
 * carries every sequence film it joins: Release 3's was 47 MiB of JSON (21 MiB packed). `GET
 * /api/jobs/:id` reads it in a short transaction, and decoding the row is synchronous, so the
 * connection saw no statement for 15 s on an idle host and over 20 s on a loaded one. Bun SQL's default
 * `idleTimeout` (20 s) then closed it before the commit, and the studio's poll of the join was answered
 * "400 Idle timeout reached after 20s": the live run's resumed join was done, but the run stopped.
 */
export const API_DATABASE_IDLE_TIMEOUT_SECONDS = 300;
/** The API's pool: eight connections, each allowed `API_DATABASE_IDLE_TIMEOUT_SECONDS` without a statement. */
export function apiDatabase(url: string): StudioDatabase { return new StudioDatabase(url, 8, { idleTimeout: API_DATABASE_IDLE_TIMEOUT_SECONDS }); }
export class StudioDatabase {
  readonly sql: SQL;
  readonly orm;
  constructor(url: string, maxConnections = 8, options: {idleTimeout?: number; connectionTimeout?: number} = {}) {
    if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error("a PostgreSQL connection URL is required");
    const tlsDirectory = process.env.HV_DATABASE_TLS_DIR;
    const role = new URL(url).username;
    if (tlsDirectory && !["hv_admin", "hv_api", "hv_worker"].includes(role)) throw new Error("unknown database client certificate identity");
    const tls = tlsDirectory ? {ca: readFileSync(resolve(tlsDirectory, "ca.pem")),
      cert: readFileSync(resolve(tlsDirectory, role + ".pem")), key: readFileSync(resolve(tlsDirectory, role + "-key.pem")),
      rejectUnauthorized: true} : undefined;
    this.sql = new SQL(url, { tls, max: maxConnections, idleTimeout: options.idleTimeout ?? 20, connectionTimeout: options.connectionTimeout ?? 10 });
    this.orm = drizzle({ client: this.sql, schema });
  }
  async migrate(folder = new URL("../../../infra/drizzle", import.meta.url).pathname): Promise<void> {
    await migrate(this.orm, { migrationsFolder: folder });
  }
  /** Call only after validating a project/review/artifact capability. Scope is transaction-local. */
  async forProject<T>(projectId: string, fn: (transaction: SQL) => Promise<T>): Promise<T> {
    if (!projectId || projectId.length > 256) throw new Error("invalid project scope");
    return await this.sql.begin(async transaction => {
      await transaction`select set_config('hv.project_id', ${projectId}, true)`;
      return fn(transaction as unknown as SQL);
    }) as T;
  }
  async health(): Promise<boolean> { const rows = await this.sql`select 1 as alive`; return rows[0]?.alive === 1; }
  async close(): Promise<void> { await this.sql.close(); }
}
