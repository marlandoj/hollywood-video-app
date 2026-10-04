/**
 * HV-017-17 — the locks a shot was rendered from, and what a changed lock means for a render already made.
 * The end-to-end proof through the API and worker is packages/api/test/feature-identity-locks.test.ts.
 */
import {expect,test} from "bun:test";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {parseFountain} from "../../parser/src/index";
import {castingSnapshot,charactersForScene,characterRecord,directCast} from "../src/casting";
import {referenceLockRecord} from "../src/reference-lock";
import {filmPlan,inSequence,greedySequences,sceneShotCounts,sequencePlan,sequenceRef} from "../src/sequences";
import {appearingIdentities,identityLocks,IdentityLockError,lockDrift,shotIdentityLocks} from "../src/identity-locks";

const now=Date.UTC(2026,9,4);
const SPUD="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",TATER="bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const image=(seed:string)=>({schema:"hv-reference/1" as const,id:"11111111-2222-4333-8444-"+seed.repeat(12).slice(0,12),projectId:"project-1",
  sha256:seed.repeat(64).slice(0,64),originalSha256:"b".repeat(64),bytes:4096,width:512,height:512,contentType:"image/png" as const,
  createdAt:new Date(now).toISOString(),attestedAt:new Date(now).toISOString()});
const [one,two,three,four]=["c","d","e","f"].map(image);
const permitted={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
const character=(id:string,name:string,references:ReturnType<typeof image>[],lockIds?:string[],label="Act one")=>characterRecord({...CAST_INPUT,name,aliases:[],permission:permitted,
  sceneBindings:[],references,...(lockIds?{referenceLock:referenceLockRecord({assetIds:lockIds,label,note:""},references,now)}:{})},id,now,true);
/** Thirteen beats a scene, so no two scenes fit one 24-shot render: the stand-in split gives one sequence a scene. */
const beats=(name:string,scene:number)=>Array.from({length:13},(_,i)=>`${name} carries crate ${i+1} across yard ${scene}.`).join("\n\n");
const SCRIPT=["INT. YARD 1 - DAY\n\n"+beats("Spud and Tater",1),"EXT. YARD 2 - DAY\n\n"+beats("Tater",2),"INT. YARD 3 - DAY\n\n"+beats("Spud",3)].join("\n\n");
const parsed=parseFountain(SCRIPT),split=sequencePlan(1,greedySequences(sceneShotCounts(parsed)));
const cast=(spudLock:string[]|undefined,version=1)=>castingSnapshot("project-1",version,[character(SPUD,"SPUD",[one!,two!,three!],spudLock),character(TATER,"TATER",[four!])],now);
const sequenceShots=(casting:ReturnType<typeof cast>,number:number)=>{const ref=sequenceRef(split,number);return inSequence(directCast(filmPlan(parsed,undefined,24,ref),parsed,casting,now),ref);};

test("every sequence's shots are cast from the lock and record it; an unlocked character's shots record none",()=>{
  expect(split.sequences.map(sequence=>[sequence.firstScene,sequence.lastScene])).toEqual([[1,1],[2,2],[3,3]]);
  const casting=cast([three!.id,one!.id]),lock=casting.characters[0]!.referenceLock!;
  for(const number of [1,2,3]){
    const shots=sequenceShots(casting,number);
    expect(shots).toHaveLength(13);
    for(const shot of shots){
      const locks=shotIdentityLocks(shot,casting);
      if(number===2){
        // Tater alone: rendered from its own image, with no lock to record.
        expect(shot.referenceAssets!.map(asset=>asset.id)).toEqual([four!.id]);
        expect(locks).toEqual([]);
      }else{
        // Spud's locked images first, in the lock's order, then (in scene 1) Tater's own.
        expect(shot.referenceAssets!.map(asset=>asset.id)).toEqual(number===1?[three!.id,one!.id,four!.id]:[three!.id,one!.id]);
        expect(locks).toEqual([{characterId:SPUD,name:"SPUD",label:"Act one",revision:lock.revision,lockedAt:lock.lockedAt,
          assets:[{id:three!.id,sha256:three!.sha256},{id:one!.id,sha256:one!.sha256}]}]);
      }
    }
  }
  // The desk's reading of a render (its cast snapshot and the scene's characters) names the same locks as the shot's own record.
  const shot=sequenceShots(casting,1)[0]!;
  expect(identityLocks(charactersForScene(casting,shot.sceneIndex,parsed))).toEqual(shotIdentityLocks(shot,casting));
});

test("a shot's record names a lock only when the render was given the lock's images, in its order and with its bytes",()=>{
  const casting=cast([three!.id,one!.id]),shot=sequenceShots(casting,1)[0]!;
  const given=shot.referenceAssets!;
  for(const referenceAssets of [[given[1]!,given[0]!,given[2]!],[given[0]!,given[2]!],[{...given[0]!,sha256:"9".repeat(64)},given[1]!,given[2]!],[given[2]!],undefined])
    expect(()=>shotIdentityLocks({...shot,referenceAssets},casting)).toThrow(IdentityLockError);
  expect(()=>shotIdentityLocks({...shot,characterIds:[crypto.randomUUID()]},casting)).toThrow("names a character its cast does not hold");
  // No cast, or no characters, is no lock.
  expect(shotIdentityLocks(shot,undefined)).toEqual([]);
  expect(shotIdentityLocks({...shot,characterIds:[]},casting)).toEqual([]);
});

test("a lock changed, added or removed after a render is drift; an unchanged lock or a character left unlocked is not",()=>{
  const before=cast([three!.id,one!.id]);
  const shown=(casting:ReturnType<typeof cast>,number:number)=>appearingIdentities(sequenceShots(casting,number).map(shot=>({characters:charactersForScene(casting,shot.sceneIndex,parsed)})));
  const first=shown(before,1);
  expect(first).toEqual([{characterId:SPUD,name:"SPUD",revision:before.characters[0]!.referenceLock!.revision},{characterId:TATER,name:"TATER",revision:null}]);
  expect(lockDrift(first,before)).toEqual([]);
  // The creator locks Spud to other images: what sequence 1 showed of Spud is no longer the cast's lock; Tater is unchanged.
  const after=cast([one!.id],2);
  expect(lockDrift(first,after)).toEqual([{characterId:SPUD,name:"SPUD",used:before.characters[0]!.referenceLock!.revision,current:after.characters[0]!.referenceLock!.revision}]);
  // A sequence that doesn't show Spud is not affected by Spud's lock.
  expect(lockDrift(shown(before,2),after)).toEqual([]);
  // Unlocking is a change too, and so is locking a look that was rendered unlocked.
  const unlocked=cast(undefined,3);
  expect(lockDrift(first,unlocked)).toEqual([{characterId:SPUD,name:"SPUD",used:before.characters[0]!.referenceLock!.revision,current:null}]);
  expect(lockDrift(shown(unlocked,3),before)).toEqual([{characterId:SPUD,name:"SPUD",used:null,current:before.characters[0]!.referenceLock!.revision}]);
  // A character who left the cast was rendered from a lock the cast no longer has.
  expect(lockDrift(first,castingSnapshot("project-1",4,[character(TATER,"TATER",[four!])],now))[0]).toMatchObject({characterId:SPUD,current:null});
});
