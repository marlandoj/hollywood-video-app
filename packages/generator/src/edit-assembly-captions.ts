import {contentHash} from "./capabilities";
import {EditAssemblyClock,validateEditAssemblyPlan} from "../../planner/src/edit-assembly-clock";
import type {EditAssemblyPlan} from "../../planner/src/edit-assembly-types";
import {editCaptionCues,editFail} from "../../planner/src/edit-timeline";

export const EDIT_ASSEMBLY_CAPTION_LIMITS={cues:4096,bytes:8*1024**2} as const;
export interface EditAssemblyCaptionCue {
  id:string;rangeId:string;parentCueId:string;
  /** Exact child output positions in integer 48 kHz samples, before WebVTT rounding. */
  start:number;end:number;text:string;
  sourceId:string;sourceCaptionId:string;clipped:boolean;
}

/** Resolve the complete parent's caption clocks and transition handles before selecting ranges. */
export function editAssemblyCaptionCues(input:EditAssemblyPlan):EditAssemblyCaptionCue[]{
  const plan=validateEditAssemblyPlan(input),parentCues=editCaptionCues(plan.parent.timeline),clock=new EditAssemblyClock(plan),result:EditAssemblyCaptionCue[]=[];
  let bytes=2;
  for(const cue of parentCues)for(const span of clock.occurrences(cue.start,cue.end)){
    if(result.length>=EDIT_ASSEMBLY_CAPTION_LIMITS.cues)editFail("The assembly exceeds 4096 retained caption cues. Select fewer caption occurrences.");
    const parentCueId=cue.id,rangeId=span.rangeId,mapped:EditAssemblyCaptionCue={id:"assembly-caption-"+contentHash({rangeId,parentCueId}),rangeId,parentCueId,start:span.outputStartSample,end:span.outputStartSample+span.samples,text:cue.text,sourceId:cue.sourceId,sourceCaptionId:cue.sourceCaptionId,clipped:cue.clipped||span.parentStartSample>cue.start||span.parentStartSample+span.samples<cue.end};
    bytes+=Buffer.byteLength(JSON.stringify(mapped),"utf8")+(result.length?1:0);
    if(bytes>EDIT_ASSEMBLY_CAPTION_LIMITS.bytes)editFail("The assembly caption response exceeds 8 MiB. Select fewer caption occurrences.");
    result.push(mapped);
  }
  return result.sort((a,b)=>a.start-b.start||a.end-b.end||a.id.localeCompare(b.id));
}

function vttTime(samples:number,end=false):string{
  const n=end?Math.ceil(samples/48):Math.floor(samples/48),h=Math.floor(n/3600000),m=Math.floor(n/60000)%60,s=Math.floor(n/1000)%60;
  return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")+"."+String(n%1000).padStart(3,"0");
}
/** Match editVtt escaping, applying millisecond rounding only after the range translation. */
export function editAssemblyVtt(plan:EditAssemblyPlan):string{
  const parts=["WEBVTT\n\n"];let bytes=Buffer.byteLength(parts[0]!);
  for(const [index,cue]of editAssemblyCaptionCues(plan).entries()){
    const part=(index?"\n":"")+cue.id+"\n"+vttTime(cue.start)+" --> "+vttTime(cue.end,true)+"\n"+cue.text.replace(/\r\n?/g,"\n").replace(/\n{2,}/g,"\n").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")+"\n";
    bytes+=Buffer.byteLength(part,"utf8");if(bytes>EDIT_ASSEMBLY_CAPTION_LIMITS.bytes)editFail("The assembly WebVTT exceeds 8 MiB. Select fewer caption occurrences.");parts.push(part);
  }
  return parts.join("");
}
