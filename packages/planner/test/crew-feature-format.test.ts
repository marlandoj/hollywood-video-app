/**
 * HV-030-28 — Release 3 step 1: the feature format, and a read-through that quotes the active profile.
 *
 * G20-202610031349 agreed a `feature` beside the reel (90 s) and the short (600 s), up to 1,200 s, and
 * the look-matched (anchored) picture profile for the live feature, at about $0.42 a shot. Two things
 * stood in the way, both found in code by HV-030-27:
 *
 * - the read-through, the plan step and the style card refused any format but `reel` and `short`;
 * - the read-through quoted Kling 2.5 (`ESTIMATE_VIDEO_SPEC`, $0.35 a 5 s clip) whatever the profile,
 *   so an anchored film was quoted a fifth short.
 *
 * The prices here are read from `FAL_MODELS` and the profiles from `scripts/staging-providers.py`, so
 * a price or profile change moves these expectations rather than leaving them stale.
 */
import { describe, expect, test } from "bun:test";
import { stagingProfile } from "../../../test/fixtures/staging-profiles";
import { configuredPool } from "../../generator/src/catalog";
import { FAL_MODELS } from "../../generator/src/fal";
import { parseFountain } from "../../parser/src/index";
import { planShots, type Shot } from "../src/index";
import { FILM_FORMATS, FORMAT_LIMIT_SEC, isFilmFormat } from "../src/crew/formats";
import { billedShotTiming, pacedSeconds, planInput } from "../src/crew/production-plan";
import { ESTIMATE_VIDEO_SPEC, READ_THROUGH_SHOT_LIMIT, quotedLane, readThroughFacts, readThroughInput } from "../src/crew/read-through";
import { STYLE_CARD_SCHEMA, styleCardInput } from "../src/crew/style-card";

const anchored = stagingProfile("live-film-anchored"), liveFilm = stagingProfile("live-film"), mock = stagingProfile("mock");
const finalPool = (profile: Record<string, string>) => configuredPool("final", {HV_PROVIDER_PRIMARY: profile.HV_PROVIDER_PRIMARY, HV_PROVIDER_SECONDARY: profile.HV_PROVIDER_SECONDARY});

const O3_SHOT_USD = FAL_MODELS["kling-o3-standard-keyframes"]!.usdPerBilledSecond * 5;
const KLING_SHOT_USD = FAL_MODELS["kling-v2.5-turbo-pro"]!.usdPerBilledSecond * 5;
const SILENT = "INT. ROOM - DAY\n\nThe kettle starts to sing.";
const parsedSilent = parseFountain(SILENT);
/** `count` silent shots of `sec` seconds each, as a planned film would carry them. */
const shots = (count: number, sec = 2): Shot[] => Array.from({length: count}, (_, index) => ({id: "shot-1-" + (index + 1), sceneIndex: 0, prompt: "INT. ROOM - DAY. The kettle starts to sing.", dialogue: [], durationSec: sec, seed: index + 1}));

describe("the feature format (G20-202610031349)", () => {
  test("three formats: a reel up to 90 s, a short up to 600 s and a feature up to 1,200 s", () => {
    expect(FILM_FORMATS).toEqual(["reel", "short", "feature"]);
    expect(FORMAT_LIMIT_SEC).toEqual({reel: 90, short: 600, feature: 1200});
    expect(Object.isFrozen(FILM_FORMATS) && Object.isFrozen(FORMAT_LIMIT_SEC)).toBe(true);
  });

  test("the read-through, the plan step and the style card accept a feature", () => {
    expect(readThroughInput({format: "feature", tone: "slow and tender"})).toEqual({format: "feature", tone: "slow and tender"});
    expect(planInput({format: "feature", tone: "", answers: []}).format).toBe("feature");
    expect(styleCardInput({schema: STYLE_CARD_SCHEMA, format: "feature", tone: "", look: "", choices: []}).format).toBe("feature");
  });

  test("and each still refuses every other format, as before", () => {
    for (const format of ["film", "Feature", "FEATURE", " feature", "feature ", "features", "movie", "long", "", "reel,short", 1200, null, undefined, true, ["feature"], {feature: true}]) {
      expect(isFilmFormat(format)).toBe(false);
      expect(() => readThroughInput({format, tone: ""})).toThrow("Choose a reel, a short or a feature");
      expect(() => planInput({format, tone: "", answers: []})).toThrow("Send the format");
      expect(() => styleCardInput({schema: STYLE_CARD_SCHEMA, format, tone: "", look: "", choices: []})).toThrow("can't read this style card");
    }
  });

  test("a feature is over its format only past 1,200 s; a short is over past 600 s", () => {
    const at = (format: "short" | "feature", count: number) => readThroughFacts(SILENT, parsedSilent, {format, tone: ""}, shots(count, 5)).concerns.map(concern => concern.kind);
    expect(at("short", 121)).toContain("over_format"); // 605 s
    expect(at("feature", 121)).not.toContain("over_format");
    expect(at("feature", 240)).not.toContain("over_format"); // 1,200 s exactly
    expect(at("feature", 241)).toContain("over_format"); // 1,205 s
    expect(readThroughFacts(SILENT, parsedSilent, {format: "feature", tone: ""}, shots(1)).formatLimitSec).toBe(1200);
  });

  test("a feature is read whole, up to 240 shots; a reel and a short as one 24-shot render, as before", () => {
    expect(READ_THROUGH_SHOT_LIMIT).toEqual({reel: 24, short: 24, feature: 240});
    // Three long scenes of 100 action paragraphs each: the planner groups paragraphs to fit the limit.
    const long = Array.from({length: 3}, (_, scene) => `INT. ROOM ${scene + 1} - DAY\n\n` + Array.from({length: 100}, (_, i) => `Beat ${i + 1}: someone crosses the room.`).join("\n\n")).join("\n\n");
    const parsed = parseFountain(long);
    expect(planShots(parsed, 7000, READ_THROUGH_SHOT_LIMIT.reel).length).toBe(24);
    expect(planShots(parsed, 7000, READ_THROUGH_SHOT_LIMIT.feature).length).toBe(240);
  });
});

