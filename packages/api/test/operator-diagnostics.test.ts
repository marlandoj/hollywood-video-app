import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticsSecret, mintDiagnosticsToken, verifyDiagnosticsToken, OPERATOR_TOKEN_TTL_MS } from "../src/operator-token";
import { createApiServer } from "../src/server";
import { OperatorDiagnostics } from "../../observability/src/diagnostics";
import { StudioTelemetry } from "../../observability/src/index";
import { TelemetryExplorer } from "../../observability/src/explorer";

test("operator credentials have strict purpose, size, lifetime, signature and payload validation", () => {
  const secret = "operator-fixture-" + crypto.randomUUID(), now = Date.now();
  const token = mintDiagnosticsToken(secret, now), payload = verifyDiagnosticsToken(token, secret, now)!;
  expect(payload.scope).toBe("diagnostics:read"); expect(payload.exp - payload.iat).toBe(OPERATOR_TOKEN_TTL_MS);
  expect(verifyDiagnosticsToken(token, secret, payload.exp)).toBeNull(); expect(verifyDiagnosticsToken(token, secret, now - 1)).toBeNull();
  expect(verifyDiagnosticsToken(token, "wrong-key", now)).toBeNull(); expect(verifyDiagnosticsToken(token, null, now)).toBeNull();
  expect(verifyDiagnosticsToken("x".repeat(100_000), secret, now)).toBeNull(); expect(verifyDiagnosticsToken(token + "x", secret, now)).toBeNull();
  expect(diagnosticsSecret("short")).toBeNull();
  const signed = (value: unknown) => {const body = Buffer.from(JSON.stringify(value)).toString("base64url"); return body + "." + createHmac("sha256", secret).update(body).digest("base64url");};
  for (const changed of [null, [], {...payload, scope: "admin"}, {...payload, kind: "project"}, {...payload, kind: "grant"},
    {...payload, exp: "tomorrow"}, {...payload, exp: null}, {...payload, exp: now + OPERATOR_TOKEN_TTL_MS + 1}, {...payload, nonce: "injected"}, {...payload, extra: "field"}])
    expect(verifyDiagnosticsToken(signed(changed), secret, now)).toBeNull();
});

test("unauthorized requests cannot initialize probes; operator access grants no project permission", async () => {
  const root = mkdtempSync(join(tmpdir(), "hv-operator-api-")), previous = process.env.HV_TOKEN_SECRET;
  process.env.HV_TOKEN_SECRET = "project-fixture-" + crypto.randomUUID();
  const secret = "diagnostics-fixture-" + crypto.randomUUID(), token = mintDiagnosticsToken(secret);
  let factories = 0, probes = 0, explorerFactories = 0, backendQueries = 0;
  const telemetry = new StudioTelemetry({service: "api", enabled: false});
  const server = createApiServer({port: 0, hostname: "127.0.0.1", tls: null, telemetry, operatorDiagnosticsSecret: secret,
    queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), costLedgerPath: join(root, "costs.json"), artifactRoot: join(root, "media"),
    telemetryExplorer: () => {explorerFactories++; return new TelemetryExplorer({enabled: true,
      fetch: async () => {backendQueries++; return Response.json({data: []});}});},
    diagnostics: () => {factories++; return new OperatorDiagnostics({telemetry, backend: "json", expectedWorkers: 1,
      database: async () => {probes++; throw new Error("database://private-credential");}});}});
  const request = (path: string, credential?: string) => fetch(new URL(path, server.url), {headers: credential ? {authorization: "Bearer " + credential} : {}});
  try {
    const owner = await (await fetch(new URL("/api/projects", server.url), {method: "POST"})).json() as {projectId: string; token: string};
    for (const credential of [undefined, "wrong", owner.token, mintDiagnosticsToken("another-key-" + crypto.randomUUID()), mintDiagnosticsToken(secret, Date.now() - OPERATOR_TOKEN_TTL_MS)]) {
      const response = await request("/api/operator/status", credential); expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      for (const path of ["/api/operator/traces", "/api/operator/traces/" + "a".repeat(32), "/api/operator/metrics"]) {
        const result = await request(path, credential); expect(result.status).toBe(401);
        expect(result.headers.get("cache-control")).toBe("private, no-store");
      }
    }
    expect((await request("/api/operator/status?token=" + token)).status).toBe(401); expect(factories).toBe(0); expect(probes).toBe(0);
    expect((await request("/api/operator/traces?token=" + token)).status).toBe(401);
    for (const path of ["/api/operator/traces?query=secret", "/api/operator/metrics?query=up", "/api/operator/traces?jobId=bad",
      "/api/operator/traces?jobId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee&jobId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "/api/operator/traces?url=http://example.invalid", "/api/operator/traces/" + "0".repeat(32), "/api/operator/traces/bad/extra"]) {
      expect((await request(path, token)).status).toBe(400);
    }
    expect(explorerFactories).toBe(0); expect(backendQueries).toBe(0);
    const tracesResponse = await request("/api/operator/traces", token);
    expect(await tracesResponse.json()).toMatchObject({schema: "hv-operator-traces/1", state: "available", value: {traces: []}});
    expect(tracesResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(explorerFactories).toBe(1); expect(backendQueries).toBe(1);
    const response = await request("/api/operator/status", token), value = await response.json() as any;
    expect(response.status).toBe(200); expect(value.status).toBe("degraded"); expect(value.budget.availableUsd).toBeNull(); expect(factories).toBe(1); expect(probes).toBe(1);
    expect(JSON.stringify(value)).not.toContain("private-credential"); expect(JSON.stringify(value)).not.toContain(token);
    expect((await request("/api/projects/" + owner.projectId, token)).status).toBe(401);
    expect((await request("/api/projects/" + owner.projectId, owner.token)).status).toBe(200);
    const page = await request("/api/operator/console");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'"); expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).toContain("Studio operations");
    expect((await request("/api/operator/app.js")).headers.get("content-type")).toContain("javascript");
  } finally {await server.stop(true); if (previous === undefined) delete process.env.HV_TOKEN_SECRET; else process.env.HV_TOKEN_SECRET = previous; rmSync(root, {recursive: true, force: true});}
});
