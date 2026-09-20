/**
 * HV-025-07: checking an original is minutes of work on a long film, so `GET editorial/sources/:job`
 * answers 202 while the check runs and 200 with the receipt when it is done. Tests that inspect an
 * original wait the same way the studio and the editor do.
 */
export async function inspected(read: (suffix: string) => Promise<any>, suffix: string, polls = 1200, waitMs = 100): Promise<any> {
  for (let attempt = 0; attempt < polls; attempt++) {
    const answer = await read(suffix);
    if (answer?.sources) return answer;
    await Bun.sleep(waitMs);
  }
  throw new Error("The original was still being checked after " + polls + " polls: " + suffix);
}
