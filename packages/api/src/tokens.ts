import { createHmac, timingSafeEqual } from "node:crypto";
import { isReviewPermission, type ReviewPermission } from "./review-capability";

export const PROJECT_TOKEN_TTL_MS = 72 * 3600 * 1000;
export const REVIEW_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
/** FR-040: a media link lives at most 30 days from completion, whatever a caller asks for. Equal to DOWNLOAD_LINK_TTL_MS in packages/queue. */
export const ARTIFACT_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
export const REVIEW_MAX_VIEWS = 3;
/** Wire format: base64url(JSON payload) "." base64url(HMAC-SHA256), checked before any MAC is computed. */
export const TOKEN_MAX_LENGTH = 1024;
export const TOKEN_PATTERN = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;
const ID_MAX_LENGTH = 128, NONCE_MAX_LENGTH = 64;
const TOKEN_KEYS: Record<TokenKind, string> = {
  project: "exp,kind,nonce,projectId",
  review: "exp,kind,nonce,permission,projectId",
  artifact: "exp,jobId,kind,nonce,projectId",
};

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
  jobId?: string;
  permission?: ReviewPermission;
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

/**
 * Shared verifier. Length and shape are checked before the MAC so an oversized
 * or malformed string costs no hashing; the payload must be a JSON object whose
 * `exp` is a safe integer strictly after `now` (`exp <= now` is expired, the
 * same boundary as the actor and diagnostics verifiers). Never throws.
 */
function verify<T extends { exp: number }>(token: unknown, secret: string, now: number): T | null {
  if (typeof token !== "string" || token.length > TOKEN_MAX_LENGTH || !Number.isSafeInteger(now)) return null;
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const expected = createHmac("sha256", secret).update(match[1]!).digest("base64url");
  const a = Buffer.from(match[2]!), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(match[1]!, "base64url").toString());
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (!Number.isSafeInteger(exp) || (exp as number) <= now) return null;
  return payload as T;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function signToken(payload: TokenPayload): string {
  return sign(payload, tokenSecret());
}

/**
 * Accepts exactly the payloads the three mint functions below produce: one key
 * set per kind, bounded non-empty identifiers, a review permission from the
 * closed set. Anything else is null even when the MAC is valid.
 */
export function verifyToken(token: string, now = Date.now()): TokenPayload | null {
  const payload = verify<TokenPayload>(token, tokenSecret(), now);
  if (!payload) return null;
  const kind: unknown = payload.kind;
  if (kind !== "project" && kind !== "review" && kind !== "artifact") return null;
  if (Object.keys(payload).sort().join(",") !== TOKEN_KEYS[kind]) return null;
  if (!boundedString(payload.projectId, ID_MAX_LENGTH) || !boundedString(payload.nonce, NONCE_MAX_LENGTH)) return null;
  if (kind === "review" && !isReviewPermission(payload.permission)) return null;
  if (kind === "artifact" && !boundedString(payload.jobId, ID_MAX_LENGTH)) return null;
  return payload;
}

export function mintProjectToken(projectId: string, now = Date.now()): string {
  return signToken({ kind: "project", projectId, exp: now + PROJECT_TOKEN_TTL_MS, nonce: crypto.randomUUID() });
}

export function mintReviewToken(projectId: string, permission: ReviewPermission, now = Date.now()): string {
  return signToken({ kind: "review", projectId, permission, exp: now + REVIEW_TOKEN_TTL_MS, nonce: crypto.randomUUID() });
}

/**
 * Signs a download link for one finished job (FR-040: valid for 30 days). The
 * signature is bound to the job as well as the project, so a link to one cut
 * cannot be replayed against another, and it never outlives the project's
 * retention window. Callers pass min(linkExpiresAt, deleteAfter); the mint
 * additionally clamps to ARTIFACT_TOKEN_TTL_MS from this host's clock so no
 * caller, and no worker/API clock drift, can sign a link past 30 days.
 */
export function mintArtifactToken(projectId: string, jobId: string, expiresAt: number, now = Date.now()): string {
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now)) throw new Error("artifact token expiry must be a safe integer timestamp");
  return signToken({ kind: "artifact", projectId, jobId, exp: Math.min(expiresAt, now + ARTIFACT_TOKEN_TTL_MS), nonce: crypto.randomUUID() });
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
