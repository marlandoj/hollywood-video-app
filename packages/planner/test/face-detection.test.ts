import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {createPlacedLipSyncFixture,ownerLipSyncPass,lipFixtureJob,LIPSYNC_POLICY} from "../../../test/fixtures/lipsync";
import {lipSyncDetectionFrame,lipSyncPlannedDetections,lipSyncWorkList,savedLipSyncFacePoints,studioLipSyncApprovalUsd,studioLipSyncDetectionPlan,studioLipSyncHoldUsd,studioLipSyncKey,studioLipSyncPlan,studioLipSyncRequestHash,STUDIO_LIPSYNC_ENV,type LipSyncWorkList} from "../src/lipsync-worklist";
import {configuredFaceDetectionPolicy,detectedLipSyncFacePoints,faceDetectionHoldUsd,faceDetectionKey,faceDetectionPolicy,faceDetectionRecordDetail,faceDetectionRequestHash,settleFaceDetection,sealFaceDetection,validateFaceDetectionPolicy,validateFaceDetectionRecord,FACE_DETECTION_KEY_PREFIX,FACE_DETECTION_STALE_MS,FACE_DETECTION_POLICY_ENV,type FaceDetectionRecord} from "../src/face-detection";
import {assertLipSyncPermission,createLipSyncPlan,retainLipSyncSource} from "../src/lipsync";
import {castingSnapshot,currentCasting} from "../src/casting";
import {FACE_DETECTION_CAPABILITY} from "../../generator/src/face-detection-capability";
import {contentHash} from "../../generator/src/capabilities";

/**
 * HV-022-25: the studio's face-point finder in the work list. No detector runs here: detections are records, as the
 * ledger keeps them. Real FFmpeg and eSpeak build the placed fixture the HV-022-23 suites use; no key or network call.
 */
