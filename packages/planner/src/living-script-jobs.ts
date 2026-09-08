import {contentHash} from "../../generator/src/capabilities";
import {validateProviderPlan,type ProviderPlan} from "../../generator/src/catalog";
import type {Project,PersistedProject} from "../../api/src/index";
import {validateEditBinding,assertEditBindingAvailable,type EditSourceBinding} from "./edit-jobs";
import {assertEditOriginalPermission} from "./edit-sources";
import {validateLivingScriptProposals,type LivingScriptProposal} from "./living-script-proposals";
import {validateLivingScriptSettings} from "./living-script-settings";
import type {LivingScriptRenderInputs} from "./living-script-generation";
import {renderShots,validateReusePlan,type ShotReusePlan} from "./shot-reuse";
import {compileRetainedShotReuse} from "./retained-shot-reuse";
import {currentCasting,assertCurrentCastPermission} from "./casting";
import {currentDirection} from "./direction";
import {assertFrameAnchorCatalog} from "./frame-anchors";
import {parseFountain} from "../../parser/src/index";
import type {Job} from "../../queue/src/index";
import {editFail} from "./edit-timeline";

export type LivingScriptGenerationRequest={role:"render"}|{role:"preview";providerPlan:ProviderPlan};
/** A pending render pins the complete proposal, original carrier and exact affected-shot set.
 * It does not commit a screenplay, approve a preview, reserve money or grant media access. */
