/**
 * HV-019-19. A prompt longer than its provider takes.
 *
 * The planner fits every film shot's prompt to its pool's declared limit before admission
 * (packages/planner/src/prompt-fit.ts), so an adapter should never see one. When one does (a path the
 * planner doesn't fit), the adapter refuses it locally, before any request, and the router does not try
 * it elsewhere: nothing is paid to find out.
 */
export class PromptLengthError extends Error {
  override name = "PromptLengthError";
}
