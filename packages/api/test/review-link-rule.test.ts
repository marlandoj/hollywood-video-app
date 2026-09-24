/**
 * HV-029-10 — which rule a review link follows was decided by whoever opened it first.
 *
 * HV-029-05 gave the owner a choice at the mint. A link minted with `maxViews` counts **viewers**:
 * a reload is not a second viewer, and the viewer who watched on the last view may still decide. A
 * link minted without one keeps FR-047's original rule — three serves, anonymous. The mint is where
 * that is decided:
 *
 *     if(maxViews!==undefined){link.maxViews=reviewViewLimit(maxViews);link.viewers=[];}
 *
 * and three readers branch on whether `viewers` exists: `peekReviewLink`, `submitReviewDecision`,
 * and the decision route. But the *counter* created it regardless:
 *
 *     if (viewer) link.viewers = [...(link.viewers ?? []), viewer.hash];
 *
 * The review page sends `x-hv-review-viewer` on every open, so the first browser to open an
 * old-rule link turned it into a viewer-identity link for everyone after it. A second reviewer whose
 * client sends no viewer id — curl, a link scanner, an embedded webview — was then shown the cut and
 * **refused a decision on it**, with "Open the cut in this review link on this device before deciding
 * on it." The identical request would have been accepted had the first reviewer never opened the
 * link.
 *
 * `submitReviewDecision`'s own comment says "A link without viewer ids keeps the old rule". It did
 * not: it kept the old rule until a browser touched it.
 *
 * Nothing caught it because `review-views.test.ts`'s old-rule case opens all three views with no
 * header at all, which is precisely the case where the defect cannot fire.
 */
import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProjectService} from "../src/index";
import {reviewViewer} from "../src/review-views";
import {REVIEW_MAX_VIEWS} from "../src/tokens";

process.env.HV_TOKEN_SECRET ??= "review-link-rule-secret-at-least-thirty-two-characters";
const root=mkdtempSync(join(tmpdir(),"hv-review-rule-"));
afterAll(()=>rmSync(root,{recursive:true,force:true}));

const viewer=(id:string)=>reviewViewer(id.padEnd(22,"x"))!;
/** A project and a link, minted with or without the owner's own view limit. */
function link(maxViews?:number) {
  const service=new ProjectService(join(root,crypto.randomUUID()+".json"));
  const now=Date.now();
  const project=service.createAnonymousProject(now);
  const minted=service.createReviewLink(project.token,"approve",now,undefined,maxViews)!;
  return {service,now,project,token:minted.token,minted,
    stored:()=>JSON.parse(JSON.stringify(service.snapshot())).reviewLinks[0] as {viewers?:string[];views:number}};
}

test("a link minted without a view limit keeps the old rule, whoever opens it",()=>{
  const l=link();
  expect(l.minted.viewers).toBeUndefined();
  // A browser opens it, sending the viewer id the review page always sends.
  expect(l.service.recordReviewView(l.token,viewer("browser-a"),l.now)).toBe(REVIEW_MAX_VIEWS-1);
  // Before: this had just become a viewer-identity link.
  expect(l.stored().viewers).toBeUndefined();
  // A second reviewer whose client sends no viewer id is shown the cut...
  expect(l.service.recordReviewView(l.token,null,l.now)).toBe(REVIEW_MAX_VIEWS-2);
  // ...and may decide on it, which is the old rule and what the link was minted for. `peekReviewLink`
  // is the check the decision route runs beside `submitReviewDecision`, and the one both of them
  // make about the viewer; it answered null here, and the route turns that into
  // "Open the cut in this review link on this device before deciding on it."
  expect(l.service.peekReviewLink(l.token,l.now,null)).not.toBeNull();
});

test("and a link minted with one counts viewers, exactly as before",()=>{
  const l=link(3);
  expect(l.minted.viewers).toEqual([]);
  const a=viewer("browser-a");
  expect(l.service.recordReviewView(l.token,a,l.now)).toBe(2);
  expect(l.stored().viewers).toHaveLength(1);
  // A reload is not a second viewer.
  expect(l.service.recordReviewView(l.token,a,l.now)).toBe(2);
  expect({views:l.stored().views,viewers:l.stored().viewers!.length}).toEqual({views:1,viewers:1});
  // A second and third viewer spend the rest, and the last of them may still decide.
  expect(l.service.recordReviewView(l.token,viewer("browser-b"),l.now)).toBe(1);
  const c=viewer("browser-c");
  expect(l.service.recordReviewView(l.token,c,l.now)).toBe(0);
  expect(l.service.peekReviewLink(l.token,l.now,c)).not.toBeNull();
  // And someone who was never shown the cut cannot decide on it.
  expect(l.service.peekReviewLink(l.token,l.now,viewer("browser-d"))).toBeNull();
});

test("and the rule a link follows is a property of the mint, not of its traffic",()=>{
  // The claim in one place. Whatever is done to a link, the field the three readers branch on is
  // the one the mint decided: it exists on a link minted with a limit and not on one minted without.
  for (const maxViews of [undefined,1,25]) {
    const l=link(maxViews);
    for (const id of ["browser-a","browser-b"]) l.service.recordReviewView(l.token,viewer(id),l.now);
    l.service.recordReviewView(l.token,null,l.now);
    expect({maxViews,countsViewers:l.stored().viewers!==undefined}).toEqual({maxViews,countsViewers:maxViews!==undefined});
  }
});
