import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {applyShotDirection,directShots,directionEntry,directionSnapshot} from "../src/direction";
import {compilePerformances,lineSources} from "../src/performances";
import type {Shot} from "../src/index";

function shot(id="shot-v2-"+"a".repeat(32)):Shot {
  const dialogue=[{character:"ALICE",lines:["Again.","Again."]}],performances=compilePerformances(dialogue,undefined);
  performances[0]!.voice.voice="en-gb";performances[0]!.notes="Calm";
  return {id,sceneIndex:23,prompt:"A fictional garden. Alice waves.",sourcePrompt:"Alice waves.",dialogue,performances,seed:7000,durationSec:2,castingRevision:"b".repeat(64),directionRevision:"c".repeat(64)};
}
test("explicit direction preserves opaque render identity and inherited cast voice while applying exact line and timing controls",()=>{
  const source=shot(),lines=lineSources(source.dialogue),fingerprint=contentHash(source),settings={seed:123,durationFrames:90,size:"close-up",blocking:"Alice stays beside the gate.",lines:[{index:1,sourceHash:lines[1]!.hash,rateWpm:135,pitch:45,level:110,beforeMs:250,afterMs:400,notes:"Wait for the reply."}]},result=applyShotDirection(source,settings);
  expect(result.id).toBe(source.id);expect(result.sceneIndex).toBe(23);expect(result.seed).toBe(123);expect(result.durationSec).toBe(3);expect(result.sourcePrompt).toBe("Alice waves.");
  expect(result.prompt).toBe("A fictional garden. Alice waves.\nShot direction (creative intent; preserve the screenplay action):\nShot size: close up\nBlocking: Alice stays beside the gate.");
  expect(result.performances![0]).toEqual(source.performances![0]);expect(result.performances![1]).toMatchObject({source:lines[1],voice:{rateWpm:135,pitch:45,level:110},beforeMs:250,afterMs:400,notes:"Wait for the reply."});
  expect(result.castingRevision).toBe(source.castingRevision);expect(result.directionRevision).toBeUndefined();expect(contentHash(source)).toBe(fingerprint);
  settings.lines[0]!.notes="Caller changed";expect(result.direction!.lines![0]!.notes).toBe("Wait for the reply.");
});
test("repeated equal dialogue keeps distinct local source hashes and stale line settings reject",()=>{
  const source=shot(),lines=lineSources(source.dialogue);expect(lines[0]!.hash).not.toBe(lines[1]!.hash);
  const settings={lines:[{index:1,sourceHash:lines[0]!.hash,beforeMs:0,afterMs:200,notes:"Wrong occurrence"}]};
  expect(()=>applyShotDirection(source,settings)).toThrow(/changed or disappeared/);
  const changed=structuredClone(source);changed.dialogue[0]!.lines[1]="New words.";
  expect(()=>applyShotDirection(changed,{lines:[{index:1,sourceHash:lines[1]!.hash}]})).toThrow(/changed or disappeared/);
});
test("legacy snapshots still require numeric identities and exact sources before calling the shared application",()=>{
  const source=shot("shot-24-1"),snapshot=directionSnapshot("direction-project",7,[directionEntry(source,{seed:123,durationFrames:90})],0),result=directShots([source],snapshot)[0]!;
  expect(result.id).toBe(source.id);expect(result.seed).toBe(123);expect(result.durationSec).toBe(3);expect(result.directionRevision).toBe(snapshot.revision);
  expect(()=>directShots([{...source,sourcePrompt:"Different physical action"}],snapshot)).toThrow(/changed or disappeared/);
  expect(()=>directionSnapshot("direction-project",8,[directionEntry(shot(),{})],0)).toThrow(/saved shot source/);
});
test("default controls preserve requested seed and duration and never attach an unrelated snapshot revision",()=>{
  const source=shot(),result=applyShotDirection(source,{});
  expect(result.seed).toBe(source.seed);expect(result.durationSec).toBe(source.durationSec);expect(result.prompt).toBe(source.prompt);expect(result.performances).toEqual(source.performances);expect(result.directionRevision).toBeUndefined();
  expect(()=>applyShotDirection(source,{unknown:true})).toThrow(/Unsupported/);
  expect(()=>applyShotDirection(source,{durationFrames:29})).toThrow(/30 seconds/);
});
