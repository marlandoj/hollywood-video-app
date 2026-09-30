/**
 * HV-027-15 — what a burned-caption deliverable is planned from, and what it refuses.
 *
 * The captions a deliverable burns are the film's own sealed `conform/captions.vtt`. The binding
 * names that file only when it is byte for byte the track the film's own cut derives, so the cue
 * count the plan carries is a fact about the file rather than a guess, and a binding that names no
 * track -- every binding made before this increment -- refuses the burned kinds and nothing else.
 */
import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {contentHash} from "../../generator/src/capabilities";
import {deliveryBinding,deliveryBindingFor,deliveryJobPlan,deliveryOffers,deliveryReadFiles,validateDeliveryPlan,
  type DeliveryBinding,type DeliveryFile} from "../src/delivery-jobs";
import {deliveryOpenCaptionsPlan,validateDeliveryOpenCaptionsPlan} from "../src/delivery-captions";

const PROJECT="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",JOB="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ROOT=PROJECT+"/"+JOB+"/export/conform",MASTER=ROOT+"/export.mp4",PARTS=3;
const digest=(seed:string)=>seed.repeat(64).slice(0,64);
const at=(path:string,bytes:number):DeliveryFile=>({path,sha256:contentHash(path),bytes});
const VTT="WEBVTT\n\ncue-1\n00:00:00.000 --> 00:00:01.172\nSPUD: Welcome to the garden.\n\ncue-2\n00:00:01.372 --> 00:00:02.751\nSPUD: Come inside, friend.\n";
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
const TRACK:DeliveryFile={path:ROOT+"/captions.vtt",sha256:sha(VTT),bytes:Buffer.byteLength(VTT)};
const files=(frames:number)=>[at(MASTER,4_000_000),at(ROOT+"/picture/index.ffconcat",512),at(ROOT+"/audio/final.wav",44+frames*1600*6),
  ...Array.from({length:PARTS},(_,index)=>at(ROOT+"/picture/part-"+String(index).padStart(5,"0")+".mkv",1_000_000))];
const bound=(width:number,height:number,frames=900,captions?:DeliveryBinding["captions"]):DeliveryBinding=>deliveryBinding({storage:"local",
  source:{projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision:digest("d")},master:at(MASTER,4_000_000),
  files:[...files(frames),...(captions?[TRACK]:[])],
  conform:{width,height,frames,pictureFramesSha256:digest("c"),pictureBytes:PARTS*1_000_000,mixBytes:44+frames*1600*6},...(captions?{captions}:{})});

test("a burned deliverable burns the film's own sealed track, laid out for the frame it is delivered in",()=>{
  const binding=bound(1920,1080,900,{...TRACK,cues:2});
  const burned=Object.fromEntries(deliveryOffers(binding).filter(offer=>offer.kind.startsWith("open-captions")).map(offer=>[offer.kind,offer.plan!]));
  expect(Object.keys(burned)).toEqual(["open-captions","open-captions-9:16","open-captions-1:1"]);
  // The words are the film's own: the same file, the same digest, the same number of cues.
  for(const plan of Object.values(burned))expect(plan.openCaptions!.captions).toEqual({...TRACK,cues:2});
  // The master's own frame is not cropped; a reframe is cropped first and captioned after, so its
  // captions sit inside the frame that is delivered rather than off the side of the master's.
  expect(burned["open-captions"]!.openCaptions).toMatchObject({frame:"master",output:{width:1920,height:1080},crop:null});
  expect(burned["open-captions"]!.reframe).toBeUndefined();
  expect(burned["open-captions-9:16"]!.openCaptions).toMatchObject({frame:"9:16",output:{width:608,height:1080},crop:"crop=608:1080:656:0,setsar=1"});
  expect(burned["open-captions-9:16"]!.reframe!.output).toEqual({width:608,height:1080});
  // Sized from the frame: a narrow frame is sized from its width and wraps onto more lines.
  expect(burned["open-captions"]!.openCaptions!.style).toEqual({font:"DejaVu Sans",fontSize:60,outline:5,marginH:96,marginV:65});
  expect(burned["open-captions-9:16"]!.openCaptions!.style.fontSize).toBe(38);
  expect(burned["open-captions-1:1"]!.openCaptions!.style.fontSize).toBe(60);
  // It opens the master and the track it burns, and nothing else of the conform.
  expect(deliveryReadFiles(burned["open-captions-1:1"]!).map(file=>file.path).sort()).toEqual([TRACK.path,MASTER].sort());
  // Each burned kind is its own deliverable of this film, distinct from the plain reframe of the same frame.
  const keys=deliveryOffers(binding).map(offer=>offer.plan!.idempotencyKey);
  expect(new Set(keys).size).toBe(keys.length);
  // A retained plan is re-derived from its own parts.
  const plan=burned["open-captions-9:16"]!;
  expect(validateDeliveryPlan(plan)).toEqual(plan);
  expect(()=>validateDeliveryOpenCaptionsPlan({...plan.openCaptions!,style:{...plan.openCaptions!.style,fontSize:12}})).toThrow("does not match the film it names");
  expect(()=>validateDeliveryOpenCaptionsPlan({...plan.openCaptions!,crop:null})).toThrow("Only a reframed deliverable crops");
});

