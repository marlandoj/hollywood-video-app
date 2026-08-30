import { describe, expect, test } from "bun:test";
import { ProjectService } from "../src/index";
import { PROJECT_TOKEN_TTL_MS, verifyToken } from "../src/tokens";

describe("anonymous project + signed 72h token (AC-004)", () => {
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
