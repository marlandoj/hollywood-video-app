import {contentHash as hash} from "../../generator/src/capabilities";
import type {ScriptVersion} from "../../parser/src/index";
import {validateCasting,type CastingSnapshot} from "./casting";
import {validateDirection,staleDirections,type DirectionSnapshot} from "./direction";
import {editFail} from "./edit-timeline";
import type {EditSourceReceipt} from "./edit-sources";
import {validateLivingScriptDocument,type LivingScriptDocument,type LivingScriptDocumentSource} from "./living-script-document";
import type {LivingScriptShotPlan} from "./living-script-shot-plan";
import {bootstrapCurrentShotPlan,materializeCurrentShotPlan,reviewShotPlanEvolution,type CurrentShotPlanRequest,type CurrentShotPlanReview,type CurrentShotCapacity} from "./living-script-current-plan";
import {bootstrapCurrentDirection,createCurrentDirectionRequest,reviewCurrentDirection,validateCurrentDirection,type CurrentDirectionContext,type CurrentDirectionSnapshot,type CurrentDirectionRequest,type CurrentDirectionReview} from "./living-script-current-direction";
import {proposeLivingScriptCastOrigin,compileLivingScriptCastRebind,validateLivingScriptCastRebind,advanceLivingScriptCastOrigin,type LivingScriptCastOrigin,type LivingScriptCastRebind} from "./living-script-cast-rebind";

