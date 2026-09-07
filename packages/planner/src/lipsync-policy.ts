import {readFileSync,statSync} from "node:fs";
import {contentHash} from "../../generator/src/capabilities";
import {LIPSYNC_API,LIPSYNC_CAPABILITY,LIPSYNC_MODEL} from "../../generator/src/lipsync-capability";

export class LipSyncError extends Error {override name="LipSyncError";}
export function lipFail(message:string):never{throw new LipSyncError(message);}
export function lipRecord(value:unknown,keys:string[]):asserts value is Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))lipFail("Use the supported lip-sync fields.");
}
export function lipHash(value:unknown):string{if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))lipFail("Lip-sync evidence is missing or changed.");return value;}
export function lipId(value:unknown):string{if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))lipFail("Invalid lip-sync identity.");return value;}
export function lipNumber(value:unknown,min:number,max:number,label:string,integer=false):number{
  if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isSafeInteger(value)))lipFail(`${label} must be ${integer?"a whole number ":""}between ${min} and ${max}.`);return value;
}
export function lipDate(value:unknown):string{if(typeof value!=="string"||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)lipFail("Use a canonical lip-sync date.");return value;}
export const lipSame=(a:unknown,b:unknown)=>a===undefined||b===undefined?a===b:contentHash(a)===contentHash(b);
export interface LipSyncPolicyInput {label:string;accountRevision:string;licenceEvidenceSha256:string;priceEvidenceSha256:string;outputHosts:string[];heldUsd:number;maxFrames:number;validFrom:string;expiresAt:string}
export interface LipSyncPolicy extends LipSyncPolicyInput {schema:"hv-lipsync-policy/1";provider:"sync";model:string;apiVersion:string;capabilityRevision:string;permissionRevision:string;priceRevision:string;revision:string}
export function lipSyncPolicy(input:LipSyncPolicyInput):LipSyncPolicy{
  lipRecord(input,["label","accountRevision","licenceEvidenceSha256","priceEvidenceSha256","outputHosts","heldUsd","maxFrames","validFrom","expiresAt"]);
  if(typeof input.label!=="string"||!input.label.trim()||input.label.length>100||[...input.label].some(c=>c.charCodeAt(0)<32))lipFail("Name the configured lip-sync provider.");
  if(!Array.isArray(input.outputHosts)||!input.outputHosts.length||input.outputHosts.length>8||new Set(input.outputHosts).size!==input.outputHosts.length
    ||input.outputHosts.some(h=>typeof h!=="string"||h.length>253||h!==h.toLowerCase()||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(h)))lipFail("Configure exact public provider output hosts.");
  const data={schema:"hv-lipsync-policy/1" as const,provider:"sync" as const,model:LIPSYNC_MODEL,apiVersion:LIPSYNC_API,capabilityRevision:LIPSYNC_CAPABILITY.revision,
    label:input.label.trim(),accountRevision:lipHash(input.accountRevision),licenceEvidenceSha256:lipHash(input.licenceEvidenceSha256),priceEvidenceSha256:lipHash(input.priceEvidenceSha256),
    outputHosts:[...input.outputHosts].sort(),heldUsd:lipNumber(input.heldUsd,.000001,1000000,"Lip-sync hold"),maxFrames:lipNumber(input.maxFrames,1,LIPSYNC_CAPABILITY.input.maxFrames,"Maximum lip-sync frames",true),validFrom:lipDate(input.validFrom),expiresAt:lipDate(input.expiresAt)};
  if(data.heldUsd!==Number(data.heldUsd.toFixed(6))||Date.parse(data.validFrom)>=Date.parse(data.expiresAt))lipFail("Invalid lip-sync price or validity window.");
  const permissionRevision=contentHash({provider:data.provider,model:data.model,accountRevision:data.accountRevision,licenceEvidenceSha256:data.licenceEvidenceSha256,outputHosts:data.outputHosts,validFrom:data.validFrom,expiresAt:data.expiresAt});
  const priceRevision=contentHash({provider:data.provider,model:data.model,accountRevision:data.accountRevision,priceEvidenceSha256:data.priceEvidenceSha256,heldUsd:data.heldUsd,maxFrames:data.maxFrames,validFrom:data.validFrom,expiresAt:data.expiresAt});
  const result={...data,permissionRevision,priceRevision};return {...result,revision:contentHash(result)};
}
export function validateLipSyncPolicy(policy:LipSyncPolicy,now?:number):LipSyncPolicy{
  lipRecord(policy,["schema","provider","model","apiVersion","capabilityRevision","label","accountRevision","licenceEvidenceSha256","priceEvidenceSha256","outputHosts","heldUsd","maxFrames","validFrom","expiresAt","permissionRevision","priceRevision","revision"]);
  const {schema:_schema,provider:_provider,model:_model,apiVersion:_api,capabilityRevision:_cap,permissionRevision:_permission,priceRevision:_price,revision:_revision,...input}=policy,result=lipSyncPolicy(input);
  if(!lipSame(result,policy))lipFail("The lip-sync policy evidence changed.");
  if(now!==undefined&&(!Number.isFinite(now)||now<Date.parse(result.validFrom)||now>=Date.parse(result.expiresAt)))lipFail("The lip-sync policy is not currently valid.");return result;
}
export function configuredLipSyncPolicy():LipSyncPolicy|undefined{
  const path=process.env.HV_LIPSYNC_POLICY_FILE;if(!path)return;
  if(statSync(path).size>65536)lipFail("The lip-sync policy exceeds its limit.");return validateLipSyncPolicy(JSON.parse(readFileSync(path,"utf8")));
}
