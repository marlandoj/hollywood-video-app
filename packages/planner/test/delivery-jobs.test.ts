import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {DELIVERY_KINDS,deliveryBinding,deliveryBindingFor,deliveryConformDirectory,deliveryFileName,deliveryJobPlan,deliveryOffers,
  validateDeliveryBinding,validateDeliveryPlan,type DeliveryBinding} from "../src/delivery-jobs";

const PROJECT="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",JOB="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const MASTER="projects/"+PROJECT+"/"+JOB+"/export/conform/export.mp4";
const conform=(width:number,height:number,frames:number)=>({width,height,frames,
  pictureFramesSha256:"c".repeat(64),pictureBytes:frames*width*height,mixBytes:44+frames*1600*6});
const binding=(overrides:Partial<Omit<DeliveryBinding,"schema"|"revision">>={},width=1920,height=1080,frames=900)=>deliveryBinding({
  source:{projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision:"d".repeat(64)},
  master:{path:MASTER,sha256:"e".repeat(64),bytes:4_000_000},
  conform:conform(width,height,frames),...overrides});

test("a deliverable is bound to the bytes of the film, not to the render that made them",()=>{
  const made=binding();
  expect(validateDeliveryBinding(made)).toEqual(made);
  expect(made.revision).toBe(binding().revision);
  // The conform directory is derived from the master's own path: two fields that must agree are two
  // fields that can disagree.
  expect(deliveryConformDirectory(made.master.path)).toBe("projects/"+PROJECT+"/"+JOB+"/export/conform");

  // The same deliverable of the same sealed output is the same job, whichever render produced it...
  const elsewhere=binding({source:{projectId:PROJECT,jobId:"cccccccc-3333-4333-8333-cccccccccccc",stage:"assembly-edit",outputRevision:"d".repeat(64)},
    master:{path:"projects/"+PROJECT+"/cccccccc-3333-4333-8333-cccccccccccc/export/conform/export.mp4",sha256:"e".repeat(64),bytes:4_000_000}});
  expect(deliveryJobPlan(elsewhere,"mezzanine").idempotencyKey).toBe(deliveryJobPlan(made,"mezzanine").idempotencyKey);
  // ...and a film rendered again is a different film to deliver.
  const rerendered=binding({source:{...made.source,outputRevision:"f".repeat(64)}});
  expect(deliveryJobPlan(rerendered,"mezzanine").idempotencyKey).not.toBe(deliveryJobPlan(made,"mezzanine").idempotencyKey);
  expect(rerendered.revision).not.toBe(made.revision);
  // Each kind is its own job.
  expect(new Set(DELIVERY_KINDS.map(kind=>deliveryJobPlan(made,kind).idempotencyKey)).size).toBe(DELIVERY_KINDS.length);
});

test("every kind is answered, including the ones this master cannot make",()=>{
  const hd=deliveryOffers(binding());
  expect(hd.map(offer=>offer.kind)).toEqual([...DELIVERY_KINDS]);
  expect(hd.every(offer=>offer.available&&offer.plan&&!offer.reason)).toBe(true);
  expect(hd[0]!.plan!.reframe!.output).toEqual({width:608,height:1080});
  expect(hd[1]!.plan!.reframe!.output).toEqual({width:1080,height:1080});
  expect(hd[2]!.plan!.mezzanine!.output.frames).toBe(900);
  expect(hd.map(offer=>deliveryFileName(offer.plan!))).toEqual(["reframe-9x16.mp4","reframe-1x1.mp4","mezzanine.mkv"]);

  // A 640x360 master can be squared and cannot be made vertical, and the creator is told which and
  // why rather than shown a shorter list.
  const small=deliveryOffers(binding({},640,360,900));
  expect(small.map(offer=>offer.kind+":"+offer.available)).toEqual(["reframe-9:16:false","reframe-1:1:true","mezzanine:true"]);
  expect(small[0]!.reason).toContain("202 by 360");
  expect(small[0]!.reason).toContain("256-pixel minimum");
  expect(small[0]!.plan).toBeUndefined();
  expect(small[1]!.plan!.reframe!.output).toEqual({width:360,height:360});
  // A film too long for a lossless master of itself loses only the mezzanine.
  const long=deliveryOffers(binding({conform:{...conform(1920,1080,108000),pictureBytes:40*1024**3}}));
  expect(long.map(offer=>offer.kind+":"+offer.available)).toEqual(["reframe-9:16:true","reframe-1:1:true","mezzanine:false"]);
  expect(long[2]!.reason).toContain("does not fit beside it");
});

