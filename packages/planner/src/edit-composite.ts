import type {EditClip,EditSource,EditTimeline} from "./edit-timeline";
import {editFail,editNumber} from "./edit-errors";
import {EDIT_COMPOSITE_LIMITS as limits,type EditComposite,type EditMaskBox} from "./edit-composite-types";

type Timeline=Pick<EditTimeline,"clips"|"matteOnlyLayers">;
const record=(value:unknown,keys:string[])=>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))editFail("Use only supported mask and matte fields.");};
const id=(value:unknown)=>{if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))editFail("Retain a valid mask or vertex identity.");};
const coordinate=(value:unknown,label:string)=>editNumber(value,limits.coordinateMinQ16,limits.coordinateMaxQ16,label);
function box(value:EditMaskBox):void{
  record(value,["xQ16","yQ16","widthQ16","heightQ16"]);coordinate(value.xQ16,"Mask left");coordinate(value.yQ16,"Mask top");
  editNumber(value.widthQ16,1,limits.coordinateMaxQ16-value.xQ16,"Mask width");editNumber(value.heightQ16,1,limits.coordinateMaxQ16-value.yQ16,"Mask height");
}
/** This is a render-path decision, not a schema-version check: removed effects can leave a /2 history. */
export function editCompositeNeeded(t:Timeline):boolean{return Boolean(t.matteOnlyLayers?.length||t.clips.some(c=>c.composite));}
export interface EditCompositeGraph {layers:number[];order:number[];dependencies:Record<number,number[]>}
/** Whole-timeline dependencies keep independently timed clips from introducing a latent cycle. */
export function editCompositeGraph(t:Timeline):EditCompositeGraph{
  const layers=[...new Set(t.clips.filter(c=>c.lane==="picture").map(c=>c.layer))].sort((a,b)=>a-b),dependencies:Record<number,number[]>={};
  for(const layer of layers)dependencies[layer]=[];
  for(const clip of t.clips){const matte=clip.composite?.matte;if(!matte)continue;editNumber(matte.layer,0,3,"Matte picture layer");
    if(clip.lane!=="picture"||matte.layer===clip.layer)editFail("A picture cannot use its own layer as a matte.");
    if(!layers.includes(matte.layer))editFail("Choose a matte layer containing retained picture clips.");
    if(!dependencies[clip.layer]!.includes(matte.layer))dependencies[clip.layer]!.push(matte.layer);
  }
  for(const deps of Object.values(dependencies))deps.sort((a,b)=>a-b);
  const order:number[]=[],done=new Set<number>(),path:number[]=[];
  const visit=(layer:number)=>{if(path.includes(layer))editFail("Track matte cycle: "+[...path.slice(path.indexOf(layer)),layer].join(" → ")+". Choose another layer or remove a matte.");if(done.has(layer))return;path.push(layer);for(const dependency of dependencies[layer]!)visit(dependency);path.pop();done.add(layer);order.push(layer);};
  layers.forEach(visit);return {layers,order,dependencies};
}
/** Validate masks against the admitted original; return bounded geometry work for the timeline limit. */
export function validateEditComposite(value:EditComposite,source:EditSource,layer:number):number{
  record(value,["schema","masks","matte","placement"]);
  if(value.schema!=="hv-edit-composite/1"||!Object.keys(value).some(key=>key!=="schema")||new TextEncoder().encode(JSON.stringify(value)).length>limits.payloadBytes)editFail("Keep a nonempty mask or matte setup within its 2 MiB limit.");
  let points=0;
  if(Object.hasOwn(value,"masks")){
    const masks=value.masks;if(!Array.isArray(masks)||!masks.length||masks.length>limits.masks||new Set(masks.map(mask=>mask?.id)).size!==masks.length)editFail("Use one to eight masks with distinct identities.");
    for(const [index,mask]of masks.entries()){
      record(mask,["id","label","sourceRevision","kind","combine","invert","featherQ8","keyframes"]);id(mask.id);
      if(typeof mask.label!=="string"||!mask.label.trim()||mask.label.length>160||/[\p{Cc}\p{Cs}\p{Cf}]/u.test(mask.label))editFail("Name each mask with one to 160 readable characters.");
      if(mask.sourceRevision!==source.revision)editFail("The mask belongs to another original. Explicitly rebind or remove it before replacing this source.");
      if(!["rectangle","ellipse","polygon"].includes(mask.kind)||!["replace","union","intersect","subtract"].includes(mask.combine)||index===0&&mask.combine!=="replace"||typeof mask.invert!=="boolean")editFail("Choose a supported shape and mask combination; the first mask replaces coverage.");
      editNumber(mask.featherQ8,0,limits.featherMaxQ8,"Mask feather");
      if(!Array.isArray(mask.keyframes)||!mask.keyframes.length||mask.keyframes.length>limits.keyframes)editFail("Use one to 512 original-frame mask keys.");
      let previous=-1,vertices:string[]|undefined;
      for(const key of mask.keyframes){
        record(key,["sourceFrame","interpolation","geometry"]);editNumber(key.sourceFrame,previous+1,source.frames-1,"Mask source frame");previous=key.sourceFrame;
        if(!["hold","linear"].includes(key.interpolation))editFail("Choose hold or linear mask interpolation.");
        if(mask.kind==="polygon"){
          const geometry=key.geometry as {points:{id:string;xQ16:number;yQ16:number}[]};record(geometry,["points"]);
          if(!Array.isArray(geometry.points)||geometry.points.length<3||geometry.points.length>limits.vertices)editFail("Use three to 64 polygon vertices.");
          const ids=geometry.points.map(point=>{record(point,["id","xQ16","yQ16"]);id(point.id);coordinate(point.xQ16,"Vertex X");coordinate(point.yQ16,"Vertex Y");return point.id;});
          if(new Set(ids).size!==ids.length||vertices&&JSON.stringify(ids)!==JSON.stringify(vertices))editFail("Keep the same distinct polygon vertices in the same order at every keyframe.");vertices=ids;points+=ids.length;
        }else{box(key.geometry as EditMaskBox);points+=4;}
      }
    }
  }
  if(Object.hasOwn(value,"matte")){const matte=value.matte!;record(matte,["layer","channel","invert"]);editNumber(matte.layer,0,3,"Matte layer");if(matte.layer===layer||!["alpha","luma"].includes(matte.channel)||typeof matte.invert!=="boolean")editFail("Choose a different picture layer and alpha or luminance matte coverage.");}
  if(Object.hasOwn(value,"placement")){const placement=value.placement!;record(placement,["xQ16","yQ16","scaleQ16","rotationMilliDegrees"]);coordinate(placement.xQ16,"Picture translation X");coordinate(placement.yQ16,"Picture translation Y");editNumber(placement.scaleQ16,limits.scaleMinQ16,limits.scaleMaxQ16,"Picture scale");editNumber(placement.rotationMilliDegrees,-360000,360000,"Picture rotation");}
  return points;
}
export function validateEditCompositeTimeline(t:Pick<EditTimeline,"schema"|"sources"|"clips"|"matteOnlyLayers">):void{
  let points=0;for(const clip of t.clips)if(Object.hasOwn(clip,"composite")){if(clip.lane!=="picture")editFail("Masks and mattes apply only to picture clips.");points+=validateEditComposite(clip.composite!,t.sources.find(source=>source.id===clip.sourceId)!,clip.layer);}
  if(points>limits.pointSamples)editFail("This timeline exceeds 65,536 retained mask point samples.");
  if(Object.hasOwn(t,"matteOnlyLayers")){const roles=t.matteOnlyLayers;if(!Array.isArray(roles)||!roles.length||roles.length>4||new Set(roles).size!==roles.length)editFail("Choose distinct matte-only picture layers, or omit empty roles.");for(const layer of roles){editNumber(layer,0,3,"Matte-only layer");if(!t.clips.some(clip=>clip.lane==="picture"&&clip.layer===layer))editFail("A matte-only layer must contain retained picture clips.");}}
  if(editCompositeNeeded(t)&&t.schema!=="hv-edit-timeline/2")editFail("Authored masks and track mattes require timeline schema 2.");editCompositeGraph(t);
}
/** Replacement is explicit, preserves unrelated matte/placement settings, and never changes source facts. */
export function replaceEditCompositeSource(clip:EditClip,source:EditSource,maskAction?:"remove"|"rebind"):void{
  const masks=clip.composite?.masks;if(!masks?.length||masks.every(mask=>mask.sourceRevision===source.revision))return;
  if(maskAction!=="remove"&&maskAction!=="rebind")editFail("Replacing this masked original requires choosing Remove masks or Rebind masks to the new source.");
  if(maskAction==="rebind")for(const mask of masks)mask.sourceRevision=source.revision;
  else{delete clip.composite!.masks;if(Object.keys(clip.composite!).length===1)delete clip.composite;}
}
