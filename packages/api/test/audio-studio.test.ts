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
