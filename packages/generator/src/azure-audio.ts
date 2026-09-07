import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import {randomUUID} from "node:crypto";
import {AZURE_AUDIO_API,AZURE_AUDIO_CAPABILITY,AZURE_AUDIO_MODEL} from "./azure-capability";
import {AZURE_AUDIO_REGION,azureLineRequest} from "./azure-request";
import {contentHash} from "./capabilities";
import {audioAbortable} from "./audio-stream";
import {createAudioDelivery,validateAudioTimings,type AudioTiming} from "./audio-delivery";
import {validateAudioLinePlan,audioNumber,audioHash,audioRecord,type AudioLinePlan} from "../../planner/src/audio-performances";
import {AudioProviderError,validateAudioOutcome,type AudioAttemptJournal,type AudioAttemptOutcome,type AudioDispatchIntent} from "./cartesia-audio";

export type AzureBoundary=sdk.SpeechSynthesisWordBoundaryEventArgs;
export interface AzureResult {reason:sdk.ResultReason;resultId:string;audioData:ArrayBuffer}
export interface AzureSynth {
  wordBoundary:((sender:sdk.SpeechSynthesizer,event:AzureBoundary)=>void)|undefined;
  synthesizing:((sender:sdk.SpeechSynthesizer,event:sdk.SpeechSynthesisEventArgs)=>void)|undefined;
  speakSsmlAsync(ssml:string,success:(result:AzureResult)=>void,failure:(error:string)=>void):void;
  close():void;
}
/** Configuration is fixed to one documented catalogue region. No arbitrary
 * endpoint, custom voice, account token or subscription is owner-supplied. */
