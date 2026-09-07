import {contentHash} from "../../generator/src/capabilities";
export {editEnvelopeGain} from "./edit-sampling";

export const EDIT_FPS=30,EDIT_SAMPLES_PER_FRAME=1600,EDIT_MAX_FRAMES=108000;
export const EDIT_AUDIO_LANES=["mix","dialogue","narration","music","ambience","effects"] as const;
export const EDIT_LANES=["picture",...EDIT_AUDIO_LANES,"captions"] as const;
export type EditLane=typeof EDIT_LANES[number];
export interface EditCaption {id:string;start:number;end:number;text:string}
export interface EditVoiceWindow {id:string;start:number;end:number;lane:"dialogue"|"narration"}
/** Source facts are supplied by retained-media admission, never trusted from an owner's request. */
export interface EditSource {id:string;revision:string;label:string;frames:number;width:number;height:number;audio:typeof EDIT_AUDIO_LANES[number][];captions:EditCaption[];voices:EditVoiceWindow[];unmeasuredAudio:boolean}
export interface EditEnvelope {from:number;frames:number;fadeIn:number;fadeOut:number}
export interface EditClip {
  id:string;sourceId:string;lane:EditLane;layer:number;link:string|null;
  at:number;from:number;frames:number;gainDb:number;opacity:number;
  crop:{x:number;y:number;width:number;height:number}|null;envelope:EditEnvelope;
}
export interface EditMarker {id:string;frame:number;label:string}
export interface EditTimeline {schema:"hv-edit-timeline/1";width:number;height:number;frames:number;sources:EditSource[];clips:EditClip[];markers:EditMarker[];revision:string}
export type EditOperation=
  |{kind:"insert";clips:EditClip[];rippleAt?:number;rippleFrames?:number}
  |{kind:"delete";clipId:string;linked:boolean;ripple:boolean}
  |{kind:"move";clipId:string;linked:boolean;at:number}
  |{kind:"reorder";clipId:string;at:number}
  |{kind:"trim";clipId:string;linked:boolean;edge:"in"|"out";delta:number;ripple:boolean}
  |{kind:"slip";clipId:string;linked:boolean;delta:number}
  |{kind:"split";clipId:string;linked:boolean;at:number;rightIds:Record<string,string>;rightLink:string|null}
  |{kind:"roll";leftId:string;rightId:string;linked:boolean;delta:number}
  |{kind:"slide";leftId:string;clipId:string;rightId:string;linked:boolean;delta:number}
  |{kind:"unlink";clipId:string}
  |{kind:"settings";clipId:string;gainDb:number;opacity:number;crop:EditClip["crop"];fadeIn:number;fadeOut:number}
  |{kind:"marker";marker:EditMarker}
  |{kind:"remove-marker";id:string}
  |{kind:"duration";frames:number};
