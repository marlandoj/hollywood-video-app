import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reviewTimecode } from "../packages/api/src/review-comments";
import { RELEASE_2_LINES, RELEASE_2_PARTS } from "../scripts/release-2-run";
import { RELEASE_3_LINES, RELEASE_3_PARTS } from "../scripts/release-3-run";
import { readCriteria as readRelease2Criteria } from "./release-2-contract";
import { RECORD_PATH, REPO, acknowledgesRelease3, approvesSecondVendor, gateEntries, readCriteria, realContext, release3Problems, release3Section,
  sequenceAtFrame, type Context } from "./release-3-contract";

/**
 * HV-030-31: Release 3's exit criteria, and the record that will prove them.
 *
 * The criteria are docs/ROADMAP.md's "Release 3 exit criteria", agreed at G20-202610031349. No run
 * has been made (the rehearsal is build step 15, the run step 16), so the contract is proved on a
 * synthetic fixture under test/fixtures/, never under docs/evidence/: evidence is never fabricated.
 * Each criterion is shown to bite by breaking the fixture in exactly that way. Once
 * docs/evidence/release-3/release-run.json exists, the last test holds the real record to the same
 * criteria, against the real gate entries only.
 */
const FIXTURE_DIR = "test/fixtures/release-3-run/";
const fixture = () => JSON.parse(readFileSync(resolve(REPO, FIXTURE_DIR, "release-run.fixture.json"), "utf8"));
const roadmap = readFileSync(resolve(REPO, "docs/ROADMAP.md"), "utf8");
const real = realContext();
const fixtureGates = gateEntries(readFileSync(resolve(REPO, FIXTURE_DIR, "gates.fixture.md"), "utf8"));
/** The real gates, plus the synthetic entries the fixture cites. */
const fixtureContext: Context = { ...real, fixture: true, evidenceRoot: FIXTURE_DIR, gates: [...real.gates, ...fixtureGates], requireAcknowledgement: true };
const problems = (record: unknown, context: Partial<Context> = {}) => release3Problems(record, { ...fixtureContext, ...context });
/** The fixture as a mock rehearsal would record it: mock picture, a short film, $0 declared, nothing moved, no review yet. */
const rehearsal = () => {
  const record = fixture();
  for (const sequence of record.feature.sequences) sequence.picture = { byProvider: { mock: sequence.shots }, strategy: "configured", quality: null };
  record.feature.film.durationSec = 410; record.feature.review = null; record.spendUsdDeclared = 0; record.acknowledgement = null;
  for (const line of Object.values(record.ledgers.lines) as any[]) line.after = { ...line.before };
  record.slices["HV-030.feature-review"] = { exercised: false, surface: "reviewer", ids: [], deferredBy: "G21-209901010000" };
  record.steps = record.steps.filter((step: any) => step.step !== "review-read-back");
  return record;
};

