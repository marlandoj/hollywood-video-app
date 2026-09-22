import {expect,test} from "bun:test";
import {CAST_INPUT,CAST_SCRIPT} from "../../../test/fixtures/casting";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord,directCast} from "../src/casting";
import {copiedActorReferences,createActorShare,importedActor} from "../src/actor-library";
import {lockedReferences,referenceLockRecord,renderReferences,validateReferenceLock} from "../src/reference-lock";

const now=Date.UTC(2026,8,22);
const ID="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const parsed=parseFountain(CAST_SCRIPT),shots=planShots(parsed,7000,24);
const image=(seed:string)=>({schema:"hv-reference/1" as const,id:"11111111-2222-4333-8444-"+seed.repeat(12).slice(0,12),projectId:"project-1",
  sha256:seed.repeat(64).slice(0,64),originalSha256:"b".repeat(64),bytes:4096,width:512,height:512,contentType:"image/png" as const,
  createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()});
const [one,two,three,four]=["c","d","e","f"].map(image);
const actor=(references=[one!,two!,three!],referenceLock?:unknown)=>characterRecord({...CAST_INPUT,
  permission:{status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()},
  sceneBindings:[],references,...(referenceLock===undefined?{}:{referenceLock})},ID,now,true);
const locked=(assetIds:string[],label="Act two, after the storm")=>referenceLockRecord({assetIds,label,note:"The coat and the glasses."},[one!,two!,three!],now);

test("a locked look names images the character already retains, in the order the render will use them",()=>{
  const lock=locked([three!.id,one!.id]);
  expect(lock.schema).toBe("hv-reference-lock/1");
  expect(lock.assets).toEqual([{id:three!.id,sha256:three!.sha256},{id:one!.id,sha256:one!.sha256}]);
  expect(lock.label).toBe("Act two, after the storm");expect(lock.lockedAt).toBe(new Date(now).toISOString());
  // The same choice is the same lock; a different order is a different lock, because order is what renders.
  expect(referenceLockRecord({assetIds:[three!.id,one!.id],label:"Act two, after the storm",note:"The coat and the glasses."},[one!,two!,three!],now).revision).toBe(lock.revision);
  expect(locked([one!.id,three!.id]).revision).not.toBe(lock.revision);
  for(const input of [{assetIds:[four!.id],label:"x"},{assetIds:[],label:"x"},{assetIds:[one!.id,one!.id],label:"x"},
    {assetIds:[one!.id,two!.id,three!.id,one!.id,two!.id],label:"x"},{assetIds:[one!.id],label:""},{assetIds:[one!.id],label:"x".repeat(121)},
    {assetIds:[one!.id],label:"x",extra:"secret"},{assetIds:one!.id,label:"x"}])
    expect(()=>referenceLockRecord(input,[one!,two!,three!],now)).toThrow();
});

test("a stored lock is re-judged against the images the character actually holds",()=>{
  const lock=locked([three!.id,one!.id]);
  expect(validateReferenceLock(lock,[one!,two!,three!])).toEqual(lock);
  // The bytes are named as well as the asset, so a re-upload under a reused id cannot pass as the locked look.
  expect(()=>validateReferenceLock(lock,[one!,two!,{...three!,sha256:"9".repeat(64)}])).toThrow("locked look");
  expect(()=>validateReferenceLock(lock,[one!,two!])).toThrow("Lock this character's look");
  expect(()=>validateReferenceLock({...lock,revision:"0".repeat(64)},[one!,two!,three!])).toThrow();
  expect(()=>validateReferenceLock({...lock,label:"Another name"},[one!,two!,three!])).toThrow();
  // A cast record carrying a lock its own images cannot satisfy is unreadable rather than quietly renderable.
  expect(()=>actor([one!,two!],lock)).toThrow();
  expect(()=>castingSnapshot("project-1",1,[actor([one!,two!,three!],lock)],now)).not.toThrow();
});

