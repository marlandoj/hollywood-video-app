import {contentHash} from "../../generator/src/capabilities";
import {parseFountain} from "../../parser/src/index";
import {assertCharacterPermission,castingSnapshot,validateCasting,type CastingSnapshot} from "./casting";
import {assertPerformanceScene,createScenePerformance} from "./performance-memory";
import {compileLivingScriptDocument,validateLivingScriptDocument,type LivingScriptDocument} from "./living-script-document";
import {editFail} from "./edit-timeline";

export interface LivingScriptCastRebindInput {
  before:LivingScriptDocument;after:LivingScriptDocument;casting:CastingSnapshot;origin:LivingScriptCastOrigin;
}
/** Initial legacy association requires an explicit owner review saved by the service. Later
 * structural associations are independently replayed; hashes never establish owner approval. */
export interface LivingScriptCastOrigin {
  schema:"hv-living-script-cast-origin/1";document:LivingScriptDocument;casting:CastingSnapshot;
  steps:{afterAncestryLength:number;afterDocumentRevision:string;castingRevision:string;createdAt:string}[];revision:string;
}
type SceneField="permission"|"wardrobe"|"scene-binding"|"performance";
export interface LivingScriptCastRebind {
  schema:"hv-living-script-cast-rebind/1";input:LivingScriptCastRebindInput;
  scenes:{sceneId:string;beforeSceneNumber:number;afterSceneNumber:number|null}[];
  changes:{characterId:string;field:SceneField;sceneId:string;beforeSceneNumber:number;afterSceneNumber:number;contentChanged:boolean}[];
  conflicts:{characterId:string|null;field:SceneField|"document";beforeSceneNumber:number|null;reason:string}[];
  candidate:CastingSnapshot|null;createdAt:string;revision:string;
}
const hash=contentHash;
const LIMITS={bytes:128*1024**2,nodes:2500000,depth:180} as const;
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>LIMITS.nodes||depth>LIMITS.depth)editFail("The cast correspondence exceeds its metadata capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>LIMITS.bytes)editFail("The cast correspondence exceeds its metadata capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))editFail("Retain portable cast correspondence data.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain cast correspondence data.");
    if(array&&keys.length!==value.length+1)editFail("Retain dense cast correspondence arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Retain cast correspondence without accessors or hidden fields.");
      bytes+=Buffer.byteLength(key,"utf8");visit(property.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>LIMITS.bytes)editFail("The cast correspondence exceeds its metadata capacity.");return structuredClone(input);
}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Retain the exact cast correspondence fields.");}
function ancestry(before:LivingScriptDocument,after:LivingScriptDocument):void {
  const prefix=before.context.ancestry,next=after.context.ancestry;
  if(before.projectId!==after.projectId||before.rootScriptRevision!==after.rootScriptRevision||prefix.length>next.length||prefix.some((patch,i)=>hash(patch)!==hash(next[i])))editFail("Rebind casting only along the complete current screenplay ancestry.");
  const at=next[prefix.length]?.before??after.context.base;
  if(hash(at)!==hash(before.context.base))editFail("The casting baseline is not the exact ancestor screenplay and locks.");
}

/** A proposed mapping of existing artistic settings and permission scope, never a new grant.
 * The service must supply accepted ancestry, present this complete review and check current
 * rights independently. Orphaned settings require an explicit owner decision; none disappear.
 * New or replaced scenes cannot inherit a grant merely by occupying the same numbered slot. */
