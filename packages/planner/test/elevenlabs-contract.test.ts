import {expect,test} from "bun:test";
import {compileAudioLine,validateAudioLinePlan,type AudioVoiceProfile} from "../src/audio-performances";
import {lineSources} from "../src/performances";
import {ELEVENLABS_DEFAULTS} from "../src/elevenlabs-performance";
import {ELEVENLABS_AUDIO_CAPABILITY,ELEVENLABS_MODEL,ELEVENLABS_MAX_LINE_CHARACTERS} from "../../generator/src/elevenlabs-capability";
import {elevenLabsLineRequest,elevenLabsWordTimings} from "../../generator/src/elevenlabs-request";
import {audioCapability} from "../../generator/src/audio-capabilities";
import {contentHash} from "../../generator/src/capabilities";

/**
 * HV-022-05: the second production voice vendor, as a contract. Nothing here dispatches: this is
 * what the adapter will ask for, what it will refuse, and how a word timing is derived from the
 * service's character alignment.
 */
const VOICE_ID="CwhRBWXzGAHq8TQ4Fs17";
const hash="a".repeat(64),permission="b".repeat(64);
const profile=(over:Partial<AudioVoiceProfile>={}):AudioVoiceProfile=>({schema:"hv-audio-voice/4",provider:"elevenlabs",language:"en",
  voice:{id:VOICE_ID,catalogueRevision:hash,permissionRevision:permission},
  controls:{speed:1.1,volume:1,emotion:"neutral",...ELEVENLABS_DEFAULTS},pronunciations:[],...over} as AudioVoiceProfile);
const source=lineSources([{character:"ELENA",lines:["One more."]}])[0]!;

test("an ElevenLabs line compiles to its own schema, capability and request",()=>{
  const line=compileAudioLine(source,profile());
  expect(line.schema).toBe("hv-audio-line/6");
  expect(line.capabilityRevision).toBe(ELEVENLABS_AUDIO_CAPABILITY.revision);
  expect(audioCapability(ELEVENLABS_AUDIO_CAPABILITY.revision)).toBe(ELEVENLABS_AUDIO_CAPABILITY);
  expect(line.alignment).toBe("words");
  expect(line.profile.voice.id).toBe(VOICE_ID);
  expect(validateAudioLinePlan(line)).toEqual(line);

  const request=elevenLabsLineRequest(line);
  expect(request.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=pcm_44100`);
  expect(request.body).toEqual({text:"One more.",model_id:ELEVENLABS_MODEL,apply_text_normalization:"auto",
    voice_settings:{stability:0.5,similarity_boost:0.75,style:0,use_speaker_boost:false,speed:1.1}});
  // The request is content-addressed like every other dispatch: the same line always hashes the same.
  expect(contentHash(elevenLabsLineRequest(line))).toBe(contentHash(request));
  expect(contentHash(elevenLabsLineRequest(compileAudioLine(source,profile({controls:{speed:1,volume:1,emotion:"neutral",...ELEVENLABS_DEFAULTS}} as Partial<AudioVoiceProfile>)))))
    .not.toBe(contentHash(request));
});

test("the contract refuses what the service does not do",()=>{
  // No loudness control, no other provider's emotion, and no phoneme alignment.
  expect(()=>compileAudioLine(source,profile({controls:{speed:1.1,volume:0.8,emotion:"neutral",...ELEVENLABS_DEFAULTS}} as Partial<AudioVoiceProfile>))).toThrow("loudness");
  expect(()=>compileAudioLine(source,profile({controls:{speed:1.1,volume:1,emotion:"sad",...ELEVENLABS_DEFAULTS}} as Partial<AudioVoiceProfile>))).toThrow("emotion control");
  expect(()=>compileAudioLine(source,profile(),undefined,"words-and-phonemes")).toThrow("word boundaries");
  // The pacing band is the service's own.
  for(const speed of [0.69,1.21])expect(()=>compileAudioLine(source,profile({controls:{speed,volume:1,emotion:"neutral",...ELEVENLABS_DEFAULTS}} as Partial<AudioVoiceProfile>))).toThrow("Speed");
  expect(()=>compileAudioLine(source,profile({controls:{speed:1.005,volume:1,emotion:"neutral",...ELEVENLABS_DEFAULTS}} as Partial<AudioVoiceProfile>))).toThrow("steps of 0.01");
  // Phrase direction belongs to the adapters that can carry it.
  expect(()=>compileAudioLine(source,profile(),{sourceHash:source.hash,phrases:[{start:0,end:3,text:"One",speed:1}]})).toThrow("one plain line");
  // A voice ID that the service never issues, and another vendor's schema pairing.
  for(const id of ["not-a-voice",VOICE_ID.slice(0,19),VOICE_ID+"X","0189c1a2-3b4c-4d5e-8f60-112233445566"])
    expect(()=>compileAudioLine(source,profile({voice:{id,catalogueRevision:hash,permissionRevision:permission}}))).toThrow("authorized catalogue");
  expect(()=>compileAudioLine(source,profile({schema:"hv-audio-voice/2"} as Partial<AudioVoiceProfile>))).toThrow("supported voice");
  expect(()=>compileAudioLine(source,profile({provider:"cartesia"} as Partial<AudioVoiceProfile>))).toThrow("supported voice");
  // A line longer than the model takes is refused before dispatch, not truncated.
  const long=lineSources([{character:"ELENA",lines:["a ".repeat(Math.ceil(ELEVENLABS_MAX_LINE_CHARACTERS/2)+10)]}])[0]!;
  expect(()=>elevenLabsLineRequest(compileAudioLine(long,profile()))).toThrow("at most");
});

test("word timings are derived from the service's character alignment, or the read is unusable",()=>{
  const characters=[..."One more."],alignment={characters,
    character_start_times_seconds:characters.map((_c,index)=>index*0.1),
    character_end_times_seconds:characters.map((_c,index)=>index*0.1+0.1)};
  expect(elevenLabsWordTimings(alignment,1)).toEqual([
    {text:"One",startSec:0,endSec:0.30000000000000004},
    {text:"more.",startSec:0.4,endSec:0.9},
  ]);
  // A zero-length character is not an error; the read is still the read.
  expect(()=>elevenLabsWordTimings({...alignment,character_end_times_seconds:alignment.character_start_times_seconds},1)).not.toThrow();
  for(const value of [
    {...alignment,character_start_times_seconds:[...alignment.character_start_times_seconds].reverse()},   // out of order
    {...alignment,character_end_times_seconds:alignment.character_end_times_seconds.map(time=>time+5)},    // past the audio
    {...alignment,characters:characters.slice(1)},                                                        // shorter than its timings
    {...alignment,characters:characters.map(()=>" ")},                                                    // no words at all
  ])expect(()=>elevenLabsWordTimings(value,1)).toThrow();
});
