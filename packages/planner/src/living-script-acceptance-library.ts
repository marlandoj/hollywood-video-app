import {contentHash} from "../../generator/src/capabilities";
import {editFail,editId,editNumber} from "./edit-timeline";
import {validateLivingScriptProposals,type LivingScriptProposal,type LivingScriptProposals} from "./living-script-proposals";
import {compileLivingScriptAcceptance,validateLivingScriptAcceptance,type LivingScriptAcceptance,type LivingScriptAcceptanceBundle,type LivingScriptAcceptanceContext,type LivingScriptAcceptanceRequest,type LivingScriptAcceptanceRetained} from "./living-script-acceptance";

export const LIVING_SCRIPT_ACCEPTANCES_LIMITS={records:16,bytes:128*1024**2} as const;
export interface LivingScriptAcceptanceRecord {
  proposalId:string;proposalRevision:string;request:LivingScriptAcceptanceRequest;
  acceptance:LivingScriptAcceptance;revision:string;
}
export interface LivingScriptAcceptances {
  schema:"hv-living-script-acceptances/1";projectId:string;version:number;
  records:LivingScriptAcceptanceRecord[];revision:string;
}
export type LivingScriptAcceptanceResult=
  |{library:LivingScriptAcceptances;record:LivingScriptAcceptanceRecord;replayed:true;bundle?:never}
  |{library:LivingScriptAcceptances;record:LivingScriptAcceptanceRecord;replayed:false;bundle:LivingScriptAcceptanceBundle};

