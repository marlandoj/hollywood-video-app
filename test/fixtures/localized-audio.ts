import {audioPolicy} from "../../packages/planner/src/audio-jobs";
import {compileAudioLine} from "../../packages/planner/src/audio-performances";
import type {AudioLanguage} from "../../packages/generator/src/audio-languages";
import type {LineSource} from "../../packages/planner/src/performances";
import {AUDIO_POLICY} from "./audio";
export const DUB_POLICY=audioPolicy({voiceId:"40000000-0000-4000-8000-000000000001",label:"Synthetic multilingual fixture",
  accountRevision:AUDIO_POLICY.accountRevision,catalogueRevision:AUDIO_POLICY.catalogueRevision,licenceEvidenceSha256:AUDIO_POLICY.licenceEvidenceSha256,priceEvidenceSha256:AUDIO_POLICY.priceEvidenceSha256,
  heldUsd:.25,maxCharacters:500,validFrom:AUDIO_POLICY.validFrom,expiresAt:AUDIO_POLICY.expiresAt,languages:["en","es","ar","ja"]});
export function localizedLine(source:LineSource,language:AudioLanguage,text:string){
  return compileAudioLine(source,{schema:"hv-audio-voice/3",provider:"cartesia",language,voice:{id:DUB_POLICY.voiceId,catalogueRevision:DUB_POLICY.catalogueRevision,permissionRevision:DUB_POLICY.permissionRevision},controls:{speed:1,volume:1,emotion:"neutral"},pronunciations:[]},
    {sourceHash:source.hash,beforeMs:0,afterMs:0,localization:{language,text,sourceHash:source.hash,reviewed:true}},"words");
}
