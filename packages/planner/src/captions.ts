export interface DialogueBlock { character: string; lines: string[] }
export interface CaptionCue { text: string; startSec: number; endSec: number }

/** Two readable lines per cue, with sequential timing across the shot. */
export function captionCues(dialogue: DialogueBlock[], durationSec: number): CaptionCue[] {
  const chunks: string[] = [];
  for (const d of dialogue) {
    const words = `${d.character}: ${d.lines.join(" ")}`.trim().split(/\s+/u);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (line && line.length + word.length + 1 > 42) { lines.push(line); line = ""; }
      // An unbroken input may itself be wider than the frame.
      for (const part of word.match(/.{1,42}/gu) ?? []) {
        if (line && line.length + part.length + 1 > 42) { lines.push(line); line = ""; }
        line += (line ? " " : "") + part;
      }
    }
    if (line) lines.push(line);
    for (let i = 0; i < lines.length; i += 2) chunks.push(lines.slice(i, i + 2).join("\n"));
  }
  const total = chunks.reduce((sum, text) => sum + text.length, 0);
  let position = 0;
  return chunks.map(text => {
    const startSec = durationSec * position / total;
    position += text.length;
    return { text, startSec, endSec: durationSec * position / total };
  });
}
