import { expect, test } from "bun:test";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import { ProjectService } from "../../api/src/index";
import { DurableJobStore } from "../../queue/src/index";
import { mintActorToken, verifyActorToken } from "../../api/src/actor-token";
import { mintProjectToken, verifyToken } from "../../api/src/tokens";
import { ACTOR_SHARE_TTL_MS, carriedReferenceLock, copiedActorReferences, validateActorShare } from "../src/actor-library";
import { currentCasting } from "../src/casting";
import { renderReferences } from "../src/reference-lock";
import type { ReferenceAsset } from "../src/references";
const now=Date.now();
function fixture() {
  process.env.HV_TOKEN_SECRET="actor-library-domain-fixture-secret-with-thirty-two-characters";
  const service=new ProjectService(),source=service.createAnonymousProject(now),destination=service.createAnonymousProject(now),id=crypto.randomUUID();
  service.editScript(source.token,CAST_SCRIPT,now);service.editScript(destination.token,"EXT. PARK - DAY\n\nSpud waves.",now);
  const casting=service.saveCharacter(source.token,id,{...CAST_INPUT,wardrobe:[...CAST_INPUT.wardrobe,{sceneNumber:2,description:"A blue jacket"}]},0,now)!;
  const share=service.shareCharacter(source.token,id,1,true,now)!,token=mintActorToken(share);
  return {service,source,destination,id,casting,share,token};
}
test("actor share tokens are purpose-bound, revision-bound, expiring and tamper evident",()=>{
  const f=fixture();expect(verifyActorToken(f.token,now)).toMatchObject({projectId:f.source.projectId,shareId:f.share.id,revision:f.share.revision});
  expect(verifyActorToken(f.token,now+ACTOR_SHARE_TTL_MS)).toBeNull();expect(verifyToken(f.token,now)).toBeNull();expect(verifyActorToken(mintProjectToken(f.source.projectId,now),now)).toBeNull();
  expect(verifyActorToken(f.token.slice(0,-1)+(f.token.endsWith("a")?"b":"a"),now)).toBeNull();
  expect(()=>validateActorShare({...f.share,character:{...f.share.character,appearance:"Changed"}},f.source.projectId)).toThrow("changed");
  expect(()=>f.service.shareCharacter(f.source.token,f.id,1,false,now)).toThrow("Confirm");
  expect(()=>f.service.shareCharacter(f.source.token,f.id,0,true,now)).toThrow("another session");
});
test("source permission narrowing, revocation, removal and project deletion invalidate future share access",async()=>{
  for(const change of ["scope","revoke","remove","delete"] as const) {
    const f=fixture();
    if(change==="scope")f.service.saveCharacter(f.source.token,f.id,{...CAST_INPUT,permission:{...CAST_INPUT.permission,scope:"scenes",sceneNumbers:[1]}},1,now);
    else if(change==="revoke")f.service.revokeCharacterPermission(f.source.token,f.id,1,now);
    else if(change==="remove")f.service.removeCharacter(f.source.token,f.id,1,now);
    else await f.service.takedown(f.source.projectId,"fixture",new DurableJobStore(null),now);
    expect(()=>f.service.sharedActor(f.token,now)).toThrow("unavailable");
  }
  const f=fixture();f.service.revokeActorShare(f.source.token,f.id,f.share.id,now);expect(()=>f.service.sharedActor(f.token,now)).toThrow("unavailable");
});
test("shared revisions stay pinned and imported costumes remain unbound until explicitly assigned",()=>{
  const f=fixture();f.service.saveCharacter(f.source.token,f.id,{...CAST_INPUT,appearance:"A different coat"},1,now);
  expect(f.service.sharedActor(f.token,now).character.appearance).toBe(CAST_INPUT.appearance);
  const imported=f.service.importSharedActor(f.destination.token,f.token,[],0,{name:"SPUD",aliases:[],attested:true},now)!;
  const actor=imported.characters[0]!;expect(actor.permission.status).toBe("pending");expect(actor.sceneBindings).toEqual([]);expect(actor.wardrobe).toEqual(CAST_INPUT.wardrobe);
  expect(actor.costumePresets).toEqual([{name:"Scene 2 — INT. KITCHEN - NIGHT",description:"A blue jacket"}]);expect(actor.libraryOrigin?.revision).toBe(f.share.revision);
  expect(()=>f.service.useCostumePreset(f.destination.token,actor.id,0,1,1,false,now,0)).toThrow("screenplay changed");
  const applied=f.service.useCostumePreset(f.destination.token,actor.id,0,1,1,false,now,1)!;expect(applied.characters[0]!.wardrobe[1]).toEqual({sceneNumber:1,description:"A blue jacket"});
  expect(applied.characters[0]!.sceneBindings).toEqual([{sceneNumber:1,heading:"EXT. PARK - DAY"}]);
  f.service.saveCharacter(f.destination.token,actor.id,CAST_INPUT,2,now);const saved=currentCasting(f.destination.projectId,f.service.authorize(f.destination.token,now)!.castingHistory);
  expect(saved.characters[0]!.costumePresets).toEqual(actor.costumePresets);expect(saved.characters[0]!.libraryOrigin).toEqual(actor.libraryOrigin);
  f.service.revokeActorShare(f.source.token,f.id,f.share.id,now);
  expect(currentCasting(f.destination.projectId,f.service.authorize(f.destination.token,now)!.castingHistory)).toEqual(saved);
  const restored=ProjectService.fromState(f.service.snapshot());expect(()=>restored.sharedActor(f.token,now)).toThrow("unavailable");
  expect(restored.authorize(f.destination.token,now)!.castingHistory).toEqual(f.service.authorize(f.destination.token,now)!.castingHistory);
});
test("share permission term bounds links and active share capacity can be recovered by revocation",()=>{
  const f=fixture();for(let i=1;i<48;i++)f.service.shareCharacter(f.source.token,f.id,1,true,now);
  expect(()=>f.service.shareCharacter(f.source.token,f.id,1,true,now)).toThrow("48 active");f.service.revokeActorShare(f.source.token,f.id,f.share.id,now);
  expect(f.service.shareCharacter(f.source.token,f.id,1,true,now)).toBeTruthy();expect(f.service.authorize(f.source.token,now)!.actorShares).toHaveLength(48);
  const g=fixture();g.service.saveCharacter(g.source.token,g.id,{...CAST_INPUT,permission:{...CAST_INPUT.permission,expiresAt:new Date(now+1000).toISOString()}},1,now);
  const limited=g.service.shareCharacter(g.source.token,g.id,2,true,now)!;expect(Date.parse(limited.expiresAt)).toBe(now+1000);expect(verifyActorToken(mintActorToken(limited),now+1001)).toBeNull();
});

