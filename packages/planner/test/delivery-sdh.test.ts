/**
 * HV-027-16 — what an SDH track may say about a film's sound, and where in the film it says it.
 *
 * Every sound an SDH track describes is a sound-mix cue the cut actually plays: a recording the
 * creator placed in a reviewed sound session, heard through a mix clip or its own stem, above the
 * floor, for the stretch of it the cut keeps, on the same clock as the captions. Nothing else is
 * described, because nothing else is named.
 */
import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {contentHash} from "../../generator/src/capabilities";
import {applyEditOperation,initialEditTimeline,type EditSource} from "../src/edit-timeline";
import {createEditAssemblyPlan} from "../src/edit-assembly-clock";
import {deliverySdhPlan,editAssemblySoundCues,editSoundCues,sdhSoundText,validateDeliverySdhCheck,type DeliverySdhCheck} from "../src/delivery-sdh";
import {deliveryBinding,deliveryJobPlan,deliveryOffers,deliveryReadFiles,type DeliveryBinding,type DeliveryFile} from "../src/delivery-jobs";
import type {EditSourceBinding} from "../src/edit-jobs";

const S=48000;
const source=(audio:EditSource["audio"]):EditSource=>({id:"mixed",revision:contentHash("mixed"),label:"Mixed",frames:150,width:64,height:48,audio,captions:[],voices:[],unmeasuredAudio:false});
const cue=(role:"music"|"ambience"|"effects",label:string,start:number,frames:number,gainDb=0)=>({role,start,frames,gainDb,asset:{label}});
/** Only what `editSoundCues` reads of a binding: the source's identity and its reviewed sound session. */
const bindings=(cues:ReturnType<typeof cue>[])=>[{source:{facts:{id:"mixed"},job:{soundMix:{session:{cues}}}}}] as unknown as EditSourceBinding[];
const SESSION=[cue("ambience","Rain",1*S,2*S,-6),cue("music","Theme",0,1*S,-60),cue("effects","Door\n  slam",4*S,S/10)];

test("a sound is described where the cut plays it, by its own label, and not where it is silent",()=>{
  const mixed=initialEditTimeline([source(["mix","dialogue","narration","music","ambience","effects"])],"mixed",64,48);
  // Heard through the mix: the rain and the door. The theme sits at the -60 dB floor, which is not a sound anyone hears.
  expect(editSoundCues(mixed,bindings(SESSION))).toEqual([
    {start:1*S,end:3*S,role:"ambience",label:"Rain"},{start:4*S,end:4*S+S/10,role:"effects",label:"Door slam"}]);
  // Trim the first second and a half away: the rain that is left starts the film, and the door moves with the picture.
  const trimmed=applyEditOperation(mixed,{kind:"trim",clipId:"initial-0",linked:true,edge:"in",delta:45,ripple:true});
  expect(editSoundCues(trimmed,bindings(SESSION))).toEqual([
    {start:0,end:1.5*S,role:"ambience",label:"Rain"},{start:2.5*S,end:2.5*S+S/10,role:"effects",label:"Door slam"}]);
  // A mix clip turned down to the floor plays nothing, so nothing is described.
  const muted=applyEditOperation(mixed,{kind:"settings",clipId:"initial-1",gainDb:-60,opacity:1,crop:null,fadeIn:0,fadeOut:0});
  expect(editSoundCues(muted,bindings(SESSION))).toEqual([]);
  // A source with no sound session has no placed sounds to describe.
  expect(editSoundCues(mixed,[{source:{facts:{id:"mixed"},job:{}}}] as unknown as EditSourceBinding[])).toEqual([]);
});

test("through its own stems, a sound is heard only on its own lane, and an assembly keeps only what its ranges keep",()=>{
  const stems=initialEditTimeline([source(["music","ambience","effects"])],"mixed",64,48);
  const ambience=stems.clips.find(clip=>clip.lane==="ambience")!.id;
  expect(editSoundCues(stems,bindings(SESSION)).map(sound=>sound.label)).toEqual(["Rain","Door slam"]);
  // The ambience stem at the floor silences the rain and leaves the door, which is on the effects stem.
  const quiet=applyEditOperation(stems,{kind:"settings",clipId:ambience,gainDb:-60,opacity:1,crop:null,fadeIn:0,fadeOut:0});
  expect(editSoundCues(quiet,bindings(SESSION)).map(sound=>sound.label)).toEqual(["Door slam"]);
  // An assembly of seconds two to four keeps one second of rain at its start and no door.
  const parent={sequenceId:"sequence",historyRevision:contentHash("history"),timeline:stems,sourceReceipts:[{sourceId:"mixed",receiptRevision:contentHash("receipt")}]};
  const assembly=createEditAssemblyPlan(parent,[{id:"middle",fromFrame:60,toFrame:120,reason:"Keep the rain."}]);
  expect(editAssemblySoundCues(assembly,bindings(SESSION))).toEqual([{start:0,end:1*S,role:"ambience",label:"Rain"}]);
  expect(sdhSoundText({role:"music",label:"Theme"})).toBe("[music: Theme]");
  expect(sdhSoundText({role:"effects",label:"Door slam"})).toBe("[Door slam]");
});

