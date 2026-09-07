import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import {audioPolicy} from "../../packages/planner/src/audio-jobs";
import {audioVoiceProfile} from "../../packages/planner/src/audio-performances";
import {AzureAudioProvider,type AzureSynth} from "../../packages/generator/src/azure-audio";
import {AUDIO_PCM} from "./audio";
// Entirely synthetic qualification data. Never an active policy or real licence.
export const AZURE_POLICY=audioPolicy({provider:"azure",voiceId:"en-US-JaneNeural",label:"Azure Jane · synthetic fixture",
  accountRevision:"5".repeat(64),catalogueRevision:"6".repeat(64),licenceEvidenceSha256:"7".repeat(64),priceEvidenceSha256:"8".repeat(64),
  heldUsd:.25,maxCharacters:2000,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
export const AZURE_PROFILE=audioVoiceProfile({schema:"hv-audio-voice/2",provider:"azure",language:"en",voice:{id:AZURE_POLICY.voiceId,catalogueRevision:AZURE_POLICY.catalogueRevision,permissionRevision:AZURE_POLICY.permissionRevision},controls:{emotion:"neutral",style:"sad",intensity:1.4,speed:1,volume:1},pronunciations:[]});
export function azureFixture(options:{timeoutMs?:number;mode?:"success"|"hang"|"bad-timing"|"cancelled";words?:string[]}={}){
  const calls:string[]=[];let closed=0;
  const provider=new AzureAudioProvider({apiKey:"fixture-not-a-real-key",timeoutMs:options.timeoutMs,synthFactory:()=>{
    const synth:AzureSynth={wordBoundary:undefined,synthesizing:undefined,close(){closed++;},speakSsmlAsync(ssml,success){calls.push(ssml);if(options.mode==="hang")return;
      const words=options.words??["Hello."];for(const [i,text]of words.entries())synth.wordBoundary?.({} as sdk.SpeechSynthesizer,new sdk.SpeechSynthesisWordBoundaryEventArgs(options.mode==="bad-timing"?-1:i*3e6,2e6,text,text.length,i*5,sdk.SpeechSynthesisBoundaryType.Word));
      success({reason:options.mode==="cancelled"?sdk.ResultReason.Canceled:sdk.ResultReason.SynthesizingAudioCompleted,resultId:"fixture-result-"+crypto.randomUUID(),audioData:Uint8Array.from(AUDIO_PCM).buffer});
    }};return synth;
  }});return {provider,calls,get closed(){return closed;}};
}
