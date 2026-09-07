import {createHash,randomUUID} from "node:crypto";
import {contentHash} from "./capabilities";
import {LIPSYNC_API,LIPSYNC_CAPABILITY,LIPSYNC_MODEL} from "./lipsync-capability";
import {lipDate,lipFail,lipHash,lipId,lipNumber,lipRecord,lipSame} from "../../planner/src/lipsync-policy";
import {validateLipSyncPlan,type LipSyncPlan,type LipSyncPrepared} from "../../planner/src/lipsync";

export interface LipSyncIntent {schema:"hv-lipsync-dispatch/1";attemptId:string;planRevision:string;preparedRevision:string;requestSha256:string;provider:"sync";model:string;apiVersion:string}
export interface LipSyncReservation {id:string;priceRevision:string;heldUsd:number}
export type LipSyncRemoteState="PENDING"|"PROCESSING"|"COMPLETED"|"FAILED"|"REJECTED";
export interface LipSyncDelivery {schema:"hv-lipsync-delivery/1";capabilityRevision:string;planRevision:string;preparedRevision:string;attemptId:string;generationId:string;provider:"sync";model:string;videoSha256:string;videoBytes:number;outputHost:string;revision:string}
export interface LipSyncReceipt {schema:"hv-lipsync-receipt/1";intent:LipSyncIntent;reservation:LipSyncReservation;dispatched:boolean;state:"not-dispatched"|"unconfirmed"|LipSyncRemoteState;remote:{id:string;createdAt:string}|null;httpStatus:number|null;observedAt:string;delivery?:LipSyncDelivery;revision:string}
export interface LipSyncJournal {authorize(intent:LipSyncIntent):Promise<LipSyncReservation>;assertCurrent():Promise<void>;observe(receipt:LipSyncReceipt):Promise<void>}
export class LipSyncProviderError extends Error {override name="LipSyncProviderError";constructor(message:string,readonly kind:"transport"|"protocol"|"accounting"|"permission"|"cancelled"|"ambiguous",readonly receipt?:LipSyncReceipt){super(message);}}
const ENDPOINT="https://api.sync.so/v2/generate",MAX_OUTPUT_BYTES=64*1024**2,STATES=["PENDING","PROCESSING","COMPLETED","FAILED","REJECTED"] as const;
const sum=(value:Uint8Array)=>createHash("sha256").update(value).digest("hex");
export function lipSyncRequest(plan:LipSyncPlan,prepared:LipSyncPrepared){
  if(prepared.planRevision!==plan.revision)lipFail("The lip-sync input belongs to another plan.");
  return {model:LIPSYNC_MODEL,video:{sha256:prepared.video.sha256,bytes:prepared.video.bytes},audio:{sha256:prepared.audio.sha256,bytes:prepared.audio.bytes},options:{sync_mode:"cut_off",active_speaker_detection:{auto_detect:false,frame_number:plan.selection.frame,coordinates:[plan.selection.x,plan.selection.y]}}};
}
export function validateLipSyncIntent(intent:LipSyncIntent,plan?:LipSyncPlan,prepared?:LipSyncPrepared):void{
  lipRecord(intent,["schema","attemptId","planRevision","preparedRevision","requestSha256","provider","model","apiVersion"]);lipId(intent.attemptId);[intent.planRevision,intent.preparedRevision,intent.requestSha256].forEach(lipHash);
  if(intent.schema!=="hv-lipsync-dispatch/1"||intent.provider!=="sync"||intent.model!==LIPSYNC_MODEL||intent.apiVersion!==LIPSYNC_API)lipFail("Unsupported lip-sync dispatch.");
  if(plan&&prepared&&(intent.planRevision!==plan.revision||intent.preparedRevision!==prepared.revision||intent.requestSha256!==contentHash(lipSyncRequest(plan,prepared))))lipFail("The lip-sync dispatch differs from its owned inputs.");
}
export function validateLipSyncDelivery(delivery:LipSyncDelivery,plan?:LipSyncPlan,prepared?:LipSyncPrepared):void{
  lipRecord(delivery,["schema","capabilityRevision","planRevision","preparedRevision","attemptId","generationId","provider","model","videoSha256","videoBytes","outputHost","revision"]);
  [delivery.capabilityRevision,delivery.planRevision,delivery.preparedRevision,delivery.videoSha256].forEach(lipHash);lipId(delivery.attemptId);lipId(delivery.generationId);lipNumber(delivery.videoBytes,1,MAX_OUTPUT_BYTES,"Returned video bytes",true);
  if(delivery.schema!=="hv-lipsync-delivery/1"||delivery.provider!=="sync"||delivery.model!==LIPSYNC_MODEL||delivery.capabilityRevision!==LIPSYNC_CAPABILITY.revision||typeof delivery.outputHost!=="string"||!/^([a-z0-9-]+\.)+[a-z]{2,63}$/.test(delivery.outputHost))lipFail("Invalid lip-sync delivery.");
  if(plan&&prepared&&(delivery.planRevision!==plan.revision||delivery.preparedRevision!==prepared.revision||!plan.policy.outputHosts.includes(delivery.outputHost)))lipFail("The returned video belongs to another lip-sync request.");
  const {revision,...data}=delivery;if(contentHash(data)!==revision)lipFail("The lip-sync delivery changed.");
}
export function validateLipSyncReceipt(receipt:LipSyncReceipt):LipSyncReceipt{
  lipRecord(receipt,["schema","intent","reservation","dispatched","state","remote","httpStatus","observedAt","delivery","revision"]);validateLipSyncIntent(receipt.intent);lipDate(receipt.observedAt);lipRecord(receipt.reservation,["id","priceRevision","heldUsd"]);
  lipId(receipt.reservation.id);lipHash(receipt.reservation.priceRevision);lipNumber(receipt.reservation.heldUsd,.000001,1000000,"Original lip-sync hold");
  if(receipt.reservation.heldUsd!==Number(receipt.reservation.heldUsd.toFixed(6))||receipt.schema!=="hv-lipsync-receipt/1"||typeof receipt.dispatched!=="boolean"||!["not-dispatched","unconfirmed",...STATES].includes(receipt.state)||(!receipt.dispatched&&(receipt.state!=="not-dispatched"||receipt.remote))||(receipt.dispatched&&receipt.state==="not-dispatched"))lipFail("Invalid lip-sync observation.");
  if(receipt.httpStatus!==null)lipNumber(receipt.httpStatus,100,599,"Provider HTTP status",true);
  if(receipt.remote){lipRecord(receipt.remote,["id","createdAt"]);lipId(receipt.remote.id);lipDate(receipt.remote.createdAt);if(!STATES.includes(receipt.state as LipSyncRemoteState))lipFail("Invalid remote generation state.");}
  else if(STATES.includes(receipt.state as LipSyncRemoteState))lipFail("Remote status needs its original generation ID.");
  if(receipt.delivery){validateLipSyncDelivery(receipt.delivery);if(receipt.state!=="COMPLETED"||receipt.delivery.attemptId!==receipt.intent.attemptId||receipt.delivery.generationId!==receipt.remote?.id||receipt.delivery.planRevision!==receipt.intent.planRevision||receipt.delivery.preparedRevision!==receipt.intent.preparedRevision)lipFail("The delivery differs from its original attempt.");}
  const {revision,...data}=receipt;if(contentHash(data)!==revision)lipFail("The lip-sync observation changed.");return structuredClone(receipt);
}
/** A later worker may observe the same generation; it cannot replace its identity,
 * repeat submission, reverse a terminal result or rewrite downloaded bytes. */
