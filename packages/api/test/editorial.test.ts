import {expect,test} from "bun:test";
import {readFileSync,realpathSync,renameSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";
import {editHistoryState} from "../../planner/src/edit-history";
test("owners inspect originals, save edit history, review exact voice cuts and render continued independent sequences",async()=>{
  const f=await dubStudio();try{
    const path=f.base+"/editorial",call=(suffix:string,method="GET",body?:unknown)=>f.call(path+suffix,method,body,f.owner.token),json=async(suffix:string)=>{const r=await call(suffix);expect(r.status).toBe(200);return r.json() as Promise<any>;};
    expect((await f.call(path)).status).toBe(401);const index=await json("");expect(index.sequences).toEqual([]);expect(index.sources.some((s:any)=>s.jobId===f.film.id)).toBe(true);
    const inspected=await json("/sources/"+f.film.id),source=inspected.sources[0];expect(source.facts.voices.length).toBeGreaterThan(0);expect(source.facts.audio).toContain("dialogue");expect(source.sourceRevision).toHaveLength(64);expect(source.job).toBeUndefined();
    const body={id:crypto.randomUUID(),label:"Opening read",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:640,height:360,expectedVersion:0};
    expect((await call("/sequences","POST",{...body,sources:[{...body.sources[0],sourceRevision:"0".repeat(64)}]})).status).toBe(400);
    const created=await call("/sequences","POST",body);expect(await created.clone().text()).not.toContain('"error"');expect(created.status).toBe(201);let state=await created.json() as any;const sequencePath="/sequences/"+body.id;
    expect(state.timeline.frames).toBe(source.facts.frames);expect(state.head).toBe(0);expect(state.parent).toBeNull();expect(state.children).toEqual([]);
    const change={expectedVersion:state.libraryVersion,expectedHistoryRevision:state.sequence.history.revision,change:{kind:"edit",label:"Keep the first second",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-state.timeline.frames,ripple:true}}};
    const changed=await call(sequencePath,"PATCH",change);expect(changed.status).toBe(200);state=await changed.json();expect(editHistoryState(state.sequence.history).timeline.frames).toBe(30);expect((await call(sequencePath,"PATCH",change)).status).toBe(400);
    const quote=await json(sequencePath+"/renders");expect(quote.speechCuts.length).toBeGreaterThan(0);expect(quote.resources.originalBytes).toBeGreaterThan(0);expect(quote.costUsd).toBe(0);expect(quote.unavailable).toBeNull();
    expect(quote.review).toEqual({timelineRevision:quote.timelineRevision,speechCutsRevision:contentHash(quote.speechCuts),unmeasuredCutsRevision:contentHash(quote.unmeasuredAudioCuts),accepted:false});expect(state.timeline.frames).toBe(30);expect(state.head).toBe(1);expect(state.parent).toBe(0);expect(state.children).toEqual([]);
    const render={idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}};
    for(const patch of [{generationApproved:false},{sourceBindingsRevision:"0".repeat(64)},{historyRevision:"0".repeat(64)},{review:{...render.review,accepted:false}},{review:{...render.review,speechCutsRevision:contentHash([])}}])expect((await call(sequencePath+"/renders","POST",{...render,...patch})).status).toBe(400);
    const submitted=await call(sequencePath+"/renders","POST",render);expect(await submitted.clone().text()).not.toContain('"error"');expect(submitted.status).toBe(202);const id=(await submitted.json() as any).jobId;expect((await(await call(sequencePath+"/renders","POST",render)).json() as any).jobId).toBe(id);
    expect((await call(sequencePath+"/renders","POST",{...render,review:{...render.review,accepted:false}})).status).toBe(400);
    const done=(await f.worker())!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.id).toBe(id);expect(done.status).toBe("done");expect(done.costUsd).toBe(0);expect(done.output!.editorial!.conform.pictureFrames).toHaveLength(30);
    const original=realpathSync(join(f.paths.artifactRoot,f.film.projectId,f.film.id));if(!original.startsWith(realpathSync(f.paths.artifactRoot)+sep))throw new Error("Unsafe editorial API fixture");renameSync(original,original+"-hidden");const queueBytes=readFileSync(f.paths.queuePath);writeFileSync(f.paths.queuePath,JSON.stringify([done]));
    try{
      const retained=(await json("/sources/"+done.id)).sources[0];expect(retained.sourceRevision).toBe(source.sourceRevision);expect(retained.jobId).toBe(done.id);
      const nextId=crypto.randomUUID(),next=await call("/sequences","POST",{...body,id:nextId,label:"Alternate assembly from retained originals",sources:[{jobId:done.id,sourceRevision:retained.sourceRevision}],expectedVersion:state.libraryVersion});expect(await next.clone().text()).not.toContain('"error"');expect(next.status).toBe(201);const saved=await next.json() as any;expect(saved.sequence.sourceRevisions).toEqual([source.sourceRevision]);
      const current=await json(sequencePath);expect(current.sequence.history).toEqual(state.sequence.history);const continued=await json(sequencePath+"/renders");expect(continued.sources[0].jobId).toBe(done.id);expect(continued.timelineRevision).toBe(quote.timelineRevision);expect(continued.sourceBindingsRevision).not.toBe(quote.sourceBindingsRevision);
      const previewId=crypto.randomUUID(),previewBase=sequencePath+"/preview",previewQuery="?historyRevision="+state.sequence.history.revision;expect((await call(previewBase,"POST",{id:previewId,historyRevision:state.sequence.history.revision,from:0,frames:60})).status).toBe(202);let preview:any;const previewEnd=Date.now()+60000;
      do{if(Date.now()>previewEnd)throw new Error("Retained-copy preview did not finish.");await Bun.sleep(50);preview=await json(previewBase+"/"+previewId+previewQuery);if(preview.state==="failed")throw new Error(preview.error);}while(preview.state!=="ready");
      const picturePath=previewBase+"/"+previewId+"/picture/"+f.film.id+"/0"+previewQuery+"&sourceKey="+preview.sources[0].sourceKey,picture=await call(picturePath);expect(picture.status).toBe(200);expect((await picture.arrayBuffer()).byteLength).toBeGreaterThan(0);
      writeFileSync(f.paths.queuePath,JSON.stringify([{...done,linkExpiresAt:new Date(Date.now()-1000).toISOString()}]));try{expect((await call(picturePath)).status).toBe(400);}finally{writeFileSync(f.paths.queuePath,JSON.stringify([done]));}expect((await call(previewBase+"/"+previewId+previewQuery,"DELETE")).status).toBe(200);
      expect((await call(sequencePath,"PATCH",{expectedVersion:saved.libraryVersion,expectedHistoryRevision:state.sequence.history.revision,change:{kind:"cursor",reason:"undo",target:0,label:"Restore full original"}})).status).toBe(200);
      const final=await json(sequencePath);expect(final.head).toBe(0);expect(final.timeline.frames).toBe(source.facts.frames);expect(final.parent).toBeNull();expect(final.children).toEqual([1]);expect(final.sequence.history.events.filter((e:any)=>e.kind==="edit")).toHaveLength(1);expect((await json("")).jobs.some((j:any)=>j.pictureEdit.sequenceId===body.id)).toBe(true);
    }finally{renameSync(original+"-hidden",original);writeFileSync(f.paths.queuePath,queueBytes);}
  }finally{await f.close();}
},180000);
