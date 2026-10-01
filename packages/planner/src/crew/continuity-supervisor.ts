import type { ContinuityReport, ContinuityScene } from "../continuity";
import type { CrewNote } from "./production-plan";

/**
 * The Continuity Supervisor's notes (HV-021-09): the continuity report, said in the crew's words.
 *
 * The report is the one the Director's desk serves (`continuityReport`, HV-021-01); this file reads
 * it and detects nothing of its own. One sentence per kind of finding, naming the scenes it is in,
 * so a film with drift in twenty shots still reads as a few lines. Deterministic, $0 and model-free:
 * the same report gives the same notes, and a kind the report does not find is never mentioned.
 *
 * A report with nothing to compare says so, rather than reading as a pass: a film that declares
 * nothing has no warnings and no comparisons (docs/CONTINUITY.md).
 */
export const SUPERVISOR_NOTE_LIMIT = 6;
/** Scenes or names a single note lists before it says how many more there are. */
export const SUPERVISOR_LIST_LIMIT = 6;
const ORDER = ["time-contradicts-heading", "look-changed", "source-stale", "wardrobe-unstated", "identity-unanchored", "handoff-absent"];

function list(items: string[]): string {
  const shown = items.slice(0, SUPERVISOR_LIST_LIMIT), more = items.length - shown.length;
  if (more) return shown.join(", ") + " and " + more + " more";
  return shown.length < 2 ? shown.join("") : shown.slice(0, -1).join(", ") + " and " + shown.at(-1);
}
const scenes = (found: ContinuityScene[]) => (found.length === 1 ? "scene " : "scenes ") + list(found.map(scene => String(scene.sceneNumber)));
const plural = (count: number, word: string) => count + " " + word + (count === 1 ? "" : "s");
const shotCount = (found: ContinuityScene[], code: string) =>
  new Set(found.flatMap(scene => scene.findings.filter(finding => finding.code === code).flatMap(finding => finding.shotIds))).size;
/** The cast the report itself names for these scenes, once each, in the order it first appears. */
const names = (found: ContinuityScene[], keep: (character: ContinuityScene["characters"][number]) => boolean) =>
  [...new Set(found.flatMap(scene => scene.characters.filter(keep).map(character => character.name)))];

function sentence(code: string, found: ContinuityScene[]): string {
  const where = scenes(found);
  switch (code) {
  case "time-contradicts-heading":
    return "Found shots directed against their own heading's time of day in " + where + ". Either the heading or the direction is wrong and only you can say which, so it is left for you.";
  case "look-changed": {
    const count = found.reduce((total, scene) => total + scene.findings.filter(finding => finding.code === code).length, 0);
    return "Found " + plural(count, "look setting") + " declared more than one way within a scene in " + where + ". Under Continuity at the Director's desk, \"Review continuity repair\" offers to hold each scene to the first shot that states it.";
  }
  case "source-stale": {
    const count = shotCount(found, code);
    return "Did not compare " + plural(count, "shot") + " in " + where + ": " + (count === 1 ? "its" : "their") + " saved direction belongs to a version of the shot that has since changed. Review " + (count === 1 ? "it" : "them") + " at the Director's desk.";
  }
  case "wardrobe-unstated": {
    const who = names(found, character => character.wardrobeScope === "unstated");
    return "No wardrobe is stated for " + list(who) + " in " + where + ", so nothing holds what they wear from shot to shot.";
  }
  case "identity-unanchored": {
    const who = names(found, character => character.references === 0);
    return "No reference image is kept yet for " + list(who) + " (" + where + "), so how they look from shot to shot rests on the written description alone.";
  }
  case "handoff-absent": {
    const count = shotCount(found, code);
    return plural(count, "shot") + " in " + where + (count === 1 ? " does" : " do") + " not start from the frame before " + (count === 1 ? "it, so it is" : "them, so each is") + " generated on its own.";
  }
  default:
    // A kind this file does not know yet is said in the report's own words, never left out.
    return "In " + where + ": " + found[0]!.findings.find(finding => finding.code === code)!.message;
  }
}

/** How many checks the report could actually make. Zero means the Supervisor had nothing to compare (and the studio does not credit it). */
export function continuityComparisons(report: ContinuityReport): number {
  return report.totals.lookComparisons + report.totals.wardrobeComparisons + report.totals.handoffComparisons;
}

export function continuitySupervisorNotes(report: ContinuityReport): CrewNote[] {
  const note = (change: string): CrewNote => ({persona: "continuity", change, source: "continuity-report"});
  const codes = [...new Set(report.scenes.flatMap(scene => scene.findings.map(finding => finding.code)))]
    .sort((a, b) => (ORDER.includes(a) ? ORDER.indexOf(a) : ORDER.length) - (ORDER.includes(b) ? ORDER.indexOf(b) : ORDER.length));
  if (!codes.length) {
    const compared = continuityComparisons(report);
    if (!report.scenes.length) return [note("Nothing to compare yet: the film has no planned shots.")];
    if (!compared) return [note("Nothing to compare yet: no scene states its look, a wardrobe or a frame handoff more than once, so there is no continuity to check.")];
    return [note("Compared " + plural(compared, "declaration") + " across " + plural(report.scenes.length, "scene") + " and found nothing that contradicts. This reads what the film states, not its pictures.")];
  }
  const notes = codes.map(code => note(sentence(code, report.scenes.filter(scene => scene.findings.some(finding => finding.code === code)))));
  if (notes.length <= SUPERVISOR_NOTE_LIMIT) return notes;
  const more = notes.length - (SUPERVISOR_NOTE_LIMIT - 1);
  return [...notes.slice(0, SUPERVISOR_NOTE_LIMIT - 1), note("And " + plural(more, "more kind") + " of finding, listed under Continuity at the Director's desk.")];
}
