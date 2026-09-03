import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createApiServer, mutualTlsFromEnv } from "../src/server";

const repo = `${import.meta.dir}/../../..`;
const root = `/tmp/hv-mtls-${process.pid}-${Date.now()}`;
const certs = `${root}/certs`;
const generator = `${repo}/infra/mtls/gen-certs.sh`;
const ATTEMPTS = 20;
let server: ReturnType<typeof createApiServer>;
let base: string;

function generateCerts(dir: string, caName?: string, force = false): void {
  const env: Record<string, string | undefined> = { ...process.env };
  if (caName) env.HV_MTLS_CA_CN = caName;
  if (force) env.HV_MTLS_FORCE = "1";
  const generated = Bun.spawnSync([generator, dir], { env });
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
}

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  generateCerts(certs);
  server = createApiServer({
    port: 0,
    hostname: "127.0.0.1",
    queuePath: `${root}/jobs.json`,
    artifactRoot: `${root}/artifacts`,
    statePath: `${root}/state/projects.json`,
    costLedgerPath: `${root}/state/cost-ledger.json`,
    rateLimit: { api: { limit: 1_000_000, windowMs: 60_000 } },
    tls: {
      cert: readFileSync(`${certs}/api/api.crt`, "utf8"),
      key: readFileSync(`${certs}/api/api.key`, "utf8"),
      clientCa: readFileSync(`${certs}/api/ca.crt`, "utf8"),
    },
  });
  base = `https://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

/**
 * Every handshake is a fresh curl process: one connection, one client
 * identity, no session or connection reuse between attempts, so each result
 * reflects exactly what the server decided for that certificate. The spawn is
 * asynchronous because the server under test shares this event loop and must
 * be free to complete the handshake.
 */
async function handshake(certDir: string | null): Promise<{ status: number; exitCode: number }> {
  const identity = certDir ? ["--cert", `${certDir}/frontend/frontend.crt`, "--key", `${certDir}/frontend/frontend.key`] : [];
  const client = Bun.spawn(
    ["curl", "--silent", "--no-keepalive", "--no-sessionid", "--max-time", "10", "--output", "/dev/null", "--write-out", "%{http_code}", "--cacert", `${certs}/frontend/ca.crt`, ...identity, `${base}/health`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, exitCode] = await Promise.all([new Response(client.stdout).text(), client.exited]);
  return { status: Number(stdout.trim() || 0), exitCode };
}

const trustedClient = () => ({
  tls: { ca: Bun.file(`${certs}/frontend/ca.crt`), cert: Bun.file(`${certs}/frontend/frontend.crt`), key: Bun.file(`${certs}/frontend/frontend.key`) },
}) as RequestInit;

describe("internal service traffic is mTLS (NFR-004, C-008)", () => {
  test("a connection without a client certificate is refused", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { status, exitCode } = await handshake(null);
      expect(status).toBe(0);
      expect(exitCode).not.toBe(0);
    }
  });

  test("a client certificate from an untrusted CA is refused on every connection", async () => {
    const sameName = `${root}/rogue-same-name`;
    const otherName = `${root}/rogue-other-name`;
    generateCerts(sameName);
    generateCerts(otherName, "rogue-ca");
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      for (const rogue of [sameName, otherName]) {
        const rejected = await handshake(rogue);
        expect(rejected.status).toBe(0);
        expect(rejected.exitCode).not.toBe(0);
      }
      expect((await handshake(certs)).status).toBe(200);
    }
  });

  test("the proxy's client certificate is accepted and the API answers over TLS", async () => {
    const response = await fetch(`${base}/health`, trustedClient());
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("healthy");
  });

  test("a trusted client round-trips a body larger than one socket buffer", async () => {
    const created = await (await fetch(`${base}/api/projects`, { method: "POST", ...trustedClient() })).json() as { projectId: string; token: string };
    const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
    const action = Array.from({ length: 60 }, (_, line) => `The lamp glows over object ${line} in the corner of the room. `.repeat(40));
    const text = `INT. ROOM - DAY\n\n${action.join("\n\n")}\n`;
    const saved = await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text }), ...trustedClient() });
    expect(saved.status).toBe(200);
    const loaded = await fetch(`${base}/api/projects/${created.projectId}`, { headers, ...trustedClient() });
    expect(loaded.status).toBe(200);
    expect((await loaded.json() as { script: string }).script).toBe(text);
  });

  test("a partial TLS configuration fails closed instead of falling back to plaintext", () => {
    const previous = { ...process.env };
    process.env.HV_TLS_CERT_PATH = `${certs}/api/api.crt`;
    delete process.env.HV_TLS_KEY_PATH;
    delete process.env.HV_TLS_CLIENT_CA_PATH;
    try {
      expect(() => mutualTlsFromEnv()).toThrow("must all be set");
    } finally {
      delete process.env.HV_TLS_CERT_PATH;
      Object.assign(process.env, previous);
    }
  });
});

/**
 * The CA signing key must never reach a runtime container or an image:
 * gen-certs.sh keeps it in its own directory, compose binds only the per-role
 * files, and the build context excludes the whole certificate tree. These
 * checks read the files statically so the policy holds without docker; the
 * CI compose job asserts the same inside the built images and the running
 * containers.
 */
describe("mTLS material is mounted least-privilege and never built into an image", () => {
  const compose = Bun.YAML.parse(readFileSync(`${repo}/docker-compose.yml`, "utf8")) as {
    services: Record<string, { volumes?: string[]; healthcheck?: { test: string[] } }>;
  };
  const binds = (service: string) => (compose.services[service]?.volumes ?? []).map((v) => v.split(":"));
  const isMtlsSource = (source: string) => source.startsWith("./infra/mtls") || source.includes("/mtls/") || source.includes("certs");

  test("gen-certs.sh keeps the CA key apart from the per-role material", () => {
    expect(readdirSync(`${certs}/ca`).sort()).toEqual(["ca.crt", "ca.key"]);
    expect(readdirSync(`${certs}/api`).sort()).toEqual(["api.crt", "api.key", "ca.crt"]);
    expect(readdirSync(`${certs}/frontend`).sort()).toEqual(["ca.crt", "frontend.crt", "frontend.key"]);
    expect(readdirSync(certs).sort()).toEqual(["api", "ca", "frontend"]);
  });

  test("regenerating over a legacy flat layout leaves no key outside its role directory", () => {
    const legacy = `${root}/legacy`;
    mkdirSync(legacy, { recursive: true });
    for (const name of ["ca.key", "ca.crt", "api.key", "api.crt", "frontend.key", "frontend.crt", "ca.srl"]) writeFileSync(`${legacy}/${name}`, "stale");
    generateCerts(legacy, undefined, true);
    expect(readdirSync(legacy).sort()).toEqual(["api", "ca", "frontend"]);
    expect(existsSync(`${legacy}/ca.key`)).toBe(false);
  });

  test("compose binds each container exactly its own identity and never ca.key", () => {
    const mtls = (service: string) => binds(service).filter(([source]) => isMtlsSource(source!)).sort();
    expect(mtls("api")).toEqual([
      ["./infra/mtls/certs/api/api.crt", "/run/mtls/api.crt", "ro"],
      ["./infra/mtls/certs/api/api.key", "/run/mtls/api.key", "ro"],
      ["./infra/mtls/certs/api/ca.crt", "/run/mtls/ca.crt", "ro"],
    ]);
    expect(mtls("frontend")).toEqual([
      ["./infra/mtls/certs/frontend/ca.crt", "/etc/nginx/mtls/ca.crt", "ro"],
      ["./infra/mtls/certs/frontend/frontend.crt", "/etc/nginx/mtls/frontend.crt", "ro"],
      ["./infra/mtls/certs/frontend/frontend.key", "/etc/nginx/mtls/frontend.key", "ro"],
    ]);
    for (const name of Object.keys(compose.services)) {
      if (name !== "api" && name !== "frontend") expect(mtls(name)).toEqual([]);
      for (const [source, , mode] of binds(name)) {
        if (!isMtlsSource(source!)) continue;
        expect(mode).toBe("ro");
        expect(source).toMatch(/^\.\/infra\/mtls\/certs\/(api|frontend)\/[a-z]+\.(crt|key)$/);
        expect(source).not.toContain("ca.key");
        expect(source).not.toContain("certs/ca/");
      }
    }
    expect(compose.services.api?.healthcheck).toBeUndefined();
    expect(compose.services.frontend?.healthcheck?.test.join(" ")).not.toContain("frontend.");
  });

  test("the docker build context excludes the certificate tree and every private key", () => {
    const ignore = readFileSync(`${repo}/.dockerignore`, "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    expect(ignore).toContain("infra/mtls/certs");
    expect(ignore).toContain("**/*.key");
    expect(ignore).toContain("**/*.pem");
    expect(ignore).toContain(".git");
    for (const dockerfile of readdirSync(`${repo}/infra`).filter((name) => name.startsWith("Dockerfile"))) {
      const content = readFileSync(`${repo}/infra/${dockerfile}`, "utf8");
      expect(content).not.toMatch(/COPY\s+[^\n]*infra\/mtls/);
    }
  });
});