function compile(input:LivingScriptCastRebindInput,now:number):LivingScriptCastRebind {
  const copied=portable(input);exact(copied,["before","after","casting","origin"]);
  if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)editFail("Use a valid cast review time.");
  const before=validateLivingScriptDocument(copied.before),after=validateLivingScriptDocument(copied.after);ancestry(before,after);
  const casting=validateCasting(copied.casting,before.projectId);
  if(hash(casting)!==hash(copied.casting)||now<Date.parse(casting.createdAt))editFail("Retain the complete current cast snapshot and its review time.");
  const beforeParsed=parseFountain(before.context.base.text),afterParsed=parseFountain(after.context.base.text),oldScenes=new Map(before.scenes.map(scene=>[scene.sceneIndex+1,scene])),newScenes=new Map(after.scenes.map(scene=>[scene.id,scene]));
  const scenes=before.scenes.map(scene=>({sceneId:scene.id,beforeSceneNumber:scene.sceneIndex+1,afterSceneNumber:newScenes.has(scene.id)?newScenes.get(scene.id)!.sceneIndex+1:null}));
  const content=(scene:LivingScriptDocument["scenes"][number])=>hash({heading:scene.heading,beats:scene.beats.map(beat=>({id:beat.id,kind:beat.kind,contentRevision:beat.contentRevision,lineIds:beat.lineIds}))});
  // Each scene body is hashed once, even when many characters/settings refer to it.
  const beforeContent=new Map(before.scenes.map(scene=>[scene.id,content(scene)])),afterContent=new Map(after.scenes.map(scene=>[scene.id,content(scene)]));
  const changes:LivingScriptCastRebind["changes"]=[],conflicts:LivingScriptCastRebind["conflicts"]=[];
  if(!before.complete||!after.complete)conflicts.push({characterId:null,field:"document",beforeSceneNumber:null,reason:"Resolve unsupported or rejected screenplay structure before rebinding casting."});
  const characters=casting.characters.map(character=>{
    const value=structuredClone(character);
    const mapped=(field:SceneField,number:number):number|null=>{
      const old=oldScenes.get(number),next=old&&newScenes.get(old.id);
      if(!old||!next){conflicts.push({characterId:character.id,field,beforeSceneNumber:number,reason:!old?"The saved setting has no supported original physical scene.":"The original scene was removed, replaced or became unbound; review this setting explicitly."});return null;}
      if((field==="permission"||field==="wardrobe")&&character.sceneBindings.find(binding=>binding.sceneNumber===number)?.heading!==old.heading){
        conflicts.push({characterId:character.id,field,beforeSceneNumber:number,reason:"This scoped setting lacks its exact saved scene binding; review it before carrying it to another screenplay revision."});return null;
      }
      const contentChanged=beforeContent.get(old.id)!==afterContent.get(next.id);
      if(number!==next.sceneIndex+1||contentChanged)changes.push({characterId:character.id,field,sceneId:old.id,beforeSceneNumber:number,afterSceneNumber:next.sceneIndex+1,contentChanged});
      return next.sceneIndex+1;
    };
    // Attestation, expiry, revocation and scope kind remain byte-identical. Only the exact
    // surviving physical scenes can be renumbered. Missing grants block the entire candidate.
    if(value.permission.scope==="scenes")value.permission.sceneNumbers=value.permission.sceneNumbers.map(number=>mapped("permission",number)??number).sort((a,b)=>a-b);
    value.wardrobe=value.wardrobe.map(entry=>entry.sceneNumber===null?entry:{...entry,sceneNumber:mapped("wardrobe",entry.sceneNumber)??entry.sceneNumber});
    value.sceneBindings=value.sceneBindings.map(entry=>{
      const old=oldScenes.get(entry.sceneNumber);
      if(old&&old.heading!==entry.heading)editFail("Review a stale cast scene binding before structural rebinding.");
      const number=mapped("scene-binding",entry.sceneNumber);return number===null?entry:{sceneNumber:number,heading:afterParsed.scenes[number-1]!.heading};
    });
    if(value.scenePerformances)value.scenePerformances=value.scenePerformances.map(memory=>{
      assertPerformanceScene(memory,beforeParsed.scenes[memory.sceneNumber-1]);
      const number=mapped("performance",memory.sceneNumber);if(number===null)return memory;
      const scene=afterParsed.scenes[number-1]!;
      return createScenePerformance(value.id,scene,{notes:memory.notes,controls:memory.controls,...(memory.picture?{picture:memory.picture}:{}),...(memory.nativeVoice?{nativeVoice:memory.nativeVoice}:{})});
    }).sort((a,b)=>a.sceneNumber-b.sceneNumber);
    return value;
  });
  // Do not normalize or persist a partial candidate containing orphaned numeric addresses.
  const candidate=conflicts.length?null:hash(characters)===hash(casting.characters)?casting:castingSnapshot(before.projectId,casting.version+1,characters,now);
  const data={schema:"hv-living-script-cast-rebind/1" as const,input:copied,scenes,changes,conflicts,candidate,createdAt:new Date(now).toISOString()};
  return portable({...data,revision:hash(data)});
}
function sealOrigin(data:Omit<LivingScriptCastOrigin,"revision">):LivingScriptCastOrigin {return {...data,revision:hash(data)};}

