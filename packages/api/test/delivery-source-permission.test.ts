/**
 * HV-027-14 — deliverables went on being served, listed and made after their film was withdrawn.
 *
 * A deliverable -- a 1:1 or 9:16 reframe, a mezzanine -- is the frames of a picture edit or an
 * assembly. Its permission check, `assertDeliveryPermission`, read only the project's: rights attested,
 * deletion date not passed. It never looked at the film it was made from. Every sibling that reuses a
 * finished cut (sound mixes, editorial, lip-sync) runs the cut's own check, so:
 *
 * - **after a character's likeness permission was revoked**, the cut itself answered 404 on its media
 *   link, but its reframe still downloaded (200), the deliverables list still showed it as available,
 *   and a new mezzanine of the same cut was admitted and rendered;
 * - **after the cut's retention link had lapsed**, the sound-mix and editorial routes refused it, but
 *   delivery still offered it, admitted a mezzanine and made it -- a fresh 30-day copy of a film the
 *   studio had stopped keeping.
 *
 * The source's own cast permission is now read wherever a deliverable is listed, served, admitted or
 * rendered, and a new deliverable is made only from a film that is still retained.
 */
import {expect,test} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected} from "../../../test/fixtures/editorial-inspection";
import {CAST_INPUT} from "../../../test/fixtures/casting";

/** A dub-studio project with a finished picture edit of its film, and the calls to reach it. */
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
  const deliverablesMade=()=>f.store.all().filter(job=>job.delivery).length;
  return {f,cut,call,json,deliveries,deliverablesMade};
}

test("after a character's permission is revoked, the cut's deliverable is not served or listed as available, and no new one is made",async()=>{
  const {f,cut,call,json,deliveries,deliverablesMade}=await edited();
  try{
    await json(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"reframe-1:1"});
    expect((await f.worker())!.status).toBe("done");
    const deliverable=(await json(deliveries)).jobs[0];
    expect((await f.call(deliverable.output.url)).status).toBe(200);
    // The creator revokes the character's likeness permission.
    const version=f.projects.snapshot().projects.find(p=>p.id===f.owner.projectId)!.castingHistory!.length;
    await f.projects.saveCharacter(f.owner.token,f.id,{...CAST_INPUT,permission:{...CAST_INPUT.permission,status:"revoked"}} as never,version);
    expect((await f.call(deliverable.output.url)).status).toBe(404);
    const listed=(await json(deliveries)).jobs[0];
    expect({output:listed.output,unavailable:typeof listed.unavailable}).toEqual({output:null,unavailable:"string"});
    expect(listed.unavailable).toContain("cast or source permission is no longer available");
    const before=deliverablesMade();
    const asked=await call(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"mezzanine"});
    expect(asked.status).toBeGreaterThanOrEqual(400);
    expect(deliverablesMade()).toBe(before);
  }finally{await f.close();}
},300_000);

test("a cut whose retention link has lapsed is neither offered nor made into a new deliverable",async()=>{
  const {f,cut,call,deliveries,deliverablesMade}=await edited();
  try{
    const jobs=JSON.parse(readFileSync(f.paths.queuePath,"utf8"));
    for(const job of jobs)if(job.id===cut.id)job.linkExpiresAt=new Date(Date.now()-60_000).toISOString();
    writeFileSync(f.paths.queuePath,JSON.stringify(jobs));
    const offers=await call(deliveries+"/"+cut.id);
    expect(offers.status).toBe(409);
    expect((await offers.json() as {error:string}).error).toBe("This film is no longer retained, so nothing new can be delivered from it.");
    const asked=await call(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"mezzanine"});
    expect(asked.status).toBe(409);
    expect(deliverablesMade()).toBe(0);
  }finally{await f.close();}
},300_000);

test("a retained cut with its permission intact is offered and delivered as before",async()=>{
  const {f,cut,json,deliveries}=await edited();
  try{
    expect((await json(deliveries+"/"+cut.id)).offers.some((offer:{available:boolean})=>offer.available)).toBe(true);
    await json(deliveries+"/"+cut.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"reframe-1:1"});
    const made=(await f.worker())!;
    expect(made.status).toBe("done");
    const listed=(await json(deliveries)).jobs[0];
    expect(listed.unavailable).toBeNull();
    expect((await f.call(listed.output.url)).status).toBe(200);
  }finally{await f.close();}
},300_000);
