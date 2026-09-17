/**
 * HV-032-01. The queue had no terminus for a job whose worker keeps dying.
 *
 * `requeueExpired` returned every lapsed-lease job to `queued`, incremented
 * `resumedCount`, appended a notification, and bounded none of it. The retry
 * budget beside it — `retriesUsed` against `retryPolicy.maxRetries` — is
 * consumed only by `fail()`, which needs a worker alive enough to report a
 * failure; a job that is OOM-killed, whose host is lost, or which crashes the
 * process reports nothing. So a poison job cycled for ever, and on the free
 * tier that is one concurrency slot per project: every honest job behind it
 * waited for the life of the deployment.
 *
 * The other half is the notification list, which lives inside the stored job
 * body. Seven call sites appended to it and none bounded it, while the
 * route-decision history beside it has been bounded at 8192 since it was
 * written.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DurableJobStore, MAX_JOB_NOTIFICATIONS, MAX_LEASE_RECOVERIES, TIERS,
  costCapCancelNotice, type Job,
} from "../src/index";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

const job = (over: Record<string, unknown> = {}) => ({
  id: "job-1", idempotencyKey: "job-1", projectId: "project-1", tier: "free" as const,
  stage: "final" as const, scriptVersion: 1, totalFrames: 60,
  retryPolicy: { maxRetries: 2, backoffMs: 10 }, timeoutMs: 120_000, costCapUsd: 5,
  scriptText: "INT. ROOM - DAY\n\nA lamp glows.", rightsAttestedAt: "2026-08-31T00:00:00.000Z",
  animaticJobId: "animatic-1", animaticApprovedAt: "2026-08-31T00:05:00.000Z",
  ...over,
} as Parameters<DurableJobStore["enqueue"]>[0]);

/** Claims the job and then lets its lease lapse, which is what a dead worker looks like. */
function abandon(store: DurableJobStore, id: string, attempt: number): Job[] {
  const now = Date.now() + attempt * 1_000_000;
  const claimed = store.claimNext(now, {}, { workerId: `worker-${attempt}`, leaseMs: 1 });
  expect(claimed?.id).toBe(id);
  return store.recoverAbandoned(now + 1000);
}