export function assertLipSyncObservation(previous:LipSyncReceipt|undefined,next:LipSyncReceipt):void{
  validateLipSyncReceipt(next);if(!previous)return;validateLipSyncReceipt(previous);
  if(!lipSame(previous.intent,next.intent)||!lipSame(previous.reservation,next.reservation)||Date.parse(next.observedAt)<Date.parse(previous.observedAt)||(previous.dispatched&&!next.dispatched)||(previous.remote&&!lipSame(previous.remote,next.remote))||(previous.delivery&&!lipSame(previous.delivery,next.delivery)))lipFail("The original lip-sync attempt is immutable.");
  if(["COMPLETED","FAILED","REJECTED"].includes(previous.state)&&previous.state!==next.state||previous.state==="PROCESSING"&&next.state==="PENDING")lipFail("The provider observation moved backwards.");
}
function seal(data:Omit<LipSyncReceipt,"revision">):LipSyncReceipt{return {...data,revision:contentHash(data)};}
async function bytes(response:Response,maximum:number,signal:AbortSignal):Promise<Buffer>{
  const declared=response.headers.get("content-length");if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))throw new Error("Unbounded provider response.");
  if(!response.body)throw new Error("Empty provider response.");const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{while(true){signal.throwIfAborted();const read=await reader.read();if(read.done)break;total+=read.value.byteLength;if(total>maximum)throw new Error("Provider response exceeds limit.");chunks.push(read.value);}return Buffer.concat(chunks,total);}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function pause(ms:number,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason);},timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});
}
export class SyncLipSyncProvider {
  readonly capabilities=LIPSYNC_CAPABILITY;
  private readonly fetchImpl:typeof fetch;
  constructor(private readonly options:{apiKey:string;fetchImpl?:typeof fetch;pollMs?:number;requestTimeoutMs?:number}){
    if(typeof options.apiKey!=="string"||!options.apiKey||options.apiKey.length>4096||/\s/.test(options.apiKey))lipFail("Configure the lip-sync credential on the worker.");this.fetchImpl=options.fetchImpl??fetch;
    lipNumber(options.pollMs??2000,1,30000,"Lip-sync observation interval",true);lipNumber(options.requestTimeoutMs??30000,1,120000,"Lip-sync request timeout",true);
  }
  async synthesize(input:LipSyncPlan,inputPrepared:LipSyncPrepared,inputMedia:{video:Uint8Array;audio:Uint8Array},journal:LipSyncJournal,prior?:LipSyncReceipt,signal=AbortSignal.timeout(30*60*1000)):Promise<{video:Buffer;delivery:LipSyncDelivery;receipt:LipSyncReceipt}>{
    const plan=validateLipSyncPlan(input),prepared=structuredClone(inputPrepared),media={video:Uint8Array.from(inputMedia.video),audio:Uint8Array.from(inputMedia.audio)},wire=lipSyncRequest(plan,prepared),{revision:preparedRevision,...preparedData}=prepared;
    if(contentHash(preparedData)!==preparedRevision)lipFail("The prepared lip-sync receipt changed.");
    for(const kind of ["video","audio"] as const)if(media[kind].byteLength!==prepared[kind].bytes||sum(media[kind])!==prepared[kind].sha256||media[kind].byteLength>LIPSYNC_CAPABILITY.input.maxFileBytes)lipFail("The provider input bytes changed before dispatch.");
    if(!journal||[journal.authorize,journal.assertCurrent,journal.observe].some(fn=>typeof fn!=="function"))lipFail("Lip-sync needs a durable attempt journal.");
    const intent:LipSyncIntent=prior?validateLipSyncReceipt(prior).intent:{schema:"hv-lipsync-dispatch/1",attemptId:randomUUID(),planRevision:plan.revision,preparedRevision:prepared.revision,requestSha256:contentHash(wire),provider:"sync",model:LIPSYNC_MODEL,apiVersion:LIPSYNC_API};validateLipSyncIntent(intent,plan,prepared);
    let receipt:LipSyncReceipt|undefined=prior?structuredClone(prior):undefined,kind:LipSyncProviderError["kind"]="permission";
    const record=async(patch:Partial<Omit<LipSyncReceipt,"revision"|"intent"|"reservation">>)=>{
      const {revision:_revision,...data}=receipt!;const next=seal({...data,...patch,observedAt:new Date(Math.max(Date.now(),Date.parse(receipt!.observedAt))).toISOString()});assertLipSyncObservation(receipt,next);receipt=next;const previousKind=kind;kind="accounting";await journal.observe(structuredClone(next));kind=previousKind;
    };
    const request=async(url:string,init:RequestInit)=>{signal.throwIfAborted();return this.fetchImpl(url,{...init,redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(this.options.requestTimeoutMs??30000)])});};
    const status=async(response:Response)=>{
      const body=JSON.parse((await bytes(response,1024**2,signal)).toString());
      if(!body||body.model!==LIPSYNC_MODEL||!STATES.includes(body.status)||typeof body.createdAt!=="string")throw new Error("Invalid generation identity.");
      if(body.createdAt.length>64||!Number.isFinite(Date.parse(body.createdAt)))throw new Error("Invalid provider date.");
      const remote={id:lipId(body.id),createdAt:new Date(body.createdAt).toISOString()};if(receipt!.remote&&!lipSame(receipt!.remote,remote))throw new Error("Provider generation changed.");
      if(body.outputDuration!==undefined&&body.outputDuration!==null)lipNumber(body.outputDuration,0,900,"Provider duration");
      await record({remote,state:body.status,httpStatus:response.status});return body;
    };
    try{
      signal.throwIfAborted();await journal.assertCurrent();
      if(!receipt){
        const reservation=await journal.authorize(intent);receipt=seal({schema:"hv-lipsync-receipt/1",intent,reservation,dispatched:false,state:"not-dispatched",remote:null,httpStatus:null,observedAt:new Date().toISOString()});validateLipSyncReceipt(receipt);
        await journal.assertCurrent();signal.throwIfAborted();
        // Persist the boundary before making the one potentially paid request.
        await record({dispatched:true,state:"unconfirmed"});kind="transport";
        const form=new FormData();form.set("model",LIPSYNC_MODEL);form.set("video",new Blob([Uint8Array.from(media.video)],{type:"video/mp4"}),"video.mp4");form.set("audio",new Blob([Uint8Array.from(media.audio)],{type:"audio/wav"}),"audio.wav");form.set("options",JSON.stringify(wire.options));
        const response=await request(ENDPOINT,{method:"POST",headers:{"x-api-key":this.options.apiKey},body:form});
        if(response.status!==201){await response.body?.cancel();await record({httpStatus:response.status});throw new Error("Submission was not confirmed.");}
        kind="protocol";await status(response);
      }else if(!receipt.remote){kind="ambiguous";throw new Error("Submission identity is unknown.");}
      let failures=0;
      while(true){
        signal.throwIfAborted();kind="permission";await journal.assertCurrent();
        if(receipt.state==="FAILED"||receipt.state==="REJECTED"){kind="protocol";throw new Error("The provider refused or failed the generation.");}
        kind="transport";let response:Response;
        try{response=await request(ENDPOINT+"/"+encodeURIComponent(receipt.remote!.id)+"?wait=true&timeout=10",{headers:{"x-api-key":this.options.apiKey}});}catch(error){if(signal.aborted||++failures>4)throw error;await pause(Math.min(30000,(this.options.pollMs??2000)*failures),signal);continue;}
        if(response.status===429||response.status>=500){await response.body?.cancel();if(++failures>4)throw new Error("Provider observation unavailable.");await pause(Math.min(30000,(this.options.pollMs??2000)*failures),signal);continue;}
        if(response.status!==200){await response.body?.cancel();throw new Error("Provider observation failed.");}
        failures=0;kind="protocol";const body=await status(response);
        if(receipt.state==="COMPLETED"){
          const url=new URL(body.outputUrl);if(url.protocol!=="https:"||url.username||url.password||url.hash||(url.port&&url.port!=="443")||!plan.policy.outputHosts.includes(url.hostname))throw new Error("Unapproved provider output host.");
          kind="permission";await journal.assertCurrent();kind="transport";const download=await request(url.href,{});if(download.status!==200){await download.body?.cancel();throw new Error("Provider media unavailable.");}
          const video=await bytes(download,MAX_OUTPUT_BYTES,signal);if(!video.byteLength)throw new Error("Provider media was empty.");
          const data={schema:"hv-lipsync-delivery/1" as const,capabilityRevision:plan.capabilityRevision,planRevision:plan.revision,preparedRevision:prepared.revision,attemptId:intent.attemptId,generationId:receipt.remote!.id,provider:"sync" as const,model:LIPSYNC_MODEL,videoSha256:sum(video),videoBytes:video.byteLength,outputHost:url.hostname};
          const delivery=receipt.delivery??{...data,revision:contentHash(data)};validateLipSyncDelivery(delivery,plan,prepared);if(delivery.videoSha256!==data.videoSha256||delivery.videoBytes!==data.videoBytes)throw new Error("The provider changed a retained result.");
          kind="permission";await journal.assertCurrent();signal.throwIfAborted();await record({delivery});return {video,delivery,receipt};
        }
        await pause(this.options.pollMs??2000,signal);
      }
    }catch{
      if(signal.aborted)kind="cancelled";
      // The journal's latest observation owns billing even if transport, lease,
      // cancellation or media verification prevents publishing a result.
      if(receipt&&!receipt.dispatched){try{await journal.observe(receipt);}catch{kind="accounting";}}
      throw new LipSyncProviderError(kind==="ambiguous"?"The original lip-sync submission needs reconciliation before another request.":"Lip-sync output was withheld. Recover or reconcile the original attempt.",kind,receipt);
    }
  }
}