export interface LivingScriptJobPlan {
  schema:"hv-living-script-job/1";createdAt:string;proposal:LivingScriptProposal;
  binding:EditSourceBinding;request:LivingScriptGenerationRequest;
  inputs:LivingScriptRenderInputs;shotReuse:ShotReusePlan;revision:string;
}
const same=(a:unknown,b:unknown)=>contentHash(a)===contentHash(b);
function portable(value:unknown):void {
  const active=new Set<object>();const visit=(item:unknown,depth:number):void=>{
    if(item===null||typeof item==="string"||typeof item==="boolean")return;
    if(typeof item==="number"&&Number.isFinite(item)&&!Object.is(item,-0))return;
    if(typeof item!=="object"||depth>160||active.has(item))editFail("Retain portable pending screenplay generation data.");
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item),keys=Reflect.ownKeys(item);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain pending screenplay generation data.");
    if(array&&keys.length!==item.length+1)editFail("Retain dense pending generation arrays.");active.add(item);
    for(const key of keys){if(array&&key==="length")continue;const d=Object.getOwnPropertyDescriptor(item,key)!;
      if(typeof key!=="string"||!d.enumerable||!Object.hasOwn(d,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))editFail("Retain pending generation data without accessors or hidden fields.");visit(d.value,depth+1);
    }active.delete(item);
  };visit(value,0);
  if(Buffer.byteLength(JSON.stringify(value),"utf8")>128*1024**2)editFail("The complete pending generation context exceeds 128 MiB.");
}
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Retain the exact pending generation fields.");
}
function checkedProposal(proposal:LivingScriptProposal):LivingScriptProposal {
  const data={schema:"hv-living-script-proposals/1" as const,projectId:proposal.projectId,version:1,proposals:[proposal]};
  return validateLivingScriptProposals({...data,revision:contentHash(data)},proposal.projectId).proposals[0]!;
}
export function createLivingScriptJobPlan(proposal:LivingScriptProposal,binding:EditSourceBinding,request:LivingScriptGenerationRequest,now=Date.now()):LivingScriptJobPlan {
  portable({proposal,binding,request,now});
  if(!proposal||typeof proposal!=="object"||!request||typeof request!=="object"||Array.isArray(request))editFail("Choose a saved screenplay proposal and pending generation request.");
  const reviewed=checkedProposal(proposal),carrier=validateEditBinding(binding,now);
  if(!Number.isSafeInteger(now)||now<Date.parse(reviewed.createdAt)||now>8640000000000000)editFail("Use a pending generation time after its saved proposal.");
  const original=reviewed.editorial.sources.find(source=>source.revision===reviewed.request.patch.receiptRevision);
  if(!original||!same(original,carrier.source)||original.job.id!==reviewed.impact.generation.sourceFilmJobId||!["animatic","final"].includes(original.job.stage))editFail("Pending film generation requires the exact reviewed direct-film original and its retained carrier.");
  const candidate=reviewed.request.candidate;let inputs:LivingScriptRenderInputs;
  if(request.role==="render"){exact(request,["role"]);inputs=structuredClone(candidate);}
  else if(request.role==="preview"){
    exact(request,["role","providerPlan"]);validateProviderPlan(request.providerPlan);
    if(candidate.stage!=="final"||request.providerPlan.stage!=="animatic")editFail("A pending final film requires an explicitly reviewed animatic provider plan.");
    inputs={...structuredClone(candidate),stage:"animatic",providerPlan:structuredClone(request.providerPlan)};
  }else editFail("Choose a pending preview or the reviewed film render.");
  validateLivingScriptSettings(reviewed.request.baseline,inputs,reviewed.projectId);
  const shots=renderShots(inputs,now),data={projectId:reviewed.projectId,
    shots:request.role==="render"?structuredClone(reviewed.impact.generation.reusableRecords):[],
    forceShotIds:request.role==="render"?[...reviewed.impact.generation.generateShotIds]:shots.map(shot=>shot.id)};
  const shotReuse=validateReusePlan({schema:"hv-shot-reuse/1",...data,revision:contentHash(data)},inputs,now);
  for(const record of shotReuse.shots)compileRetainedShotReuse(record,carrier);
  if(shots.length!==shotReuse.shots.length+shotReuse.forceShotIds.length)editFail("Review every generated and reused shot before pending generation.");
  const body={schema:"hv-living-script-job/1" as const,createdAt:new Date(now).toISOString(),proposal:reviewed,binding:carrier,request:structuredClone(request),inputs,shotReuse};
  return {...body,revision:contentHash(body)};
}
/** Historical validation is independent of today's permissions and original job expiry. */
export function validateLivingScriptJobPlan(plan:LivingScriptJobPlan):LivingScriptJobPlan {
  portable(plan);exact(plan,["schema","createdAt","proposal","binding","request","inputs","shotReuse","revision"]);
  const at=Date.parse(plan.createdAt);
  if(plan.schema!=="hv-living-script-job/1"||!Number.isSafeInteger(at)||new Date(at).toISOString()!==plan.createdAt)editFail("Retain the pending generation schema and exact creation time.");
  const expected=createLivingScriptJobPlan(plan.proposal,plan.binding,plan.request,at);
  if(!same(plan,expected))editFail("The pending generation differs from its saved proposal, provider review or exact shot reuse.");
  return expected;
}
/** Called against the current project inside admission's write fence, then at dispatch/publication.
 * A historical proposal is never authority to change permissions or bypass current source custody. */
