import {EDIT_FPS,editFail,editId,validateEditTimeline,type EditClip,type EditTimeline} from "./edit-timeline";
import {editCrossfadeWindow} from "./edit-crossfade";

/**
 * HV-023-04: the saved cut written as OpenTimelineIO JSON and as a CMX 3600 EDL, by hand and
 * without a library, so a filmmaker can finish it in a professional tool.
 *
 * Only what both formats can say exactly is written: picture clips at normal speed, their source
 * and record frames, and picture crossfades as dissolves. A speed change or two clips sharing a
 * picture layer is refused by name; everything else the cut holds and these files do not carry
 * (sound lanes, fades, opacity, crops, masks, upper layers in the EDL) is listed in `notCarried`.
 * Media is named by the studio's own job ids, never by a URL, path or token.
 */
export const EDIT_INTERCHANGE_RECORD_START=EDIT_FPS*60*60;
const MAX_DISSOLVE=999;

export interface EditInterchangeSource {sourceId:string;jobId:string;stage:string;sourceRevision:string}
export interface EditInterchangeInput {sequenceId:string;label:string;historyRevision:string;timeline:EditTimeline;sources:EditInterchangeSource[]}
export interface EditInterchangeDissolve {id:string;frames:number;before:number;after:number}
/** Hard-cut ranges, as the timeline records them; a dissolve borrows handles on either side. */
export interface EditInterchangeClip {clipId:string;sourceId:string;jobId:string;stage:string;sourceRevision:string;label:string;sourceFrames:number;recordIn:number;recordOut:number;sourceIn:number;sourceOut:number;dissolveIn:EditInterchangeDissolve|null;
  /** HV-023-05: the shot a joined feature's clip shows — its sequence, final and render record — written to the OTIO clip's metadata. */
  shot?:{sequence:number;finalJobId:string;shotId:string;renderRevision:string}}
export interface EditInterchangeLayer {layer:number;clips:EditInterchangeClip[]}
export interface EditInterchangeCut {schema:"hv-edit-interchange/1";sequenceId:string;label:string;historyRevision:string;timelineRevision:string;fps:typeof EDIT_FPS;frames:number;width:number;height:number;layers:EditInterchangeLayer[];markers:{frame:number;label:string}[];notCarried:string[]}
/** HV-023-05: a joined feature's cut (`packages/planner/src/feature-interchange.ts`), written by the same two writers. */
export interface FeatureInterchangeCut {schema:"hv-feature-interchange/1";featureFilmJobId:string;planRevision:string;outputRevision:string;label:string;fps:typeof EDIT_FPS;frames:number;width:number;height:number;layers:EditInterchangeLayer[];markers:{frame:number;label:string}[];notCarried:string[]}
export type InterchangeCut=EditInterchangeCut|FeatureInterchangeCut;

const hash=(value:string,label:string)=>{if(!/^[a-f0-9]{64}$/.test(value))editFail(label+" is missing.");return value;};
/** Control characters cannot appear inside one EDL line or comment. */
export const interchangeLine=(value:string,max:number)=>[...value].map(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127?" ":c).join("").replace(/ {2,}/g," ").trim().slice(0,max)||"Untitled";

