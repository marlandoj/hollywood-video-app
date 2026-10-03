/**
 * HV-022-14 — two paid admissions never asked the film's own spending cap.
 *
 * `GET /spend` answers `capUsd: filmCapUsd` and the studio shows that limit at every approval. It is
 * `assertFilmWithin` that enforces it, and picture, current-film and audio takes all call it before
 * they reserve. Two paid paths reached a reservation without it, by two different routes:
 *
 * - **Lip-sync.** `admitLipSync` had no `assertFilmWithin` at all, and no route could have supplied
 *   one: `server.ts` computes `filmCapUsd` and then builds
 *   `new LipSyncApi({root,artifacts,ledger,lipLedger,monthlyBudgetUsd,store,view})` — the context had
 *   no field for it. Each pass reserves the policy's held cost, and `lipsync.ts` allows 32 retained
 *   passes per lineage.
 * - **Living-script generation.** `admit`'s living-script branch *does* call `assertFilmWithin`, but
 *   `living-script-generation-api.ts` called `ledger.admit(projectId,submitted,monthlyBudgetUsd)`
 *   with no fourth argument, and `assertFilmWithin` returns immediately when the cap is `undefined`.
 *   A re-render off a paid provider pool reserves `costCapUsd`.
 *
 * Either way a creator whose film had spent its whole `HV_FILM_SPEND_CAP_USD` was refused every
 * other render and admitted for these, bounded only by the monthly program cap.
 *
 * This is a **wiring** defect, so these are wiring guards. The refusal itself is `assertFilmWithin`,
 * which the other admissions already rely on and which `film-budget.test.ts` covers; what was missing
 * was anyone asking for it. Two things now make that hard to repeat:
 *
 * - each API module's context **requires** `filmCapUsd`, so an unwired route is a type error rather
 *   than a silent omission — adding the field failed `bun run typecheck` in three test files that
 *   build these contexts by hand, which is the guarantee working;
 * - every admission that reserves money asks the cap, checked here over the source rather than
 *   argued about.
 */
import {expect,test} from "bun:test";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";

const API=new URL("../src/",import.meta.url).pathname;
const STORAGE=new URL("../../storage/src/",import.meta.url).pathname;
const read=(root:string,name:string)=>readFileSync(join(root,name),"utf8");

/**
 * The admission methods: the three places a job is enqueued against a reservation.
 *
 * Named rather than discovered, because the claim below is about all of them and a fourth appearing
 * unnamed is exactly what this is here to catch.
 */
const ADMISSIONS=[["ledger.ts","admit"],["audio-ledger.ts","admitAudio"],["lipsync-ledger.ts","admitLipSync"]] as const;

/** A method's body: from its signature to the start of the next one at the same indent. */
function body(source:string,name:string):string {
  const start=source.indexOf("  async "+name+"(");
  expect({name,found:start>=0}).toEqual({name,found:true});
  const rest=source.slice(start+3);
  const next=rest.search(/\n {2}(?:async |private |protected |[A-Za-z]\w*[(<])/);
  return next<0?rest:rest.slice(0,next);
}

test("every admission that reserves money asks the film's cap first",()=>{
  for (const [file,name] of ADMISSIONS) {
    const method=body(read(STORAGE,file),name);
    // Each reservation in the method, with the amount it reserves: the fifth argument.
    const reservations=[...method.matchAll(/reserveWithin\((?:[^,]*,){4}\s*([^,]+),/g)].map(match=>match[1]!.trim());
    expect({file,name,reservations:reservations.length>0}).toEqual({file,name,reservations:true});
    const paid=reservations.filter(amount=>amount!=="0");
    if (!paid.length) continue;
    // A method that reserves anything but a literal zero must have asked the cap on the way in.
    expect({file,name,paid,asks:method.includes("assertFilmWithin(")}).toEqual({file,name,paid,asks:true});
  }
  // And lip-sync in particular, because it is the one that did not: it asks before it reserves.
  const lip=body(read(STORAGE,"lipsync-ledger.ts"),"admitLipSync");
  expect(lip.indexOf("assertFilmWithin(")).toBeLessThan(lip.indexOf("reserveWithin("));
  expect(lip).toContain("this.assertFilmWithin(tx,projectId,policy.heldUsd,filmCapUsd)");
});

test("and every admission call in the API names the cap, so none can be wired without it",()=>{
  // The whole map, over every file rather than the one that was wrong. `admit`, `admitAudio` and
  // `admitLipSync` are the calls that enqueue against a reservation; `admitEditSource` adds a source
  // to the editorial library and reserves nothing, so it is named here as the one exception.
  const calls:string[]=[];
  for (const name of readdirSync(API).filter(file=>file.endsWith(".ts")).sort()) {
    const source=read(API,name);
    // The argument list, not the line: `admitAudio`'s spans four of them.
    for (const match of source.matchAll(/\.(admit\w*)\(/g)) {
      const from=match.index!+match[0].length;
      let depth=1,to=from;
      while (to<source.length&&depth>0) {const c=source[to]!; if (c==="(") depth+=1; else if (c===")") depth-=1; to+=1;}
      // HV-030-28: the cap is the film's limit or, for a feature, the feature's -- named either way.
      const args=source.slice(from,to);
      calls.push(name+":"+match[1]+":"+(args.includes("filmCapUsd")||args.includes("filmCap(")||args.includes("filmCapFor(")?"cap":"no-cap"));
    }
  }
  const reserving=calls.filter(call=>!call.includes(":admitEditSource:"));
  expect(reserving.length).toBeGreaterThan(5);
  expect(reserving.filter(call=>call.endsWith(":no-cap"))).toEqual([]);
  // The exception is named, not merely filtered out: it is still there, and it still reserves nothing.
  expect(calls.some(call=>call.includes(":admitEditSource:"))).toBe(true);
});

test("and each API module that admits requires the cap on its context",()=>{
  // A required field, not an optional one: an unwired route is a type error. This is the half of the
  // fix that no runtime test can show, so it is asserted where it is written.
  for (const name of ["lipsync-api.ts","edit-api.ts","graphic-api.ts","delivery-api.ts","sound-api.ts","living-script-generation-api.ts"]) {
    const source=read(API,name);
    const context=source.slice(source.indexOf("interface Context"),source.indexOf("}",source.indexOf("interface Context")));
    expect({name,declares:context.includes("filmCapUsd:number;")}).toEqual({name,declares:true});
    expect({name,optional:context.includes("filmCapUsd?")}).toEqual({name,optional:false});
    // HV-030-28: and the feature's own limit, required for the same reason.
    expect({name,declares:context.includes("featureCapUsd:number;")}).toEqual({name,declares:true});
  }
  // And the server hands each of them the one it computed, rather than computing a second one.
  const server=read(API,"server.ts");
  expect(server.split("filmLimits(process.env").length-1).toBe(1);
  for (const built of ["new LipSyncApi({","new SoundApi({","new GraphicApi({","new DeliveryApi({","new EditApi({"]) {
    const line=server.slice(server.indexOf(built)).split("\n")[0]!;
    expect({built,passes:line.includes("filmCapUsd")&&line.includes("featureCapUsd")}).toEqual({built,passes:true});
  }
});
