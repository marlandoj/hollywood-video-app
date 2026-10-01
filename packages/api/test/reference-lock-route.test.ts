import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {DeterministicMockImageProvider} from "../../generator/src/image";
import {CAST_INPUT,CAST_SCRIPT} from "../../../test/fixtures/casting";
import type {CastingSnapshot} from "../../planner/src/casting";
import type {ReferenceAsset} from "../../planner/src/references";

const root=mkdtempSync(join(tmpdir(),"hv-reference-lock-api-"));
let server:ReturnType<typeof createApiServer>,first:Buffer,second:Buffer;
beforeAll(async()=>{
  process.env.HV_TOKEN_SECRET="reference-lock-api-fixture-secret-with-thirty-two-characters";
  const provider=new DeterministicMockImageProvider();
  first=readFileSync((await provider.generateFrame("A fictional potato in a scarf",7,{},join(root,"one.png"))).path);
  second=readFileSync((await provider.generateFrame("A fictional potato in a hat",11,{},join(root,"two.png"))).path);
  server=createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),
    artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json"),rateLimit:{api:{limit:1000,windowMs:60000}}});
});
afterAll(async()=>{await server?.stop(true);rmSync(root,{recursive:true,force:true});});
const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,
  headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});

async function fixture(){
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string};
  const base="/api/projects/"+owner.projectId,id=crypto.randomUUID();
  await call(base+"/script","PUT",{text:CAST_SCRIPT},owner.token);
  await call(base+"/rights","POST",{attested:true},owner.token);
  await call(base+"/cast/"+id,"PUT",{expectedVersion:0,character:CAST_INPUT},owner.token);
  const upload=async(data:Buffer,version:number)=>{
    const response=await fetch(new URL(base+"/cast/"+id+"/references",server.url),{method:"POST",
      headers:{authorization:"Bearer "+owner.token,"content-type":"image/png","x-hv-cast-version":String(version),"x-hv-reference-attested":"true"},body:new Uint8Array(data)});
    expect(response.status).toBe(201);return(await response.json() as {asset:ReferenceAsset}).asset;};
  const cast=async()=>(await(await call(base+"/cast","GET",undefined,owner.token)).json() as {casting:CastingSnapshot}).casting;
  return {owner,base,id,upload,cast};
}

test("a character's look is locked to images it holds, and the lock survives a later cast save",async()=>{
  const f=await fixture(),one=await f.upload(first,1),two=await f.upload(second,2);
  const lock=(body:unknown,token=f.owner.token)=>call(f.base+"/cast/"+f.id+"/reference-lock","PUT",body,token);

  expect((await lock({expectedVersion:3,lock:{assetIds:[two.id,one.id],label:"Act two, after the storm",note:"The scarf stays."}})).status).toBe(200);
  const saved=(await f.cast()).characters[0]!;
  expect(saved.referenceLock!.assets).toEqual([{id:two.id,sha256:two.sha256},{id:one.id,sha256:one.sha256}]);
  expect(saved.referenceLock!.label).toBe("Act two, after the storm");

  // Optimistic on the cast version, owner-only, and never locked to an image the character does not hold.
  expect((await lock({expectedVersion:3,lock:{assetIds:[one.id],label:"Stale"}})).status).toBe(409);
  const other=await(await call("/api/projects","POST")).json() as {token:string};
  expect((await lock({expectedVersion:4,lock:{assetIds:[one.id],label:"Not yours"}},other.token)).status).toBe(401);
  expect((await lock({expectedVersion:4,lock:{assetIds:[crypto.randomUUID()],label:"Missing"}})).status).toBe(400);
  expect((await lock({expectedVersion:4,lock:{assetIds:[one.id],label:""}})).status).toBe(400);

  // A creator's own character save carries no images, so it must not drop the look they locked.
  expect((await call(f.base+"/cast/"+f.id,"PUT",{expectedVersion:4,character:{...CAST_INPUT,arcNotes:"Learns to ask twice"}},f.owner.token)).status).toBe(200);
  const resaved=(await f.cast()).characters[0]!;
  expect(resaved.arcNotes).toBe("Learns to ask twice");
  expect(resaved.referenceLock!.assets.map(asset=>asset.id)).toEqual([two.id,one.id]);
});

