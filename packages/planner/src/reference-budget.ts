import type {ReferenceAsset} from "./references";

/**
 * HV-019-17 (G22-202610041528): a shot's reference budget.
 *
 * A shot carries its characters' reference images: a locked look's images in the lock's order, or an
 * unlocked character's own (`renderReferences`). A locked look holds up to four, so a shot of two locked
 * characters carries eight, and the reference vendors (FLUX.2 edit, Kling O3 reference) take at most
 * four. Without a budget that shot is refused at admission ("render requirements: references").
 *
 * The budget is the largest reference count any provider in the render's pool accepts
 * (`poolReferenceBudget`); the router then sends the shot to a provider that takes that many. A pool in
 * which no provider takes a reference has no budget, so a shot with references is refused there exactly
 * as before: images are never dropped to fit a text-only provider.
 *
 * When a shot's images exceed the budget, a fixed subset is sent (`allocateReferences`):
 * - The budget is split evenly across the shot's characters that hold images, in prominence order:
 *   two each for two characters at four, and when it doesn't divide, the more prominent get one more
 *   (three characters at four: 2, 1, 1). A character with fewer images than its share passes the rest
 *   on, one at a time in prominence order.
 * - Each character's images are taken from the front of its own order: a locked look's order, which is
 *   the creator's (the desk locks a turnaround sheet front view first), else the order it holds them.
 * - With more characters than the budget, the most prominent get one image each, and the rest get none.
 *   They stay in the shot and in its written cast direction, and the record names each of them with
 *   every image dropped: no character leaves the record.
 *
 * Prominence is the shot's own (`castProminence` in casting.ts): characters who speak in it, in the order
 * they speak; then characters named in its action; then the scene's other characters; ties in cast order.
 *
 * The record (`ShotReferenceBudget`) goes on the shot and into its provenance, beside HV-017-17's
 * identity locks, only when something was dropped. A shot within budget is unchanged, byte for byte.
 */
export const REFERENCE_BUDGET_SCHEMA = "hv-reference-budget/1" as const;
export interface ReferenceBudgetEntry {
  characterId: string; name: string; locked: boolean;
  /** In the character's own order: the images the shot was conditioned on, then those it was not. */
  sent: {id: string; sha256: string}[]; dropped: {id: string; sha256: string}[];
}
export interface ShotReferenceBudget {
  schema: typeof REFERENCE_BUDGET_SCHEMA;
  /** The pool's largest reference count, which the shot's images were cut to. */
  max: number;
  /** How many images the shot's characters hold, before the cut. */
  carried: number;
  /** Every character in the shot that holds an image, in prominence order. */
  characters: ReferenceBudgetEntry[];
}
export interface BudgetCandidate {id: string; name: string; locked: boolean; views: Pick<ReferenceAsset, "id" | "sha256">[]}

/** The most reference images any provider in this pool takes, or null when none takes one. */
export function poolReferenceBudget(pool: readonly {snapshot: {input: {referenceFrames: number}}}[] | null | undefined): number | null {
  const most = Math.max(0, ...(pool ?? []).map(entry => entry.snapshot.input.referenceFrames));
  return most > 0 ? most : null;
}

/**
 * How many of each character's images the shot sends, with the record of what was cut, or null when
 * nothing needs cutting. `candidates` are in prominence order.
 */
export function allocateReferences(candidates: readonly BudgetCandidate[], max: number | null): {kept: Map<string, number>; record: ShotReferenceBudget | null} {
  const holding = candidates.filter(candidate => candidate.views.length > 0);
  const carried = holding.reduce((total, candidate) => total + candidate.views.length, 0);
  const kept = new Map(candidates.map(candidate => [candidate.id, candidate.views.length]));
  if (max === null || carried <= max) return {kept, record: null};
  if (!Number.isInteger(max) || max < 1) throw new Error("A reference budget is a positive whole number of images.");
  const take = holding.map((candidate, index) => holding.length > max
    ? (index < max ? 1 : 0)
    : Math.min(candidate.views.length, Math.floor(max / holding.length) + (index < max % holding.length ? 1 : 0)));
  let left = max - take.reduce((a, b) => a + b, 0);
  while (left > 0 && holding.length <= max) {
    const before = left;
    for (const [index, candidate] of holding.entries()) if (left > 0 && take[index]! < candidate.views.length) { take[index]!++; left--; }
    if (left === before) break;
  }
  for (const [index, candidate] of holding.entries()) kept.set(candidate.id, take[index]!);
  const digest = (asset: Pick<ReferenceAsset, "id" | "sha256">) => ({id: asset.id, sha256: asset.sha256});
  return {kept, record: {schema: REFERENCE_BUDGET_SCHEMA, max, carried, characters: holding.map((candidate, index) => ({characterId: candidate.id, name: candidate.name,
    locked: candidate.locked, sent: candidate.views.slice(0, take[index]).map(digest), dropped: candidate.views.slice(take[index]).map(digest)}))}};
}

/**
 * HV-019-16 meets HV-019-17. A recording adapter (the mock) writes `referenceRecord`: the images it was
 * sent, by digest, in order. A cut shot writes `referenceBudget`: which images the planner chose to send.
 * They describe one set of images from two sides, so where a shot has both they must be the same images
 * in the same order: the budget's `sent` in the shot's order, which is its reference set. Refused before
 * the encode otherwise, so the two records can never disagree.
 */
export function assertBudgetMatchesRecord(shot: {id: string; referenceAssets?: Pick<ReferenceAsset, "id" | "sha256">[]; referenceBudget?: ShotReferenceBudget},
  record: {images: {sha256: string}[]} | undefined): void {
  if (!shot.referenceBudget || !record) return;
  const sent = new Set(shot.referenceBudget.characters.flatMap(entry => entry.sent.map(asset => asset.id)));
  const ordered = (shot.referenceAssets ?? []).filter(asset => sent.has(asset.id)).map(asset => asset.sha256);
  if (ordered.length !== sent.size || ordered.length !== (shot.referenceAssets ?? []).length
    || record.images.length !== ordered.length || record.images.some((image, index) => image.sha256 !== ordered[index]))
    throw new Error("Shot " + shot.id + "'s recorded reference images are not the images its reference budget sent.");
}