/** A source actor with three images, uploaded in the order one, two, three, optionally locked to [three, one]. */
function lockedFixture(lock=true) {
  process.env.HV_TOKEN_SECRET="actor-library-domain-fixture-secret-with-thirty-two-characters";
  const service=new ProjectService(),source=service.createAnonymousProject(now),destination=service.createAnonymousProject(now),id=crypto.randomUUID();
  service.editScript(source.token,CAST_SCRIPT,now);service.editScript(destination.token,"EXT. PARK - DAY\n\nSpud waves.",now);
  service.saveCharacter(source.token,id,CAST_INPUT,0,now);
  const images:ReferenceAsset[]=["c","d","e"].map(seed=>({schema:"hv-reference/1",id:crypto.randomUUID(),projectId:source.projectId,sha256:seed.repeat(64),originalSha256:"b".repeat(64),
    bytes:4096,width:512,height:512,contentType:"image/png",createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()}));
  let version=1;for(const image of images)service.addCharacterReference(source.token,id,image,version++,now);
  if(lock)service.saveCharacterReferenceLock(source.token,id,{assetIds:[images[2]!.id,images[0]!.id],label:"Act two, after the storm",note:"The coat and the glasses."},version++,now);
  const creator=currentCasting(source.projectId,service.authorize(source.token,now)!.castingHistory).characters[0]!;
  const share=service.shareCharacter(source.token,id,version,true,now)!,token=mintActorToken(share),copies=copiedActorReferences(share,destination.projectId,now);
  return {service,source,destination,id,images,creator,share,token,copies};
}
/**
 * HV-017-15, criteria 1 and 2. The share already records the creator's lock -- ordered image ids and
 * each image's sha256 -- and the import rebuilds it over this project's copies, so the imported actor
 * renders from the same pictures in the same order, not in upload order.
 */
