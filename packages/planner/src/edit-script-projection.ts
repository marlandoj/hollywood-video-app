import {contentHash} from "../../generator/src/capabilities";
import {EDIT_LANES,editFail,editId,editNumber,editRecord,validateEditTimeline,type EditSource,type EditTimeline} from "./edit-timeline";
import {EditTime} from "./edit-time";
import {editRenderClips,type EditRenderClip} from "./edit-transition-render";
import {EDIT_SCRIPT_LIMITS,type EditScriptSourceIndex,type EditScriptNavigation,type EditScriptOccurrence} from "./edit-script-types";

const SAMPLES=1600;
/** Shared window identity lets derived reviews retain the exact contributing shot window. */
export function editScriptOccurrenceId(sourceId:string,entryId:string,clipId:string,windowIndex:number,startSample:number,endSample:number):string{return contentHash({sourceId,entryId,clipId,windowIndex,startSample,endSample});}
const warning="Navigation lists retained source ranges, not guaranteed visible picture or audible contribution after layering, masks, mattes, fades and mixing. Muted marks zero-speed audio holds only.";
function hash(value:unknown){if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Use a current script navigation revision.");}
function text(value:unknown){if(typeof value!=="string")editFail("Retain script navigation text as plain text.");}
function json(value:unknown):string {try{const result=JSON.stringify(value);if(result===undefined)editFail("Retain portable script navigation data.");return result;}catch{editFail("Retain portable script navigation data.");}}
function bytes(value:unknown):number{return new TextEncoder().encode(json(value)).length;}
function bounded(value:unknown):void {if(bytes(value)>EDIT_SCRIPT_LIMITS.responseBytes)editFail("Script navigation exceeds its 8 MiB response capacity. Use fewer retained sources or occurrences.");}

/** Source indexes are derived metadata; no job, receipt body or artifact path may cross this boundary. */
export function validateEditScriptSourceIndex(input:EditScriptSourceIndex,source:EditSource):EditScriptSourceIndex {
  bounded(input);editRecord(input,["schema","sourceId","sourceRevision","receiptRevision","label","language","scriptRevision","scriptText","entries","warnings","revision"]);
  if(input.schema!=="hv-edit-script-source/1"||input.sourceId!==source.id||input.sourceRevision!==source.revision||input.label!==source.label)editFail("The script index belongs to a different original source.");
  hash(input.receiptRevision);hash(input.sourceRevision);hash(input.revision);text(input.label);text(input.language);if(input.scriptRevision!==null)hash(input.scriptRevision);if(input.scriptText!==null)text(input.scriptText);
  if(!Array.isArray(input.entries)||input.entries.length>EDIT_SCRIPT_LIMITS.entriesPerSource||!Array.isArray(input.warnings)||input.warnings.some(w=>typeof w!=="string"))editFail("Retain a bounded script index and its warnings.");
  const ids=new Set<string>();
  for(const entry of input.entries){
    editRecord(entry,["id","kind","sceneIndex","startLine","endLine","text","character","performedText","windows","unavailableReason"]);editId(entry.id);if(ids.has(entry.id))editFail("Script entry identities must be distinct within an original.");ids.add(entry.id);
    if(!["scene","action","dialogue","transition","narration"].includes(entry.kind))editFail("Retain a supported script entry kind.");text(entry.text);
    if(entry.sceneIndex!==null)editNumber(entry.sceneIndex,0,Number.MAX_SAFE_INTEGER,"Script scene index");
    if(entry.startLine===null?entry.endLine!==null:entry.endLine===null)editFail("Retain both script line bounds or neither.");if(entry.startLine!==null){editNumber(entry.startLine,1,Number.MAX_SAFE_INTEGER,"Script start line");editNumber(entry.endLine,entry.startLine,Number.MAX_SAFE_INTEGER,"Script end line");}
    for(const key of ["character","performedText","unavailableReason"] as const)if(Object.hasOwn(entry,key))text(entry[key]);
    if(!Array.isArray(entry.windows))editFail("Retain script source windows as an array.");
    for(const window of entry.windows){
      editRecord(window,["startSample","endSample","lanes","evidence","shotId"]);editNumber(window.startSample,0,source.frames*SAMPLES-1,"Script source start");editNumber(window.endSample,window.startSample+1,source.frames*SAMPLES,"Script source end");
      if(!["measured-speech","shot-coverage"].includes(window.evidence)||!Array.isArray(window.lanes)||!window.lanes.length||new Set(window.lanes).size!==window.lanes.length||window.lanes.some(lane=>!EDIT_LANES.includes(lane)||lane!=="picture"&&lane!=="captions"&&!source.audio.includes(lane)))editFail("Retain supported script timing evidence and available lanes.");
      if(window.evidence==="shot-coverage"&&window.lanes.some(lane=>lane!=="picture"))editFail("Shot coverage does not establish measured speech timing.");if(Object.hasOwn(window,"shotId"))editId(window.shotId);
    }
  }
  const {revision,...data}=input;if(contentHash(data)!==revision||contentHash(JSON.parse(json(input)))!==contentHash(input))editFail("The script index changed after compilation.");return structuredClone(input);
}
interface ClockClip {clip:EditRenderClip;clock:EditTime;start:number;end:number;sourceStart:number;sourceLast:number;cuts:number[];originalStart:number;originalEnd:number}
function clockClip(clip:EditRenderClip,timeline:EditTimeline):ClockClip {
  const clock=new EditTime(clip),start=clip.at*SAMPLES,end=(clip.at+clip.frames)*SAMPLES,original=timeline.clips.find(c=>c.id===clip.id)!,originalStart=original.at*SAMPLES,originalEnd=(original.at+original.frames)*SAMPLES,cuts=new Set([start,end,originalStart,originalEnd]);
  for(const fade of clip.crossfades??[]){cuts.add(fade.at*SAMPLES);cuts.add((fade.at+fade.frames)*SAMPLES);}
  // A zero-rate ramp endpoint mutes even its one exact output sample. Split it from an advancing segment.
  for(const point of clip.timing?.points??[]){const at=(clip.at+point.frame-clip.timing!.offset)*SAMPLES;cuts.add(at);if(point.rate===0)cuts.add(at+1);}
  return {clip,clock,start,end,sourceStart:clock.source(start),sourceLast:clock.source(end-1),cuts:[...cuts].filter(s=>s>=start&&s<=end).sort((a,b)=>a-b),originalStart,originalEnd};
}

/** Project retained half-open source windows through the same monotone clock used by conform. */
export function projectEditScriptNavigation(sequenceId:string,historyRevision:string,input:EditTimeline,indexes:EditScriptSourceIndex[]):EditScriptNavigation {
  editId(sequenceId);hash(historyRevision);const timeline=validateEditTimeline(input);bounded(indexes);
  if(!Array.isArray(indexes)||indexes.length!==timeline.sources.length||new Set(indexes.map(s=>s.sourceId)).size!==indexes.length)editFail("Retain one script index for every original on this edit branch.");
  const sources=timeline.sources.map(source=>{const index=indexes.find(s=>s.sourceId===source.id);if(!index)editFail("The edit lost a script source index.");return validateEditScriptSourceIndex(index,source);});
  const occurrences:EditScriptOccurrence[]=[],data={schema:"hv-edit-script-navigation/1" as const,sequenceId,historyRevision,timelineRevision:timeline.revision,sources,occurrences,warnings:[warning]};let size=bytes({...data,revision:"0".repeat(64)});
  const clips=editRenderClips(timeline).map(clip=>clockClip(clip,timeline));
  for(const source of sources)for(const entry of source.entries)for(const [windowIndex,window]of entry.windows.entries())for(const c of clips){
    if(c.clip.sourceId!==source.sourceId||!window.lanes.includes(c.clip.lane)||c.sourceLast<window.startSample||c.sourceStart>=window.endSample)continue;
    const start=c.clock.boundary(window.startSample),end=c.clock.boundary(window.endSample);if(start>=end)continue;
    const cuts=[start,...c.cuts.filter(s=>s>start&&s<end),end],parts:{at:number;until:number;held:boolean;transition:boolean}[]=[];
    for(let i=1;i<cuts.length;i++){
      const at=cuts[i-1]!,until=cuts[i]!,held=c.clock.speed(at)===0&&c.clock.speed(until-1)===0,transition=at<c.originalStart||until>c.originalEnd||Boolean(c.clip.crossfades?.some(x=>at<(x.at+x.frames)*SAMPLES&&until>x.at*SAMPLES));
      const previous=parts.at(-1);if(previous&&previous.until===at&&previous.held===held&&previous.transition===transition)previous.until=until;else parts.push({at,until,held,transition});
    }
    for(const {at,until,held,transition}of parts){
      const occurrence:EditScriptOccurrence={id:editScriptOccurrenceId(source.sourceId,entry.id,c.clip.id,windowIndex,at,until),sourceId:source.sourceId,entryId:entry.id,clipId:c.clip.id,lane:c.clip.lane,layer:c.clip.layer,startSample:at,endSample:until,startFrame:Math.floor(at/SAMPLES),endFrame:Math.ceil(until/SAMPLES),sourceStartSample:Math.max(window.startSample,c.clock.source(at)),sourceEndSample:Math.min(window.endSample,c.clock.source(held?at:until)),evidence:window.evidence,held,transition,muted:held&&c.clip.lane!=="picture"&&c.clip.lane!=="captions"};
      if(occurrences.length>=EDIT_SCRIPT_LIMITS.occurrences)editFail("Script navigation exceeds its occurrence capacity. Use fewer retained occurrences.");size+=bytes(occurrence)+(occurrences.length?1:0);if(size>EDIT_SCRIPT_LIMITS.responseBytes)editFail("Script navigation exceeds its 8 MiB response capacity. Use fewer retained sources or occurrences.");occurrences.push(occurrence);
    }
  }
  occurrences.sort((a,b)=>a.startSample-b.startSample||a.endSample-b.endSample||a.sourceId.localeCompare(b.sourceId)||a.entryId.localeCompare(b.entryId)||a.clipId.localeCompare(b.clipId)||a.id.localeCompare(b.id));
  const result={...data,revision:contentHash(data)};bounded(result);return result;
}
