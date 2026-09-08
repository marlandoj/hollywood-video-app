import {expect,test} from "bun:test";
import {mkdtempSync,readdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {EditOriginalFrameApi} from "../src/edit-original-frame-api";
import {decodePreviewPage,previewDigest} from "../../planner/src/edit-preview-protocol";
const cleanup=(path:string)=>{const root=realpathSync(path);if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-dub-studio-"))throw new Error("Unsafe mask API fixture cleanup.");rmSync(root,{recursive:true,force:true});};

test("mask owners load original frames beyond the trim, preview the saved composite, render reviewed masks and reject stale or revoked access",async()=>{
  const f=await dubStudio();
  try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown)=>f.call(base+path,method,body,f.owner.token),json=async(path:string)=>{const r=await call(path);expect(await r.clone().text()).not.toContain('"error"');expect(r.status).toBe(200);return r.json() as Promise<any>;};
    const source=(await json("/sources/"+f.film.id)).sources[0],created=await call("/sequences","POST",{id:crypto.randomUUID(),label:"Mask review fixture",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:320,height:180,expectedVersion:0});expect(created.status).toBe(201);let state=await created.json() as any;const path="/sequences/"+state.sequence.id;
    const change=async(operation:unknown)=>{const response=await call(path,"PATCH",{expectedVersion:state.libraryVersion,expectedHistoryRevision:state.sequence.history.revision,change:{kind:"edit",label:"Author a saved mask",operation}});expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(200);state=await response.json();};
    await change({kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-state.timeline.frames,ripple:true});
    const originalPath=(frame:number)=>path+"/sources/"+f.film.id+"/frames/"+frame+"?historyRevision="+state.sequence.history.revision;
    const last=state.timeline.sources[0].frames-1,oldPath=originalPath(last);expect(last).toBeGreaterThan(state.timeline.frames-1);expect((await f.call(base+oldPath)).status).toBe(401);
    let original=await call(oldPath),end=Date.now()+60000;
    while(original.status===202){const preparing=await original.json() as any;expect(preparing.historyRevision).toBe(state.sequence.history.revision);if(Date.now()>end)throw new Error("Original did not prepare");await Bun.sleep(50);original=await call(oldPath);}
    expect(await original.clone().text().then(t=>t.startsWith('{"error"'))).toBe(false);expect(original.status).toBe(200);expect(original.headers.get("content-type")).toBe("image/png");expect(original.headers.get("x-hv-source-frame")).toBe(String(last));expect(original.headers.get("x-hv-history-revision")).toBe(state.sequence.history.revision);expect(original.headers.get("x-hv-source-width")).toBe(String(state.timeline.sources[0].width));expect(original.headers.get("access-control-expose-headers")).toContain("x-hv-source-revision");const png=new Uint8Array(await original.arrayBuffer());expect(await previewDigest(png)).toBe(original.headers.get("x-hv-preview-sha256")!);expect(Array.from(png.subarray(0,8))).toEqual([137,80,78,71,13,10,26,10]);
    expect((await call(originalPath(last+1))).status).toBe(400);expect((await call(oldPath+"&path=private")).status).toBe(400);
    await change({kind:"composite",clipId:"initial-0",composite:{schema:"hv-edit-composite/1",masks:[{id:"subject",label:"Left subject",sourceRevision:state.timeline.sources[0].revision,kind:"rectangle",combine:"replace",invert:false,featherQ8:0,keyframes:[{sourceFrame:0,interpolation:"hold",geometry:{xQ16:0,yQ16:0,widthQ16:32768,heightQ16:65536}}]}]}});
    expect(state.timeline.schema).toBe("hv-edit-timeline/2");expect((await call(oldPath)).status).toBe(400);
    const id=crypto.randomUUID(),history=state.sequence.history.revision,session=path+"/preview/"+id,query="?historyRevision="+history;
    expect((await call(path+"/preview","POST",{id,historyRevision:history,from:0,frames:30})).status).toBe(202);let preview:any;end=Date.now()+60000;
    do{if(Date.now()>end)throw new Error("Composition did not prepare");await Bun.sleep(50);preview=await json(session+query);if(preview.state==="failed")throw new Error(preview.error);}while(preview.state!=="ready");
    expect(preview.picture.picturePurpose).toBe("timeline-composite");const picture=session+"/picture/timeline-picture/0"+query+"&sourceKey="+preview.picture.sourceKey+"&frame=12";
    for(let i=0;i<2;i++){const response=await call(picture);expect(await response.clone().text().then(t=>t.startsWith('{"error"'))).toBe(false);expect(response.status).toBe(200);const packet=await decodePreviewPage(new Uint8Array(await response.arrayBuffer()),{sourceKey:preview.picture.sourceKey,from:0,sha256:response.headers.get("x-hv-preview-sha256")!});expect(packet.header.schema).toBe("hv-edit-preview-page/3");expect(packet.header.pictureFrames).toEqual([12]);expect(packet.header.sourceRevision).toBe(state.timeline.revision);}
    expect((await call(picture.replace("&frame=12",""))).status).toBe(400);expect((await call(picture.replace("&frame=12","&frame=30"))).status).toBe(400);expect((await call(session+"/picture/"+f.film.id+"/0"+query+"&sourceKey="+preview.sources[0].sourceKey)).status).toBe(400);
    const quote=await json(path+"/renders");expect(quote.compositing.timelineRevision).toBe(state.timeline.revision);expect(quote.compositing.clips[0].maskCount).toBe(1);expect(quote.review.compositingRevision).toHaveLength(64);
    const body={idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:history,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}};
    expect((await call(path+"/renders","POST",{...body,review:{...body.review,compositingRevision:"f".repeat(64)}})).status).toBe(400);expect((await call(path+"/renders","POST",body)).status).toBe(202);
    const done=(await f.worker())!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.output!.editorial!.plan.review.compositingRevision).toBe(quote.review.compositingRevision);
    const warmOriginal=await call(originalPath(0));if(warmOriginal.status===200)await warmOriginal.arrayBuffer();else expect(warmOriginal.status).toBe(202);
    writeFileSync(f.paths.queuePath,JSON.stringify(f.store.all().filter(job=>job.id!==f.film.id)));let retained=await call(originalPath(0));end=Date.now()+60000;while(retained.status===202){await retained.arrayBuffer();if(Date.now()>end)throw new Error("Retained original did not prepare");await Bun.sleep(50);retained=await call(originalPath(0));}expect(await retained.clone().text().then(t=>t.startsWith('{"error"'))).toBe(false);expect(retained.status).toBe(200);expect(retained.headers.get("x-hv-source-revision")).toBe(state.timeline.sources[0].revision);await retained.arrayBuffer();
    expect(f.projects.revokeCharacterPermission(f.owner.token,f.id,1)).not.toBeNull();expect((await call(picture)).status).toBe(400);expect((await call(originalPath(0))).status).toBe(400);expect(f.ledger.monthSpend()).toBe(0);
  }finally{await f.close(false);expect(readdirSync(f.paths.artifactRoot).filter(n=>n.startsWith(".edit-original-")||n.startsWith(".edit-preview-"))).toEqual([]);cleanup(f.root);}
},180000);

test("original-frame cancellation and shutdown release stalled authorization without touching unrelated files",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-dub-studio-original-close-"))),api=new EditOriginalFrameApi({root,job:()=>undefined,bindings:async()=>[]}),url="http://fixture/?historyRevision="+"a".repeat(64);
  try{const controller=new AbortController(),cancelled=api.handle(new Request(url,{signal:controller.signal}),"project","sequence","source",0,()=>new Promise(()=>{}));void cancelled.catch(()=>{});controller.abort(new Error("cancel original"));await expect(cancelled).rejects.toThrow("cancel original");const held=api.handle(new Request(url),"project","sequence","source",0,()=>new Promise(()=>{}));void held.catch(()=>{});await api.close();await expect(held).rejects.toThrow("stopped");expect(readdirSync(root)).toEqual([]);}finally{await api.close();cleanup(root);}
});
