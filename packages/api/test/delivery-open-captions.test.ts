/**
 * HV-027-15 — a finished film delivered with its own captions burned into the picture.
 *
 * Release 2's delivery slice is "9:16 and 1:1 reframes, burned subtitles, SDH, mezzanine". The
 * reframes and the mezzanine were built; a film could not be delivered with its captions in the
 * picture, which is what a feed that autoplays without sound, or a platform that drops sidecar files,
 * needs. The captions burned here are the film's own sealed `conform/captions.vtt`, the same bytes the
 * cut was completed with, into the master's frame or a reframe of it.
 */
import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";
import {validateDeliveryOutput} from "../../planner/src/delivery-jobs";
import {contentHash} from "../../generator/src/capabilities";

/** One decoded frame of a delivered file, as 8-bit luma. */
async function luma(path:string,frame:number,width:number,height:number,directory:string):Promise<Uint8Array>{
  const out=join(directory,"frame-"+frame+"-"+contentHash(path).slice(0,8)+".raw");
  const child=Bun.spawn(["ffmpeg","-v","error","-nostdin","-i",path,"-vf","select=eq(n\\,"+frame+")","-fps_mode","passthrough","-frames:v","1",
    "-f","rawvideo","-pix_fmt","gray","-y",out],{stdin:"ignore",stdout:"ignore",stderr:"pipe"});
  const log=await new Response(child.stderr).text();
  expect({code:await child.exited,log}).toEqual({code:0,log:""});
  const bytes=new Uint8Array(readFileSync(out));
  expect(bytes.length).toBe(width*height);
  return bytes;
}
/** Mean absolute difference of two frames over a band of rows. */
const difference=(a:Uint8Array,b:Uint8Array,width:number,from:number,to:number)=>{
  let sum=0;for(let index=from*width;index<to*width;index++)sum+=Math.abs(a[index]!-b[index]!);return sum/((to-from)*width);};