test("a locked look decides what conditions the render, and in what order",()=>{
  const unlocked=directCast(shots,parsed,castingSnapshot("project-1",1,[actor()],now),now);
  expect(unlocked[0]!.referenceAssets!.map(asset=>asset.id)).toEqual([one!.id,two!.id,three!.id]);
  const lock=locked([three!.id,one!.id]);
  const directed=directCast(shots,parsed,castingSnapshot("project-1",2,[actor([one!,two!,three!],lock)],now),now);
  expect(directed[0]!.referenceAssets!.map(asset=>asset.id)).toEqual([three!.id,one!.id]);
  // The numbered map the prompt gives the provider counts the locked set, not the images left out of it.
  expect(directed[0]!.prompt).toContain("Reference image 1 depicts SPUD.");
  expect(directed[0]!.prompt).toContain("Reference image 2 depicts SPUD.");
  expect(directed[0]!.prompt).not.toContain("Reference image 3 depicts SPUD.");
  expect(lockedReferences(actor([one!,two!,three!],lock))!.map(asset=>asset.id)).toEqual([three!.id,one!.id]);
  expect(lockedReferences(actor())).toBeUndefined();
  expect(renderReferences(actor()).map(asset=>asset.id)).toEqual([one!.id,two!.id,three!.id]);
});

test("adding another image to a locked character does not change what it renders",()=>{
  const lock=locked([three!.id,one!.id]);
  const before=directCast(shots,parsed,castingSnapshot("project-1",2,[actor([one!,two!,three!],lock)],now),now);
  const after=directCast(shots,parsed,castingSnapshot("project-1",3,[actor([one!,two!,three!,four!],lock)],now),now);
  expect(after[0]!.referenceAssets).toEqual(before[0]!.referenceAssets);
  expect(after[0]!.prompt).toBe(before[0]!.prompt);
  // Unlocked, the same adoption silently changes every render of the character. That is the defect this closes.
  const loose=directCast(shots,parsed,castingSnapshot("project-1",4,[actor([one!,two!,three!,four!])],now),now);
  expect(loose[0]!.referenceAssets!.map(asset=>asset.id)).toEqual([one!.id,two!.id,three!.id,four!.id]);
});

test("a share of a locked character imports, because the copies are new images with new identities",()=>{
  // HV-017-10: the lock names the source project's asset ids, and copiedActorReferences gives every
  // copy a fresh one, so a lock carried across could never be satisfied — it made every import of
  // that share fail, for the whole week the share lived.
  const SOURCE="11111111-aaaa-4aaa-8aaa-111111111111",DEST="22222222-bbbb-4bbb-8bbb-222222222222";
  const owned=(seed:string)=>({...image(seed),projectId:SOURCE});
  const [a,b]=["7","8"].map(owned);
  const held=characterRecord({...CAST_INPUT,permission:{status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()},
    sceneBindings:[],references:[a!,b!],referenceLock:referenceLockRecord({assetIds:[b!.id,a!.id],label:"Act two"},[a!,b!],now)},ID,now,true);
  const source=castingSnapshot(SOURCE,1,[held],now);
  const share=createActorShare(source,held.id,new Date(now+3*24*3600*1000).toISOString(),now);
  const copies=copiedActorReferences(share,DEST,now);
  const imported=importedActor(share,"cccccccc-3333-4333-8333-cccccccccccc",DEST,"MARGUERITE",[],copies,now);
  expect(imported.references).toHaveLength(2);
  expect(imported.referenceLock).toBeUndefined();
  // The imported record is readable, which is the whole point: it round-trips through the validator.
  expect(()=>castingSnapshot(DEST,1,[imported],now)).not.toThrow();
  // And the destination can lock its own look, from its own images.
  expect(referenceLockRecord({assetIds:[copies[0]!.id],label:"Its own look"},imported.references!,now).assets[0]!.id).toBe(copies[0]!.id);
});
