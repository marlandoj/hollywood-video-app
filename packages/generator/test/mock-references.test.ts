/**
 * HV-019-16 — the mock accepts a shot's reference images and records them (Release 3 step 15's $0 rehearsal).
 *
 * The rehearsal locked two characters' looks and the mock profile then refused the first rough cut:
 * "No configured provider supports these render requirements: references." The mock declared no
 * reference input, so on the mock profile no shot of a character holding a reference image could be
 * rendered at all. It now accepts any reference set a shot can carry, checks it as every reference
 * vendor does, and records each image by digest in its clip; it says, in its capability and in each
 * match, that the picture is not rendered from them. Every vendor's capability is unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CONDITIONING_INPUTS, REFERENCES_RECORDED_ADAPTATION, REFERENCES_RECORDED_NOT_RENDERED,
  baseCapability, capability, matchCapability, videoRequirements,
} from "../src/capabilities";
import { describeProvider } from "../src/catalog";
import { falVideoCapability } from "../src/fal";
import { falImageCapability } from "../src/fal-image";
import { DeterministicMockImageProvider, mockImageCapability } from "../src/image";
import { DeterministicMockProvider, RichAnimaticProvider, mockVideoCapability } from "../src/index";
import { PROVIDER_REGISTRY } from "../src/registry";
import { RoutedGenerator, type RouteDecision } from "../src/router";

const root = mkdtempSync(join(tmpdir(), "hv-mock-references-"));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let looks: Buffer[] = [], references: string[] = [];
beforeAll(async () => {
  const images = new DeterministicMockImageProvider();
  looks = await Promise.all(["a mustard scarf", "a leather apron", "a white beard", "a loupe on a cord"].map(async (look, index) =>
    readFileSync((await images.generateFrame("A fictional clockmaker in " + look, 21 + index, {}, join(root, "look-" + index + ".png"))).path)));
  references = looks.map(bytes => "data:image/png;base64," + bytes.toString("base64"));
});
afterAll(() => rmSync(root, {recursive: true, force: true}));

describe("what the mock declares", () => {
  test("the mock takes any reference set a shot can carry, says it records them, and still takes no identity lock", () => {
    for (const snapshot of [mockVideoCapability(), mockVideoCapability(.05), mockImageCapability(), describeProvider("mock", "animatic").snapshot,
      describeProvider("legacy-mock", "animatic").snapshot, describeProvider("mock", "character-sheet").snapshot, describeProvider("image:mock", "final").snapshot]) {
      expect([snapshot.input.referenceFrames, snapshot.input.minimumReferenceFrames, snapshot.input.identityLocks, snapshot.referenceUse])
        .toEqual([MAX_CONDITIONING_INPUTS, undefined, 0, REFERENCES_RECORDED_NOT_RENDERED]);
    }
    const shot = videoRequirements({widthxheight: "640x360", durationSec: 2, referenceFrames: references.concat(references)});
    for (const snapshot of [mockVideoCapability(), describeProvider("mock", "animatic").snapshot]) {
      const match = matchCapability(snapshot, shot, 1);
      expect([match.eligible, match.estimateUsd]).toEqual([true, 0]);
      expect(match.adaptations).toContain(REFERENCES_RECORDED_ADAPTATION);
      // A shot with no reference image is matched exactly as before: nothing is said about references.
      expect(matchCapability(snapshot, {...shot, referenceFrames: 0}, 1).adaptations).not.toContain(REFERENCES_RECORDED_ADAPTATION);
      expect(matchCapability(snapshot, {...shot, identityLocks: 1}, 1).reasons).toEqual(["identity"]);
    }
    // One past the most a shot can carry is not a shot at all.
    expect(() => videoRequirements({referenceFrames: Array(MAX_CONDITIONING_INPUTS + 1).fill("x")})).toThrow("Invalid shot requirements.");
  });

  test("the declaration is the mock's alone: every vendor and every other local adapter is matched as before", () => {
    const declaring = PROVIDER_REGISTRY.filter(entry => describeProvider(entry.spec, entry.stage).snapshot.referenceUse !== undefined)
      .map(entry => entry.stage + ":" + entry.spec).sort();
    expect(declaring).toEqual(["animatic:legacy-mock", "animatic:mock", "character-sheet:mock", "final:image:mock", "final:mock"]);
    expect(PROVIDER_REGISTRY.filter(entry => entry.paid).every(entry => describeProvider(entry.spec, entry.stage, {FAL_KEY: "fixture"}).snapshot.referenceUse === undefined)).toBe(true);
    // A vendor that conditions on references is not described as recording them, and one that takes none still refuses them.
    const shot = videoRequirements({widthxheight: "640x360", durationSec: 2, referenceFrames: references.slice(0, 2)});
    const kling = matchCapability(falVideoCapability("kling-o3-standard-reference"), shot, 1);
    expect([kling.eligible, kling.adaptations.includes(REFERENCES_RECORDED_ADAPTATION)]).toEqual([true, false]);
    expect(matchCapability(falVideoCapability(), shot, 5).reasons).toEqual(["references"]);
    expect(matchCapability(describeProvider("image:fal:flux-schnell", "animatic").snapshot, shot, 5).reasons).toEqual(["references"]);
    expect(matchCapability(falVideoCapability("kling-o3-standard-reference"), {...shot, referenceFrames: 5}, 5).reasons).toEqual(["references"]);
    expect(falImageCapability("flux-2-edit").referenceUse).toBeUndefined();
  });

  test("the declaration is refused on an adapter that takes no reference, and takes no other value", () => {
    const definition = baseCapability("fixture", "fixture-model", "video");
    expect(() => capability({...definition, referenceUse: REFERENCES_RECORDED_NOT_RENDERED})).toThrow("Invalid provider capability configuration.");
    expect(() => capability({...definition, input: {...definition.input, referenceFrames: 2}, referenceUse: "rendered" as never})).toThrow("Invalid provider capability configuration.");
    const recorded = capability({...definition, input: {...definition.input, referenceFrames: 2}, referenceUse: REFERENCES_RECORDED_NOT_RENDERED});
    // The declaration is part of the capability's identity, so a plan admitted before it can't run on it.
    expect(recorded.revision).not.toBe(capability({...definition, input: {...definition.input, referenceFrames: 2}}).revision);
  });
});

describe("what the mock records", () => {
  test("a final-stage mock render of a locked shot succeeds, records each image by digest in order, and renders the same picture", async () => {
    const provider = new DeterministicMockProvider(), params = {seed: 9, widthxheight: "640x360", durationSec: 1};
    const plain = await provider.generate("WREN and OSWIN at the bench.", 9, params, join(root, "plain.mp4"));
    const locked = await provider.generate("WREN and OSWIN at the bench.", 9, {...params, referenceFrames: [references[1]!, references[0]!, references[3]!]}, join(root, "locked.mp4"));
    expect(plain.referenceRecord).toBeUndefined();
    expect(locked.referenceRecord).toEqual({use: REFERENCES_RECORDED_NOT_RENDERED,
      images: [looks[1]!, looks[0]!, looks[3]!].map(bytes => ({sha256: sha(bytes), bytes: bytes.length}))});
    expect(locked.fingerprint).toBe(plain.fingerprint);
    expect(sha(readFileSync(locked.path))).toBe(sha(readFileSync(plain.path)));
    expect(locked.cost.total_cost_usd).toBe(0);
  });

  test("a rough-cut mock render of a locked shot succeeds and records the images through the animatic", async () => {
    const provider = new RichAnimaticProvider(new DeterministicMockImageProvider()), params = {seed: 4, widthxheight: "640x360", durationSec: 1, cameraMove: "static" as const};
    const plain = await provider.generate("WREN runs along the harbour wall.", 4, params, join(root, "plain-rough.mp4"));
    const locked = await provider.generate("WREN runs along the harbour wall.", 4, {...params, referenceFrames: references}, join(root, "locked-rough.mp4"));
    expect(plain.referenceRecord).toBeUndefined();
    expect(locked.referenceRecord?.images.map(image => image.sha256)).toEqual(looks.map(sha));
    expect(sha(readFileSync(locked.posterPath!))).toBe(sha(readFileSync(plain.posterPath!)));
    expect(locked.cost.total_cost_usd).toBe(0);
  });

  test("the routed render names the adaptation, and the mock still refuses what a reference vendor refuses", async () => {
    const decisions: RouteDecision[] = [];
    const router = new RoutedGenerator({candidates: [{id: "mock", adapter: new DeterministicMockProvider()}], maxAttemptUsd: 1, onDecision: async decision => { decisions.push(decision); }});
    const clip = await router.generate("OSWIN sets the loupe down.", 3, {seed: 3, shotId: "shot-1-1", widthxheight: "640x360", durationSec: 1, referenceFrames: references.slice(0, 2)}, join(root, "routed.mp4"));
    expect(clip.routing?.adaptations).toContain(REFERENCES_RECORDED_ADAPTATION);
    expect(decisions.map(decision => [decision.selectedId, decision.candidates[0]!.adaptations.includes(REFERENCES_RECORDED_ADAPTATION)])).toEqual([["mock", true]]);
    expect(clip.routing?.selectedCapability.referenceUse).toBe(REFERENCES_RECORDED_NOT_RENDERED);
    expect(clip.referenceRecord?.images.map(image => image.sha256)).toEqual(looks.slice(0, 2).map(sha));
    const provider = new DeterministicMockProvider(), images = new DeterministicMockImageProvider();
    for (const refs of [["https://example.test/private.png"], ["data:image/png;base64,AAAA"], [references[0]!.replace("image/png", "image/jpeg")]]) {
      await expect(provider.generate("A clock face.", 1, {seed: 1, referenceFrames: refs}, join(root, "refused.mp4"))).rejects.toThrow();
      await expect(images.generateFrame("A clock face.", 1, {referenceFrames: refs}, join(root, "refused.png"))).rejects.toThrow();
    }
    await expect(provider.generate("A clock face.", 1, {seed: 1, identityLocks: ["wren"]}, join(root, "refused.mp4"))).rejects.toThrow("identity conditioning is not implemented");
    await expect(images.generateFrame("A clock face.", 1, {identityLocks: ["wren"]}, join(root, "refused.png"))).rejects.toThrow("identity conditioning is not implemented");
  });
});