export const CURRENT_SCREENPLAY_LIBRARY_LIMITS={bytes:128*1024**2,nodes:2500000,depth:200,proposals:32,acceptances:32} as const;
/** Complete historical input evidence. A seal never establishes owner acceptance or current rights. */
export interface CurrentScreenplayState {
  schema:"hv-current-screenplay-state/1";projectId:string;context:CurrentDirectionContext;
  direction:CurrentDirectionSnapshot;casting:LivingScriptCastRebind;castOrigin:LivingScriptCastOrigin;revision:string;
}
export interface CurrentScreenplayBootstrapRequest {
  id:string;label:string;script:ScriptVersion;source:EditSourceReceipt;
  documentSource:LivingScriptDocumentSource;originalPlan:LivingScriptShotPlan;
  baseline:{casting:CastingSnapshot;direction:DirectionSnapshot};
}
export interface CurrentScreenplayOrigin {
  schema:"hv-current-screenplay-origin/1";projectId:string;libraryVersion:number;createdAt:string;
  request:CurrentScreenplayBootstrapRequest;requestRevision:string;directionReview:CurrentDirectionReview;
  state:CurrentScreenplayState;revision:string;
}
export interface CurrentScreenplayProposalRequest {
  id:string;label:string;expectedHeadRevision:string;beforeStateRevision:string;
  afterDocument:LivingScriptDocument;planRequest:CurrentShotPlanRequest;
  directionRequest:CurrentDirectionRequest|null;capacity:CurrentShotCapacity;
}
export interface CurrentScreenplayProposal {
  schema:"hv-current-screenplay-proposal/1";projectId:string;libraryVersion:number;createdAt:string;
  request:CurrentScreenplayProposalRequest;requestRevision:string;planReview:CurrentShotPlanReview;
  directionReview:CurrentDirectionReview|null;castReview:LivingScriptCastRebind;
  candidate:CurrentScreenplayState|null;revision:string;
}
export interface CurrentScreenplayAcceptanceRequest {id:string;proposalRevision:string;expectedHeadRevision:string}
export interface CurrentScreenplayAcceptance {
  schema:"hv-current-screenplay-acceptance/1";projectId:string;libraryVersion:number;createdAt:string;
  request:CurrentScreenplayAcceptanceRequest;requestRevision:string;state:CurrentScreenplayState;
  /** Every structural suffix version belongs to this one atomic acceptance time. */
  versions:ScriptVersion[];revision:string;
}
export interface CurrentScreenplayLibrary {
  schema:"hv-current-screenplay-library/1";projectId:string;version:number;
  origin:CurrentScreenplayOrigin|null;proposals:CurrentScreenplayProposal[];
  acceptances:CurrentScreenplayAcceptance[];headRevision:string|null;revision:string;
}
export interface CurrentScreenplayHead {
  kind:"origin"|"acceptance";revision:string;createdAt:string;state:CurrentScreenplayState;script:ScriptVersion;
}
export interface CurrentScreenplayTargetSelector {kind:"accepted"|"proposal";revision:string}
export interface CurrentScreenplayTarget {
  schema:"hv-current-screenplay-target/1";kind:CurrentScreenplayTargetSelector["kind"];projectId:string;
  headRevision:string;recordRevision:string;state:CurrentScreenplayState;revision:string;
}
export interface CurrentScreenplayTargetResolution {library:CurrentScreenplayLibrary;head:CurrentScreenplayHead;target:CurrentScreenplayTarget}
// Bound constructed output before hashing can expand a shared proof into a large JSON string.
const seal=<T extends object>(value:T):T&{revision:string}=>({...value,revision:hash(portable(value,false))});
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Retain exact current screenplay fields.");
}
function id(value:unknown):void {if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))editFail("Retain a bounded current screenplay identity.");}
function digest(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain an exact current screenplay revision.");}
function integer(value:unknown,min:number,max:number):asserts value is number {if(!Number.isSafeInteger(value)||typeof value!=="number"||value<min||value>max)editFail("Retain bounded current screenplay versions, counts and times.");}
function date(value:unknown):number {if(typeof value!=="string")editFail("Retain a canonical current screenplay time.");const at=Date.parse(value);integer(at,0,8640000000000000);if(new Date(at).toISOString()!==value)editFail("Retain a canonical current screenplay time.");return at;}
function label(value:unknown):void {if(typeof value!=="string"||!value.trim()||value!==value.trim()||value.length>160||[...value].some(c=>c.charCodeAt(0)<32))editFail("Name the current screenplay review in at most 160 readable characters.");}
/** Descriptors and incremental work/byte budgets are checked before reads, hashing or cloning. */
function portable<T>(input:T,clone=true):T {
  let bytes=0,nodes=0;const active=new Set<object>(),limit=CURRENT_SCREENPLAY_LIBRARY_LIMITS;
  const visit=(v:unknown,depth:number):void=>{
    if(++nodes>limit.nodes||depth>limit.depth)editFail("Current screenplay library metadata exceeds its capacity.");
    if(typeof v==="string"){bytes+=Buffer.byteLength(v,"utf8");if(bytes>limit.bytes)editFail("Current screenplay library metadata exceeds its capacity.");return;}
    if(v===null||typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v)&&!Object.is(v,-0))return;
    if(typeof v!=="object"||active.has(v))editFail("Retain portable current screenplay metadata.");
    const array=Array.isArray(v),keys=Reflect.ownKeys(v),proto=Object.getPrototypeOf(v);
    if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)editFail("Retain plain current screenplay metadata.");
    if(array&&keys.length!==v.length+1)editFail("Retain dense current screenplay arrays.");active.add(v);
    for(const key of keys){if(array&&key==="length")continue;const field=Object.getOwnPropertyDescriptor(v,key)!;
      if(typeof key!=="string"||!field.enumerable||!Object.hasOwn(field,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=v.length))editFail("Retain current screenplay metadata without accessors or hidden fields.");
      bytes+=Buffer.byteLength(key,"utf8");if(bytes>limit.bytes)editFail("Current screenplay library metadata exceeds its capacity.");visit(field.value,depth+1);
    }active.delete(v);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>limit.bytes)editFail("Current screenplay library metadata exceeds its capacity.");return clone?structuredClone(input):input;
}
function script(value:ScriptVersion):void {
  exact(value,["version","text","createdAt","parentVersion"]);integer(value.version,1,Number.MAX_SAFE_INTEGER);date(value.createdAt);
  if(typeof value.text!=="string"||value.text.length>200000)editFail("Retain the complete bounded screenplay text.");
  if(value.parentVersion!==null)integer(value.parentVersion,1,value.version-1);
}
function state(context:CurrentDirectionContext,direction:CurrentDirectionSnapshot,casting:LivingScriptCastRebind):CurrentScreenplayState {
  if(!casting.candidate||casting.conflicts.length||!same(casting.input.after,context.plan.document))editFail("Resolve all casting against the exact current screenplay.");
  return seal({schema:"hv-current-screenplay-state/1" as const,projectId:context.plan.projectId,context,direction,casting,castOrigin:advanceLivingScriptCastOrigin(casting)});
}
/** Structural validation only; complete acceptance provenance is replayed by the library validator. */
export function validateCurrentScreenplayState(input:CurrentScreenplayState):CurrentScreenplayState {
  const value=portable(input);exact(value,["schema","projectId","context","direction","casting","castOrigin","revision"]);id(value.projectId);
  const direction=validateCurrentDirection(value.direction,value.context),casting=validateLivingScriptCastRebind(value.casting),expected=state(value.context,direction,casting);
  if(!same(expected,value))editFail("The current screenplay state differs from its complete plan, direction or cast evidence.");return expected;
}
function bootstrapRequest(value:CurrentScreenplayBootstrapRequest):void {
  exact(value,["id","label","script","source","documentSource","originalPlan","baseline"]);id(value.id);label(value.label);script(value.script);exact(value.baseline,["casting","direction"]);
}
function proposalRequest(value:CurrentScreenplayProposalRequest):void {
  exact(value,["id","label","expectedHeadRevision","beforeStateRevision","afterDocument","planRequest","directionRequest","capacity"]);id(value.id);label(value.label);digest(value.expectedHeadRevision);digest(value.beforeStateRevision);
}
function acceptanceRequest(value:CurrentScreenplayAcceptanceRequest):void {exact(value,["id","proposalRevision","expectedHeadRevision"]);id(value.id);digest(value.proposalRevision);digest(value.expectedHeadRevision);}
function origin(projectId:string,request:CurrentScreenplayBootstrapRequest,createdAt:string):CurrentScreenplayOrigin {
  bootstrapRequest(request);const at=date(createdAt),baseline=request.baseline,casting=validateCasting(baseline.casting,projectId),direction=validateDirection(baseline.direction,projectId);
  if(!same(casting,baseline.casting)||!same(direction,baseline.direction)||at<Math.max(date(casting.createdAt),date(direction.createdAt),date(request.script.createdAt),date(request.source.job.completedAt)))editFail("Bootstrap from complete historical settings and a completed original at their exact review time.");
  const base=bootstrapCurrentShotPlan(request.source,request.originalPlan,request.documentSource),context={...base,originals:[request.source]},document=context.plan.document;
  if(document.projectId!==projectId||document.context.base.version!==request.script.version||document.context.base.text!==request.script.text)editFail("The bootstrap does not match this project's exact committed screenplay.");
  const material=materializeCurrentShotPlan(base.plan,document,base.lineage,context.originals);
  if(staleDirections(material,direction).length||!same(direction.sceneCuts??[],request.source.job.direction?.sceneCuts??[]))editFail("Reconcile changed or stale legacy shot membership before binding the complete current plan.");
  const initial=bootstrapCurrentDirection(context),directionRequest=createCurrentDirectionRequest(initial,base.plan,{id:"bootstrap-"+hash(request).slice(0,40),settings:base.plan.shots.map(row=>({shotId:row.id,settings:direction.entries.find(entry=>entry.source.id===row.renderId)?.settings??null})),lines:[],retired:[]}),directionReview=reviewCurrentDirection({before:context,after:context,snapshot:initial,request:directionRequest});
  if(!directionReview.candidate||directionReview.conflicts.length)editFail("Resolve complete root directions before bootstrap.");
  const castOrigin=proposeLivingScriptCastOrigin(document,casting),castReview=compileLivingScriptCastRebind({before:document,after:document,casting,origin:castOrigin},at);
  return seal({schema:"hv-current-screenplay-origin/1" as const,projectId,libraryVersion:1,createdAt,request,requestRevision:hash(request),directionReview,state:state(context,directionReview.candidate,castReview)});
}
function suffix(before:LivingScriptDocument,after:LivingScriptDocument):LivingScriptDocument["context"]["ancestry"] {
  const old=before.context.ancestry,chain=after.context.ancestry;
  if(before.projectId!==after.projectId||before.rootScriptRevision!==after.rootScriptRevision||chain.length<=old.length||old.some((patch,i)=>!same(patch,chain[i]))||!same(chain[old.length]!.before,before.context.base))editFail("Review an exact nonempty linear structural suffix from the accepted current head.");
  return chain.slice(old.length);
}
function proposal(projectId:string,head:CurrentScreenplayHead,request:CurrentScreenplayProposalRequest,version:number,createdAt:string):CurrentScreenplayProposal {
  proposalRequest(request);const at=date(createdAt),before=head.state,after=validateLivingScriptDocument(request.afterDocument);
  if(request.expectedHeadRevision!==head.revision||request.beforeStateRevision!==before.revision||at<date(head.createdAt))editFail("The accepted current screenplay head changed before this proposal.");suffix(before.context.plan.document,after);
  const planReview=reviewShotPlanEvolution({previous:before.context.plan,lineage:before.context.lineage,originals:before.context.originals,beforeDocument:before.context.plan.document,afterDocument:after,request:request.planRequest,capacity:request.capacity});
  const castReview=compileLivingScriptCastRebind({before:before.context.plan.document,after,casting:before.casting.candidate!,origin:before.castOrigin},at);
  let directionReview:CurrentDirectionReview|null=null,candidate:CurrentScreenplayState|null=null;
  if(planReview.candidate){
    if(!request.directionRequest)editFail("Retain explicit current direction review choices for the complete candidate plan.");
    const context={plan:planReview.candidate,lineage:planReview.proposedLineage!,originals:before.context.originals};
    directionReview=reviewCurrentDirection({before:before.context,after:context,snapshot:before.direction,request:request.directionRequest});
    if(directionReview.candidate&&!directionReview.conflicts.length&&castReview.candidate&&!castReview.conflicts.length)candidate=state(context,directionReview.candidate,castReview);
  }else if(request.directionRequest!==null)editFail("Resolve the complete shot plan before supplying its direction request.");
  return seal({schema:"hv-current-screenplay-proposal/1" as const,projectId,libraryVersion:version,createdAt,request,requestRevision:hash(request),planReview,directionReview,castReview,candidate});
}
function acceptance(projectId:string,head:CurrentScreenplayHead,proposals:CurrentScreenplayProposal[],request:CurrentScreenplayAcceptanceRequest,version:number,createdAt:string):CurrentScreenplayAcceptance {
  acceptanceRequest(request);const at=date(createdAt),chosen=proposals.find(row=>row.revision===request.proposalRevision);
  if(request.expectedHeadRevision!==head.revision||!chosen||chosen.request.expectedHeadRevision!==head.revision||chosen.request.beforeStateRevision!==head.state.revision)editFail("Accept only the exact saved proposal from the current screenplay head.");
  if(!chosen.candidate||at<Math.max(date(chosen.createdAt),date(head.createdAt),date(head.script.createdAt)))editFail("Resolve the complete saved proposal before accepting it at a valid time.");
  let parent=head.script.version;const versions=suffix(head.state.context.plan.document,chosen.candidate.context.plan.document).map(patch=>{
    if(patch.before.version!==parent||patch.after.version!==parent+1)editFail("Retain every consecutive structural version without a jump or squash.");
    const value={version:patch.after.version,text:patch.after.text,createdAt,parentVersion:parent};parent=value.version;return value;
  });
  return seal({schema:"hv-current-screenplay-acceptance/1" as const,projectId,libraryVersion:version,createdAt,request,requestRevision:hash(request),state:chosen.candidate,versions});
}
function headOf(library:CurrentScreenplayLibrary):CurrentScreenplayHead|null {
  const last=library.acceptances.at(-1);if(last)return {kind:"acceptance",revision:last.revision,createdAt:last.createdAt,state:last.state,script:last.versions.at(-1)!};
  const root=library.origin;return root?{kind:"origin",revision:root.revision,createdAt:root.createdAt,state:root.state,script:root.request.script}:null;
}
function rebuild(value:CurrentScreenplayLibrary,projectId:string):CurrentScreenplayLibrary {
  exact(value,["schema","projectId","version","origin","proposals","acceptances","headRevision","revision"]);id(projectId);
  if(value.schema!=="hv-current-screenplay-library/1"||value.projectId!==projectId||!Array.isArray(value.proposals)||!Array.isArray(value.acceptances)||value.proposals.length>CURRENT_SCREENPLAY_LIBRARY_LIMITS.proposals||value.acceptances.length>CURRENT_SCREENPLAY_LIBRARY_LIMITS.acceptances)editFail("Retain a bounded complete current screenplay library for this project.");
  integer(value.version,0,1+CURRENT_SCREENPLAY_LIBRARY_LIMITS.proposals+CURRENT_SCREENPLAY_LIBRARY_LIMITS.acceptances);
  let result=emptyCurrentScreenplayLibrary(projectId),lastAt=0;
  const events=[...(value.origin?[{kind:"origin" as const,row:value.origin}]:[]),...value.proposals.map(row=>({kind:"proposal" as const,row})),...value.acceptances.map(row=>({kind:"acceptance" as const,row}))];
  for(const list of [value.proposals,value.acceptances])if(list.some((row,i)=>i>0&&row.libraryVersion<=list[i-1]!.libraryVersion))editFail("Retain append-only current screenplay collection order.");
  if(events.length!==value.version)editFail("Retain every current screenplay library event without a version gap.");
  events.sort((a,b)=>a.row.libraryVersion-b.row.libraryVersion);
  for(const event of events){const row=event.row;integer(row.libraryVersion,1,value.version);const at=date(row.createdAt);
    if(row.libraryVersion!==result.version+1||at<lastAt)editFail("Retain exact chronological current screenplay library history.");lastAt=at;
    const head=headOf(result);let expected:CurrentScreenplayOrigin|CurrentScreenplayProposal|CurrentScreenplayAcceptance;
    if(event.kind==="origin"){
      if(result.version!==0)editFail("The immutable current screenplay origin must be first.");expected=origin(projectId,event.row.request,row.createdAt);result.origin=expected;result.headRevision=expected.revision;
    }else if(event.kind==="proposal"){
      if(!head||result.proposals.some(p=>p.request.id===event.row.request.id))editFail("Retain one immutable request identity per saved proposal after bootstrap.");
      expected=proposal(projectId,head,event.row.request,row.libraryVersion,row.createdAt);result.proposals.push(expected);
    }else{
      if(!head||result.acceptances.some(p=>p.request.id===event.row.request.id))editFail("Retain one immutable request identity per acceptance after bootstrap.");
      expected=acceptance(projectId,head,result.proposals,event.row.request,row.libraryVersion,row.createdAt);result.acceptances.push(expected);result.headRevision=expected.revision;
    }
    if(!same(expected,row))editFail("The current screenplay history differs from its exact original request and replayed evidence.");result.version++;
  }
  const {revision:_revision,...body}=result;result=seal(body);if(!same(result,value))editFail("The current screenplay library head or seal changed.");return result;
}
export function emptyCurrentScreenplayLibrary(projectId:string):CurrentScreenplayLibrary {id(projectId);return seal({schema:"hv-current-screenplay-library/1" as const,projectId,version:0,origin:null,proposals:[],acceptances:[],headRevision:null});}
/** Pure historical replay. Callers must independently establish that this is the owner's saved library. */
export function validateCurrentScreenplayLibrary(input:CurrentScreenplayLibrary,projectId?:string):CurrentScreenplayLibrary {const value=portable(input);return portable(rebuild(value,projectId??value.projectId));}
export function currentScreenplayHead(library:CurrentScreenplayLibrary):CurrentScreenplayHead|null {return headOf(validateCurrentScreenplayLibrary(library));}
function nextVersion(library:CurrentScreenplayLibrary,expectedVersion:number,now:number):void {
  integer(expectedVersion,0,Number.MAX_SAFE_INTEGER);integer(now,0,8640000000000000);
  if(library.version!==expectedVersion)editFail("The current screenplay library changed in another window.");
  const latest=Math.max(library.origin?date(library.origin.createdAt):0,...library.proposals.map(row=>date(row.createdAt)),...library.acceptances.map(row=>date(row.createdAt)));
  if(now<latest)editFail("Retain chronological current screenplay events.");
}
function finish(library:CurrentScreenplayLibrary):CurrentScreenplayLibrary {const {revision:_revision,...data}=library;return portable(seal(data));}
/** These append helpers compute detached results; only the service can authorize/persist them. */
export function bootstrapCurrentScreenplayLibrary(library:CurrentScreenplayLibrary,request:CurrentScreenplayBootstrapRequest,expectedVersion:number,now=Date.now()):{library:CurrentScreenplayLibrary;origin:CurrentScreenplayOrigin;replayed:boolean} {
  const args=portable({library,request,expectedVersion,now}),next=validateCurrentScreenplayLibrary(args.library);bootstrapRequest(args.request);integer(expectedVersion,0,Number.MAX_SAFE_INTEGER);integer(now,0,8640000000000000);
  if(next.origin){if(!same(next.origin.request,args.request))editFail("The immutable screenplay bootstrap already belongs to another request.");return {library:next,origin:structuredClone(next.origin),replayed:true};}
  nextVersion(next,expectedVersion,now);const created=origin(next.projectId,args.request,new Date(now).toISOString());next.origin=created;next.headRevision=created.revision;next.version++;
  return {library:finish(next),origin:structuredClone(created),replayed:false};
}
export function saveCurrentScreenplayProposal(library:CurrentScreenplayLibrary,request:CurrentScreenplayProposalRequest,expectedVersion:number,now=Date.now()):{library:CurrentScreenplayLibrary;proposal:CurrentScreenplayProposal;replayed:boolean} {
  const args=portable({library,request,expectedVersion,now}),next=validateCurrentScreenplayLibrary(args.library);proposalRequest(args.request);integer(expectedVersion,0,Number.MAX_SAFE_INTEGER);integer(now,0,8640000000000000);
  const old=next.proposals.find(row=>row.request.id===args.request.id);if(old){if(!same(old.request,args.request))editFail("This proposal identity already belongs to a different exact request.");return {library:next,proposal:structuredClone(old),replayed:true};}
  nextVersion(next,expectedVersion,now);if(next.proposals.length>=CURRENT_SCREENPLAY_LIBRARY_LIMITS.proposals)editFail("The complete current screenplay proposal history reached its capacity.");const head=headOf(next);if(!head)editFail("Save the exact screenplay origin before proposing an evolution.");
  const created=proposal(next.projectId,head,args.request,next.version+1,new Date(now).toISOString());next.proposals.push(created);next.version++;
  return {library:finish(next),proposal:structuredClone(created),replayed:false};
}
export function acceptCurrentScreenplayProposal(library:CurrentScreenplayLibrary,request:CurrentScreenplayAcceptanceRequest,expectedVersion:number,now=Date.now()):{library:CurrentScreenplayLibrary;acceptance:CurrentScreenplayAcceptance;versions:ScriptVersion[];replayed:boolean} {
  const args=portable({library,request,expectedVersion,now}),next=validateCurrentScreenplayLibrary(args.library);acceptanceRequest(args.request);integer(expectedVersion,0,Number.MAX_SAFE_INTEGER);integer(now,0,8640000000000000);
  const old=next.acceptances.find(row=>row.request.id===args.request.id);if(old){if(!same(old.request,args.request))editFail("This acceptance identity already belongs to a different exact request.");return {library:next,acceptance:structuredClone(old),versions:structuredClone(old.versions),replayed:true};}
  nextVersion(next,expectedVersion,now);if(next.acceptances.length>=CURRENT_SCREENPLAY_LIBRARY_LIMITS.acceptances)editFail("The complete current screenplay acceptance history reached its capacity.");const head=headOf(next);if(!head)editFail("Save the exact screenplay origin before acceptance.");
  const created=acceptance(next.projectId,head,next.proposals,args.request,next.version+1,new Date(now).toISOString());next.acceptances.push(created);next.headRevision=created.revision;next.version++;
  return {library:finish(next),acceptance:structuredClone(created),versions:structuredClone(created.versions),replayed:false};
}
/** Historical linkage permits later unrelated versions; live generation must additionally match the current head. */
export function validateProjectCurrentScreenplay(input:CurrentScreenplayLibrary|undefined,current:{projectId:string;versions:ScriptVersion[]}):CurrentScreenplayLibrary {
  exact(current,["projectId","versions"]);const projectField=Object.getOwnPropertyDescriptor(current,"projectId")!,versionField=Object.getOwnPropertyDescriptor(current,"versions")!;
  if(!Object.hasOwn(projectField,"value")||!Object.hasOwn(versionField,"value"))editFail("Retain project context without accessors.");
  id(projectField.value);if(!Array.isArray(versionField.value))editFail("Retain durable screenplay versions.");
  // The optional feature cannot impose a new date, text or ancestry policy on legacy projects.
  // Existing project/snapshot validators remain authoritative for unrelated version history.
  if(input===undefined)return emptyCurrentScreenplayLibrary(projectField.value);
  const library=validateCurrentScreenplayLibrary(input,projectField.value);if(!library.origin)return library;
  const history=portable(versionField.value as ScriptVersion[]);if(history.length>100000)editFail("Retain bounded durable screenplay versions.");
  const versions=new Map<number,ScriptVersion>();let previous=0;
  for(const value of history){integer(value.version,1,Number.MAX_SAFE_INTEGER);if(value.version<=previous)editFail("Retain ordered unique durable screenplay versions.");versions.set(value.version,value);previous=value.version;}
  const required=[...(library.origin?[library.origin.request.script]:[]),...library.acceptances.flatMap(row=>row.versions)];
  for(const value of required)if(!same(value,versions.get(value.version)??null))editFail("The accepted current screenplay lost an exact durable script version.");return library;
}
/** One full replay returns both target and before-head evidence; this avoids redundant historical
 * validation without exposing an unchecked fast path or caching any current permission result. */