export function editInterchangeCut(input:EditInterchangeInput):EditInterchangeCut{
  const timeline=validateEditTimeline(input.timeline);editId(input.sequenceId);hash(input.historyRevision,"The saved history");
  const sources=new Map<string,EditInterchangeSource>();
  for(const s of input.sources){editId(s.sourceId);editId(s.jobId);hash(s.sourceRevision,"A source revision");if(typeof s.stage!=="string"||!/^[a-z-]{1,40}$/.test(s.stage))editFail("A source stage is missing.");if(sources.has(s.sourceId))editFail("Duplicate interchange source.");sources.set(s.sourceId,s);}
  const picture=timeline.clips.filter(c=>c.lane==="picture");
  if(!picture.length)editFail("This cut has no picture to export.");
  const retimed=picture.find(c=>c.timing);
  if(retimed)editFail("Clip "+retimed.id+" changes speed. Interchange export carries normal-speed picture only; return the clip to normal speed or export without it.");
  const dissolves=new Map<string,{id:string;left:EditClip;frames:number;before:number;after:number}>();
  for(const x of timeline.transitions??[]){const left=timeline.clips.find(c=>c.id===x.leftId)!,right=timeline.clips.find(c=>c.id===x.rightId)!;if(left.lane!=="picture")continue;const w=editCrossfadeWindow(left,right,x.frames,x.alignment,timeline.frames);dissolves.set(right.id,{id:x.id,left,frames:w.frames,before:w.before,after:w.after});}
  const layers:EditInterchangeLayer[]=[];
  for(const layer of [...new Set(picture.map(c=>c.layer))].sort((a,b)=>a-b)){
    const clips=picture.filter(c=>c.layer===layer).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id)),out:EditInterchangeClip[]=[];
    clips.forEach((c,i)=>{
      const previous=clips[i-1];if(previous&&previous.at+previous.frames>c.at)editFail("Clips "+previous.id+" and "+c.id+" overlap on picture layer "+(layer+1)+". Move one to another layer before exporting.");
      const facts=timeline.sources.find(s=>s.id===c.sourceId)!,source=sources.get(c.sourceId);
      if(!source||source.jobId!==facts.id||source.sourceRevision!==facts.revision)editFail("Clip "+c.id+" has no retained original to name. Reload the sequence and export again.");
      const dissolve=dissolves.get(c.id);if(dissolve&&dissolve.left.id!==previous?.id)editFail("A dissolve into clip "+c.id+" does not follow the clip before it.");
      out.push({clipId:c.id,sourceId:c.sourceId,jobId:source.jobId,stage:source.stage,sourceRevision:source.sourceRevision,label:facts.label,sourceFrames:facts.frames,recordIn:c.at,recordOut:c.at+c.frames,sourceIn:c.from,sourceOut:c.from+c.frames,dissolveIn:dissolve?{id:dissolve.id,frames:dissolve.frames,before:dissolve.before,after:dissolve.after}:null});
    });
    layers.push({layer,clips:out});
  }
  const notCarried:string[]=[],lanes=[...new Set(timeline.clips.filter(c=>c.lane!=="picture").map(c=>c.lane))];
  if(lanes.length)notCarried.push("Sound and caption lanes ("+lanes.join(", ")+") are not written; export picture is a reference cut for finishing.");
  if(picture.some(c=>c.envelope.fadeIn||c.envelope.fadeOut))notCarried.push("Picture fades to and from black are not written.");
  if(picture.some(c=>c.opacity!==1))notCarried.push("Picture opacity is not written.");
  if(picture.some(c=>c.crop))notCarried.push("Picture crops are not written.");
  if(picture.some(c=>c.composite)||timeline.matteOnlyLayers?.length)notCarried.push("Masks and track mattes are not written.");
  if(layers.length>1)notCarried.push("The EDL carries picture layer 1 only; the OTIO carries every picture layer.");
  if(timeline.markers.length)notCarried.push("Markers are written to the OTIO only.");
  return {schema:"hv-edit-interchange/1",sequenceId:input.sequenceId,label:interchangeLine(input.label,160),historyRevision:input.historyRevision,timelineRevision:timeline.revision,fps:EDIT_FPS,frames:timeline.frames,width:timeline.width,height:timeline.height,layers,markers:timeline.markers.map(m=>({frame:m.frame,label:m.label})),notCarried};
}

const urn=(jobId:string)=>"urn:hv:job:"+jobId;
const time=(value:number)=>({OTIO_SCHEMA:"RationalTime.1",rate:EDIT_FPS,value});
const range=(start:number,duration:number)=>({OTIO_SCHEMA:"TimeRange.1",duration:time(duration),start_time:time(start)});
const gap=(frames:number)=>({OTIO_SCHEMA:"Gap.1",metadata:{},name:"",source_range:range(0,frames),effects:[],markers:[],enabled:true});