export function azureSdkSynth(apiKey:string):AzureSynth{
  const config=sdk.SpeechConfig.fromSubscription(apiKey,AZURE_AUDIO_REGION);
  config.speechSynthesisOutputFormat=sdk.SpeechSynthesisOutputFormat.Raw48Khz16BitMonoPcm;
  config.setProperty(sdk.PropertyId.SpeechServiceResponse_RequestWordBoundary,"true");
  config.setProperty(sdk.PropertyId.SpeechServiceResponse_RequestSentenceBoundary,"false");
  return new sdk.SpeechSynthesizer(config,null);
}
function freeze<T>(value:T):T{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export class AzureAudioProvider {
  readonly capabilities=AZURE_AUDIO_CAPABILITY;
  private readonly timeoutMs:number;
  constructor(private readonly options:{apiKey:string;timeoutMs?:number;synthFactory?:(apiKey:string)=>AzureSynth}){
    if(typeof options.apiKey!=="string"||!options.apiKey.trim()||options.apiKey.length>4096||/\s/.test(options.apiKey))throw new Error("Configure the Azure speech credential on the worker.");
    this.timeoutMs=audioNumber(options.timeoutMs??120000,1,180000,"Audio request timeout",true);
  }
  async synthesize(input:AudioLinePlan,journal:AudioAttemptJournal,signal?:AbortSignal){
    const plan=freeze(validateAudioLinePlan(input));if(plan.profile.provider!=="azure"||plan.capabilityRevision!==AZURE_AUDIO_CAPABILITY.revision)throw new Error("The selected voice requires its own audio adapter.");
    if(!journal||[journal.authorize,journal.assertCurrent,journal.recordOutcome].some(fn=>typeof fn!=="function"))throw new Error("Audio synthesis requires a durable reservation and permission journal.");
    const id=randomUUID(),intent=freeze<AudioDispatchIntent>({schema:"hv-audio-dispatch/2",attemptId:id,contextId:id,planRevision:plan.revision,capabilityRevision:plan.capabilityRevision,
      requestSha256:contentHash(azureLineRequest(plan)),provider:"azure",model:AZURE_AUDIO_MODEL,apiVersion:AZURE_AUDIO_API});
    let outcome:AudioAttemptOutcome={schema:"hv-audio-attempt-outcome/1",intent,reservation:null,dispatched:false,providerState:"not-dispatched",deliveryState:"withheld",httpStatus:null,providerRequestId:null,billing:{state:"not-incurred",actualUsd:0},deliveryRevision:null};
    const deadline=AbortSignal.timeout(this.timeoutMs),combined=signal?AbortSignal.any([signal,deadline]):deadline;
    let synth:AzureSynth|undefined,result:ReturnType<typeof createAudioDelivery>|undefined,failed=false,failure:AudioProviderError["failure"]="authorization";
    const close=()=>{try{synth?.close();}catch{/* Outcome recording still owns the liability. */}};
    try{
      combined.throwIfAborted();const held=await journal.authorize(intent,plan);audioRecord(held,["id","priceRevision","heldUsd"]);audioHash(held.priceRevision);audioNumber(held.heldUsd,.000001,1000000,"Audio reservation");
      if(typeof held.id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(held.id))throw new Error("Invalid audio reservation.");outcome.reservation=freeze(held);
      failure="permission-changed";combined.throwIfAborted();await journal.assertCurrent(intent,plan);combined.throwIfAborted();
      failure="transport";outcome.dispatched=true;outcome.providerState="unconfirmed";outcome.billing={state:"unreconciled",actualUsd:null};
      synth=(this.options.synthFactory??azureSdkSynth)(this.options.apiKey);combined.addEventListener("abort",close,{once:true});
      const words:AudioTiming[]=[];let bytes=0;
      const response=await audioAbortable(new Promise<AzureResult>((resolve,reject)=>{
        const bad=()=>{failure="protocol";reject(new Error("Invalid speech event."));close();};
        synth!.wordBoundary=(_sender,event)=>{try{
          if(![sdk.SpeechSynthesisBoundaryType.Word,sdk.SpeechSynthesisBoundaryType.Punctuation,sdk.SpeechSynthesisBoundaryType.Sentence].includes(event.boundaryType))return bad();
          if(event.boundaryType!==sdk.SpeechSynthesisBoundaryType.Word)return;
          for(const n of [event.audioOffset,event.duration])if(!Number.isSafeInteger(n)||n<0)throw new Error("Invalid ticks.");
          const timing=validateAudioTimings([{text:event.text,startSec:event.audioOffset/1e7,endSec:(event.audioOffset+event.duration)/1e7}],1,600)[0]!;
          const prior=words.at(-1);if(words.length>=20000||prior&&(timing.startSec<prior.startSec||timing.endSec<prior.endSec))throw new Error("Unordered boundaries.");words.push(timing);
        }catch{bad();}};
        synth!.synthesizing=(_sender,event)=>{try{bytes+=event.result.audioData.byteLength;if(bytes>48000*2*600)bad();}catch{bad();}};
        // Exactly one synthesis call. Disconnect/cancellation does not imply a
        // refund; no voice fallback or second synthesis attempt is scheduled.
        synth!.speakSsmlAsync(azureLineRequest(plan).ssml!,resolve,()=>reject(new Error("Speech SDK request failed.")));
      }),combined);
      failure="protocol";
      if(typeof response.resultId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(response.resultId))throw new Error("Missing speech result identity.");outcome.providerRequestId=response.resultId;
      if(response.reason!==sdk.ResultReason.SynthesizingAudioCompleted)throw new Error("Speech synthesis did not complete.");
      outcome.providerState="completed";combined.throwIfAborted();
      result=createAudioDelivery(plan,id,Buffer.from(response.audioData),words,[]);
      failure="permission-changed";await journal.assertCurrent(intent,plan);combined.throwIfAborted();outcome.deliveryState="ready";outcome.deliveryRevision=result.report.revision;
    }catch{failed=true;if(signal?.aborted)failure="cancelled";else if(deadline.aborted)failure="timeout";outcome.deliveryState="withheld";outcome.deliveryRevision=null;}
    finally{combined.removeEventListener("abort",close);close();}
    validateAudioOutcome(outcome);outcome=freeze(outcome);
    try{await journal.recordOutcome(outcome);}catch{throw new AudioProviderError("Audio outcome recording failed. Reconcile the original attempt before retrying.","accounting",outcome);}
    if(combined.aborted||failed||!result)throw new AudioProviderError("Audio delivery was withheld. The original attempt retains its billing and permission evidence.",combined.aborted?(signal?.aborted?"cancelled":"timeout"):failure,outcome);
    return {...result,outcome};
  }
}
