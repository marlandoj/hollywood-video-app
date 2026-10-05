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

/** HV-019-21: what each `@ImageN` reference token is counted as, beyond its own escaped characters. */
export const REFERENCE_TOKEN_ALLOWANCE = 16;
/**
 * HV-019-21. A prompt's size the way a limit is held to it: the strictest count the evidence allows.
 *
 * fal's Kling has refused prompts three times (Release 3's live run, G23):
 * 1. "String should have at most 2500 characters" (fal's own validator), at 2,651 characters.
 * 2. "prompt: size must be between 0 and 2500" at 2,495 characters, 2,503 UTF-8 bytes (HV-019-20 then
 *    counted UTF-8 bytes).
 * 3. The same message for the prompt fal echoed back as 2,491 characters, 2,491 UTF-16 units and 2,499
 *    UTF-8 bytes (`packages/queue/test/fixtures/fal-received-shot9.txt`). So whatever checks it counts more
 *    than every plain measure of the string fal received.
 *
 * "size must be between 0 and 2500" is the default message of a Java `@Size` check, which counts the
 * characters of the string it is given. That string must then be longer than the one fal echoed. Two ways
 * it can be, and neither is documented in this repository or by fal's schema:
 * - the prompt is counted as it is written in JSON: the line breaks and quote marks escaped (2 each), and
 *   with every non-ASCII character as `\uXXXX` (6). That is 2,536 for the echoed prompt.
 * - fal rewrites each `@ImageN` reference token (7 characters) into the model's own reference syntax
 *   before it forwards the prompt. Each of the four tokens is counted {@link REFERENCE_TOKEN_ALLOWANCE}
 *   characters more. That is far more than any bracketed image name, and costs 64 characters with four images.
 *
 * Both are counted. The echoed prompt is 2,600 by this measure. Every count of a string is at most its
 * size here, so a prompt within this size is within 2,500 however it is counted. The size is a sum over
 * characters and tokens, so a prompt's size is the sum of its parts' sizes.
 */
export function promptSize(text: string): number {
  let size = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    size += code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : code < 0x20 || code > 0x7e ? 6 : 1;
  }
  return size + REFERENCE_TOKEN_ALLOWANCE * (text.match(/@Image\d+/g)?.length ?? 0);
}