test("a finished film is offered, burned and served with its own captions in the picture, and the burn is terminal",async()=>{
  const f=await dubStudio(),scratch=mkdtempSync(join(tmpdir(),"hv-open-captions-"));
  try{
    const editorial=f.base+"/editorial",deliveries=f.base+"/deliveries";
    const call=(path:string,method="GET",body?:unknown)=>f.call(path,method,body,f.owner.token);
    const json=async(path:string,method="GET",body?:unknown)=>{const response=await call(path,method,body);const text=await response.text();
      if(!response.ok)throw new Error(path+" "+response.status+" "+text);return JSON.parse(text);};
    const source=(await inspectedSource(async suffix=>await(await call(editorial+suffix)).json() as any,"/sources/"+f.film.id)).sources[0];
    const id=crypto.randomUUID(),sequence=editorial+"/sequences/"+id;
    const state=await json(editorial+"/sequences","POST",{id,label:"Captioned cut",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],
      firstSourceId:f.film.id,width:640,height:360,expectedVersion:0});
    const quote=await json(sequence+"/renders");
    await json(sequence+"/renders","POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,
      sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}});
    const film=(await f.worker())!;
    expect({status:film.status,failed:film.failureReason??null}).toEqual({status:"done",failed:null});
    const sealedCaptions=film.output!.editorial!.files.find(file=>file.path.endsWith("/conform/captions.vtt"))!;
    expect(readFileSync(join(f.paths.artifactRoot,sealedCaptions.path),"utf8")).toContain("SPUD: Welcome to the garden.");

    // 1. Every burned kind is answered, with the frame it burns into and how many cues it burns; the
    //    one this 640x360 master cannot carry says why.
    const offered=await json(deliveries+"/"+film.id);
    const burnedOffers=offered.offers.filter((offer:any)=>offer.kind.startsWith("open-captions"));
    expect(burnedOffers.map((offer:any)=>offer.kind+":"+offer.available)).toEqual(["open-captions:true","open-captions-9:16:false","open-captions-1:1:true"]);
    expect(burnedOffers[0].output).toEqual({width:640,height:360,estimatedBytes:null,captionCues:2});
    expect(burnedOffers[1].reason).toContain("256-pixel minimum");
    expect(burnedOffers[2].output).toEqual({width:360,height:360,estimatedBytes:null,captionCues:2});

    // 2. Asked for, made at no cost, and the same deliverable under another key is the same job.
    const key=crypto.randomUUID();
    const asked=await json(deliveries+"/"+film.id,"POST",{idempotencyKey:key,kind:"open-captions-1:1"});
    expect((await json(deliveries+"/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"open-captions-1:1"})).jobId).toBe(asked.jobId);
    expect((await call(deliveries+"/"+film.id,"POST",{idempotencyKey:key,kind:"open-captions"})).status).toBe(400);
    const burned=(await f.worker())!;
    expect({id:burned.id,status:burned.status,failed:burned.failureReason??null,cost:burned.costUsd}).toEqual({id:asked.jobId,status:"done",failed:null,cost:0});
    const output=burned.deliveryOutput!;
    validateDeliveryOutput(burned,output);
    expect(output.file.path).toEndWith("/open-captions-1x1.mp4");
    expect(output.delivered).toMatchObject({width:360,height:360,video:"h264",audio:"aac"});
    // The burn measured its own caption layer: both cues drew ink, inside the frame.
    expect(output.captions).toMatchObject({captionsSha256:sealedCaptions.sha256,cues:2,betweenFrames:0,frame:{width:360,height:360}});
    expect(output.captions!.sampled.map(sample=>sample.cue)).toEqual([0,1]);
    for(const sample of output.captions!.sampled){
      expect(sample.ink).toBeGreaterThan(50);
      expect(sample.box.x0).toBeGreaterThan(0);expect(sample.box.x1).toBeLessThan(359);
      // Bottom-centred: the caption sits in the lower third of the frame.
      expect(sample.box.y0).toBeGreaterThan(240);
    }

    // 3. The captions are in the delivered picture, not beside it. The plain 1:1 reframe of the same
    //    film is the same crop and the same encode without them: inside the caption's band the two
    //    differ, above it they agree, and after the last cue the frames agree everywhere.
    await json(deliveries+"/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"reframe-1:1"});
    const plain=(await f.worker())!;
    expect(plain.status).toBe("done");
    const burnedFile=join(f.paths.artifactRoot,output.file.path),plainFile=join(f.paths.artifactRoot,plain.deliveryOutput!.file.path);
    for(const sample of output.captions!.sampled){
      const [withCaptions,without]=[await luma(burnedFile,sample.frame,360,360,scratch),await luma(plainFile,sample.frame,360,360,scratch)];
      expect(difference(withCaptions,without,360,sample.box.y0,sample.box.y1+1)).toBeGreaterThan(10);
      expect(difference(withCaptions,without,360,0,sample.box.y0-8)).toBeLessThan(2);
    }
    const after=120;
    expect(difference(await luma(burnedFile,after,360,360,scratch),await luma(plainFile,after,360,360,scratch),360,0,360)).toBeLessThan(2);

    // 4. The master's own frame is a burned kind too, laid out for 640x360.
    await json(deliveries+"/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"open-captions"});
    const wide=(await f.worker())!;
    expect({status:wide.status,failed:wide.failureReason??null}).toEqual({status:"done",failed:null});
    expect(wide.deliveryOutput!.delivered).toMatchObject({width:640,height:360,video:"h264",audio:"aac"});
    expect(wide.deliveryOutput!.file.path).toEndWith("/open-captions.mp4");
    expect(wide.deliveryOutput!.captions!.sampled.every(sample=>sample.box.x1<639)).toBe(true);

    // 5. Listed and served like every other deliverable, with what the burn measured.
    const listed=(await json(deliveries)).jobs.find((job:any)=>job.id===burned.id);
    expect(listed).toMatchObject({kind:"open-captions-1:1",status:"done",unavailable:null,sourceJobId:film.id});
    expect(listed.output.captions).toEqual({cues:2,checked:2,betweenFrames:0});
    const fetched=await f.call(listed.output.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-disposition")).toContain("open-captions-1x1.mp4");
    expect((await fetched.arrayBuffer()).byteLength).toBe(output.file.bytes);

    // 6. A burned deliverable is terminal: its captions cannot be taken out, so nothing may edit it
    //    or deliver from it.
    expect((await call(deliveries+"/"+burned.id)).status).toBe(404);
    const inspection=await call(editorial+"/sources/"+burned.id);
    expect({status:inspection.status,body:await inspection.json()}).toEqual({status:400,body:{error:"Choose a completed retained film, dialogue, lip-sync, sound or graphic version."}});
    const asSource=await call(editorial+"/sequences","POST",{id:crypto.randomUUID(),label:"Re-edit the burned cut",
      sources:[{jobId:burned.id,sourceRevision:"a".repeat(64)}],firstSourceId:burned.id,width:360,height:360,expectedVersion:state.libraryVersion});
    expect({status:asSource.status,body:await asSource.json()}).toEqual({status:400,body:{error:"Choose a completed retained film, dialogue, lip-sync, sound or graphic version."}});

    // 7. The retained check is re-read, not believed.
    const resealed=(change:(value:typeof output)=>Record<string,unknown>)=>{
      const {revision:_ignored,...rest}=change(structuredClone(output)) as unknown as typeof output;return {...rest,revision:contentHash(rest)} as typeof output;};
    expect(()=>validateDeliveryOutput(burned,resealed(({captions:_dropped,...rest})=>rest))).toThrow("keeps the check of its own caption layer");
    expect(()=>validateDeliveryOutput(burned,resealed(value=>({...value,captions:{...value.captions!,captionsSha256:"f".repeat(64)}}))))
      .toThrow("a different caption track");
    expect(()=>validateDeliveryOutput(burned,resealed(value=>({...value,captions:{...value.captions!,
      sampled:value.captions!.sampled.map(sample=>({...sample,box:{...sample.box,x1:359}}))}})))).toThrow("runs off the edge");
    expect(()=>validateDeliveryOutput(burned,resealed(value=>({...value,captions:{...value.captions!,
      sampled:value.captions!.sampled.map(sample=>({...sample,ink:0}))}})))).toThrow("left no ink");
    expect(()=>validateDeliveryOutput(burned,resealed(value=>({...value,captions:{...value.captions!,sampled:value.captions!.sampled.slice(1)}}))))
      .toThrow("sampled 1 of 2");
    // And a deliverable with no captions in its picture cannot claim a caption check.
    const plainOutput=plain.deliveryOutput!,{revision:_plain,...plainRest}={...plainOutput,captions:output.captions};
    expect(()=>validateDeliveryOutput(plain,{...plainRest,revision:contentHash(plainRest)} as typeof plainOutput)).toThrow("Only a burned deliverable");
  }finally{await f.close();rmSync(scratch,{recursive:true,force:true});}
},300_000);
