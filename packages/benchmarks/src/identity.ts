import { continuityScore, frameFingerprint } from "../../generator/src/index";
import type { Shot } from "../../planner/src/index";

/**
 * HV-037-02. The benchmark's first **measured** score: how closely a rendered shot resembles the
 * locked reference image of a character who is in it.
 *
 * It reuses the one picture comparison the studio already has, rather than adding a model:
 * `frameFingerprint` (packages/generator/src/fal.ts) reduces a frame to a 17x16 grayscale picture
 * and keeps one bit per horizontally adjacent pair -- a 256-bit difference hash -- and
 * `continuityScore` (packages/generator/src/index.ts) is the share of those bits two hashes agree
 * on. The Supervisor's continuity check compares shot to shot with exactly this pair of functions;
 * here the comparison is reference image to rendered frame.
 *
 * What it is, said plainly so no later reader takes it for more:
 * - **A whole-frame structural measure, not a face-identity embedding.** A shot that frames the
 *   character as the reference does scores high; the same face in a wide shot need not. FULL-SCOPE
 *   P2's identity embedding was never built (packages/planner/src/reference-lock.ts says so), and
 *   nothing in the repository could stand in for it without a new model or dependency.
 * - **Measured from the rendered file.** The frame hash is computed here, from the clip on disk, at
 *   the middle of the clip -- never read from `VideoClip.fingerprint`, which the deterministic mock
 *   provider fills with a SHA-256 of its prompt rather than of any picture.
 * - **Scale.** 1 is identical structure; unrelated pictures land near 0.5, since each bit is a
 *   coin toss between them.
 * - **A flat frame carries no evidence.** A frame with no horizontal gradient at 17x16 (a solid
 *   colour -- every frame the mock provider renders) hashes to all zeros, and its "similarity" to a
 *   reference would only count the reference's zero bits. Such a frame is reported, and not scored.
 */
export const IDENTITY_METRIC = {
  id: "identity-dhash256-midframe/1",
  method: "256-bit difference hash (the studio's frameFingerprint: 17x16 grayscale, area-scaled) of the rendered clip's middle frame, "
    + "compared bit for bit (the studio's continuityScore) with the same hash of the character's locked reference image. "
    + "1 is identical structure; unrelated pictures score near 0.5. A whole-frame structural measure, not a face-identity embedding.",
} as const;

const FINGERPRINT = /^[0-9a-f]{64}$/;

/** The hash of a still reference image (PNG), at its only frame. */
export function stillFingerprint(path: string): string {
  return frameFingerprint(path, 0);
}

/** The hash of a rendered clip's middle frame, read from the file -- the point the studio's providers fingerprint. */
export function renderedFrameFingerprint(clipPath: string, durationSec: number): { atSec: number; fingerprint: string } {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("A rendered clip must have a positive duration to be measured.");
  const atSec = Number((durationSec / 2).toFixed(3));
  return { atSec, fingerprint: frameFingerprint(clipPath, atSec) };
}

/** No horizontal gradient anywhere at 17x16: a solid or near-solid frame. */
export function isFlatFingerprint(fingerprint: string): boolean {
  if (!FINGERPRINT.test(fingerprint)) throw new Error("A frame fingerprint is 64 lowercase hex characters.");
  return /^0{64}$/.test(fingerprint) || /^f{64}$/.test(fingerprint);
}

/** The studio's own comparison, applied to a reference and a rendered frame. */
export function identitySimilarity(referenceFingerprint: string, frameFingerprintHex: string): number {
  if (!FINGERPRINT.test(referenceFingerprint) || !FINGERPRINT.test(frameFingerprintHex)) throw new Error("A frame fingerprint is 64 lowercase hex characters.");
  return continuityScore({ fingerprint: referenceFingerprint }, { fingerprint: frameFingerprintHex });
}

/**
 * The locked characters a shot shows: those who speak in it, and those its action names as a whole
 * word. Only characters with a reference image are returned, in name order. A voice with no
 * reference (the corpus's VOICE) is never scored, and an unnamed "two figures" is not guessed at.
 */
export function shotCharacters(shot: Pick<Shot, "prompt" | "dialogue">, referenced: Iterable<string>): string[] {
  const names = new Set([...referenced].map(name => name.toUpperCase()));
  const present = new Set<string>();
  for (const line of shot.dialogue) if (names.has(line.character.toUpperCase())) present.add(line.character.toUpperCase());
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(shot.prompt)) present.add(name);
  }
  return [...present].sort();
}

export interface ShotIdentity {
  /** Per character in the shot, the measured similarity of the frame to that character's reference. */
  identity: { character: string; score: number }[];
  /** The mean over `identity`, or null when nothing was scored. */
  identityScore: number | null;
  flatFrame: boolean;
}

/** Score one rendered frame against the references of the characters in its shot. */
export function scoreShotIdentity(frameFingerprintHex: string, characters: readonly string[], references: Readonly<Record<string, string>>): ShotIdentity {
  const flatFrame = isFlatFingerprint(frameFingerprintHex);
  if (flatFrame) return { identity: [], identityScore: null, flatFrame };
  const identity = characters.map(character => {
    const reference = references[character];
    if (!reference) throw new Error(`No reference fingerprint for ${character}.`);
    return { character, score: identitySimilarity(reference, frameFingerprintHex) };
  });
  return { identity, identityScore: identity.length ? identity.reduce((sum, value) => sum + value.score, 0) / identity.length : null, flatFrame };
}
