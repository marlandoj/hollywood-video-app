/**
 * HV-029-09 — retention removed the film and kept the review link.
 *
 * `sweepExpired` and `takedown` each emptied one map:
 *
 *     for (const [id, project] of this.projects) {
 *       if (new Date(project.deleteAfter).getTime() <= now) { this.projects.delete(id); removed.push(id); }
 *     }
 *
 * `reviewLinks` is the only other map this state keys by project, and nothing in the file ever
 * removed an entry from it — `grep reviewLinks packages/api/src/index.ts` gives `set`, `get`, and a
 * `clear` on reload. `snapshot()` then wrote every dead project's links back on the next `persist()`,
 * indefinitely.
 *
 * So after day thirty the project record and its artifacts were gone and `state/projects.json` still
 * held, for ever, each `ReviewLink` that film had ever minted: the review **token**, a bearer
 * capability valid for up to seven more days; `decisionNote`, up to 2,000 characters the reviewer
 * typed; the `outputBinding`; and the viewer hashes. The same was true of a takedown, where the
 * operator's intent is that the content is gone.
 *
 * `scripts/sweep-expired.ts` is the retention loop for this backend and its own comment says
 * "Retention is only real if both halves expire." The PostgreSQL path has always done it —
 * `PostgresRetention.purgeProject` runs `delete from hv_reviews where project_id = …` — which is
 * exactly why this went unseen: retention is tested there, and the default backend is this one.
 *
 * Nothing caught it because `api.test.ts`'s sweep case asserts the returned id array and nothing
 * else, and never mints a link; `review-views.test.ts` reads links out of the state file but never
 * sweeps or takes down.
 */
import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProjectService,type PersistedState} from "../src/index";

process.env.HV_TOKEN_SECRET ??= "retention-review-links-secret-at-least-thirty-two-characters";
const DAY=24*3600*1000;

/** A service on disk, so the claim is about what is *persisted*, not only about what is in memory. */
function studio() {
  const root=mkdtempSync(join(tmpdir(),"hv-retention-links-"));
  const path=join(root,"state","projects.json");
  return {path,root,service:()=>new ProjectService(path),
    stored:()=>JSON.parse(readFileSync(path,"utf8")) as PersistedState,
    close(){rmSync(root,{recursive:true,force:true});}};
}
const revoker={revokeProject:async()=>[]};

test("a swept project takes its review links with it, on disk as well as in memory",async()=>{
  const studio_=studio();
  try {
    const service=studio_.service(),t0=Date.now();
    const kept=service.createAnonymousProject(t0),swept=service.createAnonymousProject(t0);
    const doomed=service.createReviewLink(swept.token,"approve",t0)!;
    const survivor=service.createReviewLink(kept.token,"approve",t0)!;
    expect(studio_.stored().reviewLinks.map(link=>link.token).sort()).toEqual([doomed.token,survivor.token].sort());
    // Thirty days on, one film expires. Its link is a bearer token with seven days of life left.
    service.extendRetention(kept.projectId,10,"festival submission",t0);
    expect(service.sweepExpired(t0+31*DAY)).toEqual([swept.projectId]);
    const after=studio_.stored();
    expect(after.projects.map(project=>project.id)).toEqual([kept.projectId]);
    expect(after.reviewLinks.map(link=>link.token)).toEqual([survivor.token]);
    // And a fresh service reading that file agrees: the swept film's token opens nothing, while the
    // surviving one still does. (Asked inside the token's own seven days, which is the window in
    // which the swept one would have kept working.)
    const reopened=new ProjectService(studio_.path);
    expect(reopened.useReviewLink(doomed.token,t0+DAY)).toBeNull();
    expect(reopened.useReviewLink(survivor.token,t0+DAY)).not.toBeNull();
  } finally { studio_.close(); }
});

test("and so does a taken-down one, which is what the operator asked for",async()=>{
  const studio_=studio();
  try {
    const service=studio_.service(),t0=Date.now();
    const project=service.createAnonymousProject(t0);
    const link=service.createReviewLink(project.token,"approve",t0,undefined,3)!;
    // What the link is: a bearer capability, and the hashes of whoever was shown the cut.
    expect(service.useReviewLink(link.token,t0)).not.toBeNull();
    expect(studio_.stored().reviewLinks[0]).toMatchObject({token:link.token,projectId:project.projectId,permission:"approve"});
    expect(await service.takedown(project.projectId,"rights complaint",revoker,t0)).toBe(true);
    const after=studio_.stored();
    expect(after.reviewLinks).toEqual([]);
    expect(new ProjectService(studio_.path).useReviewLink(link.token,t0)).toBeNull();
    // The tombstone and the operator's log are the deliberate record and stay.
    expect(after.takenDown).toEqual([project.projectId]);
    expect(after.takedownLog.map(entry=>entry.reason)).toEqual(["rights complaint"]);
  } finally { studio_.close(); }
});

test("and nothing this state keys by project outlives the project",()=>{
  // The guard on the shape rather than on the two callers. `PersistedState` has four collections;
  // two are keyed by project and are removed together, and the other two are the record of the
  // removal. A fifth added later is a decision about which of those it is.
  const source=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
  const shape=source.slice(source.indexOf("export interface PersistedState"),source.indexOf("}",source.indexOf("export interface PersistedState")));
  expect(shape.match(/^\s+(\w+)[?:]/gm)!.map(line=>line.trim().replace(/[?:]$/,""))).toEqual(["version","projects","reviewLinks","takenDown","takedownLog"]);
  // One place removes a project, and both callers go through it.
  const forget=source.slice(source.indexOf("  private forget("),source.indexOf("  sweepExpired("));
  expect(forget).toContain("this.projects.delete(projectId)");
  expect(forget).toContain("this.reviewLinks.delete(token)");
  expect(source.split("this.forget(").length-1).toBe(2);
  expect(source).not.toContain("this.projects.delete(id);\n        removed.push(id);");
});
