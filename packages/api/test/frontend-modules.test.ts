/**
 * HV-039-02 — every module the browser will ask for is served.
 *
 * The API serves the creator UI's modules two different ways: most are returned
 * as the raw file, with their `import` statements intact, and ten are returned
 * bundled by `previewBrowserModule`, with their imports inlined. Which module
 * goes which way is decided by six hand-written path arrays in `server.ts` --
 * one of them a thousand lines below the other five -- and nothing held those
 * arrays equal to what the modules actually import. Add
 * a shared module -- as this increment does, `busy.js` -- to a raw-served panel
 * and the browser requests a path no array names, gets a 404, and the whole
 * panel fails to load. Every existing check in this package names one such path
 * by hand, so none of them would notice.
 *
 * This walks the graph as the browser walks it: the entries come out of the
 * served HTML, and every further edge comes out of the bytes the server
 * returned rather than out of the source on disk -- which is the only way to be
 * right about both mechanisms at once, because a bundled module's response has
 * no imports left to follow and its source does.
 */
import {afterAll, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";

const SRC = join(import.meta.dir, "..", "..", "frontend", "src");
const fixtures: {root: string; server: ReturnType<typeof createApiServer>}[] = [];
afterAll(async () => {
  for (const f of fixtures) {await f.server.stop(true); rmSync(f.root, {recursive: true, force: true});}
});

function fixture() {
  process.env.HV_TOKEN_SECRET = "frontend-modules-fixture-secret-of-at-least-thirty-two";
  const root = mkdtempSync(join(tmpdir(), "hv-frontend-modules-")),
    server = createApiServer({port: 0, hostname: "127.0.0.1", statePath: join(root, "projects.json"),
      queuePath: join(root, "jobs.json"), costLedgerPath: join(root, "costs.json"),
      artifactRoot: join(root, "media"), rateLimit: {api: {limit: 100000, windowMs: 60000}}});
  fixtures.push({root, server});
  return server;
}

/**
 * Relative module specifiers in a served response.
 *
 * Parsed, not matched. An earlier draft of this used three regular expressions
 * and they were blind to anything they had not been written for:
 * `import{x}from"./y.js"` without spaces, an import spread over lines, a bare
 * `export{x}from"./y.js"` — each of those made an edge invisible, so a module
 * could lose its route and this walk would report nothing wrong. The
 * transpiler is in the runtime already and is not fooled by a string that
 * merely looks like an import.
 */
const transpiler = new Bun.Transpiler({loader: "js"});
function relativeImports(body: string): string[] {
  return [...new Set(transpiler.scanImports(body)
    .filter(found => found.path.startsWith("./"))
    .map(found => found.path.slice(2)))].sort();
}

/** The `/api/...` module and stylesheet paths a served HTML page asks for. */
const pageEntries = (file: string): string[] =>
  [...new Set([...readFileSync(join(SRC, file), "utf8").matchAll(/\/api\/[a-z0-9./-]*\.(?:js|css)/g)].map(m => m[0]))].sort();

test("every module the served pages reach is served, at the prefix the browser will use", async () => {
  const server = fixture();
  const get = (path: string) => fetch(new URL(path, server.url));

  const entries = [...new Set([...pageEntries("index.html"), ...pageEntries("operator.html")])].sort();
  // Pinned so that a page losing an entry, or the extraction quietly matching
  // nothing, is a failure here rather than a silently smaller walk below.
  expect(entries).toEqual([
    "/api/audio-studio.js", "/api/cast/app.js", "/api/cast/library.js", "/api/color-grade.js",
    "/api/direction/app.js", "/api/direction/dialogue-replacement.js", "/api/direction/performances.js",
    "/api/editorial.js", "/api/graphic-studio.js", "/api/lipsync.js", "/api/living-script.js",
    "/api/operator/app.css", "/api/operator/app.js", "/api/review-notes.js", "/api/sound-studio.js", "/api/studio/app.js",
  ]);

  const seen = new Map<string, {status: number; type: string; from: string}>();
  const queue = entries.map(path => ({path, from: "a served page"}));
  while (queue.length) {
    const {path, from} = queue.shift()!;
    if (seen.has(path)) continue;
    const response = await get(path);
    const type = response.headers.get("content-type") ?? "";
    seen.set(path, {status: response.status, type, from});
    if (response.status !== 200 || !type.includes("javascript")) {await response.text(); continue;}
    const body = await response.text();
    const prefix = path.slice(0, path.lastIndexOf("/") + 1);
    for (const specifier of relativeImports(body)) queue.push({path: prefix + specifier, from: path});
  }

  const broken = [...seen].filter(([, result]) => result.status !== 200)
    .map(([path, result]) => `${path} -> ${result.status} (imported by ${result.from})`);
  expect(broken).toEqual([]);

  // The whole reached set, pinned. An empty `broken` only means something if
  // the walk actually went everywhere, and a floor with slack in it -- an
  // earlier draft said `>= 25` against a real 42 -- lets seventeen edges go
  // missing before anything notices. Pinned exactly, any change to what the
  // browser fetches has to be written down here on purpose. Twenty-eight of
  // these are reached only by following an import and are named by neither
  // page; the three `busy.js` paths are what this increment added.
  // HV-021-07 added `/api/direction/continuity.js`, imported by the desk.
  expect([...seen.keys()].sort()).toEqual([
    "/api/audio-phrases.js", "/api/audio-studio.js", "/api/busy.js", "/api/cast/app.js",
    "/api/cast/audio-focus.js", "/api/cast/busy.js", "/api/cast/library.js",
    "/api/cast/performances.js", "/api/cast/picture-performance.js", "/api/cast/sheets.js",
    "/api/cast/speech-player.js", "/api/color-grade.js", "/api/direction/app.js", "/api/direction/audio-focus.js",
    "/api/direction/busy.js", "/api/direction/camera-path.js", "/api/direction/continuity.js",
    "/api/direction/coverage.js",
    "/api/direction/dialogue-replacement.js", "/api/direction/frame-anchors.js",
    "/api/direction/narration-editor.js", "/api/direction/performances.js",
    "/api/direction/picture-performance.js", "/api/direction/scene-cuts.js",
    "/api/direction/speech-player.js", "/api/direction/subject-motion.js",
    "/api/direction/take-player.js", "/api/direction/takes.js", "/api/direction/viewfinder.js",
    "/api/edit-assemblies.js", "/api/edit-assembly-preview.js", "/api/edit-script.js",
    "/api/editorial.js", "/api/graphic-studio.js", "/api/lipsync.js", "/api/living-script.js",
    "/api/mask-editor.js", "/api/mask-source.js", "/api/operator/app.css",
    "/api/operator/app.js", "/api/picture-performance.js", "/api/preview-comparison.js",
    "/api/preview-controller.js", "/api/review-notes.js", "/api/sound-studio.js", "/api/studio/app.js", "/api/studio/score.js",
    "/api/studio/titles.js",
  ]);
  for (const [path, result] of seen) {
    expect({path, type: result.type.split(";")[0]}).toEqual({path, type: path.endsWith(".css") ? "text/css" : "text/javascript"});
  }
});

test("the walk follows a raw response's imports and a bundled response's absence of them", async () => {
  const server = fixture();
  const body = async (path: string) => {
    const response = await fetch(new URL(path, server.url));
    expect(response.status).toBe(200);
    return response.text();
  };
  // editorial.js is served raw: its nine imports are in the response, so the
  // walk above genuinely had edges to follow.
  const editorial = relativeImports(await body("/api/editorial.js"));
  expect(editorial).toEqual([
    "busy.js", "edit-assemblies.js", "edit-assembly-preview.js", "edit-script.js",
    "living-script.js", "mask-editor.js", "mask-source.js", "preview-comparison.js", "preview-controller.js",
  ]);
  // living-script.js is served bundled: it imports three modules on disk and
  // none in the response, so requiring its *source* imports to be served
  // would demand routes the browser never asks for.
  expect(relativeImports(readFileSync(join(SRC, "living-script.js"), "utf8"))).toEqual(["busy.js", "living-script-recut.js", "living-script-state.js"]);
  expect(relativeImports(await body("/api/living-script.js"))).toEqual([]);
});

test("a module that does not exist is refused at every prefix, so 200 means something", async () => {
  const server = fixture();
  for (const path of ["/api/not-a-real-module.js", "/api/cast/not-a-real-module.js", "/api/direction/not-a-real-module.js",
    "/api/busy.ts", "/api/index.html", "/api/operator.js"]) {
    expect({path, status: (await fetch(new URL(path, server.url))).status}).toEqual({path, status: 404});
  }
});

/**
 * HV-030-06 — the shot editor's duration ceiling comes from the API, not from a constant.
 *
 * The editor is a DOM module with a dozen collaborators, so this is a source check rather than a
 * driven one: what it pins is that `direction.js` has exactly one duration ceiling, that the
 * ceiling reads the API's `durationLimitSec`, and that the ceiling is applied in all three places
 * it has to be — the field's initial max, the max after a view loads, and the save path. A future
 * edit that writes `30` back into any of them fails here.
 */
test("the shot editor takes its duration ceiling from the served view", () => {
  const source = readFileSync(join(SRC, "direction.js"), "utf8");
  const limit = source.match(/const durationLimit=\(\)=>[^\n]*durationLimitSec[^\n]*/);
  expect(limit).not.toBeNull();
  // One definition, and it is the only place a bare 30-second ceiling may appear.
  expect(source.split("durationLimit=()=>").length - 1).toBe(1);
  expect(/durationSeconds"[^\n]*"number",\[1,\s*30\s*,/.test(source)).toBe(false);
  // Applied where it matters: the field as built, the field once a view arrives, and the save.
  expect(/durationSeconds"[^\n]*"number",\[1,durationLimit\(\),/.test(source)).toBe(true);
  expect(source).toContain("durationInput.max=durationLimit();");
  expect(/Number\(input\.value\)>durationLimit\(\)/.test(source)).toBe(true);
  // And the creator is told the number rather than left to discover it at admission.
  expect(source).toContain('providers render at most "+durationLimit()+" seconds a shot');
});
