import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApiServer, mutualTlsFromEnv } from "../src/server";

const root = `/tmp/hv-mtls-${Date.now()}`;
const certs = `${root}/certs`;
let server: ReturnType<typeof createApiServer>;
let base: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  const generated = Bun.spawnSync([`${import.meta.dir}/../../../infra/mtls/gen-certs.sh`, certs]);
  if (generated.exitCode !== 0) throw new Error(generated.stderr.toString());
  server = createApiServer({
    port: 0,
    hostname: "127.0.0.1",
    queuePath: `${root}/jobs.json`,
    artifactRoot: `${root}/artifacts`,
    statePath: `${root}/state/projects.json`,
    costLedgerPath: `${root}/state/cost-ledger.json`,
    tls: {
      cert: readFileSync(`${certs}/api.crt`, "utf8"),
      key: readFileSync(`${certs}/api.key`, "utf8"),
      clientCa: readFileSync(`${certs}/ca.crt`, "utf8"),
    },
  });
  base = `https://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

/**
 * The negative cases use curl as the client. Bun's fetch reuses TLS client
 * state across calls in the same process, which made a rejected identity look
 * accepted once another identity had connected; an independent client shows
 * what the server actually enforces. The spawn is asynchronous because the
 * server under test shares this event loop and must be free to complete the
 * handshake.
 */
async function handshake(certDir: string | null): Promise<{ status: number; exitCode: number }> {
  const identity = certDir ? ["--cert", `${certDir}/frontend.crt`, "--key", `${certDir}/frontend.key`] : [];
  const client = Bun.spawn(
    ["curl", "--silent", "--max-time", "10", "--output", "/dev/null", "--write-out", "%{http_code}", "--cacert", `${certs}/ca.crt`, ...identity, `${base}/health`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, exitCode] = await Promise.all([new Response(client.stdout).text(), client.exited]);
  return { status: Number(stdout.trim() || 0), exitCode };
}

describe("internal service traffic is mTLS (NFR-004, C-008)", () => {
  test("a connection without a client certificate is refused", async () => {
    const { status, exitCode } = await handshake(null);
    expect(status).toBe(0);
    expect(exitCode).not.toBe(0);
  });

  test("a client certificate from an untrusted CA is refused", async () => {
    const rogue = `${root}/rogue`;
    const generated = Bun.spawnSync([`${import.meta.dir}/../../../infra/mtls/gen-certs.sh`, rogue]);
    expect(generated.exitCode).toBe(0);
    const rejected = await handshake(rogue);
    expect(rejected.status).toBe(0);
    expect(rejected.exitCode).not.toBe(0);
    expect((await handshake(certs)).status).toBe(200);
  });

  test("the proxy's client certificate is accepted and the API answers over TLS", async () => {
    const response = await fetch(`${base}/health`, {
      tls: { ca: Bun.file(`${certs}/ca.crt`), cert: Bun.file(`${certs}/frontend.crt`), key: Bun.file(`${certs}/frontend.key`) },
    } as RequestInit);
    expect(response.status).toBe(200);
    expect((await response.json() as { status: string }).status).toBe("healthy");
  });

  test("a partial TLS configuration fails closed instead of falling back to plaintext", () => {
    const previous = { ...process.env };
    process.env.HV_TLS_CERT_PATH = `${certs}/api.crt`;
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
