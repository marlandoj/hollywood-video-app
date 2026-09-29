/**
 * HV-027-13 — a finished film could not be exported once the month's spend was a cent past the budget.
 *
 * HV-027-11 made capacity let a job that holds nothing through whatever the month has spent, and
 * gave the deliverable, sound-mix, editorial, assembly and graphic routes `requestedUsd:0`. Each of
 * those routes then reserves its $0 with the ledger, and the ledger still ran the month's check:
 *
 *     if (this.spend(now) + held + remainingUsd > monthlyCapUsd + 1e-9) throw new BudgetError(...)
 *
 * With nothing to add, that is true exactly when the month is already past the cap -- which happens:
 * a provider's actual cost can exceed its hold, and the operator can lower the cap. HV-027-11's own
 * test landed the spend exactly on the budget and so never saw it. A cent past, exporting a film the
 * creator already had answered 429 "generation capacity is reserved", the outcome HV-027-11 was
 * written to prevent. The PostgreSQL ledger's `reserveWithin` ran the same check.
 *
 * A reservation that holds nothing is no longer refused by the month's spend; one that holds money
 * still is.
 */
import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CostLedger} from "../../operator/src/index";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";

const spend=(usd:number)=>({provider:"fal",model:"x",prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:usd,at:new Date().toISOString(),projectId:crypto.randomUUID(),shotId:"s"});

test("the ledger reserves nothing for a job that holds nothing when the month is past its cap, and still refuses one that holds money",()=>{
  const root=mkdtempSync(join(tmpdir(),"hv-zero-over-cap-"));
  try{
    const ledger=new CostLedger(join(root,"ledger.json"));
    ledger.record(spend(5000.01));
    expect(()=>ledger.reserve("free-job","delivery",0,5000)).not.toThrow();
    expect(()=>ledger.reserve("paid-job","final",0.5,5000)).toThrow("generation capacity is reserved");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("a deliverable of a finished film is admitted when the month's spend is a cent past the budget",async()=>{
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
    // Another project's paid generation lands one cent past the month's budget.
    f.ledger.record(spend(5000.01));
    const asked=await call(deliveries+"/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"reframe-1:1"});
    expect(asked.status).toBe(202);
  }finally{await f.close();}
},300_000);
