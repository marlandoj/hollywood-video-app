import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {DELIVERY_KINDS,deliveryBinding,deliveryBindingFor,deliveryConformDirectory,deliveryFileName,deliveryJobPlan,deliveryOffers,
  validateDeliveryBinding,validateDeliveryPlan,type DeliveryBinding,type DeliveryFile} from "../src/delivery-jobs";

const PROJECT="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",JOB="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PREFIX="projects-are-not-here/",ROOT=PROJECT+"/"+JOB+"/export/conform";
const MASTER=ROOT+"/export.mp4",PARTS=15;
const digest=(seed:string)=>seed.repeat(64).slice(0,64);
const at=(path:string,bytes:number):DeliveryFile=>({path,sha256:contentHash(path),bytes});
const conformFiles=(frames:number,partBytes:number,root=ROOT):DeliveryFile[]=>[
  at(root+"/export.mp4",4_000_000),at(root+"/picture/index.ffconcat",512),at(root+"/audio/final.wav",44+frames*1600*6),
  ...Array.from({length:PARTS},(_,index)=>at(root+"/picture/part-"+String(index).padStart(5,"0")+".mkv",partBytes))];
const conform=(width:number,height:number,frames:number,partBytes=60_000_000)=>({width,height,frames,
  pictureFramesSha256:digest("c"),pictureBytes:PARTS*partBytes,mixBytes:44+frames*1600*6});
const binding=(overrides:Partial<Omit<DeliveryBinding,"schema"|"revision">>={},width=1920,height=1080,frames=900,partBytes=60_000_000)=>deliveryBinding({
  storage:"s3",source:{projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision:digest("d")},
  master:at(MASTER,4_000_000),files:conformFiles(frames,partBytes),conform:conform(width,height,frames,partBytes),...overrides});
/** HV-027-15: the same film with its sealed caption track named, so the burned kinds can be planned. */
const CAPTIONS=at(ROOT+"/captions.vtt",180);
const captioned=(width=1920,height=1080,frames=900,partBytes=60_000_000)=>binding({files:[...conformFiles(frames,partBytes),CAPTIONS],captions:{...CAPTIONS,cues:3}},width,height,frames,partBytes);

test("a deliverable is bound to the bytes of the film, not to the render that made them",()=>{
  const made=binding();
  expect(validateDeliveryBinding(made)).toEqual(made);
  expect(made.revision).toBe(binding().revision);
  expect(made.files).toHaveLength(PARTS+3);
  // Named rather than discovered: nothing in this studio enumerates another job's artifacts under s3.
  expect(made.files.map(file=>file.path)).toEqual([...made.files].map(file=>file.path).sort((a,b)=>a.localeCompare(b,"en-US")));
  expect(made.storage).toBe("s3");
  // The conform directory is derived from the master's own path: two fields that must agree are two
  // fields that can disagree.
  expect(deliveryConformDirectory(made.master.path)).toBe(ROOT);

  // The same deliverable of the same sealed output is the same job, whichever render produced it...
  const other="cccccccc-3333-4333-8333-cccccccccccc",otherRoot=PROJECT+"/"+other+"/export/conform";
  const elsewhere=deliveryBinding({storage:"s3",source:{projectId:PROJECT,jobId:other,stage:"assembly-edit",outputRevision:digest("d")},
    master:at(otherRoot+"/export.mp4",4_000_000),files:conformFiles(900,60_000_000,otherRoot),conform:conform(1920,1080,900)});
  expect(deliveryJobPlan(elsewhere,"mezzanine").idempotencyKey).toBe(deliveryJobPlan(made,"mezzanine").idempotencyKey);
  // ...and a film rendered again is a different film to deliver.
  const rerendered=binding({source:{...made.source,outputRevision:digest("f")}});
  expect(deliveryJobPlan(rerendered,"mezzanine").idempotencyKey).not.toBe(deliveryJobPlan(made,"mezzanine").idempotencyKey);
  expect(rerendered.revision).not.toBe(made.revision);
  // Each kind is its own job.
  expect(new Set(DELIVERY_KINDS.map(kind=>deliveryJobPlan(captioned(),kind).idempotencyKey)).size).toBe(DELIVERY_KINDS.length);
});

