import {contentHash} from "../../generator/src/capabilities";
import {validateEditLibrary,type EditLibrary} from "./edit-library";
import {editFail,editId,editNumber} from "./edit-timeline";
import {compileLivingScriptCutImpact,type LivingScriptCutImpact} from "./living-script-cut-impact";
import type {LivingScriptPatch} from "./living-script-patch";
import type {LivingScriptRenderInputs} from "./living-script-generation";
import {validateLivingScriptSettings,type LivingScriptSettingsBaseline} from "./living-script-settings";

export const LIVING_SCRIPT_PROPOSAL_LIMITS={proposals:16,bytes:64*1024**2} as const;
export interface LivingScriptProposalRequest {
  id:string;label:string;sequenceId:string;historyRevision:string;editorialRevision:string;
  navigationRevision:string;patch:LivingScriptPatch;candidate:LivingScriptRenderInputs;
  baseline:LivingScriptSettingsBaseline;
}
export interface LivingScriptProposal {
  schema:"hv-living-script-proposal/1";projectId:string;createdAt:string;
  request:LivingScriptProposalRequest;requestRevision:string;
  editorial:EditLibrary;impact:LivingScriptCutImpact;revision:string;
}
export interface LivingScriptProposals {
  schema:"hv-living-script-proposals/1";projectId:string;version:number;
  proposals:LivingScriptProposal[];revision:string;
}

