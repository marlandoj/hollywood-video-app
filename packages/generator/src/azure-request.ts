import {AZURE_AUDIO_API,AZURE_AUDIO_MODEL,AZURE_AUDIO_REGION} from "./azure-capability";
import type {AudioLinePlan} from "../../planner/src/audio-performances";

export {AZURE_AUDIO_REGION} from "./azure-capability";
export function azureLineRequest(plan:AudioLinePlan){
  return {provider:"azure",model:AZURE_AUDIO_MODEL,apiVersion:AZURE_AUDIO_API,region:AZURE_AUDIO_REGION,
    ssml:plan.providerTranscript,outputFormat:"raw-48khz-16bit-mono-pcm",wordBoundary:true,phonemes:false};
}
