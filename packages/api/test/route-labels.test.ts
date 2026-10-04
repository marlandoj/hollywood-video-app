/**
 * HV-030-32 — the request log names a project route by its pattern.
 *
 * Every project route but six logged `route: "unmatched"`, so the operator reading the rehearsal's
 * log couldn't tell the score (101 s) from the dialogue (47.8 s) from the render request that timed
 * out behind them. A project path is now labelled with its words kept and every other segment written
 * `:id`, from a closed list of words that this file holds to the handlers' own.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROUTE_WORDS, ROUTE_TEMPLATES, isRouteLabel, routeLabel, routeTemplate } from "../../observability/src/index";
import { safeLogFields } from "../../observability/src/logs";

const ID = "4b9c1f0e-6a7d-4e2b-9c3a-1d2e3f4a5b6c", JOB = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f";

/** Criterion 3: every word a handler compares a path segment with is a word the label keeps. */
test("every word the API's handlers match a project path against is a labelled word", () => {
  const dir = join(import.meta.dir, "../src"), words = new Set<string>();
  for (const name of readdirSync(dir).filter(file => file.endsWith(".ts"))) {
    const source = readFileSync(join(dir, name), "utf8");
    for (const match of source.matchAll(/\b(?:parts|rest)\[\d+\]\s*===?\s*"([a-z][a-z0-9-]*)"/g)) words.add(match[1]!);
    for (const match of source.matchAll(/\[((?:"[a-z][a-z0-9-]*",?\s*)+)\]\.includes\((?:parts|rest)\[\d+\]/g))
      for (const word of match[1]!.matchAll(/"([a-z][a-z0-9-]*)"/g)) words.add(word[1]!);
  }
  // Words of the path before a project's own: not part of a project route's pattern.
  for (const word of ["api", "projects", "artifacts", "reviews"]) words.delete(word);
  expect(words.size).toBeGreaterThan(60);
  expect([...words].filter(word => !(PROJECT_ROUTE_WORDS as readonly string[]).includes(word))).toEqual([]);
});

/** Criterion 3: the finishing routes have their own labels, in the log and in the metrics. */
test("the finishing routes are labelled by pattern, and an id, a token or a name never is", () => {
  const project = "/api/projects/" + ID;
  expect([
    routeLabel(project + "/dialogue/" + JOB), routeLabel(project + "/sound-mixes/" + JOB), routeLabel(project + "/sound-mixes"),
    routeLabel(project + "/sounds"), routeLabel(project + "/ambience/" + JOB), routeLabel(project + "/jobs"),
    routeLabel(project + "/crew/read-through"), routeLabel(project + "/cast/maya/sheets"), routeLabel(project + "/editorial/sequences/" + JOB + "/preview/abc123/picture/0"),
  ]).toEqual([
    "/api/projects/:projectId/dialogue/:id", "/api/projects/:projectId/sound-mixes/:id", "/api/projects/:projectId/sound-mixes",
    "/api/projects/:projectId/sounds", "/api/projects/:projectId/ambience/:id", "/api/projects/:projectId/jobs",
    "/api/projects/:projectId/crew/read-through", "/api/projects/:projectId/cast/:id/sheets", "/api/projects/:projectId/editorial/sequences/:id/preview/:id/picture/:id",
  ]);
  // The five finishing routes are metric templates too; the rest stay out of the metrics' closed set.
  for (const path of ["/dialogue/" + JOB, "/sound-mixes", "/sound-mixes/" + JOB, "/sounds", "/ambience/" + JOB])
    expect(ROUTE_TEMPLATES as readonly string[]).toContain(routeTemplate(project + path));
  expect(routeTemplate(project + "/crew/read-through")).toBe("unmatched");
  // Paths outside a project, and paths deeper than any route, are still "unmatched".
  expect([routeLabel("/api/cast/performances.js"), routeLabel("/attacker/secret"), routeLabel(project + "/jobs".repeat(14))]).toEqual(["unmatched", "unmatched", "unmatched"]);
  // A log keeps a pattern and drops anything else in its place.
  expect(safeLogFields({route: "/api/projects/:projectId/dialogue/:id"}).fields).toEqual({route: "/api/projects/:projectId/dialogue/:id"});
  for (const route of [project + "/dialogue/" + JOB, "/api/projects/:projectId/maya", "/api/projects/:projectId/dialogue/" + JOB, "/api/projects/" + ID + "/jobs"])
    expect([route, isRouteLabel(route), safeLogFields({route}).dropped]).toEqual([route, false, 1]);
});
