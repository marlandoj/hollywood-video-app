// The private staging edge: serves the frontend and proxies /api, /artifacts and /health
// to the API over mutual TLS. It is the file Zo's staging runtime has run from
// RUNTIME/edge/edge.ts since before the loop, now kept in the repository so a new host
// is provisioned from here (scripts/provision-staging-host.py) rather than copied by hand.
import { resolve } from "node:path";

const appRoot = resolve(process.env.HV_APP_ROOT ?? "../app");
const mtlsRoot = resolve(process.env.HV_EDGE_MTLS_ROOT ?? "../mtls/frontend");
const upstream = (process.env.HV_EDGE_UPSTREAM ?? "https://127.0.0.1:8443").replace(/\/$/, "");
const port = Number(process.env.PORT ?? 8081);
const hostname = process.env.HV_EDGE_HOSTNAME ?? "0.0.0.0";

const indexHtml = Bun.file(`${appRoot}/packages/frontend/src/index.html`);
const hlsBundle = Bun.file(`${appRoot}/node_modules/hls.js/dist/hls.min.js`);
const [cert, key, ca] = await Promise.all([
  Bun.file(`${mtlsRoot}/frontend.crt`).text(),
  Bun.file(`${mtlsRoot}/frontend.key`).text(),
  Bun.file(`${mtlsRoot}/ca.crt`).text(),
]);
const tls = { cert, key, ca, checkServerIdentity: () => undefined };

const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function clientAddress(request: Request, peer: string | undefined): string {
  const hops = (request.headers.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? peer ?? "unknown";
}

async function proxy(request: Request, url: URL, peer: string | undefined): Promise<Response> {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!hopByHop.has(name.toLowerCase()) && name.toLowerCase() !== "host") headers.set(name, value);
  }
  headers.set("host", url.host);
  headers.set("x-forwarded-for", clientAddress(request, peer));
  headers.set("x-forwarded-proto", request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", ""));
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
    tls,
  } as RequestInit);
  const out = new Headers();
  for (const [name, value] of response.headers) {
    if (!hopByHop.has(name.toLowerCase()) && name.toLowerCase() !== "content-encoding") out.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: out });
}

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 255,
  async fetch(request, srv) {
    const url = new URL(request.url);
    const peer = srv.requestIP(request)?.address;
    const path = url.pathname;
    if (path === "/health" || path.startsWith("/api/") || path.startsWith("/artifacts/")) {
      try {
        return await proxy(request, url, peer);
      } catch (error) {
        return Response.json({ error: "upstream unavailable", detail: error instanceof Error ? error.message : String(error) }, { status: 502 });
      }
    }
    if (path === "/vendor/hls.min.js") {
      return new Response(hlsBundle, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600" } });
    }
    if (path === "/" || path === "/index.html") {
      return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`Rough Cut staging edge listening on http://${server.hostname}:${server.port} -> ${upstream}`);
