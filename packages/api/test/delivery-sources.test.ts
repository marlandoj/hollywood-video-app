/**
 * HV-026-08 — the finished cuts a deliverable can be made from are listed, each answered.
 *
 * The delivery routes took a cut's job id and assumed the caller already had it; nothing listed the
 * cuts, so a page that was to grade one had nothing to choose from. `GET …/deliveries` now names them:
 * every finished picture edit and assembly, newest first, with its size and length when it can be
 * delivered from, and with the offer route's own reason when it cannot.
 */
import {expect,test} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected} from "../../../test/fixtures/editorial-inspection";

/**
 * A finished one-second picture edit of the dub-studio film: listed as a source with its size and
 * length, while the film it was cut from — not a picture edit or an assembly — is not listed at all.
 * When the cut's retention lapses it stays listed, unavailable, with the sentence the offer route
 * answers 409 with.
 */
test("a finished cut is listed as a deliverable source, and a lapsed one is listed with the reason",async()=>{
  const f=await dubStudio();
  try{
    const editorial=f.base+"/editorial",deliveries=f.base+"/deliveries";
    const call=(path:string,method="GET",body?:unknown)=>f.call(path,method,body,f.owner.token);
    const json=async(path:string,method="GET",body?:unknown)=>{const r=await call(path,method,body);const t=await r.text();if(!r.ok)throw new Error(path+" "+r.status+" "+t);return JSON.parse(t);};
    expect((await json(deliveries)).sources).toEqual([]);
    const source=(await inspected(async s=>await(await call(editorial+s)).json() as never,"/sources/"+f.film.id)).sources[0];
    const id=crypto.randomUUID(),sequence=editorial+"/sequences/"+id;
    let state=await json(editorial+"/sequences","POST",{id,label:"cut",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:640,height:360,expectedVersion:0});
    state=await json(sequence,"PATCH",{expectedVersion:state.libraryVersion,expectedHistoryRevision:state.sequence.history.revision,
      change:{kind:"edit",label:"trim",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-state.timeline.frames,ripple:true}}});
    const quote=await json(sequence+"/renders");
    await json(sequence+"/renders","POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}});
    const cut=(await f.worker())!;expect(cut.status).toBe("done");

    const listed=(await json(deliveries)).sources;
    expect(listed).toEqual([{id:cut.id,stage:"picture-edit",completedAt:cut.completedAt,unavailable:null,width:640,height:360,durationSec:1}]);
    // The film the cut was made from is not a picture master, so it is not a source.
    expect(listed.some((value:{id:string})=>value.id===f.film.id)).toBe(false);

    const jobs=JSON.parse(readFileSync(f.paths.queuePath,"utf8"));
    for(const job of jobs)if(job.id===cut.id)job.linkExpiresAt=new Date(Date.now()-60_000).toISOString();
    writeFileSync(f.paths.queuePath,JSON.stringify(jobs));
    const lapsed=(await json(deliveries)).sources;
    expect(lapsed).toEqual([{id:cut.id,stage:"picture-edit",completedAt:cut.completedAt,unavailable:"This film is no longer retained, so nothing new can be delivered from it."}]);
    const offer=await call(deliveries+"/"+cut.id);
    expect({status:offer.status,error:(await offer.json() as {error:string}).error}).toEqual({status:409,error:lapsed[0].unavailable});
  }finally{await f.close();}
},300_000);