/** This is only a review proposal. Persist it with explicit owner acceptance before treating
 * legacy numeric settings as associated with physical scenes. Never bootstrap a later
 * structural revision from an old unbound cast snapshot. */
export function proposeLivingScriptCastOrigin(document:LivingScriptDocument,casting:CastingSnapshot):LivingScriptCastOrigin {
  const copied=portable({document,casting}),checked=validateLivingScriptDocument(copied.document),saved=validateCasting(copied.casting,checked.projectId);
  if(checked.context.ancestry.length)editFail("A later structural screenplay needs its previously accepted cast origin.");
  if(hash(saved)!==hash(copied.casting))editFail("Retain the complete original cast snapshot.");
  return sealOrigin({schema:"hv-living-script-cast-origin/1",document:checked,casting:saved,steps:[]});
}
function resolveOrigin(input:LivingScriptCastOrigin,final:LivingScriptDocument):{document:LivingScriptDocument;casting:CastingSnapshot} {
  exact(input,["schema","document","casting","steps","revision"]);
  if(input.schema!=="hv-living-script-cast-origin/1"||!Array.isArray(input.steps)||input.steps.length>32)editFail("Retain up to 32 complete cast origin steps.");
  const {revision,...data}=input;if(revision!==hash(data))editFail("The retained cast origin changed.");
  const initial=proposeLivingScriptCastOrigin(input.document,input.casting),current=validateLivingScriptDocument(final);let document=initial.document,casting=initial.casting;
  for(const step of input.steps){exact(step,["afterAncestryLength","afterDocumentRevision","castingRevision","createdAt"]);
    if(!Number.isSafeInteger(step.afterAncestryLength)||step.afterAncestryLength<=document.context.ancestry.length||step.afterAncestryLength>current.context.ancestry.length)editFail("The cast origin contains a nonadvancing or missing structural review.");
    const prefix=current.context.ancestry.slice(0,step.afterAncestryLength),after=compileLivingScriptDocument({base:prefix.at(-1)!.after,ancestry:prefix});
    if(after.revision!==step.afterDocumentRevision)editFail("The cast origin's exact document revision changed.");
    const reviewed=compile({before:document,after,casting,origin:initial},Date.parse(step.createdAt));
    if(!reviewed.candidate||step.createdAt!==reviewed.createdAt||reviewed.candidate.revision!==step.castingRevision)editFail("The cast origin contains an unresolved or altered casting review.");
    document=reviewed.input.after;casting=reviewed.candidate;
  }
  return {document,casting};
}
export function compileLivingScriptCastRebind(input:LivingScriptCastRebindInput,now=Date.now()):LivingScriptCastRebind {
  const copied=portable(input);exact(copied,["before","after","casting","origin"]);const current=resolveOrigin(copied.origin,copied.before);
  if(hash(current.document)!==hash(copied.before)||hash(current.casting)!==hash(copied.casting))editFail("The cast snapshot is not bound to this exact before-document revision by its retained origin.");
  return compile(copied,now);
}
const validatedCastCorrespondences=new Set<string>();
export function validateLivingScriptCastRebind(input:LivingScriptCastRebind):LivingScriptCastRebind {
  // Cache only successful historical replay. Full descriptors, capacity and
  // content are checked and cloned on every call; current grants remain below.
  const value=portable(input),key=hash(value);
  if(validatedCastCorrespondences.has(key)){validatedCastCorrespondences.delete(key);validatedCastCorrespondences.add(key);return value;}
  const compiled=compileLivingScriptCastRebind(value.input,Date.parse(value.createdAt));
  if(key!==hash(compiled))editFail("The cast correspondence or proposed settings changed.");
  validatedCastCorrespondences.add(key);if(validatedCastCorrespondences.size>64)validatedCastCorrespondences.delete(validatedCastCorrespondences.values().next().value!);return compiled;
}
/** A deterministic next association for the same atomic acceptance as screenplay/casting.
 * Returning it is not proof of that acceptance; the service must retain its exact receipt. */
