import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as schema from "./schema";

export class StudioDatabase {
  readonly sql: SQL;
  readonly orm;
  constructor(url: string, maxConnections = 8) {
    if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error("a PostgreSQL connection URL is required");
    this.sql = new SQL(url, { max: maxConnections, idleTimeout: 20, connectionTimeout: 10 });
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
