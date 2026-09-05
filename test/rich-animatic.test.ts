import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../packages/api/src/server";
import { CostLedger, OperatorReviewQueue } from "../packages/operator/src/index";
import { DurableJobStore } from "../packages/queue/src/index";
import { processNextJob } from "../packages/queue/src/worker";

const root = mkdtempSync(join(tmpdir(), "hv-rich-flow-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const script = "EXT. ZOO - DAY\n\nSpud waves to a giraffe.\n\nINT. CAFE - DAY\n\nA kettle steams.";
describe("rich animatic application flow", () => {
  test("screenplay produces signed storyboard frames, keeps approval binding, and releases reservation", async () => {
    process.env.HV_TOKEN_SECRET = "rich-flow-secret-that-is-longer-than-thirty-two-characters";
    const queuePath = join(root, "queue.json"), ledgerPath = join(root, "ledger.json"), artifacts = join(root, "artifacts");
    const api = createApiServer({ port: 0, hostname: "127.0.0.1", tls: null, queuePath, artifactRoot: artifacts,
      statePath: join(root, "projects.json"), costLedgerPath: ledgerPath });
    try {
      const base = `http://127.0.0.1:${api.port}`;
      const created = await (await fetch(base + "/api/projects", { method: "POST" })).json() as { projectId: string; token: string };
      const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
      const project = base + "/api/projects/" + created.projectId;
      await fetch(project + "/script", { method: "PUT", headers, body: JSON.stringify({ text: script }) });
      await fetch(project + "/rights", { method: "POST", headers, body: JSON.stringify({ attested: true }) });
      const queue = await fetch(project + "/jobs", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "rich-e2e" }) });
      expect(queue.status).toBe(202);
      const job = await queue.json() as { jobId: string };
      const ledger = new CostLedger(ledgerPath);
      ledger.reserve("capacity-used-after-admission", "final", 5000, 5000);
      const replay = await fetch(project + "/jobs", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "rich-e2e" }) });
      expect(replay.status).toBe(202);
      expect((await replay.json() as { jobId: string }).jobId).toBe(job.jobId);
      ledger.release("capacity-used-after-admission");
      const result = await processNextJob(new DurableJobStore(queuePath), artifacts, { ledger, reviewQueue: new OperatorReviewQueue() });
      expect(result?.status).toBe("done");
      const response = await fetch(base + "/api/jobs/" + job.jobId, { headers });
      const state = await response.json() as { storyboard: { url: string; caption: string }[] };
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(state.storyboard).toHaveLength(2);
      for (const frame of state.storyboard) {
        const image = await fetch(base + frame.url);
        expect(image.status).toBe(200);
        expect(image.headers.get("content-type")).toBe("image/png");
        expect(image.headers.get("set-cookie")).toBeNull();
        expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
      }
      expect(ledger.monthSpend()).toBe(0);
      expect(ledger.reservedUsd()).toBe(0);
      expect(ledger.all().every(e => e.stage === "animatic")).toBe(true);
      await fetch(project + "/script", { method: "PUT", headers, body: JSON.stringify({ text: script + "\n\nSpud exits." }) });
      const approval = await fetch(project + "/animatic/decision", { method: "POST", headers,
        body: JSON.stringify({ animaticJobId: job.jobId, decision: "approved" }) });
      expect(approval.status).toBe(409);
    } finally { api.stop(true); }
  }, 30000);

  test("paid storyboard admission rejects a job above its cap before any job is enqueued", async () => {
    const previous = { spec: process.env.HV_ANIMATIC_PROVIDER, cap: process.env.HV_ANIMATIC_COST_CAP_USD };
    process.env.HV_ANIMATIC_PROVIDER = "image:fal";
    process.env.HV_ANIMATIC_COST_CAP_USD = "0.001";
    const queuePath = join(root, "capped-queue.json");
    const api = createApiServer({ port: 0, hostname: "127.0.0.1", tls: null, queuePath, artifactRoot: join(root, "capped-artifacts"),
      statePath: join(root, "capped-projects.json"), costLedgerPath: join(root, "capped-ledger.json") });
    try {
      const base = `http://127.0.0.1:${api.port}`;
      const created = await (await fetch(base + "/api/projects", { method: "POST" })).json() as { projectId: string; token: string };
      const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
      const project = base + "/api/projects/" + created.projectId;
      await fetch(project + "/script", { method: "PUT", headers, body: JSON.stringify({ text: script }) });
      await fetch(project + "/rights", { method: "POST", headers, body: JSON.stringify({ attested: true }) });
      const response = await fetch(project + "/jobs", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "over-cap" }) });
      expect(response.status).toBe(429);
      expect(new DurableJobStore(queuePath).all()).toHaveLength(0);
    } finally {
      api.stop(true);
      if (previous.spec === undefined) delete process.env.HV_ANIMATIC_PROVIDER; else process.env.HV_ANIMATIC_PROVIDER = previous.spec;
      if (previous.cap === undefined) delete process.env.HV_ANIMATIC_COST_CAP_USD; else process.env.HV_ANIMATIC_COST_CAP_USD = previous.cap;
    }
  });
});