export function advanceLivingScriptCastOrigin(input:LivingScriptCastRebind):LivingScriptCastOrigin {
  const reviewed=validateLivingScriptCastRebind(input);
  if(!reviewed.candidate)editFail("Resolve the complete cast review before advancing its origin.");
  if(reviewed.input.before.revision===reviewed.input.after.revision)return structuredClone(reviewed.input.origin);
  const {revision:_revision,...data}=reviewed.input.origin,next=sealOrigin({...data,steps:[...data.steps,{afterAncestryLength:reviewed.input.after.context.ancestry.length,afterDocumentRevision:reviewed.input.after.revision,castingRevision:reviewed.candidate.revision,createdAt:reviewed.createdAt}]});resolveOrigin(next,reviewed.input.after);return portable(next);
}

/** Check the freshly loaded owner state before dispatch/copy/publication. Pending generation
 * uses the original scene's current permission; accepted generation uses the current address.
 * The complete correspondence is checked again. A caller-provided seal is not authority:
 * current must come from the project service, and characterIds from the resolved shot. */
export function assertLivingScriptCastRebindCurrent(input:LivingScriptCastRebind,current:{documentRevision:string;casting:CastingSnapshot},characterIds:string[],sceneNumber:number,now=Date.now()):void {
  const copied=portable({input,current,characterIds,sceneNumber,now});exact(copied.current,["documentRevision","casting"]);
  const review=validateLivingScriptCastRebind(copied.input),candidate=review.candidate;
  if(!candidate||!Number.isSafeInteger(copied.now)||copied.now<0||copied.now>8640000000000000)editFail("Resolve the cast correspondence before using its proposed settings.");
  const before=copied.current.documentRevision===review.input.before.revision,after=copied.current.documentRevision===review.input.after.revision;
  if(!before&&!after)editFail("The owner screenplay changed after the cast correspondence review.");
  const expected=before?review.input.casting:candidate,latest=validateCasting(copied.current.casting,candidate.projectId);
  if(hash(latest)!==hash(copied.current.casting)||hash(latest)!==hash(expected))editFail("Current casting changed after the structural review. Review the latest permissions and settings.");
  if(!Array.isArray(copied.characterIds)||copied.characterIds.length>24||new Set(copied.characterIds).size!==copied.characterIds.length||copied.characterIds.some(id=>typeof id!=="string"))editFail("Use the exact resolved shot's cast identities.");
  const target=review.input.after.scenes.find(scene=>scene.sceneIndex+1===copied.sceneNumber);
  if(!target||!Number.isSafeInteger(copied.sceneNumber))editFail("The proposed shot has no current structural scene.");
  const origin=review.scenes.find(scene=>scene.sceneId===target.id),number=before?origin?.beforeSceneNumber??copied.sceneNumber:copied.sceneNumber;
  const currentDocument=before?review.input.before:review.input.after,currentScene=currentDocument.scenes.find(scene=>scene.sceneIndex+1===number);
  for(const id of copied.characterIds){
    const proposed=candidate.characters.find(character=>character.id===id),actual=latest.characters.find(character=>character.id===id);
    if(!proposed||!actual)editFail("A resolved character is no longer available in this casting review.");
    assertCharacterPermission(proposed,copied.sceneNumber,copied.now);
    if(before&&!origin&&actual.permission.scope!=="project")editFail("An introduced scene has no inherited scene-scoped permission.");
    assertCharacterPermission(actual,number,copied.now);
    if(actual.permission.scope==="scenes"&&(!currentScene||actual.sceneBindings.find(binding=>binding.sceneNumber===number)?.heading!==currentScene.heading))editFail("The current character grant belongs to a different physical scene binding.");
  }
}
