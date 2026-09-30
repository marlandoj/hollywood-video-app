/**
 * HV-026-07 — a creator grades a finished cut, and the grade is checked before it is offered.
 *
 * A grade is a deliverable: asked for on the cut's delivery route with a colour decision, admitted at
 * zero cost, rendered by the delivery worker from the cut's own master, sealed with its picture quality
 * check and its own grade check. The cut is never touched. A grade whose check finds it clipped what
 * the cut did not is sealed and listed with the reason — and never served.
 */
import {expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected} from "../../../test/fixtures/editorial-inspection";
import {COLOR_GRADE_NEUTRAL,COLOR_LOOK_IDS,type ColorGradeDecision} from "../../planner/src/color-grade";
import {validateDeliveryOutput} from "../../planner/src/delivery-jobs";
import {mintArtifactToken} from "../src/tokens";

/** A dub-studio project with a finished one-second picture edit of its film, and the calls to reach it. */
async function edited(){
  const f=await dubStudio();
  const editorial=f.base+"/editorial",deliveries=f.base+"/deliveries";
  const call=(path:string,method="GET",body?:unknown)=>f.call(path,method,body,f.owner.token);
  const json=async(path:string,method="GET",body?:unknown)=>{const r=await call(path,method,body);const t=await r.text();if(!r.ok)throw new Error(path+" "+r.status+" "+t);return JSON.parse(t);};
  const source=(await inspected(async s=>await(await call(editorial+s)).json() as never,"/sources/"+f.film.id)).sources[0];
  const id=crypto.randomUUID(),sequence=editorial+"/sequences/"+id;
  let state=await json(editorial+"/sequences","POST",{id,label:"cut",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:640,height:360,expectedVersion:0});
  state=await json(sequence,"PATCH",{expectedVersion:state.libraryVersion,expectedHistoryRevision:state.sequence.history.revision,
    change:{kind:"edit",label:"trim",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-state.timeline.frames,ripple:true}}});
  const quote=await json(sequence+"/renders");
  await json(sequence+"/renders","POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}});
  const cut=(await f.worker())!;expect(cut.status).toBe("done");
  const grades=()=>f.store.all().filter(job=>job.delivery?.kind==="grade");
  return {f,cut,call,json,deliveries,grades};
}

/**
 * The offer, the admission, the render and the serve, end to end: the grade is offered beside the
 * other deliverables with the library it can use; a decision is admitted at zero cost as a job bound
 * to the cut's sealed output; the worker makes it from the cut's master; its check is sealed with it;
 * and it is listed with a link and served. The same decision under a new key is the same job, and a
 * changed decision is a new one. The cut's own sealed output is exactly what it was.
 */