test("a locked image cannot be removed by accident, and unlocking is the creator's own decision",async()=>{
  const f=await fixture(),one=await f.upload(first,1),two=await f.upload(second,2);
  const lock=(body:unknown)=>call(f.base+"/cast/"+f.id+"/reference-lock","PUT",body,f.owner.token);
  const remove=(assetId:string,expectedVersion:number)=>call(f.base+"/cast/"+f.id+"/references/"+assetId+"/remove","POST",{expectedVersion},f.owner.token);

  expect((await lock({expectedVersion:3,lock:{assetIds:[two.id],label:"The hat"}})).status).toBe(200);
  const refused=await remove(two.id,4);
  expect(refused.status).toBe(409);
  expect((await refused.json() as {error:string}).error).toContain("locked look");
  // An image outside the lock is still the creator's to remove.
  expect((await remove(one.id,4)).status).toBe(200);
  expect((await f.cast()).characters[0]!.referenceLock!.assets.map(asset=>asset.id)).toEqual([two.id]);

  expect((await lock({expectedVersion:5,lock:null})).status).toBe(200);
  expect((await f.cast()).characters[0]!.referenceLock).toBeUndefined();
  expect((await remove(two.id,6)).status).toBe(200);
  expect((await f.cast()).characters[0]!.references ?? []).toEqual([]);
});

test("adopting a sheet over a locked look is refused by name, not by the snapshot validator",async()=>{
  // HV-017-10: replacing the images a lock names left the look pointing at images the character no
  // longer held, and the failure surfaced as "Lock this character's look to images the character
  // already retains" — a message that names no character and says nothing about unlocking.
  const {ProjectService}=await import("../src/index");
  const service=new ProjectService(join(root,"replace-projects.json"));
  const owner=service.createAnonymousProject();
  service.editScript(owner.token,CAST_SCRIPT);
  const id=crypto.randomUUID();
  service.saveCharacter(owner.token,id,CAST_INPUT,0);
  const asset=(seed:string)=>({schema:"hv-reference/1" as const,id:crypto.randomUUID(),projectId:owner.projectId,
    sha256:seed.repeat(64).slice(0,64),originalSha256:"b".repeat(64),bytes:4096,width:512,height:512,contentType:"image/png" as const,
    createdAt:new Date().toISOString(),attestedAt:new Date().toISOString()});
  const held=asset("a");
  service.addCharacterReference(owner.token,id,held,1);
  service.saveCharacterReferenceLock(owner.token,id,{assetIds:[held.id],label:"The scarf"},2);
  expect(()=>service.addCharacterReferences(owner.token,id,[asset("c")],3,Date.now(),{replaceExisting:true}))
    .toThrow("Replacing these images would break SPUD's locked look");
  // Adding beside the locked images is still fine, and the lock still names what it named.
  const added=service.addCharacterReferences(owner.token,id,[asset("d")],3)!;
  expect(added.characters[0]!.references).toHaveLength(2);
  expect(added.characters[0]!.referenceLock!.assets.map(value=>value.id)).toEqual([held.id]);
  // Unlocked, the replacement goes through.
  service.saveCharacterReferenceLock(owner.token,id,null,added.version);
  const replaced=service.addCharacterReferences(owner.token,id,[asset("e")],added.version+1,Date.now(),{replaceExisting:true})!;
  expect(replaced.characters[0]!.references).toHaveLength(1);
});

/**
 * HV-017-16. A look's name and note are creator text, and the lock route kept both unread by the
 * content policy. A name or note naming a public figure, or a brand, is now refused with a message
 * that says which field to change, and nothing is saved: the cast version does not move.
 */
test("a locked look whose name or note falls outside the content policy is refused, and nothing is saved",async()=>{
  const f=await fixture(),one=await f.upload(first,1);
  const lock=(body:unknown)=>call(f.base+"/cast/"+f.id+"/reference-lock","PUT",body,f.owner.token);

  for(const [label,note,says] of [["Taylor Swift on tour","","names a real person or a public figure"],["Act two","Dressed like Mickey Mouse","falls outside the content policy"]] as const) {
    const refused=await lock({expectedVersion:2,lock:{assetIds:[one.id],label,note}});
    expect(refused.status).toBe(400);
    const error=(await refused.json() as {error:string}).error;
    expect(error).toContain(says);
    expect(error).toContain("Rename the look or change its note");
    const cast=await f.cast();
    expect(cast.version).toBe(2);
    expect(cast.characters[0]!.referenceLock).toBeUndefined();
  }
  // The same image under a clean name locks as before.
  expect((await lock({expectedVersion:2,lock:{assetIds:[one.id],label:"Act two",note:"The scarf stays."}})).status).toBe(200);
});