describe("the criteria", () => {
  /** The parts table covers every slice the Release 3 table names, and the driver fills the same parts and lines. */
  test("the criteria name a part for every Release 3 slice, and the driver records the roadmap's parts, lines and declared spend", () => {
    const { epics, parts, lines, declaredUsd } = readCriteria(roadmap);
    expect(epics).toEqual(["HV-030", "HV-017", "HV-021", "HV-019", "HV-020", "HV-023", "HV-034", "HV-025", "HV-037"]);
    expect([...new Set(parts.map(part => part.epic))].sort()).toEqual([...epics].sort());
    for (const part of parts) expect(part.part.startsWith(part.epic + ".")).toBe(true);
    expect(Object.fromEntries(parts.map(part => [part.part, part.surface]))).toEqual({ ...RELEASE_3_PARTS });
    expect(lines).toEqual({ ...RELEASE_3_LINES });
    // The four lines are Release 2's, so scripts/release-2-lines.ts reads them unchanged.
    expect(RELEASE_3_LINES).toEqual(RELEASE_2_LINES);
    expect(declaredUsd).toBe(135);
  });

  /** Both sections share their table shapes; each parse reads its own section only. */
  test("the Release 3 parse never reads Release 2's section, and Release 2's never reads Release 3's", () => {
    const three = readCriteria(roadmap), two = readRelease2Criteria(roadmap);
    expect(three.parts.some(part => part.part in RELEASE_2_PARTS)).toBe(false);
    expect(two.parts.some(part => part.part in RELEASE_3_PARTS)).toBe(false);
    // Removing Release 2's section changes nothing in Release 3's criteria, and Release 3's is bounded by Release 4's heading.
    const withoutTwo = roadmap.slice(0, roadmap.indexOf("## Release 2")) + roadmap.slice(roadmap.indexOf("## Release 3"));
    expect(readCriteria(withoutTwo)).toEqual(three);
    expect(release3Section(roadmap)).not.toContain("## Release 4");
    expect(() => readCriteria(roadmap.replace("## Release 4", "## Later"))).toThrow("no Release 3 section before Release 4");
  });

  /** The deferral the run expects to cite for the second vendor is a real entry, and nothing on the real gates approves the vendor yet. */
  test("the second vendor's approval is read from a G3 entry that names it, and no real entry approves it yet", () => {
    expect(real.gates.map(entry => entry.id)).toContain("G20-202610031349");
    expect(real.gates.some(approvesSecondVendor)).toBe(false);
    // G19 and G20 say the vendor still needs its G3 approval; neither is that approval.
    expect(approvesSecondVendor(real.gates.find(entry => entry.id === "G19-202610030430"))).toBe(false);
    expect(approvesSecondVendor(real.gates.find(entry => entry.id === "G20-202610031349"))).toBe(false);
    expect(approvesSecondVendor(fixtureGates.find(entry => entry.id === "G22-209901010000"))).toBe(true);
    expect(acknowledgesRelease3(real.gates.find(entry => entry.id === "G6-202610030339"))).toBe(false);
    expect(real.requireAcknowledgement).toBe(false);
  });
});