test("every kind is answered, including the ones this master cannot make",()=>{
  const hd=deliveryOffers(captioned());
  expect(hd.map(offer=>offer.kind)).toEqual([...DELIVERY_KINDS]);
  expect(hd.every(offer=>offer.available&&offer.plan&&!offer.reason)).toBe(true);
  expect(hd[0]!.plan!.reframe!.output).toEqual({width:608,height:1080});
  expect(hd[1]!.plan!.reframe!.output).toEqual({width:1080,height:1080});
  expect(hd[2]!.plan!.mezzanine!.output.frames).toBe(900);
  expect(hd.map(offer=>deliveryFileName(offer.plan!))).toEqual(["reframe-9x16.mp4","reframe-1x1.mp4","mezzanine.mkv",
    "open-captions.mp4","open-captions-9x16.mp4","open-captions-1x1.mp4"]);

  // A 640x360 master can be squared and cannot be made vertical, and the creator is told which and
  // why rather than shown a shorter list.
  const small=deliveryOffers(captioned(640,360,900));
  expect(small.map(offer=>offer.kind+":"+offer.available)).toEqual(["reframe-9:16:false","reframe-1:1:true","mezzanine:true",
    "open-captions:true","open-captions-9:16:false","open-captions-1:1:true"]);
  expect(small[0]!.reason).toContain("202 by 360");
  expect(small[0]!.reason).toContain("256-pixel minimum");
  expect(small[0]!.plan).toBeUndefined();
  expect(small[1]!.plan!.reframe!.output).toEqual({width:360,height:360});
  // A film too long for a lossless master of itself loses only the mezzanine.
  const long=deliveryOffers(captioned(1920,1080,108000,2*1024**3));
  expect(long.map(offer=>offer.kind+":"+offer.available)).toEqual(["reframe-9:16:true","reframe-1:1:true","mezzanine:false",
    "open-captions:true","open-captions-9:16:true","open-captions-1:1:true"]);
  expect(long[2]!.reason).toContain("does not fit beside it");
});

test("a binding is refused when it does not describe a film this studio made",()=>{
  const files=conformFiles(900,60_000_000);
  expect(()=>binding({storage:"tape" as never})).toThrow("configured storage backend");
  expect(()=>binding({source:{projectId:"not-a-uuid",jobId:JOB,stage:"picture-edit",outputRevision:digest("d")}})).toThrow("project and job");
  expect(()=>binding({source:{projectId:PROJECT,jobId:JOB,stage:"sound-mix" as never,outputRevision:digest("d")}})).toThrow("picture edit or an assembly");
  expect(()=>binding({source:{projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision:"short"}})).toThrow("sealed output revision");
  expect(()=>binding({master:{...at(MASTER,1),sha256:"bad"}})).toThrow("bytes and their digest");
  // Every conform writes its export to conform/export.mp4. A master elsewhere is not one of ours.
  expect(()=>binding({master:at(PROJECT+"/"+JOB+"/export/final.mp4",1)})).toThrow("conform/export.mp4");
  // A deliverable reads from inside the film's own job and nowhere else.
  expect(()=>binding({files:[...files,at(PREFIX+"elsewhere.mkv",1)]})).toThrow("inside the film's own job");
  expect(()=>binding({files:[...files,files[0]!]})).toThrow("names each file it reads once");
  // The three files a renderer cannot do without are named by what they are.
  expect(()=>binding({files:files.filter(file=>!file.path.endsWith("index.ffconcat"))})).toThrow("picture master's index");
  expect(()=>binding({files:files.filter(file=>!file.path.endsWith("final.wav"))})).toThrow("final mix");
  expect(()=>binding({files:files.filter(file=>!file.path.includes("part-"))})).toThrow("no retained parts");
  // The inventory is checked against arithmetic the conform cannot disagree with.
  expect(()=>binding({files:files.map(file=>file.path.endsWith("final.wav")?{...file,bytes:file.bytes+6}:file)})).toThrow("frames of its sound is");
  expect(()=>binding({files:files.map(file=>file.path.includes("part-")?{...file,bytes:file.bytes+1}:file)})).toThrow("the conform recorded");
  // A conform whose own record does not add up cannot be bound to at all, whichever deliverable is
  // being asked for -- the check belongs to the conform, not to the mezzanine.
  expect(()=>binding({conform:{...conform(1920,1080,900),mixBytes:100}})).toThrow("do not agree");
  expect(()=>binding({conform:{...conform(1920,1080,900),pictureFramesSha256:"nope"}})).toThrow("recorded picture frame hashes");

  const made=binding();
  expect(()=>validateDeliveryBinding({...made,master:{...made.master,bytes:made.master.bytes+1}})).toThrow("named twice with different bytes");
  expect(()=>validateDeliveryBinding({...made,storage:"local"})).toThrow("does not match the film it names");
  expect(()=>deliveryJobPlan(made,"reframe-4:3" as never)).toThrow("a deliverable this studio makes");
  const plan=deliveryJobPlan(made,"mezzanine");
  expect(validateDeliveryPlan(plan)).toEqual(plan);
  expect(()=>validateDeliveryPlan({...plan,idempotencyKey:contentHash("elsewhere")})).toThrow("does not match the film it names");
  expect(()=>validateDeliveryPlan({...plan,kind:"reframe-1:1"})).toThrow("does not match the film it names");
});