/** OpenTimelineIO JSON: Timeline.1 / Stack.1 / Track.1 / Clip.1 / ExternalReference.1 at 30 fps. */
export function editOtio(cut:InterchangeCut):string{
  const tracks=cut.layers.map(({layer,clips})=>{
    const children:unknown[]=[];let position=0;
    for(const c of clips){
      if(c.recordIn>position)children.push(gap(c.recordIn-position));
      if(c.dissolveIn)children.push({OTIO_SCHEMA:"Transition.1",metadata:{hv:{transitionId:c.dissolveIn.id}},name:"",in_offset:time(c.dissolveIn.before),out_offset:time(c.dissolveIn.after),transition_type:"SMPTE_Dissolve"});
      children.push({OTIO_SCHEMA:"Clip.1",metadata:{hv:{clipId:c.clipId,jobId:c.jobId,stage:c.stage,sourceRevision:c.sourceRevision,...(c.shot?{shot:c.shot}:{})}},name:c.label,source_range:range(c.sourceIn,c.recordOut-c.recordIn),effects:[],markers:[],enabled:true,
        media_reference:{OTIO_SCHEMA:"ExternalReference.1",metadata:{hv:{jobId:c.jobId,sourceRevision:c.sourceRevision}},name:c.jobId,available_range:range(0,c.sourceFrames),available_image_bounds:null,target_url:urn(c.jobId)}});
      position=c.recordOut;
    }
    if(cut.frames>position)children.push(gap(cut.frames-position));
    return {OTIO_SCHEMA:"Track.1",metadata:{hv:{layer}},name:"V"+(layer+1),source_range:null,effects:[],markers:[],enabled:true,children,kind:"Video"};
  });
  const markers=cut.markers.map(m=>({OTIO_SCHEMA:"Marker.2",metadata:{},name:m.label,color:"RED",marked_range:range(m.frame,0),comment:""}));
  const origin=cut.schema==="hv-edit-interchange/1"?{schema:cut.schema,sequenceId:cut.sequenceId,historyRevision:cut.historyRevision,timelineRevision:cut.timelineRevision}
    :{schema:cut.schema,featureFilmJobId:cut.featureFilmJobId,planRevision:cut.planRevision,outputRevision:cut.outputRevision};
  return JSON.stringify({OTIO_SCHEMA:"Timeline.1",metadata:{hv:{...origin,width:cut.width,height:cut.height,notCarried:cut.notCarried}},name:cut.label,global_start_time:time(EDIT_INTERCHANGE_RECORD_START),
    tracks:{OTIO_SCHEMA:"Stack.1",metadata:{},name:"tracks",source_range:null,effects:[],markers,enabled:true,children:tracks}},null,4)+"\n";
}

/** Non-drop-frame SMPTE timecode at the studio's 30 fps. */
export function editTimecode(frame:number):string{
  if(!Number.isSafeInteger(frame)||frame<0||frame>=24*60*60*EDIT_FPS)editFail("Timecode is outside one day.");
  const two=(n:number)=>String(n).padStart(2,"0");return [Math.floor(frame/108000),Math.floor(frame/1800)%60,Math.floor(frame/EDIT_FPS)%60,frame%EDIT_FPS].map(two).join(":");
}

/**
 * CMX 3600 of picture layer 1. A dissolve is written the CMX way: the outgoing clip ends where the
 * dissolve starts, a zero-length cut repeats its last source frame, and the incoming event starts
 * at the dissolve with the handle it borrows before the cut.
 */
export function editCmx3600(cut:InterchangeCut):string{
  const layer=cut.layers[0]!,reels=new Map<string,string>(),out=["TITLE: "+interchangeLine(cut.label,70),"FCM: NON-DROP FRAME",""];
  for(const c of layer.clips)if(!reels.has(c.jobId))reels.set(c.jobId,"HV"+String(reels.size+1).padStart(2,"0"));
  const record=(frame:number)=>editTimecode(EDIT_INTERCHANGE_RECORD_START+frame),event=(n:number,reel:string,kind:string,sIn:number,sOut:number,rIn:number,rOut:number)=>String(n).padStart(3,"0")+"  "+reel.padEnd(8)+" V     "+kind.padEnd(8)+" "+editTimecode(sIn)+" "+editTimecode(sOut)+" "+record(rIn)+" "+record(rOut);
  const comments=(c:EditInterchangeClip)=>["* FROM CLIP NAME: "+interchangeLine(c.label,120),"* SOURCE FILE: "+urn(c.jobId)];
  layer.clips.forEach((c,i)=>{
    if(i+1>999)editFail("A CMX 3600 EDL holds at most 999 events.");
    const next=layer.clips[i+1],before=c.dissolveIn?.before??0,tail=next?.dissolveIn?.before??0;
    if(c.dissolveIn){
      if(c.dissolveIn.frames>MAX_DISSOLVE)editFail("The dissolve into clip "+c.clipId+" is longer than the "+MAX_DISSOLVE+" frames a CMX 3600 EDL can write.");
      const previous=layer.clips[i-1]!,held=previous.sourceOut-before;
      out.push(event(i+1,reels.get(previous.jobId)!,"C",held,held,c.recordIn-before,c.recordIn-before));
      out.push(event(i+1,reels.get(c.jobId)!,"D    "+String(c.dissolveIn.frames).padStart(3,"0"),c.sourceIn-before,c.sourceOut-tail,c.recordIn-before,c.recordOut-tail));
      out.push("* FROM CLIP NAME: "+interchangeLine(previous.label,120),"* TO CLIP NAME: "+interchangeLine(c.label,120),"* SOURCE FILE: "+urn(c.jobId),"");
    }else{out.push(event(i+1,reels.get(c.jobId)!,"C",c.sourceIn,c.sourceOut-tail,c.recordIn,c.recordOut-tail),...comments(c),"");}
  });
  return out.join("\n");
}
