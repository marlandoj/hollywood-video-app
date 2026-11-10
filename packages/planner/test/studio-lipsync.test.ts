import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {createLipSyncFixture,createPlacedLipSyncFixture,ownerLipSyncPass,lipFixtureJob,LIPSYNC_POLICY} from "../../../test/fixtures/lipsync";
import {lipSyncWorkList,lipSyncPicture,savedLipSyncFacePoints,studioLipSyncEnabled,studioLipSyncHoldUsd,studioLipSyncKey,studioLipSyncPlan,studioLipSyncRequestHash,STUDIO_LIPSYNC_ENV,STUDIO_KEY_PREFIX,LIPSYNC_WORK_REASONS} from "../src/lipsync-worklist";
import {createLipSyncPlan,retainLipSyncSource,validateLipSyncPlan} from "../src/lipsync";
import {lipSyncPolicy} from "../src/lipsync-policy";
import {LIPSYNC_CAPABILITY} from "../../generator/src/lipsync-capability";
import {prepareLipSyncMedia,renderLipSyncVersion} from "../../generator/src/lipsync-media";
import {SyncLipSyncProvider} from "../../generator/src/sync-lipsync";
import {contentHash} from "../../generator/src/capabilities";
import {DurableJobStore} from "../../queue/src/index";
import {speakingDirection} from "../src/dialogue-placement";
import {DEFAULT_FILM_SPEND_CAP_USD,DEFAULT_FEATURE_FILM_SPEND_CAP_USD} from "../../operator/src/film-budget";

/**
 * HV-022-23: the studio's lip-sync work list. Real FFmpeg, eSpeak and the closed-transport Sync adapter the
 * existing lip-sync suites use; no policy file, key or network call.
 */
