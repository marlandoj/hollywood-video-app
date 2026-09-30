import { checkPrompt, type SafetyVerdict } from "../../safety/src/index";

/**
 * HV-029-14 -- timecoded review comments and the stage a review decision approves.
 *
 * A comment is pinned to one frame of the one cut a review link is bound to. Frames are counted at
 * the studio's 30 fps, so the owner's player lands on the frame the reviewer paused on. A comment
 * carries no identity: the only thing that says who wrote it is the link's own anonymous viewer
 * hash, which is kept only on links that count viewers by id (ADR-0018). It lives inside the review
 * link record, so it is retained, exported and purged with the link, and the link with its project.
 *
 * This module imports only the safety gate: it is read by `packages/storage`'s snapshot validator.
 */
export const REVIEW_FPS = 30;
/** Comments one review link may hold. */
export const REVIEW_COMMENTS_MAX = 50;
/** Characters (code points) in one comment. */
export const REVIEW_COMMENT_MAX_CHARS = 500;
/** One past the last frame a comment may name: four hours at 30 fps. */
export const REVIEW_COMMENT_FRAME_LIMIT = 4 * 60 * 60 * REVIEW_FPS;

export interface ReviewComment {
  id: string;
  /** Frame index at REVIEW_FPS, from the first frame of the bound cut. */
  frame: number;
  text: string;
  /** The link's viewer hash for the reviewer who wrote it, or null on a link that keeps none. */
  viewer: string | null;
  at: string;
  resolvedAt: string | null;
}

/** The production stages a review decision can approve, in the order a film passes through them. */
export const REVIEW_STAGES = ["rough-cut", "final", "picture-edit", "sound-mix", "deliverable"] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];
export const REVIEW_STAGE_LABELS: Record<ReviewStage, string> = {
  "rough-cut": "Rough cut (animatic)", final: "Final", "picture-edit": "Picture edit", "sound-mix": "Sound mix", deliverable: "Deliverable",
};

/**
 * The stage a decision on a cut of this job stage approves. Only a job stage a review link can be
 * bound to has one; anything else is null, and a decision on it is refused rather than guessed.
 * Dialogue replacement and lip sync are versions of the film's sound and dialogue, so they are
 * approved as the sound mix.
 */
export function reviewStage(jobStage: string): ReviewStage | null {
  switch (jobStage) {
    case "animatic": case "take-preview": return "rough-cut";
    case "final": case "take-final": return "final";
    case "picture-edit": case "assembly-edit": return "picture-edit";
    case "sound-mix": case "dialogue-replacement": case "lip-sync": return "sound-mix";
    case "delivery": return "deliverable";
    default: return null;
  }
}
export function isReviewStage(value: unknown): value is ReviewStage {
  return typeof value === "string" && (REVIEW_STAGES as readonly string[]).includes(value);
}

/** HH:MM:SS:FF at REVIEW_FPS. */
export function reviewTimecode(frame: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const seconds = Math.floor(frame / REVIEW_FPS);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, frame % REVIEW_FPS].map(pad).join(":");
}

export class ReviewCommentError extends Error { override name = "ReviewCommentError"; }
/** A comment the content policy refuses. Carries the verdict so the route can answer in its words. */
export class ReviewCommentRefused extends ReviewCommentError {
  override name = "ReviewCommentRefused";
  constructor(readonly safety: SafetyVerdict) { super(safety.refusal ?? "content policy refusal"); }
}

const length = (text: string) => Array.from(text).length;
const validFrame = (frame: unknown): frame is number => Number.isSafeInteger(frame) && (frame as number) >= 0 && (frame as number) < REVIEW_COMMENT_FRAME_LIMIT;

/** Narrow an untrusted request body to a comment's frame and text, or throw. Runs the safety gate. */
export function reviewCommentInput(body: unknown): { frame: number; text: string } {
  const value = (body ?? {}) as { frame?: unknown; text?: unknown };
  if (!validFrame(value.frame)) throw new ReviewCommentError("Pin the comment to a frame of the cut (0 to " + (REVIEW_COMMENT_FRAME_LIMIT - 1) + ").");
  if (typeof value.text !== "string" || !value.text.trim()) throw new ReviewCommentError("Write a comment.");
  const text = value.text.trim();
  if (length(text) > REVIEW_COMMENT_MAX_CHARS) throw new ReviewCommentError("Keep a comment to " + REVIEW_COMMENT_MAX_CHARS + " characters.");
  const verdict = checkPrompt(text);
  if (!verdict.allowed) throw new ReviewCommentRefused(verdict);
  return { frame: value.frame, text };
}

const ISO = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The snapshot rule for one link's comments and decision stage: bounded, well formed, only on a
 * link bound to a cut, and naming only a viewer the link itself counted. Throws on the first fault.
 */
export function validateReviewLinkRecords(link: { comments?: unknown; decisionStage?: unknown; decidedAt?: unknown; outputBinding?: unknown; viewers?: string[] }): void {
  if (link.decisionStage !== undefined && !isReviewStage(link.decisionStage)) throw new Error("invalid review decision stage");
  if (link.decidedAt !== undefined && !ISO(link.decidedAt)) throw new Error("invalid review decision time");
  if (link.comments === undefined) return;
  if (!Array.isArray(link.comments) || link.comments.length > REVIEW_COMMENTS_MAX || (link.comments.length && !link.outputBinding)) throw new Error("invalid review comments");
  const ids = new Set<string>();
  for (const comment of link.comments as ReviewComment[]) {
    if (typeof comment !== "object" || comment === null || Object.keys(comment).sort().join() !== "at,frame,id,resolvedAt,text,viewer"
      || typeof comment.id !== "string" || !ID.test(comment.id) || ids.has(comment.id) || !validFrame(comment.frame)
      || typeof comment.text !== "string" || !comment.text.trim() || length(comment.text) > REVIEW_COMMENT_MAX_CHARS || !ISO(comment.at)
      || (comment.resolvedAt !== null && !ISO(comment.resolvedAt))
      || (comment.viewer !== null && (typeof comment.viewer !== "string" || !(link.viewers ?? []).includes(comment.viewer)))) throw new Error("invalid review comment");
    ids.add(comment.id);
  }
}