export function assertLivingScriptGenerationCurrent(plan:LivingScriptJobPlan,project:Project|PersistedProject|null|undefined,currentCarrier:Job|undefined,now=Date.now()):void {
  assertGenerationCurrent(validateLivingScriptJobPlan(plan),project,currentCarrier,now);
}
type CurrentPreparation={candidate:ReturnType<typeof validateLivingScriptSettings>;shots:{characterIds:string[];sceneNumber:number;heading:string|undefined}[]};
function prepareCurrent(checked:LivingScriptJobPlan,now:number):CurrentPreparation {
  const candidate=validateLivingScriptSettings(checked.proposal.request.baseline,checked.inputs,checked.proposal.projectId),parsed=parseFountain(checked.inputs.scriptText);
  return {candidate,shots:renderShots(checked.inputs,now).map(shot=>({characterIds:shot.characterIds??[],sceneNumber:shot.sceneIndex+1,heading:parsed.scenes[shot.sceneIndex]?.heading}))};
}
function assertGenerationCurrent(checked:LivingScriptJobPlan,project:Project|PersistedProject|null|undefined,currentCarrier:Job|undefined,now:number,prepared?:CurrentPreparation):void {
  const proposal=checked.proposal,r=proposal.request;
  if(!project||project.id!==proposal.projectId||Date.parse(project.deleteAfter)<=now||!project.rightsAttestedAt)editFail("The pending screenplay project is unavailable.");
  const versions=Array.isArray(project.versions)?project.versions:project.versions.history(),latest=versions.at(-1);
  if(latest?.version!==r.patch.before.version||latest.text!==r.patch.before.text||project.editLibrary?.revision!==r.editorialRevision
    ||!project.livingScriptProposals?.proposals.some(value=>value.revision===proposal.revision&&same(value,proposal)))editFail("The screenplay, saved cut or reviewed proposal changed before pending generation.");
  const current=currentCasting(project.id,project.castingHistory),direction=currentDirection(project.id,project.directionHistory);
  if(!same(current,r.baseline.casting)||!same(direction,r.baseline.direction))editFail("The pending screenplay's current settings baseline changed.");
  const {candidate,shots}=prepared??prepareCurrent(checked,now),assets=project.referenceAssets??[];
  for(const character of candidate.casting.characters){const saved=current.characters.find(value=>value.id===character.id);
    if(!saved||!same(saved.permission,character.permission)||!same(saved.sceneBindings,character.sceneBindings)||!same(saved.libraryOrigin??null,character.libraryOrigin??null))editFail("Review new character permissions in the current cast before pending generation.");
    for(const reference of character.references??[])if(!assets.some(asset=>same(asset,reference)))editFail("A pending character reference is unavailable in the current asset catalog.");
  }
  for(const entry of candidate.direction.entries)assertFrameAnchorCatalog(entry.settings.frameAnchors,project.id,assets);
  for(const shot of shots)assertCurrentCastPermission(candidate.casting,current,shot.characterIds,shot.sceneNumber,now,shot.heading);
  assertEditBindingAvailable(checked.binding,currentCarrier,now);assertEditOriginalPermission(checked.binding.source,project,now);
}
export interface LivingScriptCurrentGuard {
  readonly bytes:number;
  matches(plan:unknown):boolean;
  assert(project:Project|PersistedProject|null|undefined,currentCarrier:Job|undefined,now?:number):void;
}
/** Validate immutable historical evidence once for an independently bounded owner session.
 * No current permission, carrier, catalog or clock result is cached. The caller must match the
 * entire currently retained job plan before each assertion; a revision alone is insufficient. */
export function createLivingScriptCurrentGuard(plan:LivingScriptJobPlan):LivingScriptCurrentGuard {
  const checked=validateLivingScriptJobPlan(plan),prepared=prepareCurrent(checked,Date.parse(checked.createdAt));
  const freeze=(value:unknown):void=>{if(value&&typeof value==="object"){for(const item of Object.values(value))freeze(item);Object.freeze(value);}};
  freeze(checked);freeze(prepared);const hash=contentHash(checked),bytes=Buffer.byteLength(JSON.stringify({checked,prepared}),"utf8");
  return Object.freeze({bytes,matches(value:unknown):boolean{try{portable(value);return contentHash(value)===hash;}catch{return false;}},
    assert(project:Project|PersistedProject|null|undefined,currentCarrier:Job|undefined,now=Date.now()):void{assertGenerationCurrent(checked,project,currentCarrier,now,prepared);}});
}
/** Job identity includes exact proposal context, not just a proposed numeric script version. */
export function assertLivingScriptJobInputs(plan:LivingScriptJobPlan,job:LivingScriptRenderInputs&{shotReuse?:ShotReusePlan}):void {
  const checked=validateLivingScriptJobPlan(plan),actual:LivingScriptRenderInputs={projectId:job.projectId,stage:job.stage,tier:job.tier,scriptVersion:job.scriptVersion,scriptText:job.scriptText,
    ...(job.casting?{casting:job.casting}:{}),...(job.direction?{direction:job.direction}:{}),...(job.providerPlan?{providerPlan:job.providerPlan}:{})};
  if(!same(actual,checked.inputs)||!same(job.shotReuse??null,checked.shotReuse))editFail("The pending job changed its reviewed screenplay, settings, providers or shot reuse.");
}
