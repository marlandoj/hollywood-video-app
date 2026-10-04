/**
 * HV-030-29: feature-length scripts for the Showrunner's tests. `featureScript()` is 34 scenes of one to
 * six beats each, with scene 21 at 30 beats (grouped into one sequence of 24 shots); `evenFeature(n, beats)`
 * is n scenes of the same number of beats, so each sequence's render holds the same.
 */
export function featureScript(sceneCount = 34): string {
  return Array.from({length: sceneCount}, (_, i) => {
    const n = i + 1, beats = i === 20 ? 30 : 1 + (i * 7) % 6;
    return `${i % 2 ? "EXT" : "INT"}. PLACE ${n} - ${i % 3 ? "DAY" : "NIGHT"}\n\n` + Array.from({length: beats}, (_, b) => `Mara crosses room ${n}, step ${b + 1}.`).join("\n\n")
      + (i % 4 === 0 ? `\n\nMARA\nWe keep going, ${n}.` : "");
  }).join("\n\n");
}

export function evenFeature(sceneCount: number, beats: number): string {
  return Array.from({length: sceneCount}, (_, i) => `${i % 2 ? "EXT" : "INT"}. YARD ${i + 1} - DAY\n\n`
    + Array.from({length: beats}, (_, b) => `Mara carries crate ${b + 1} across yard ${i + 1}.`).join("\n\n") + `\n\nMARA\nOne more, ${i + 1}.`).join("\n\n");
}
