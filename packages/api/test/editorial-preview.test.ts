import {expect,test} from "bun:test";
import {mkdtempSync,readdirSync,realpathSync,rmSync,readFileSync,writeFileSync,renameSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {EditPreviewApi} from "../src/edit-preview-api";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {decodePreviewPage,previewDigest} from "../../planner/src/edit-preview-protocol";
import {previewRequests} from "../../planner/src/edit-preview-render";
import {contentHash} from "../../generator/src/capabilities";
import {EditPreviewMix} from "../../generator/src/edit-preview-mix";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";
function cleanup(path:string){const root=realpathSync(path);if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-dub-studio-"))throw new Error("Unsafe preview API fixture cleanup.");rmSync(root,{recursive:true,force:true});}
test("owners prepare only a saved playhead window, receive verified picture/mixed audio and cannot reuse stale or revoked preview media",async()=>{
  const f=await dubStudio(),identity=EditPreviewMix.prototype.identity,page=EditPreviewMix.prototype.page,renderers:WeakRef<EditPreviewMix>[]=[];let renders=0;
  EditPreviewMix.prototype.identity=function(...args){renderers.push(new WeakRef(this));return identity.apply(this,args);};
  EditPreviewMix.prototype.page=function(...args){renders++;return page.apply(this,args);};
  // Collection is asynchronous and slower on loaded CI runners; allow several seconds before calling a renderer leaked.
  async function collected(references:WeakRef<EditPreviewMix>[]){for(let i=0;i<200;i++){Bun.gc(true);if(references.every(r=>!r.deref()))return true;await Bun.sleep(25);}return false;}
  try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown,token=f.owner.token)=>f.call(base+path,method,body,token),json=async(path:string)=>{const r=await call(path);expect(await r.clone().text()).not.toContain('"error"');expect(r.status).toBe(200);return r.json() as Promise<any>;};
    const inspected=await inspectedSource(async path=>await(await call(path)).json() as any,"/sources/"+f.film.id),source=inspected.sources[0],created=await call("/sequences","POST",{id:crypto.randomUUID(),label:"Preview cut",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:640,height:360,expectedVersion:0});expect(created.status).toBe(201);const state=await created.json() as any,path="/sequences/"+state.sequence.id,history=state.sequence.history.revision,id=crypto.randomUUID(),body={id,historyRevision:history,from:0,frames:60};
    const requested=await call(path+"/preview","POST",body);expect(await requested.clone().text()).not.toContain('"error"');expect(requested.status).toBe(202);let preview=await requested.json() as any;expect(preview.state).toBe("preparing");expect(preview.frames).toBe(Math.min(60,state.timeline.frames));expect(preview.totalSources).toBe(1);expect(preview.audio).toBeNull();expect(JSON.stringify(preview)).not.toContain("original/");
    const session=path+"/preview/"+id,query="?historyRevision="+history;expect((await f.call(base+session+query)).status).toBe(401);const stranger=await(await f.call("/api/projects","POST")).json() as any;expect((await call(session+query,"GET",undefined,stranger.token)).status).toBe(401);
    expect((await call(path+"/preview","POST",{...body,from:60})).status).toBe(400);const end=Date.now()+60000;while(preview.state!=="ready"){if(Date.now()>end)throw new Error("Owner preview preparation did not finish.");await Bun.sleep(30);preview=await json(session+query);if(preview.state==="failed")throw new Error(preview.error);}
    expect(preview.completedSources).toBe(1);expect(preview.audio.sampleRate).toBe(48000);expect(preview.sources[0].sourceKey).toHaveLength(64);
    const audioPath=session+"/audio/0"+query+"&sourceKey="+preview.audio.sourceKey,picturePath=session+"/picture/"+f.film.id+"/0"+query+"&sourceKey="+preview.sources[0].sourceKey;
    for(const [url,key,picture]of [[audioPath,preview.audio.sourceKey,false],[picturePath,preview.sources[0].sourceKey,true]] as const){const response=await call(url);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("access-control-expose-headers")).toContain("x-hv-preview-sha256");const bytes=new Uint8Array(await response.arrayBuffer()),decoded=await decodePreviewPage(bytes,{sourceKey:key,from:0,sha256:response.headers.get("x-hv-preview-sha256")!});expect(decoded.header.includePicture).toBe(picture);expect(decoded.header.audioLanes).toEqual(picture?[]:["mix"]);if(picture)expect(decoded.header.picture.map(p=>p.frame)).toEqual(previewRequests(state.timeline,0,preview.frames).find(p=>p.includePicture)!.pictureFrames!);if(response.headers.has("content-length"))expect(bytes.length).toBe(Number(response.headers.get("content-length")));}
    // Repeated admission/status and concurrent warm reads retain one renderer for this live window.
    expect((await call(path+"/preview","POST",body)).status).toBe(202);expect((await json(session+query)).audio.sourceKey).toBe(preview.audio.sourceKey);
    const warm=await Promise.all([call(audioPath),call(audioPath)]),hashes:string[]=[];
    for(const response of warm){expect(response.status).toBe(200);hashes.push(await previewDigest(new Uint8Array(await response.arrayBuffer())));}
    expect(hashes[0]).toBe(hashes[1]);expect(renders).toBe(1);expect(renderers.length).toBeGreaterThan(3);expect(renderers.every(r=>r.deref()===renderers[0]!.deref())).toBe(true);
    // New windows may reuse the packet, but must release their own renderer when stopped.
    for(let i=0;i<3;i++){const other=crypto.randomUUID(),start=renderers.length,otherPath=path+"/preview/"+other;
      expect((await call(path+"/preview","POST",{...body,id:other})).status).toBe(202);
      const response=await call(otherPath+"/audio/0"+query+"&sourceKey="+preview.audio.sourceKey);expect(response.status).toBe(200);expect(await previewDigest(new Uint8Array(await response.arrayBuffer()))).toBe(hashes[0]);
      expect(renderers[start]!.deref()).not.toBe(renderers[0]!.deref());expect((await call(otherPath+query,"DELETE")).status).toBe(200);expect(await collected(renderers.slice(start))).toBe(true);
    }
    expect(renders).toBe(1);
    expect((await call(audioPath.replace(preview.audio.sourceKey,"0".repeat(64)))).status).toBe(400);expect((await call(session+"/audio/60"+query+"&sourceKey="+preview.audio.sourceKey)).status).toBe(400);expect((await call(picturePath+"&path=private")).status).toBe(400);
    expect((await call(session+"/picture/"+f.film.id+"/60"+query+"&sourceKey="+preview.sources[0].sourceKey)).status).toBe(400);
    const options=await fetch(new URL(base+session+query,f.server.url),{method:"OPTIONS",headers:{origin:"http://localhost:8081","access-control-request-method":"DELETE","access-control-request-headers":"authorization"}});expect(options.headers.get("access-control-allow-methods")).toContain("DELETE");expect(options.headers.get("access-control-allow-methods")).toContain("PATCH");
    const changed=await call(path,"PATCH",{expectedVersion:state.libraryVersion,expectedHistoryRevision:history,change:{kind:"edit",label:"Mark current beat",operation:{kind:"marker",marker:{id:"beat",frame:1,label:"Beat"}}}});expect(changed.status).toBe(200);const nextState=await changed.json() as any;expect((await call(audioPath)).status).toBe(400);expect((await call(picturePath)).status).toBe(400);
    const nextHistory=nextState.sequence.history.revision,next=crypto.randomUUID();expect((await call(path+"/preview","POST",{id:next,historyRevision:nextHistory,from:0,frames:60})).status).toBe(202);const latest=await json(path+"/preview/"+next+"?historyRevision="+nextHistory);expect(latest.state).toBe("ready");expect(latest.sources[0].sourceKey).toBe(preview.sources[0].sourceKey);expect(latest.audio.sourceKey).not.toBe(preview.audio.sourceKey);
    expect((await call(session+query,"DELETE")).status).toBe(200);expect((await call(session+query,"DELETE")).status).toBe(200);expect(await collected(renderers)).toBe(true);
    const nextAudio=path+"/preview/"+next+"/audio/0?historyRevision="+nextHistory+"&sourceKey="+latest.audio.sourceKey,prepared=await call(nextAudio);expect(prepared.status).toBe(200);await prepared.arrayBuffer();expect(renders).toBe(2);
    // Revoking character permission must also refuse a cache hit from a still-retained original.
    expect(f.projects.revokeCharacterPermission(f.owner.token,f.id,1)).not.toBeNull();expect((await call(nextAudio)).status).toBe(400);expect((await call(path+"/preview/"+next+"/picture/"+f.film.id+"/0?historyRevision="+nextHistory+"&sourceKey="+latest.sources[0].sourceKey)).status).toBe(400);
    expect((await call(path+"/preview/"+next+"?historyRevision="+nextHistory,"DELETE")).status).toBe(200);expect((await call(path+"/preview/"+next+"?historyRevision="+nextHistory)).status).toBe(400);expect(f.ledger.monthSpend()).toBe(0);expect(contentHash(f.store.get(f.film.id)!.output)).toBe(contentHash(f.film.output));
  }finally{EditPreviewMix.prototype.identity=identity;EditPreviewMix.prototype.page=page;await f.close(false);expect(readdirSync(f.paths.artifactRoot).filter(n=>n.startsWith(".edit-preview-"))).toEqual([]);cleanup(f.root);}
},120000);
test("preview shutdown and cancelled requests release stalled owner authorization",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-dub-studio-preview-close-"))),api=new EditPreviewApi({root,job:()=>undefined,bindings:async()=>[]}),url="http://fixture/?historyRevision="+"a".repeat(64);
  try{const controller=new AbortController(),cancelled=api.handle(["window"],new Request(url,{signal:controller.signal}),"project","sequence",()=>new Promise(()=>{}));void cancelled.catch(()=>{});controller.abort(new Error("request cancelled"));await expect(cancelled).rejects.toThrow("request cancelled");
    const held=api.handle(["window"],new Request(url),"project","sequence",()=>new Promise(()=>{}));void held.catch(()=>{});await api.close();await expect(held).rejects.toThrow("stopped");expect(readdirSync(root)).toEqual([]);
  }finally{await api.close();cleanup(root);}
});
test("rendered-version previews remain bound to frozen edits and retained originals after current history changes",async()=>{
  const f=await dubStudio();let restore:()=>void=()=>{};
  try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown,token=f.owner.token)=>f.call(base+path,method,body,token),json=async(path:string)=>{const response=await call(path);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(200);return response.json() as Promise<any>;};
    const source=(await inspectedSource(async path=>await(await call(path)).json() as any,"/sources/"+f.film.id)).sources[0],creation={id:crypto.randomUUID(),label:"Frozen comparison",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:640,height:360,expectedVersion:0};
    const created=await call("/sequences","POST",creation);expect(created.status).toBe(201);const saved=await created.json() as any,sequencePath="/sequences/"+saved.sequence.id,quote=await json(sequencePath+"/renders");
    expect((await call(sequencePath+"/renders","POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}})).status).toBe(202);
    const done=(await f.worker())!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");const revision=contentHash(done.output),versionPath="/versions/"+done.id,versionQuery="?outputRevision="+revision;
    const version=await json(versionPath+versionQuery);expect(version.sequence).toEqual(done.pictureEdit!.sequence);expect(version.timeline).toEqual(saved.timeline);expect(version.outputRevision).toBe(revision);
    expect((await call(versionPath)).status).toBe(400);expect((await call(versionPath+versionQuery+"&outputRevision="+revision)).status).toBe(400);expect((await f.call(base+versionPath+versionQuery)).status).toBe(401);
    const foreign=await(await f.call("/api/projects","POST")).json() as any;expect((await call(versionPath+versionQuery,"GET",undefined,foreign.token)).status).toBe(401);
    expect((await call(sequencePath,"PATCH",{expectedVersion:saved.libraryVersion,expectedHistoryRevision:saved.sequence.history.revision,change:{kind:"edit",label:"Later current cut",operation:{kind:"marker",marker:{id:"later",frame:1,label:"Later"}}}})).status).toBe(200);
    expect((await json(versionPath+versionQuery)).timeline).toEqual(saved.timeline);expect((await json(sequencePath)).sequence.history.revision).not.toBe(saved.sequence.history.revision);
    // The version must recover from its own copies after the original carrier is gone.
    const original=realpathSync(join(f.paths.artifactRoot,f.film.projectId,f.film.id));if(!original.startsWith(realpathSync(f.paths.artifactRoot)+sep))throw new Error("Unsafe version fixture path");const queueBytes=readFileSync(f.paths.queuePath);renameSync(original,original+"-hidden");writeFileSync(f.paths.queuePath,JSON.stringify([done]));restore=()=>{renameSync(original+"-hidden",original);writeFileSync(f.paths.queuePath,queueBytes);};
    const id=crypto.randomUUID(),body={id,historyRevision:saved.sequence.history.revision,outputRevision:revision,from:0,frames:60},previewBase=versionPath+"/preview",session=previewBase+"/"+id,query="?historyRevision="+body.historyRevision+"&outputRevision="+revision;
    expect((await call(previewBase,"POST",{...body,outputRevision:"f".repeat(64)})).status).toBe(409);expect((await call(previewBase,"POST",body)).status).toBe(202);
    let preview:any;const end=Date.now()+60000;do{if(Date.now()>end)throw new Error("Version preview did not prepare");await Bun.sleep(30);preview=await json(session+query);if(preview.state==="failed")throw new Error(preview.error);}while(preview.state!=="ready");expect(preview.outputRevision).toBe(revision);expect(preview.timelineRevision).toBe(saved.timeline.revision);
    const picture=session+"/picture/"+f.film.id+"/0"+query+"&sourceKey="+preview.sources[0].sourceKey,audio=session+"/audio/0"+query+"&sourceKey="+preview.audio.sourceKey;
    for(const [path,key]of [[picture,preview.sources[0].sourceKey],[audio,preview.audio.sourceKey]]){const response=await call(path);expect(response.status).toBe(200);expect(response.headers.get("access-control-expose-headers")).toContain("x-hv-preview-sha256");const packet=await decodePreviewPage(new Uint8Array(await response.arrayBuffer()),{sourceKey:key,from:0,sha256:response.headers.get("x-hv-preview-sha256")!});expect(packet.header.frames).toBeGreaterThan(0);}
    // Identical raw sequence/job IDs do not grant access through the other target kind.
    const current=await json(sequencePath);expect((await call("/sequences","POST",{...creation,id:done.id,label:"Same raw ID",sources:[{jobId:done.id,sourceRevision:source.sourceRevision}],expectedVersion:current.libraryVersion})).status).toBe(201);
    expect((await call("/sequences/"+done.id+"/preview/"+id+"?historyRevision="+body.historyRevision,"DELETE")).status).toBe(400);expect((await json(session+query)).state).toBe("ready");
    const tampered=structuredClone(done);tampered.output!.editorial!.files[0]!.sha256="0".repeat(64);writeFileSync(f.paths.queuePath,JSON.stringify([tampered]));for(const path of [versionPath+versionQuery,session+query,picture,audio])expect((await call(path)).status).toBe(409);
    // Cleanup remains available with the captured scope even if the output changed.
    expect((await call(session+query,"DELETE")).status).toBe(200);writeFileSync(f.paths.queuePath,JSON.stringify([done]));
    expect((await call(previewBase,"POST",{...body,id:crypto.randomUUID()})).status).toBe(202);expect(f.projects.revokeCharacterPermission(f.owner.token,f.id,1)).not.toBeNull();expect((await call(versionPath+versionQuery)).status).toBe(400);expect((await call(previewBase,"POST",{...body,id:crypto.randomUUID()})).status).toBe(400);expect(f.ledger.monthSpend()).toBe(0);
  }finally{restore();await f.close(false);cleanup(f.root);}
},180000);
