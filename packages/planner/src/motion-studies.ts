import {sourcePlan} from "./scene-cuts";
import {contentHash} from "../../generator/src/capabilities";
import {gateOrThrow,shotText} from "../../safety/src/index";
import {parseFountain} from "../../parser/src/index";
import {directCast,type CastingSnapshot} from "./casting";
import {DEFAULT_DIRECTION,directionEntry,directionSnapshot,DirectionConflict,type DirectionSnapshot,type DirectionSource} from "./direction";
import {validateReference,type ReferenceAsset} from "./references";
import {subjectMotionPlan,type SubjectMotionPlan} from "./subject-motion";

export interface MotionStudy {
  schema:"hv-motion-study/1";projectId:string;version:number;revision:string;createdAt:string;
  source:DirectionSource;sourceHash:string;scriptVersion:number;maxShots:24|60;castingRevision:string;directionRevision:string;
  asset:ReferenceAsset;appearance:"source-image";plan:SubjectMotionPlan;links:{subjectId:string;characterId:string}[];
}
export interface MotionStudies {schema:"hv-motion-studies/1";version:number;studies:MotionStudy[]}
export interface MotionContext {projectId:string;scriptText:string;scriptVersion:number;casting:CastingSnapshot;direction:DirectionSnapshot;assets:ReferenceAsset[]}
export const emptyMotionStudies=():MotionStudies=>({schema:"hv-motion-studies/1",version:0,studies:[]});
function record(input:unknown,keys:string[]):Record<string,unknown> {
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join(",")!==[...keys].sort().join(","))throw new Error("Use supported movement plan fields.");return input as Record<string,unknown>;
}
function sourceContext(context:MotionContext,shotId:string,maxShots:number,now:number){
  if(![24,60].includes(maxShots))throw new Error("Choose the 24-shot or 60-shot plan.");
  const parsed=parseFountain(context.scriptText),shot=sourcePlan(parsed,context.direction,7000,maxShots).find(shot=>shot.id===shotId);
  if(!shot)throw new DirectionConflict("The source shot disappeared. Reload and review the movement plan.");
  const castShot=directCast([shot],parsed,context.casting,now)[0]!;gateOrThrow(shotText(castShot));
  const entry=directionEntry(shot,DEFAULT_DIRECTION),saved=context.direction.entries.find(value=>value.source.id===shotId);
  if(saved&&saved.sourceHash!==entry.sourceHash)throw new DirectionConflict("Review or remove this shot's stale direction before saving its movement plan.");
  return {entry,characterIds:castShot.characterIds??[]};
}
function links(input:unknown,plan:SubjectMotionPlan):MotionStudy["links"] {
  if(!Array.isArray(input)||input.length>6)throw new Error("Link each subject to at most one cast character.");
  const seen=new Set<string>();return input.map(input=>{const value=record(input,["subjectId","characterId"]);
    if(typeof value.subjectId!=="string"||!plan.subjects.some(s=>s.id===value.subjectId)||seen.has(value.subjectId)||typeof value.characterId!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.characterId))throw new Error("Choose distinct subjects and valid cast characters.");
    seen.add(value.subjectId);return {subjectId:value.subjectId,characterId:value.characterId};});
}
export function createMotionStudy(context:MotionContext,shotId:string,input:unknown,version:number,now=Date.now()):MotionStudy {
  const value=record(input,["sourceHash","maxShots","assetId","appearance","prompt","seed","subjects","links"]);
  const current=sourceContext(context,shotId,value.maxShots as number,now);
  if(value.sourceHash!==current.entry.sourceHash)throw new DirectionConflict("The source shot changed. Reload and review the movement plan.");
  const asset=context.assets.find(asset=>asset.id===value.assetId);if(!asset||asset.source?.kind!=="shot-anchor"||asset.source.shotId!==shotId||asset.source.sourceHash!==current.entry.sourceHash)throw new Error("Choose a private source image prepared for this version of this shot.");
  if(value.appearance!=="source-image")throw new Error("Confirm that the movement plan uses the appearance in the source image.");
  const plan=subjectMotionPlan({schema:"hv-subject-motion/1",source:{sha256:asset.sha256,width:asset.width,height:asset.height},prompt:value.prompt,seed:value.seed,subjects:value.subjects}),associations=links(value.links,plan);
  if(associations.some(link=>!current.characterIds.includes(link.characterId)))throw new Error("Link only cast characters present and permitted in this scene.");
  gateOrThrow([plan.prompt,...plan.subjects.map(s=>s.label)].join("\n"));
  const data={projectId:context.projectId,version,createdAt:new Date(now).toISOString(),source:current.entry.source,sourceHash:current.entry.sourceHash,scriptVersion:context.scriptVersion,maxShots:value.maxShots as 24|60,
    castingRevision:context.casting.revision,directionRevision:context.direction.revision,asset:validateReference(asset,context.projectId),appearance:"source-image" as const,plan,links:associations};
  return {schema:"hv-motion-study/1",...data,revision:contentHash(data)};
}
export function validateMotionStudy(input:MotionStudy,projectId:string,catalog:ReferenceAsset[]):MotionStudy {
  const value=record(input,["schema","projectId","version","revision","createdAt","source","sourceHash","scriptVersion","maxShots","castingRevision","directionRevision","asset","appearance","plan","links"]);
  if(value.schema!=="hv-motion-study/1"||value.projectId!==projectId||!Number.isSafeInteger(value.version)||Number(value.version)<1||!Number.isSafeInteger(value.scriptVersion)||Number(value.scriptVersion)<1||![24,60].includes(value.maxShots as number)
    ||value.appearance!=="source-image"||typeof value.createdAt!=="string"||!Number.isFinite(Date.parse(value.createdAt))||![value.revision,value.sourceHash,value.castingRevision,value.directionRevision].every(v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v)))throw new Error("Invalid saved movement plan.");
  directionSnapshot(projectId,0,[{source:input.source,sourceHash:input.sourceHash,settings:DEFAULT_DIRECTION}],0);
  const asset=validateReference(input.asset,projectId),plan=subjectMotionPlan(input.plan);
  if(asset.source?.kind!=="shot-anchor"||asset.source.shotId!==input.source.id||asset.source.sourceHash!==input.sourceHash||!catalog.some(a=>contentHash(a)===contentHash(asset)))throw new Error("Movement source is absent from the private image catalog.");
  if(contentHash(plan)!==contentHash(input.plan)||contentHash(plan.source)!==contentHash({sha256:asset.sha256,width:asset.width,height:asset.height})||contentHash(links(input.links,plan))!==contentHash(input.links))throw new Error("The saved movement inputs changed.");
  const {schema:_schema,revision,...data}=input;if(contentHash(data)!==revision)throw new Error("The movement plan revision changed.");return structuredClone(input);
}
export function validateMotionStudies(input:MotionStudies,projectId:string,catalog:ReferenceAsset[]):MotionStudies {
  record(input,["schema","version","studies"]);
  if(input.schema!=="hv-motion-studies/1"||!Number.isSafeInteger(input.version)||input.version<0||!Array.isArray(input.studies)||input.studies.length>60||new Set(input.studies.map(s=>s.source?.id)).size!==input.studies.length)throw new Error("Invalid saved movement collection.");
  for(const study of input.studies){validateMotionStudy(study,projectId,catalog);if(study.version>input.version)throw new Error("Invalid movement revision order.");}return structuredClone(input);
}
export function assertMotionStudyCurrent(study:MotionStudy,context:MotionContext,now=Date.now()):MotionStudy {
  validateMotionStudy(study,context.projectId,context.assets);
  if(study.scriptVersion!==context.scriptVersion||study.castingRevision!==context.casting.revision||study.directionRevision!==context.direction.revision)throw new DirectionConflict("The screenplay, cast or direction changed. Review and save a new movement plan before exporting.");
  const current=sourceContext(context,study.source.id,study.maxShots,now);
  if(study.sourceHash!==current.entry.sourceHash||study.links.some(link=>!current.characterIds.includes(link.characterId)))throw new DirectionConflict("The movement plan's source or cast association changed.");
  gateOrThrow([study.plan.prompt,...study.plan.subjects.map(s=>s.label)].join("\n"));return structuredClone(study);
}