describe("the read-through quotes the active picture profile (HV-030-27's constraint 4)", () => {
  test("the staging profiles are what HV-030-27 read: anchored leads with Kling O3 keyframes, live-film with Kling 2.5", () => {
    expect(anchored.HV_PROVIDER_PRIMARY).toBe("fal:kling-o3-standard-keyframes");
    expect(anchored.HV_PROVIDER_SECONDARY).toBe(ESTIMATE_VIDEO_SPEC);
    expect(liveFilm.HV_PROVIDER_PRIMARY).toBe(ESTIMATE_VIDEO_SPEC);
    expect(mock.HV_PROVIDER_PRIMARY).toBe("mock");
    expect(O3_SHOT_USD).toBeCloseTo(0.42, 10);
    expect(KLING_SHOT_USD).toBeCloseTo(0.35, 10);
  });

  test("on the anchored profile a shot is quoted at $0.42, the O3 keyframe lane at the Editor's 5 s pace", () => {
    const facts = readThroughFacts(SILENT, parsedSilent, {format: "reel", tone: ""}, shots(10), finalPool(anchored));
    expect(facts.estimate).toEqual({videoSpec: "fal:kling-o3-standard-keyframes", basis: "profile", finalVideoUsd: Number((10 * O3_SHOT_USD).toFixed(2))});
    expect(facts.estimate.finalVideoUsd).toBe(4.2);
  });

  test("a 200-240-shot anchored feature is quoted $84-$101, as G20 agreed", () => {
    const quote = (count: number) => readThroughFacts(SILENT, parsedSilent, {format: "feature", tone: ""}, shots(count), finalPool(anchored)).estimate.finalVideoUsd;
    expect(quote(200)).toBe(84);
    expect(quote(240)).toBe(100.8);
  });

  test("on the live-film profile a shot is quoted at Kling 2.5's $0.35", () => {
    const facts = readThroughFacts(SILENT, parsedSilent, {format: "short", tone: ""}, shots(10), finalPool(liveFilm));
    expect(facts.estimate).toEqual({videoSpec: ESTIMATE_VIDEO_SPEC, basis: "profile", finalVideoUsd: 3.5});
  });

  test("on the mock profile, with no billed lane, the quote is the reference lane's, exactly as before", () => {
    const pool = finalPool(mock);
    expect(quotedLane(pool)).toMatchObject({basis: "reference", lane: {spec: ESTIMATE_VIDEO_SPEC}});
    for (const given of [pool, null, undefined]) {
      const facts = readThroughFacts(SILENT, parsedSilent, {format: "reel", tone: ""}, shots(10), given);
      expect(facts.estimate).toEqual({videoSpec: ESTIMATE_VIDEO_SPEC, basis: "reference", finalVideoUsd: 3.5});
    }
  });

  test("a shot whose lines need longer is quoted at the longer clip the Editor will pace it to", () => {
    // 22 words of dialogue take longer than 5 s to say, so the Editor holds the shot to a longer O3 clip.
    const line = "I kept every letter you sent me, and I read them all again last night, slowly, one by one, until morning came.";
    const talking: Shot = {...shots(1)[0]!, dialogue: [{character: "MAYA", lines: [line]}]};
    const usd = readThroughFacts(SILENT, parsedSilent, {format: "reel", tone: ""}, [talking], finalPool(anchored)).estimate.finalVideoUsd!;
    const paced = pacedSeconds(billedShotTiming(finalPool(anchored))!, talking)!;
    expect(paced).toBeGreaterThan(5);
    expect(usd).toBe(Number((paced * FAL_MODELS["kling-o3-standard-keyframes"]!.usdPerBilledSecond).toFixed(2)));
    expect(usd).toBeGreaterThan(O3_SHOT_USD);
  });

  test("a retired lane is never the one quoted", () => {
    const pool = configuredPool("final", {HV_PROVIDER_POOL: JSON.stringify(["fal:veo3-fast", "fal:kling-v2.5-turbo-pro"])});
    expect(pool[0]!.snapshot.lifecycle).toBe("retired");
    expect(quotedLane(pool).lane.spec).toBe("fal:kling-v2.5-turbo-pro");
  });
});
