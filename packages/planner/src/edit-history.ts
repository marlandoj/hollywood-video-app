import {contentHash} from "../../generator/src/capabilities";
import {applyEditOperation,editFail,editId,editRecord,validateEditTimeline,type EditSource,type EditOperation,type EditTimeline} from "./edit-timeline";

interface EditEventBase {sequence:number;previousRevision:string;at:string;label:string;timelineRevision:string;revision:string}
export type EditEvent=EditEventBase&({kind:"edit";parent:number;operation:EditOperation}|{kind:"cursor";target:number;reason:"undo"|"redo"|"branch"});
export interface EditHistory {schema:"hv-edit-history/1";id:string;root:EditTimeline;events:EditEvent[];revision:string}
export interface EditHistoryState {head:number;timeline:EditTimeline;parent:number|null;children:number[]}
/** Recovery must retain abandoned effect branches and even no-op new operation records. */
export function editHistoryUsesComposite(history:EditHistory|undefined):boolean{
  if(!history)return false;const root=history.root;
  return Boolean(root?.schema==="hv-edit-timeline/2"||root&&Object.hasOwn(root,"matteOnlyLayers")||root?.clips?.some(clip=>Object.hasOwn(clip,"composite"))||history.events?.some(event=>event.kind==="edit"&&(event.operation.kind==="composite"||event.operation.kind==="matte-only"||event.operation.kind==="replace"&&Object.hasOwn(event.operation,"maskAction")||event.operation.kind==="insert"&&event.operation.clips?.some(clip=>Object.hasOwn(clip,"composite")))));
}
const label=(v:string)=>{if(typeof v!=="string"||!v.trim()||v.length>240||[...v].some(c=>c.charCodeAt(0)<32))editFail("Name the edit or branch in 240 readable characters or fewer.");return v;};
function seal(history:Omit<EditHistory,"revision">):EditHistory{return {...history,revision:contentHash(history)};}
export function createEditHistory(id:string,root:EditTimeline):EditHistory{return seal({schema:"hv-edit-history/1",id:editId(id),root:validateEditTimeline(root),events:[]});}
/** Nodes are immutable edits. Cursor events append undo/redo/branch changes without deleting any node. */
export function editHistoryState(history:EditHistory):EditHistoryState{return editHistoryReplay(history).state;}
export interface EditHistoryReplay {state:EditHistoryState;catalog:EditSource[];receipts:Record<string,string>}
/**
 * HV-023-01: replays of a history that has already been replayed, answered from its own revision.
 *
 * `editHistoryReplay` walks every event from the root and `applyEditOperation` validates the whole
 * timeline twice per event, and nothing memoized it. One `PATCH` to a sequence ran it **2S + 2**
 * times, where S is the number of sequences in the project's library: `validateEditLibrary` replays
 * every sequence, `appendEdit` replays the history before and after the change, and the library is
 * validated again on the way out. At the limits the routes themselves enforce -- 1000 events, 256
 * clips, 32 sequences -- one save measured **20 s** with a single sequence and **5 minutes** with
 * thirty-two, from 0.5 MB of stored metadata, well inside the library's own 64 MiB limit. On a
 * single-threaded server that is the whole studio waiting, from an ordinary edit.
 *
 * | events | one replay | `appendEdit` | one PATCH, 1 sequence | one PATCH, 32 sequences |
 * |---|---|---|---|---|
 * | 62 | 313 ms | 748 ms | 1,375 ms | 20,788 ms |
 * | 250 | 1,243 ms | 2,626 ms | 5,111 ms | 82,170 ms |
 * | 999 | 4,822 ms | 10,392 ms | 20,036 ms | 318,976 ms |
 *
 * The key is the history's own `revision`, which is `contentHash` of everything else in it -- and it
 * is **recomputed here before the cache is consulted**, not trusted. Otherwise a hit would serve a
 * validated replay to a forged history that merely names a revision that was once valid, which is
 * the cache turning "the revision matches the content" into "this revision was valid once". The
 * hash is linear in the stored bytes and costs under a millisecond against the replay's seconds.
 *
 * Bounded at 64 entries, which is twice the 32 sequences a library may hold, so a save that touches
 * every sequence twice does not evict its own working set. A retained timeline is at most 256 clips;
 * sixty-four of them is single-digit megabytes against a 64 MiB library.
 */