export function resolveCurrentScreenplayTarget(library:CurrentScreenplayLibrary,selector:CurrentScreenplayTargetSelector):CurrentScreenplayTargetResolution {
  const args=portable({library,selector});exact(args.selector,["kind","revision"]);digest(args.selector.revision);const checked=validateCurrentScreenplayLibrary(args.library),head=headOf(checked);if(!head)editFail("Retain a saved current screenplay head before generation.");
  let selected:CurrentScreenplayState;
  if(args.selector.kind==="accepted"){if(args.selector.revision!==head.revision)editFail("Select the exact frozen current screenplay head.");selected=head.state;}
  else if(args.selector.kind==="proposal"){const found=checked.proposals.find(row=>row.revision===args.selector.revision);
    if(!found?.candidate||found.request.expectedHeadRevision!==head.revision||found.request.beforeStateRevision!==head.state.revision)editFail("Select a complete saved proposal from the exact frozen current head.");selected=found.candidate;
  }else editFail("Select an accepted screenplay head or saved candidate proposal.");
  const target=seal({schema:"hv-current-screenplay-target/1" as const,kind:args.selector.kind,projectId:checked.projectId,headRevision:head.revision,recordRevision:args.selector.revision,state:selected});
  return portable({library:checked,head,target});
}
/** The service still checks the owner's actual saved library and current authority. */
export function currentScreenplayTarget(library:CurrentScreenplayLibrary,selector:CurrentScreenplayTargetSelector):CurrentScreenplayTarget {return resolveCurrentScreenplayTarget(library,selector).target;}
