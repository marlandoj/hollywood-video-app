import {contentHash} from "../../generator/src/capabilities";
import {applyEditOperation,editFail,editId,editRecord,validateEditTimeline,type EditOperation,type EditTimeline} from "./edit-timeline";

interface EditEventBase {sequence:number;previousRevision:string;at:string;label:string;timelineRevision:string;revision:string}
export type EditEvent=EditEventBase&({kind:"edit";parent:number;operation:EditOperation}|{kind:"cursor";target:number;reason:"undo"|"redo"|"branch"});
export interface EditHistory {schema:"hv-edit-history/1";id:string;root:EditTimeline;events:EditEvent[];revision:string}
export interface EditHistoryState {head:number;timeline:EditTimeline;parent:number|null;children:number[]}
const label=(v:string)=>{if(typeof v!=="string"||!v.trim()||v.length>240||[...v].some(c=>c.charCodeAt(0)<32))editFail("Name the edit or branch in 240 readable characters or fewer.");return v;};
function seal(history:Omit<EditHistory,"revision">):EditHistory{return {...history,revision:contentHash(history)};}
export function createEditHistory(id:string,root:EditTimeline):EditHistory{return seal({schema:"hv-edit-history/1",id:editId(id),root:validateEditTimeline(root),events:[]});}
/** Nodes are immutable edits. Cursor events append undo/redo/branch changes without deleting any node. */
export function editHistoryState(history:EditHistory):EditHistoryState{
  editRecord(history,["schema","id","root","events","revision"]);if(history.schema!=="hv-edit-history/1"||!Array.isArray(history.events)||history.events.length>1000)editFail("Use a supported edit history with up to 1000 events.");editId(history.id);
  const root=validateEditTimeline(history.root),nodes=new Map<number,{timeline:EditTimeline;parent:number|null}>([[0,{timeline:root,parent:null}]]);let head=0,previous=history.root.revision,time=-Infinity;
  for(const [i,event]of history.events.entries()){
    editRecord(event,["sequence","previousRevision","at","label","timelineRevision","revision",...(event.kind==="edit"?["kind","parent","operation"]:["kind","target","reason"])]);
    if(event.sequence!==i+1||event.previousRevision!==previous||!Number.isFinite(Date.parse(event.at))||Date.parse(event.at)<time)editFail("The edit history sequence changed.");label(event.label);
    const {revision,...data}=event;if(revision!==contentHash(data))editFail("An edit event changed.");
    if(event.kind==="edit"){
      if(event.parent!==head)editFail("An edit must extend the currently selected branch.");const timeline=applyEditOperation(nodes.get(head)!.timeline,event.operation);
      // Operations never mutate source facts. Share this validated catalog across replay nodes.
      timeline.sources=root.sources;nodes.set(event.sequence,{timeline,parent:head});head=event.sequence;
    }else if(event.kind==="cursor"){
      const target=nodes.get(event.target);if(!target||!["undo","redo","branch"].includes(event.reason))editFail("Choose an existing edit branch.");
      if(event.reason==="undo"&&nodes.get(head)!.parent!==event.target||event.reason==="redo"&&target.parent!==head)editFail("Undo or redo must follow the selected branch.");head=event.target;
    }else editFail("Unsupported edit event.");
    if(nodes.get(head)!.timeline.revision!==event.timelineRevision)editFail("The edit event no longer reproduces its timeline.");previous=revision;time=Date.parse(event.at);
  }
  const {revision,...data}=history;if(revision!==contentHash(data))editFail("The edit history changed.");const node=nodes.get(head)!;
  return {head,timeline:structuredClone(node.timeline),parent:node.parent,children:[...nodes].filter(([,n])=>n.parent===head).map(([id])=>id)};
}
export function appendEdit(history:EditHistory,operation:EditOperation,description:string,expectedRevision:string,now=Date.now()):EditHistory{
  const state=editHistoryState(history);if(expectedRevision!==history.revision)editFail("The timeline changed in another window. Reload your edit history.");
  const timeline=applyEditOperation(state.timeline,operation);return append(history,{kind:"edit",parent:state.head,operation:structuredClone(operation)},timeline.revision,description,now);
}
export function moveEditCursor(history:EditHistory,target:number,reason:"undo"|"redo"|"branch",description:string,expectedRevision:string,now=Date.now()):EditHistory{
  const state=editHistoryState(history);if(expectedRevision!==history.revision)editFail("The timeline changed in another window. Reload your edit history.");if(!Number.isSafeInteger(target)||target<0||target===state.head)editFail("Choose a different existing edit.");
  const event=history.events.find(e=>e.sequence===target&&e.kind==="edit"),revision=target===0?history.root.revision:event?.timelineRevision;if(!revision)editFail("Choose an existing edit node.");return append(history,{kind:"cursor",target,reason},revision,description,now);
}
function append(history:EditHistory,action:{kind:"edit";parent:number;operation:EditOperation}|{kind:"cursor";target:number;reason:"undo"|"redo"|"branch"},timelineRevision:string,description:string,now:number):EditHistory{
  if(!Number.isFinite(now))editFail("Use a valid edit time.");const data={sequence:history.events.length+1,previousRevision:history.events.at(-1)?.revision??history.root.revision,at:new Date(Math.max(now,Date.parse(history.events.at(-1)?.at??"")||0)).toISOString(),label:label(description),...action,timelineRevision};
  const next=seal({schema:history.schema,id:history.id,root:structuredClone(history.root),events:[...structuredClone(history.events),{...data,revision:contentHash(data)}]});editHistoryState(next);return next;
}
