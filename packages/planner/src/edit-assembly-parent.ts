import {contentHash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";
import {editFail,editId,editNumber,editRecord} from "./edit-timeline";
import {editHistoryReplay} from "./edit-history";
import {validateEditLibrary,type EditLibrary} from "./edit-library";
import {validateEditAssemblyLibrary,type EditAssemblyLibrary} from "./edit-assembly-proposals";
import type {EditAssemblyParent} from "./edit-assembly-types";
import {assertEditBindingAvailable,type EditSourceBinding} from "./edit-jobs";
import {assertEditOriginalPermission} from "./edit-sources";

/** Server-selected current metadata, never accepted as an owner request body. */
export interface EditAssemblyCarrier {binding:EditSourceBinding;current:Job|undefined}
export interface EditAssemblyExpected {libraryVersion:number;historyRevision:string}
export interface EditAssemblyRevisionExpected extends EditAssemblyExpected {proposalRevision:string}
function historyRevision(value:string):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain a complete parent history revision.");}
export function validateEditAssemblyExpected(expected:EditAssemblyExpected,revision=false):void {
  const fields=["libraryVersion","historyRevision",...(revision?["proposalRevision"]:[])];editRecord(expected,fields);if(Object.keys(expected).length!==fields.length)editFail("Retain the assembly library and parent history revisions.");editNumber(expected.libraryVersion,0,100000,"Assembly library version");historyRevision(expected.historyRevision);if(revision)historyRevision((expected as EditAssemblyRevisionExpected).proposalRevision);
}
function catalog(parent:EditAssemblyParent,projectId:string,library:EditLibrary):void {
  for(const [i,binding]of parent.sourceReceipts.entries()){
    const facts=parent.timeline.sources[i],receipt=library.sources.find(s=>s.revision===binding.receiptRevision);
    if(!facts||binding.sourceId!==facts.id||!receipt||receipt.job.projectId!==projectId||receipt.facts.id!==binding.sourceId||contentHash(receipt.facts)!==contentHash(facts))editFail("The assembly parent lost an owned original receipt or its measured facts.");
  }
}
/** Derive inside the project mutation so caller-supplied timelines cannot replace the saved parent. */
export function deriveEditAssemblyParent(projectId:string,library:EditLibrary,sequenceId:string,expectedHistoryRevision?:string):EditAssemblyParent {
  editId(sequenceId);const checked=validateEditLibrary(library,projectId),sequence=checked.sequences.find(s=>s.id===sequenceId);if(!sequence)editFail("Choose a saved parent edit sequence.");
  if(expectedHistoryRevision!==undefined){historyRevision(expectedHistoryRevision);if(sequence.history.revision!==expectedHistoryRevision)editFail("The parent history changed. Reload the saved sequence.");}
  const replay=editHistoryReplay(sequence.history),receipts=new Map(replay.catalog.map((s,i)=>[s.id,sequence.sourceRevisions[i]!])),parent:EditAssemblyParent={sequenceId:sequence.id,historyRevision:sequence.history.revision,timeline:replay.state.timeline,sourceReceipts:replay.state.timeline.sources.map(s=>({sourceId:s.id,receiptRevision:receipts.get(s.id)!}))};
  catalog(parent,projectId,checked);return structuredClone(parent);
}
/** Restored proposals and old accepted versions retain receipts without requiring the parent to stay current. */
export function validateProjectAssemblyLibrary(library:EditAssemblyLibrary,projectId:string,editorial:EditLibrary):EditAssemblyLibrary {
  editId(projectId);const checked=validateEditAssemblyLibrary(library);if(!checked.proposals.length&&!checked.assemblies.length)return checked;const sources=validateEditLibrary(editorial,projectId);
  for(const item of [...checked.proposals,...checked.assemblies])catalog(item.plan.parent,projectId,sources);return checked;
}
/** Same-process synchronous fence; PostgreSQL supplies these jobs under carrier row locks. */
export function assertEditAssemblyCarriers(parent:EditAssemblyParent,project:Parameters<typeof assertEditOriginalPermission>[1],carriers:EditAssemblyCarrier[],now=Date.now()):void {
  if(!project||!Array.isArray(carriers)||carriers.length!==parent.sourceReceipts.length||new Set(carriers.map(c=>c?.binding?.source?.facts?.id)).size!==carriers.length)editFail("Retain one current owned carrier for every assembly original.");
  for(const carrier of carriers){editRecord(carrier,["binding","current"]);if(!Object.hasOwn(carrier,"binding")||!Object.hasOwn(carrier,"current"))editFail("Retain current carrier metadata for the assembly.");}
  for(const [i,receipt]of parent.sourceReceipts.entries()){
    const selected=carriers.find(c=>c?.binding?.source?.facts?.id===receipt.sourceId),binding=selected?.binding;
    if(!binding||binding.source.revision!==receipt.receiptRevision||binding.owner.projectId!==project.id||binding.source.job.projectId!==project.id||contentHash(binding.source.facts)!==contentHash(parent.timeline.sources[i]))editFail("The assembly carrier changed its original identity or measured facts.");
    assertEditBindingAvailable(binding,selected!.current,now);assertEditOriginalPermission(binding.source,project,now);
  }
}