const FINDER_POLICY=faceDetectionPolicy({label:"fal · closed fixture",accountRevision:"a".repeat(64),priceEvidenceSha256:"f".repeat(64),heldUsd:.02,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
const root=mkdtempSync(join(tmpdir(),"hv-face-detection-")),keys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE",STUDIO_LIPSYNC_ENV,FACE_DETECTION_POLICY_ENV],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
let placed:Awaited<ReturnType<typeof createPlacedLipSyncFixture>>,owner:Awaited<ReturnType<typeof ownerLipSyncPass>>;
beforeAll(async()=>{
  Object.assign(process.env,{HV_TOKEN_SECRET:"face detection fixture, at least thirty-two characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});delete process.env[STUDIO_LIPSYNC_ENV];delete process.env[FACE_DETECTION_POLICY_ENV];
  mkdirSync(join(root,"placed"));placed=await createPlacedLipSyncFixture(join(root,"placed"));process.env.HV_AUDIO_POLICY_FILE=join(root,"placed","audio-policy.json");
  owner=await ownerLipSyncPass(placed,placed.first,placed.spoken[0]!.shotId,{x:40,y:30});
},120000);
afterAll(()=>{for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}if(!resolve(root).startsWith(resolve(tmpdir())+sep+"hv-face-detection-"))throw new Error("Unexpected fixture root");rmSync(root,{recursive:true,force:true});});
const source=()=>retainLipSyncSource(placed.second);
const points=()=>savedLipSyncFacePoints(placed.store.all());
const finderInput=(records:FaceDetectionRecord[]=[],jobs=placed.store.all())=>({policy:FINDER_POLICY,records,points:detectedLipSyncFacePoints(records,jobs)});
const reasons=(list:LipSyncWorkList)=>list.items.map(i=>[i.character,i.reason,i.faceDetection?.status??null]);
/** A detection of the second MARLA line (no owner point) on its middle frame, held or with a result. */
function detection(result?:Parameters<typeof settleFaceDetection>[1],options:{rgbSha256?:string;policy?:typeof FINDER_POLICY;at?:string}={}):FaceDetectionRecord{
  const list=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY}),item=list.items[2]!,frame=lipSyncDetectionFrame(item.window!),rgbSha256=options.rgbSha256??"9".repeat(64),policy=options.policy??FINDER_POLICY;
  const frameInfo={width:320,height:240,rgbSha256};
  const held:Omit<FaceDetectionRecord,"revision">={schema:"hv-face-detection/1",id:faceDetectionKey({sourceJobId:list.sourceJobId,shotId:item.shotId,lineIndex:item.lineIndex,rgbSha256,policyRevision:policy.revision}),projectId:placed.project.id,
    sourceJobId:list.sourceJobId,picture:list.picture,shotId:item.shotId,lineIndex:item.lineIndex,characterId:item.characterId!,frame,absoluteFrame:item.window!.startFrame+frame,...frameInfo,
    policyRevision:policy.revision,capabilityRevision:FACE_DETECTION_CAPABILITY.revision,requestHash:faceDetectionRequestHash(frameInfo,policy.revision),heldUsd:policy.heldUsd,admittedAt:options.at??"2026-11-11T10:00:00.000Z",
    status:"held",outcome:null,faces:null,point:null,responseSha256:null,completedAt:null};
  const sealed=sealFaceDetection(held);return result?settleFaceDetection(sealed,result,Date.parse("2026-11-11T10:00:05.000Z")):sealed;
}
const ONE={outcome:"one-face" as const,faces:1,point:{x:150,y:90},responseSha256:"1".repeat(64)};

test("the finder's policy is the operator's file, validated and dated; with none configured there is no finder",()=>{
  expect(configuredFaceDetectionPolicy({})).toBeUndefined();
  const path=join(root,"finder-policy.json");writeFileSync(path,JSON.stringify(FINDER_POLICY));
  expect(configuredFaceDetectionPolicy({[FACE_DETECTION_POLICY_ENV]:path})).toEqual(FINDER_POLICY);
  expect(FINDER_POLICY).toMatchObject({schema:"hv-face-detection-policy/1",provider:"fal",model:"fal-ai/moondream-next/detection",capabilityRevision:FACE_DETECTION_CAPABILITY.revision,heldUsd:.02});
  writeFileSync(path,JSON.stringify({...FINDER_POLICY,heldUsd:.01}));expect(()=>configuredFaceDetectionPolicy({[FACE_DETECTION_POLICY_ENV]:path})).toThrow("evidence changed");
  expect(()=>validateFaceDetectionPolicy(FINDER_POLICY,Date.parse("2025-01-01T00:00:00.000Z"))).toThrow("not currently valid");
  for(const heldUsd of [0,-1,1001,.0000001,Number.NaN])expect(()=>faceDetectionPolicy({...FINDER_POLICY,heldUsd} as never)).toThrow();
  expect(faceDetectionHoldUsd([1,2,3],{heldUsd:.1})).toBe(.3);
});

test("finder off: the work list, its hash, every item and the hold are exactly as before",()=>{
  const before=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY});
  expect(before.faceDetection).toBeUndefined();expect(before.items.some(i=>"faceDetection" in i||"detectedPoint" in i)).toBe(false);
  // The finder needs the lip-sync policy too: without it nothing about detection appears, even with records.
  const unpriced=lipSyncWorkList(source(),{facePoints:points(),faceDetection:finderInput([detection(ONE)])});
  expect(unpriced).toEqual(lipSyncWorkList(source(),{facePoints:points()}));
  expect(reasons(before)).toEqual([["MARLA","ready",null],["KEVIN","off-camera",null],["MARLA","no-face-point",null]]);
  // The first line is ready on the owner's own point, chosen on the first voiced cut of the same picture.
  expect(before.items[0]!.facePointJobId).toBe(owner.id);
});

test("finder on: a line with no owner point plans one detection on its window's middle frame, priced into the approval",()=>{
  const list=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY,faceDetection:finderInput()}),item=list.items[2]!;
  expect(reasons(list)).toEqual([["MARLA","ready",null],["KEVIN","off-camera",null],["MARLA","no-face-point","planned"]]);
  expect(item.faceDetection).toEqual({status:"planned",frame:Math.floor((item.window!.frames-1)/2),heldUsd:.02});
  // An off-camera line and a ready line plan none.
  expect(list.items[0]!.faceDetection).toBeUndefined();expect(list.items[1]!.faceDetection).toBeUndefined();
  expect(list.faceDetection).toEqual({policyRevision:FINDER_POLICY.revision,capabilityRevision:FACE_DETECTION_CAPABILITY.revision,heldUsdPerDetection:.02,planned:1,heldUsd:.02});
  expect(lipSyncPlannedDetections(list).map(i=>[i.shotId,i.lineIndex])).toEqual([[item.shotId,item.lineIndex]]);
  // The approval: the ready pass, the detection, and the pass the detection may make possible.
  const ready=list.items.filter(i=>i.included);
  expect(studioLipSyncApprovalUsd(ready,lipSyncPlannedDetections(list),LIPSYNC_POLICY,FINDER_POLICY)).toBe(10.02);
  expect(studioLipSyncApprovalUsd(ready,[],LIPSYNC_POLICY,FINDER_POLICY)).toBe(studioLipSyncHoldUsd(ready,LIPSYNC_POLICY));
  expect(()=>studioLipSyncApprovalUsd(ready,[1],LIPSYNC_POLICY)).toThrow("face detection policy");
  // Twenty detections at $0.000001 and passes at $5 sum exactly.
  expect(studioLipSyncApprovalUsd([],Array(20).fill(0),{...LIPSYNC_POLICY,heldUsd:.000001},{...FINDER_POLICY,heldUsd:.000001})).toBe(.00004);
  // The list's revision names the finder: turning it on is a new list to approve.
  expect(list.revision).not.toBe(lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY}).revision);
});

