import {expect,test} from "bun:test";
import {realpathSync,renameSync} from "node:fs";
import {join,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";

/**
 * HV-025-08: the studio inspects an original and then immediately saves it in a sequence, and the
 * save checked the same original all over again -- the same minutes a second time. On staging the
 * Release 1 short's `POST editorial/sequences` ran 257 seconds and died behind the edge's timeout,
 * so the film still could not be titled after HV-025-07 fixed the read. The save now reuses the
 * receipt the creator was just shown, for the exact job output and revision it was made from, with
 * its permissions re-asserted.
 */
test("saving a sequence reuses the receipt the creator was just shown",async()=>{
  const f=await dubStudio();
  try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown)=>f.call(base+path,method,body,f.owner.token);
    const source=(await inspectedSource(async path=>await(await call(path)).json() as any,"/sources/"+f.film.id)).sources[0];
    expect(source.sourceRevision).toHaveLength(64);

    // With the original's media out of reach, a second check cannot succeed: whatever answers now
    // came from the finished check, not from re-reading the film.
    const media=realpathSync(join(f.paths.artifactRoot,f.film.projectId,f.film.id));
    if(!media.startsWith(realpathSync(f.paths.artifactRoot)+sep))throw new Error("Unsafe editorial inspection fixture");
    renameSync(media,media+"-hidden");
    try{
      const created=await call("/sequences","POST",{id:crypto.randomUUID(),label:"Titled cut",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],
        firstSourceId:f.film.id,width:320,height:180,expectedVersion:0});
      expect(await created.clone().text()).not.toContain('"error"');
      expect(created.status).toBe(201);
      const state=await created.json() as any;
      expect(f.projects.peekProject(f.owner.projectId)!.editLibrary.sources.some(receipt=>receipt.revision===source.sourceRevision)).toBe(true);
      // A revision the check never produced is still refused, and is not served from the cache.
      const wrong=await call("/sequences","POST",{id:crypto.randomUUID(),label:"Wrong receipt",sources:[{jobId:f.film.id,sourceRevision:"0".repeat(64)}],
        firstSourceId:f.film.id,width:320,height:180,expectedVersion:state.libraryVersion});
      expect(wrong.status).toBe(400);
    }finally{renameSync(media+"-hidden",media);}
  }finally{await f.close();}
},180000);
