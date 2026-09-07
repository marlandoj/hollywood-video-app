import {contentHash} from "./capabilities";

export const LIPSYNC_MODEL="sync-3";
export const LIPSYNC_API="rest-v2-2026-09-07";
const definition={schema:"hv-lipsync-capability/1",provider:"sync",model:LIPSYNC_MODEL,apiVersion:LIPSYNC_API,
  modelVersion:"service-managed-not-pinnable",qualification:"closed-transport-fixtures-only",
  input:{visual:"video",audio:"retained-dialogue-pcm",transport:"multipart",maxFileBytes:19000000,maxFrames:900,fps:30,maxWidth:1920,maxHeight:1080},
  selection:{mode:"manual",coordinates:"native-input-pixels",frame:"input-relative"},
  controls:{syncMode:"cut_off",emotion:"inherited-audio-and-picture",intensity:false,gesture:false},
  output:{kind:"new-picture-version",originalCut:"retained",audio:"original-dialogue-waveform",captions:"original-dialogue-timing"},
  recovery:{submission:"one-original-attempt",observation:"resume-original-generation-id",unknownSubmission:"operator-reconciliation"},
  quality:{automaticScore:false,ownerRubric:["mouth-sync","face-stability","expression"],cutawaySuggestions:"advisory"},
  voiceCloning:false,textToSpeech:false,determinism:"none",billing:"operator-invoice-allocation",
  documentation:["https://sync.so/docs/api-reference/api/generate-api/create-with-files","https://sync.so/docs/api-reference/api/generate-api/get","https://sync.so/docs/developer-guides/speaker-selection","https://sync.so/docs/models/sync-3"],
  openapiSha256:"e255042ea0a27845b355adda0ef73c1b7f81e14fea178485727b78b2d0afaf08"};
function freeze<T>(value:T):T{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const LIPSYNC_CAPABILITY=freeze({...definition,revision:contentHash(definition)});
