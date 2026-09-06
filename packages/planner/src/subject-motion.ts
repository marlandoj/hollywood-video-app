import {contentHash} from "../../generator/src/capabilities";

/** Point conditioning for Wan-Move; labels identify intended subjects, not identity embeddings. */
export interface SubjectMotionKeyframe {frame:number;x:number;y:number;easing:"linear"|"smooth";visible:boolean}
export interface SubjectMotionTrack {id:string;keyframes:SubjectMotionKeyframe[]}
export interface SubjectMotionPlan {
  schema:"hv-subject-motion/1";
  source:{sha256:string;width:number;height:number};
  prompt:string;seed:number;
  subjects:{id:string;label:string;tracks:SubjectMotionTrack[]}[];
}
export const SUBJECT_MOTION_FRAMES=81;
export const SUBJECT_MOTION_FPS=16;
export const SUBJECT_MOTION_STRIDE=4;
function record(value:unknown,keys:string[],label:string):Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==[...keys].sort().join(","))throw new Error("Use supported "+label+" fields.");
  return value as Record<string,unknown>;
}
function identifier(value:unknown):string {
  if(typeof value!=="string"||!/^[a-z][a-z0-9-]{0,47}$/.test(value))throw new Error("Use identifiers starting with a lowercase letter, followed by up to 47 lowercase letters, digits or hyphens.");
  return value;
}
function text(value:unknown,limit:number,label:string):string {
  if(typeof value!=="string"||!value.trim()||value.length>limit||[...value].some(char=>{const code=char.charCodeAt(0);return code<32&&![9,10,13].includes(code)||code>=127&&code<=159;}))throw new Error("Provide "+label+" of at most "+limit+" characters.");
  return value.trim();
}
function coordinate(value:unknown):number {
  if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0||value>10000)throw new Error("Subject coordinates must be integers from 0 to 10000.");
  return value;
}
export function subjectMotionPlan(input:unknown):SubjectMotionPlan {
  const value=record(input,["schema","source","prompt","seed","subjects"],"subject motion");
  if(value.schema!=="hv-subject-motion/1")throw new Error("Use hv-subject-motion/1.");
  const source=record(value.source,["sha256","width","height"],"source image");
  if(typeof source.sha256!=="string"||!/^[a-f0-9]{64}$/.test(source.sha256)||!((source.width===832&&source.height===480)||(source.width===480&&source.height===832)))
    throw new Error("Bind an exact 832×480 or 480×832 PNG by its SHA-256. Prepare the image before placing points.");
  if(typeof value.seed!=="number"||!Number.isSafeInteger(value.seed)||value.seed<0||value.seed>2147483647)throw new Error("Choose a seed from 0 to 2147483647.");
  if(!Array.isArray(value.subjects)||value.subjects.length<1||value.subjects.length>6)throw new Error("Identify one to six subjects.");
  const ids=new Set<string>(),origins=new Set<string>();
  const subjects=value.subjects.map(input=>{
    const subject=record(input,["id","label","tracks"],"subject"),id=identifier(subject.id);
    if(ids.has(id))throw new Error("Subject identifiers must be distinct.");ids.add(id);
    if(!Array.isArray(subject.tracks)||subject.tracks.length<1||subject.tracks.length>8)throw new Error("Place one to eight tracks on each subject.");
    const trackIds=new Set<string>();
    const tracks=subject.tracks.map(input=>{
      const track=record(input,["id","keyframes"],"point track"),trackId=identifier(track.id);
      if(trackIds.has(trackId))throw new Error("Track identifiers must be distinct within each subject.");trackIds.add(trackId);
      if(!Array.isArray(track.keyframes)||track.keyframes.length<2||track.keyframes.length>21)throw new Error("Use two to 21 keyframes per track.");
      let previous=-1;
      const keyframes=track.keyframes.map(input=>{
        const frame=record(input,["frame","x","y","easing","visible"],"subject keyframe");
        if(typeof frame.frame!=="number"||!Number.isSafeInteger(frame.frame)||frame.frame<0||frame.frame>80||frame.frame%SUBJECT_MOTION_STRIDE!==0||frame.frame<=previous)
          throw new Error("Place increasing keyframes on frames 0, 4, 8, …, 80; the native model samples every fourth frame.");
        previous=frame.frame;
        if(!["linear","smooth"].includes(frame.easing as string)||typeof frame.visible!=="boolean")throw new Error("Choose linear or smooth easing and explicit visibility.");
        return {frame:frame.frame,x:coordinate(frame.x),y:coordinate(frame.y),easing:frame.easing as SubjectMotionKeyframe["easing"],visible:frame.visible};
      });
      if(keyframes[0]!.frame!==0||keyframes.at(-1)!.frame!==80||!keyframes[0]!.visible)throw new Error("Each track must begin visibly at frame 0 and end at frame 80.");
      const first=keyframes[0]!,origin=JSON.stringify([first.x,first.y]);
      if(origins.has(origin))throw new Error("Each track must identify a different point in the source image.");origins.add(origin);
      return {id:trackId,keyframes};
    });
    return {id,label:text(subject.label,80,"a subject label"),tracks};
  });
  return {schema:"hv-subject-motion/1",source:{sha256:source.sha256,width:source.width as number,height:source.height as number},prompt:text(value.prompt,2000,"a motion prompt"),seed:value.seed,subjects};
}
export function subjectMotionRevision(input:unknown):string {return contentHash(subjectMotionPlan(input));}
/** Pure sampling after validation. Easing belongs to the outgoing segment; visibility is held until the next knot. */
export function sampleSubjectTrack(track:SubjectMotionTrack,frame:number):{x:number;y:number;visible:boolean} {
  if(!Number.isSafeInteger(frame)||frame<0||frame>=SUBJECT_MOTION_FRAMES)throw new Error("Choose a frame from 0 to 80.");
  let index=0;while(index+1<track.keyframes.length&&track.keyframes[index+1]!.frame<=frame)index++;
  const left=track.keyframes[index]!,right=track.keyframes[index+1];
  if(!right)return {x:left.x,y:left.y,visible:left.visible};
  const t=(frame-left.frame)/(right.frame-left.frame),amount=left.easing==="smooth"?t*t*(3-2*t):t;
  return {x:left.x+(right.x-left.x)*amount,y:left.y+(right.y-left.y)*amount,visible:left.visible};
}
