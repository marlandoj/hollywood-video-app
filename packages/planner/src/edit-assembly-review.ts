import {contentHash} from "../../generator/src/capabilities";
import {validateEditAssemblyPlan} from "./edit-assembly-clock";
import type {EditAssemblyPlan,EditAssemblyPurpose} from "./edit-assembly-types";
import {editFail} from "./edit-timeline";

export interface EditAssemblyReview {
  schema:"hv-edit-assembly-review/1";
  planRevision:string;
  purpose:EditAssemblyPurpose;
  frames:number;
  parentFrames:number;
  uniqueRetainedFrames:number;
  repeatedFrames:number;
  omitted:{fromFrame:number;toFrame:number}[];
  joins:{fromRangeId:string;toRangeId:string;outputFrame:number;parentLeftEndFrame:number;parentRightStartFrame:number;continuous:boolean}[];
  target:{frames:1800;status:"exact"|"short"|"long";deltaFrames:number}|null;
  revision:string;
}

/** Structural edit review only. Range membership does not certify audible speech or visible action. */
export function reviewEditAssembly(input:EditAssemblyPlan,purpose:EditAssemblyPurpose):EditAssemblyReview {
  const plan=validateEditAssemblyPlan(input);
  if(!["directors-cut","trailer","sixty-second","custom"].includes(purpose))editFail("Choose an assembly purpose.");
  // Union only for omission accounting. Playback keeps every range in its requested order.
  const covered:{fromFrame:number;toFrame:number}[]=[];
  for(const range of [...plan.ranges].sort((a,b)=>a.fromFrame-b.fromFrame||a.toFrame-b.toFrame)){
    const last=covered.at(-1);
    if(last&&range.fromFrame<=last.toFrame)last.toFrame=Math.max(last.toFrame,range.toFrame);
    else covered.push({fromFrame:range.fromFrame,toFrame:range.toFrame});
  }
  const omitted:EditAssemblyReview["omitted"]=[];
  let position=0,uniqueRetainedFrames=0;
  for(const range of covered){
    if(position<range.fromFrame)omitted.push({fromFrame:position,toFrame:range.fromFrame});
    position=range.toFrame;
    uniqueRetainedFrames+=range.toFrame-range.fromFrame;
  }
  if(position<plan.parent.timeline.frames)omitted.push({fromFrame:position,toFrame:plan.parent.timeline.frames});
  const joins:EditAssemblyReview["joins"]=[];
  let outputFrame=0;
  for(const [index,range]of plan.ranges.entries()){
    const previous=plan.ranges[index-1];
    if(previous)joins.push({fromRangeId:previous.id,toRangeId:range.id,outputFrame,parentLeftEndFrame:previous.toFrame,parentRightStartFrame:range.fromFrame,continuous:previous.toFrame===range.fromFrame});
    outputFrame+=range.toFrame-range.fromFrame;
  }
  const target:EditAssemblyReview["target"]=purpose==="sixty-second"?{frames:1800,status:plan.frames===1800?"exact":plan.frames<1800?"short":"long",deltaFrames:plan.frames-1800}:null;
  const data:Omit<EditAssemblyReview,"revision">={schema:"hv-edit-assembly-review/1",planRevision:plan.revision,purpose,frames:plan.frames,parentFrames:plan.parent.timeline.frames,uniqueRetainedFrames,repeatedFrames:plan.frames-uniqueRetainedFrames,omitted,joins,target};
  return {...data,revision:contentHash(data)};
}
