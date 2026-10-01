import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RELEASE_2_LINES, RELEASE_2_PARTS } from "../scripts/release-2-run";
import { RECORD_PATH, REPO, gateIds, readCriteria, realContext, release2Problems, type Context } from "./release-2-contract";

/**
 * HV-030-22: Release 2's exit criteria, and the record that will prove them.
 *
 * The criteria are docs/ROADMAP.md's "Release 2 exit criteria". No run has been made yet (that is
 * HV-030-23), so the contract is proved on a synthetic fixture under test/fixtures/, never under
 * docs/evidence/: evidence is never fabricated. Each criterion is shown to bite by breaking the
 * fixture in exactly that way. Once docs/evidence/release-2/release-run.json exists, the last test
 * holds the real record to the same criteria, against the real gate entries only.
 */
const FIXTURE_DIR = "test/fixtures/release-2-run/";
const fixture = () => JSON.parse(readFileSync(resolve(REPO, FIXTURE_DIR, "release-run.fixture.json"), "utf8"));
const real = realContext();
/** The real gates, plus the one synthetic entry the fixture's deferrals cite. */
const fixtureContext: Context = { ...real, fixture: true, evidenceRoot: FIXTURE_DIR,
  gates: [...real.gates, ...gateIds(readFileSync(resolve(REPO, FIXTURE_DIR, "gates.fixture.md"), "utf8"))] };
const problems = (record: unknown) => release2Problems(record, fixtureContext);

describe("the criteria", () => {
  /** The parts table covers every slice the Release 2 table names, and the driver fills the same parts and lines. */
  test("the criteria name a part for every Release 2 slice, and the driver records the roadmap's parts and lines", () => {
    const { epics, parts, lines } = readCriteria(readFileSync(resolve(REPO, "docs/ROADMAP.md"), "utf8"));
    expect(epics).toEqual(["HV-030", "HV-021", "HV-017", "HV-022", "HV-024", "HV-026", "HV-027", "HV-016", "HV-029", "HV-031", "HV-039"]);
    expect([...new Set(parts.map(part => part.epic))].sort()).toEqual([...epics].sort());
    for (const part of parts) expect(part.part.startsWith(part.epic + ".")).toBe(true);
    expect(Object.fromEntries(parts.map(part => [part.part, part.surface]))).toEqual({ ...RELEASE_2_PARTS });
    expect(lines).toEqual({ ...RELEASE_2_LINES });
    expect(lines).toEqual({ generation: 450, voice: 25, music: 10, crew: 25 });
  });

  /** GPT-Live-1 is deferred under G15, so the deferral the run will cite is a real entry. */
  test("the deferral the run will cite for voice meetings is a real gate entry", () => {
    expect(real.gates).toContain("G15-202609301223");
    expect(readFileSync(resolve(REPO, "docs/loop/HUMAN-GATES.md"), "utf8")).toContain("**G3 GPT-Live-1:** deferred");
  });
});

