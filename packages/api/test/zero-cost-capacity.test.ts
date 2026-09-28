/**
 * HV-027-11 — a finished film could not be exported once another project had spent the month.
 *
 * `CapacityController.decide` refuses every admission once the month's spend reaches the budget:
 *
 *     if (utilization >= 1) return {action:"reject",reason:"budget_exhausted",message:"We're at capacity right now. Your script is saved — please try again soon."};
 *
 * and the deliverable, sound-mix, editorial-export, assembly-export and motion-graphic routes all ask
 * it with the program's spend. None of those jobs holds a cent or calls a provider -- each admits
 * with `costCapUsd:0` and `budgetReservedUsd:0` -- yet one project's paid renders stopped every other
 * creator from reframing, mixing or exporting a film they had already made, with a message about a
 * saved script, while the delivery offers beside it still said "available":
 *
 *     zero-cost deliverable request: 429 {"error":"We're at capacity right now. …","reason":"budget_exhausted"}
 *
 * `decide` now takes what the job will hold; a job that holds nothing is not refused or throttled by
 * the month's spend. Concurrency and the shot limit still apply to it.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {CapacityController} from "../../queue/src/index";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";

test("a job that holds nothing is not refused or throttled by the month's spend; one that holds money still is",()=>{
  const capacity=new CapacityController(500),spent={tier:"free" as const,runningForProject:0,requestedShots:1,sceneCount:1,monthSpendUsd:500};
  expect(capacity.decide({...spent,requestedUsd:0})).toEqual({action:"run",reason:"capacity_available"});
  expect(capacity.decide({...spent,monthSpendUsd:450,requestedUsd:0})).toEqual({action:"run",reason:"capacity_available"});
  expect(capacity.decide({...spent,requestedUsd:0.5}).reason).toBe("budget_exhausted");
  // Unchanged for every caller that does not say what it holds.
  expect(capacity.decide(spent).reason).toBe("budget_exhausted");
  expect(capacity.decide({...spent,monthSpendUsd:450}).reason).toBe("budget_throttle");
  // Concurrency still applies to a free job.
  expect(capacity.decide({...spent,requestedUsd:0,runningForProject:1}).reason).toBe("project_concurrency");
});

test("every route that admits a zero-cost job says so to capacity",()=>{
  // The whole map: each of these routes admits only jobs with costCapUsd:0 and budgetReservedUsd:0,
  // and every capacity decision it asks for says it holds nothing.
  for(const file of ["delivery-api","sound-api","edit-api","graphic-api"]){
    const source=readFileSync(new URL("../src/"+file+".ts",import.meta.url),"utf8");
    const asks=source.match(/capacity\.decide\(\{[^}]*\}/g)??[];
    expect({file,asks:asks.length>0,all:asks.every(ask=>ask.includes("requestedUsd:0"))}).toEqual({file,asks:true,all:true});
    expect({file,paid:/budgetReservedUsd:(?!0[,}])/.test(source)}).toEqual({file,paid:false});
  }
});

test("a deliverable of a finished film is admitted after another project has spent the month",async()=>{
  const f=await dubStudio();
  try{
    const editorial=f.base+"/editorial",deliveries=f.base+"/deliveries";
    const call=(path:string,method="GET",body?:unknown)=>f.call(path,method,body,f.owner.token);
    const json=async(path:string,method="GET",body?:unknown)=>{const r=await call(path,method,body);const t=await r.text();if(!r.ok)throw new Error(path+" "+r.status+" "+t);return JSON.parse(t);};
    const source=(await inspectedSource(async s=>await(await call(editorial+s)).json() as never,"/sources/"+f.film.id)).sources[0];
    const id=crypto.randomUUID(),sequence=editorial+"/sequences/"+id;
    let state=await json(editorial+"/sequences","POST",{id,label:"cut",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:640,height:360,expectedVersion:0});
    state=await json(sequence,"PATCH",{expectedVersion:state.libraryVersion,expectedHistoryRevision:state.sequence.history.revision,
      change:{kind:"edit",label:"trim",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-state.timeline.frames,ripple:true}}});
    const quote=await json(sequence+"/renders");
    await json(sequence+"/renders","POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}});
    const film=(await f.worker())!;
    expect(film.status).toBe("done");
    // Another project's paid generation reaches the month's budget.
    f.ledger.record({provider:"fal",model:"x",prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:5000,at:new Date().toISOString(),projectId:crypto.randomUUID(),shotId:"s"});
    const asked=await call(deliveries+"/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"reframe-1:1"});
    expect(asked.status).toBe(202);
    // And a paid render of this project is still refused, as it must be.
    const paid=await call(f.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID()});
    expect(paid.status).toBe(429);
  }finally{await f.close();}
},300_000);