test("a film with nothing to burn, or a track that is not the film's, is refused by name",()=>{
  // A film whose cut carries no spoken line has an empty track, and burning it would deliver the plain film under another name.
  const silent=deliveryOffers(bound(1920,1080,900,{...TRACK,cues:0}));
  for(const offer of silent.filter(offer=>offer.kind.startsWith("open-captions")))
    expect({available:offer.available,reason:offer.reason}).toEqual({available:false,reason:"This film has no captions to burn: nothing in its cut carries a spoken line."});
  // A binding made before the burned kinds existed names no track: they are refused and the rest are untouched.
  const older=deliveryOffers(bound(1920,1080));
  expect(older.map(offer=>offer.kind+":"+offer.available)).toEqual(["reframe-9:16:true","reframe-1:1:true","mezzanine:true",
    "open-captions:false","open-captions-9:16:false","open-captions-1:1:false"]);
  expect(older[3]!.reason).toContain("could not be tied to its cut");
  // And those older deliverables are still the deliverables they were: a binding without a track, and
  // the reframe and mezzanine plans made from it, carry the revisions this fixture had before the
  // burned kinds existed, so a retained plan re-derives to itself.
  expect(bound(1920,1080).revision).toBe("aa415235f2f27706f29efd4161da3d79fecae833eaf235af4627b360da5aa85d");
  expect(deliveryJobPlan(bound(1920,1080),"reframe-1:1").revision).toBe("4c929a7302904d994b08980cb7dae12aab0692a1a5507308092601c0ead4a56e");
  expect(deliveryJobPlan(bound(1920,1080),"mezzanine").revision).toBe("d1a330408e1d5fa327dde3f8e89ff41517a7f7709750c45a72695e8d17395bdd");
  // A track is one of the files the binding already names, at the conform's own path, with the same bytes.
  expect(()=>bound(1920,1080,900,{...TRACK,sha256:digest("e"),cues:2})).toThrow("not the one its sealed inventory names");
  expect(()=>deliveryBinding({...bound(1920,1080),captions:{...TRACK,cues:2}})).toThrow("not the one its sealed inventory names");
  expect(()=>bound(1920,1080,900,{...TRACK,cues:1.5})).toThrow("Count this film's caption cues");
  // And the plan checks its own inputs.
  expect(()=>deliveryOpenCaptionsPlan({...TRACK,path:ROOT+"/elsewhere.vtt",cues:2},"master",{width:1920,height:1080},null)).toThrow("own sealed caption track");
  expect(()=>deliveryOpenCaptionsPlan({...TRACK,cues:2},"4:3" as never,{width:1920,height:1080},null)).toThrow("Choose a frame");
});

test("the track is named only when it is byte for byte the one the film's own cut derives",()=>{
  const frames=900,inventory=[...files(frames),TRACK],sealed={revision:digest("d"),files:inventory};
  const record={pictureFrames:Array.from({length:frames},(_,index)=>String(index).padStart(64,"0")),picture:{parts:Array.from({length:PARTS},()=>({frames:300}))}};
  const job={projectId:PROJECT,id:JOB,stage:"picture-edit"},timeline={width:1920,height:1080,frames};
  const tied=deliveryBindingFor(job,{mp4Path:MASTER,editorial:sealed},record,timeline,"local",{text:VTT,cues:2});
  expect(tied.captions).toEqual({...TRACK,cues:2});
  expect(tied.files.map(file=>file.path)).toContain(TRACK.path);
  expect(deliveryJobPlan(tied,"open-captions").openCaptions!.captions.cues).toBe(2);
  // A cut that derives other words than the sealed file carries is not tied to it, and nothing is burned.
  const untied=deliveryBindingFor(job,{mp4Path:MASTER,editorial:sealed},record,timeline,"local",{text:VTT.replace("friend","stranger"),cues:2});
  expect(untied.captions).toBeUndefined();
  expect(untied.files.map(file=>file.path)).not.toContain(TRACK.path);
  expect(()=>deliveryJobPlan(untied,"open-captions-1:1")).toThrow("could not be tied to its cut");
  expect(deliveryJobPlan(untied,"reframe-1:1").reframe!.output).toEqual({width:1080,height:1080});
});
