import {expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";

/**
 * HV-025-07: checking an original is not request-sized work. A shared 50-second film is 247 MB
 * across 48 files, which the check copies and re-probes; it took 5.7 minutes on staging, while a
 * socket may be idle for at most 255 seconds, so the studio's request died and the Editor had to
 * share the film untitled. The check now runs beside the request: 202 while it runs, 200 with the
 * receipt when it is done, and the same refusal it always gave when the original is not allowed.
 */
test("checking an original answers 202 while it runs, then the receipt, and starts only one check",async()=>{
  const f=await dubStudio();
  try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown,token=f.owner.token)=>f.call(base+path,method,body,token);
    const first=await call("/sources/"+f.film.id);
    expect(first.status).toBe(202);
    const waiting=await first.json() as any;
    expect(waiting).toMatchObject({inspecting:true,jobId:f.film.id});
    expect(Number.isFinite(Date.parse(waiting.startedAt))).toBe(true);
    // A second reader while the check runs waits with it; it never starts a second one.
    const second=await call("/sources/"+f.film.id);
    expect(second.status).toBe(202);
    expect((await second.json() as any).startedAt).toBe(waiting.startedAt);

    const answer=await inspectedSource(async path=>await(await call(path)).json() as any,"/sources/"+f.film.id);
    const source=answer.sources[0];
    expect(source.jobId).toBe(f.film.id);
    expect(source.sourceRevision).toHaveLength(64);
    expect(source.facts.frames).toBeGreaterThan(0);
    expect(source.job).toBeUndefined();

    // The finished receipt is kept: asking again answers at once, with the same receipt.
    const again=await call("/sources/"+f.film.id);
    expect(again.status).toBe(200);
    expect((await again.json() as any).sources[0].sourceRevision).toBe(source.sourceRevision);

    // The check is still the owner's alone, and an unknown original is still refused.
    expect((await f.call(base+"/sources/"+f.film.id,"GET",undefined,undefined)).status).toBe(401);
    const unknown=await call("/sources/"+crypto.randomUUID());
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as any).error).toContain("retained source");
  }finally{await f.close();}
},180000);
