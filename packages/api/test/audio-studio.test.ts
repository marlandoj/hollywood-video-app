import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {createActorShare,importedActor} from "../../planner/src/actor-library";
import {currentCasting,validateCasting} from "../../planner/src/casting";
import {contentHash} from "../../generator/src/capabilities";
import {validateSnapshot} from "../../storage/src/snapshots";
import {CAST_INPUT,CAST_SCRIPT} from "../../../test/fixtures/casting";
import {AUDIO_POLICY} from "../../../test/fixtures/audio";
import {parseFountain} from "../../parser/src/index";
import {scenePerformanceSource} from "../../planner/src/performance-memory";
import {AZURE_POLICY,AZURE_PROFILE} from "../../../test/fixtures/azure-audio";
import {AZURE_AUDIO_CAPABILITY} from "../../generator/src/azure-capability";
import {compileAudioLine} from "../../planner/src/audio-performances";
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});
async function fixture(){
  process.env.HV_TOKEN_SECRET="audio-studio-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-audio-studio-")),statePath=join(root,"projects.json"),policies=[AUDIO_POLICY],server=createApiServer({port:0,hostname:"127.0.0.1",statePath,queuePath:join(root,"jobs.json"),costLedgerPath:join(root,"costs.json"),artifactRoot:join(root,"media"),audioPolicies:()=>policies,rateLimit:{api:{limit:10000,windowMs:60000}}});fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as any,base="/api/projects/"+owner.projectId,id=crypto.randomUUID(),character={...CAST_INPUT,voice:{voice:"en-us+m3",rateWpm:140}};
  await call(base+"/script","PUT",{text:CAST_SCRIPT},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);expect((await call(base+"/cast/"+id,"PUT",{expectedVersion:0,character},owner.token)).status).toBe(200);
  const body={expectedVersion:1,voiceId:AUDIO_POLICY.voiceId,policyRevision:AUDIO_POLICY.revision,controls:{speed:1.2,volume:.9,emotion:"calm"},pronunciations:[{word:"Spud",say:"Spudd"}]};
  const view=async()=>await(await call(base+"/audio-takes","GET",undefined,owner.token)).json() as any;
  return {root,server,statePath,policies,call,owner,base,id,body,character,view};
}
test("native voice catalogue controls persist in cast history with provider-specific capabilities and fresh import permission",async()=>{
  const f=await fixture();f.policies.push(AZURE_POLICY);const path=f.base+"/cast/"+f.id+"/audio-voice",body={...f.body,voiceId:AZURE_POLICY.voiceId,policyRevision:AZURE_POLICY.revision,controls:AZURE_PROFILE.controls};
  expect((await f.call(path,"PUT",{...body,controls:{...body.controls,emotion:"calm"}},f.owner.token)).status).toBe(400);expect((await f.call(path,"PUT",body,f.owner.token)).status).toBe(200);
  const view=await f.view();expect(view.nativeCapabilityRevision).toBe(AZURE_AUDIO_CAPABILITY.revision);expect(view.voices.find((v:any)=>v.id===AZURE_POLICY.voiceId).styles).toContain("sad");expect(view.characters[0].profile.schema).toBe("hv-audio-voice/2");expect(view.characters[0].profile.controls).toEqual(AZURE_PROFILE.controls);
  const state=new ProjectService(f.statePath).snapshot();expect(validateSnapshot({schema:"hv-state/1",projects:state,jobs:[],reviews:[],ledger:{events:[],reservations:[]}}).projects).toEqual(state);const cast=currentCasting(f.owner.projectId,state.projects[0]!.castingHistory),share=createActorShare(cast,f.id,state.projects[0]!.deleteAfter),copy=importedActor(share,crypto.randomUUID(),crypto.randomUUID(),"Imported Spud",[],[]);expect(copy.audioVoice).toBeUndefined();
});
test("expressive character defaults persist alongside temporary voices, survive ordinary edits and restore in cast history",async()=>{
  const f=await fixture(),path=f.base+"/cast/"+f.id+"/audio-voice";
  expect((await f.call(path,"PUT",f.body,f.owner.token)).status).toBe(200);
  const view=await f.view(),actor=view.characters[0];expect(view.enabled).toBe(false);expect(view.castingVersion).toBe(2);expect(actor.voiceAvailable).toBe(true);expect(actor.profile.controls).toEqual(f.body.controls);
  expect(actor.profileRevision).toBe(contentHash(actor.profile));expect(view.lines[0].source.text).toBe("Hello, friend.");expect(view.lines[0].unavailable).toBeNull();
  expect((await f.call(f.base+"/cast/"+f.id,"PUT",{expectedVersion:2,character:{...f.character,appearance:"A cheerful potato with a scarf."}},f.owner.token)).status).toBe(200);
  const projects=new ProjectService(f.statePath),snapshot=projects.snapshot(),casting=currentCasting(f.owner.projectId,snapshot.projects[0]!.castingHistory);
  expect(casting.characters[0]!.voice!.rateWpm).toBe(140);expect(casting.characters[0]!.audioVoice).toEqual(actor.profile);expect(validateCasting(casting,f.owner.projectId)).toEqual(casting);
  expect(validateSnapshot({schema:"hv-state/1",projects:snapshot,jobs:[],reviews:[],ledger:{events:[],reservations:[]}}).projects).toEqual(snapshot);
  const malformed=structuredClone(casting);malformed.characters[0]!.audioVoice!.controls.speed=2;expect(()=>validateCasting(malformed,f.owner.projectId)).toThrow();
  expect((await f.call(path,"PUT",{expectedVersion:3,clear:true},f.owner.token)).status).toBe(200);expect((await f.view()).characters[0].profile).toBeNull();
  expect((await f.call(f.base+"/cast/restore","POST",{expectedVersion:4,version:2},f.owner.token)).status).toBe(200);expect((await f.view()).characters[0].profile).toEqual(actor.profile);expect((await f.view()).lines[0].unavailable).toContain("not permitted");
});
test("only the owner can save current catalogue profiles, with explicit removal and optimistic cast versions",async()=>{
  const f=await fixture(),path=f.base+"/cast/"+f.id+"/audio-voice",foreign=await(await f.call("/api/projects","POST")).json() as any;
  expect((await f.call(path,"PUT",f.body,foreign.token)).status).toBe(401);
  const review=await(await f.call(f.base+"/reviews","POST",{permission:"read"},f.owner.token)).json() as any;expect((await f.call(path,"PUT",f.body,review.token)).status).toBe(401);
  for(const patch of [{policyRevision:"f".repeat(64)},{voiceId:crypto.randomUUID()},{expectedVersion:0},{profile:{permissionRevision:"a".repeat(64)}},{controls:{...f.body.controls,pitch:40}},{clear:true}])
    expect((await f.call(path,"PUT",{...f.body,...patch},f.owner.token)).status).toBeOneOf([400,409]);
  expect((await f.view()).castingVersion).toBe(1);
  expect((await f.call(path,"PUT",f.body,f.owner.token)).status).toBe(200);f.policies.splice(0);
  const unavailable=await f.view();expect(unavailable.characters[0].voiceAvailable).toBe(false);expect(unavailable.voices).toEqual([]);expect(unavailable.characters[0].profile).toBeTruthy();
  expect((await f.call(path,"PUT",{...f.body,expectedVersion:2},f.owner.token)).status).toBe(409);expect((await f.call(path,"PUT",{expectedVersion:2,clear:true},f.owner.token)).status).toBe(200);
});
test("actor import requires a fresh expressive voice assignment while retaining temporary voice and provenance",async()=>{
  const f=await fixture();await f.call(f.base+"/cast/"+f.id+"/audio-voice","PUT",f.body,f.owner.token);
  const source=new ProjectService(f.statePath).snapshot().projects[0]!,cast=currentCasting(source.id,source.castingHistory),share=createActorShare(cast,f.id,source.deleteAfter),copy=importedActor(share,crypto.randomUUID(),crypto.randomUUID(),"Imported Spud",[],[]);
  expect(share.character.audioVoice).toBeTruthy();expect(copy.audioVoice).toBeUndefined();expect(copy.voice).toEqual(share.character.voice);expect(copy.permission.status).toBe("pending");expect(copy.libraryOrigin!.revision).toBe(share.revision);
  const original=JSON.parse(readFileSync(f.statePath,"utf8"));expect(original.projects[0].castingHistory.at(-1).characters[0].audioVoice).toBeTruthy();
});
test("scene intent persists through ordinary edits and snapshots, binds silent scenes, and is removed from actor imports",async()=>{
  const f=await fixture(),path=f.base+"/cast/"+f.id+"/scene-performance",view=await f.view();expect(view.scenes).toHaveLength(2);expect(view.scenes[1].text).toContain("carries a basket");
  const save=(sceneNumber:number,expectedVersion:number,notes:string)=>f.call(path,"PUT",{expectedVersion,expectedScriptVersion:1,sceneNumber,sourceHash:view.scenes[sceneNumber-1].sourceHash,notes,controls:{emotion:"calm",speed:.8}},f.owner.token);
  expect((await save(1,1,"Hide the disappointment behind a smile.")).status).toBe(200);expect((await save(2,2,"Carry the basket with quiet pride.")).status).toBe(200);
  const current=await f.view(),memory=current.characters[0].scenePerformances;expect(current.lines[0].memory).toEqual(memory[0]);expect(current.lines[0].performanceRevision).toBe(memory[0].revision);
  expect((await f.call(f.base+"/cast/"+f.id,"PUT",{expectedVersion:3,character:f.character},f.owner.token)).status).toBe(200);
  const state=new ProjectService(f.statePath).snapshot(),cast=currentCasting(f.owner.projectId,state.projects[0]!.castingHistory);expect(cast.characters[0]!.scenePerformances).toEqual(memory);
  expect(validateSnapshot({schema:"hv-state/1",projects:state,jobs:[],reviews:[],ledger:{events:[],reservations:[]}}).projects).toEqual(state);
  const share=createActorShare(cast,f.id,state.projects[0]!.deleteAfter),copy=importedActor(share,crypto.randomUUID(),crypto.randomUUID(),"Imported Spud",[],[]);expect(share.character.scenePerformances).toEqual(memory);expect(copy.scenePerformances).toBeUndefined();
  expect((await f.call(path,"PUT",{expectedVersion:4,expectedScriptVersion:1,sceneNumber:1,sourceHash:view.scenes[0].sourceHash,remove:true},f.owner.token)).status).toBe(200);
  expect((await f.view()).lines[0].memory).toBeNull();expect((await f.call(f.base+"/cast/restore","POST",{expectedVersion:5,version:3},f.owner.token)).status).toBe(200);expect((await f.view()).characters[0].scenePerformances).toEqual(memory);
});
test("owner scene styles survive reload and restore, initialize reads, and can be cleared without losing other direction",async()=>{
  const f=await fixture(),path=f.base+"/cast/"+f.id+"/scene-performance",view=await f.view(),body={expectedVersion:1,expectedScriptVersion:1,sceneNumber:1,sourceHash:view.scenes[0].sourceHash,notes:"A private welcome.",controls:{speed:.8},nativeVoice:{style:"whispering",intensity:1.6},picture:{emotion:"calm"}};
  expect(view.sceneNativeStyles).toContain("whispering");
  for(const patch of [{nativeVoice:{style:"neutral",intensity:2}},{nativeVoice:{style:"sad",intensity:.015}},{remove:true}])expect((await f.call(path,"PUT",{...body,...patch},f.owner.token)).status).toBe(400);
  expect((await f.call(path,"PUT",body,f.owner.token)).status).toBe(200);
  const saved=await f.view(),memory=saved.lines[0].memory;expect(memory.schema).toBe("hv-scene-performance/3");expect(memory.nativeVoice).toEqual(body.nativeVoice);
  expect(compileAudioLine(saved.lines[0].source,AZURE_PROFILE,undefined,undefined,memory).profile.controls).toMatchObject(body.nativeVoice);
  const snapshot=new ProjectService(f.statePath).snapshot();expect(validateSnapshot({schema:"hv-state/1",projects:snapshot,jobs:[],reviews:[],ledger:{events:[],reservations:[]}}).projects).toEqual(snapshot);
  expect((await f.call(path,"PUT",{...body,expectedVersion:2,nativeVoice:undefined},f.owner.token)).status).toBe(200);
  const cleared=(await f.view()).lines[0].memory;expect(cleared.schema).toBe("hv-scene-performance/2");expect(cleared).not.toHaveProperty("nativeVoice");expect(cleared.picture).toEqual(body.picture);expect(cleared.notes).toBe(body.notes);expect(cleared.controls).toEqual(body.controls);
  expect((await f.call(f.base+"/cast/restore","POST",{expectedVersion:3,version:2},f.owner.token)).status).toBe(200);expect((await f.view()).lines[0].memory).toEqual(memory);
});
test("scene writes reject foreign owners, stale scene/cast/script reviews and hidden fields; removed scenes can be cleared",async()=>{
  const f=await fixture(),path=f.base+"/cast/"+f.id+"/scene-performance",view=await f.view(),body={expectedVersion:1,expectedScriptVersion:1,sceneNumber:1,sourceHash:view.scenes[0].sourceHash,notes:"An uncertain greeting."},foreign=await(await f.call("/api/projects","POST")).json() as any;
  expect((await f.call(path,"PUT",body,foreign.token)).status).toBe(401);
  for(const patch of [{expectedVersion:0},{expectedScriptVersion:0},{sourceHash:"f".repeat(64)},{sceneNumber:0},{controls:{pitch:4}},{notes:""},{revision:"forged"}])expect((await f.call(path,"PUT",{...body,...patch},f.owner.token)).status).toBeOneOf([400,409]);
  expect((await f.call(path,"PUT",body,f.owner.token)).status).toBe(200);
  const changed=CAST_SCRIPT.replace("waves","waits");await f.call(f.base+"/script","PUT",{text:changed},f.owner.token);const stale=await f.view();expect(stale.lines[0].source.hash).toBe(view.lines[0].source.hash);expect(stale.lines[0].unavailable).toContain("saved character performance");
  expect((await f.call(path,"PUT",{...body,expectedVersion:2,expectedScriptVersion:2},f.owner.token)).status).toBe(409);
  expect((await f.call(path,"PUT",{...body,expectedVersion:2,expectedScriptVersion:2,sourceHash:scenePerformanceSource(parseFountain(changed).scenes[0]!)},f.owner.token)).status).toBe(200);expect((await f.view()).lines[0].unavailable).toBeNull();
  expect((await f.call(path,"PUT",{...body,expectedVersion:3,expectedScriptVersion:2,sceneNumber:2,sourceHash:view.scenes[1].sourceHash},f.owner.token)).status).toBe(200);
  expect((await f.call(f.base+"/script","PUT",{text:changed.split("INT. KITCHEN")[0]},f.owner.token)).status).toBe(200);expect((await f.view()).scenes).toHaveLength(1);
  expect((await f.call(path,"PUT",{expectedVersion:4,expectedScriptVersion:3,sceneNumber:2,sourceHash:null,remove:true},f.owner.token)).status).toBe(200);expect((await f.view()).characters[0].scenePerformances.map((p:any)=>p.sceneNumber)).toEqual([1]);
});
