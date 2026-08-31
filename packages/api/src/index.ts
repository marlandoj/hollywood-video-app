import { REVIEW_MAX_VIEWS, mintProjectToken, mintReviewToken, verifyToken } from "./tokens";
import { VersionStore } from "../../parser/src/index";

export interface Project {
  id: string;
  createdAt: string;
  versions: VersionStore;
  deleteAfter: string;
  operatorExtensions: { extendedAt: string; days: number; reason: string }[];
}

export type ReviewDecision = "approved" | "changes_requested";
export interface ReviewLink {
  token: string;
  projectId: string;
  permission: "read" | "approve";
  views: number;
  revoked: boolean;
  decision: ReviewDecision | null;
  decisionNote: string | null;
}

export class ProjectService {
  private projects = new Map<string, Project>();
  private reviewLinks = new Map<string, ReviewLink>();
  readonly takedownLog: { projectId: string; at: string; reason: string }[] = [];
  private takenDown = new Set<string>();

  createAnonymousProject(now = Date.now()): { projectId: string; token: string; expiresAt: string } {
    const id = crypto.randomUUID();
    this.projects.set(id, {
      id,
      createdAt: new Date(now).toISOString(),
      versions: new VersionStore(),
      deleteAfter: new Date(now + 30 * 24 * 3600 * 1000).toISOString(),
      operatorExtensions: [],
    });
    return { projectId: id, token: mintProjectToken(id, now), expiresAt: new Date(now + 72 * 3600 * 1000).toISOString() };
  }

  authorize(token: string, now = Date.now()): Project | null {
    const p = verifyToken(token, now);
    if (!p || p.kind !== "project") return null;
    if (this.takenDown.has(p.projectId)) return null;
    return this.projects.get(p.projectId) ?? null;
  }

  editScript(token: string, text: string, now = Date.now()): { version: number } | null {
    const proj = this.authorize(token, now);
    if (!proj) return null;
    return { version: proj.versions.commit(text).version };
  }

  getVersion(token: string, version: number, now = Date.now()): string | null {
    const proj = this.authorize(token, now);
    return proj?.versions.get(version)?.text ?? null;
  }

  createReviewLink(ownerToken: string, permission: "read" | "approve", now = Date.now()): ReviewLink | null {
    const proj = this.authorize(ownerToken, now);
    if (!proj) return null;
    const token = mintReviewToken(proj.id, permission, now);
    const link: ReviewLink = { token, projectId: proj.id, permission, views: 0, revoked: false, decision: null, decisionNote: null };
    this.reviewLinks.set(token, link);
    return link;
  }

  useReviewLink(token: string, now = Date.now()): { projectId: string; permission: "read" | "approve" } | null {
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked) return null;
    if (link.views >= REVIEW_MAX_VIEWS) return null;
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review") return null;
    link.views += 1;
    return { projectId: link.projectId, permission: link.permission };
  }

  revokeReviewLink(ownerToken: string, reviewToken: string, now = Date.now()): boolean {
    const proj = this.authorize(ownerToken, now);
    const link = this.reviewLinks.get(reviewToken);
    if (!proj || !link || link.projectId !== proj.id) return false;
    link.revoked = true;
    return true;
  }

  submitReviewDecision(token: string, decision: ReviewDecision, note = "", now = Date.now()): boolean {
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked || link.permission !== "approve" || link.views >= REVIEW_MAX_VIEWS) return false;
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review" || payload.permission !== "approve") return false;
    link.views += 1;
    link.decision = decision;
    link.decisionNote = note.slice(0, 2000);
    return true;
  }

  latestScript(token: string, now = Date.now()): string | null {
    return this.authorize(token, now)?.versions.latest()?.text ?? null;
  }

  takedown(projectId: string, reason: string, now = Date.now()): boolean {
    if (!this.projects.has(projectId) || this.takenDown.has(projectId)) return false;
    this.takenDown.add(projectId);
    this.projects.delete(projectId);
    this.takedownLog.push({ projectId, at: new Date(now).toISOString(), reason });
    return true;
  }

  isTakenDown(projectId: string): boolean { return this.takenDown.has(projectId); }

  extendRetention(projectId: string, days: number, reason: string, now = Date.now()): boolean {
    const proj = this.projects.get(projectId);
    if (!proj) return false;
    proj.deleteAfter = new Date(new Date(proj.deleteAfter).getTime() + days * 24 * 3600 * 1000).toISOString();
    proj.operatorExtensions.push({ extendedAt: new Date(now).toISOString(), days, reason });
    return true;
  }

  sweepExpired(now = Date.now()): string[] {
    const removed: string[] = [];
    for (const [id, p] of this.projects) {
      if (new Date(p.deleteAfter).getTime() <= now) { this.projects.delete(id); removed.push(id); }
    }
    return removed;
  }
}