test("one face found: the line is ready on the finder's suggestion, with its provenance, and its pass names the detection",()=>{
  const record=detection(ONE),list=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY,faceDetection:finderInput([record])}),item=list.items[2]!;
  expect(item.reason).toBe("ready");expect(item.included).toBe(true);expect(item.facePointJobId).toBeNull();expect(item.faceDetection).toBeUndefined();
  expect(item.selection).toEqual({frame:record.frame,width:320,height:240,x:150,y:90,rgbSha256:record.rgbSha256});
  expect(item.detectedPoint).toEqual({detectionId:record.id,source:"detected",provider:"fal",model:"fal-ai/moondream-next/detection",frameSha256:record.rgbSha256,requestHash:record.requestHash,policyRevision:FINDER_POLICY.revision,capabilityRevision:FACE_DETECTION_CAPABILITY.revision});
  expect(list.faceDetection!.planned).toBe(0);expect(list.passes).toBe(2);expect(list.needFacePoint).toBe(0);
  // The pass made from it is the studio's, keyed as any studio pass, and its request names the detection.
  expect(studioLipSyncKey(list,item)).toMatch(/^studio-lipsync-[a-f0-9]{48}$/);
  const plan=studioLipSyncPlan(source(),list,item,LIPSYNC_POLICY,"local");expect(plan.selection).toEqual(item.selection!);
  expect(studioLipSyncRequestHash(list,item)).not.toBe(studioLipSyncRequestHash(list,{...item,detectedPoint:undefined}));
  // A studio pass never offers an owner point, so the suggestion is never mistaken for the owner's.
  expect(savedLipSyncFacePoints([{...placed.store.enqueue(lipFixtureJob(plan,crypto.randomUUID(),placed.project.id+":"+studioLipSyncKey(list,item))),status:"done"}])).toEqual([]);
});

test("the owner's point always wins over a suggestion, even an older owner point against a newer detection",async()=>{
  const list0=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY}),line=list0.items[2]!;
  const retained=source(),frame=lipSyncDetectionFrame(line.window!);
  const {previewLipSyncFrame}=await import("../../generator/src/lipsync-media");const image=await previewLipSyncFrame(retained,placed.artifacts,line.shotId,line.lineIndex,frame);
  const ownerPlan=createLipSyncPlan(retained,line.shotId,line.lineIndex,{frame,width:image.width,height:image.height,x:12,y:14,rgbSha256:image.rgbSha256},LIPSYNC_POLICY,"local",contentHash({owner:"second-line"}),Date.parse("2026-11-01T00:00:00.000Z"));
  const ownerPass={...lipFixtureJob(ownerPlan),status:"done" as const},ownerId=ownerPass.id;
  const record=detection(ONE,{at:"2026-11-11T12:00:00.000Z"});
  const list=lipSyncWorkList(retained,{facePoints:savedLipSyncFacePoints([...placed.store.all(),ownerPass as never]),policy:LIPSYNC_POLICY,faceDetection:finderInput([record])}),item=list.items[2]!;
  expect(item.reason).toBe("ready");expect(item.facePointJobId).toBe(ownerId);expect(item.detectedPoint).toBeUndefined();
  expect(item.selection).toMatchObject({x:12,y:14});
});

