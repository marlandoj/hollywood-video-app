import { describe, expect, test } from "bun:test";
import { DeterministicMockProvider, repairLoop } from "../packages/generator/src/index";
import { assemble } from "../packages/assembler/src/index";
import { parseFountain } from "../packages/parser/src/index";
import { attestRights, generateBible, planShots } from "../packages/planner/src/index";
import { checkPrompt } from "../packages/safety/src/index";
import { ProjectService } from "../packages/api/src/index";
import { CostLedger, OperatorReviewQueue } from "../packages/operator/src/index";

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
  test("anonymous journey completes with <2 continuity failures and a validated export", async () => {
    const svc = new ProjectService();
    const { token } = svc.createAnonymousProject();
    expect(svc.editScript(token, SCRIPT)?.version).toBe(1);

    const parsed = parseFountain(SCRIPT);
    expect(parsed.rejected).toBe(false);
    const shots = planShots(parsed, 7000);
    expect(shots.length).toBe(12);

    const bible = attestRights(generateBible("e2e", parsed));
    expect(bible.rightsAttestation.attested).toBe(true);

    for (const s of shots) expect(checkPrompt(s.prompt).allowed).toBe(true);

    const provider = new DeterministicMockProvider();
    const ledger = new CostLedger();
    const reviewQueue = new OperatorReviewQueue();
    const flagged: { shotId: string; score: number }[] = [];
    const clips = [];
    const degraded: string[] = [];
    let prev = null;
    const dir = `/tmp/hv-e2e-${Date.now()}`;
    for (const s of shots) {
      const { clip, outcome } = await repairLoop(
        s.id, prev,
        (attempt) => provider.generate(s.prompt, s.seed + attempt * 10000, { seed: s.seed, durationSec: 1 }, `${dir}/${s.id}-a${attempt}.mp4`),
        flagged,
      );
      ledger.record({ ...clip.cost, at: new Date().toISOString(), projectId: "e2e", shotId: s.id });
      if (outcome.status === "degraded") degraded.push(s.id);
      for (const f of flagged.splice(0)) reviewQueue.flag(f.shotId, "e2e", f.score);
      clips.push(clip);
      prev = clip;
    }
    expect(degraded.length).toBeLessThan(2);

    const result = assemble(clips, shots, `${dir}/out`, { crossfadeSec: 0.5 }, degraded);
    expect(result.ffprobe.codec).toBe("h264");
    expect(result.ffprobe.audioCodec).toBe("aac");
    expect(result.ffprobe.durationSec).toBeGreaterThan(5);
    expect(await Bun.file(result.srtPath).text()).toContain("WAITER");
    const manifest = JSON.parse(await Bun.file(result.manifestPath).text());
    expect(manifest.shots.length).toBe(12);
    expect(ledger.rollup("day").jobs).toBeGreaterThanOrEqual(12);
  }, 180000);
});