describe("the contract, on a synthetic fixture", () => {
  test("the synthetic fixture meets every criterion, and is kept outside docs/evidence", () => {
    expect(FIXTURE_DIR.startsWith("docs/evidence")).toBe(false);
    expect(fixture().fixture).toContain("never evidence");
    expect(problems(fixture())).toEqual([]);
  });

  test("a synthetic fixture cannot stand as the release's evidence", () => {
    expect(problems(fixture(), { fixture: false })).toContain("a synthetic fixture cannot stand as the release's evidence");
  });

  /** Criterion 1: one feature, 200-240 shots in sequences of at most 24 covering every scene, joined into the one film shared, all live picture. */
  test("criterion 1: a film that isn't a 15-20 minute feature of 200-240 shots in sequences covering every scene, joined and shared, fails", () => {
    const reel = fixture(); reel.feature.format = "reel";
    expect(problems(reel)).toContain("the film was not pitched as a feature");
    const small = fixture(); small.feature.readThrough.shots = 150;
    expect(problems(small)).toContain("the read-through did not read a feature of 200-240 shots");
    const big = fixture(); big.feature.sequences[0].shots = 25;
    expect(problems(big)).toContain("sequence 1 is not 1-24 shots");
    const gap = fixture(); gap.feature.sequences[3].firstScene += 1;
    expect(problems(gap)).toContain("sequence 4 does not start where the sequence before it ends");
    const short = fixture(); short.feature.sequences.pop();
    expect(problems(short)).toContain("the sequences do not cover every scene of the feature");
    const unmade = fixture(); unmade.feature.sequences[2].final = null;
    expect(problems(unmade)).toContain("sequence 3 has no rough cut, final and finished film");
    const unjoined = fixture(); unjoined.feature.shared = unjoined.feature.sequences[9].film;
    expect(problems(unjoined)).toContain("the sequences were not joined into the one film that was shared");
    const brief = fixture(); brief.feature.film.durationSec = 600;
    expect(problems(brief)).toContain("the joined film does not run 900-1200 s before its credits");
  });

  /**
   * HV-030-33, criterion 1: a sequence's finished film is the Composer's mix of its final. A sequence
   * whose score failed is joined as its bare final, and fails by name, in a rehearsal as in the release
   * (mock scores at $0). A record that doesn't say what the film is fails too. Before, any film id passed.
   */
  test("criterion 1: a sequence joined as its bare final, without its score, fails in a rehearsal and in the release", () => {
    const bare = fixture(); bare.feature.sequences[2].film = bare.feature.sequences[2].final; bare.feature.sequences[2].filmStage = "final";
    expect(problems(bare)).toEqual(["sequence 3's film was not scored (the studio holds it as final)"]);
    const voiced = rehearsal(); voiced.feature.sequences[9].filmStage = "dialogue-replacement";
    expect(problems(voiced, { rehearsal: true })).toEqual(["sequence 10's film was not scored (the studio holds it as dialogue-replacement)"]);
    const unsaid = fixture(); delete unsaid.feature.sequences[0].filmStage;
    expect(problems(unsaid)).toEqual(["sequence 1's film was not scored (the studio holds it as an unrecorded stage)"]);
  });

  /** Criterion 1: every shot from the live profile, none a mock slate; a second vendor only after its G3. */
  test("criterion 1: a mock slate in the shared film, or a shot by a second vendor without its G3 approval, fails", () => {
    const slate = fixture(); slate.feature.sequences[6].picture.byProvider = { "fal:kling-o3-standard-keyframes": 23, mock: 1 };
    expect(problems(slate)).toContain("sequence 7 carries a mock slate in the shared film");
    const unknown = fixture(); unknown.feature.sequences[1].picture.byProvider = { "fal:kling-o3-standard-keyframes": 19 };
    expect(problems(unknown)).toContain("sequence 2's final does not account for every shot's provider");
    const vendor = fixture(); vendor.feature.sequences[2].picture.byProvider = { "fal:kling-o3-standard-keyframes": 18, "othervendor:video-1": 2 };
    expect(problems(vendor)).toContain("sequence 3 was rendered by a second vendor without its G3 approval");
    vendor.secondVendor.approvedBy = "G22-209901010000";
    expect(problems(vendor)).toEqual([]);
  });

  /** Criterion 2: one look and one cast across every sequence; continuity held across every boundary. */
  test("criterion 2: a sequence off the style bible or its locks, or continuity not held across every boundary, fails", () => {
    const look = fixture(); look.feature.sequences[5].bibleRevision = "e".repeat(64);
    expect(problems(look)).toContain("sequence 6 was not rendered from the feature's style bible");
    const stale = fixture(); stale.identity.sequences[3].current = false;
    expect(problems(stale)).toContain("sequence 4's final was not rendered from the current locks");
    const old = fixture(); old.identity.sequences[0].revisions[0].revision = "d".repeat(64);
    expect(problems(old)).toContain("sequence 1 used a lock revision the cast no longer holds");
    const unlocked = fixture(); for (const sequence of unlocked.identity.sequences) sequence.lockedShots = 0;
    expect(problems(unlocked)).toContain("no shot of the feature was rendered from a lock");
    const boundary = fixture(); boundary.continuity.boundaries.pop();
    expect(problems(boundary)).toContain("the Continuity Supervisor's report does not cover every sequence boundary");
    const pending = fixture(); pending.continuity.edits = 2;
    expect(problems(pending)).toContain("the Continuity Supervisor's repair was proposed but not applied");
    const late = fixture(); late.continuity.remake = [{ sequence: 4, stages: ["final"] }];
    expect(problems(late)).toContain("a continuity repair applied after the finals leaves sequences to make again");
  });

  /** Criterion 3: reviewed on a second device, with comments in at least three sequences and a decision naming its stage. */
  test("criterion 3: comments in fewer than three sequences, a comment off its sequence, or no decided stage, fails", () => {
    const two = fixture(); two.feature.review.comments.pop();
    expect(problems(two)).toContain("the feature has timecoded comments in fewer than 3 sequences");
    const misplaced = fixture(); misplaced.feature.review.comments[0].sequence = 2;
    expect(problems(misplaced)).toContain("a comment names a sequence its frame is not in");
    const offFrame = fixture(); offFrame.feature.review.comments[1].timecode = reviewTimecode(0);
    expect(problems(offFrame)).toContain("the feature has a comment that is not pinned to a frame");
    const undecided = fixture(); undecided.feature.review.decisionStage = null;
    expect(problems(undecided)).toContain("the feature's reviewer did not decide a stage");
    const unopened = fixture(); unopened.feature.review.views = 0;
    expect(problems(unopened)).toContain("the feature's review link was not opened on the joined film");
    const elsewhere = fixture(); elsewhere.feature.review.boundJobId = elsewhere.feature.sequences[0].film;
    expect(problems(elsewhere)).toContain("the feature's review link was not opened on the joined film");
  });

  /** A frame falls in the last sequence whose start it has reached, and never in the credits. */
  test("a comment's frame is placed in the sequence of the joined film it falls in", () => {
    const starts = [{ number: 1, startSec: 0, durationSec: 100 }, { number: 2, startSec: 99.6, durationSec: 50 }];
    expect(sequenceAtFrame(starts, 0)).toBe(1);
    expect(sequenceAtFrame(starts, 99 * 30)).toBe(1);
    expect(sequenceAtFrame(starts, 100 * 30)).toBe(2);
    expect(sequenceAtFrame(starts, 150 * 30)).toBe(null);
  });

  /** Criterion 4: every part exercised with real ids, or deferred to a gate entry that exists; the second vendor only after its G3. */
  test("criterion 4: a part left unsaid, deferred to a missing entry, with ids no step reported, or a second vendor exercised without its G3, fails", () => {
    const unsaid = fixture(); unsaid.slices["HV-025.vfx-composite"].deferredBy = null;
    expect(problems(unsaid)).toContain("HV-025.vfx-composite is neither exercised nor deferred to a gate entry that exists");
    const invented = fixture(); invented.slices["HV-020.native-camera"].deferredBy = "G99-209912312359";
    expect(problems(invented)).toContain("HV-020.native-camera is neither exercised nor deferred to a gate entry that exists");
    const missing = fixture(); delete missing.slices["HV-023.interchange"];
    expect(problems(missing)).toContain("HV-023.interchange is not accounted for");
    const unreported = fixture(); unreported.slices["HV-019.hero-chain"].ids.push("00000000-0000-4000-8000-0000000000ff");
    expect(problems(unreported)).toContain("HV-019.hero-chain has ids no step reported");
    const fake = fixture(); fake.slices["HV-034.style-bible"].ids = ["the bible"];
    expect(problems(fake)).toContain("HV-034.style-bible has an id that is not a real studio id: the bible");
    const nowhere = fixture(); nowhere.slices["HV-037.paid-benchmark"].ids = ["docs/evidence/release-2/release-run.json"];
    expect(problems(nowhere)).toContain("HV-037.paid-benchmark has an id that is not a real repository path: docs/evidence/release-2/release-run.json");
    const wrongSurface = fixture(); wrongSurface.slices["HV-030.feature-review"].surface = "front-door";
    expect(problems(wrongSurface)).toContain("HV-030.feature-review names the wrong surface");
    const vendor = fixture(); vendor.slices["HV-019.second-vendor"] = { exercised: true, surface: "front-door", ids: [vendor.feature.sequences[0].final], deferredBy: null };
    vendor.steps.find((step: any) => step.step === "second-vendor").outcome = "done";
    vendor.steps.find((step: any) => step.step === "second-vendor").parts = ["HV-019.second-vendor"];
    vendor.steps.find((step: any) => step.step === "second-vendor").ids = [vendor.feature.sequences[0].final];
    expect(problems(vendor)).toContain("HV-019.second-vendor is exercised without a G3 entry approving the vendor");
    vendor.secondVendor.approvedBy = "G20-202610031349";
    expect(problems(vendor)).toContain("HV-019.second-vendor is exercised without a G3 entry approving the vendor");
    vendor.secondVendor.approvedBy = "G22-209901010000";
    expect(problems(vendor)).toEqual([]);
  });

  /** Criterion 5: within the declared ~$135 (G23), each line within its limit, and the feature within its own $150. */
  test("criterion 5: a line over its limit, a run over its declaration, a declaration past $135, or a feature past $150, fails", () => {
    const voice = fixture(); voice.ledgers.lines.voice.after = { spentUsd: 0, heldUsd: 25.01 };
    expect(problems(voice)).toContain("the voice line is over its $25 limit");
    const over = fixture(); over.spendUsdDeclared = 90;
    expect(problems(over)).toContain("the run spent more than it declared");
    const raised = fixture(); raised.spendUsdDeclared = 150;
    expect(problems(raised)).toContain("the record declares more than the roadmap's $135 for the feature");
    const film = fixture(); film.feature.spend = { spentUsd: 140, heldUsd: 10.01, capUsd: 150 };
    expect(problems(film)).toContain("the feature is not within its own $150 film limit");
    const reel = fixture(); reel.feature.spend.capUsd = 40;
    expect(problems(reel)).toContain("the feature is not within its own $150 film limit");
    const unrecorded = fixture(); unrecorded.ledgers.lines.crew.after = null;
    expect(problems(unrecorded)).toContain("the crew line has no before and after");
  });

  /** Criterion 6: the crew's rules at feature length. */
  test("criterion 6: a concern against the script, a cast member not permitted, or a film not in English, fails", () => {
    const figure = fixture(); figure.feature.readThrough.concerns = ["public_figure"];
    expect(problems(figure)).toContain("the read-through raised a concern against the feature");
    const pending = fixture(); pending.feature.cast[2].permission = "pending";
    expect(problems(pending)).toContain("the feature's cast is not every character original or consented, and permitted");
    const french = fixture(); french.feature.film.captionLanguage = "fr";
    expect(problems(french)).toContain("the feature is not in English");
  });

  /** Criterion 7: the shared feature's signed sidecar matches its record and verifies. */
  test("criterion 7: a sidecar that doesn't match its record, or wasn't verified, fails", () => {
    const mismatch = fixture(); mismatch.provenance.exports[0].sidecar.matchesRecord = false;
    expect(problems(mismatch)).toContain("the shared feature has no signed sidecar matching its record");
    const unverified = fixture(); unverified.provenance.exports[0].verification = null;
    expect(problems(unverified)).toContain("the shared feature's signed sidecar was not verified");
  });

  /** Criterion 8: each step names its surface. */
  test("criterion 8: a step without its surface, or a feature with no front-door step, fails", () => {
    const unnamed = fixture(); unnamed.steps[3].surface = "desk";
    expect(problems(unnamed).some(problem => problem.startsWith("a step does not name its surface"))).toBe(true);
    const back = fixture(); back.steps = back.steps.filter((step: any) => step.step !== "pitch-to-shared-feature");
    expect(problems(back)).toContain("the feature has no front-door step");
  });

  /** Criterion 9: the acknowledgement cites the operator's G6 for Release 3, once the gates hold it. */
  test("criterion 9: an acknowledgement that cites no G6 for Release 3, or none once the gates hold one, fails", () => {
    const wrong = fixture(); wrong.acknowledgement = { gate: "G6-202610030339" };
    expect(problems(wrong)).toContain("the acknowledgement does not cite the operator's G6 for Release 3");
    const none = fixture(); none.acknowledgement = null;
    expect(problems(none)).toContain("the operator's acknowledgement (G6) is not cited");
    expect(problems(none, { requireAcknowledgement: false })).toEqual([]);
  });

  test("a record that carries a project token or a signed media or review link fails", () => {
    const token = fixture(); token.knownGaps.push("eyJraW5kIjoicHJvamVjdCJ9.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ");
    expect(problems(token)).toContain("the record carries a credential or a signed link");
    const link = fixture(); link.hero.stages[0].url = "/artifacts/x/hero/denoise.mp4";
    expect(problems(link)).toContain("the record carries a credential or a signed link");
    const review = fixture(); review.feature.review.decisionNote = "http://studio.test/#/review/abc";
    expect(problems(review)).toContain("the record carries a credential or a signed link");
  });

  /** Build step 15: the mock rehearsal is held to the same contract, waiving only what mock can't show, and spending nothing. */
  test("a mock rehearsal meets the contract as a rehearsal, never as the release, and a rehearsal that spends fails", () => {
    expect(problems(rehearsal(), { rehearsal: true })).toEqual([]);
    const asRelease = problems(rehearsal());
    expect(asRelease).toContain("sequence 1 carries a mock slate in the shared film");
    expect(asRelease).toContain("the joined film does not run 900-1200 s before its credits");
    const spent = rehearsal(); spent.ledgers.lines.generation.after.spentUsd += 1;
    expect(problems(spent, { rehearsal: true })).toContain("the generation line moved in a rehearsal");
    const declared = rehearsal(); declared.spendUsdDeclared = 5;
    expect(problems(declared, { rehearsal: true })).toContain("a rehearsal declares $0");
  });
});

/** The real record, once the release run (build step 16) has made it. Until then there is nothing to hold, and nothing is claimed. */
test.skipIf(!existsSync(resolve(REPO, RECORD_PATH)))("Release 3's run record meets its exit criteria (skipped until the release run records it)", () => {
  expect(release3Problems(JSON.parse(readFileSync(resolve(REPO, RECORD_PATH), "utf8")), real)).toEqual([]);
});