/** Verify descriptors before hashing; JSON must not erase any part of a reviewed request. */
function portable(value:unknown):void {
  const active=new Set<object>();const visit=(item:unknown,depth:number):void=>{
    if(item===null||typeof item==="string"||typeof item==="boolean")return;
    if(typeof item==="number"){if(!Number.isFinite(item)||Object.is(item,-0))editFail("Retain finite proposal values.");return;}
    if(typeof item!=="object"||depth>128||active.has(item))editFail("Retain portable proposal metadata.");
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item),keys=Reflect.ownKeys(item);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain proposal records.");
    if(array&&keys.length!==item.length+1)editFail("Retain dense proposal arrays.");active.add(item);
    for(const key of keys){if(array&&key==="length")continue;const descriptor=Object.getOwnPropertyDescriptor(item,key)!;
      if(typeof key!=="string"||!descriptor.enumerable||!Object.hasOwn(descriptor,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))editFail("Retain enumerable proposal data without accessors.");visit(descriptor.value,depth+1);
    }active.delete(item);
  };visit(value,0);
  if(Buffer.byteLength(JSON.stringify(value),"utf8")>LIVING_SCRIPT_PROPOSAL_LIMITS.bytes)editFail("The complete screenplay proposal library exceeds 64 MiB.");
}
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==[...keys].sort().join(","))editFail("Retain the exact screenplay proposal fields.");
}
function hash(value:string):void{if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain complete screenplay proposal revisions.");}
function seal<T extends object>(data:T):T&{revision:string}{return {...data,revision:contentHash(data)};}
function unchanged(value:{revision:string}):void{hash(value.revision);const{revision,...data}=value;if(contentHash(data)!==revision)editFail("The retained screenplay proposal changed.");}
function request(value:LivingScriptProposalRequest):void{
  exact(value,["id","label","sequenceId","historyRevision","editorialRevision","navigationRevision","patch","candidate","baseline"]);editId(value.id);editId(value.sequenceId);
  if(typeof value.label!=="string"||!value.label.trim()||value.label!==value.label.trim()||value.label.length>160||[...value.label].some(c=>c.charCodeAt(0)<32))editFail("Name the screenplay proposal in 160 readable characters or fewer.");
  hash(value.historyRevision);hash(value.editorialRevision);hash(value.navigationRevision);
}
function proposal(value:LivingScriptProposal,projectId:string):void {
  exact(value,["schema","projectId","createdAt","request","requestRevision","editorial","impact","revision"]);
  if(value.schema!=="hv-living-script-proposal/1"||value.projectId!==projectId)editFail("Retain screenplay proposals for this project.");
  const at=Date.parse(value.createdAt);if(!Number.isSafeInteger(at)||at<0||new Date(at).toISOString()!==value.createdAt)editFail("Retain an exact proposal creation time.");
  request(value.request);hash(value.requestRevision);if(contentHash(value.request)!==value.requestRevision)editFail("The exact submitted screenplay proposal changed.");
  const editorial=validateEditLibrary(value.editorial,projectId),r=value.request;
  validateLivingScriptSettings(r.baseline,r.candidate,projectId);
  if(editorial.revision!==r.editorialRevision)editFail("The proposal lost its complete original editorial context.");
  const impact=compileLivingScriptCutImpact(projectId,editorial,r.sequenceId,r.historyRevision,r.patch,r.candidate,r.navigationRevision,at);
  if(contentHash(impact)!==contentHash(value.impact))editFail("The screenplay proposal impact no longer matches its retained originals.");unchanged(value);
}
export function emptyLivingScriptProposals(projectId:string):LivingScriptProposals{
  editId(projectId);return seal({schema:"hv-living-script-proposals/1" as const,projectId,version:0,proposals:[]});
}
/** Historical validation deliberately uses frozen context, never the project's later screenplay or cut.
 * This does not authorize generation, current media use, project acceptance or publication. */
export function validateLivingScriptProposals(library:LivingScriptProposals,projectId:string):LivingScriptProposals{
  portable(library);exact(library,["schema","projectId","version","proposals","revision"]);editId(projectId);editNumber(library.version,0,100000,"Screenplay proposal library version");
  if(library.schema!=="hv-living-script-proposals/1"||library.projectId!==projectId||!Array.isArray(library.proposals)||library.proposals.length>LIVING_SCRIPT_PROPOSAL_LIMITS.proposals)editFail("Retain up to sixteen screenplay proposals for this project.");
  if(library.version===0&&library.proposals.length)editFail("An initial screenplay proposal library must be empty.");
  if(new Set(library.proposals.map(p=>p?.request?.id)).size!==library.proposals.length)editFail("Use distinct immutable screenplay proposal identities.");
  for(const item of library.proposals)proposal(item,projectId);unchanged(library);return structuredClone(library);
}
/** A proposed next version is uncommitted; its exact original version must remain project history. */
export function validateProjectLivingScriptProposals(library:LivingScriptProposals,projectId:string,versions:{version:number;text:string}[]):LivingScriptProposals{
  const checked=validateLivingScriptProposals(library,projectId);
  if(!Array.isArray(versions))editFail("Retain the original project screenplay history.");
  for(const item of checked.proposals){const before=item.request.patch.before,matches=versions.filter(version=>version.version===before.version);
    if(matches.length!==1||matches[0]!.text!==before.text)editFail("A screenplay proposal lost its exact original project version.");
  }
  return checked;
}
/** Save a new immutable review or replay its exact original body after a lost response.
 * The caller must recheck current script/cast/direction, permissions and carriers inside its write fence.
 * A replay returns historical review data; it never refreshes approval or grants generation permission. */
export function createLivingScriptProposal(library:LivingScriptProposals,projectId:string,editorial:EditLibrary,input:LivingScriptProposalRequest,expectedVersion:number,now=Date.now()):{library:LivingScriptProposals;proposal:LivingScriptProposal;replayed:boolean}{
  portable({input,expectedVersion,now});request(input);editNumber(expectedVersion,0,100000,"Screenplay proposal library version");editNumber(now,0,8640000000000000,"Screenplay proposal time");
  const next=validateLivingScriptProposals(library,projectId),requestRevision=contentHash(input),previous=next.proposals.find(p=>p.request.id===input.id);
  if(previous){if(previous.requestRevision!==requestRevision)editFail("This request identity already belongs to a different screenplay proposal.");return {library:next,proposal:structuredClone(previous),replayed:true};}
  if(next.version!==expectedVersion)editFail("The screenplay proposals changed in another window. Reload before saving.");
  const saved=validateEditLibrary(editorial,projectId);if(saved.revision!==input.editorialRevision)editFail("The saved editorial library changed. Review the screenplay impact again.");
  validateLivingScriptSettings(input.baseline,input.candidate,projectId);
  const impact=compileLivingScriptCutImpact(projectId,saved,input.sequenceId,input.historyRevision,input.patch,input.candidate,input.navigationRevision,now);
  const created=seal({schema:"hv-living-script-proposal/1" as const,projectId,createdAt:new Date(now).toISOString(),request:structuredClone(input),requestRevision,editorial:saved,impact});
  const {revision:_revision,...data}=next;const result=validateLivingScriptProposals(seal({...data,version:next.version+1,proposals:[...next.proposals,created]}),projectId);
  return {library:result,proposal:structuredClone(created),replayed:false};
}