test("a creator grades a finished cut with a look, and the checked grade is offered and served",async()=>{
  const {f,cut,call,json,deliveries,grades}=await edited();
  try{
    const sealedBefore=structuredClone(cut.output);
    const offered=await json(deliveries+"/"+cut.id);
    const offer=offered.offers.find((value:{kind:string})=>value.kind==="grade");
    expect(offer).toMatchObject({available:true,reason:null,output:{width:640,height:360}});
    expect(offered.grade.looks.map((look:{id:string})=>look.id)).toEqual(COLOR_LOOK_IDS);
    expect(offered.grade.neutral).toEqual({...COLOR_GRADE_NEUTRAL});
    expect(offered.grade.controls.gain).toEqual([0.5,2]);

    const decision:ColorGradeDecision={...COLOR_GRADE_NEUTRAL,look:"warm",saturation:0.9,temperature:0.1};
    const key=crypto.randomUUID();
    const asked=await json(deliveries+"/"+cut.id,"POST",{idempotencyKey:key,kind:"grade",grade:decision});
    // The same decision under another key is the same job; the same key for another decision is refused.
    expect((await json(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"grade",grade:decision})).jobId).toBe(asked.jobId);
    expect((await call(deliveries+"/"+cut.id,"POST",{idempotencyKey:key,kind:"grade",grade:{...decision,look:"cool"}})).status).toBe(400);
    // A grade names its decision, and nothing else takes one.
    expect((await call(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"grade"})).status).toBe(400);
    expect((await call(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"reframe-1:1",grade:decision})).status).toBe(400);
    expect((await call(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"grade",grade:{...decision,gain:3}})).status).toBe(400);
    expect(grades()).toHaveLength(1);
    const admitted=grades()[0]!;
    expect({costCapUsd:admitted.costCapUsd,budgetReservedUsd:admitted.budgetReservedUsd}).toEqual({costCapUsd:0,budgetReservedUsd:0});
    expect(admitted.delivery!.binding.source).toMatchObject({jobId:cut.id,outputRevision:cut.output!.editorial!.revision});
    expect(admitted.delivery!.grade!.decision).toEqual(decision);

    const made=(await f.worker())!;
    expect({id:made.id,status:made.status,failed:made.failureReason??null}).toEqual({id:asked.jobId,status:"done",failed:null});
    expect(made.costUsd).toBe(0);
    validateDeliveryOutput(made,made.deliveryOutput!);
    const check=made.deliveryOutput!.grade!;
    expect(check.source).toEqual({sha256:made.deliveryOutput!.file.sha256,bytes:made.deliveryOutput!.file.bytes});
    expect(check.measurement.framesMeasured).toBe(30);
    expect(check.verdict).toBe("offered");
    expect(made.deliveryOutput!.delivered).toMatchObject({width:640,height:360,video:"h264",audio:"aac"});

    const listed=(await json(deliveries)).jobs.find((job:{id:string})=>job.id===made.id);
    expect(listed.unavailable).toBeNull();
    expect(listed.grade).toMatchObject({decision,look:{id:"warm",label:"Warm"},check:{verdict:"offered"}});
    expect((await f.call(listed.output.url)).status).toBe(200);

    // A changed decision is a different grade of the same cut.
    const cooler=await json(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"grade",grade:{...decision,look:"cool"}});
    expect(cooler.jobId).not.toBe(asked.jobId);
    // And the cut is the cut: its sealed output did not move.
    expect(f.store.get(cut.id)!.output).toEqual(sealedBefore);
  }finally{await f.close();}
},300_000);

/**
 * A gain and an exposure pushed until most of the picture leaves the RGB cube. The grade is made and
 * sealed — the measurement is the record — but its check withholds it: it is listed with no link and
 * the reason, its decision and findings are shown, and the file is not served even to a request that
 * names it with a valid token.
 */
test("a grade that clips what the cut did not is sealed and listed with the reason, and never served",async()=>{
  const {f,cut,json,deliveries}=await edited();
  try{
    const decision:ColorGradeDecision={...COLOR_GRADE_NEUTRAL,gain:2,exposure:1};
    await json(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"grade",grade:decision});
    const made=(await f.worker())!;
    expect({status:made.status,failed:made.failureReason??null}).toEqual({status:"done",failed:null});
    const check=made.deliveryOutput!.grade!;
    expect(check.verdict).toBe("withheld");
    expect(check.findings.find(finding=>finding.code==="highlights-clipped")).toMatchObject({severity:"withhold"});

    const listed=(await json(deliveries)).jobs.find((job:{id:string})=>job.id===made.id);
    expect(listed.output).toBeNull();
    expect(listed.unavailable).toContain("This grade is withheld: This grade clips the highlights");
    expect(listed.unavailable).toContain("Lower the gain or the exposure");
    expect(listed.grade.check.verdict).toBe("withheld");
    expect(listed.grade.decision).toEqual(decision);

    // Asked for directly, by the path it was sealed under and a token that would serve any other deliverable.
    const token=mintArtifactToken(made.projectId,made.id,Date.parse(made.linkExpiresAt!));
    expect((await f.call("/artifacts/"+token+"/"+made.deliveryOutput!.file.path)).status).toBe(404);
  }finally{await f.close();}
},300_000);
