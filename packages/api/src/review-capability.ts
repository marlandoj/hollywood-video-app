/**
 * The closed set of review-link capabilities, declared once.
 *
 * Before this module the set was spelled out independently in six places — the
 * verifier and the mint signature in `tokens.ts`, the `ReviewLink` type and the
 * two decision checks in `index.ts`, the create route in `server.ts`, the
 * snapshot validator in `packages/storage/src/snapshots.ts`, and the two
 * delegating signatures in `packages/storage/src/projects.ts`. Five of those
 * copies agreed. The sixth, the create route, coerced anything it did not
 * recognise to `approve`, so `{"permission":"reviewer"}` minted a link that
 * could approve a cut. A closed set that each reader re-declares is a set that
 * can disagree with itself; this module exists so that it cannot.
 *
 * This module imports nothing on purpose: it is read by the token layer, which
 * is itself read by `packages/storage`, and a capability name must not drag a
 * package graph behind it.
 *
 * **What is not here.** FULL-SCOPE P13 names eight capability-link roles —
 * owner, producer, director, writer, editor, sound, colourist, reviewer — with
 * scoped permissions, expiry and revocation. None of those eight is delivered,
 * and this module does not invent them: their scoped permissions are not
 * specified anywhere in the repository, and naming a role that no route can
 * mint and no reader honours would be scaffolding rather than a capability.
 * What this module provides is the single place they will be added, so that
 * adding them is one data edit rather than a seventh independent copy.
 */

/** Every capability a review link may carry today. Order is not significant. */
export const REVIEW_PERMISSIONS = ["read", "approve"] as const;

export type ReviewPermission = (typeof REVIEW_PERMISSIONS)[number];

/** True only for an exact member of the closed set; never widens a near miss. */
export function isReviewPermission(value: unknown): value is ReviewPermission {
  return typeof value === "string" && (REVIEW_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Narrows an untrusted value to the closed set, or throws. Callers that hold an
 * HTTP request body use this rather than a comparison chain, because a
 * comparison chain has to choose what the final `else` means and every such
 * choice so far has chosen the more privileged capability.
 */
export function reviewPermission(value: unknown): ReviewPermission {
  if (!isReviewPermission(value)) {
    throw new ReviewCapabilityError("Choose " + REVIEW_PERMISSIONS.join(" or ") + " for this review link.");
  }
  return value;
}

/**
 * Whether a capability may record an approval decision. Readers ask this rather
 * than comparing against a literal, so that no file outside this module needs
 * to name a member of the set at all.
 */
export function mayApprove(permission: ReviewPermission | undefined): boolean {
  return permission === "approve";
}

/** Distinguishes an unusable capability from every other 400 the route can raise. */
export class ReviewCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewCapabilityError";
  }
}
