import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord,directCast} from "../src/casting";
import {directionEntry,directionSnapshot,directShots,directionSettings} from "../src/direction";
import {createScenePerformance,validateScenePerformance} from "../src/performance-memory";
import {pictureBaseRevision,pictureControls,picturePerformance,validatePicturePerformance,picturePerformancePrompt} from "../src/picture-performance";
import {createShotTakes,shotTakeShots} from "../src/takes";
import {compileAudioLine} from "../src/audio-performances";
import {lineSources} from "../src/performances";
import {CAST_INPUT,CAST_SCRIPT} from "../../../test/fixtures/casting";
import {contentHash} from "../../generator/src/capabilities";
const parsed=parseFountain(CAST_SCRIPT),scene=parsed.scenes[0]!,shots=planShots(parsed,7000,24),id=crypto.randomUUID();
const actor=()=>({...characterRecord(CAST_INPUT,id),scenePerformances:[createScenePerformance(id,scene,{notes:"Conceal disappointment.",picture:{emotion:"sad",intensity:"restrained",gestures:["avert-gaze","hold-still"]}})]});
test("picture scene defaults and shot overrides compile one effective prompt without changing legacy serialization",()=>{
  const character=actor(),cast=castingSnapshot("picture",1,[character]),baseRevision=pictureBaseRevision(character,scene),override={characterId:id,baseRevision,controls:{emotion:"joyful" as const,gestures:[]}},direction=directionSnapshot("picture",1,[directionEntry(shots[0]!,{picture:[override]})]);
  const result=directShots(directCast(shots,parsed,cast,Date.now(),direction),direction)[0]!,intent=result.picturePerformance!;
  expect(intent.characters[0]!.controls).toEqual({emotion:"joyful",intensity:"restrained",gestures:[]});expect(result.prompt).toContain(picturePerformancePrompt(intent));expect(result.prompt).not.toContain("emotion sad");expect(result.prompt).not.toContain("avert gaze");expect(validatePicturePerformance(intent)).toEqual(intent);expect(validateScenePerformance(character.scenePerformances[0]!)).toEqual(character.scenePerformances[0]!);
  expect(intent.characters[0]!.memoryRevision).toBe(character.scenePerformances[0]!.revision);expect(character.scenePerformances[0]!.picture!.gestures).toEqual(["avert-gaze","hold-still"]);
  const old=createScenePerformance(id,scene,{notes:"Watch the gate."}),{schema,revision,...data}=old;expect(schema).toBe("hv-scene-performance/1");expect(revision).toBe(contentHash(data));expect(old).not.toHaveProperty("picture");expect(directionSettings({picture:null})).toEqual(directionSettings({}));expect(directCast(shots,parsed,castingSnapshot("picture",0,[]))[0]).not.toHaveProperty("picturePerformance");
});
test("picture overrides reject unreviewed scene or character changes, foreign actors, invalid fields and receipt tampering",()=>{
  const c=actor(),edit={characterId:id,baseRevision:pictureBaseRevision(c,scene),controls:{intensity:"heightened" as const}};
  expect(()=>picturePerformance([{...c,name:"Changed"}],scene,[edit])).toThrow("rebind");expect(()=>picturePerformance([],scene,[edit])).toThrow("no longer present");
  const changed={...c,scenePerformances:[createScenePerformance(id,scene,{picture:{emotion:"calm"}})]};expect(()=>picturePerformance([changed],scene,[edit])).toThrow("rebind");
  expect(()=>picturePerformance([c],parseFountain(CAST_SCRIPT.replace("waves","waits")).scenes[0]!,[edit])).toThrow("rebind");
  for(const v of [{strength:5},{intensity:5},{emotion:"fear"},{gestures:["point-gun"]},{gestures:["nod","nod"]},{gestures:["nod","smile","shrug","frown"]},{}])expect(()=>pictureControls(v)).toThrow();
  const packet=picturePerformance([c],scene)!;expect(()=>validatePicturePerformance({...packet,transport:"native" as any})).toThrow();const altered=structuredClone(packet);altered.characters[0]!.controls.emotion="angry";expect(()=>validatePicturePerformance(altered)).toThrow("changed");
  const memory=structuredClone(c.scenePerformances[0]!);memory.schema="hv-scene-performance/1";expect(()=>validateScenePerformance(memory)).toThrow("changed");
});
test("alternate picture takes retain distinct directions and scene receipts without mutating their source",()=>{
  const c=actor(),cast=castingSnapshot("picture",1,[c]),direction=directionSnapshot("picture",0,[]),source=directionEntry(shots[0]!,{}),baseRevision=pictureBaseRevision(c,scene),plan=createShotTakes("picture",1,cast,direction,parsed,{shotId:shots[0]!.id,sourceHash:source.sourceHash,maxShots:24,takes:[{label:"Quiet",seed:1,settings:{picture:[{characterId:id,baseRevision,controls:{intensity:"restrained"}}]}},{label:"Broad",seed:2,settings:{picture:[{characterId:id,baseRevision,controls:{intensity:"heightened",gestures:["open-palms"]}}]}}]});
  const result=shotTakeShots(plan,cast,parsed,direction,1);expect(result.map(s=>s.picturePerformance!.characters[0]!.controls.intensity)).toEqual(["restrained","heightened"]);expect(result[1]!.prompt).toContain("open palms");expect(result[0]!.prompt).not.toContain("open palms");expect(plan.takes[1]!.settings.picture![0]!.baseRevision).toBe(baseRevision);
  const voice={schema:"hv-audio-voice/1" as const,provider:"cartesia" as const,language:"en" as const,voice:{id:crypto.randomUUID(),catalogueRevision:"a".repeat(64),permissionRevision:"b".repeat(64)},controls:{emotion:"calm" as const,speed:1,volume:1},pronunciations:[]};
  const line=compileAudioLine(lineSources(scene.dialogue)[0]!,voice,undefined,undefined,c.scenePerformances[0]);expect(line.memory!.picture).toEqual(c.scenePerformances[0]!.picture);expect(line.profile.controls).toEqual(voice.controls);expect(line.notes).toBe("Conceal disappointment.");
});
