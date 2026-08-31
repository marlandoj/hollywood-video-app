import { createHmac, timingSafeEqual } from "node:crypto";

export const PROJECT_TOKEN_TTL_MS = 72 * 3600 * 1000;
export const REVIEW_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
export const REVIEW_MAX_VIEWS = 3;

export function tokenSecret(): string {
  const secret = process.env.HV_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("HV_TOKEN_SECRET must be configured with at least 32 characters");
  }
  return secret;
}

export interface TokenPayload {
  kind: "project" | "review";
  projectId: string;
  permission?: "read" | "approve";
  exp: number;
  nonce: string;
}

export function signToken(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", tokenSecret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyToken(token: string, now = Date.now()): TokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", tokenSecret()).update(body).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString()) as TokenPayload;
  } catch {
    return null;
  }
  if (payload.exp < now) return null;
  return payload;
}

export function mintProjectToken(projectId: string, now = Date.now()): string {
  return signToken({ kind: "project", projectId, exp: now + PROJECT_TOKEN_TTL_MS, nonce: crypto.randomUUID() });
}

export function mintReviewToken(projectId: string, permission: "read" | "approve", now = Date.now()): string {
  return signToken({ kind: "review", projectId, permission, exp: now + REVIEW_TOKEN_TTL_MS, nonce: crypto.randomUUID() });
}
