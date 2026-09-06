import { expect, test } from "bun:test";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import { ProjectService } from "../../api/src/index";
import { mintActorToken, verifyActorToken } from "../../api/src/actor-token";
import { mintProjectToken, verifyToken } from "../../api/src/tokens";
import { ACTOR_SHARE_TTL_MS, validateActorShare } from "../src/actor-library";
import { currentCasting } from "../src/casting";
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
test("source permission narrowing, revocation, removal and project deletion invalidate future share access",()=>{
  for(const change of ["scope","revoke","remove","delete"] as const) {
    const f=fixture();
    if(change==="scope")f.service.saveCharacter(f.source.token,f.id,{...CAST_INPUT,permission:{...CAST_INPUT.permission,scope:"scenes",sceneNumbers:[1]}},1,now);
    else if(change==="revoke")f.service.revokeCharacterPermission(f.source.token,f.id,1,now);
    else if(change==="remove")f.service.removeCharacter(f.source.token,f.id,1,now);
    else f.service.takedown(f.source.projectId,"fixture",now);
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
