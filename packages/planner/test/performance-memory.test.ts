import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {createScenePerformance,validateScenePerformance,scenePerformanceSource,performanceForScene} from "../src/performance-memory";
import {compileAudioLine,validateAudioLinePlan,type AudioVoiceProfile} from "../src/audio-performances";
import {lineSources,DEFAULT_VOICE} from "../src/performances";
import {castingSnapshot,characterRecord,directCast} from "../src/casting";
import {planShots} from "../src/index";
import {directionEntry,directionSnapshot,directShots} from "../src/direction";
import {proposeSceneCut,sourcePlan} from "../src/scene-cuts";
import {cartesiaLineRequest} from "../../generator/src/cartesia-audio";
import {contentHash} from "../../generator/src/capabilities";
import {CAST_INPUT,CAST_SCRIPT} from "../../../test/fixtures/casting";
import {AUDIO_POLICY} from "../../../test/fixtures/audio";
import {AZURE_PROFILE} from "../../../test/fixtures/azure-audio";
const id=crypto.randomUUID(),parsed=parseFountain(CAST_SCRIPT),scene=parsed.scenes[0]!,source=lineSources(scene.dialogue)[0]!;
const profile:AudioVoiceProfile={schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision},controls:{speed:1.2,volume:.8,emotion:"sad"},pronunciations:[]};
test("Azure scene style and intensity inherit independently of Cartesia emotion and retain explicit line precedence",()=>{
  const memory=createScenePerformance(id,scene,{controls:{emotion:"calm",speed:.8},nativeVoice:{style:"whispering",intensity:1.6},picture:{emotion:"calm"}});
  expect(memory.schema).toBe("hv-scene-performance/3");expect(validateScenePerformance(memory)).toEqual(memory);
  const native=compileAudioLine(source,AZURE_PROFILE,undefined,undefined,memory);
  expect(native.profile.controls).toEqual({speed:.8,volume:1,emotion:"neutral",style:"whispering",intensity:1.6});
  expect(native.providerTranscript).toContain('style="whispering" styledegree="1.6"');expect(validateAudioLinePlan(native)).toEqual(native);
  const reset=compileAudioLine(source,AZURE_PROFILE,{sourceHash:source.hash,style:"neutral",intensity:1,speed:1},undefined,memory);
  expect(reset.profile.controls).toMatchObject({style:"neutral",intensity:1,speed:1});expect(reset.providerTranscript).not.toContain("express-as");expect(validateAudioLinePlan(reset)).toEqual(reset);
  const other=compileAudioLine(source,profile,undefined,undefined,memory);expect(other.profile.controls).toEqual({speed:.8,volume:.8,emotion:"calm"});expect(validateAudioLinePlan(other)).toEqual(other);
  const inherited=createScenePerformance(id,scene,{notes:"Keep the welcome quiet."});expect(compileAudioLine(source,AZURE_PROFILE,undefined,undefined,inherited).profile.controls).toEqual(AZURE_PROFILE.controls);
  memory.nativeVoice!.intensity=1;expect(native.memory!.nativeVoice!.intensity).toBe(1.6);expect(()=>validateScenePerformance(memory)).toThrow("changed");
});
test("scene voice schema preserves older revisions and refuses unsupported or downgraded native settings",()=>{
  for(const nativeVoice of [null,{}, {style:"happy",intensity:1},{style:"sad"},{style:"sad",intensity:0},{style:"sad",intensity:2.01},{style:"sad",intensity:.015},{style:"sad",intensity:Infinity},{style:"neutral",intensity:1.1},{style:"sad",intensity:1,voiceId:"injected"}])expect(()=>createScenePerformance(id,scene,{nativeVoice})).toThrow();
  const native=createScenePerformance(id,scene,{nativeVoice:{style:"neutral",intensity:1}});expect(native.notes).toBe("");expect(native.schema).toBe("hv-scene-performance/3");
  for(const schema of ["hv-scene-performance/1","hv-scene-performance/2"] as const)expect(()=>validateScenePerformance({...native,schema})).toThrow("changed");
  for(const input of [{notes:"A quiet welcome."},{picture:{emotion:"calm"}}]){const legacy=createScenePerformance(id,scene,input),{schema,revision,...data}=legacy;expect(schema).toBe("picture" in input?"hv-scene-performance/2":"hv-scene-performance/1");expect(legacy).not.toHaveProperty("nativeVoice");expect(revision).toBe(contentHash(data));expect(validateScenePerformance(legacy)).toEqual(legacy);expect(()=>validateScenePerformance({...legacy,schema:"hv-scene-performance/3"})).toThrow("changed");}
});
test("character, scene and explicit line settings have stable precedence and immutable provenance",()=>{
  const memory=createScenePerformance(id,scene,{notes:"Conceal disappointment, then smile.",controls:{emotion:"calm",speed:.8}}),inherited=compileAudioLine(source,profile,undefined,undefined,memory);
  expect(inherited.profile.controls).toEqual({emotion:"calm",speed:.8,volume:.8});expect(inherited.notes).toBe(memory.notes);expect(inherited.schema).toBe("hv-audio-line/2");expect(validateAudioLinePlan(inherited)).toEqual(inherited);
  const explicit=compileAudioLine(source,profile,{sourceHash:source.hash,emotion:"neutral",speed:1,volume:1,notes:"",beforeMs:500},"words",memory);
  expect(explicit.profile.controls).toEqual({emotion:"neutral",speed:1,volume:1});expect(explicit.notes).toBe("");expect(explicit.memory).toEqual(memory);expect(validateAudioLinePlan(explicit)).toEqual(explicit);
  const wire=cartesiaLineRequest(explicit,crypto.randomUUID());expect(wire.generation_config).toEqual(explicit.profile.controls);expect(wire.transcript).toBe(source.text);expect(JSON.stringify(wire)).not.toContain(memory.notes);expect(wire).not.toHaveProperty("memory");
  const legacy=compileAudioLine(source,profile),{revision,...data}=legacy;expect(legacy.schema).toBe("hv-audio-line/1");expect(legacy).not.toHaveProperty("memory");expect(revision).toBe(contentHash(data));expect(validateAudioLinePlan(legacy)).toEqual(legacy);
  memory.notes="Later edit";expect(inherited.memory!.notes).toBe("Conceal disappointment, then smile.");expect(()=>validateScenePerformance(memory)).toThrow("changed");
  expect(()=>validateAudioLinePlan({...explicit,schema:"hv-audio-line/1"})).toThrow();expect(()=>validateAudioLinePlan({...legacy,schema:"hv-audio-line/2"})).toThrow();
});
test("saved intent follows the entire ordered scene, with explicit review for action, speaker or order changes",()=>{
  const memory=createScenePerformance(id,scene,{notes:"A hesitant greeting."}),character={id,scenePerformances:[memory]};
  expect(scenePerformanceSource(parseFountain("\n[[comment]]\n"+CAST_SCRIPT).scenes[0]!)).toBe(memory.sourceHash);
  for(const script of [CAST_SCRIPT.replace("waves","hesitates"),CAST_SCRIPT.replace("SPUD\n","SPUDDY\n"),CAST_SCRIPT.replace("Hello, friend.","Hello."),CAST_SCRIPT.replace("EXT. GARDEN","EXT. PARK")])expect(()=>performanceForScene(character,parseFountain(script).scenes[0]!)).toThrow("changed");
  expect(performanceForScene(character,parsed.scenes[1]!)).toBeUndefined();expect(()=>performanceForScene({...character,id:crypto.randomUUID()},scene)).toThrow("another character");
  for(const settings of [{notes:""},{notes:"x".repeat(601)},{notes:"\ud800"},{notes:"\u0000"},{notes:"clone the voice of a real celebrity"},{controls:{pitch:5}},{controls:{speed:.2}},{controls:{volume:Infinity}},{controls:{emotion:"elated"}}])expect(()=>createScenePerformance(id,scene,settings)).toThrow();
});
test("picture prompts and temporary line notes inherit scene intent through coverage changes and line overrides",()=>{
  const memory=createScenePerformance(id,scene,{notes:"A hesitant greeting.",controls:{emotion:"calm"}}),silent=createScenePerformance(id,parsed.scenes[1]!,{notes:"Carry the basket with quiet pride."}),character={...characterRecord(CAST_INPUT,id),scenePerformances:[memory,silent]},cast=castingSnapshot("scene-test",1,[character]);
  const raw=planShots(parsed),directed=directCast(raw,parsed,cast);expect(directed[0]!.prompt).toContain(memory.notes);expect(directed.at(-1)!.prompt).toContain(silent.notes);expect(directed[0]!.performances![0]!.notes).toBe(memory.notes);expect(directed[0]!.performances![0]!.voice).toEqual(DEFAULT_VOICE);
  const entry=directionEntry(raw[0]!,{performance:"Smile after speaking.",lines:[{index:0,sourceHash:source.hash,notes:"A bright greeting."}]}),line=directShots(directed,directionSnapshot("scene-test",1,[entry]));expect(line[0]!.performances![0]!.notes).toBe("A bright greeting.");expect(line[0]!.prompt).toContain("Smile after speaking.");
  const split=sourcePlan(parsed,directionSnapshot("scene-test",1,[],Date.now(),[proposeSceneCut(scene,true)])),result=directCast(split,parsed,cast);
  expect(result.flatMap(s=>s.performances??[]).filter(p=>p.source.character==="SPUD").map(p=>p.notes)).toEqual([memory.notes]);expect(result.filter(s=>s.sceneIndex===0).every(s=>s.prompt.includes(memory.notes))).toBe(true);
  expect(()=>castingSnapshot("scene-test",2,[{...character,scenePerformances:[memory,memory]}])).toThrow();
  expect(()=>directCast(raw,parseFountain(CAST_SCRIPT.replace("waves","waits")),cast)).toThrow("changed");
});
