import {contentHash} from "../../generator/src/capabilities";
import {editId,editRecord} from "./edit-timeline";
import {editFail,editNumber} from "./edit-errors";
import {validateMotionGraphic,type MotionGraphicPlan} from "./motion-graphics";

export interface GraphicSpec {schema:"hv-owned-graphic/1";projectId:string;id:string;label:string;plan:MotionGraphicPlan;createdAt:string;revision:string}
export type GraphicChange={kind:"save";id:string;label:string;plan:MotionGraphicPlan}|{kind:"availability";id:string;available:boolean};
export interface GraphicEvent {version:number;at:string;change:{kind:"save";spec:GraphicSpec}|{kind:"availability";id:string;available:boolean};previous:string;revision:string}
export interface GraphicLibrary {schema:"hv-graphic-library/1";version:number;events:GraphicEvent[]}
export interface GraphicState {spec:GraphicSpec;available:boolean}
export const emptyGraphicLibrary=():GraphicLibrary=>({schema:"hv-graphic-library/1",version:0,events:[]});
export function graphicDate(value:unknown):number {if(typeof value!=="string"||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)editFail("Retain a canonical graphic date.");return Date.parse(value);}
export function graphicLabel(value:unknown):string {if(typeof value!=="string"||!value.trim()||value.length>160||/[\p{Cc}\p{Cs}\p{Cf}]/u.test(value))editFail("Name the graphic with one to 160 readable characters.");return value.trim();}
export function validateGraphicSpec(spec:GraphicSpec,projectId:string):GraphicSpec {
  editRecord(spec,["schema","projectId","id","label","plan","createdAt","revision"]);editId(spec.id);editId(projectId);graphicDate(spec.createdAt);validateMotionGraphic(spec.plan);
  const {revision,...data}=spec;if(spec.schema!=="hv-owned-graphic/1"||spec.projectId!==projectId||graphicLabel(spec.label)!==spec.label||revision!==contentHash(data))editFail("The saved graphic or its owner changed.");return structuredClone(spec);
}
function replayGraphicLibrary(library:GraphicLibrary,projectId:string):Map<string,GraphicState>{
  editRecord(library,["schema","version","events"]);editId(projectId);
  if(library.schema!=="hv-graphic-library/1"||!Array.isArray(library.events)||library.events.length>1000||library.version!==library.events.length||JSON.stringify(library).length>8*1024**2)editFail("The graphic library exceeds its history or metadata limit.");
  const states=new Map<string,GraphicState>();let previous=contentHash({projectId,kind:"graphics"}),date=-Infinity;
  for(const [i,event] of library.events.entries()){
    editRecord(event,["version","at","change","previous","revision"]);const {revision,...data}=event,currentDate=graphicDate(event.at);
    if(event.version!==i+1||event.previous!==previous||revision!==contentHash(data)||currentDate<date)editFail("The graphic history changed order or lost an event.");date=currentDate;previous=revision;
    if(event.change.kind==="save"){
      editRecord(event.change,["kind","spec"]);const spec=validateGraphicSpec(event.change.spec,projectId);if(spec.createdAt!==event.at)editFail("The graphic lost its original save date.");
      states.set(spec.id,{spec,available:states.get(spec.id)?.available??true});if(states.size>128)editFail("Use up to 128 graphics in this project.");
    }else{
      editRecord(event.change,["kind","id","available"]);const change=event.change,state=states.get(change.id);if(change.kind!=="availability"||!state||typeof change.available!=="boolean")editFail("Choose an existing graphic and its availability.");state.available=change.available;
    }
  }
  return states;
}
export function validateGraphicLibrary(library:GraphicLibrary,projectId:string):GraphicLibrary {replayGraphicLibrary(library,projectId);return structuredClone(library);}
export function currentGraphics(library:GraphicLibrary,projectId:string):GraphicState[]{return structuredClone([...replayGraphicLibrary(library,projectId).values()]);}
export function graphicSpecAvailable(library:GraphicLibrary,projectId:string,spec:GraphicSpec):boolean {
  validateGraphicSpec(spec,projectId);const state=replayGraphicLibrary(library,projectId).get(spec.id);
  return state?.available===true&&library.events.some(e=>e.change.kind==="save"&&e.change.spec.revision===spec.revision);
}
export function updateGraphicLibrary(library:GraphicLibrary,projectId:string,input:GraphicChange,expectedVersion:number,now=Date.now()):GraphicLibrary {
  const current=validateGraphicLibrary(library,projectId),states=replayGraphicLibrary(current,projectId);editId(input.id);editNumber(expectedVersion,0,1000,"Graphic library version");
  if(input.kind==="save"){editRecord(input,["kind","id","label","plan"]);graphicLabel(input.label);validateMotionGraphic(input.plan);}else{editRecord(input,["kind","id","available"]);if(input.kind!=="availability"||typeof input.available!=="boolean"||!states.has(input.id))editFail("Choose an existing graphic to hide or restore.");}
  const retry=current.events[expectedVersion];
  if(expectedVersion!==current.version){
    if(retry?.change.kind==="save"&&input.kind==="save"&&retry.change.spec.id===input.id&&retry.change.spec.label===graphicLabel(input.label)&&retry.change.spec.plan.revision===input.plan.revision||retry?.change.kind==="availability"&&contentHash(retry.change)===contentHash(input))return current;
    editFail("The graphic library changed. Reload its current version before saving.");
  }
  const at=new Date(now).toISOString();graphicDate(at);let change:GraphicEvent["change"];
  if(input.kind==="save"){const data={schema:"hv-owned-graphic/1" as const,projectId,id:input.id,label:graphicLabel(input.label),plan:structuredClone(input.plan),createdAt:at};change={kind:"save",spec:{...data,revision:contentHash(data)}};}else change=structuredClone(input);
  const data={version:current.version+1,at,change,previous:current.events.at(-1)?.revision??contentHash({projectId,kind:"graphics"})};current.events.push({...data,revision:contentHash(data)});current.version++;return validateGraphicLibrary(current,projectId);
}
