import {expect,test} from "bun:test";
import {lineSources} from "../src/performances";
import {compileAudioLine,validateAudioLinePlan,audioVoiceProfile} from "../src/audio-performances";
import {audioPolicy,audioTakePlan,validateAudioPolicy} from "../src/audio-jobs";
import {CARTESIA_MULTILINGUAL_CAPABILITY,CARTESIA_AUDIO_CAPABILITY} from "../../generator/src/audio-capabilities";
import {cartesiaLineRequest} from "../../generator/src/cartesia-audio";
import {DUB_POLICY,localizedLine} from "../../../test/fixtures/localized-audio";
import {AUDIO_POLICY} from "../../../test/fixtures/audio";
const source=lineSources([{character:"MARLA",lines:["Welcome home."]}])[0]!;
test("reviewed translations preserve the source, direct translated phrases and bind exact language requests",()=>{
  for(const [language,text]of [["es","Bienvenida a casa."],["ar","أهلاً بك في البيت."],["ja","お帰りなさい。"]] as const){
    const plan=localizedLine(source,language,text);expect(plan.source).toEqual(source);expect(plan.spokenText).toBe(text);expect(plan.localization!.review).toBe("owner-reviewed");expect(validateAudioLinePlan(plan)).toEqual(plan);
    expect(plan.capabilityRevision).toBe(CARTESIA_MULTILINGUAL_CAPABILITY.revision);const wire=cartesiaLineRequest(plan,crypto.randomUUID());expect(wire.language).toBe(language);expect(wire.transcript).toBe(text);expect(wire.generation_config).toEqual({speed:1,volume:1});expect(wire.add_phoneme_timestamps).toBe(false);
    expect(audioTakePlan(0,crypto.randomUUID(),plan,DUB_POLICY,"local").line.localization).toEqual(plan.localization);
    const changed=structuredClone(plan);changed.localization!.text+="!";expect(()=>validateAudioLinePlan(changed)).toThrow();
  }
  const first=localizedLine(source,"es","Bienvenida a casa."),direction={sourceHash:source.hash,localization:{language:"es" as const,text:first.localization!.text,sourceHash:source.hash,reviewed:true as const},phrases:[{start:0,end:10,text:"Bienvenida",speed:.8}]};
  const plan=compileAudioLine(source,first.profile,direction);expect(plan.providerTranscript).toContain('<speed ratio="0.8"/>Bienvenida');expect(plan.source.text).toBe("Welcome home.");expect(validateAudioLinePlan(plan)).toEqual(plan);
  expect(()=>compileAudioLine(source,first.profile,{...direction,phrases:[{start:0,end:7,text:"Welcome",speed:.8}]})).toThrow("exact phrase");
});
test("language, review, permission and legacy capability boundaries reject unreviewed or unsupported inputs",()=>{
  const plan=localizedLine(source,"ar","أهلاً بك."),base={sourceHash:source.hash,localization:{language:"ar" as const,text:plan.localization!.text,sourceHash:source.hash,reviewed:true as const}};
  for(const patch of [{reviewed:false},{sourceHash:"a".repeat(64)},{language:"es"},{text:"<break/>"},{text:" "},{unexpected:true}])expect(()=>compileAudioLine(source,plan.profile,{...base,localization:{...base.localization,...patch} as never})).toThrow();
  expect(()=>compileAudioLine(source,plan.profile,{...base,emotion:"sad"})).toThrow("English emotion");expect(()=>compileAudioLine(source,plan.profile,base,"words-and-phonemes")).toThrow("word boundaries");
  expect(()=>audioVoiceProfile({...plan.profile,language:"xx"})).toThrow("language");expect(()=>audioVoiceProfile({...plan.profile,schema:"hv-audio-voice/1"})).toThrow();
  expect(()=>audioTakePlan(0,crypto.randomUUID(),plan,{...DUB_POLICY,languages:["en"]},"local")).toThrow();
  const english=compileAudioLine(source,{...plan.profile,schema:"hv-audio-voice/1",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision}});
  expect(english.schema).toBe("hv-audio-line/1");expect(english.capabilityRevision).toBe(CARTESIA_AUDIO_CAPABILITY.revision);expect(english.localization).toBeUndefined();expect(validateAudioLinePlan(english)).toEqual(english);expect(validateAudioPolicy(AUDIO_POLICY)).toEqual(AUDIO_POLICY);
  const {schema:_schema,provider:_provider,model:_model,permissionRevision:_permission,priceRevision:_price,revision:_revision,...input}=DUB_POLICY;
  const removed=audioPolicy({...input,languages:["en"]});expect(removed.permissionRevision).not.toBe(DUB_POLICY.permissionRevision);expect(removed.priceRevision).toBe(DUB_POLICY.priceRevision);
  expect(()=>audioTakePlan(0,crypto.randomUUID(),plan,removed,"local")).toThrow("selected language");expect(()=>audioPolicy({...input,languages:["es","es"]})).toThrow("distinct");
});
