import {expect,test} from "bun:test";
import {ElevenLabsAudioProvider,resampleElevenLabsPcm} from "../src/elevenlabs-audio";
import {AudioProviderError,validateAudioIntent,validateAudioOutcome,type AudioAttemptJournal,type AudioAttemptOutcome} from "../src/cartesia-audio";
import {ELEVENLABS_AUDIO_CAPABILITY,ELEVENLABS_SAMPLE_RATE} from "../src/elevenlabs-capability";
import {AUDIO_SAMPLE_RATE} from "../src/audio-capabilities";
import {validateAudioDelivery} from "../src/audio-delivery";
import {audioVoiceProfile,compileAudioLine} from "../../planner/src/audio-performances";
import {AZURE_PROFILE} from "../../../test/fixtures/azure-audio";
import {lineSources} from "../../planner/src/performances";

/**
 * HV-022-06: the ElevenLabs adapter on the shared protocol. Nothing here reaches the network: the
 * transport is a stub, as the other adapters' qualification fixtures are. What is proved is the
 * order of the journal, the shape of the request, the conversion to the studio's sample rate, and
 * that every failure leaves exactly one recorded attempt with its hold intact.
 */
const VOICE_ID="CwhRBWXzGAHq8TQ4Fs17";
const PROFILE=audioVoiceProfile({schema:"hv-audio-voice/4",provider:"elevenlabs",language:"en",
  voice:{id:VOICE_ID,catalogueRevision:"a".repeat(64),permissionRevision:"b".repeat(64)},
  controls:{speed:1.1,volume:1,emotion:"neutral",stability:0.5,similarity:0.75,exaggeration:0},pronunciations:[]});
const source=lineSources([{character:"ELENA",lines:["One more."]}])[0]!;
const line=()=>compileAudioLine(source,PROFILE,{sourceHash:source.hash,beforeMs:100});

/** Half a second of 44.1 kHz mono tone, as the service would return it. */
const NATIVE_SAMPLES=ELEVENLABS_SAMPLE_RATE/2;
const native=()=>{const pcm=Buffer.alloc(NATIVE_SAMPLES*2);for(let i=0;i<NATIVE_SAMPLES;i++)pcm.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*220*i/ELEVENLABS_SAMPLE_RATE)),i*2);return pcm;};
const alignment=(text="One more.",seconds=0.5)=>{const characters=[...text];
  return {characters,character_start_times_seconds:characters.map((_c,i)=>i*seconds/characters.length),
    character_end_times_seconds:characters.map((_c,i)=>(i+1)*seconds/characters.length)};};

function journal(){
  const outcomes:AudioAttemptOutcome[]=[],order:string[]=[];
  const value:AudioAttemptJournal={
    authorize:async(intent,plan)=>{order.push("authorize");validateAudioIntent(intent,plan);return {id:"test",heldUsd:.002,priceRevision:"c".repeat(64)};},
    assertCurrent:async()=>{order.push("current");},
    recordOutcome:async outcome=>{validateAudioOutcome(outcome);outcomes.push(outcome);order.push("record");}};
  return {journal:value,outcomes,order};
}
function stub(over:{status?:number;body?:unknown;headers?:Record<string,string>;hang?:boolean}={}){
  const calls:{url:string;body:any;key:string|null}[]=[];
  const fetchImpl=(async(url:any,init:any)=>{
    calls.push({url:String(url),body:JSON.parse(String(init.body)),key:new Headers(init.headers).get("xi-api-key")});
    if(over.hang)await new Promise((_resolve,reject)=>{init.signal?.addEventListener("abort",()=>reject(init.signal.reason),{once:true});});
    return new Response(JSON.stringify(over.body??{audio_base64:native().toString("base64"),alignment:alignment(),normalized_alignment:alignment()}),
      {status:over.status??200,headers:{"content-type":"application/json","request-id":"req-fixture-1",...over.headers}});
  }) as unknown as typeof fetch;
  return {calls,fetchImpl};
}
const provider=(over:Parameters<typeof stub>[0]={},options:{convert?:boolean;timeoutMs?:number}={})=>{
  const transport=stub(over);
  return {transport,provider:new ElevenLabsAudioProvider({apiKey:"fixture-key",fetchImpl:transport.fetchImpl,timeoutMs:options.timeoutMs,
    ...(options.convert===false?{convert:async(pcm:Buffer)=>pcm}:{})})};
};

test("one read: authorize, check the permission, dispatch once, convert to 48 kHz, record the outcome",async()=>{
  const {transport,provider:adapter}=provider(),j=journal(),plan=line();
  const output=await adapter.synthesize(plan,j.journal);
  expect(j.order).toEqual(["authorize","current","current","record"]);
  expect(transport.calls).toHaveLength(1);
  expect(transport.calls[0]!.key).toBe("fixture-key");
  expect(transport.calls[0]!.url).toContain(`/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=pcm_44100`);
  expect(transport.calls[0]!.body).toMatchObject({text:"One more.",model_id:"eleven_multilingual_v2",
    voice_settings:{stability:0.5,similarity_boost:0.75,style:0,use_speaker_boost:false,speed:1.1}});

  // The delivery is the studio's own format, with the read resampled from the service's 44.1 kHz.
  expect(output.report.format).toEqual({encoding:"pcm_s16le",channels:1,sampleRate:AUDIO_SAMPLE_RATE});
  const leading=AUDIO_SAMPLE_RATE*plan.beforeMs/1000*2;
  expect(output.pcm.length).toBeGreaterThan(leading+NATIVE_SAMPLES*2);
  expect(output.pcm.subarray(0,leading).every(byte=>byte===0)).toBe(true);
  expect(output.report.alignment.words.map(word=>word.text)).toEqual(["One","more."]);
  expect(validateAudioDelivery(output.report,output.pcm)).toEqual(output.report);

  // The attempt: dispatched, completed, its cost unknown until the vendor's own accounting says.
  expect(output.outcome.intent.provider).toBe("elevenlabs");
  expect(output.outcome.intent.capabilityRevision).toBe(ELEVENLABS_AUDIO_CAPABILITY.revision);
  expect(output.outcome.httpStatus).toBe(200);
  expect(output.outcome.providerRequestId).toBe("req-fixture-1");
  expect(output.outcome.providerState).toBe("completed");
  expect(output.outcome.billing).toEqual({state:"unreconciled",actualUsd:null});
  expect(output.outcome.deliveryRevision).toBe(output.report.revision);
  // Another vendor's line belongs to another adapter.
  await expect(adapter.synthesize(compileAudioLine(source,AZURE_PROFILE,{sourceHash:source.hash}),j.journal)).rejects.toThrow("own audio adapter");
});

