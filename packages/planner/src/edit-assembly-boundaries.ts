import {contentHash} from "../../generator/src/capabilities";
import {validateEditAssemblyPlan} from "./edit-assembly-clock";
import type {EditAssemblyPlan} from "./edit-assembly-types";
import {EditTime} from "./edit-time";
import {editRenderClips} from "./edit-transition-render";
import {EDIT_AUDIO_LANES,editFail,type EditVoiceWindow} from "./edit-timeline";

interface Boundary {
  rangeId:string;clipId:string;sourceId:string;lane:string;edge:"in"|"out";
  outputFrame:number;parentFrame:number;sourceSample:number;mutedHold:boolean;
}
export interface EditAssemblyBoundaryReview {
  schema:"hv-edit-assembly-boundaries/1";planRevision:string;
  speechCuts:(Boundary&{voiceId:string})[];
  unmeasuredAudioCuts:Boundary[];revision:string;
}

/** Indexed interval membership avoids scanning every voice for every selected range boundary. */
function voiceIndex(voices:EditVoiceWindow[]){
  const sorted=[...voices].sort((a,b)=>a.start-b.start||a.end-b.end||a.id.localeCompare(b.id)),maximum:number[]=[];
  for(const [index,voice]of sorted.entries())maximum.push(Math.max(maximum[index-1]??0,voice.end));
  return (sample:number):EditVoiceWindow[]=>{
    let low=0,high=sorted.length;
    while(low<high){const middle=(low+high)>>>1;if(sorted[middle]!.start<sample)low=middle+1;else high=middle;}
    const result:EditVoiceWindow[]=[];
    for(let index=low-1;index>=0&&maximum[index]!>sample;index--)if(sorted[index]!.end>sample)result.push(sorted[index]!);
    return result.reverse();
  };
}

/** New discontinuous range boundaries only; inherited parent cut reviews remain separate evidence. */
export function reviewEditAssemblyBoundaries(input:EditAssemblyPlan):EditAssemblyBoundaryReview {
  const plan=validateEditAssemblyPlan(input),parent=plan.parent.timeline,speechCuts:EditAssemblyBoundaryReview["speechCuts"]=[],unmeasuredAudioCuts:Boundary[]=[];
  const sources=new Map(parent.sources.map(source=>[source.id,source])),indices=new Map(parent.sources.map(source=>[source.id,voiceIndex(source.voices)]));
  const clips=editRenderClips(parent).filter(clip=>(EDIT_AUDIO_LANES as readonly string[]).includes(clip.lane)).map(clip=>({clip,time:new EditTime(clip)}));
  let output=0;
  for(const [index,range]of plan.ranges.entries()){
    const end=output+range.toFrame-range.fromFrame;
    for(const edge of ["in","out"] as const){
      const frame=edge==="in"?range.fromFrame:range.toFrame;
      const continuous=edge==="in"?plan.ranges[index-1]?.toFrame===frame:plan.ranges[index+1]?.fromFrame===frame;
      if(continuous||frame===0||frame===parent.frames)continue;
      for(const {clip,time}of clips){
        // Trims at an existing rendered clip endpoint belong to the inherited parent review.
        if(frame<=clip.at||frame>=clip.at+clip.frames)continue;
        const source=sources.get(clip.sourceId)!,sourceSample=time.source(frame*1600),sampleInside=frame*1600-(edge==="out"?1:0);
        const boundary:Boundary={rangeId:range.id,clipId:clip.id,sourceId:clip.sourceId,lane:clip.lane,edge,outputFrame:edge==="in"?output:end,parentFrame:frame,sourceSample,mutedHold:time.speed(sampleInside)===0};
        if(source.unmeasuredAudio){unmeasuredAudioCuts.push(boundary);if(unmeasuredAudioCuts.length>100000)editFail("The assembly has too many unmeasured sound boundaries to review.");}
        if(!["mix","dialogue","narration"].includes(clip.lane))continue;
        for(const voice of indices.get(source.id)!(sourceSample))if(clip.lane==="mix"||clip.lane===voice.lane){
          speechCuts.push({...boundary,voiceId:voice.id});if(speechCuts.length>100000)editFail("The assembly has too many measured speech boundaries to review.");
        }
      }
    }
    output=end;
  }
  const data={schema:"hv-edit-assembly-boundaries/1" as const,planRevision:plan.revision,speechCuts,unmeasuredAudioCuts};
  const result={...data,revision:contentHash(data)};
  if(Buffer.byteLength(JSON.stringify(result),"utf8")>8*1024**2)editFail("The assembly boundary review exceeds 8 MiB. Use fewer ranges.");
  return result;
}
