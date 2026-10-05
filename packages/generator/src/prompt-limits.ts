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

/**
 * HV-019-20. A prompt's size the way a limit is held to it: its UTF-8 bytes.
 *
 * fal's Kling refused one prompt over "2500 characters" (G23) and, after HV-019-19 fitted prompts to 2,500
 * UTF-16 units, refused another at 2,495 characters with "prompt: size must be between 0 and 2500" (G23's
 * resumed run). That prompt was 2,503 UTF-8 bytes: the live crew's cast direction quotes the script in
 * curly quotes, three bytes each. UTF-8 bytes are never fewer than code points or UTF-16 units, so a prompt
 * within this size is within the limit however the vendor counts.
 */
export function promptSize(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
