import {audioPolicy} from "../../packages/planner/src/audio-jobs";
import {cartesiaLineRequest,type AudioDispatchIntent} from "../../packages/generator/src/cartesia-audio";
import {CARTESIA_MODEL,CARTESIA_API_VERSION} from "../../packages/generator/src/audio-capabilities";
import {contentHash} from "../../packages/generator/src/capabilities";
import type {AudioLinePlan} from "../../packages/planner/src/audio-performances";
export const AUDIO_POLICY=audioPolicy({voiceId:"db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",label:"Closed fixture voice",
  accountRevision:"1".repeat(64),catalogueRevision:"2".repeat(64),licenceEvidenceSha256:"3".repeat(64),priceEvidenceSha256:"4".repeat(64),
  heldUsd:.25,maxCharacters:500,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
// Synthetic transport probe. This is neither speech nor a licensed voice sample.
export const AUDIO_PCM=Buffer.alloc(48000*2);
for(let i=0;i<48000;i++)AUDIO_PCM.writeInt16LE(Math.round(Math.sin(i*.04)*2000),i*2);
export function audioSse(context:string){
  const rows=[{type:"chunk",data:AUDIO_PCM.toString("base64")},
    {type:"timestamps",word_timestamps:{words:["Hello."],start:[0],end:[.9]}},
    {type:"phoneme_timestamps",phoneme_timestamps:{phonemes:["h"],start:[0],end:[.9]}},
    {type:"done",done:true}];
  return new Response(rows.map(row=>"data: "+JSON.stringify({context_id:context,status_code:row.type==="done"?200:206,done:false,...row})+"\n\n").join(""),{headers:{"content-type":"text/event-stream"}});
}
export function audioIntent(line:AudioLinePlan):AudioDispatchIntent{
  const id=crypto.randomUUID();return {schema:"hv-audio-dispatch/1",attemptId:id,contextId:id,planRevision:line.revision,capabilityRevision:line.capabilityRevision,
    requestSha256:contentHash(cartesiaLineRequest(line,id)),provider:"cartesia",model:CARTESIA_MODEL,apiVersion:CARTESIA_API_VERSION};
}
