import { beforeAll, describe, expect, test } from "bun:test";
import { DeterministicMockProvider } from "../packages/generator/src/index";
import { parseFountain } from "../packages/parser/src/index";
import { attestRights, generateBible, planShots } from "../packages/planner/src/index";
import { checkShot } from "../packages/safety/src/index";
import { ProjectService } from "../packages/api/src/index";
import { CostLedger, OperatorReviewQueue } from "../packages/operator/src/index";
import { DurableJobStore } from "../packages/queue/src/index";
import { processNextJob } from "../packages/queue/src/worker";

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
});

const SCRIPT = `Title: Twelve Beats

INT. STUDY - NIGHT

A candle gutters.

EXT. STREET - NIGHT

Fog rolls past a lamp.

INT. HALL - NIGHT

Footsteps echo.

EXT. BRIDGE - DAWN

A figure crosses.

INT. CAFE - DAY

Steam rises from a cup.

WAITER
The usual?

EXT. PARK - DAY

Leaves turn in the wind.

INT. LIBRARY - DAY

Dust drifts in a sunbeam.

EXT. RIVER - SUNSET

Light breaks on the water.

INT. TRAIN - NIGHT

The city slides past the glass.

EXT. PLATFORM - NIGHT

A door hisses shut.

INT. STAIRWELL - NIGHT

One bulb flickers.

EXT. ROOFTOP - DAWN

The skyline turns gold.
`;

describe("12-shot short end-to-end (AC-008): script -> MP4", () => {
  test("anonymous journey completes through the production worker path with a validated export", async () => {
    const root = `/tmp/hv-e2e-${Date.now()}`;
    const service = new ProjectService(`${root}/state/projects.json`);
    const { projectId, token } = service.createAnonymousProject();
    expect(service.editScript(token, SCRIPT)?.version).toBe(1);

    const parsed = parseFountain(SCRIPT);
    expect(parsed.rejected).toBe(false);
    const shots = planShots(parsed, 7000);
    expect(shots.length).toBe(12);
    for (const shot of shots) expect(checkShot(shot).allowed).toBe(true);

    const attested = service.attestRights(token)!;
    const bible = attestRights(generateBible(projectId, parsed), attested.rightsAttestedAt!);
    expect(bible.rightsAttestation.attested).toBe(true);

    const store = new DurableJobStore(`${root}/jobs.json`);
    const context = {
      ledger: new CostLedger(`${root}/state/cost-ledger.json`),
      reviewQueue: new OperatorReviewQueue(`${root}/state/operator-review-queue.json`),
      primary: new DeterministicMockProvider({ costPerShotUsd: 0.01 }),
      secondary: new DeterministicMockProvider({ costPerShotUsd: 0.01 }),
    };
    const baseJob = {
      projectId,
      tier: "free" as const,
      scriptVersion: 1,
      totalFrames: shots.reduce((total, shot) => total + Math.round(shot.durationSec * 30), 0),
      retryPolicy: { maxRetries: 1, backoffMs: 10 },
      timeoutMs: 300000,
      costCapUsd: 60,
      scriptText: SCRIPT,
      rightsAttestedAt: attested.rightsAttestedAt,
      animaticApprovedAt: null,
    };

    store.enqueue({ ...baseJob, id: "animatic-1", idempotencyKey: "e2e-animatic", stage: "animatic", animaticJobId: null });
    const animatic = await processNextJob(store, `${root}/artifacts`, context);
    expect(animatic?.status).toBe("done");
    expect(animatic?.checkpointShots).toBe(12);

    const approval = service.recordAnimaticDecision(projectId, "animatic-1", 1, "approved", "ship it")!;
    expect(approval.decision).toBe("approved");

    store.enqueue({
      ...baseJob,
      id: "final-1",
      idempotencyKey: "e2e-final",
      stage: "final",
      animaticJobId: "animatic-1",
      animaticApprovedAt: approval.at,
    });
    const final = await processNextJob(store, `${root}/artifacts`, context);
    expect(final?.status).toBe("done");
    expect(final?.checkpointShots).toBe(12);
    expect(final?.costUsd).toBeCloseTo(0.12, 4);

    const captions = await Bun.file(`${root}/artifacts/${final!.output!.captionsPath}`).text();
    expect(captions).toContain("WAITER");
    const manifest = JSON.parse(await Bun.file(`${root}/artifacts/${final!.output!.manifestPath}`).text());
    expect(manifest.shots.length).toBe(12);
    expect(manifest.credentials.claim).toContain("AI-generated video");

    const ledger = new CostLedger(`${root}/state/cost-ledger.json`);
    expect(ledger.rollup("day").jobs).toBe(24);
    expect(ledger.monthSpend()).toBeCloseTo(0.24, 4);
    expect(ledger.gpuSecondsByProject()[projectId]).toBeGreaterThan(0);

    const restarted = new ProjectService(`${root}/state/projects.json`);
    expect(restarted.authorize(token)?.id).toBe(projectId);
    expect(restarted.animaticApproval(projectId, "animatic-1")?.decision).toBe("approved");
  }, 300000);
});
