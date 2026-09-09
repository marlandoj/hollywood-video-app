import {contentHash} from "../../generator/src/capabilities";
import {editFail,editId,editNumber,editRecord,initialEditTimeline,type EditOperation} from "./edit-timeline";
import {appendEdit,createEditHistory,editHistoryReplay,moveEditCursor,type EditHistory} from "./edit-history";
import {validateEditSourceReceipt,type EditSourceReceipt} from "./edit-sources";

export interface EditSequence {id:string;label:string;createdAt:string;sourceRevisions:string[];history:EditHistory}
export interface EditLibrary {schema:"hv-edit-library/1";version:number;sources:EditSourceReceipt[];sequences:EditSequence[];revision:string}
export type EditSequenceChange={kind:"edit";operation:EditOperation;label:string}|{kind:"cursor";target:number;reason:"undo"|"redo"|"branch";label:string}|{kind:"rename";label:string};
const label=(value:string)=>{if(typeof value!=="string"||!value.trim()||value.length>160||[...value].some(c=>c.charCodeAt(0)<32))editFail("Name this sequence in 160 readable characters or fewer.");return value.trim();};
const seal=(value:Omit<EditLibrary,"revision">):EditLibrary=>({...value,revision:contentHash(value)});
export function emptyEditLibrary():EditLibrary{return seal({schema:"hv-edit-library/1",version:0,sources:[],sequences:[]});}
/** A project deduplicates original receipts; later retention/review receipts cannot rewrite old branches. */
export function validateEditLibrary(library:EditLibrary,projectId:string):EditLibrary{
  editRecord(library,["schema","version","sources","sequences","revision"]);editId(projectId);editNumber(library.version,0,100000,"Editorial library version");
  if(library.schema!=="hv-edit-library/1"||!Array.isArray(library.sources)||library.sources.length>64||!Array.isArray(library.sequences)||library.sequences.length>32||new Set(library.sources.map(s=>s.revision)).size!==library.sources.length||new Set(library.sequences.map(s=>s.id)).size!==library.sequences.length||JSON.stringify(library).length>64*1024**2)editFail("Keep this editorial library within 64 sources, 32 sequences and 64 MiB of metadata.");
  for(const s of library.sources){validateEditSourceReceipt(s);if(s.schema==="hv-edit-source/4")editFail("Mixed-film editing isn't available in saved sequences yet.");if(s.job.projectId!==projectId)editFail("The editorial library contains a source from another project.");}
  for(const sequence of library.sequences){
    editRecord(sequence,["id","label","createdAt","sourceRevisions","history"]);editId(sequence.id);if(sequence.label!==label(sequence.label)||!Number.isFinite(Date.parse(sequence.createdAt))||sequence.history.id!==sequence.id)editFail("Invalid retained edit sequence.");
    const {catalog,receipts}=editHistoryReplay(sequence.history);if(!Array.isArray(sequence.sourceRevisions)||sequence.sourceRevisions.length!==catalog.length)editFail("An edit sequence lost its source bindings.");for(const [i,facts]of catalog.entries())if(receipts[facts.id]&&receipts[facts.id]!==sequence.sourceRevisions[i]||!library.sources.some(s=>s.revision===sequence.sourceRevisions[i]&&contentHash(s.facts)===contentHash(facts)))editFail("An edit sequence lost its original source receipt.");
  }
  if(library.version===0&&(library.sources.length||library.sequences.length))editFail("An initial editorial library must be empty.");
  const {revision,...data}=library;if(contentHash(data)!==revision)editFail("The editorial library changed.");return structuredClone(library);
}
export function createEditSequence(library:EditLibrary,projectId:string,receipts:EditSourceReceipt[],id:string,name:string,firstId:string,width:number,height:number,expectedVersion:number,now=Date.now()):EditLibrary{
  const next=validateEditLibrary(library,projectId);if(next.version!==expectedVersion)editFail("The editorial library changed in another window. Reload its sequences.");editId(id);if(next.sequences.some(s=>s.id===id))editFail("Choose a new sequence identity.");
  if(!Array.isArray(receipts)||!receipts.length||receipts.length>16||new Set(receipts.map(s=>s.job.id)).size!==receipts.length)editFail("Choose one to sixteen distinct retained sources.");
  for(const source of receipts){validateEditSourceReceipt(source);if(source.job.projectId!==projectId)editFail("Choose source media from this project.");if(!next.sources.some(s=>s.revision===source.revision))next.sources.push(structuredClone(source));}
  const root=initialEditTimeline(receipts.map(r=>r.facts),firstId,width,height);next.sequences.push({id,label:label(name),createdAt:new Date(now).toISOString(),sourceRevisions:root.sources.map(s=>receipts.find(r=>r.facts.id===s.id)!.revision),history:createEditHistory(id,root)});
  const {revision:_revision,...data}=next;return validateEditLibrary(seal({...data,version:next.version+1}),projectId);
}
export function changeEditSequence(library:EditLibrary,projectId:string,id:string,change:EditSequenceChange,expectedVersion:number,expectedHistoryRevision:string,now=Date.now()):EditLibrary{
  const next=validateEditLibrary(library,projectId);if(next.version!==expectedVersion)editFail("The editorial library changed in another window. Reload its sequences.");const sequence=next.sequences.find(s=>s.id===id);if(!sequence||sequence.history.revision!==expectedHistoryRevision)editFail("The timeline changed in another window. Reload its edit history.");
  editRecord(change,change.kind==="edit"?["kind","operation","label"]:change.kind==="cursor"?["kind","target","reason","label"]:["kind","label"]);
  if(change.kind==="edit"&&change.operation.kind==="source")editFail("Inspect and admit an original through the sequence source control.");
  if(change.kind==="edit")sequence.history=appendEdit(sequence.history,change.operation,change.label,expectedHistoryRevision,now);
  else if(change.kind==="cursor")sequence.history=moveEditCursor(sequence.history,change.target,change.reason,change.label,expectedHistoryRevision,now);
  else if(change.kind==="rename")sequence.label=label(change.label);else editFail("Choose a supported sequence change.");
  const {revision:_revision,...data}=next;return validateEditLibrary(seal({...data,version:next.version+1}),projectId);
}


