import {expect,test} from "bun:test";
import {audioPhrases,phraseTokens} from "../src/audio-phrases";
import {compileAudioLine,validateAudioLinePlan,type AudioVoiceProfile} from "../src/audio-performances";
import {lineSources} from "../src/performances";
import {audioPolicy,audioTakePlan} from "../src/audio-jobs";
import {cartesiaLineRequest,validateAudioIntent} from "../../generator/src/cartesia-audio";
import {CARTESIA_AUDIO_CAPABILITY,CARTESIA_PHRASE_CAPABILITY,audioCapability} from "../../generator/src/audio-capabilities";
import {contentHash} from "../../generator/src/capabilities";
import {AUDIO_POLICY,audioIntent} from "../../../test/fixtures/audio";
import {createScenePerformance} from "../src/performance-memory";
import {parseFountain} from "../../parser/src/index";
const profile:AudioVoiceProfile={schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision},controls:{emotion:"calm",speed:1.2,volume:.9},pronunciations:[{word:"Zo",say:"Zoe"}]};
const source=lineSources([{character:"MARLA",lines:["Hello Zo, hello Zo."]}])[0]!;
test("source-bound phrase controls compile only reviewed ranges and explicitly restore the line settings",()=>{
  const phrases=[{start:0,end:5,text:"Hello",speed:.8,volume:1.1,pauseAfterMs:200},{start:10,end:19,text:"hello Zo.",volume:.7}],line=compileAudioLine(source,profile,{sourceHash:source.hash,phrases});
  expect(line.schema).toBe("hv-audio-line/3");expect(line.capabilityRevision).toBe(CARTESIA_PHRASE_CAPABILITY.revision);expect(line.spokenText).toBe("Hello Zoe, hello Zoe.");
  expect(line.providerTranscript).toBe('<speed ratio="0.8"/><volume ratio="1.1"/>Hello<speed ratio="1.2"/><volume ratio="0.9"/><break time="200ms"/> Zoe, <volume ratio="0.7"/>hello Zoe.<volume ratio="0.9"/>');
  expect(line.source.text).toBe(source.text);expect(validateAudioLinePlan(line)).toEqual(line);expect(cartesiaLineRequest(line,crypto.randomUUID()).transcript).toBe(line.providerTranscript!);expect(line.profile.controls).toEqual(profile.controls);
  const intent=audioIntent(line);expect(()=>validateAudioIntent(intent,line)).not.toThrow();expect(()=>validateAudioIntent({...intent,capabilityRevision:CARTESIA_AUDIO_CAPABILITY.revision},line)).toThrow("differs");
  expect(audioCapability(CARTESIA_AUDIO_CAPABILITY.revision)).toBe(CARTESIA_AUDIO_CAPABILITY);expect(CARTESIA_AUDIO_CAPABILITY.controls.wordEmphasis).toBe(false);
});
test("repeated words and Unicode phrases use exact source ranges and refuse overlap, split words and unknown tags",()=>{
  const text="Zo 👩🏾‍🚀 élan, Zo",tokens=phraseTokens(text),last=tokens.at(-1)!;expect(tokens).toHaveLength(4);expect(audioPhrases(text,[{...last,speed:1}])[0]!.start).toBe(text.lastIndexOf("Zo"));
  for(const value of [[{start:1,end:2,text:"o",speed:1}],[{start:3,end:5,text:"👩",speed:1}],[{...last,text:"Zoe",speed:1}],[{...last,emphasis:"strong"}],[{...last,speed:.59}],[{...last,volume:2.01}],[{...last,pauseAfterMs:3001}],[{...last,pauseAfterMs:.5}],[{...last,pauseAfterMs:0}],[{...last,speed:1},{...last,volume:1}]])expect(()=>audioPhrases(text,value)).toThrow();
  expect(()=>audioPhrases("one two",[{start:0,end:3,text:"one",pauseAfterMs:500},{start:4,end:7,text:"two",pauseBeforeMs:500}])).toThrow("one requested pause");
  expect(()=>audioPhrases(text,Array.from({length:17},()=>({...last,speed:1})))).toThrow("16");
  const tagged=lineSources([{character:"MARLA",lines:['Hello <speed ratio="2"/>'] }])[0]!;expect(()=>compileAudioLine(tagged,profile,{sourceHash:tagged.hash,phrases:[{start:0,end:5,text:"Hello",speed:1}]})).toThrow("plain dialogue");
});
test("pronunciation changes cannot cross a phrase boundary or silently move source direction onto another occurrence",()=>{
  const source=lineSources([{character:"MARLA",lines:["Visit New York, then New York."]}])[0]!,custom={...profile,pronunciations:[{word:"New York",say:"New Yawk"}]};
  expect(()=>compileAudioLine(source,custom,{sourceHash:source.hash,phrases:[{start:6,end:9,text:"New",speed:.8}]})).toThrow("crosses a phrase boundary");
  const line=compileAudioLine(source,custom,{sourceHash:source.hash,phrases:[{start:6,end:15,text:"New York,",speed:.8}]});expect(line.providerTranscript).toBe('Visit <speed ratio="0.8"/>New Yawk,<speed ratio="1.2"/> then New Yawk.');
  const changed=lineSources([{character:"MARLA",lines:["Visit Old York, then New York."]}])[0]!;expect(()=>compileAudioLine(changed,custom,{sourceHash:changed.hash,phrases:line.phrases})).toThrow("exact phrase");
});
test("legacy and scene-only plans retain their schemas while forged phrase transcripts or capability downgrades fail canonical validation",()=>{
  const scene=parseFountain("INT. ROOM - DAY\n\nMARLA\n"+source.text).scenes[0]!,memory=createScenePerformance(crypto.randomUUID(),scene,{notes:"An uncertain greeting.",controls:{speed:.7}});
  for(const intent of [undefined,memory]){const old=compileAudioLine(source,profile,undefined,undefined,intent),empty=compileAudioLine(source,profile,{sourceHash:source.hash,phrases:[]},undefined,intent);expect(empty).toEqual(old);expect(old.schema).toBe(intent?"hv-audio-line/2":"hv-audio-line/1");expect(old.capabilityRevision).toBe(CARTESIA_AUDIO_CAPABILITY.revision);expect(old).not.toHaveProperty("providerTranscript");}
  const line=compileAudioLine(source,profile,{sourceHash:source.hash,phrases:[{start:0,end:5,text:"Hello",speed:1}]},undefined,memory);expect(line.memory).toEqual(memory);expect(line.providerTranscript).toContain('<speed ratio="0.7"/>');
  for(const patch of [{providerTranscript:line.spokenText},{providerTranscript:'<audio src="https://evil.invalid/x"/>'+line.spokenText},{capabilityRevision:CARTESIA_AUDIO_CAPABILITY.revision},{phrases:[]},{schema:"hv-audio-line/2"}]){const {revision:_revision,...data}={...line,...patch};expect(()=>validateAudioLinePlan({...data,revision:contentHash(data)} as any)).toThrow();}
});
test("audio admission conservatively bounds the complete wire transcript within the authorized character envelope",()=>{
  const line=compileAudioLine(source,profile,{sourceHash:source.hash,phrases:[{start:0,end:5,text:"Hello",speed:1}]}),{schema:_s,provider:_p,model:_m,permissionRevision:_r,priceRevision:_pr,revision:_rev,...input}=AUDIO_POLICY,id=crypto.randomUUID();
  expect(()=>audioTakePlan(0,id,line,audioPolicy({...input,maxCharacters:line.spokenText.length}),"local")).toThrow("authorized voice and price");expect(audioTakePlan(0,id,line,audioPolicy({...input,maxCharacters:line.providerTranscript!.length}),"local").line).toEqual(line);
});
