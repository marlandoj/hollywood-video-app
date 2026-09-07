import {expect,test} from "bun:test";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import {AzureAudioProvider} from "../src/azure-audio";
import {AudioProviderError,CartesiaAudioProvider,validateAudioIntent,validateAudioOutcome,type AudioAttemptJournal,type AudioAttemptOutcome} from "../src/cartesia-audio";
import {azureFixture,AZURE_POLICY,AZURE_PROFILE} from "../../../test/fixtures/azure-audio";
import {AUDIO_PCM} from "../../../test/fixtures/audio";
import {compileAudioLine} from "../../planner/src/audio-performances";
import {lineSources} from "../../planner/src/performances";
import {validateAudioDelivery} from "../src/audio-delivery";
import {createScenePerformance,type ScenePerformance} from "../../planner/src/performance-memory";
import {parseFountain} from "../../parser/src/index";
const source=lineSources([{character:"MARLA",lines:["Hello."]}])[0]!;
const line=(memory?:ScenePerformance)=>compileAudioLine(source,AZURE_PROFILE,{sourceHash:source.hash,beforeMs:100,phrases:[{start:0,end:6,text:"Hello.",emphasis:"strong"}]},undefined,memory);
function journal(){const outcomes:AudioAttemptOutcome[]=[],order:string[]=[];const journal:AudioAttemptJournal={authorize:async(intent,plan)=>{order.push("authorize");validateAudioIntent(intent,plan);return {id:"test",heldUsd:.25,priceRevision:AZURE_POLICY.priceRevision};},assertCurrent:async()=>{order.push("current");},recordOutcome:async o=>{validateAudioOutcome(o);outcomes.push(o);order.push("record");}};return {journal,outcomes,order};}
test("native SDK event auditions retain word timing and unknown billing with no synthetic phonemes or HTTP status",async()=>{
  const f=azureFixture(),j=journal(),p=line(),output=await f.provider.synthesize(p,j.journal);expect(f.calls).toEqual([p.providerTranscript!]);expect(j.order).toEqual(["authorize","current","current","record"]);expect(f.closed).toBe(1);
  expect(output.report.schema).toBe("hv-audio-line-delivery/2");expect(output.report.alignment).toEqual({basis:"provider-word-boundary-events",origin:"speech-start",words:[{text:"Hello.",startSec:0,endSec:.2}],phonemes:[]});expect(output.outcome.httpStatus).toBeNull();expect(output.outcome.billing.actualUsd).toBeNull();expect(output.pcm.subarray(4800*2,(4800+48000)*2)).toEqual(AUDIO_PCM);expect(validateAudioDelivery(output.report,output.pcm)).toEqual(output.report);
  expect(()=>validateAudioDelivery({...output.report,alignment:{...output.report.alignment,basis:"provider-normalized-transcript"}})).toThrow();
  await expect(new CartesiaAudioProvider({apiKey:"fixture"}).synthesize(p,j.journal)).rejects.toThrow("own audio adapter");
});
test("native admission, revocation, malformed events, deadlines and accounting failures retain one original attempt",async()=>{
  for(const mode of ["bad-timing","cancelled","hang"] as const){const f=azureFixture({mode,timeoutMs:20}),j=journal();await expect(f.provider.synthesize(line(),j.journal)).rejects.toBeInstanceOf(AudioProviderError);expect(f.calls).toHaveLength(1);expect(j.outcomes).toHaveLength(1);expect(j.outcomes[0]!.billing.actualUsd).toBeNull();expect(j.outcomes[0]!.deliveryState).toBe("withheld");}
  const f=azureFixture(),j=journal();j.journal.assertCurrent=async()=>{throw new Error("revoked private data");};await expect(f.provider.synthesize(line(),j.journal)).rejects.toThrow("withheld");expect(f.calls).toHaveLength(0);expect(j.outcomes[0]!.dispatched).toBe(false);
  const late=azureFixture(),last=journal();let checks=0;last.journal.assertCurrent=async()=>{if(++checks===2)throw new Error("revoked");};await expect(late.provider.synthesize(line(),last.journal)).rejects.toThrow();expect(last.outcomes[0]!.providerState).toBe("completed");expect(last.outcomes[0]!.deliveryRevision).toBeNull();
  const ledger=journal();ledger.journal.recordOutcome=async()=>{throw new Error("secret");};try{await azureFixture().provider.synthesize(line(),ledger.journal);throw new Error("expected failure");}catch(e){expect(e).toBeInstanceOf(AudioProviderError);expect((e as AudioProviderError).failure).toBe("accounting");expect(String(e)).not.toContain("secret");}
});
test("pinned real speech SDK sends one SSML request over closed WebSocket and returns its actual PCM and word events",async()=>{
  const memory=createScenePerformance(crypto.randomUUID(),parseFountain("INT. GARDEN - DAY\n\nMARLA\nHello.").scenes[0]!,{nativeVoice:{style:"hopeful",intensity:1.25}}),plan=line(memory);
  const calls:string[]=[],contexts:any[]=[];
  const wire=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req,server){if(server.upgrade(req))return;return new Response(null,{status:400});},websocket:{message(ws,message){
    if(typeof message!=="string")return;const split=message.indexOf("\r\n\r\n"),headers=message.slice(0,split),body=message.slice(split+4),path=/Path:([^\r]+)/i.exec(headers)?.[1]?.trim(),id=/X-RequestId:([^\r]+)/i.exec(headers)?.[1]?.trim();
    if(path==="synthesis.context")contexts.push(JSON.parse(body));if(path!=="ssml")return;calls.push(body);
    const text=(path:string,value:unknown)=>ws.send('X-RequestId:'+id+'\r\nPath:'+path+'\r\nContent-Type:application/json\r\n\r\n'+JSON.stringify(value));
    text("turn.start",{});text("response",{audio:{streamId:"probe"}});
    text("audio.metadata",{Metadata:[{Type:"WordBoundary",Data:{Offset:1000000,Duration:6000000,text:{Text:"Hello.",Length:6,BoundaryType:"WordBoundary"}}}]});
    const h=Buffer.from('X-RequestId:'+id+'\r\nX-StreamId:probe\r\nPath:audio\r\nContent-Type:audio/x-wav\r\n'),prefix=Buffer.alloc(2);prefix.writeUInt16BE(h.length);ws.send(Buffer.concat([prefix,h,AUDIO_PCM]));text("turn.end",{});
  }}});
  try{const provider=new AzureAudioProvider({apiKey:"fixture-not-real",timeoutMs:5000,synthFactory:key=>{
    // Only the test factory changes transport. Production has a fixed region.
    const config=sdk.SpeechConfig.fromHost(new URL(String(wire.url).replace("http:","ws:")),key);config.speechSynthesisOutputFormat=sdk.SpeechSynthesisOutputFormat.Raw48Khz16BitMonoPcm;config.setProperty(sdk.PropertyId.SpeechServiceResponse_RequestWordBoundary,"true");return new sdk.SpeechSynthesizer(config,null);
  }}),j=journal(),output=await provider.synthesize(plan,j.journal);
    expect(calls).toEqual([plan.providerTranscript!]);expect(calls[0]).toContain('style="hopeful" styledegree="1.25"');expect(output.report.plan.memory).toEqual(memory);expect(contexts).toHaveLength(1);expect(JSON.stringify(contexts[0])).toContain("raw-48khz-16bit-mono-pcm");expect(output.report.alignment.words).toEqual([{text:"Hello.",startSec:.1,endSec:.7}]);expect(output.report.alignment.phonemes).toEqual([]);expect(output.pcm.subarray(9600,105600)).toEqual(AUDIO_PCM);
  }finally{await wire.stop(true);}
},10000);