test("several faces, none, a face outside the frame or an unreadable answer: no point, the line stays the owner's, and it is never detected again",()=>{
  const cases:[Parameters<typeof settleFaceDetection>[1],string,number|null][]=[
    [{outcome:"several-faces",faces:2,point:null,responseSha256:"2".repeat(64)},"2 faces found; choose the speaker under Direct lip-sync.",2],
    [{outcome:"no-face",faces:0,point:null,responseSha256:"3".repeat(64)},"No face found; choose the speaker under Direct lip-sync.",0],
    [{outcome:"out-of-bounds",faces:1,point:null,responseSha256:"4".repeat(64)},"The face found lies outside the frame; choose the speaker under Direct lip-sync.",1],
    [{outcome:"unparseable",faces:null,point:null,responseSha256:"5".repeat(64)},"The detection's answer could not be read with certainty; choose the speaker under Direct lip-sync.",null],
    [{outcome:"failed",faces:null,point:null,responseSha256:null},"The face detection did not answer; choose the speaker under Direct lip-sync.",null],
    // A "one face" with no point is read as unreadable, never as a point.
    [{outcome:"one-face",faces:1,point:null,responseSha256:"6".repeat(64)},"The detection's answer could not be read with certainty; choose the speaker under Direct lip-sync.",1],
  ];
  for(const [result,detail,faces] of cases){
    const record=detection(result),list=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY,faceDetection:finderInput([record])}),item=list.items[2]!;
    expect(item.reason).toBe("no-face-point");expect(item.included).toBe(false);expect(item.selection).toBeNull();
    expect(item.faceDetection).toEqual({status:"settled",detectionId:record.id,outcome:record.outcome,faces,detail});
    expect(list.faceDetection!.planned).toBe(0);expect(list.faceDetection!.heldUsd).toBe(0);expect(list.passes).toBe(1);
  }
  // A detection admitted but not finished is not asked again either.
  const held=detection(),list=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY,faceDetection:finderInput([held])});
  expect(list.items[2]!.faceDetection).toEqual({status:"held",detectionId:held.id,outcome:null,faces:null,detail:"The face detection for this line did not finish; choose the speaker under Direct lip-sync."});
  expect(list.faceDetection!.planned).toBe(0);
  // Nor is a line detected under an earlier policy, or on another frame hash.
  const other=faceDetectionPolicy({label:"fal · repriced",accountRevision:"a".repeat(64),priceEvidenceSha256:"e".repeat(64),heldUsd:.05,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
  const earlier=detection({outcome:"several-faces",faces:3,point:null,responseSha256:"7".repeat(64)},{policy:other,rgbSha256:"8".repeat(64)});
  expect(lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY,faceDetection:finderInput([earlier])}).items[2]!.faceDetection).toMatchObject({status:"settled",detail:"3 faces found; choose the speaker under Direct lip-sync."});
});

test("the detection key is fixed by the cut, shot, line, frame and policy; the record cannot be edited into a point",()=>{
  const record=detection(),again=detection();expect(again.id).toBe(record.id);expect(record.id.startsWith(FACE_DETECTION_KEY_PREFIX)).toBe(true);
  const vary=(change:Partial<Parameters<typeof faceDetectionKey>[0]>)=>faceDetectionKey({sourceJobId:record.sourceJobId,shotId:record.shotId,lineIndex:record.lineIndex,rgbSha256:record.rgbSha256,policyRevision:record.policyRevision,...change});
  expect(vary({})).toBe(record.id);
  for(const change of [{sourceJobId:placed.first.id},{shotId:"other-shot"},{lineIndex:record.lineIndex+1},{rgbSha256:"0".repeat(64)},{policyRevision:"0".repeat(64)}])expect(vary(change)).not.toBe(record.id);
  // A settled record keeps its result; a held one cannot carry a point; a record's identity cannot move.
  const settled=settleFaceDetection(record,ONE);expect(()=>settleFaceDetection(settled,ONE)).toThrow("already has its result");
  expect(()=>validateFaceDetectionRecord({...record,point:{x:1,y:1}})).toThrow();
  // A settled point moved by hand no longer matches the record's own revision.
  expect(()=>validateFaceDetectionRecord({...settled,point:{x:1,y:1}})).toThrow("changed");expect(()=>validateFaceDetectionRecord({...settled,heldUsd:.01})).toThrow("changed");
  expect(()=>validateFaceDetectionRecord({...settled,faces:2})).toThrow();
  expect(()=>validateFaceDetectionRecord({...settled,point:{x:320,y:10}})).toThrow();
  expect(()=>validateFaceDetectionRecord({...settled,lineIndex:settled.lineIndex+1})).toThrow("changed");
  expect(()=>validateFaceDetectionRecord({...settled,requestHash:"0".repeat(64)})).toThrow("changed");
  expect(()=>validateFaceDetectionRecord({...settled,outcome:"several-faces"})).toThrow();
  expect(faceDetectionRecordDetail(record)).toContain("did not finish");
});