export class EditConflict extends Error {override name="EditConflict";}
export function editFail(message:string):never{throw new EditConflict(message);}
export function editRecord(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))editFail("Use only supported timeline fields.");return value as Record<string,unknown>;}
export function editNumber(value:unknown,min:number,max:number,label:string,integer=true):number{if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isSafeInteger(value))editFail(label+" is outside its supported range.");return value;}
export function editId(value:unknown):string{if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))editFail("Use a valid timeline identity.");return value;}
function text(value:unknown,max:number):string{if(typeof value!=="string"||!value.trim()||value.length>max||[...value].some(c=>c.charCodeAt(0)<32&&!"\t\n\r".includes(c)))editFail("Use a short, readable timeline label or caption.");return value;}
function hash(value:unknown){if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("A timeline revision is missing.");}
function unique(values:string[],label:string){if(new Set(values).size!==values.length)editFail("Duplicate "+label+" identities.");}
function source(input:EditSource):void{
  const s=editRecord(input,["id","revision","label","frames","width","height","audio","captions","voices","unmeasuredAudio"]);editId(s.id);hash(s.revision);text(s.label,160);editNumber(s.frames,1,EDIT_MAX_FRAMES,"Source frames");
  editNumber(s.width,16,3840,"Source width");editNumber(s.height,16,2160,"Source height");
  if(!Array.isArray(s.audio)||s.audio.length>6||s.audio.some(a=>!EDIT_AUDIO_LANES.includes(a))||!Array.isArray(s.captions)||s.captions.length>4096)editFail("Invalid retained sound lanes or captions.");unique(s.audio,"audio lane");unique(s.captions.map(c=>c.id),"source caption");
  for(const c of input.captions){editRecord(c,["id","start","end","text"]);editId(c.id);editNumber(c.start,0,input.frames*1600-1,"Caption start");editNumber(c.end,c.start+1,input.frames*1600,"Caption end");text(c.text,4000);}
  if(!Array.isArray(input.voices)||input.voices.length>4096||typeof input.unmeasuredAudio!=="boolean")editFail("Retain measured voice ranges or declare audio timing unknown.");unique(input.voices.map(v=>v.id),"voice window");for(const v of input.voices){editRecord(v,["id","start","end","lane"]);editId(v.id);editNumber(v.start,0,input.frames*1600-1,"Voice start");editNumber(v.end,v.start+1,input.frames*1600,"Voice end");if(!["dialogue","narration"].includes(v.lane))editFail("Choose a measured voice lane.");}
}
function clip(c:EditClip,t:Omit<EditTimeline,"revision">):void{
  editRecord(c,["id","sourceId","lane","layer","link","at","from","frames","gainDb","opacity","crop","envelope"]);editId(c.id);editId(c.sourceId);if(c.link!==null)editId(c.link);
  const s=t.sources.find(s=>s.id===c.sourceId);if(!s||!EDIT_LANES.includes(c.lane))editFail("Choose retained media and a supported track.");
  if(c.lane!=="picture"&&c.lane!=="captions"&&!s.audio.includes(c.lane))editFail("This source has no "+c.lane+" waveform.");
  editNumber(c.layer,0,c.lane==="picture"?3:0,"Picture layer");editNumber(c.at,0,t.frames-1,"Clip position");editNumber(c.from,0,s.frames-1,"Source in point");editNumber(c.frames,1,Math.min(t.frames-c.at,s.frames-c.from),"Clip duration");
  editNumber(c.gainDb,-60,12,"Clip level",false);if(Math.abs(c.gainDb*10-Math.round(c.gainDb*10))>1e-8)editFail("Use clip levels in 0.1 dB steps.");editNumber(c.opacity,0,1,"Picture opacity",false);
  if((c.lane==="picture"||c.lane==="captions")&&c.gainDb!==0||c.lane!=="picture"&&(c.opacity!==1||c.crop!==null))editFail("Use sound levels on audio and opacity/crop on picture clips.");
  if(c.crop){const r=editRecord(c.crop,["x","y","width","height"]);editNumber(r.x,0,s.width-2,"Crop left");editNumber(r.y,0,s.height-2,"Crop top");editNumber(r.width,2,s.width-c.crop.x,"Crop width");editNumber(r.height,2,s.height-c.crop.y,"Crop height");if(Object.values(r).some(n=>Number(n)%2))editFail("Place crop edges on even pixels.");}
  const e=c.envelope;editRecord(e,["from","frames","fadeIn","fadeOut"]);editNumber(e.from,-EDIT_MAX_FRAMES,c.from,"Envelope source start");editNumber(e.frames,c.from+c.frames-e.from,EDIT_MAX_FRAMES,"Envelope duration");editNumber(e.fadeIn,0,e.frames,"Fade in");editNumber(e.fadeOut,0,e.frames-e.fadeIn,"Fade out");if(c.lane==="captions"&&(e.fadeIn||e.fadeOut))editFail("Caption clips do not have audio or picture fades.");
}
export function editTimeline(input:Omit<EditTimeline,"revision">):EditTimeline{
  editRecord(input,["schema","width","height","frames","sources","clips","markers"]);if(input.schema!=="hv-edit-timeline/1")editFail("Unsupported picture timeline.");
  editNumber(input.width,16,1920,"Timeline width");editNumber(input.height,16,1080,"Timeline height");if(input.width%2||input.height%2)editFail("Use even export dimensions.");editNumber(input.frames,1,EDIT_MAX_FRAMES,"Timeline duration");
  if(!Array.isArray(input.sources)||!input.sources.length||input.sources.length>16||!Array.isArray(input.clips)||input.clips.length>256||!Array.isArray(input.markers)||input.markers.length>256)editFail("Use up to 16 sources, 256 clips and 256 markers.");
  unique(input.sources.map(s=>s.id),"source");input.sources.forEach(source);unique(input.clips.map(c=>c.id),"clip");input.clips.forEach(c=>clip(c,input));
  const groups=new Map<string,EditClip[]>();for(const c of input.clips)if(c.link){const g=groups.get(c.link)??[];g.push(c);groups.set(c.link,g);}
  for(const g of groups.values())if(g.some(c=>c.at!==g[0]!.at||c.from!==g[0]!.from||c.frames!==g[0]!.frames||c.sourceId!==g[0]!.sourceId))editFail("Linked clips must share source and timing. Unlink before an independent L/J edit.");
  unique(input.markers.map(m=>m.id),"marker");for(const m of input.markers){editRecord(m,["id","frame","label"]);editId(m.id);editNumber(m.frame,0,input.frames-1,"Marker position");text(m.label,240);}
  const data=structuredClone(input);data.sources.sort((a,b)=>a.id.localeCompare(b.id));data.clips.sort((a,b)=>EDIT_LANES.indexOf(a.lane)-EDIT_LANES.indexOf(b.lane)||a.layer-b.layer||a.at-b.at||a.id.localeCompare(b.id));data.markers.sort((a,b)=>a.frame-b.frame||a.id.localeCompare(b.id));
  return {...data,revision:contentHash(data)};
}
export function validateEditTimeline(t:EditTimeline):EditTimeline{const {revision:_revision,...data}=editRecord(t,["schema","width","height","frames","sources","clips","markers","revision"]) as unknown as EditTimeline;const expected=editTimeline(data);if(contentHash(expected)!==contentHash(t))editFail("The saved timeline changed.");return expected;}
export function initialEditTimeline(sources:EditSource[],firstId:string,width:number,height:number):EditTimeline{
  const s=sources.find(s=>s.id===firstId);if(!s)editFail("Choose a retained picture source.");const clips:EditClip[]=["picture",...(s.audio.includes("mix")?["mix"]:s.audio),"captions"].map((lane,i)=>({id:"initial-"+i,sourceId:s.id,lane:lane as EditLane,layer:0,link:"initial",at:0,from:0,frames:s.frames,gainDb:0,opacity:1,crop:null,envelope:{from:0,frames:s.frames,fadeIn:0,fadeOut:0}}));return editTimeline({schema:"hv-edit-timeline/1",width,height,frames:s.frames,sources,clips,markers:[]});
}
function selected(t:EditTimeline,id:string,linked:boolean):EditClip[]{const c=t.clips.find(c=>c.id===id);if(!c)editFail("Choose an existing clip.");if(typeof linked!=="boolean")editFail("Choose whether to edit linked tracks together.");if(!linked&&c.link)editFail("Unlink this clip before editing only one track.");return linked&&c.link?t.clips.filter(x=>x.link===c.link):[c];}
function shift(t:EditTimeline,boundary:number,delta:number,except:Set<string>){for(const c of t.clips){if(except.has(c.id))continue;if(c.at<boundary&&c.at+c.frames>boundary)editFail("A ripple boundary crosses another clip. Split or unlink that range first.");if(c.at>=boundary)c.at+=delta;}for(const m of t.markers)if(m.frame>=boundary)m.frame+=delta;t.frames+=delta;}
function roll(t:EditTimeline,leftId:string,rightId:string,delta:number,linked:boolean){const left=selected(t,leftId,linked),right=selected(t,rightId,linked);if(left.some(c=>right.includes(c))||left.length!==right.length||left.some(l=>!right.some(r=>r.lane===l.lane&&r.layer===l.layer&&r.at===l.at+l.frames)))editFail("Roll between adjacent clips with matching linked tracks.");for(const c of left)c.frames+=delta;for(const c of right){c.at+=delta;c.from+=delta;c.frames-=delta;}for(const c of [...left,...right])c.envelope={...c.envelope,from:c.from,frames:c.frames};}
export function applyEditOperation(timeline:EditTimeline,input:EditOperation):EditTimeline{
  const t=validateEditTimeline(timeline),op=structuredClone(input),allowed:Record<EditOperation["kind"],string[]>={insert:["clips","rippleAt","rippleFrames"],delete:["clipId","linked","ripple"],move:["clipId","linked","at"],reorder:["clipId","at"],trim:["clipId","linked","edge","delta","ripple"],slip:["clipId","linked","delta"],split:["clipId","linked","at","rightIds","rightLink"],roll:["leftId","rightId","linked","delta"],slide:["leftId","clipId","rightId","linked","delta"],unlink:["clipId"],settings:["clipId","gainDb","opacity","crop","fadeIn","fadeOut"],marker:["marker"],"remove-marker":["id"],duration:["frames"]};
  if(!op||!Object.hasOwn(allowed,op.kind))editFail("Choose a supported timeline operation.");editRecord(op,["kind",...allowed[op.kind]]);if("delta"in op)editNumber(op.delta,-EDIT_MAX_FRAMES,EDIT_MAX_FRAMES,"Edit offset");
  switch(op.kind){
    case "insert":if(!Array.isArray(op.clips)||!op.clips.length||op.clips.length>256)editFail("Insert one or more retained clips.");if(op.rippleAt!==undefined||op.rippleFrames!==undefined){editNumber(op.rippleAt,0,t.frames,"Ripple position");editNumber(op.rippleFrames,1,EDIT_MAX_FRAMES,"Ripple length");shift(t,op.rippleAt!,op.rippleFrames!,new Set());}t.clips.push(...op.clips);break;
    case "delete":{const clips=selected(t,op.clipId,op.linked),c=clips[0]!,ids=new Set(clips.map(c=>c.id));if(typeof op.ripple!=="boolean")editFail("Choose whether to close the removed range.");t.clips=t.clips.filter(c=>!ids.has(c.id));if(op.ripple){if(t.clips.some(x=>x.at<c.at+c.frames&&x.at+x.frames>c.at))editFail("Other tracks occupy the removed range. Remove them together or keep the gap.");t.markers=t.markers.filter(m=>m.frame<c.at||m.frame>=c.at+c.frames);shift(t,c.at+c.frames,-c.frames,new Set());}break;}
    case "move":{editNumber(op.at,0,EDIT_MAX_FRAMES-1,"Clip position");const clips=selected(t,op.clipId,op.linked),delta=op.at-clips[0]!.at;for(const c of clips)c.at+=delta;break;}
    case "reorder":{const clips=selected(t,op.clipId,true),c=clips[0]!,ids=new Set(clips.map(c=>c.id)),before=c.at,end=c.at+c.frames;editNumber(op.at,0,t.frames-c.frames,"Reordered position after removal");if(t.clips.some(x=>!ids.has(x.id)&&x.at<end&&x.at+x.frames>before))editFail("Reorder a complete linked range without overlapping clips.");const markers=t.markers.filter(m=>m.frame>=before&&m.frame<end);t.markers=t.markers.filter(m=>!markers.includes(m));shift(t,end,-c.frames,ids);shift(t,op.at,c.frames,ids);for(const x of clips)x.at=op.at;for(const m of markers){m.frame+=op.at-before;t.markers.push(m);}break;}
    case "trim":{if(!["in","out"].includes(op.edge)||typeof op.ripple!=="boolean")editFail("Choose a trim edge and ripple behavior.");const clips=selected(t,op.clipId,op.linked),first=clips[0]!,oldEnd=first.at+first.frames,ids=new Set(clips.map(c=>c.id));for(const c of clips){if(op.edge==="in"){c.from+=op.delta;c.frames-=op.delta;if(!op.ripple)c.at+=op.delta;}else c.frames+=op.delta;c.envelope={...c.envelope,from:c.from,frames:c.frames};}if(op.ripple)shift(t,oldEnd,op.edge==="in"?-op.delta:op.delta,ids);break;}
    case "slip":for(const c of selected(t,op.clipId,op.linked)){c.from+=op.delta;c.envelope.from+=op.delta;}break;
    case "split":{const clips=selected(t,op.clipId,op.linked),first=clips[0]!,offset=editNumber(op.at,first.at+1,first.at+first.frames-1,"Split position")-first.at;editRecord(op.rightIds,clips.map(c=>c.id));if(Object.keys(op.rightIds).length!==clips.length)editFail("Give each split track a new identity.");if(op.rightLink!==null)editId(op.rightLink);if(first.link&&(!op.rightLink||t.clips.some(c=>c.link===op.rightLink)))editFail("Give the right-hand linked clips a fresh group identity.");for(const c of clips){const right={...structuredClone(c),id:editId(op.rightIds[c.id]),at:c.at+offset,from:c.from+offset,frames:c.frames-offset,link:op.rightLink};c.frames=offset;t.clips.push(right);}break;}
    case "roll":roll(t,op.leftId,op.rightId,op.delta,op.linked);break;
    case "slide":{const middle=selected(t,op.clipId,op.linked).map(c=>({id:c.id,from:c.from,envelope:structuredClone(c.envelope)}));roll(t,op.leftId,op.clipId,op.delta,op.linked);roll(t,op.clipId,op.rightId,op.delta,op.linked);for(const old of middle){const c=t.clips.find(c=>c.id===old.id)!;c.from=old.from;c.envelope=old.envelope;}break;}
    case "unlink":{const c=t.clips.find(c=>c.id===op.clipId);if(!c)editFail("Choose an existing clip.");c.link=null;break;}
    case "settings":{const c=t.clips.find(c=>c.id===op.clipId);if(!c)editFail("Choose an existing clip.");c.gainDb=op.gainDb;c.opacity=op.opacity;c.crop=op.crop;c.envelope={from:c.from,frames:c.frames,fadeIn:op.fadeIn,fadeOut:op.fadeOut};break;}
    case "marker":{const index=t.markers.findIndex(m=>m.id===op.marker.id);if(index<0)t.markers.push(op.marker);else t.markers[index]=op.marker;break;}
    case "remove-marker":if(!t.markers.some(m=>m.id===op.id))editFail("Choose an existing marker.");t.markers=t.markers.filter(m=>m.id!==op.id);break;
    case "duration":t.frames=op.frames;break;
  }
  const {revision:_revision,...data}=t;return editTimeline(data);
}
export function editCaptionCues(timeline:EditTimeline):{id:string;start:number;end:number;text:string;sourceId:string;sourceCaptionId:string;clipped:boolean}[]{
  const t=validateEditTimeline(timeline),result:ReturnType<typeof editCaptionCues>=[];
  for(const c of t.clips.filter(c=>c.lane==="captions")){const s=t.sources.find(s=>s.id===c.sourceId)!,begin=c.from*1600,end=(c.from+c.frames)*1600,shift=(c.at-c.from)*1600;
    for(const cue of s.captions)if(cue.start<end&&cue.end>begin)result.push({id:c.id+":"+cue.id,start:Math.max(begin,cue.start)+shift,end:Math.min(end,cue.end)+shift,text:cue.text,sourceId:s.id,sourceCaptionId:cue.id,clipped:cue.start<begin||cue.end>end});
  }
  return result.sort((a,b)=>a.start-b.start||a.end-b.end||a.id.localeCompare(b.id));
}
/** Review reports partial source speech coverage even when the owner independently removes captions. */
export function editSpeechCuts(timeline:EditTimeline):{clipId:string;voiceId:string;edge:"in"|"out"}[]{
  const t=validateEditTimeline(timeline),cuts:ReturnType<typeof editSpeechCuts>=[];for(const c of t.clips.filter(c=>c.lane==="mix"||c.lane==="dialogue"||c.lane==="narration")){const s=t.sources.find(s=>s.id===c.sourceId)!;for(const cue of s.voices.filter(v=>c.lane==="mix"||c.lane===v.lane)){if(cue.start<c.from*1600&&cue.end>c.from*1600)cuts.push({clipId:c.id,voiceId:cue.id,edge:"in"});if(cue.start<(c.from+c.frames)*1600&&cue.end>(c.from+c.frames)*1600)cuts.push({clipId:c.id,voiceId:cue.id,edge:"out"});}}return cuts;
}
export function editUnmeasuredCuts(timeline:EditTimeline):string[]{const t=validateEditTimeline(timeline);return t.clips.filter(c=>EDIT_AUDIO_LANES.includes(c.lane as typeof EDIT_AUDIO_LANES[number])&&t.sources.some(s=>s.id===c.sourceId&&s.unmeasuredAudio&&(c.from>0||c.frames<s.frames))).map(c=>c.id);}
