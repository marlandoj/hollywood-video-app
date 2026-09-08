import {contentHash} from "../../generator/src/capabilities";
import {pictureSpans} from "../../generator/src/edit-picture";
import {validateEditAssemblyPlan} from "./edit-assembly-clock";
import type {EditAssemblyPlan} from "./edit-assembly-types";
import {editStorageEstimate,assertEditStorageEstimate} from "./edit-resources";
import {EDIT_AUDIO_LANES,editFail,editNumber,editRecord} from "./edit-timeline";

export type EditAssemblyStorageBinding=Parameters<typeof editStorageEstimate>[1][number];
/** Ownership, receipt seals and live availability are checked by validateEditBinding at admission. */
function validateBindings(plan:EditAssemblyPlan,bindings:EditAssemblyStorageBinding[]):void {
  const sources=plan.parent.timeline.sources;
  if(!Array.isArray(bindings)||bindings.length!==sources.length)editFail("Assembly capacity requires every retained parent source binding.");
  for(const [i,binding]of bindings.entries()){
    const source=binding?.source;if(!source||contentHash(source.facts)!==contentHash(sources[i]))editFail("Assembly capacity requires exact parent source facts in canonical source order.");
    if(!Array.isArray(source.files)||!source.files.length||source.files.length>30000)editFail("Retain a bounded original file inventory for assembly capacity.");
    const paths=new Set<string>();for(const file of source.files){
      editRecord(file,["path","bytes","sha256"]);editNumber(file.bytes,1,8*1024**3,"Retained assembly artifact bytes");
      if(typeof file.path!=="string"||file.path.length>1024||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(part=>!part||part==="."||part==="..")||paths.has(file.path)||typeof file.sha256!=="string"||!/^[a-f0-9]{64}$/.test(file.sha256))editFail("Retain distinct original artifact paths and hashes for assembly capacity.");paths.add(file.path);
    }
    const audio=editRecord(source.audio,[...EDIT_AUDIO_LANES]);
    if(contentHash(Object.keys(audio).sort())!==contentHash(sources[i]!.audio.slice().sort()))editFail("Assembly capacity lost a retained canonical sound lane.");
    for(const input of Object.values(source.audio)){
      if(!input||!["copy48","decode","film-dialogue"].includes(input.kind))editFail("Retain a supported canonical audio input for assembly capacity.");
      editRecord(input,input.kind==="film-dialogue"?["kind"]:["kind","path"]);if(input.kind!=="film-dialogue"&&(typeof input.path!=="string"||!paths.has(input.path)))editFail("Assembly capacity lost an original waveform artifact.");
    }
  }
}
/** Full parent originals and scratch recipes remain retained; only emitted media follows child time. */
export function editAssemblyStorageEstimate(plan:EditAssemblyPlan,bindings:EditAssemblyStorageBinding[]){
  const valid=validateEditAssemblyPlan(plan);validateBindings(valid,bindings);const parent=valid.parent.timeline,base=editStorageEstimate(parent,bindings),spans=pictureSpans(parent);
  let parts=0;for(const range of valid.ranges)for(const span of spans)if(Math.max(range.fromFrame,span.at)<Math.min(range.toFrame,span.at+span.frames))parts++;
  const laneBytes=7*(44+valid.frames*1600*6),pictureBytes=valid.frames*parent.width*parent.height*3,deliveryBytes=pictureBytes,outputBytes=base.originalBytes+base.canonicalBytes+laneBytes+pictureBytes+deliveryBytes+base.metadataBytes;
  const workspaceBytes=outputBytes*3+(base.retimingScratchBytes??0)+(base.rgbaScratchBytes??0)+(base.compositeScratchBytes??0),files=base.files-spans.length-Math.ceil(parent.frames/30)+parts+Math.ceil(valid.frames/30);
  for(const value of [base.originalBytes,base.canonicalBytes,laneBytes,pictureBytes,deliveryBytes,outputBytes,workspaceBytes,files])if(!Number.isSafeInteger(value)||value<0)editFail("Assembly capacity exceeds exact accounting bounds.");
  return {...base,schema:"hv-edit-assembly-resources/1" as const,planRevision:valid.revision,parentFrames:parent.frames,childFrames:valid.frames,parts,laneBytes,pictureBytes,deliveryBytes,outputBytes,workspaceBytes,files,limits:{...base.limits}};
}
export function assertEditAssemblyStorageEstimate(estimate:ReturnType<typeof editAssemblyStorageEstimate>):void {assertEditStorageEstimate(estimate);}
