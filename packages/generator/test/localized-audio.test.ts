import {expect,test} from "bun:test";
import {CartesiaAudioProvider,validateAudioIntent,validateAudioOutcome} from "../src/cartesia-audio";
import {verifyAudioWav} from "../src/audio-media";
import {lineSources} from "../../planner/src/performances";
import {DUB_POLICY,localizedLine} from "../../../test/fixtures/localized-audio";
import {AUDIO_PCM} from "../../../test/fixtures/audio";
test("multilingual SSE sends the reviewed Arabic transcript and language without English emotion or invented alignment",async()=>{
  const text="أهلاً بك في البيت.",plan=localizedLine(lineSources([{character:"MARLA",lines:["Welcome home."]}])[0]!,"ar",text),requests:any[]=[],events:string[]=[];
  const wire=Bun.serve({port:0,hostname:"127.0.0.1",async fetch(request){const body=await request.json() as any;requests.push(body);const rows=[{type:"chunk",data:AUDIO_PCM.toString("base64")},{type:"timestamps",word_timestamps:{words:[text],start:[0],end:[.9]}},{type:"done",done:true}];return new Response(rows.map(row=>"data: "+JSON.stringify({context_id:body.context_id,status_code:row.type==="done"?200:206,done:false,...row})+"\n\n").join(""),{headers:{"content-type":"text/event-stream"}});}});
  try{const provider=new CartesiaAudioProvider({apiKey:"fixture-not-a-real-key",fetchImpl:(async(url,init)=>{expect(url).toBe("https://api.cartesia.ai/tts/sse");expect(events[0]).toBe("reserved");return fetch(wire.url,init);}) as typeof fetch});
    const result=await provider.synthesize(plan,{async authorize(intent,line){validateAudioIntent(intent,line);events.push("reserved");return {id:intent.attemptId,priceRevision:DUB_POLICY.priceRevision,heldUsd:DUB_POLICY.heldUsd};},async assertCurrent(){events.push("checked");},async recordOutcome(outcome){validateAudioOutcome(outcome);events.push("recorded");}});
    expect(requests).toHaveLength(1);expect(requests[0].language).toBe("ar");expect(requests[0].transcript).toBe(text);expect(requests[0].generation_config).toEqual({speed:1,volume:1});expect(requests[0].add_phoneme_timestamps).toBe(false);
    expect(result.report.alignment.words[0]!.text).toBe(text);expect(result.report.alignment.phonemes).toEqual([]);expect(result.report.plan.localization).toEqual(plan.localization);expect(result.outcome.billing.state).toBe("unreconciled");expect(events.at(-1)).toBe("recorded");verifyAudioWav(result.wav,result.report);
  }finally{await wire.stop(true);}
});
