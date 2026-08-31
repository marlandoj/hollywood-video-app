export interface Scene {
  index: number;
  heading: string;
  action: string[];
  dialogue: { character: string; lines: string[] }[];
  transitions: string[];
}

export interface ParseWarning { code: string; message: string; line?: number }

export interface ParseResult {
  scenes: Scene[];
  pageEstimate: number;
  warnings: ParseWarning[];
  rejected: boolean;
  rejectionReason?: string;
  unparseable: { line: number; text: string }[];
}

const LINES_PER_PAGE = 55;
const MAX_PAGES = 30;
const SCENE_WARNING_THRESHOLD = 20;

const SCENE_HEADING = /^(INT|EXT|EST|INT\.\/EXT|I\/E)[.\s]/i;
const FORCED_HEADING = /^\./;
const TRANSITION = /(TO:|FADE OUT\.?|FADE IN:?|CUT TO BLACK\.?)$/;
const CHARACTER = /^[A-Z][A-Z0-9 '().-]*$/;
const PROTECTED_SPAN = /\[\[[^\]]*\]\]|\/\*[\s\S]*?\*\//;

export function parseFountain(text: string): ParseResult {
  const rawLines = text.split(/\r?\n/);
  const warnings: ParseWarning[] = [];
  const unparseable: { line: number; text: string }[] = [];
  const scenes: Scene[] = [];
  let current: Scene | null = null;
  let pendingCharacter: string | null = null;

  const protectedRanges = new Set<number>();
  let inBlockComment = false;
  rawLines.forEach((l, i) => {
    if (inBlockComment) { protectedRanges.add(i); if (l.includes("*/")) inBlockComment = false; return; }
    if (l.includes("/*") && !l.includes("*/")) { inBlockComment = true; protectedRanges.add(i); }
    else if (PROTECTED_SPAN.test(l)) protectedRanges.add(i);
  });

  rawLines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const t = line.trim();
    if (protectedRanges.has(i)) return;
    if (t === "") { pendingCharacter = null; return; }
    if (SCENE_HEADING.test(t) || (FORCED_HEADING.test(t) && !t.startsWith(".."))) {
      current = { index: scenes.length, heading: t.replace(/^\./, ""), action: [], dialogue: [], transitions: [] };
      scenes.push(current);
      pendingCharacter = null;
      return;
    }
    if (TRANSITION.test(t) && t === t.toUpperCase()) {
      if (current) current.transitions.push(t);
      return;
    }
    if (!current) {
      if (/^(Title|Credit|Author|Source|Draft date|Contact):/i.test(t)) return;
      unparseable.push({ line: i + 1, text: t });
      return;
    }
    if (pendingCharacter) {
      const d = current.dialogue[current.dialogue.length - 1];
      d.lines.push(t);
      return;
    }
    if (CHARACTER.test(t) && t.length <= 40 && !SCENE_HEADING.test(t)) {
      pendingCharacter = t;
      current.dialogue.push({ character: t.replace(/\s*\(.*\)$/, ""), lines: [] });
      return;
    }
    if (/^[<>~_*]{3,}/.test(t)) {
      unparseable.push({ line: i + 1, text: t });
      warnings.push({ code: "UNPARSEABLE", message: `Unparseable construct at line ${i + 1}`, line: i + 1 });
      return;
    }
    current.action.push(t);
  });

  const nonEmpty = rawLines.filter((l) => l.trim() !== "").length;
  const pageEstimate = Math.ceil(nonEmpty / LINES_PER_PAGE) || 0;
  let rejected = false;
  let rejectionReason: string | undefined;
  if (pageEstimate > MAX_PAGES) {
    rejected = true;
    rejectionReason = `Script is approximately ${pageEstimate} pages; the limit is ${MAX_PAGES} pages.`;
  }
  if (scenes.length > SCENE_WARNING_THRESHOLD) {
    warnings.push({ code: "SCENE_COUNT", message: `Script has ${scenes.length} scenes; more than ${SCENE_WARNING_THRESHOLD} may exceed capacity tiers.` });
  }
  for (const u of unparseable) {
    if (!warnings.some((w) => w.line === u.line)) warnings.push({ code: "UNPARSEABLE", message: `Unparseable construct at line ${u.line}`, line: u.line });
  }
  return { scenes, pageEstimate, warnings, rejected, rejectionReason, unparseable };
}

export interface ScriptVersion { version: number; text: string; createdAt: string; parentVersion: number | null }

export class VersionStore {
  private versions: ScriptVersion[] = [];
  commit(text: string): ScriptVersion {
    const v: ScriptVersion = {
      version: this.versions.length + 1,
      text,
      createdAt: new Date().toISOString(),
      parentVersion: this.versions.length === 0 ? null : this.versions.length,
    };
    this.versions.push(v);
    return v;
  }
  get(version: number): ScriptVersion | undefined { return this.versions.find((v) => v.version === version); }
  latest(): ScriptVersion | undefined { return this.versions[this.versions.length - 1]; }
  history(): ScriptVersion[] { return [...this.versions]; }
}
