import {contentHash} from "./capabilities";

export const AZURE_AUDIO_MODEL="standard-neural";
export const AZURE_AUDIO_API="speech-sdk-1.51.0-websocket-v1";
export const AZURE_AUDIO_REGION="eastus";
export const AZURE_VOICES=["en-US-GuyNeural","en-US-DavisNeural","en-US-JaneNeural"] as const;
// Intersection of the published styles for these three explicitly supported
// emphasis voices. Operator catalogue/licence evidence remains mandatory.
export const AZURE_STYLES=["neutral","angry","cheerful","excited","friendly","hopeful","sad","shouting","terrified","unfriendly","whispering"] as const;
export type AzureStyle=typeof AZURE_STYLES[number];
const definition={schema:"hv-audio-capability/3",provider:"azure" as const,model:AZURE_AUDIO_MODEL,apiVersion:AZURE_AUDIO_API,region:AZURE_AUDIO_REGION,
  qualification:"transport-fixtures-only",languages:["en"],voices:[...AZURE_VOICES],modelVersion:"service-managed-not-pinnable",
  controls:{speed:{min:.6,max:1.5,interpretation:"SSML-rate"},volume:{min:.5,max:2,interpretation:"SSML-relative-volume"},
    style:[...AZURE_STYLES],intensity:{min:.01,max:2,step:.01,interpretation:"native-styledegree",neutral:false},
    wordEmphasis:["reduced","none","moderate","strong"],phraseVolume:false,notes:"retained-direction-only",pauses:"local-exact-silence"},
  alignment:{words:true,phonemes:false,visemes:false,basis:"provider-word-boundary-events"},
  output:{encoding:"pcm_s16le",channels:1,sampleRate:48000,maxSpeechSeconds:600},maxLineCharacters:20000,maxTranscriptCharacters:40000,
  voiceCloning:false,determinism:"none",cancellation:"disconnect-billing-unconfirmed",billing:{unit:"characters",actualUsd:null,reconciliation:"operator-invoice-allocation"},
  documentation:["https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice",
    "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts",
    "https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/speechsynthesiswordboundaryeventargs?view=azure-node-latest"]};
function freeze<T>(value:T):T{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const AZURE_AUDIO_CAPABILITY=freeze({...definition,revision:contentHash(definition)});
