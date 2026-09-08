import type {EditLane} from "./edit-timeline";

/** Derived navigation only: all sample addresses use the retained original's 48 kHz clock. */
export type EditScriptEvidence="measured-speech"|"shot-coverage";
export interface EditScriptWindow {startSample:number;endSample:number;lanes:EditLane[];evidence:EditScriptEvidence;shotId?:string}
export interface EditScriptEntry {
  id:string;kind:"scene"|"action"|"dialogue"|"transition"|"narration";
  sceneIndex:number|null;startLine:number|null;endLine:number|null;text:string;
  character?:string;performedText?:string;windows:EditScriptWindow[];unavailableReason?:string;
}
export interface EditScriptSourceIndex {
  schema:"hv-edit-script-source/1";sourceId:string;sourceRevision:string;receiptRevision:string;
  label:string;language:string;scriptRevision:string|null;scriptText:string|null;
  entries:EditScriptEntry[];warnings:string[];revision:string;
}
/** Half-open output sample intervals. Frame bounds enclose that interval for navigation.
 * Source endpoints retain the clock's fractional phase; a held range has equal source endpoints. */
export interface EditScriptOccurrence {
  id:string;sourceId:string;entryId:string;clipId:string;lane:EditLane;layer:number;
  startSample:number;endSample:number;startFrame:number;endFrame:number;
  sourceStartSample:number;sourceEndSample:number;evidence:EditScriptEvidence;
  held:boolean;transition:boolean;muted:boolean;
}
export interface EditScriptNavigation {
  schema:"hv-edit-script-navigation/1";sequenceId:string;historyRevision:string;timelineRevision:string;
  sources:EditScriptSourceIndex[];occurrences:EditScriptOccurrence[];warnings:string[];revision:string;
}
export const EDIT_SCRIPT_LIMITS={entriesPerSource:16384,occurrences:100000,responseBytes:8*1024**2} as const;
