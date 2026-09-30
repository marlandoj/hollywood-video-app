import {expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";
import {validateDeliveryOutput} from "../../planner/src/delivery-jobs";
import {validatePictureQcReport} from "../../planner/src/picture-qc";
import {contentHash} from "../../generator/src/capabilities";

/**
 * HV-027-05: a creator asks a finished film for a deliverable, and gets one.
 *
 * The film here is 640x360, which is the interesting size: it can be squared and it cannot be made
 * vertical, so the offer list has to say both — with the reason for the one it refuses.
 */
test("a finished cut is offered its deliverables, makes one, and serves it",async()=>{
  const f=await dubStudio();
  try{
    const editorial=f.base+"/editorial",deliveries=f.base+"/deliveries";
    const call=(path:string,method="GET",body?:unknown)=>f.call(path,method,body,f.owner.token);
    const json=async(path:string,method="GET",body?:unknown)=>{const response=await call(path,method,body);
      const text=await response.clone().text();
      expect({path,status:response.status,text:text.includes('"error"')?text:""}).toMatchObject({path,text:""});
      return response.json() as Promise<any>;};

    // A short picture edit of the fixture film, rendered the ordinary way.
    const source=(await inspectedSource(async suffix=>await(await call(editorial+suffix)).json() as any,"/sources/"+f.film.id)).sources[0];
    const id=crypto.randomUUID(),sequence=editorial+"/sequences/"+id;
    let state=await json(editorial+"/sequences","POST",{id,label:"Deliverable cut",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],
      firstSourceId:f.film.id,width:640,height:360,expectedVersion:0});
    state=await json(sequence,"PATCH",{expectedVersion:state.libraryVersion,expectedHistoryRevision:state.sequence.history.revision,
      change:{kind:"edit",label:"Keep the first second",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-state.timeline.frames,ripple:true}}});
    const quote=await json(sequence+"/renders");
    const submitted=await json(sequence+"/renders","POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,
      historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,
      review:{...quote.review,accepted:true}});
    const film=(await f.worker())!;
    expect({status:film.status,failed:film.failureReason??null}).toEqual({status:"done",failed:null});
    expect(film.id).toBe(submitted.jobId);

    // Every kind is answered. A 640x360 master can be squared and cannot be made vertical.
    const offered=await json(deliveries+"/"+film.id);
    expect(offered.sourceJobId).toBe(film.id);
    expect(offered.outputRevision).toBe(film.output!.editorial!.revision);
    expect(offered.offers.map((offer:any)=>offer.kind+":"+offer.available).slice(0,3)).toEqual(["reframe-9:16:false","reframe-1:1:true","mezzanine:true"]);
    expect(offered.offers.find((offer:any)=>offer.kind==="grade")?.available).toBe(true);
    expect(offered.offers[0]!.reason).toContain("256-pixel minimum");
    expect(offered.offers[1]!.output).toMatchObject({width:360,height:360});
    expect(offered.offers[2]!.estimatedBytes).toBeGreaterThan(0);
    expect(offered.jobs).toEqual([]);
    // A film that is not this project's finished cut has nothing to deliver.
    expect((await call(deliveries+"/"+crypto.randomUUID())).status).toBe(404);
    expect((await call(deliveries+"/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"reframe-16:9"})).status).toBe(400);

    // Ask for the mezzanine, and let the worker make it.
    const key=crypto.randomUUID();
    const asked=await json(deliveries+"/"+film.id,"POST",{idempotencyKey:key,kind:"mezzanine"});
    // The same request key returns the same job; a different deliverable under it is refused.
    expect((await json(deliveries+"/"+film.id,"POST",{idempotencyKey:key,kind:"mezzanine"})).jobId).toBe(asked.jobId);
    expect((await call(deliveries+"/"+film.id,"POST",{idempotencyKey:key,kind:"reframe-1:1"})).status).toBe(400);
    // The same deliverable of the same sealed output is the same job, whatever request key asks for
    // it: two keys asking for one file would render it twice and retain it twice.
    expect((await json(deliveries+"/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"mezzanine"})).jobId).toBe(asked.jobId);
    const made=(await f.worker())!;
    expect({status:made.status,failed:made.failureReason??null}).toEqual({status:"done",failed:null});
    expect(made.id).toBe(asked.jobId);
    expect(made.costUsd).toBe(0);
    validateDeliveryOutput(made,made.deliveryOutput!);
    expect(made.deliveryOutput!.delivered).toMatchObject({width:640,height:360,video:"ffv1",audio:"pcm_s24le"});
    // A mezzanine is a lossless carry of the conform's picture, so it is larger than the H.264 master.
    const master=film.output!.editorial!.files.find(file=>file.path===film.output!.mp4Path)!;
    expect(made.deliveryOutput!.file.bytes).toBeGreaterThan(master.bytes);

    // HV-027-06: the deliverable was measured as part of being delivered, and the measurement is
    // kept. Four increments had built this check and nothing had ever run it on a delivered file.
    const check=made.deliveryOutput!.quality;
    expect(validatePictureQcReport(check)).toEqual(check);
    // It measured *this* file: the digest and the size the job sealed, not a report from elsewhere.
    expect(check.source).toEqual({sha256:made.deliveryOutput!.file.sha256,bytes:made.deliveryOutput!.file.bytes});
    // And it is a reading, not a placeholder: the probe and the decode both produced numbers.
    expect(check.programme).toMatchObject({width:640,height:360,video:"ffv1",audio:"pcm_s24le"});
    expect(check.programme.durationSec).toBeGreaterThan(0);
    expect(check.picture.framesSampled).toBeGreaterThan(0);
    expect(check.sound).not.toBeNull();
    expect(typeof check.sound!.maxVolumeDb).toBe("number");
    expect(check.notChecked.length).toBeGreaterThan(0);
    expect(["pass","review"]).toContain(check.verdict);
    // Every finding follows from the measurement, because the report is re-derived above; what this
    // asserts is that the two readings of the file agree, which is what the seal cross-examines.
    expect(check.programme.bytes).toBe(made.deliveryOutput!.file.bytes);

    // And the creator can fetch it, through the same guarded artifact path everything else uses.
    const listed=await json(deliveries);
    expect(listed.jobs).toHaveLength(1);
    expect(listed.jobs[0]).toMatchObject({id:made.id,kind:"mezzanine",status:"done",unavailable:null,sourceJobId:film.id});
    const url=listed.jobs[0].output.url as string;
    const fetched=await f.call(url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-disposition")).toContain("mezzanine.mkv");
    expect((await fetched.arrayBuffer()).byteLength).toBe(made.deliveryOutput!.file.bytes);
    // The token is minted for this job, so pointing it at the film's own job is not authorized at
    // all -- the request never reaches the question of whether that file exists.
    expect((await f.call(url.replace(made.id,film.id))).status).toBe(401);

    // The other renderer, on the same film: a square cut is a crop, so it keeps the master's own
    // sound and is smaller than the lossless master of the same picture.
    const squared=await json(deliveries+"/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),kind:"reframe-1:1"});
    const cut=(await f.worker())!;
    expect({status:cut.status,failed:cut.failureReason??null}).toEqual({status:"done",failed:null});
    expect(cut.id).toBe(squared.jobId);
    expect(cut.deliveryOutput!.delivered).toMatchObject({width:360,height:360,video:"h264",audio:"aac"});
    expect(cut.deliveryOutput!.file.bytes).toBeLessThan(made.deliveryOutput!.file.bytes);
    expect(cut.deliveryOutput!.file.path).toEndWith("/reframe-1x1.mp4");
    // Each deliverable carries its own measurement of its own bytes, and a report cannot be moved
    // between them: the seal binds it to the file's digest and to the shape the probe read.
    expect(cut.deliveryOutput!.quality.source.sha256).toBe(cut.deliveryOutput!.file.sha256);
    expect(cut.deliveryOutput!.quality.source.sha256).not.toBe(made.deliveryOutput!.quality.source.sha256);
    expect(cut.deliveryOutput!.quality.programme).toMatchObject({width:360,height:360,video:"h264",audio:"aac"});
    // Re-hashed, so the revision check cannot answer for the quality check: even a consistently
    // sealed output carrying another deliverable's reading is refused.
    const resealed=(quality:NonNullable<typeof cut.deliveryOutput>["quality"])=>{
      const {revision:_ignored,...rest}={...cut.deliveryOutput!,quality};return {...rest,revision:contentHash(rest)};};
    expect(()=>validateDeliveryOutput(cut,resealed(made.deliveryOutput!.quality))).toThrow("measured different bytes");
    // And a verdict edited under its own measurement is refused by re-derivation, not by a hash.
    expect(()=>validateDeliveryOutput(cut,resealed({...cut.deliveryOutput!.quality,
      verdict:cut.deliveryOutput!.quality.verdict==="pass"?"review":"pass"}))).toThrow("not a reading of its own file");
    // Both deliverables of one film sit beside it, each under its own job.
    const both=await json(deliveries);
    expect(both.jobs.map((job:any)=>job.kind).sort()).toEqual(["mezzanine","reframe-1:1"]);
    // The creator is shown the verdict and the findings, and told what nobody looked at. The
    // measurement itself stays in the retained report: this is "should you look at this file",
    // not the operator's own reading of it.
    for(const view of both.jobs){
      expect(["pass","review"]).toContain(view.output.quality.verdict);
      expect(view.output.quality.notChecked.length).toBeGreaterThan(0);
      for(const finding of view.output.quality.findings)
        expect(Object.keys(finding).sort()).toEqual(["code","message","severity"]);
      expect(view.output.quality.programme).toBeUndefined();
      expect(view.output.quality.source).toBeUndefined();
    }
    const mezzanineView=both.jobs.find((job:any)=>job.kind==="mezzanine");
    expect(mezzanineView.output.quality.verdict).toBe(made.deliveryOutput!.quality.verdict);
    expect(mezzanineView.output.quality.findings.map((finding:any)=>finding.code))
      .toEqual(made.deliveryOutput!.quality.findings.map(finding=>finding.code));
    expect(new Set(both.jobs.map((job:any)=>job.sourceOutputRevision))).toEqual(new Set([film.output!.editorial!.revision]));
    // And the film's own offer list now shows what has already been made of it.
    expect((await json(deliveries+"/"+film.id)).jobs).toHaveLength(2);
  }finally{await f.close();}
},300_000);