const root=mkdtempSync(join(tmpdir(),"hv-studio-lipsync-")),keys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE",STUDIO_LIPSYNC_ENV],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
let placed:Awaited<ReturnType<typeof createPlacedLipSyncFixture>>,owner:Awaited<ReturnType<typeof ownerLipSyncPass>>;
beforeAll(async()=>{
  Object.assign(process.env,{HV_TOKEN_SECRET:"studio-lipsync-fixture-secret-at-least-thirty-two-characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});delete process.env[STUDIO_LIPSYNC_ENV];
  mkdirSync(join(root,"placed"));placed=await createPlacedLipSyncFixture(join(root,"placed"));process.env.HV_AUDIO_POLICY_FILE=join(root,"placed","audio-policy.json");
  // The owner's own pass on the first voiced cut: MARLA's "Hello." on the shot whose action names her, at a face point they chose.
  owner=await ownerLipSyncPass(placed,placed.first,placed.spoken[0]!.shotId,{x:40,y:30});
},120000);
afterAll(()=>{for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}if(!resolve(root).startsWith(resolve(tmpdir())+sep+"hv-studio-lipsync-"))throw new Error("Unexpected fixture root");rmSync(root,{recursive:true,force:true});});
const points=()=>savedLipSyncFacePoints(placed.store.all());
const reasons=(list:ReturnType<typeof lipSyncWorkList>)=>list.items.map(i=>[i.character,i.reason]);

test("the switch is off unless the operator sets HV_STUDIO_LIPSYNC=1, and it never enters a contract, policy or plan",()=>{
  expect(studioLipSyncEnabled({})).toBe(false);
  for(const value of ["0","true","yes","on"," 1",""])expect(studioLipSyncEnabled({HV_STUDIO_LIPSYNC:value})).toBe(false);
  expect(studioLipSyncEnabled({HV_STUDIO_LIPSYNC:"1"})).toBe(true);
  // The revisions every recorded pass binds, as they were before this increment (unchanged files: lipsync-capability.ts, lipsync-policy.ts).
  expect(LIPSYNC_CAPABILITY.revision).toBe("13785712e9072b9351d8809ff91aa99d6b1f08859cb62bcb8342be238a7beaf6");
  expect(LIPSYNC_POLICY.revision).toBe("23b1104e9ef45fcf866eb85fc979bfb46c8ea030bdf01ebe31ab65b9edaa1b89");
  expect(LIPSYNC_POLICY.priceRevision).toBe("059f17184ef3c900688c2ec27f0d93b30e435f70d16b71e4d1348e910750662f");
  // The owner's plan revalidates and rehashes the same with the switch on.
  const before=contentHash(owner.lipSync);process.env[STUDIO_LIPSYNC_ENV]="1";
  try{expect(contentHash(validateLipSyncPlan(owner.lipSync!))).toBe(before);expect(Object.keys(owner.lipSync!).sort()).toEqual(["admittedAt","capabilityRevision","characterId","lineIndex","policy","requestHash","revision","schema","selection","shotId","source","sourceHash","storage","window"]);}
  finally{delete process.env[STUDIO_LIPSYNC_ENV];}
  // The budget defaults are as they were.
  expect([DEFAULT_FILM_SPEND_CAP_USD,DEFAULT_FEATURE_FILM_SPEND_CAP_USD]).toEqual([40,150]);
});

test("a placed feature's on-camera line with the owner's face point is ready; a voice-over and a line without a face point are not",()=>{
  const second=retainLipSyncSource(placed.second),list=lipSyncWorkList(second,{facePoints:points(),policy:LIPSYNC_POLICY});
  expect(list.placement).toBe("speaker");expect(reasons(list)).toEqual([["MARLA","ready"],["KEVIN","off-camera"],["MARLA","no-face-point"]]);
  expect(list.items.map(i=>i.shotId)).toEqual(placed.spoken.map(s=>s.shotId));
  // The voiced cuts of one final are the same picture, so the owner's point chosen on the first stands on the second.
  expect(lipSyncPicture(second)).toBe(lipSyncPicture(retainLipSyncSource(placed.first)));expect(lipSyncPicture(second)).toStartWith("video-stream:");
  const ready=list.items[0]!;expect(ready.facePointJobId).toBe(owner.id);expect(ready.selection).toEqual(owner.lipSync!.selection);expect(ready.included).toBe(true);expect(ready.heldUsd).toBe(5);
  expect(list.items.filter(i=>!i.included).every(i=>i.selection===null&&i.heldUsd===null)).toBe(true);
  expect(list.passes).toBe(1);expect(list.needFacePoint).toBe(1);
  // Deterministic: the same cut, points and policy give the same list.
  expect(lipSyncWorkList(second,{facePoints:points(),policy:LIPSYNC_POLICY}).revision).toBe(list.revision);
  // A pass that failed or was cancelled offers no point (the point may be why); with no saved point, nothing is guessed.
  expect(savedLipSyncFacePoints([{...owner,status:"cancelled"},{...owner,status:"failed"}])).toEqual([]);expect(savedLipSyncFacePoints([{...owner,status:"done"}])).toHaveLength(1);
  // Both on-camera lines then need one.
  expect(reasons(lipSyncWorkList(second,{policy:LIPSYNC_POLICY}))).toEqual([["MARLA","no-face-point"],["KEVIN","off-camera"],["MARLA","no-face-point"]]);
  // A point for another character, or for a frame outside the line's window, is not this shot's speaker.
  const [point]=points();expect(reasons(lipSyncWorkList(second,{facePoints:[{...point!,characterId:placed.kevin}],policy:LIPSYNC_POLICY}))[0]).toEqual(["MARLA","no-face-point"]);
  expect(reasons(lipSyncWorkList(second,{facePoints:[{...point!,absoluteFrame:point!.absoluteFrame+ready.window!.frames}],policy:LIPSYNC_POLICY}))[0]).toEqual(["MARLA","no-face-point"]);
  expect(reasons(lipSyncWorkList(second,{facePoints:[{...point!,picture:"lipsync-export:"+"0".repeat(64)}],policy:LIPSYNC_POLICY}))[0]).toEqual(["MARLA","no-face-point"]);
  // The ready shot was asked to show MARLA speaking; the voice-over's shot names nobody.
  const shots=placed.film.output!.shotRenders!;expect(shots.find(s=>s.shotId===placed.spoken[1]!.shotId)!.clip.speech!.lines[0]!.source.character).toBe("KEVIN");
  expect(speakingDirection([{character:"MARLA",lines:["Hello."]}])).toBe("MARLA speaks on camera: face visible, mouth moving, framed for dialogue.");
},60000);

test("an unmarked plan lists every line as unplaced, and the policy's duration excludes a long line",async()=>{
  const folder=join(root,"unplaced");mkdirSync(folder);const legacy=await createLipSyncFixture(folder),source=retainLipSyncSource(legacy.dialogue);
  expect(legacy.film.sequence).toBeUndefined();
  const list=lipSyncWorkList(source,{facePoints:savedLipSyncFacePoints(legacy.store.all()),policy:LIPSYNC_POLICY});
  expect(list.placement).toBeNull();expect(list.items.map(i=>i.reason)).toEqual(["unplaced","no-applied-voice"]);expect(list.passes).toBe(0);expect(list.heldUsd).toBe(0);
  // Placed, but the policy allows fewer frames than the line's window.
  const short=lipSyncPolicy({label:"Sync · short",accountRevision:"a".repeat(64),licenceEvidenceSha256:"b".repeat(64),priceEvidenceSha256:"c".repeat(64),outputHosts:["output.sync.so"],heldUsd:5,maxFrames:10,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
  expect(reasons(lipSyncWorkList(retainLipSyncSource(placed.second),{facePoints:points(),policy:short}))).toEqual([["MARLA","too-long"],["KEVIN","off-camera"],["MARLA","too-long"]]);
},120000);

test("every pass is held: the list's hold is passes times the policy's price, in integer micro-dollars",()=>{
  const list=lipSyncWorkList(retainLipSyncSource(placed.second),{facePoints:points(),policy:LIPSYNC_POLICY});
  expect(list.heldUsdPerPass).toBe(5);expect(list.heldUsd).toBe(5);expect(studioLipSyncHoldUsd(list.items.filter(i=>i.included),LIPSYNC_POLICY)).toBe(5);
  const third=lipSyncPolicy({label:"Sync · third",accountRevision:"a".repeat(64),licenceEvidenceSha256:"b".repeat(64),priceEvidenceSha256:"c".repeat(64),outputHosts:["output.sync.so"],heldUsd:.333333,maxFrames:900,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
  const item=list.items[0]!;expect(studioLipSyncHoldUsd([item,item,item],third)).toBe(.999999);expect(studioLipSyncHoldUsd([],third)).toBe(0);
  expect(lipSyncWorkList(retainLipSyncSource(placed.second),{facePoints:points(),policy:third}).heldUsd).toBe(.333333);
});

test("with no policy the list holds nothing and no pass can be planned",()=>{
  const list=lipSyncWorkList(retainLipSyncSource(placed.second),{facePoints:points()});
  expect(list.policyRevision).toBeNull();expect(list.heldUsd).toBeNull();expect(list.heldUsdPerPass).toBeNull();expect(list.items[0]!.heldUsd).toBeNull();
  expect(()=>studioLipSyncRequestHash(list,list.items[0]!)).toThrow("current policy");
  expect(()=>studioLipSyncPlan(retainLipSyncSource(placed.second),list,list.items[0]!,LIPSYNC_POLICY,"local")).toThrow("Review the current lip-sync work list");
  // An off-camera or unsaved line is never planned, policy or not.
  const priced=lipSyncWorkList(retainLipSyncSource(placed.second),{facePoints:points(),policy:LIPSYNC_POLICY});
  for(const item of priced.items.slice(1))expect(()=>studioLipSyncRequestHash(priced,item)).toThrow("ready line");
});

test("a ready line queues as the owner's pass would, through the closed Sync transport, and its result is a new picture",async()=>{
  const source=retainLipSyncSource(placed.second),list=lipSyncWorkList(source,{facePoints:points(),policy:LIPSYNC_POLICY}),item=list.items[0]!;
  const plan=studioLipSyncPlan(source,list,item,LIPSYNC_POLICY,"local");
  // The plan is the existing owner plan: the owner's point, this cut's window, the policy's hold, and the work list's request.
  expect(plan).toEqual(createLipSyncPlan(source,item.shotId,item.lineIndex,owner.lipSync!.selection,LIPSYNC_POLICY,"local",studioLipSyncRequestHash(list,item),Date.parse(plan.admittedAt)));
  expect(plan.characterId).toBe(placed.marla);expect(plan.source.jobId).toBe(placed.second.id);
  // Fixed by the cut, the line and the policy: a retry asks with the same key and request.
  expect(studioLipSyncKey(list,item)).toBe(studioLipSyncKey(lipSyncWorkList(source,{facePoints:points(),policy:LIPSYNC_POLICY}),item));expect(studioLipSyncKey(list,item)).toMatch(/^studio-lipsync-[a-f0-9]{48}$/);
  // Its own queue, so the owner's pass (still queued, and the project's one running slot) stays as it is.
  const store=new DurableJobStore(join(root,"studio-jobs.json")),job=store.enqueue(lipFixtureJob(plan,crypto.randomUUID(),studioLipSyncKey(list,item)));expect(job.costCapUsd).toBe(5);expect(job.budgetReservedUsd).toBe(5);
  expect(store.claimNext(Date.now(),{},{workerId:"studio-lipsync"})!.id).toBe(job.id);
  const prepared=await prepareLipSyncMedia(job,placed.artifacts,join(placed.artifacts,job.projectId,job.id,"prepared"),async()=>{});store.checkpointLipSyncPrepared(job.id,"studio-lipsync",prepared);
  expect(prepared.rgbSha256).toBe(owner.lipSync!.selection.rgbSha256);
  const video=readFileSync(join(placed.artifacts,prepared.video.path)),audio=readFileSync(join(placed.artifacts,prepared.audio.path));let posts=0;
  const remote={id:crypto.randomUUID(),model:"sync-3",createdAt:new Date().toISOString(),status:"COMPLETED",outputUrl:"https://output.sync.so/fixture.mp4"};
  const provider=new SyncLipSyncProvider({apiKey:"closed-fixture-only",pollMs:1,fetchImpl:(async(url:unknown,init?:RequestInit)=>{if(init?.method==="POST")posts++;return String(url).includes("output.sync.so")?new Response(video):Response.json(remote,{status:init?.method==="POST"?201:200});}) as typeof fetch});
  const delivered=await provider.synthesize(plan,prepared,{video,audio},{authorize:async()=>({id:job.id,priceRevision:LIPSYNC_POLICY.priceRevision,heldUsd:LIPSYNC_POLICY.heldUsd}),assertCurrent:async()=>{},observe:async()=>{}});expect(posts).toBe(1);
  const output=await renderLipSyncVersion(job,prepared,delivered.video,delivered.delivery,placed.artifacts,join(placed.artifacts,job.projectId,job.id,"output"),async()=>{});
  store.checkpointLipSync(job.id,"studio-lipsync",output);const done=store.complete(job.id,"studio-lipsync",output);expect(done.status).toBe("done");
  // The pass's own output is a new encode: the owner's point does not stand on it, and the synced line is not listed again.
  const next=retainLipSyncSource(done),all=[...placed.store.all(),...store.all()],after=lipSyncWorkList(next,{facePoints:savedLipSyncFacePoints(all),policy:LIPSYNC_POLICY});
  expect(lipSyncPicture(next)).toStartWith("lipsync-export:");expect(reasons(after)).toEqual([["MARLA","already-synced"],["KEVIN","off-camera"],["MARLA","no-face-point"]]);expect(after.passes).toBe(0);
  // The studio's pass copied the owner's point and chose nothing, so it offers none: the list's point stays the owner's.
  expect(savedLipSyncFacePoints(all).filter(p=>p.picture===lipSyncPicture(source)).map(p=>p.jobId)).toEqual([owner.id]);
  expect(lipSyncWorkList(source,{facePoints:savedLipSyncFacePoints(all),policy:LIPSYNC_POLICY}).revision).toBe(list.revision);
},120000);

test("a line whose studio pass failed or was cancelled is the owner's to retry: the studio never buys it again by itself",()=>{
  const second=retainLipSyncSource(placed.second),list=lipSyncWorkList(second,{facePoints:points(),policy:LIPSYNC_POLICY}),item=list.items[0]!;
  const key=placed.project.id+":"+studioLipSyncKey(list,item);
  for(const status of ["failed","cancelled"] as const){
    const after=lipSyncWorkList(second,{facePoints:points(),policy:LIPSYNC_POLICY,studioPasses:[{idempotencyKey:key,status}]});
    expect(reasons(after)).toEqual([["MARLA","failed-pass"],["KEVIN","off-camera"],["MARLA","no-face-point"]]);
    expect(after.items[0]!.included).toBe(false);expect(after.items[0]!.selection).toBeNull();expect(after.passes).toBe(0);expect(after.heldUsd).toBe(0);expect(after.revision).not.toBe(list.revision);
  }
  // A live or finished pass under the key is the route's to list as holding; an owner's own failed pass, or one under another policy's key, is not the studio's.
  for(const studioPasses of [[{idempotencyKey:key,status:"queued" as const}],[{idempotencyKey:key,status:"done" as const}],[{idempotencyKey:placed.project.id+":owner-key",status:"failed" as const}],
    [{idempotencyKey:placed.project.id+":"+STUDIO_KEY_PREFIX+"0".repeat(48),status:"failed" as const}]])
    expect(lipSyncWorkList(second,{facePoints:points(),policy:LIPSYNC_POLICY,studioPasses}).revision).toBe(list.revision);
  // With no policy no studio pass can exist, so none is looked for.
  expect(reasons(lipSyncWorkList(second,{facePoints:points(),studioPasses:[{idempotencyKey:key,status:"failed"}]}))[0]).toEqual(["MARLA","ready"]);
  expect(LIPSYNC_WORK_REASONS["failed-pass"]).toContain("Direct lip-sync");
});

test("a face point is reused only while the owner's latest review of its pass, if any, is an accept with nothing under 3",()=>{
  const review=(decision:"accept"|"revise"|"cutaway",score=4,version=1)=>({version,outputRevision:"d".repeat(64),rubric:"owner-rubric/1" as const,mouthSync:score,faceStability:4,expression:4,decision,notes:"Checked on playback.",at:"2026-11-10T00:00:00.000Z",revision:"e".repeat(64)});
  const with_=(...entries:ReturnType<typeof review>[])=>savedLipSyncFacePoints([{...owner,status:"done",lipSyncReviews:{version:entries.length,entries}}]).map(p=>p.jobId);
  // Not yet reviewed: the owner chose the point on a decoded frame.
  expect(savedLipSyncFacePoints([{...owner,status:"done"}]).map(p=>p.jobId)).toEqual([owner.id]);
  expect(with_(review("accept"))).toEqual([owner.id]);expect(with_(review("accept",3))).toEqual([owner.id]);
  // A revise or a cutaway, or an accept that still rates something under 3, offers no point for a paid pass.
  expect(with_(review("revise"))).toEqual([]);expect(with_(review("cutaway"))).toEqual([]);expect(with_(review("accept",2))).toEqual([]);
  // The latest review decides.
  expect(with_(review("revise"),review("accept",4,2))).toEqual([owner.id]);expect(with_(review("accept"),review("cutaway",4,2))).toEqual([]);
  // So the ready line then needs a face point again.
  const pts=savedLipSyncFacePoints([{...owner,status:"done",lipSyncReviews:{version:1,entries:[review("revise")]}}]);
  expect(reasons(lipSyncWorkList(retainLipSyncSource(placed.second),{facePoints:pts,policy:LIPSYNC_POLICY}))[0]).toEqual(["MARLA","no-face-point"]);
});