test("a suggestion whose studio pass failed, was cancelled, or was reviewed as anything but a good accept is not offered again",()=>{
  const record=detection(ONE),first=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY,faceDetection:finderInput([record])}),item=first.items[2]!;
  const plan=studioLipSyncPlan(source(),first,item,LIPSYNC_POLICY,"local"),job={...lipFixtureJob(plan,crypto.randomUUID(),placed.project.id+":"+studioLipSyncKey(first,item)),status:"done"};
  const review=(decision:"accept"|"revise"|"cutaway",score=4)=>({version:1,outputRevision:"d".repeat(64),rubric:"owner-rubric/1" as const,mouthSync:score,faceStability:4,expression:4,decision,notes:"Checked on playback.",at:"2026-11-11T00:00:00.000Z",revision:"e".repeat(64)});
  const offered=(jobs:unknown[])=>detectedLipSyncFacePoints([record],jobs as never).map(p=>p.detectionId);
  expect(offered([job])).toEqual([record.id]);
  expect(offered([{...job,lipSyncReviews:{version:1,entries:[review("accept",3)]}}])).toEqual([record.id]);
  for(const spoiled of [{status:"failed"},{status:"cancelled"},{lipSyncReviews:{version:1,entries:[review("revise")]}},{lipSyncReviews:{version:1,entries:[review("cutaway")]}},{lipSyncReviews:{version:1,entries:[review("accept",2)]}}]){
    expect(offered([{...job,...spoiled}])).toEqual([]);
    const list=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY,faceDetection:{policy:FINDER_POLICY,records:[record],points:detectedLipSyncFacePoints([record],[{...job,...spoiled}] as never)}});
    // The line needs the owner's point, and is not detected again.
    expect(list.items[2]!.reason).toBe("no-face-point");expect(list.items[2]!.faceDetection).toMatchObject({status:"settled",detail:"The studio's suggested face point was not accepted; choose the speaker under Direct lip-sync."});
  }
  // A record that no longer validates offers nothing.
  expect(detectedLipSyncFacePoints([{...record,point:{x:1,y:1}}],[])).toEqual([]);
});

test("review B1: a planned line's permission is checked on the plan its pass would be queued under, before anything is held",()=>{
  const list=lipSyncWorkList(source(),{facePoints:points(),policy:LIPSYNC_POLICY,faceDetection:finderInput()}),[item]=lipSyncPlannedDetections(list),frame={frame:item!.faceDetection!.status==="planned"?item!.faceDetection!.frame:0,width:320,height:240,rgbSha256:"9".repeat(64)};
  const plan=studioLipSyncDetectionPlan(source(),list,item!,frame,LIPSYNC_POLICY,"local");
  expect(plan).toMatchObject({shotId:item!.shotId,lineIndex:item!.lineIndex,characterId:item!.characterId,selection:{frame:frame.frame,width:320,height:240,x:160,y:120,rgbSha256:frame.rgbSha256}});
  expect(()=>assertLipSyncPermission(plan,placed.project)).not.toThrow();
  // A cast permission withdrawn refuses the line, so the route skips it and holds nothing.
  const revoked=structuredClone(placed.project),cast=currentCasting(revoked.id,revoked.castingHistory),characters=structuredClone(cast.characters);
  for(const c of characters)c.permission.status="revoked";revoked.castingHistory!.push(castingSnapshot(revoked.id,cast.version+1,characters,Date.now()));
  expect(()=>assertLipSyncPermission(plan,revoked)).toThrow("not permitted");
  // Only a line with a planned detection, on the list's own policy and cut, has such a plan.
  expect(()=>studioLipSyncDetectionPlan(source(),list,list.items[0]!,frame,LIPSYNC_POLICY,"local")).toThrow("planned face detection");
  expect(()=>studioLipSyncDetectionPlan(source(),{...list,policyRevision:"0".repeat(64)},item!,frame,LIPSYNC_POLICY,"local")).toThrow("Review the current lip-sync work list");
});

test("review S1: a detection held past FACE_DETECTION_STALE_MS is settled as failed, with no point, and its hold stays its cost",()=>{
  expect(FACE_DETECTION_STALE_MS).toBe(10*60*1000);
  const held=detection(),failed=settleFaceDetection(held,{outcome:"failed",faces:null,point:null,responseSha256:null},Date.parse(held.admittedAt)+FACE_DETECTION_STALE_MS);
  expect(failed).toMatchObject({status:"settled",outcome:"failed",faces:null,point:null,heldUsd:held.heldUsd});expect(validateFaceDetectionRecord(failed)).toEqual(failed);
});
