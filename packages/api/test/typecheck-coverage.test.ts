import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join,relative,resolve,sep} from "node:path";
import {Glob} from "bun";

const REPO=resolve(import.meta.dir,"../../..");

/**
 * HV-026-05: every TypeScript file in this repository is typechecked.
 *
 * `tsconfig.json` included `packages/**` and `scripts/**` and nothing else, so the six suites in the
 * root `test/` directory — the ones that read the release evidence and the staging records — were
 * never seen by `tsc`. `bun run lint` covers them, but oxlint does not know types, so a change to a
 * shared type could break them with no signal until the suite ran.
 *
 * It did. HV-026-04 made a quality check's sound measurement nullable, updated every reader `tsc`
 * could see, and left `report.sound.meanVolumeDb` standing in `test/picture-qc-check.test.ts`. Two
 * errors, hidden by a glob.
 *
 * Asserted by walking the repository rather than by naming the directories, so a new one is covered
 * the day it appears.
 */
test("every TypeScript file in the repository is inside the typechecker's own include list",()=>{
  const config=JSON.parse(readFileSync(join(REPO,"tsconfig.json"),"utf8").replace(/^\s*\/\/.*$/gm,"")) as {include:string[]};
  expect(Array.isArray(config.include)).toBe(true);
  const globs=config.include.map(pattern=>new Glob(pattern));
  const found=[...new Glob("**/*.ts").scanSync({cwd:REPO,onlyFiles:true,dot:false})]
    .map(path=>path.split(sep).join("/"))
    .filter(path=>!path.startsWith("node_modules/")&&!path.includes("/node_modules/"));
  // The walk has to find the files this test exists for, or it is asserting over an empty list.
  expect(found).toContain("test/picture-qc-check.test.ts");
  expect(found.length).toBeGreaterThan(500);
  const missed=found.filter(path=>!globs.some(glob=>glob.match(path)));
  expect(missed).toEqual([]);
  // And the include must not name a directory that no longer exists, which would read as coverage.
  for(const pattern of config.include)
    expect({pattern,covered:found.some(path=>new Glob(pattern).match(path))}).toEqual({pattern,covered:true});
  expect(relative(REPO,join(REPO,"tsconfig.json"))).toBe("tsconfig.json");
});
