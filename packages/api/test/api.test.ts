import { beforeAll, describe, expect, test } from "bun:test";
import { ProjectService } from "../src/index";
import { PROJECT_TOKEN_TTL_MS, mintOperatorGrant, mintProjectToken, verifyOperatorGrant, verifyToken } from "../src/tokens";

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
});

describe("anonymous project + signed 72h token (AC-004)", () => {
  test("token signing fails closed when the secret is absent", () => {
    const configured = process.env.HV_TOKEN_SECRET;
    delete process.env.HV_TOKEN_SECRET;
    expect(() => mintProjectToken("project-1")).toThrow("HV_TOKEN_SECRET");
    process.env.HV_TOKEN_SECRET = configured;
  });

  test("creation returns a signed URL token; journey needs no account/email/card", () => {
    const svc = new ProjectService();
    const { projectId, token, expiresAt } = svc.createAnonymousProject();
    expect(projectId).toBeTruthy();
    expect(verifyToken(token)?.projectId).toBe(projectId);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(71 * 3600 * 1000);
    expect(svc.editScript(token, "INT. ROOM - DAY")?.version).toBe(1);
  });

  test("token expires after 72h and tampered tokens fail", () => {
    const svc = new ProjectService();
    const t0 = Date.now();
    const { token } = svc.createAnonymousProject(t0);
    expect(svc.authorize(token, t0 + PROJECT_TOKEN_TTL_MS + 1)).toBeNull();
    expect(svc.authorize(token.slice(0, -4) + "AAAA", t0)).toBeNull();
  });
});

describe("revision history (AC-027)", () => {
  test("each edit creates a version; any prior version retrievable for regeneration", () => {
    const svc = new ProjectService();
    const { token } = svc.createAnonymousProject();
    svc.editScript(token, "draft 1");
    svc.editScript(token, "draft 2");
    expect(svc.editScript(token, "draft 3")?.version).toBe(3);
    expect(svc.getVersion(token, 1)).toBe("draft 1");
  });
});

describe("accountless review links (AC-015)", () => {
  test("read-only and approve permissions, 3-view limit, revocable, 7-day expiry", () => {
    const svc = new ProjectService();
    const { token } = svc.createAnonymousProject();
    const ro = svc.createReviewLink(token, "read")!;
    const ap = svc.createReviewLink(token, "approve")!;
    expect(svc.useReviewLink(ro.token)?.permission).toBe("read");
    expect(svc.useReviewLink(ro.token)).toBeTruthy();
    expect(svc.useReviewLink(ro.token)).toBeTruthy();
    expect(svc.useReviewLink(ro.token)).toBeNull();
    expect(svc.useReviewLink(ap.token, Date.now() + 8 * 24 * 3600 * 1000)).toBeNull();
    const ro2 = svc.createReviewLink(token, "read")!;
    expect(svc.revokeReviewLink(token, ro2.token)).toBe(true);
    expect(svc.useReviewLink(ro2.token)).toBeNull();
  });

  test("approve links record approval or request-changes decisions", () => {
    const svc = new ProjectService();
    const { token } = svc.createAnonymousProject();
    const approved = svc.createReviewLink(token, "approve")!;
    expect(svc.submitReviewDecision(approved.token, "approved", "ready")).toBe(true);
    expect(approved.decision).toBe("approved");

    const changes = svc.createReviewLink(token, "approve")!;
    expect(svc.submitReviewDecision(changes.token, "changes_requested", "tighten scene two")).toBe(true);
    expect(changes.decision).toBe("changes_requested");
  });
});

describe("takedown + retention (AC-017, AC-028)", () => {
  test("takedown is logged and irreversible; owner token stops working", () => {
    const svc = new ProjectService();
    const { projectId, token } = svc.createAnonymousProject();
    expect(svc.takedown(projectId, "verified request #1")).toBe(true);
    expect(svc.takedown(projectId, "again")).toBe(false);
    expect(svc.authorize(token)).toBeNull();
    expect(svc.takedownLog[0].reason).toContain("verified");
  });

  test("30-day auto-delete with logged operator extensions", () => {
    const svc = new ProjectService();
    const t0 = Date.now();
    const { projectId } = svc.createAnonymousProject(t0);
    expect(svc.extendRetention(projectId, 10, "festival submission", t0)).toBe(true);
    expect(svc.sweepExpired(t0 + 31 * 24 * 3600 * 1000)).toEqual([]);
    expect(svc.sweepExpired(t0 + 41 * 24 * 3600 * 1000)).toEqual([projectId]);
  });
});

describe("durable project state (AC-024)", () => {
  test("projects, scripts, attestations, approvals, and review links survive a restart", () => {
    const statePath = `/tmp/hv-project-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    const first = new ProjectService(statePath);
    const { projectId, token } = first.createAnonymousProject();
    first.editScript(token, "INT. ROOM - DAY\n\nA lamp glows.");
    first.attestRights(token);
    first.recordAnimaticDecision(projectId, "animatic-1", 1, "approved", "looks right");
    const link = first.createReviewLink(token, "approve")!;

    const restarted = new ProjectService(statePath);
    const project = restarted.authorize(token);
    expect(project?.id).toBe(projectId);
    expect(project?.rightsAttestedAt).toBeTruthy();
    expect(restarted.latestScript(token)).toContain("A lamp glows");
    expect(restarted.getVersion(token, 1)).toContain("A lamp glows");
    expect(restarted.animaticApproval(projectId, "animatic-1")?.decision).toBe("approved");
    expect(restarted.useReviewLink(link.token)?.permission).toBe("approve");
  });

  test("a takedown survives a restart and keeps the owner token dead", () => {
    const statePath = `/tmp/hv-project-takedown-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    const first = new ProjectService(statePath);
    const { projectId, token } = first.createAnonymousProject();
    first.takedown(projectId, "verified request");
    const restarted = new ProjectService(statePath);
    expect(restarted.authorize(token)).toBeNull();
    expect(restarted.isTakenDown(projectId)).toBe(true);
  });
});

describe("operator-granted elevated capacity (FR-030)", () => {
  test("grants are rejected outright when no operator grant secret is configured", () => {
    const configured = process.env.HV_OPERATOR_GRANT_SECRET;
    delete process.env.HV_OPERATOR_GRANT_SECRET;
    expect(() => mintOperatorGrant("project-1")).toThrow("HV_OPERATOR_GRANT_SECRET");
    expect(verifyOperatorGrant("anything", "project-1")).toBeNull();
    if (configured) process.env.HV_OPERATOR_GRANT_SECRET = configured;
  });

  test("a grant is bound to one project, expires, and cannot be forged with the project secret", () => {
    process.env.HV_OPERATOR_GRANT_SECRET = "operator-grant-secret-at-least-thirty-two-chars";
    const grant = mintOperatorGrant("project-1");
    expect(verifyOperatorGrant(grant, "project-1")?.tier).toBe("elevated");
    expect(verifyOperatorGrant(grant, "project-2")).toBeNull();
    expect(verifyOperatorGrant(grant, "project-1", Date.now() + 25 * 3600 * 1000)).toBeNull();
    expect(verifyToken(grant)).toBeNull();
    delete process.env.HV_OPERATOR_GRANT_SECRET;
  });
});
