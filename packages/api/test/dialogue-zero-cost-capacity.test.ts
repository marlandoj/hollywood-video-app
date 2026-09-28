/**
 * HV-027-12 — a dialogue replacement could not be made once another project had spent the month.
 *
 * HV-027-11 taught `CapacityController.decide` what a job will hold, and gave every zero-cost route
 * it found -- deliverables, sound mixes, editorial and assembly exports, motion graphics --
 * `requestedUsd:0`, so another project's paid renders no longer refused them. The dialogue
 * replacement route in `server.ts` was not in that map. Its job holds nothing either:
 *
 *     costCapUsd:0,budgetReservedUsd:0
 *
 * yet it asked capacity with the month's spend alone, so once the studio's paid renders reached the
 * budget, a creator could not dub or replace a line in a film they had already made, and was told
 * "We're at capacity right now. Your script is saved".
 *
 * It now says it holds nothing, like its siblings.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";

test("a $0 dialogue replacement is admitted after another project has spent the month",async()=>{
  const f=await dubStudio();
  try{
    const quote=await f.quote();expect(quote.error).toBeUndefined();
    // Another project's paid generation reaches the month's budget.
    f.ledger.record({provider:"fal",model:"x",prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:5000,at:new Date().toISOString(),projectId:crypto.randomUUID(),shotId:"s"});
    const r=await f.call(f.base+"/dialogue/"+f.film.id,"POST",f.requestBody(quote),f.owner.token);
    const body=await r.json() as Record<string,unknown>;
    expect({status:r.status,costUsd:body.costUsd,reason:body.reason}).toEqual({status:202,costUsd:0,reason:undefined});
  }finally{await f.close();}
},300_000);

test("the dialogue route's capacity ask says it holds nothing, and its job holds nothing",()=>{
  const source=readFileSync(new URL("../src/server.ts",import.meta.url),"utf8");
  const start=source.indexOf('stage:"dialogue-replacement" as const');
  expect(start).toBeGreaterThan(0);
  // The ask just before the dialogue job's admission, and the admission itself.
  const ask=source.slice(0,start).match(/capacity\.decide\(\{[^}]*\}/g)!.at(-1)!;
  expect(ask).toContain("requestedUsd:0");
  expect(source.slice(start,start+600)).toContain("costCapUsd:0,budgetReservedUsd:0");
});
