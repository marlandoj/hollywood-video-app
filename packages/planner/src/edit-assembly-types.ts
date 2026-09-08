import type {EditTimeline} from "./edit-timeline";

/** Ordered half-open ranges in the retained parent output clock, never source clip positions. */
export interface EditAssemblyRange {
  id:string;
  fromFrame:number;
  toFrame:number;
  reason:string;
}

/** An independent parent snapshot preserves composition, clocks and borrowed transition handles. */
export interface EditAssemblyParent {
  sequenceId:string;
  historyRevision:string;
  timeline:EditTimeline;
  sourceReceipts:{sourceId:string;receiptRevision:string}[];
}

export interface EditAssemblyPlan {
  schema:"hv-edit-assembly/1";
  parent:EditAssemblyParent;
  ranges:EditAssemblyRange[];
  join:"cut";
  frames:number;
  revision:string;
}

export interface EditAssemblySpan {
  rangeId:string;
  outputStartSample:number;
  parentStartSample:number;
  samples:number;
}

export type EditAssemblyPurpose="directors-cut"|"trailer"|"sixty-second"|"custom";
