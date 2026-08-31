import { createHmac, timingSafeEqual } from "node:crypto";

export const PROJECT_TOKEN_TTL_MS = 72 * 3600 * 1000;
export const REVIEW_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
export const ARTIFACT_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REVIEW_MAX_VIEWS = 3;

export function tokenSecret(): string {
  const secret = process.env.HV_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("HV_TOKEN_SECRET must be configured with at least 32 characters");
  }
  return secret;
}

export function operatorGrantSecret(): string | null {
  const secret = process.env.HV_OPERATOR_GRANT_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export type TokenKind = "project" | "review" | "artifact";

export interface TokenPayload {
  kind: TokenKind;
  projectId: string;
  permission?: "read" | "approve";
  exp: number;
  nonce: string;
}

export interface GrantPayload {
  kind: "grant";
  projectId: string;
  tier: "elevated";
  exp: number;
  nonce: string;
}

function sign(payload: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify<T extends { exp: number }>(token: string, secret: string, now: number): T | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
  if (payload.exp < now) return null;
  return payload;
}

export function signToken(payload: TokenPayload): string {
  return sign(payload, tokenSecret());
}

export function verifyToken(token: string, now = Date.now()): TokenPayload | null {
  const payload = verify<TokenPayload>(token, tokenSecret(), now);
  if (!payload) return null;
  if (payload.kind !== "project" && payload.kind !== "review" && payload.kind !== "artifact") return null;
  return payload;
}

export function mintProjectToken(projectId: string, now = Date.now()): string {
  return signToken({ kind: "project", projectId, exp: now + PROJECT_TOKEN_TTL_MS, nonce: crypto.randomUUID() });
}

export function mintReviewToken(projectId: string, permission: "read" | "approve", now = Date.now()): string {
  return signToken({ kind: "review", projectId, permission, exp: now + REVIEW_TOKEN_TTL_MS, nonce: crypto.randomUUID() });
}

export function mintArtifactToken(projectId: string, now = Date.now()): string {
  return signToken({ kind: "artifact", projectId, exp: now + ARTIFACT_TOKEN_TTL_MS, nonce: crypto.randomUUID() });
}

export function mintOperatorGrant(projectId: string, ttlMs = 24 * 3600 * 1000, now = Date.now()): string {
  const secret = operatorGrantSecret();
  if (!secret) throw new Error("HV_OPERATOR_GRANT_SECRET must be configured with at least 32 characters to mint grants");
  const payload: GrantPayload = { kind: "grant", projectId, tier: "elevated", exp: now + ttlMs, nonce: crypto.randomUUID() };
  return sign(payload, secret);
}

export function verifyOperatorGrant(token: string, projectId: string, now = Date.now()): GrantPayload | null {
  const secret = operatorGrantSecret();
  if (!secret) return null;
  const payload = verify<GrantPayload>(token, secret, now);
  if (!payload || payload.kind !== "grant" || payload.tier !== "elevated") return null;
  if (payload.projectId !== projectId) return null;
  return payload;
}