test("the binding is built from what the job actually sealed",()=>{
  const files=conformFiles(900,60_000_000);
  const sealed={revision:digest("d"),files:[at(PROJECT+"/"+JOB+"/provenance.json",12),...files]};
  const conformRecord={pictureFrames:Array.from({length:900},(_,index)=>String(index).padStart(64,"0")),
    picture:{parts:Array.from({length:PARTS},()=>({frames:60}))}};
  const timeline={width:1920,height:1080,frames:900};
  const job={projectId:PROJECT,id:JOB,stage:"picture-edit"};
  const made=deliveryBindingFor(job,{mp4Path:MASTER,editorial:sealed},conformRecord,timeline,"s3");
  // Every digest and size comes from the sealed inventory -- what the output's revision is computed
  // over -- rather than from a fresh look at the disk, and the renderer's whole reading list with it.
  expect(made.master).toEqual(files[0]!);
  expect(made.source).toEqual({projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision:sealed.revision});
  expect(made.conform.pictureBytes).toBe(PARTS*60_000_000);
  expect(made.files.map(file=>file.path).sort()).toEqual(files.map(file=>file.path).sort());
  // The provenance file is not something the renderer reads, so it is not in the reading list.
  expect(made.files.some(file=>file.path.endsWith("provenance.json"))).toBe(false);
  // HV-027-15: no caption text was handed in to tie the sealed track to, so only the burned kinds are
  // refused, each with the reason.
  expect(deliveryOffers(made).map(offer=>offer.kind+":"+offer.available)).toEqual(["reframe-9:16:true","reframe-1:1:true","mezzanine:true",
    "open-captions:false","open-captions-9:16:false","open-captions-1:1:false"]);
  expect(deliveryOffers(made)[3]!.reason).toContain("could not be tied to its cut");

  // An assembly seals under its own key, and a picture edit's output is not an assembly's.
  expect(deliveryBindingFor({...job,stage:"assembly-edit"},{mp4Path:MASTER,assembly:sealed},conformRecord,timeline,"s3").source.stage).toBe("assembly-edit");
  expect(()=>deliveryBindingFor({...job,stage:"assembly-edit"},{mp4Path:MASTER,editorial:sealed},conformRecord,timeline,"s3")).toThrow("has not been sealed");
  expect(()=>deliveryBindingFor({...job,stage:"sound-mix"},{mp4Path:MASTER,editorial:sealed},conformRecord,timeline,"s3")).toThrow("picture edit or an assembly");
  // A sealed output that names a master its own inventory does not contain is refused rather than
  // delivered from: the inventory is the thing the revision vouches for.
  expect(()=>deliveryBindingFor(job,{mp4Path:MASTER,editorial:{...sealed,files:[sealed.files[0]!]}},conformRecord,timeline,"s3"))
    .toThrow("sealed inventory does not contain the master it names");
  // And a film whose inventory holds a different number of parts than its own record claims is not
  // one to deliver from. Saying which two numbers disagree is more use than a missing file later.
  expect(()=>deliveryBindingFor(job,{mp4Path:MASTER,editorial:{...sealed,files:sealed.files.filter(file=>!file.path.endsWith("part-00000.mkv"))}},conformRecord,timeline,"s3"))
    .toThrow("records 15 picture parts and its sealed inventory retains 14");
  expect(()=>deliveryBindingFor(job,{mp4Path:MASTER,editorial:{...sealed,files:sealed.files.filter(file=>!file.path.endsWith("final.wav"))}},conformRecord,timeline,"s3"))
    .toThrow("does not contain audio/final.wav");
});
