import { createHmac, timingSafeEqual } from "node:crypto";

export const OPERATOR_TOKEN_TTL_MS = 15 * 60_000;
interface OperatorToken {kind: "operator"; scope: "diagnostics:read"; iat: number; exp: number; nonce: string}

export function diagnosticsSecret(value = process.env.HV_OPERATOR_DIAGNOSTICS_SECRET): string | null {
  return value && value.length >= 32 && value.length <= 4096 ? value : null;
}

/** Separate key and purpose from project access, media access, and capacity grants. */
export function mintDiagnosticsToken(secret: string, now = Date.now()): string {
  if (!diagnosticsSecret(secret) || !Number.isSafeInteger(now)) throw new Error("invalid diagnostics signing configuration");
  const payload: OperatorToken = {kind: "operator", scope: "diagnostics:read", iat: now, exp: now + OPERATOR_TOKEN_TTL_MS, nonce: crypto.randomUUID()};
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + createHmac("sha256", secret).update(body).digest("base64url");
}

export function verifyDiagnosticsToken(token: unknown, secret: string | null, now = Date.now()): OperatorToken | null {
  if (!secret || typeof token !== "string" || token.length > 1024) return null;
  const match = /^([A-Za-z0-9_-]{1,900})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const expected = createHmac("sha256", secret).update(match[1]!).digest("base64url");
  if (!timingSafeEqual(Buffer.from(match[2]!), Buffer.from(expected))) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1]!, "base64url").toString()) as OperatorToken;
    if (!value || Object.keys(value).sort().join(",") !== "exp,iat,kind,nonce,scope"
      || value.kind !== "operator" || value.scope !== "diagnostics:read"
      || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp)
      || value.iat > now || value.exp <= now || value.exp <= value.iat || value.exp - value.iat > OPERATOR_TOKEN_TTL_MS
      || typeof value.nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.nonce)) return null;
    return value;
  } catch { return null; }
}
