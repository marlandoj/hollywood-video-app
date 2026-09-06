import { openSync, writeFileSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { diagnosticsSecret, mintDiagnosticsToken, OPERATOR_TOKEN_TTL_MS } from "../packages/api/src/operator-token";

const [output, originValue] = process.argv.slice(2);
try {
  if (!output || !originValue) throw new Error("arguments");
  const secret = diagnosticsSecret(), origin = new URL(originValue);
  if (!secret || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
    || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)))) throw new Error("configuration");
  const now = Date.now(), token = mintDiagnosticsToken(secret, now);
  const descriptor = openSync(resolve(output), "wx", 0o600);
  try {writeFileSync(descriptor, JSON.stringify({url: origin.origin + "/api/operator/console#" + token, token, expiresAt: new Date(now + OPERATOR_TOKEN_TTL_MS).toISOString()}, null, 2) + "\n");}
  finally {closeSync(descriptor);}
  console.log("Saved a read-only operator credential to the requested file; it expires in 15 minutes.");
} catch {
  console.error("Could not mint diagnostics access. Supply a new output file and an HTTPS origin (or loopback HTTP), with HV_OPERATOR_DIAGNOSTICS_SECRET configured.");
  process.exitCode = 1;
}
