import {contentHash} from "../../generator/src/capabilities";
import {createEditAssemblyPlan,validateEditAssemblyPlan} from "./edit-assembly-clock";
import type {EditAssemblyParent,EditAssemblyPlan,EditAssemblyPurpose,EditAssemblyRange} from "./edit-assembly-types";
import {editFail,editId,editNumber} from "./edit-timeline";

export const EDIT_ASSEMBLY_LIBRARY_LIMITS={proposals:32,assemblies:32,bytes:64*1024**2} as const;
export interface EditAssemblyProposal {id:string;label:string;purpose:EditAssemblyPurpose;createdAt:string;plan:EditAssemblyPlan;revision:string}
export interface EditAssemblyTarget {frames:1800;status:"exact"|"short"|"long";deltaFrames:number}
export interface AcceptedEditAssembly {
  id:string;proposalId:string;proposalRevision:string;proposalCreatedAt:string;label:string;purpose:EditAssemblyPurpose;
  acceptedAt:string;plan:EditAssemblyPlan;target?:EditAssemblyTarget;revision:string;
}
export interface EditAssemblyLibrary {schema:"hv-edit-assembly-library/1";version:number;proposals:EditAssemblyProposal[];assemblies:AcceptedEditAssembly[];revision:string}
export interface EditAssemblyProposalInput {id:string;label:string;purpose:EditAssemblyPurpose;ranges:EditAssemblyRange[]}
export type EditAssemblyProposalRevision=Omit<EditAssemblyProposalInput,"id">;
const purposes:EditAssemblyPurpose[]=["directors-cut","trailer","sixty-second","custom"];
/** Check descriptors before reading fields so a seal cannot hide values erased by JSON. */
function portable(input:unknown):void {
  const active=new Set<object>();const visit=(value:unknown,depth:number):void=>{
    if(value===null||typeof value==="string"||typeof value==="boolean")return;
    if(typeof value==="number"){if(!Number.isFinite(value)||Object.is(value,-0))editFail("Retain finite portable assembly numbers.");return;}
    if(typeof value!=="object"||depth>64||active.has(value))editFail("Retain portable, non-cyclic assembly data.");
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain assembly records and arrays.");
    active.add(value);const keys=Reflect.ownKeys(value);if(array&&keys.length!==value.length+1)editFail("Retain dense assembly arrays without extra fields.");
    for(const key of keys){if(array&&key==="length")continue;const descriptor=Object.getOwnPropertyDescriptor(value,key)!;if(typeof key!=="string"||!descriptor.enumerable||!Object.hasOwn(descriptor,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Retain plain enumerable assembly values.");visit(descriptor.value,depth+1);}
    active.delete(value);
  };visit(input,0);
}
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==[...keys].sort().join(","))editFail("Use only the supported assembly fields.");
}
function hash(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain a complete assembly revision.");}
function label(value:unknown):string {if(typeof value!=="string"||!value.trim()||value!==value.trim()||value.length>160||[...value].some(c=>c.charCodeAt(0)<32))editFail("Name this assembly in 160 readable characters or fewer.");return value;}
function purpose(value:unknown):void {if(!purposes.includes(value as EditAssemblyPurpose))editFail("Choose a supported assembly purpose.");}
function date(value:unknown):number {if(typeof value!=="string"||!Number.isFinite(Date.parse(value))||new Date(Date.parse(value)).toISOString()!==value)editFail("Retain a valid assembly date.");return Date.parse(value);}
function timestamp(now:number):string {editNumber(now,0,8_640_000_000_000_000,"Assembly creation time");return new Date(now).toISOString();}
function sealed<T extends object>(data:T):T&{revision:string}{return {...data,revision:contentHash(data)};}
function unchanged(value:{revision:string}):void {hash(value.revision);const {revision,...data}=value;if(revision!==contentHash(data))editFail("The saved assembly record changed.");}
function target(plan:EditAssemblyPlan,value:EditAssemblyPurpose):EditAssemblyTarget|undefined {return value==="sixty-second"?{frames:1800,status:plan.frames===1800?"exact":plan.frames<1800?"short":"long",deltaFrames:plan.frames-1800}:undefined;}
function proposal(value:EditAssemblyProposal):void {
  exact(value,["id","label","purpose","createdAt","plan","revision"]);editId(value.id);label(value.label);purpose(value.purpose);date(value.createdAt);validateEditAssemblyPlan(value.plan);unchanged(value);
}
function accepted(value:AcceptedEditAssembly):void {
  exact(value,["id","proposalId","proposalRevision","proposalCreatedAt","label","purpose","acceptedAt","plan",...(value?.purpose==="sixty-second"?["target"]:[]),"revision"]);
  editId(value.id);hash(value.proposalRevision);const original={id:value.proposalId,label:value.label,purpose:value.purpose,createdAt:value.proposalCreatedAt,plan:value.plan,revision:value.proposalRevision};proposal(original);
  if(date(value.acceptedAt)<date(value.proposalCreatedAt))editFail("An assembly cannot be accepted before its proposal.");
  if(value.purpose==="sixty-second"){
    exact(value.target,["frames","status","deltaFrames"]);if(contentHash(value.target)!==contentHash(target(value.plan,value.purpose)))editFail("Retain the actual sixty-second target outcome.");
  }
  unchanged(value);
}
/** Metadata only: callers still own project authentication, permissions, carrier checks and storage locks. */
export function emptyEditAssemblyLibrary():EditAssemblyLibrary{return sealed({schema:"hv-edit-assembly-library/1" as const,version:0,proposals:[],assemblies:[]});}
export function validateEditAssemblyLibrary(library:EditAssemblyLibrary):EditAssemblyLibrary {
  portable(library);
  exact(library,["schema","version","proposals","assemblies","revision"]);editNumber(library.version,0,100000,"Assembly library version");
  if(library.schema!=="hv-edit-assembly-library/1"||!Array.isArray(library.proposals)||library.proposals.length>EDIT_ASSEMBLY_LIBRARY_LIMITS.proposals||!Array.isArray(library.assemblies)||library.assemblies.length>EDIT_ASSEMBLY_LIBRARY_LIMITS.assemblies)editFail("Keep up to 32 proposals and 32 accepted assemblies.");
  let serialized:string;try{serialized=JSON.stringify(library);}catch{editFail("Retain portable assembly metadata.");}if(Buffer.byteLength(serialized,"utf8")>EDIT_ASSEMBLY_LIBRARY_LIMITS.bytes)editFail("The assembly library exceeds 64 MiB of metadata.");
  if(library.version===0&&(library.proposals.length||library.assemblies.length))editFail("An initial assembly library must be empty.");
  for(const item of library.proposals)proposal(item);
  for(const item of library.assemblies){
    accepted(item);const original=library.proposals.find(p=>p.id===item.proposalId);
    if(!original||original.createdAt!==item.proposalCreatedAt||contentHash(original.plan.parent)!==contentHash(item.plan.parent))editFail("An accepted assembly lost its immutable proposal parent.");
  }
  if(new Set(library.proposals.map(p=>p.id)).size!==library.proposals.length||new Set(library.assemblies.map(a=>a.id)).size!==library.assemblies.length||new Set(library.assemblies.map(a=>a.proposalId+":"+a.proposalRevision)).size!==library.assemblies.length)editFail("Use distinct proposal, accepted assembly and acceptance identities.");
  unchanged(library);return structuredClone(library);
}
function expected(library:EditAssemblyLibrary,version:number):void {editNumber(version,0,100000,"Assembly library version");if(library.version!==version)editFail("The assembly library changed in another window. Reload its proposals.");}
function current(plan:EditAssemblyPlan,parent:EditAssemblyParent):void {
  const checked=createEditAssemblyPlan(parent,plan.ranges);if(contentHash(checked.parent)!==contentHash(plan.parent))editFail("The parent edit, history or original receipts changed. Create a fresh proposal.");
}
function finish(library:EditAssemblyLibrary):EditAssemblyLibrary {const {revision:_revision,...data}=library;return validateEditAssemblyLibrary(sealed({...data,version:data.version+1}));}
export function createEditAssemblyProposal(library:EditAssemblyLibrary,input:EditAssemblyProposalInput,currentParent:EditAssemblyParent,expectedVersion:number,now=Date.now()):EditAssemblyLibrary {
  portable({input,expectedVersion,now});
  const next=validateEditAssemblyLibrary(library);expected(next,expectedVersion);exact(input,["id","label","purpose","ranges"]);editId(input.id);label(input.label);purpose(input.purpose);
  if(next.proposals.some(p=>p.id===input.id))editFail("Choose a new proposal identity.");
  next.proposals.push(sealed({id:input.id,label:input.label,purpose:input.purpose,createdAt:timestamp(now),plan:createEditAssemblyPlan(currentParent,input.ranges)}));return finish(next);
}
/** Revising ranges never refreshes or replaces the original parent snapshot. */
export function reviseEditAssemblyProposal(library:EditAssemblyLibrary,id:string,input:EditAssemblyProposalRevision,currentParent:EditAssemblyParent,expectedVersion:number,expectedProposalRevision:string):EditAssemblyLibrary {
  portable({input,expectedVersion});
  const next=validateEditAssemblyLibrary(library);expected(next,expectedVersion);editId(id);hash(expectedProposalRevision);exact(input,["label","purpose","ranges"]);label(input.label);purpose(input.purpose);
  const index=next.proposals.findIndex(p=>p.id===id),original=next.proposals[index];if(!original||original.revision!==expectedProposalRevision)editFail("The proposal changed. Reload it before revising.");current(original.plan,currentParent);
  next.proposals[index]=sealed({id:original.id,label:input.label,purpose:input.purpose,createdAt:original.createdAt,plan:createEditAssemblyPlan(original.plan.parent,input.ranges)});return finish(next);
}
/** An exact lost-response retry returns its saved result before checking now-stale optimistic versions. */
export function acceptEditAssemblyProposal(library:EditAssemblyLibrary,proposalId:string,proposalRevision:string,assemblyId:string,currentParent:EditAssemblyParent,expectedVersion:number,now=Date.now()):{library:EditAssemblyLibrary;assembly:AcceptedEditAssembly;replayed:boolean} {
  portable({proposalId,proposalRevision,assemblyId,expectedVersion,now});
  const next=validateEditAssemblyLibrary(library);editId(proposalId);hash(proposalRevision);editId(assemblyId);editNumber(expectedVersion,0,100000,"Assembly library version");
  const previous=next.assemblies.find(a=>a.id===assemblyId||a.proposalId===proposalId&&a.proposalRevision===proposalRevision);
  if(previous){if(previous.id!==assemblyId||previous.proposalId!==proposalId||previous.proposalRevision!==proposalRevision)editFail("This acceptance already belongs to another assembly or proposal revision.");return {library:next,assembly:structuredClone(previous),replayed:true};}
  expected(next,expectedVersion);const original=next.proposals.find(p=>p.id===proposalId);if(!original||original.revision!==proposalRevision)editFail("The reviewed proposal changed. Review its current revision before accepting.");current(original.plan,currentParent);
  const outcome=target(original.plan,original.purpose),assembly=sealed({id:assemblyId,proposalId:original.id,proposalRevision:original.revision,proposalCreatedAt:original.createdAt,label:original.label,purpose:original.purpose,acceptedAt:timestamp(now),plan:structuredClone(original.plan),...(outcome?{target:outcome}:{})});
  next.assemblies.push(assembly);return {library:finish(next),assembly:structuredClone(assembly),replayed:false};
}