test("every failure leaves one recorded attempt, its hold intact and no provider text",async()=>{
  // The service refuses: the attempt is recorded as rejected and nothing is delivered.
  {
    const {transport,provider:adapter}=provider({status:429,body:{detail:"quota exceeded for sk-secret"}}),j=journal();
    await expect(adapter.synthesize(line(),j.journal)).rejects.toBeInstanceOf(AudioProviderError);
    expect(transport.calls).toHaveLength(1);
    expect(j.outcomes).toHaveLength(1);
    expect(j.outcomes[0]!.providerState).toBe("rejected");
    expect(j.outcomes[0]!.deliveryState).toBe("withheld");
    expect(j.outcomes[0]!.billing).toEqual({state:"unreconciled",actualUsd:null});
    expect(JSON.stringify(j.outcomes[0])).not.toContain("sk-secret");
  }
  // Unusable payloads: not base64, not whole samples, and an alignment that is not the read's.
  for(const body of [{audio_base64:"not base64!!",alignment:alignment()},
    {audio_base64:Buffer.alloc(3).toString("base64"),alignment:alignment()},
    {audio_base64:native().toString("base64")},
    {audio_base64:native().toString("base64"),alignment:{...alignment(),character_end_times_seconds:alignment().character_end_times_seconds.map(t=>t+90)}}]){
    const {provider:adapter}=provider({body},{convert:false}),j=journal();
    await expect(adapter.synthesize(line(),j.journal)).rejects.toBeInstanceOf(AudioProviderError);
    expect(j.outcomes).toHaveLength(1);
    expect(j.outcomes[0]!.deliveryState).toBe("withheld");
    expect(j.outcomes[0]!.deliveryRevision).toBeNull();
  }
  // Permission withdrawn before the request: nothing is dispatched at all.
  {
    const {transport,provider:adapter}=provider(),j=journal();
    j.journal.assertCurrent=async()=>{throw new Error("revoked private data");};
    await expect(adapter.synthesize(line(),j.journal)).rejects.toThrow("not dispatched");
    expect(transport.calls).toHaveLength(0);
    expect(j.outcomes[0]!.dispatched).toBe(false);
    expect(j.outcomes[0]!.billing).toEqual({state:"not-incurred",actualUsd:0});
  }
  // Permission withdrawn while the read was in flight: the attempt completed, the delivery does not.
  {
    const {provider:adapter}=provider({},{convert:false}),j=journal();let checks=0;
    j.journal.assertCurrent=async()=>{if(++checks===2)throw new Error("revoked");};
    await expect(adapter.synthesize(line(),j.journal)).rejects.toBeInstanceOf(AudioProviderError);
    expect(j.outcomes[0]!.providerState).toBe("completed");
    expect(j.outcomes[0]!.deliveryState).toBe("withheld");
    expect(j.outcomes[0]!.deliveryRevision).toBeNull();
  }
  // The deadline: the request is abandoned and the attempt is still recorded.
  {
    const {provider:adapter}=provider({hang:true},{timeoutMs:30}),j=journal();
    await expect(adapter.synthesize(line(),j.journal)).rejects.toBeInstanceOf(AudioProviderError);
    expect(j.outcomes).toHaveLength(1);
    expect(j.outcomes[0]!.dispatched).toBe(true);
  }
  // Recording the outcome fails: the caller is told to reconcile, and no provider text escapes.
  {
    const {provider:adapter}=provider(),j=journal();
    j.journal.recordOutcome=async()=>{throw new Error("ledger secret");};
    try{await adapter.synthesize(line(),j.journal);throw new Error("expected failure");}
    catch(error){
      expect(error).toBeInstanceOf(AudioProviderError);
      expect((error as AudioProviderError).failure).toBe("accounting");
      expect(String(error)).not.toContain("ledger secret");
    }
  }
});

test("the conversion to 48 kHz is the one the capability declares",async()=>{
  const converted=await resampleElevenLabsPcm(native(),AbortSignal.timeout(60_000));
  // Half a second in, half a second out, at the studio's rate, and byte-identical run to run.
  expect(converted.length/2).toBeGreaterThan(AUDIO_SAMPLE_RATE/2*0.98);
  expect(converted.length/2).toBeLessThan(AUDIO_SAMPLE_RATE/2*1.02);
  expect(await resampleElevenLabsPcm(native(),AbortSignal.timeout(60_000))).toEqual(converted);
  expect(ELEVENLABS_AUDIO_CAPABILITY.output.conversion).toContain(`aresample=${AUDIO_SAMPLE_RATE}`);
},120000);
