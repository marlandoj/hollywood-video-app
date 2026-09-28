/**
 * HV-022-19 — a render request whose key belonged to another kind of job was answered with that job.
 *
 * `POST /projects/:id/jobs` looks the request's idempotency key up among the project's jobs and, when
 * it finds one, answers with it (HV-030-10: `admitted: false`) before either backend's admission
 * runs. It refused a match only for a dialogue replacement, a screenplay proposal or a take plan.
 * Every other kind of job -- a voice audition, a sound mix, a motion graphic, a deliverable, or a
 * render of the other stage -- came back as though it were the render asked for:
 *
 *     {"jobId":"<the audition>","stage":"audio-take","status":"done","admitted":false}  202
 *
 * so nothing was rendered, the caller was told its render already existed, and a final asked for
 * with the key its rough cut had used was answered with the rough cut. The audio-take, dialogue,
 * lip-sync, sound, graphic and delivery routes each refuse a key that belongs to another request;
 * this one now does too.
 */
import {expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";

test("a render asked for with a voice audition's key is refused, and the audition is not handed back",async()=>{
  const f=await dubStudio();
  try{
    const audition=f.spanish[0]!;expect(audition.stage).toBe("audio-take");
    const r=await f.call(f.base+"/jobs","POST",{idempotencyKey:audition.idempotencyKey.slice(f.owner.projectId.length+1)},f.owner.token);
    const body=await r.json() as Record<string,unknown>;
    expect({status:r.status,jobId:body.jobId}).toEqual({status:409,jobId:undefined});
    expect(body.error).toBe("This idempotency key belongs to another kind of job. Use a new key.");
  }finally{await f.close();}
},300_000);

test("a final asked for with its rough cut's key is refused rather than answered with the rough cut",async()=>{
  const f=await dubStudio();
  try{
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:f.film.id,decision:"approved"},f.owner.token)).status).toBe(201);
    const r=await f.call(f.base+"/jobs","POST",{idempotencyKey:"source",stage:"final",animaticJobId:f.film.id},f.owner.token);
    const body=await r.json() as Record<string,unknown>;
    expect({status:r.status,jobId:body.jobId,stage:body.stage}).toEqual({status:409,jobId:undefined,stage:undefined});
  }finally{await f.close();}
},300_000);

test("the same render asked for again with its own key is still answered with it, admitted once",async()=>{
  const f=await dubStudio();
  try{
    const r=await f.call(f.base+"/jobs","POST",{idempotencyKey:"source"},f.owner.token);
    expect({http:r.status,...await r.json() as Record<string,unknown>}).toMatchObject({http:202,jobId:f.film.id,stage:"animatic",admitted:false});
  }finally{await f.close();}
},300_000);
