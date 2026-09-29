/**
 * HV-024-09 — a sound-mix key used on one cut, posted to another, was answered with the first cut's job.
 *
 * `POST /sound-mixes/:cut` looks its idempotency key up among the project's jobs and, when it finds
 * one, answers with it if the request body hashes the same:
 *
 *     if(previous.soundMix?.requestHash!==contentHash(input))soundFail("This key belongs to a different sound session.");
 *     return {status:202,body:{jobId:previous.id}};
 *
 * The cut is in the URL, not the body, so the same session sent with the same key to a second cut
 * hashed the same and came back 202 with the first cut's sound mix. The caller took it for the
 * second cut's mix and nothing was queued for it. The sibling routes each bind the resource in the
 * URL into this check -- lip-sync and dialogue hash the source job, graphics hash the graphic id,
 * editorial compares the sequence, delivery binds the output revision. The sound route now compares
 * the cut too; the same request to the same cut is answered with its job, as before.
 */
import {expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";

test("a sound-mix key used on one cut is refused on another, and still answered on its own cut",async()=>{
  const f=await dubStudio();
  try{
    const call=(path:string,method="GET",body?:unknown)=>f.call(path,method,body,f.owner.token);
    const json=async(path:string,method="GET",body?:unknown)=>{const r=await call(path,method,body);const t=await r.text();if(!r.ok)throw new Error(path+" "+r.status+" "+t);return JSON.parse(t);};
    await json(f.base+"/jobs","POST",{idempotencyKey:"second-cut"});const other=(await f.worker())!;expect(other.status).toBe("done");
    const quote=await json(f.base+"/sound-mixes/"+f.film.id);
    const body={idempotencyKey:"shared-key-123",generationApproved:true,sourceRevision:quote.sourceRevision,engineVersion:quote.engineVersion,session:{reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[]}};
    const first=await json(f.base+"/sound-mixes/"+f.film.id,"POST",body);
    const elsewhere=await call(f.base+"/sound-mixes/"+other.id,"POST",body);
    expect(elsewhere.status).toBe(400);
    expect((await elsewhere.json() as {error:string}).error).toBe("This key belongs to a different sound session.");
    // Nothing was queued for the other cut, and the first cut's mix is the only one.
    expect(f.store.all().filter(job=>job.soundMix).map(job=>job.soundMix!.source.jobId)).toEqual([f.film.id]);
    // The same request to its own cut is answered with its job, as before.
    expect(await json(f.base+"/sound-mixes/"+f.film.id,"POST",body)).toEqual({jobId:first.jobId});
  }finally{await f.close();}
},300_000);