test("a binding is refused when it does not describe a film this studio made",()=>{
  expect(()=>binding({source:{projectId:"not-a-uuid",jobId:JOB,stage:"picture-edit",outputRevision:"d".repeat(64)}})).toThrow("project and job");
  expect(()=>binding({source:{projectId:PROJECT,jobId:JOB,stage:"sound-mix" as never,outputRevision:"d".repeat(64)}})).toThrow("picture edit or an assembly");
  expect(()=>binding({source:{projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision:"short"}})).toThrow("sealed output revision");
  expect(()=>binding({master:{path:MASTER,sha256:"bad",bytes:1}})).toThrow("bytes and their digest");
  expect(()=>binding({master:{path:MASTER,sha256:"e".repeat(64),bytes:0}})).toThrow("bytes and their digest");
  // Every conform writes its export to conform/export.mp4. A master elsewhere is not one of ours.
  expect(()=>binding({master:{path:"projects/x/y/export/final.mp4",sha256:"e".repeat(64),bytes:1}})).toThrow("conform/export.mp4");
  // A conform whose own record does not add up cannot be bound to at all, whichever deliverable is
  // being asked for -- the check belongs to the conform, not to the mezzanine.
  expect(()=>binding({conform:{...conform(1920,1080,900),mixBytes:100}})).toThrow("do not agree");
  expect(()=>binding({conform:{...conform(1920,1080,900),pictureFramesSha256:"nope"}})).toThrow("recorded picture frame hashes");

  const made=binding();
  expect(()=>validateDeliveryBinding({...made,master:{...made.master,bytes:made.master.bytes+1}})).toThrow("does not match the film it names");
  expect(()=>deliveryJobPlan(made,"reframe-4:3" as never)).toThrow("a deliverable this studio makes");
  const plan=deliveryJobPlan(made,"mezzanine");
  expect(validateDeliveryPlan(plan)).toEqual(plan);
  expect(()=>validateDeliveryPlan({...plan,idempotencyKey:contentHash("elsewhere")})).toThrow("does not match the film it names");
  expect(()=>validateDeliveryPlan({...plan,kind:"reframe-1:1"})).toThrow("does not match the film it names");
});

test("the binding is built from what the job actually sealed",()=>{
  const master={path:MASTER,sha256:"e".repeat(64),bytes:4_000_000};
  const sealed={revision:"d".repeat(64),files:[{path:"projects/x/provenance.json",sha256:"0".repeat(64),bytes:12},master]};
  const conformRecord={pictureFrames:Array.from({length:900},(_,index)=>String(index).padStart(64,"0")),
    picture:{parts:Array.from({length:15},()=>({frames:60}))}};
  const timeline={width:1920,height:1080,frames:900},parts=Array.from({length:15},()=>1_000_000);
  const job={projectId:PROJECT,id:JOB,stage:"picture-edit"};
  const made=deliveryBindingFor(job,{mp4Path:MASTER,editorial:sealed},conformRecord,timeline,parts);
  // The digest and size come from the sealed inventory -- what the output's revision is computed
  // over -- rather than from a fresh look at the disk.
  expect(made.master).toEqual(master);
  expect(made.source).toEqual({projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision:sealed.revision});
  expect(made.conform.pictureBytes).toBe(15_000_000);
  expect(deliveryOffers(made).every(offer=>offer.available)).toBe(true);

  // An assembly seals under its own key, and a picture edit's output is not an assembly's.
  expect(deliveryBindingFor({...job,stage:"assembly-edit"},{mp4Path:MASTER,assembly:sealed},conformRecord,timeline,parts).source.stage).toBe("assembly-edit");
  expect(()=>deliveryBindingFor({...job,stage:"assembly-edit"},{mp4Path:MASTER,editorial:sealed},conformRecord,timeline,parts)).toThrow("has not been sealed");
  expect(()=>deliveryBindingFor({...job,stage:"sound-mix"},{mp4Path:MASTER,editorial:sealed},conformRecord,timeline,parts)).toThrow("picture edit or an assembly");
  // A sealed output that names a master its own inventory does not contain is refused rather than
  // delivered from: the inventory is the thing the revision vouches for.
  expect(()=>deliveryBindingFor(job,{mp4Path:MASTER,editorial:{...sealed,files:[sealed.files[0]!]}},conformRecord,timeline,parts))
    .toThrow("sealed inventory does not contain the master it names");
});