describe("the contract, on a synthetic fixture", () => {
  /** The fixture is the shape the real run must take, and it lives outside the evidence. */
  test("the synthetic fixture meets every criterion, and is kept outside docs/evidence", () => {
    expect(FIXTURE_DIR.startsWith("docs/evidence")).toBe(false);
    expect(fixture().fixture).toContain("never evidence");
    expect(problems(fixture())).toEqual([]);
  });

  /** A fixture is never a release: the real record may not carry the fixture marker. */
  test("a synthetic fixture cannot stand as the release's evidence", () => {
    expect(release2Problems(fixture(), { ...fixtureContext, fixture: false })).toContain("a synthetic fixture cannot stand as the release's evidence");
  });

  /** Criterion 1. */
  test("film B pitched without film A's style card, or without the crew reading it, fails", () => {
    const other = fixture(); other.films[1].styleCard.attached.sha256 = "f".repeat(64);
    expect(problems(other)).toContain("film B was not pitched with the style card film A kept, read by the crew");
    const unread = fixture(); unread.films[1].readStyleCard = false;
    expect(problems(unread)).toContain("film B was not pitched with the style card film A kept, read by the crew");
    const one = fixture(); one.films.pop();
    expect(problems(one)).toContain("the record does not hold exactly two films, A and B");
  });

  /** Criterion 2. */
  test("a film with no timecoded comment, or a decision that names no stage, fails", () => {
    const silent = fixture(); silent.films[0].review.comments = [];
    expect(problems(silent)).toContain("film A has no timecoded comment");
    const unstaged = fixture(); unstaged.films[1].review.decisionStage = null;
    expect(problems(unstaged)).toContain("film B's reviewer did not decide a stage");
    const offFrame = fixture(); offFrame.films[0].review.comments[0].timecode = "00:00:00:00";
    expect(problems(offFrame)).toContain("film A has a comment that is not pinned to a frame");
    const unopened = fixture(); unopened.films[0].review.views = 0;
    expect(problems(unopened)).toContain("film A's review link was not opened on the shared film");
  });

  /** Criterion 3. */
  test("a part left unsaid, deferred to an entry that does not exist, or exercised with ids no step reported, fails", () => {
    const unsaid = fixture(); unsaid.slices["HV-024.sfx"].deferredBy = null;
    expect(problems(unsaid)).toContain("HV-024.sfx is neither exercised nor deferred to a gate entry that exists");
    const invented = fixture(); invented.slices["HV-024.sfx"].deferredBy = "G99-209912312359";
    expect(problems(invented)).toContain("HV-024.sfx is neither exercised nor deferred to a gate entry that exists");
    const missing = fixture(); delete missing.slices["HV-027.mezzanine"];
    expect(problems(missing)).toContain("HV-027.mezzanine is not accounted for");
    const unreported = fixture(); unreported.slices["HV-024.music"].ids.push("00000000-0000-4000-8000-0000000000ff");
    expect(problems(unreported)).toContain("HV-024.music has ids no step reported");
    const fake = fixture(); fake.slices["HV-017.identity-lock"].ids = ["RUTH"];
    expect(problems(fake)).toContain("HV-017.identity-lock has an id that is not a real studio id: RUTH");
    const nowhere = fixture(); nowhere.slices["HV-039.wcag"].ids = ["docs/NO-SUCH-AUDIT.md"];
    expect(problems(nowhere)).toContain("HV-039.wcag has an id that is not a real repository path: docs/NO-SUCH-AUDIT.md");
    const wrongSurface = fixture(); wrongSurface.slices["HV-029.timecoded-comments"].surface = "desk-api";
    expect(problems(wrongSurface)).toContain("HV-029.timecoded-comments names the wrong surface");
  });

  /** Criterion 4. */
  test("a line over its own limit, or a run over its declared spend, fails", () => {
    const voice = fixture(); voice.ledgers.lines.voice.after = { spentUsd: 24.99, heldUsd: 0.03 };
    expect(problems(voice)).toContain("the voice line is over its $25 limit");
    const music = fixture(); music.ledgers.lines.music.after = { spentUsd: 10.01, heldUsd: 0 };
    expect(problems(music)).toContain("the music line is over its $10 limit");
    const declared = fixture(); declared.spendUsdDeclared = 1;
    expect(problems(declared)).toContain("the run spent more than it declared");
    const unrecorded = fixture(); unrecorded.ledgers.lines.crew.after = null;
    expect(problems(unrecorded)).toContain("the crew line has no before and after");
    const film = fixture(); film.films[0].spend.spentUsd = 41;
    expect(problems(film)).toContain("film A is not within its own film cap");
  });

  /** Criterion 5. */
  test("a host that holds the key but whose sidecar does not match its record, or was not verified, fails", () => {
    const mismatch = fixture(); mismatch.provenance.exports[1].sidecar.matchesRecord = false;
    expect(problems(mismatch)).toContain("film A's shared export has no signed sidecar matching its record");
    const unverified = fixture(); unverified.provenance.exports[3].verification = null;
    expect(problems(unverified)).toContain("film B's signed sidecar was not verified");
    const keyless = fixture(); keyless.provenance.hostHoldsKey = false;
    expect(problems(keyless)).toContain("signed C2PA is exercised, but the host holds no key");
  });

  /** Criterion 6. */
  test("a record that used the desk and says the desk was never opened fails, and every step names its surface", () => {
    const claimed = fixture(); claimed.films[0].directorsDesk = false;
    expect(problems(claimed)).toContain("the record says the Director's desk was never opened, but a step used it");
    const unnamed = fixture(); unnamed.steps[4].surface = "desk";
    expect(problems(unnamed).some(problem => problem.startsWith("a step does not name its surface"))).toBe(true);
  });

  /** No key to a film, an actor or a review travels in the record. */
  test("a record that carries a project token or a signed media link fails", () => {
    const token = fixture(); token.knownGaps.push("eyJraW5kIjoicHJvamVjdCJ9.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ");
    expect(problems(token)).toContain("the record carries a credential or a signed link");
    const link = fixture(); link.provenance.exports[0].manifest = "/artifacts/x/provenance.json";
    expect(problems(link)).toContain("the record carries a credential or a signed link");
  });
});

/** The real record, once HV-030-23 has made it. Until then there is nothing to hold, and nothing is claimed. */
test.skipIf(!existsSync(resolve(REPO, RECORD_PATH)))("Release 2's run record meets its exit criteria (skipped until HV-030-23 records the run)", () => {
  expect(release2Problems(JSON.parse(readFileSync(resolve(REPO, RECORD_PATH), "utf8")), real)).toEqual([]);
});
