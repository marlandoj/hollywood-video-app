import { createHash } from "node:crypto";
import type { ReviewItem } from "../../operator/src/index";
import { StudioDatabase } from "./database";

export class PostgresReviewQueue {
  constructor(private readonly database: StudioDatabase) {}
  async flag(shotId: string, projectId: string, score: number): Promise<void> {
    const body: ReviewItem = {shotId, projectId, score, queuedAt: new Date().toISOString(), resolved: false};
    const id = createHash("sha256").update(projectId + "\0" + shotId).digest("hex");
    await this.database.sql`insert into hv_operator_reviews (id, project_id, shot_id, body)
      values (${id}, ${projectId}, ${shotId}, ${body}::jsonb)
      on conflict (id) do update set body = excluded.body, resolved_at = null`;
  }
  async pending(): Promise<ReviewItem[]> {
    return (await this.database.sql`select body from hv_operator_reviews where resolved_at is null order by id`)
      .map((row: {body: ReviewItem}) => row.body);
  }
  async resolve(shotId: string): Promise<void> {
    await this.database.sql`update hv_operator_reviews set resolved_at = now(),
      body = jsonb_set(body, '{resolved}', 'true'::jsonb) where shot_id = ${shotId} and resolved_at is null`;
  }
}