const PROJECT="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",JOB="bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",ROOT=PROJECT+"/"+JOB+"/export/conform";
const at=(path:string,bytes:number):DeliveryFile=>({path,sha256:contentHash(path),bytes});
const VTT="WEBVTT\n\na\n00:00:00.000 --> 00:00:01.000\nSPUD: Hello.\n";
const TRACK:DeliveryFile={path:ROOT+"/captions.vtt",sha256:createHash("sha256").update(VTT).digest("hex"),bytes:Buffer.byteLength(VTT)};
const bound=(extra:Partial<Pick<DeliveryBinding,"captions"|"sounds">>):DeliveryBinding=>deliveryBinding({storage:"local",
  source:{projectId:PROJECT,jobId:JOB,stage:"picture-edit",outputRevision:"d".repeat(64)},master:at(ROOT+"/export.mp4",4000),
  files:[at(ROOT+"/export.mp4",4000),at(ROOT+"/picture/index.ffconcat",64),at(ROOT+"/audio/final.wav",44+150*1600*6),at(ROOT+"/picture/part-00000.mkv",9000),TRACK],
  conform:{width:640,height:360,frames:150,pictureFramesSha256:"c".repeat(64),pictureBytes:9000,mixBytes:44+150*1600*6},...extra});

test("an SDH track is offered from the film's own lines and placed sounds, and refused by name without them",()=>{
  const binding=bound({captions:{...TRACK,cues:1},sounds:[{start:S,end:3*S,role:"ambience",label:"Rain"}]});
  const plan=deliveryJobPlan(binding,"sdh");
  expect(plan.sdh).toMatchObject({captions:{...TRACK,cues:1},sounds:[{startMs:1000,endMs:3000,text:"[ambience: Rain]"}],output:{width:640,height:360}});
  expect(plan.reframe).toBeUndefined();expect(plan.mezzanine).toBeUndefined();expect(plan.openCaptions).toBeUndefined();
  // It opens the master and the caption track, and writes sdh.mp4.
  expect(deliveryReadFiles(plan).map(file=>file.path).sort()).toEqual([ROOT+"/captions.vtt",ROOT+"/export.mp4"]);
  expect(deliveryOffers(binding).find(offer=>offer.kind==="sdh")).toMatchObject({available:true});
  // A film with sounds and no spoken line still has an SDH track; a film with neither has nothing to caption.
  expect(deliveryJobPlan(bound({captions:{...TRACK,cues:0},sounds:[{start:0,end:S,role:"music",label:"Theme"}]}),"sdh").sdh!.sounds).toHaveLength(1);
  expect(()=>deliveryJobPlan(bound({captions:{...TRACK,cues:0},sounds:[]}),"sdh")).toThrow("nothing to caption for the deaf and hard of hearing");
  // A binding whose sounds were never read -- every binding made before this -- refuses SDH and only SDH.
  const older=deliveryOffers(bound({captions:{...TRACK,cues:1}}));
  expect(older.find(offer=>offer.kind==="sdh")!.reason).toContain("sound cues were not read when it was bound");
  expect(older.map(offer=>offer.kind+":"+offer.available)).toEqual(deliveryOffers(binding).map(offer=>offer.kind+":"+(offer.kind!=="sdh"&&offer.available)));
  expect(()=>deliveryJobPlan(bound({sounds:[]}),"sdh")).toThrow("could not be tied to its cut");
  // The sound list is re-checked, not believed.
  expect(()=>bound({sounds:[{start:0,end:151*1600,role:"music",label:"Theme"}]})).toThrow("inside the film");
  expect(()=>bound({sounds:[{start:0,end:S,role:"dialogue" as never,label:"Theme"}]})).toThrow("music, ambience or effects");
  expect(()=>bound({sounds:[{start:0,end:S,role:"music",label:"Two\nlines"}]})).toThrow("one-line label");
  expect(()=>bound({sounds:[{start:S,end:2*S,role:"music",label:"B"},{start:0,end:S,role:"music",label:"A"}]})).toThrow("in the order they are heard");

  // And the retained proof is checked against the plan it proves.
  const check:DeliverySdhCheck={schema:"hv-delivery-sdh-check/1",captionsSha256:TRACK.sha256,dialogue:1,sounds:1,segments:3,
    segmentsSha256:"a".repeat(64),readBackSha256:"a".repeat(64),masterStreams:"b".repeat(64),deliveredStreams:"b".repeat(64),track:{codec:"mov_text",hearingImpaired:true,handler:"SDH"}};
  expect(validateDeliverySdhCheck(check,plan.sdh!)).toEqual(check);
  expect(()=>validateDeliverySdhCheck({...check,readBackSha256:"c".repeat(64)},plan.sdh!)).toThrow("does not read back as it was written");
  expect(()=>validateDeliverySdhCheck({...check,deliveredStreams:"c".repeat(64)},plan.sdh!)).toThrow("not the master's own");
  expect(()=>validateDeliverySdhCheck({...check,sounds:0},plan.sdh!)).toThrow("other cues than its plan names");
  expect(()=>validateDeliverySdhCheck({...check,track:{...check.track,hearingImpaired:false as never}},plan.sdh!)).toThrow("marked for the hearing impaired");
  expect(()=>deliverySdhPlan({...TRACK,cues:1},undefined,{width:640,height:360},150)).toThrow("were not read");
});