test("a job whose worker keeps dying stops at a dead letter instead of cycling for ever", () => {
  const store = new DurableJobStore(`/tmp/hv-dead-letter-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  store.enqueue(job());

  // The free tier allows one running job per project, which is why an
  // unbounded resume loop is not merely untidy.
  expect(TIERS.free.maxConcurrent).toBe(1);

  for (let attempt = 1; attempt <= MAX_LEASE_RECOVERIES; attempt += 1) {
    const touched = abandon(store, "job-1", attempt);
    expect(touched.map(value => value.id)).toEqual(["job-1"]);
    const resumed = store.get("job-1")!;
    expect({ attempt, status: resumed.status, resumedCount: resumed.resumedCount }).toEqual({ attempt, status: "queued", resumedCount: attempt });
    expect(resumed.claimedBy).toBeNull();
    expect(resumed.leaseExpiresAt).toBeNull();
    expect(resumed.failureKind).toBeUndefined();
    expect(resumed.notifications.at(-1)).toBe("Your job was interrupted and will resume from its last checkpoint.");
    // The reported-failure budget is a different budget and is untouched.
    expect(resumed.retriesUsed).toBe(0);
  }

  const touched = abandon(store, "job-1", MAX_LEASE_RECOVERIES + 1);
  expect(touched.map(value => value.status)).toEqual(["failed"]);
  const dead = store.get("job-1")!;
  expect(dead.status).toBe("failed");
  expect(dead.failureKind).toBe("dead_letter");
  expect(dead.failureReason).toBe("This job was interrupted 6 times without finishing and has been stopped. Nothing was charged.");
  expect(dead.nextEligibleAt).toBeNull();
  expect(dead.claimedBy).toBeNull();
  expect(dead.leaseExpiresAt).toBeNull();
  expect(dead.completedAt).not.toBeNull();
  expect(dead.notifications.at(-1)).toBe(dead.failureReason);
  // And it is a terminus: no later pass returns it to the queue.
  expect(store.claimNext(Date.now() + 9_000_000, {}, { workerId: "worker-late" })).toBeUndefined();
  expect(store.recoverAbandoned(Date.now() + 9_000_000)).toEqual([]);
  expect(store.get("job-1")!.status).toBe("failed");
});

test("the dead letter releases the project's only concurrency slot", () => {
  const store = new DurableJobStore(`/tmp/hv-dead-letter-slot-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  store.enqueue(job({ id: "poison", idempotencyKey: "poison" }));
  store.enqueue(job({ id: "honest", idempotencyKey: "honest" }));

  // Which of the two the fair-share order picks first is not the point and is
  // not asserted; that it picks the *same* one on every pass is, because that
  // is what holds the slot. The first claim names the victim.
  const first = store.claimNext(Date.now() + 1_000_000, {}, { workerId: "worker-1", leaseMs: 1 })!;
  store.recoverAbandoned(Date.now() + 1_001_000);
  const stuck = first.id, waiting = stuck === "poison" ? "honest" : "poison";

  for (let attempt = 2; attempt <= MAX_LEASE_RECOVERIES + 1; attempt += 1) {
    const now = Date.now() + attempt * 1_000_000;
    const claimed = store.claimNext(now, {}, { workerId: `worker-${attempt}`, leaseMs: 1 });
    expect({ attempt, claimed: claimed?.id }).toEqual({ attempt, claimed: stuck });
    store.recoverAbandoned(now + 1000);
  }
  expect(store.get(stuck)!.failureKind).toBe("dead_letter");
  expect(store.get(waiting)!.status).toBe("queued");
  expect(store.get(waiting)!.resumedCount).toBe(0);

  // The next claim is the job that was waiting behind it. Before the terminus
  // this assertion was the stuck job for ever.
  const next = store.claimNext(Date.now() + 9_000_000, {}, { workerId: "worker-next" });
  expect(next?.id).toBe(waiting);
});

test("the recovery budget and the reported-failure budget are independent", () => {
  const store = new DurableJobStore(`/tmp/hv-dead-letter-budgets-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  // maxRetries 0: a reported failure is terminal immediately.
  store.enqueue(job({ id: "no-retries", idempotencyKey: "no-retries", retryPolicy: { maxRetries: 0, backoffMs: 10 } }));
  // A worker death still gets the full recovery budget, because it is not a
  // reported failure and consumes none of that budget.
  for (let attempt = 1; attempt <= MAX_LEASE_RECOVERIES; attempt += 1) abandon(store, "no-retries", attempt);
  expect(store.get("no-retries")!.status).toBe("queued");
  expect(store.get("no-retries")!.retriesUsed).toBe(0);

  // And a reported failure consumes the retry budget without touching the
  // recovery count.
  const now = Date.now() + 9_000_000;
  const claimed = store.claimNext(now, {}, { workerId: "worker-report", leaseMs: 600_000 })!;
  expect(claimed.id).toBe("no-retries");
  const failed = store.fail("no-retries", "worker-report", "the provider refused", now);
  expect({ status: failed.status, retriesUsed: failed.retriesUsed, resumedCount: failed.resumedCount, kind: failed.failureKind })
    .toEqual({ status: "failed", retriesUsed: 1, resumedCount: MAX_LEASE_RECOVERIES, kind: undefined });
});

test("the notification list is bounded, in one place, for every writer", () => {
  expect(MAX_JOB_NOTIFICATIONS).toBe(256);
  // A job that already carries more notifications than the cap -- a record
  // written before this bound existed -- is trimmed by the next write rather
  // than growing further, and the newest message is the one kept.
  const overflowing = {
    ...job({ status: "running", claimedBy: "worker-a", leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() }),
    notifications: Array.from({ length: 300 }, (_, index) => `old ${index}`),
    queueAction: "run", queueReason: "capacity_available", queuedBehind: [],
    costUsd: 0, retriesUsed: 0, checkpointFrame: 0, checkpointShots: 0, resumedCount: 0,
    completedAt: null, linkExpiresAt: null,
  } as unknown as Job;
  const store = DurableJobStore.fromJobs([overflowing]);
  const cancelled = store.cancel("job-1", "worker-a", "operator stopped this render");
  expect(cancelled.notifications.length).toBe(MAX_JOB_NOTIFICATIONS);
  expect(cancelled.notifications.at(-1)).toBe("operator stopped this render");
  // The oldest entries are the ones dropped, so the tail is contiguous.
  expect(cancelled.notifications.at(0)).toBe(`old ${300 - (MAX_JOB_NOTIFICATIONS - 1)}`);
});

test("the cost-cap cancellation notice is declared once, and both cancellers use it", () => {
  expect(costCapCancelNotice("cost $9.00 exceeded per-job cap $5.00"))
    .toBe("Your shot was cancelled: cost $9.00 exceeded per-job cap $5.00. You were not charged — this project is operator-funded.");

  // The queue cancels on the per-job cap and the PostgreSQL cost ledger cancels
  // on the same cap inside its own transaction. Both spelled the sentence out.
  // Scanned rather than asserted on one call site, because the second copy is
  // the defect and a behavioural test of the ledger needs a database.
  const sources = [...new Bun.Glob("packages/*/src/**/*.ts").scanSync(REPO_ROOT)].map(file => file.split("\\").join("/")).sort();
  expect(sources.length).toBeGreaterThan(100);
  const declares = sources.filter(file => readFileSync(join(REPO_ROOT, file), "utf8").includes("You were not charged"));
  expect(declares).toEqual(["packages/queue/src/index.ts"]);
  // And the ledger reaches it through the module.
  const ledger = readFileSync(join(REPO_ROOT, "packages/storage/src/ledger.ts"), "utf8");
  expect(/costCapCancelNotice/.test(ledger)).toBe(true);
  expect(/notifications\.push/.test(ledger)).toBe(false);
});