test("a shared actor keeps the look its creator locked, rendering the same images in the same order",()=>{
  const f=lockedFixture();
  expect(f.share.character.referenceLock!.assets).toEqual([{id:f.images[2]!.id,sha256:f.images[2]!.sha256},{id:f.images[0]!.id,sha256:f.images[0]!.sha256}]);
  const imported=f.service.importSharedActor(f.destination.token,f.token,f.copies,0,{name:"SPUD",aliases:[],attested:true},now+1000)!,actor=imported.characters[0]!;
  const copyOf=(image:ReferenceAsset)=>f.copies.find(copy=>copy.source?.kind==="actor-share"&&copy.source.assetId===image.id)!;
  expect(actor.referenceLock!.assets).toEqual([{id:copyOf(f.images[2]!).id,sha256:f.images[2]!.sha256},{id:copyOf(f.images[0]!).id,sha256:f.images[0]!.sha256}]);
  expect(actor.referenceLock).toMatchObject({label:"Act two, after the storm",note:"The coat and the glasses.",lockedAt:new Date(now+1000).toISOString()});
  expect(renderReferences(actor).map(asset=>asset.sha256)).toEqual(renderReferences(f.creator).map(asset=>asset.sha256));
  expect(renderReferences(actor).map(asset=>asset.sha256)).toEqual([f.images[2]!.sha256,f.images[0]!.sha256]);
  expect(renderReferences(actor).every(asset=>asset.projectId===f.destination.projectId)).toBe(true);
  // What was saved is what renders: the destination's stored cast carries the rebuilt lock, and survives a reload.
  const stored=ProjectService.fromState(f.service.snapshot()).authorize(f.destination.token,now)!;
  expect(currentCasting(f.destination.projectId,stored.castingHistory).characters[0]!.referenceLock).toEqual(actor.referenceLock!);
});
/**
 * HV-017-15, criterion 3. A lock is carried whole or not at all: a locked image with no copy, or a copy
 * whose bytes are not the ones locked, leaves the actor unlocked with a plain note, never half-locked.
 */
test("a locked image that is missing or changed leaves the imported actor unlocked, with a note saying why",()=>{
  const f=lockedFixture(),lock=f.share.character.referenceLock!;
  const missing=carriedReferenceLock(lock,f.copies.filter(copy=>copy.source?.kind==="actor-share"&&copy.source.assetId!==f.images[0]!.id),now);
  expect(missing.referenceLock).toBeUndefined();
  expect(missing.note).toBe("The locked look \u201cAct two, after the storm\u201d was not carried over: locked image 2 was not copied into this project. The actor was imported unlocked; lock its look again from its images here.");
  const tampered=carriedReferenceLock(lock,f.copies.map(copy=>copy.source?.kind==="actor-share"&&copy.source.assetId===f.images[2]!.id?{...copy,sha256:"9".repeat(64)}:copy),now);
  expect(tampered.referenceLock).toBeUndefined();
  expect(tampered.note).toContain("the copy of locked image 1 is not the picture that was locked. The actor was imported unlocked");
  // The whole lock is judged before any of it is built: the first image being fine does not make a one-image lock.
  const second=carriedReferenceLock(lock,f.copies.map(copy=>copy.source?.kind==="actor-share"&&copy.source.assetId===f.images[0]!.id?{...copy,sha256:"9".repeat(64)}:copy),now);
  expect(second).toEqual({note:expect.stringContaining("locked image 2 is not the picture")});
  // And an import handed copies that differ from the share is still refused outright, as before.
  expect(()=>f.service.importSharedActor(f.destination.token,f.token,f.copies.map((copy,index)=>index===2?{...copy,sha256:"9".repeat(64)}:copy),0,{name:"SPUD",aliases:[],attested:true},now)).toThrow("do not match");
});
/**
 * HV-017-15, criterion 4. A share of an actor that was never locked -- which is also what every share
 * minted before locks existed looks like -- imports as it did: no lock, no note, upload order.
 */
test("a share of an unlocked actor, like one minted before locks, imports exactly as before",()=>{
  const f=lockedFixture(false);expect(f.share.character.referenceLock).toBeUndefined();expect("referenceLock" in f.share.character).toBe(false);
  expect(carriedReferenceLock(f.share.character.referenceLock,f.copies,now)).toEqual({});
  const restored=ProjectService.fromState(f.service.snapshot());
  const actor=restored.importSharedActor(f.destination.token,f.token,f.copies,0,{name:"SPUD",aliases:[],attested:true},now)!.characters[0]!;
  expect("referenceLock" in actor).toBe(false);
  expect(renderReferences(actor).map(asset=>asset.id)).toEqual(f.copies.map(copy=>copy.id));
  expect(renderReferences(actor).map(asset=>asset.sha256)).toEqual(f.images.map(image=>image.sha256));
});
