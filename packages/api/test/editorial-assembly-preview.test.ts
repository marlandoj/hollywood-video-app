import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {decodePng} from "@hyperframes/engine";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {EditPreviewApi} from "../src/edit-preview-api";
import {contentHash} from "../../generator/src/capabilities";
import {prepareEditSources} from "../../generator/src/edit-source-media";
import {conformEditAudio} from "../../generator/src/edit-conform";
import {conformEditPicture} from "../../generator/src/edit-picture";
import {soundProcessingCommand} from "../../generator/src/sound-finishing";
import {EditAssemblyClock} from "../../planner/src/edit-assembly-clock";
import {decodePreviewPage,previewDigest,previewAssemblyPictureFrames} from "../../planner/src/edit-preview-protocol";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";

function cleanup(path:string){const root=realpathSync(path);if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-dub-studio-"))throw new Error("Unsafe assembly preview API fixture cleanup");rmSync(root,{recursive:true,force:true});}
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
test("owner assembly HTTP preview addresses exact child PNG and PCM while accepted parents remain immutable",async()=>{
  const f=await dubStudio();try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown,token=f.owner.token)=>f.call(base+path,method,body,token);
    const json=async(path:string)=>{const response=await call(path);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(200);return response.json() as Promise<any>;};
    const source=(await inspectedSource(async suffix=>await(await call(suffix)).json() as any,"/sources/"+f.film.id)).sources[0],sequenceId=crypto.randomUUID(),sequencePath="/sequences/"+sequenceId;
    const created=await call("/sequences","POST",{id:sequenceId,label:"Frozen preview parent",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:320,height:180,expectedVersion:0});expect(created.status).toBe(201);let state=await created.json() as any;
    const trimmed=await call(sequencePath,"PATCH",{expectedVersion:state.libraryVersion,expectedHistoryRevision:state.sequence.history.revision,change:{kind:"edit",label:"Keep one second",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-state.timeline.frames,ripple:true}}});expect(trimmed.status).toBe(200);state=await trimmed.json();expect(state.timeline.frames).toBe(30);
    const historyRevision=state.sequence.history.revision,proposalId=crypto.randomUUID(),proposalPath="/assemblies/proposals/"+proposalId,input={id:proposalId,label:"Seams and repeated coverage",purpose:"trailer",ranges:[
      {id:"later",fromFrame:20,toFrame:30,reason:"Open on later coverage."},{id:"whole",fromFrame:0,toFrame:30,reason:"Return to the full exchange."},{id:"repeat",fromFrame:20,toFrame:30,reason:"Repeat the later coverage."},{id:"opening",fromFrame:0,toFrame:20,reason:"Finish on the opening."}
    ]};
    const proposed=await call("/assemblies/proposals","POST",{sequenceId,input,expected:{libraryVersion:0,historyRevision}});expect(proposed.status).toBe(201);const detail=await proposed.json() as any;
    const project=f.projects.peekProject(f.owner.projectId)!,original=project.editLibrary.sources.find(receipt=>receipt.facts.id===f.film.id)!,parent=project.assemblyLibrary.proposals[0]!.plan.parent.timeline,plan=project.assemblyLibrary.proposals[0]!.plan,clock=new EditAssemblyClock(plan);
    const queueBefore=readFileSync(f.paths.queuePath,"utf8"),outputBefore=contentHash(f.film.output);
    // Independent full-parent media is the reference; child routes must select it exactly at every seam.
    const prepared=await prepareEditSources([original],f.paths.artifactRoot,join(f.paths.artifactRoot,"assembly-preview-reference-sources"),async()=>{}),media=prepared.sources.map(source=>source.media),pictureDirectory=join(f.paths.artifactRoot,"assembly-preview-reference-picture");mkdirSync(pictureDirectory);
    const picture=await conformEditPicture(parent,new Map(media.map(source=>[source.id,join(f.paths.artifactRoot,source.picture.path)])),pictureDirectory,async()=>{});
    await conformEditAudio(parent,media,f.paths.artifactRoot,join(f.paths.artifactRoot,"assembly-preview-reference-audio"),async()=>{});const fullPcm=readFileSync(join(f.paths.artifactRoot,"assembly-preview-reference-audio/final.wav")).subarray(44),expectedPcm=Buffer.concat(plan.ranges.map(range=>fullPcm.subarray(range.fromFrame*1600*6,range.toFrame*1600*6)));
    const pixelsPath=join(pictureDirectory,"parent.rgba");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-f","concat","-safe","0","-threads","1","-i",join(pictureDirectory,picture.picture.concatFile),"-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-f","rawvideo",pixelsPath],pictureDirectory,async()=>{});const fullPixels=readFileSync(pixelsPath);
    const begin=async(path:string,item:any,id=crypto.randomUUID())=>{
      const body={id,historyRevision:item.revision,from:0,frames:70},response=await call(path+"/preview","POST",body);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(202);let status=await response.json() as any;const session=path+"/preview/"+id,query="?historyRevision="+item.revision,end=Date.now()+60000;
      while(status.state!=="ready"){if(Date.now()>end)throw new Error("Assembly preview preparation did not finish");if(status.state==="failed")throw new Error(status.error);await Bun.sleep(30);status=await json(session+query);}
      expect(status).toMatchObject({id,historyRevision:item.revision,timelineRevision:item.planRevision,from:0,frames:70,pageFrames:60,totalSources:1,completedSources:1});expect(status.picture).toMatchObject({width:320,height:180,picturePurpose:"timeline-composite",pictureEncoding:"png-rgba"});expect(status.audio).toMatchObject({sampleRate:48000,channels:2});expect(JSON.stringify(status)).not.toContain('"files":');expect(JSON.stringify(status)).not.toContain("original/");return {body,status,session,query,path};
    };
    const proposal=await begin(proposalPath,detail.item),audioPath=(scope:typeof proposal,from:number)=>scope.session+"/audio/"+from+scope.query+"&sourceKey="+scope.status.audio.sourceKey,picturePath=(scope:typeof proposal,frame:number)=>scope.session+"/picture/timeline-picture/"+Math.floor(frame/60)*60+scope.query+"&sourceKey="+scope.status.picture.sourceKey+"&frame="+frame;
    expect((await f.call(base+proposal.session+proposal.query)).status).toBe(401);const stranger=await(await f.call("/api/projects","POST")).json() as any;expect((await call(proposal.session+proposal.query,"GET",undefined,stranger.token)).status).toBe(401);
    const readPage=async(path:string,key:string,from:number)=>{const response=await call(path);expect(response.status).toBe(200);expect(response.headers.get("content-type")).toBe("application/vnd.hollywood-video.preview");expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("access-control-expose-headers")).toContain("x-hv-preview-sha256");const bytes=new Uint8Array(await response.arrayBuffer()),sha256=response.headers.get("x-hv-preview-sha256")!;expect(sha256).toBe(await previewDigest(bytes));if(response.headers.has("content-length"))expect(Number(response.headers.get("content-length"))).toBe(bytes.length);return {bytes,decoded:await decodePreviewPage(bytes,{sourceKey:key,from,sha256})};};
    const mixed:Uint8Array[]=[];for(const from of [0,60]){const page=await readPage(audioPath(proposal,from),proposal.status.audio.sourceKey,from);expect(page.decoded.header).toMatchObject({sourceId:"timeline-audio",sourceRevision:plan.revision,sourceFrames:70,frames:from?10:60,audioLanes:["mix"]});mixed.push(page.decoded.audio.mix!);}expect(Buffer.concat(mixed)).toEqual(expectedPcm);
    const images=new Map<number,string>(),blocks=new Map<number,string>();for(const frame of [0,9,10,16,39,40,49,50,59,60,69]){
      const page=await readPage(picturePath(proposal,frame),proposal.status.picture.sourceKey,Math.floor(frame/60)*60),selected=previewAssemblyPictureFrames(frame,plan.frames);
      expect(page.decoded.header).toMatchObject({schema:"hv-edit-preview-page/3",sourceId:"timeline-picture",sourceRevision:plan.revision,sourceFrames:70,pictureFrames:selected,pictureEncoding:"png-rgba",picturePurpose:"timeline-composite"});
      expect(selected.length).toBeLessThanOrEqual(16);const previous=blocks.get(selected[0]!);if(previous)expect(hash(page.bytes)).toBe(previous);else blocks.set(selected[0]!,hash(page.bytes));
      for(const [index,child]of selected.entries()){const parentFrame=clock.frame(child).parentFrame,expected=fullPixels.subarray(parentFrame*320*180*4,(parentFrame+1)*320*180*4);expect(page.decoded.header.picture[index]!.sourceSha256).toBe(hash(expected));expect(Buffer.from(decodePng(Buffer.from(page.decoded.picture[index]!)).data)).toEqual(expected);images.set(child,hash(page.decoded.picture[index]!));}
    }expect(images.size).toBe(70);expect(blocks.size).toBe(5);
    expect(images.get(0)).toBe(images.get(40));expect(images.get(9)).toBe(images.get(49));expect(images.get(10)).toBe(images.get(50));
    for(const path of [audioPath(proposal,0).replace(proposal.status.audio.sourceKey,"0".repeat(64)),audioPath(proposal,120),picturePath(proposal,70),picturePath(proposal,60).replace("/60?","/0?"),picturePath(proposal,0)+"&frame=0",proposal.session+"/picture/"+f.film.id+"/0"+proposal.query+"&sourceKey="+proposal.status.sources[0].sourceKey])expect((await call(path)).status).toBe(400);
    expect((await call(proposalPath+"/preview","POST",{...proposal.body,historyRevision:historyRevision})).status).toBe(400);expect((await call(proposalPath+"/preview","POST",{...proposal.body,from:60})).status).toBe(400);
    const options=await fetch(new URL(base+proposal.session+proposal.query,f.server.url),{method:"OPTIONS",headers:{origin:"http://localhost:8081","access-control-request-method":"DELETE","access-control-request-headers":"authorization"}});expect(options.headers.get("access-control-allow-methods")).toContain("DELETE");
    const acceptance={proposalRevision:detail.item.revision,assemblyId:crypto.randomUUID(),expected:{libraryVersion:detail.libraryVersion,historyRevision},reviewRevision:detail.review.revision,boundariesRevision:detail.boundaries.revision,sourceBindingsRevision:detail.sourceBindingsRevision,accepted:true},acceptedResponse=await call(proposalPath+"/accept","POST",acceptance);expect(acceptedResponse.status).toBe(201);const acceptedDetail=await acceptedResponse.json() as any,acceptedPath="/assemblies/accepted/"+acceptance.assemblyId,accepted=await begin(acceptedPath,acceptedDetail.item);
    expect(accepted.status.audio.sourceKey).toBe(proposal.status.audio.sourceKey);expect(accepted.status.picture.sourceKey).toBe(proposal.status.picture.sourceKey);
    const warm=await readPage(picturePath(accepted,40),accepted.status.picture.sourceKey,0);expect(hash(warm.decoded.picture[warm.decoded.header.picture.findIndex(p=>p.frame===40)]!)).toBe(images.get(40)!);
    // A session remains bound to its exact kind and owner even where its child page keys coincide.
    expect((await call(acceptedPath+"/preview/"+proposal.body.id+proposal.query,"DELETE")).status).toBe(400);expect((await json(proposal.session+proposal.query)).state).toBe("ready");
    const revised=await call(proposalPath,"PATCH",{input:{label:"Later proposal",purpose:"trailer",ranges:[{id:"new-range",fromFrame:1,toFrame:5,reason:"A different reviewed range."}]},expected:{libraryVersion:acceptedDetail.libraryVersion,proposalRevision:detail.item.revision,historyRevision}});expect(revised.status).toBe(200);
    for(const path of [proposal.session+proposal.query,audioPath(proposal,0),picturePath(proposal,0)])expect((await call(path)).status).toBe(400);expect((await call(proposalPath+"/preview","POST",{...proposal.body,id:crypto.randomUUID()})).status).toBe(400);
    expect((await call(proposal.session+proposal.query,"DELETE")).status).toBe(200);expect((await call(proposal.session+proposal.query,"DELETE")).status).toBe(200);
    const changed=await call(sequencePath,"PATCH",{expectedVersion:state.libraryVersion,expectedHistoryRevision:historyRevision,change:{kind:"edit",label:"Later parent edit",operation:{kind:"marker",marker:{id:"later",frame:1,label:"Later authoring"}}}});expect(changed.status).toBe(200);expect((await json(sequencePath)).sequence.history.revision).not.toBe(historyRevision);
    expect((await json(accepted.session+accepted.query)).timelineRevision).toBe(plan.revision);const after=await readPage(picturePath(accepted,40),accepted.status.picture.sourceKey,0);expect(after.bytes).toEqual(warm.bytes);
    const tail=await readPage(audioPath(accepted,60),accepted.status.audio.sourceKey,60);expect(Buffer.from(tail.decoded.audio.mix!)).toEqual(expectedPcm.subarray(60*1600*6));
    expect(f.projects.revokeCharacterPermission(f.owner.token,f.id,1)).not.toBeNull();const deniedStatus=await call(accepted.session+accepted.query);expect(deniedStatus.status).toBe(200);const denied=await deniedStatus.json() as any;expect(denied.state).toBe("failed");expect(denied.audio).toBeNull();expect(denied.picture).toBeUndefined();
    for(const path of [audioPath(accepted,0),picturePath(accepted,40)])expect((await call(path)).status).toBe(400);
    expect((await call(acceptedPath+"/preview","POST",{...accepted.body,id:crypto.randomUUID()})).status).toBe(400);expect((await call(accepted.session+accepted.query,"DELETE")).status).toBe(200);expect((await call(accepted.session+accepted.query,"DELETE")).status).toBe(200);
    expect(readFileSync(f.paths.queuePath,"utf8")).toBe(queueBefore);expect(contentHash(f.store.get(f.film.id)!.output)).toBe(outputBefore);expect(f.ledger.monthSpend()).toBe(0);
  }finally{await f.close(false);expect(readdirSync(f.paths.artifactRoot).filter(name=>name.startsWith(".edit-preview-"))).toEqual([]);cleanup(f.root);}
},180000);

test("assembly preview cancellation and service close interrupt stalled authorization and leave no page or source workspace",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-dub-studio-assembly-preview-close-"))),api=new EditPreviewApi({root,job:()=>undefined,bindings:async()=>[],assemblyBindings:async()=>[]}),url="http://fixture/?historyRevision="+contentHash("assembly revision");
  try{
    const controller=new AbortController(),cancelled=api.handle(["window"],new Request(url,{signal:controller.signal}),"project","proposal",()=>new Promise(()=>{}),undefined,"assembly-proposal");void cancelled.catch(()=>{});controller.abort(new Error("assembly request cancelled"));await expect(cancelled).rejects.toThrow("assembly request cancelled");
    const held=api.handle(["window"],new Request(url),"project","accepted",()=>new Promise(()=>{}),undefined,"assembly-accepted");void held.catch(()=>{});await api.close();await expect(held).rejects.toThrow("stopped");expect(readdirSync(root)).toEqual([]);
    await expect(api.handle(["window"],new Request(url),"project","accepted",async()=>null,undefined,"assembly-accepted")).rejects.toThrow("stopped");
  }finally{await api.close();cleanup(root);}
});
