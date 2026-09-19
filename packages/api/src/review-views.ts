import { createHash } from "node:crypto";

/**
 * HV-029-05 -- what a review-link "view" is.
 *
 * FR-047: review links expire after 7 days or 3 views (configurable). A view used to be
 * every GET of the link, counted before the route knew whether it had anything to show,
 * so an early open, a refused cut or a page reload each spent one of three. Now a view is
 * one viewer who was shown the cut. The review page generates a random viewer id per
 * browser tab (sessionStorage, never a cookie, never sent anywhere but this link's own
 * API calls) and sends it as `x-hv-review-viewer`; the link stores only its SHA-256.
 * A request without one counts on every serve, as before.
 */
export const REVIEW_VIEWER_HEADER = "x-hv-review-viewer";
/** The owner may choose 1..REVIEW_VIEW_LIMIT_MAX views; FR-047's default of 3 is unchanged. */
export const REVIEW_VIEW_LIMIT_MAX = 25;
const VIEWER_ID = /^[A-Za-z0-9_-]{22,64}$/;

export interface ReviewViewer { hash: string }

export function reviewViewer(value: string | null | undefined): ReviewViewer | null {
  if (typeof value !== "string" || !VIEWER_ID.test(value)) return null;
  return {hash: createHash("sha256").update("hv-review-viewer:" + value).digest("hex")};
}

export function reviewViewerKnown(link: {viewers?: string[]}, viewer: ReviewViewer | null): boolean {
  return viewer !== null && (link.viewers ?? []).includes(viewer.hash);
}

export class ReviewViewLimitError extends Error { override name = "ReviewViewLimitError"; }

export function reviewViewLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > REVIEW_VIEW_LIMIT_MAX)
    throw new ReviewViewLimitError("Choose a view limit from 1 to " + REVIEW_VIEW_LIMIT_MAX + ".");
  return value as number;
}
