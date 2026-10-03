import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {readFileSync,readdirSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";
import {EditInterchangeApi} from "../src/edit-interchange-api";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";
import {otioAsEvents,readEdl,readOtio} from "../../../test/fixtures/interchange-readers";

test("the owner downloads the saved cut as OTIO and as a CMX 3600 EDL, both read back to the same shots and frames, and nobody else can",async()=>{
  const f=await dubStudio();
  try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown,token:string|undefined=f.owner.token)=>f.call(base+path,method,body,token);
    const inspected=(await inspectedSource(async path=>await(await call(path)).json() as any,"/sources/"+f.film.id)).sources[0],id=crypto.randomUUID(),route="/sequences/"+id;
    const created=await call("/sequences","POST",{id,label:"Garden — reel 1",sources:[{jobId:f.film.id,sourceRevision:inspected.sourceRevision}],firstSourceId:f.film.id,width:320,height:180,expectedVersion:0});expect(created.status).toBe(201);let state=await created.json() as any;
    const edit=async(label:string,operation:unknown)=>{const response=await call(route,"PATCH",{expectedVersion:state.libraryVersion,expectedHistoryRevision:state.sequence.history.revision,change:{kind:"edit",label,operation}});expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(200);state=await response.json();};
    // Three shots of the retained film: two splits, a ripple trim at each end of the cut, and a centred 8-frame dissolve.
    const N=state.timeline.frames as number,P1=Math.floor(N/3),P2=Math.floor(2*N/3),linked=(link:string)=>state.timeline.clips.filter((c:any)=>c.link===link),ids=(link:string,prefix:string)=>Object.fromEntries(linked(link).map((c:any)=>[c.id,prefix+c.lane]));
    expect(N).toBeGreaterThan(60);expect(linked("initial").some((c:any)=>c.lane==="picture")).toBe(true);
    const picture=(link:string)=>linked(link).find((c:any)=>c.lane==="picture").id as string;
    await edit("Split A|B",{kind:"split",clipId:picture("initial"),linked:true,at:P1,rightIds:ids("initial","b-"),rightLink:"b"});
    await edit("Split B|C",{kind:"split",clipId:"b-picture",linked:true,at:P2,rightIds:ids("b","c-"),rightLink:"c"});
    await edit("Trim B head",{kind:"trim",clipId:"b-picture",linked:true,edge:"in",delta:6,ripple:true});
    await edit("Trim C tail",{kind:"trim",clipId:"c-picture",linked:true,edge:"out",delta:-6,ripple:true});
    const dissolveIds=Object.fromEntries(linked("initial").filter((c:any)=>c.lane!=="captions").map((c:any)=>[c.id,"x-"+c.lane]));
    await edit("Dissolve A to B",{kind:"crossfade",leftId:picture("initial"),rightId:"b-picture",linked:true,frames:8,alignment:"center",ids:dissolveIds});
    expect(state.timeline.frames).toBe(N-12);
    const film=f.film.id,history=state.sequence.history.revision as string,path=(format:string)=>route+"/interchange/"+format+"?historyRevision="+history;
    const queueBefore=readFileSync(f.paths.queuePath,"utf8"),artifactsBefore=readdirSync(f.paths.artifactRoot).sort();
    const download=async(format:string)=>{const response=await call(path(format));const text=await response.text();expect(text).not.toContain('"error"');expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe("attachment; filename=\""+id+"."+format+"\"");expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-hv-interchange-sha256")).toBe(createHash("sha256").update(text).digest("hex"));return text;};
    const otioText=await download("otio"),edlText=await download("edl");
    const label=state.timeline.sources[0].label as string;
    // Worked from the edits above, not from the exporter.
    const hard=[
      {name:label,jobId:film,clipId:picture("initial"),sourceIn:0,sourceOut:P1,recordIn:0,recordOut:P1,dissolveIn:null},
      {name:label,jobId:film,clipId:"b-picture",sourceIn:P1+6,sourceOut:P2,recordIn:P1,recordOut:P2-6,dissolveIn:{before:4,after:4}},
      {name:label,jobId:film,clipId:"c-picture",sourceIn:P2,sourceOut:N-6,recordIn:P2-6,recordOut:N-12,dissolveIn:null},
    ];
    const otio=readOtio(otioText),edl=readEdl(edlText);
    expect(otio.name).toBe("Garden — reel 1");expect(otio.tracks).toHaveLength(1);expect(otio.tracks[0]!.frames).toBe(N-12);expect(otio.tracks[0]!.clips).toEqual(hard);
    expect(otio.metadata).toMatchObject({hv:{sequenceId:id,historyRevision:history,timelineRevision:state.timeline.revision}});
    expect(edl.title).toBe("Garden — reel 1");expect(edl.fcm).toBe("NON-DROP FRAME");
    expect(edl.events).toEqual([
      {jobId:film,sourceIn:0,sourceOut:P1-4,recordIn:0,recordOut:P1-4,dissolve:null},
      {jobId:film,sourceIn:P1+2,sourceOut:P2,recordIn:P1-4,recordOut:P2-6,dissolve:8},
      {jobId:film,sourceIn:P2,sourceOut:N-6,recordIn:P2-6,recordOut:N-12,dissolve:null},
    ]);
    expect(otioAsEvents(otio.tracks[0]!)).toEqual(edl.events);
    // The studio's own ids name the media: no token, signed link, storage path or expiry leaves in either file.
    for(const text of [otioText,edlText]){expect(text).toContain("urn:hv:job:"+film);expect(text).not.toContain(f.owner.token);expect(text).not.toContain(f.paths.artifactRoot);expect(text).not.toMatch(/:\/\/|token|signature|x-amz|expires|\.mp4|\.wav|\.m3u8/i);}
    expect(readFileSync(f.paths.queuePath,"utf8")).toBe(queueBefore);expect(readdirSync(f.paths.artifactRoot).sort()).toEqual(artifactsBefore);expect(f.ledger.monthSpend()).toBe(0);
    // Unauthorised callers are refused before anything is written.
    expect((await call(path("otio"),"GET",undefined,"")).status).toBe(401);
    const other=await(await f.call("/api/projects","POST")).json() as any;for(const format of ["otio","edl"])expect([401,403,404]).toContain((await call(path(format),"GET",undefined,other.token)).status);
    const elsewhere=await f.call("/api/projects/"+other.projectId+"/editorial"+path("edl"),"GET",undefined,f.owner.token);expect([401,403,404]).toContain(elsewhere.status);expect(await elsewhere.text()).not.toContain("HV01");
    for(const bad of [route+"/interchange/otio",route+"/interchange/aaf?historyRevision="+history,path("edl")+"&format=otio",route+"/interchange/edl?historyRevision="+contentHash("stale")]){const response=await call(bad);expect(response.status).toBe(400);expect(await response.text()).not.toContain("HV01");}
    expect((await call(route+"/interchange/otio/extra?historyRevision="+history)).status).toBe(404);
    // A withdrawn permission stops the export, as it stops every other read of the cut.
    expect(f.projects.revokeCharacterPermission(f.owner.token,f.id,1)).not.toBeNull();const withdrawn=await call(path("edl"));expect(withdrawn.status).toBe(400);const refusal=await withdrawn.text();expect(refusal).toContain("not permitted");expect(refusal).not.toContain("HV01");
  }finally{await f.close();}
},180000);

test("interchange export is bounded to two at once and releases stalled reads on cancel and close",async()=>{
  let bindingCalls=0;const api=new EditInterchangeApi({job:()=>undefined,bindings:async()=>{bindingCalls++;return [];}}),url="http://fixture/?historyRevision="+contentHash("saved"),refresh=()=>new Promise<never>(()=>{});
  try{
    const controller=new AbortController(),first=api.handle(new Request(url,{signal:controller.signal}),"project","sequence","otio",refresh);void first.catch(()=>{});const second=api.handle(new Request(url),"project","sequence","edl",refresh);void second.catch(()=>{});
    await expect(api.handle(new Request(url),"project","sequence","otio",refresh)).rejects.toThrow("busy");controller.abort(new Error("cancel export"));await expect(first).rejects.toThrow("cancel export");
    await expect(api.handle(new Request(url),"project","sequence","fcpxml",refresh)).rejects.toThrow("Choose otio or edl");
    const third=api.handle(new Request(url),"project","sequence","edl",refresh);void third.catch(()=>{});await api.close();await expect(second).rejects.toThrow("stopped");await expect(third).rejects.toThrow("stopped");expect(bindingCalls).toBe(0);
  }finally{await api.close();}
});