/** Check descriptors before any serialization or seal calculation; never drop reviewed fields. */
function portable<T>(input:T):T {
  const active=new Set<object>();const visit=(value:unknown,depth:number):void=>{
    if(value===null||typeof value==="string"||typeof value==="boolean")return;
    if(typeof value==="number"){if(!Number.isFinite(value)||Object.is(value,-0))editFail("Retain finite acceptance ledger values.");return;}
    if(typeof value!=="object"||depth>128||active.has(value))editFail("Retain portable acceptance ledger metadata.");
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain acceptance ledger records.");
    if(array&&keys.length!==value.length+1)editFail("Retain dense acceptance ledger arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!descriptor.enumerable||!Object.hasOwn(descriptor,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Retain enumerable acceptance ledger fields without accessors.");visit(descriptor.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>LIVING_SCRIPT_ACCEPTANCES_LIMITS.bytes)editFail("The complete acceptance ledger exceeds its 128 MiB metadata capacity.");return structuredClone(input);
}
function exact(value:unknown,fields:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==fields.slice().sort().join(","))editFail("Retain the exact acceptance ledger fields.");}
function hash(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain complete acceptance ledger revisions.");}
function seal<T extends object>(data:T):T&{revision:string}{return {...data,revision:contentHash(data)};}
function unchanged(value:{revision:string}):void {hash(value.revision);const {revision,...data}=value;if(contentHash(data)!==revision)editFail("The retained acceptance ledger seal changed.");}
function time(value:unknown):number {if(typeof value!=="string")editFail("Retain an exact acceptance time.");const at=Date.parse(value);if(!Number.isSafeInteger(at)||at<0||new Date(at).toISOString()!==value)editFail("Retain an exact acceptance time.");return at;}
function requestHash(value:LivingScriptAcceptanceRequest):string{return contentHash({schema:"hv-living-script-accept-request/1",...value});}
function bind(proposals:LivingScriptProposals,projectId:string,proposalId:string,proposalRevision:string,request:LivingScriptAcceptanceRequest):LivingScriptProposal {
  editId(proposalId);hash(proposalRevision);exact(request,["id","name","reviewRevision","baseline","recutInput","recut"]);editId(request.id);
  const proposal=proposals.proposals.find(item=>item.request.id===proposalId);if(!proposal||proposal.revision!==proposalRevision)editFail("Retain the exact immutable screenplay proposal for this acceptance.");
  const r=proposal.request,input=request.recutInput;
  if(!input||input.projectId!==projectId||input.sequenceId!==r.sequenceId||input.historyRevision!==r.historyRevision||input.navigationRevision!==r.navigationRevision
    ||contentHash(input.library)!==contentHash(proposal.editorial)||contentHash(input.patch)!==contentHash(r.patch)||contentHash(input.candidate)!==contentHash(r.candidate)||contentHash(request.baseline)!==contentHash(r.baseline))editFail("The linked acceptance differs from its saved proposal baseline, screenplay, generation inputs or frozen cut.");
  if(!request.recut||request.recut.cutImpactRevision!==proposal.impact.revision||request.recut.generationRevision!==proposal.impact.generation.revision)editFail("The linked acceptance lost its exact reviewed proposal impact.");
  if(time(request.recut.createdAt)<time(proposal.createdAt))editFail("Review the generated recut after its retained screenplay proposal.");
  return proposal;
}
function historical(proposals:LivingScriptProposals,projectId:string,record:LivingScriptAcceptanceRecord):void {
  exact(record,["proposalId","proposalRevision","request","acceptance","revision"]);unchanged(record);
  const proposal=bind(proposals,projectId,record.proposalId,record.proposalRevision,record.request),request=record.request,at=time(record.acceptance?.acceptedAt);
  const bundle=compileLivingScriptAcceptance({projectId,editorial:proposal.editorial,currentScript:{version:proposal.request.patch.before.version,text:proposal.request.patch.before.text},currentCasting:proposal.request.baseline.casting,currentDirection:proposal.request.baseline.direction},request,at);
  if(record.acceptance.id!==request.id||record.acceptance.requestHash!==requestHash(request)||contentHash(bundle.acceptance)!==contentHash(record.acceptance))editFail("The retained acceptance differs from its complete historical reviewed request.");
}
function checked(library:LivingScriptAcceptances,proposals:LivingScriptProposals,projectId:string):LivingScriptAcceptances {
  exact(library,["schema","projectId","version","records","revision"]);editId(projectId);editNumber(library.version,0,LIVING_SCRIPT_ACCEPTANCES_LIMITS.records,"Acceptance ledger version");
  if(library.schema!=="hv-living-script-acceptances/1"||library.projectId!==projectId||!Array.isArray(library.records)||library.records.length>LIVING_SCRIPT_ACCEPTANCES_LIMITS.records||library.version!==library.records.length)editFail("Retain an append-only acceptance ledger with up to sixteen records.");
  unchanged(library);
  const ids=new Set<string>(),proposalRevisions=new Set<string>();
  for(const record of library.records){if(ids.has(record?.request?.id)||proposalRevisions.has(record?.proposalRevision))editFail("Accept each request identity and immutable proposal revision only once.");historical(proposals,projectId,record);ids.add(record.request.id);proposalRevisions.add(record.proposalRevision);}
  return library;
}

export function emptyLivingScriptAcceptances(projectId:string):LivingScriptAcceptances {
  editId(projectId);return seal({schema:"hv-living-script-acceptances/1" as const,projectId,version:0,records:[]});
}
/** Frozen historical validation. It neither depends on current project settings nor grants any
 * current generation, media, ownership or publication permission. */
export function validateLivingScriptAcceptances(library:LivingScriptAcceptances,proposals:LivingScriptProposals,projectId:string):LivingScriptAcceptances {
  return checked(portable(library),validateLivingScriptProposals(proposals,projectId),projectId);
}
/** The full request proves approval correspondence; the compact helper additionally proves that
 * accepted script versions and parent/child history prefixes still exist after restoration. */
export function validateProjectLivingScriptAcceptances(library:LivingScriptAcceptances,proposals:LivingScriptProposals,context:LivingScriptAcceptanceRetained):LivingScriptAcceptances {
  const retained=portable(context);exact(retained,["projectId","versions","editorial"]);
  const validated=validateLivingScriptAcceptances(library,proposals,retained.projectId);
  for(const record of validated.records)validateLivingScriptAcceptance(record.acceptance,retained);return validated;
}
/** Resolve exact replay before current-state/version checks. The service must recheck owner and
 * carrier permissions, then atomically persist a fresh bundle together with this entire ledger.
 * A replay deliberately returns no mutation bundle and never refreshes historical approval. */
export function acceptLivingScriptProposal(library:LivingScriptAcceptances,proposals:LivingScriptProposals,context:LivingScriptAcceptanceContext,proposalId:string,proposalRevision:string,request:LivingScriptAcceptanceRequest,expectedVersion:number,now=Date.now()):LivingScriptAcceptanceResult {
  const args=portable({context,proposalId,proposalRevision,request,expectedVersion,now}),current=args.context;
  editNumber(args.expectedVersion,0,LIVING_SCRIPT_ACCEPTANCES_LIMITS.records,"Acceptance ledger version");editNumber(args.now,0,8640000000000000,"Acceptance ledger time");
  const saved=validateLivingScriptProposals(proposals,current.projectId),next=checked(portable(library),saved,current.projectId),asked=args.request;
  bind(saved,current.projectId,args.proposalId,args.proposalRevision,asked);
  const previous=next.records.find(record=>record.request.id===asked.id),previousProposal=next.records.find(record=>record.proposalRevision===args.proposalRevision);
  if(previous){if(previous.proposalId!==args.proposalId||previous.proposalRevision!==args.proposalRevision||previous.acceptance.requestHash!==requestHash(asked)||contentHash(previous.request)!==contentHash(asked))editFail("This acceptance request identity already belongs to a different reviewed body or proposal.");return {library:next,record:structuredClone(previous),replayed:true};}
  if(previousProposal)editFail("This immutable screenplay proposal already has a different acceptance request.");
  if(next.version!==args.expectedVersion)editFail("The acceptance ledger changed in another window. Reload before accepting.");
  if(next.records.length>=LIVING_SCRIPT_ACCEPTANCES_LIMITS.records)editFail("This ledger already retains sixteen immutable linked acceptances.");
  const bundle=compileLivingScriptAcceptance(current,asked,args.now),record=seal({proposalId:args.proposalId,proposalRevision:args.proposalRevision,request:asked,acceptance:bundle.acceptance}),{revision:_revision,...data}=next;
  const result=portable(seal({...data,version:next.version+1,records:[...next.records,record]}));
  // Existing records were already recompiled and the appended receipt was just compiled here.
  return {library:result,record:structuredClone(record),replayed:false,bundle};
}
