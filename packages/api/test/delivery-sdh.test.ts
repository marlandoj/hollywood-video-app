/**
 * HV-027-16 — a finished film delivered with a track for the deaf and hard of hearing.
 *
 * The film here is the fixture's dubbed scene with a reviewed sound session laid under it (two
 * seconds of "Garden birdsong", looped, from one second in), cut in a picture edit. Its SDH track
 * must carry the film's own two lines with their speaker, and the birdsong where the cut plays it,
 * named by the label the creator gave the recording -- and nothing the pipeline does not know.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";
import {soundCue,soundFixture,SOUND_RIGHTS} from "../../../test/fixtures/sound";
import {validateDeliveryOutput} from "../../planner/src/delivery-jobs";
import {parseSdhReadBack} from "../../generator/src/delivery-sdh";
import {contentHash} from "../../generator/src/capabilities";

test("a finished film with placed sounds is offered and delivered an SDH track of its own lines and sounds, read back from the file",async()=>{
  const f=await dubStudio();
  try{
    const editorial=f.base+"/editorial",deliveries=f.base+"/deliveries";
    const call=(path:string,method="GET",body?:unknown)=>f.call(path,method,body,f.owner.token);
    const json=async(path:string,method="GET",body?:unknown)=>{const response=await call(path,method,body);const text=await response.text();
      if(!response.ok)throw new Error(path+" "+response.status+" "+text);return JSON.parse(text);};

    // A recording the creator uploads and names, laid under the film in a reviewed sound session.
    const sound=soundFixture(f.owner.projectId,48000,50000,100000);
    const uploaded=await fetch(new URL(f.base+"/sounds",f.server.url),{method:"POST",headers:{authorization:"Bearer "+f.owner.token,"content-type":"audio/wav",
      "x-hv-sound-record":encodeURIComponent(JSON.stringify({label:"Garden birdsong",rights:SOUND_RIGHTS,expectedVersion:0}))},body:new Uint8Array(sound.wav)});
    expect(uploaded.status).toBe(201);
    const {asset}=await uploaded.json() as any;
    const quote=await json(f.base+"/sound-mixes/"+f.film.id);
    const {asset:_asset,...settings}=soundCue(asset);
    await json(f.base+"/sound-mixes/"+f.film.id,"POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:quote.sourceRevision,engineVersion:quote.engineVersion,
      session:{reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[{...settings,assetId:asset.id,assetRevision:asset.revision,role:"ambience",start:48000,frames:96000,loop:true,gainDb:-6}]}});
    const mixed=(await f.worker())!;
    expect({status:mixed.status,failed:mixed.failureReason??null}).toEqual({status:"done",failed:null});

    // The mixed film, cut in a picture edit and rendered.
    const source=(await inspectedSource(async suffix=>await(await call(editorial+suffix)).json() as any,"/sources/"+mixed.id)).sources[0];
    const id=crypto.randomUUID(),sequence=editorial+"/sequences/"+id;
    const state=await json(editorial+"/sequences","POST",{id,label:"SDH cut",sources:[{jobId:mixed.id,sourceRevision:source.sourceRevision}],
      firstSourceId:mixed.id,width:640,height:360,expectedVersion:0});
    const renders=await json(sequence+"/renders");
    await json(sequence+"/renders","POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:renders.sequence.historyRevision,
      sourceBindingsRevision:renders.sourceBindingsRevision,engineVersion:renders.engineVersion,review:{...renders.review,accepted:true}});
    const film=(await f.worker())!;
    expect({status:film.status,failed:film.failureReason??null}).toEqual({status:"done",failed:null});

    // 1. Offered with the lines and the sounds it will carry.
    const offered=await json(deliveries+"/"+film.id);
    const offer=offered.offers.find((value:any)=>value.kind==="sdh");
    expect(offer).toEqual({kind:"sdh",available:true,reason:null,estimatedBytes:null,
      output:{width:640,height:360,estimatedBytes:null,captionCues:2,soundCues:1}});

    // 2. Asked for, made at no cost, and the same deliverable under another key is the same job.
    const key=crypto.randomUUID();
    const asked=await json(deliveries+"/"+film.id,"POST",{idempotencyKey:key,kind:"sdh"});
    expect((await json(deliveries+"/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"sdh"})).jobId).toBe(asked.jobId);
    expect((await call(deliveries+"/"+film.id,"POST",{idempotencyKey:key,kind:"open-captions"})).status).toBe(400);
    const made=(await f.worker())!;
    expect({id:made.id,status:made.status,failed:made.failureReason??null,cost:made.costUsd}).toEqual({id:asked.jobId,status:"done",failed:null,cost:0});
    const output=made.deliveryOutput!;
    validateDeliveryOutput(made,output);
    expect(output.file.path).toEndWith("/sdh.mp4");
    expect(output.delivered).toMatchObject({width:640,height:360,video:"h264",audio:"aac"});
    expect(output.sdh).toMatchObject({dialogue:2,sounds:1,track:{codec:"mov_text",hearingImpaired:true,handler:"SDH"}});
    // The picture and sound are the master's own packets, and the track read back as it was written.
    expect(output.sdh!.deliveredStreams).toBe(output.sdh!.masterStreams);
    expect(output.sdh!.readBackSha256).toBe(output.sdh!.segmentsSha256);

    // 3. What the track says, read out of the delivered file independently of the render: the two
    //    lines with their speaker, as the film's own captions have them, and the birdsong from one
    //    second to three, under both, by its own label.
    const back=join(f.root,"sdh-back.srt");
    const child=Bun.spawn(["ffmpeg","-v","error","-i",join(f.paths.artifactRoot,output.file.path),"-map","0:s:0","-f","srt","-y",back],{stdin:"ignore",stdout:"ignore",stderr:"pipe"});
    expect(await child.exited).toBe(0);
    expect(parseSdhReadBack(readFileSync(back,"utf8"))).toEqual([
      {startMs:0,endMs:1000,text:"SPUD: Welcome to the garden."},
      {startMs:1000,endMs:1172,text:"SPUD: Welcome to the garden.\n[ambience: Garden birdsong]"},
      {startMs:1172,endMs:1372,text:"[ambience: Garden birdsong]"},
      {startMs:1372,endMs:2751,text:"[ambience: Garden birdsong]\nSPUD: Come inside, friend."},
      {startMs:2751,endMs:3000,text:"[ambience: Garden birdsong]"}]);
    expect(output.sdh!.segments).toBe(5);

    // 4. Listed and served like every other deliverable, with what the track holds.
    const listed=(await json(deliveries)).jobs.find((job:any)=>job.id===made.id);
    expect(listed).toMatchObject({kind:"sdh",status:"done",unavailable:null,sourceJobId:film.id});
    expect(listed.output.sdh).toEqual({dialogue:2,sounds:1,segments:5});
    const fetched=await f.call(listed.output.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-disposition")).toContain("sdh.mp4");
    expect((await fetched.arrayBuffer()).byteLength).toBe(output.file.bytes);

    // 5. A deliverable is terminal: nothing edits it or delivers from it.
    expect((await call(deliveries+"/"+made.id)).status).toBe(404);
    const asSource=await call(editorial+"/sequences","POST",{id:crypto.randomUUID(),label:"Re-edit the SDH master",
      sources:[{jobId:made.id,sourceRevision:"a".repeat(64)}],firstSourceId:made.id,width:640,height:360,expectedVersion:state.libraryVersion});
    expect(asSource.status).toBe(400);

    // 6. The retained proof is re-read, not believed.
    const resealed=(change:(value:typeof output)=>unknown)=>{
      const {revision:_ignored,...rest}=change(structuredClone(output)) as typeof output;return {...rest,revision:contentHash(rest)} as typeof output;};
    expect(()=>validateDeliveryOutput(made,resealed(({sdh:_dropped,...rest})=>rest))).toThrow("keeps the check of its own track");
    expect(()=>validateDeliveryOutput(made,resealed(value=>({...value,sdh:{...value.sdh!,readBackSha256:"f".repeat(64)}})))).toThrow("does not read back");
    expect(()=>validateDeliveryOutput(made,resealed(value=>({...value,sdh:{...value.sdh!,deliveredStreams:"f".repeat(64)}})))).toThrow("not the master's own");
  }finally{await f.close();}
},300_000);
