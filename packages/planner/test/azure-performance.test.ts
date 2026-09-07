import {expect,test} from "bun:test";
import {AZURE_POLICY,AZURE_PROFILE} from "../../../test/fixtures/azure-audio";
import {AUDIO_POLICY} from "../../../test/fixtures/audio";
import {audioVoiceProfile,compileAudioLine,validateAudioLinePlan} from "../src/audio-performances";
import {audioPolicy,audioTakePlan,validateAudioPolicy} from "../src/audio-jobs";
import {lineSources} from "../src/performances";
import {AZURE_AUDIO_CAPABILITY} from "../../generator/src/azure-capability";
import {CARTESIA_AUDIO_CAPABILITY} from "../../generator/src/audio-capabilities";
import {contentHash} from "../../generator/src/capabilities";
const source=(text="Zo & Zo welcome.")=>lineSources([{character:"MARLA",lines:[text]}])[0]!;
test("native emphasis binds exact source occurrences and compiles supported style intensity with escaped pronunciation",()=>{
  const s=source(),profile={...AZURE_PROFILE,pronunciations:[{word:"Zo",say:"Zoe"}]},p=compileAudioLine(s,profile,{sourceHash:s.hash,phrases:[{start:5,end:7,text:"Zo",emphasis:"strong",speed:.8,pauseBeforeMs:300}]});
  expect(p.schema).toBe("hv-audio-line/4");expect(p.capabilityRevision).toBe(AZURE_AUDIO_CAPABILITY.revision);expect(p.alignment).toBe("words");expect(p.spokenText).toBe("Zoe & Zoe welcome.");
  expect(p.providerTranscript).toContain('<mstts:express-as style="sad" styledegree="1.4">');expect(p.providerTranscript).toContain('Zoe &amp; </prosody><break time="300ms"/><prosody rate="-20.00%" volume="+0.00%"><emphasis level="strong">Zoe</emphasis></prosody><prosody rate="+0.00%"');
  expect(validateAudioLinePlan(p)).toEqual(p);expect(()=>validateAudioLinePlan({...p,providerTranscript:p.providerTranscript!.replace("strong","moderate")})).toThrow();
  expect(()=>validateAudioLinePlan({...p,capabilityRevision:CARTESIA_AUDIO_CAPABILITY.revision})).toThrow();
});
test("native catalogue and direction refuse unsupported voices, emotion substitution, neutral intensity and false phonemes",()=>{
  const s=source();for(const patch of [{voice:{...AZURE_PROFILE.voice,id:"en-US-JennyNeural"}},{controls:{...AZURE_PROFILE.controls,emotion:"calm"}},{controls:{...AZURE_PROFILE.controls,style:"neutral",intensity:2}},{controls:{...AZURE_PROFILE.controls,intensity:.015}},{provider:"cartesia"}])expect(()=>audioVoiceProfile({...AZURE_PROFILE,...patch})).toThrow();
  expect(()=>compileAudioLine(s,AZURE_PROFILE,undefined,"words-and-phonemes")).toThrow("phoneme");
  for(const phrases of [[{start:0,end:2,text:"Zo",emphasis:"very-strong"}],[{start:0,end:2,text:"Zo",volume:.9}],[{start:1,end:2,text:"o",emphasis:"strong"}],[{start:0,end:2,text:"Zo",emphasis:"strong"},{start:0,end:2,text:"Zo",speed:.8}]])expect(()=>compileAudioLine(s,AZURE_PROFILE,{sourceHash:s.hash,phrases:phrases as any})).toThrow();
  expect(()=>compileAudioLine(s,{...AZURE_PROFILE,pronunciations:[{word:"Zo welcome",say:"Zoe"}]},{sourceHash:s.hash,phrases:[{start:5,end:7,text:"Zo",emphasis:"strong"}]})).toThrow("boundary");
});
test("provider-specific policies cannot be relabelled and count the complete SSML before a reservation",()=>{
  const s=source(),line=compileAudioLine(s,AZURE_PROFILE);expect(validateAudioPolicy(AZURE_POLICY)).toEqual(AZURE_POLICY);expect(validateAudioPolicy(AUDIO_POLICY)).toEqual(AUDIO_POLICY);
  expect(()=>validateAudioPolicy({...AZURE_POLICY,provider:"cartesia"})).toThrow();expect(()=>validateAudioPolicy({...AUDIO_POLICY,provider:"azure"})).toThrow();
  const {schema:_schema,model:_model,revision:_revision,permissionRevision:_permission,priceRevision:_price,...input}=AZURE_POLICY;
  const small=audioPolicy({...input,maxCharacters:line.spokenText.length});expect(()=>audioTakePlan(0,crypto.randomUUID(),line,small,"local")).toThrow("policy");
  expect(audioTakePlan(0,crypto.randomUUID(),line,AZURE_POLICY,"local").line.revision).toBe(line.revision);
  expect(contentHash(AUDIO_POLICY)).not.toBe(contentHash(AZURE_POLICY));
});
