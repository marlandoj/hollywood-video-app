import { createHash } from "node:crypto";
import { ProjectService, type PersistedProject, type PersistedState, type ReviewDecision, type ReviewLink } from "../../api/src/index";
import { verifyToken } from "../../api/src/tokens";
import { PostgresRetention } from "./retention";
import { StudioDatabase } from "./database";

const empty = (): PersistedState => ({ version: 1, projects: [], reviewLinks: [], takenDown: [], takedownLog: [] });
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Reuse the existing domain rules while committing each project mutation under a row lock. */
export class PostgresProjectService {
  constructor(readonly database: StudioDatabase) {}
  private projectId(token: string, kind: "project" | "review", now: number): string | null {
    const payload = verifyToken(token, now);
    return payload?.kind === kind ? payload.projectId : null;
  }
  private async state<T>(id: string, write: boolean, fn: (service: ProjectService) => T): Promise<T> {
    return this.database.forProject(id, async tx => {
      const rows = await tx`select body, taken_down_at, takedown_reason from hv_projects where id = ${id} for update`;
      const row = rows[0];
      const links = await tx`select body from hv_reviews where project_id = ${id}`;
      const snapshot = empty();
      if (row?.taken_down_at) {
        snapshot.takenDown = [id];
        snapshot.takedownLog = [{ projectId: id, at: new Date(row.taken_down_at).toISOString(), reason: row.takedown_reason ?? "" }];
      } else if (row) snapshot.projects = [row.body as PersistedProject];
      snapshot.reviewLinks = links.map((link: { body: ReviewLink }) => link.body);
      const service = ProjectService.fromState(snapshot);
      const result = fn(service);
      if (!write || !row) return result;
      const next = service.snapshot();
      const project = next.projects[0];
      if (project) {
        await tx`update hv_projects set body = ${project}::jsonb, delete_after = ${project.deleteAfter}, version = version + 1 where id = ${id}`;
      } else if (next.takenDown.includes(id)) {
        const event = next.takedownLog.find(event => event.projectId === id)!;
        await tx`update hv_projects set body = '{}'::jsonb, taken_down_at = ${event.at}, takedown_reason = ${event.reason}, version = version + 1 where id = ${id}`;
      } else {
        await tx`delete from hv_projects where id = ${id}`;
      }
      await tx`delete from hv_reviews where project_id = ${id}`;
      if (project) for (const link of next.reviewLinks) {
        await tx`insert into hv_reviews (token_hash, project_id, body) values (${hash(link.token)}, ${id}, ${link}::jsonb)`;
      }
      return result;
    });
  }
  private async owner<T>(token: string, write: boolean, now: number, fallback: T, fn: (service: ProjectService) => T): Promise<T> {
    const id = this.projectId(token, "project", now);
    return id ? this.state(id, write, fn) : fallback;
  }
  private async reviewer<T>(token: string, write: boolean, now: number, fallback: T, fn: (service: ProjectService) => T): Promise<T> {
    const id = this.projectId(token, "review", now);
    return id ? this.state(id, write, service => service.peekProject(id) ? fn(service) : fallback) : fallback;
  }
  async createAnonymousProject(now = Date.now()) {
    const service = new ProjectService();
    const result = service.createAnonymousProject(now);
    const body = service.snapshot().projects[0]!;
    await this.database.forProject(result.projectId, async tx => {
      await tx`insert into hv_projects (id, body, created_at, delete_after) values (${body.id}, ${body}::jsonb, ${body.createdAt}, ${body.deleteAfter})`;
    });
    return result;
  }
  authorize(token: string, now = Date.now()) { return this.owner(token, false, now, null, service => service.authorize(token, now)); }
  editScript(token: string, text: string, now = Date.now()) { return this.owner(token, true, now, null, service => service.editScript(token, text, now)); }
  getVersion(token: string, version: number, now = Date.now()) { return this.owner(token, false, now, null, service => service.getVersion(token, version, now)); }
  attestRights(token: string, now = Date.now()) { return this.owner(token, true, now, null, service => service.attestRights(token, now)); }
  latestScript(token: string, now = Date.now()) { return this.owner(token, false, now, null, service => service.latestScript(token, now)); }
  createReviewLink(token: string, permission: "read" | "approve", now = Date.now()) {
    return this.owner(token, true, now, null, service => service.createReviewLink(token, permission, now));
  }
  revokeReviewLink(token: string, reviewToken: string, now = Date.now()) {
    return this.owner(token, true, now, false, service => service.revokeReviewLink(token, reviewToken, now));
  }
  useReviewLink(token: string, now = Date.now()) { return this.reviewer(token, true, now, null, service => service.useReviewLink(token, now)); }
  peekReviewLink(token: string, now = Date.now()) { return this.reviewer(token, false, now, null, service => service.peekReviewLink(token, now)); }
  submitReviewDecision(token: string, decision: ReviewDecision, note = "", now = Date.now()) {
    return this.reviewer(token, true, now, false, service => service.submitReviewDecision(token, decision, note, now));
  }
  peekProject(id: string) { return this.state(id, false, service => service.peekProject(id)); }
  animaticApproval(projectId: string, jobId: string) { return this.state(projectId, false, service => service.animaticApproval(projectId, jobId)); }
  recordAnimaticDecision(projectId: string, jobId: string, version: number, decision: ReviewDecision, note = "", now = Date.now()) {
    return this.state(projectId, true, service => {
      if (service.peekProject(projectId)?.versions.latest()?.version !== version) return null;
      return service.recordAnimaticDecision(projectId, jobId, version, decision, note, now);
    });
  }
  takedown(projectId: string, reason: string, now = Date.now()) { return this.state(projectId, true, service => service.takedown(projectId, reason, now)); }
  isTakenDown(projectId: string) { return this.state(projectId, false, service => service.isTakenDown(projectId)); }
  extendRetention(projectId: string, days: number, reason: string, now = Date.now()) {
    return this.state(projectId, true, service => service.extendRetention(projectId, days, reason, now));
  }
  async sweepExpired(now = Date.now()): Promise<string[]> {
    return new PostgresRetention(this.database).sweep(now);
  }
}