const REPLAY_CACHE_LIMIT=64;
const replays=new Map<string,EditHistoryReplay>();
/** How many replays are held. Exported so the bound above is a tested number rather than a comment. */
export const editHistoryReplaysHeld=():number=>replays.size;
/** Callers mutate what they are given, so the cache hands out a copy and keeps the original. */
const copyReplay=(value:EditHistoryReplay):EditHistoryReplay=>({
  state:{head:value.state.head,parent:value.state.parent,children:[...value.state.children],timeline:structuredClone(value.state.timeline)},
  catalog:structuredClone(value.catalog),receipts:{...value.receipts}});
/** Catalog includes abandoned branches so later exports can retain every recorded original. */
export function editHistoryReplay(history:EditHistory):EditHistoryReplay{
  let key:string|null=null;
  try{
    const {revision,...data}=history;
    if(typeof revision==="string"&&contentHash(data)===revision)key=revision;
  }catch{key=null;}
  if(key!==null){
    const hit=replays.get(key);
    // Delete and re-add: the eviction below drops the least recently used, and a library of
    // thirty-two sequences replays them all twice in one request.
    if(hit){replays.delete(key);replays.set(key,hit);return copyReplay(hit);}
  }
  const result=replayEditHistory(history);
  if(key!==null){
    if(replays.size>=REPLAY_CACHE_LIMIT)replays.delete(replays.keys().next().value!);
    replays.set(key,result);
  }
  return copyReplay(result);
}
function replayEditHistory(history:EditHistory):EditHistoryReplay{
  editRecord(history,["schema","id","root","events","revision"]);if(history.schema!=="hv-edit-history/1"||!Array.isArray(history.events)||history.events.length>1000)editFail("Use a supported edit history with up to 1000 events.");editId(history.id);
  const root=validateEditTimeline(history.root),nodes=new Map<number,{timeline:EditTimeline;parent:number|null}>([[0,{timeline:root,parent:null}]]);const catalog=new Map(root.sources.map(s=>[s.id,s])),receipts=new Map<string,string>();let head=0,previous=history.root.revision,time=-Infinity;
  for(const [i,event]of history.events.entries()){
    editRecord(event,["sequence","previousRevision","at","label","timelineRevision","revision",...(event.kind==="edit"?["kind","parent","operation"]:["kind","target","reason"])]);
    if(event.sequence!==i+1||event.previousRevision!==previous||!Number.isFinite(Date.parse(event.at))||Date.parse(event.at)<time)editFail("The edit history sequence changed.");label(event.label);
    const {revision,...data}=event;if(revision!==contentHash(data))editFail("An edit event changed.");
    if(event.kind==="edit"){
      if(event.parent!==head)editFail("An edit must extend the currently selected branch.");const parent=nodes.get(head)!.timeline,timeline=applyEditOperation(parent,event.operation);
      if(event.operation.kind==="source"){const addition=event.operation,facts=timeline.sources.find(s=>s.id===addition.source.id)!,known=catalog.get(facts.id),receipt=receipts.get(facts.id);if(known&&contentHash(known)!==contentHash(facts)||receipt&&receipt!==event.operation.receiptRevision)editFail("A recorded original changed between edit branches.");catalog.set(facts.id,facts);receipts.set(facts.id,event.operation.receiptRevision);if(catalog.size>16)editFail("Use at most sixteen originals across this sequence history.");}
      else timeline.sources=parent.sources;nodes.set(event.sequence,{timeline,parent:head});head=event.sequence;
    }else if(event.kind==="cursor"){
      const target=nodes.get(event.target);if(!target||!["undo","redo","branch"].includes(event.reason))editFail("Choose an existing edit branch.");
      if(event.reason==="undo"&&nodes.get(head)!.parent!==event.target||event.reason==="redo"&&target.parent!==head)editFail("Undo or redo must follow the selected branch.");head=event.target;
    }else editFail("Unsupported edit event.");
    if(nodes.get(head)!.timeline.revision!==event.timelineRevision)editFail("The edit event no longer reproduces its timeline.");previous=revision;time=Date.parse(event.at);
  }
  const {revision,...data}=history;if(revision!==contentHash(data))editFail("The edit history changed.");const node=nodes.get(head)!;
  return {state:{head,timeline:structuredClone(node.timeline),parent:node.parent,children:[...nodes].filter(([,n])=>n.parent===head).map(([id])=>id)},catalog:[...catalog.values()].sort((a,b)=>a.id.localeCompare(b.id)),receipts:Object.fromEntries(receipts)};
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