/** A receipt is verified at the service boundary; source facts never come from an owner's PATCH. */
export function admitEditSource(library:EditLibrary,projectId:string,id:string,receipt:EditSourceReceipt,expectedVersion:number,expectedHistoryRevision:string,now=Date.now()):EditLibrary{
  const next=validateEditLibrary(library,projectId),sequence=next.sequences.find(s=>s.id===id);if(next.version!==expectedVersion||!sequence||sequence.history.revision!==expectedHistoryRevision)editFail("The sequence changed. Reload it before adding this original.");validateEditSourceReceipt(receipt);if(receipt.job.projectId!==projectId)editFail("Choose a retained original from this project.");
  const before=editHistoryReplay(sequence.history),known=before.catalog.find(s=>s.id===receipt.facts.id);if(known&&sequence.sourceRevisions[before.catalog.indexOf(known)]!==receipt.revision)editFail("This sequence already retains a different receipt for that original.");if(before.state.timeline.sources.some(s=>s.id===receipt.facts.id))editFail("This original is already available in the current edit branch.");
  const bound=new Map(before.catalog.map((s,i)=>[s.id,sequence.sourceRevisions[i]!]));bound.set(receipt.facts.id,receipt.revision);if(!next.sources.some(s=>s.revision===receipt.revision))next.sources.push(structuredClone(receipt));
  sequence.history=appendEdit(sequence.history,{kind:"source",source:receipt.facts,receiptRevision:receipt.revision},"Add original: "+receipt.facts.label,expectedHistoryRevision,now);sequence.sourceRevisions=editHistoryReplay(sequence.history).catalog.map(s=>bound.get(s.id)!);
  const {revision:_revision,...data}=next;return validateEditLibrary(seal({...data,version:next.version+1}),projectId);
}
