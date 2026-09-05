import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as schema from "./schema";

export class StudioDatabase {
  readonly sql: SQL;
  readonly orm;
  constructor(url: string, maxConnections = 8, options: {idleTimeout?: number} = {}) {
    if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error("a PostgreSQL connection URL is required");
    const tlsDirectory = process.env.HV_DATABASE_TLS_DIR;
    const role = new URL(url).username;
    if (tlsDirectory && !["hv_admin", "hv_api", "hv_worker"].includes(role)) throw new Error("unknown database client certificate identity");
    const tls = tlsDirectory ? {ca: readFileSync(resolve(tlsDirectory, "ca.pem")),
      cert: readFileSync(resolve(tlsDirectory, role + ".pem")), key: readFileSync(resolve(tlsDirectory, role + "-key.pem")),
      rejectUnauthorized: true} : undefined;
    this.sql = new SQL(url, { tls, max: maxConnections, idleTimeout: options.idleTimeout ?? 20, connectionTimeout: 10 });
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
