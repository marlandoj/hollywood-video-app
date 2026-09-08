import {EDIT_COMPOSITE_LIMITS as limits} from '../../planner/src/edit-composite-types';
import {editMaskGeometry} from '../../planner/src/edit-composite-sampling';

const clone=value=>structuredClone(value);
export const emptyComposite=()=>({schema:'hv-edit-composite/1'});
export function newMask(kind,source,sourceFrame,id=()=>crypto.randomUUID()){
  if(!['rectangle','ellipse','polygon'].includes(kind))throw new Error('Choose a rectangle, ellipse or polygon.');
  const geometry=kind==='polygon'?{points:[[16384,16384],[49152,16384],[49152,49152],[16384,49152]].map(([xQ16,yQ16])=>({id:id(),xQ16,yQ16}))}:{xQ16:16384,yQ16:16384,widthQ16:32768,heightQ16:32768};
  return {id:id(),label:kind==='polygon'?'Subject outline':kind==='ellipse'?'Ellipse mask':'Rectangle mask',sourceRevision:source.revision,kind,combine:'replace',invert:false,featherQ8:0,keyframes:[{sourceFrame,interpolation:'linear',geometry}]};
}
export function setMaskKey(mask,sourceFrame,geometry,interpolation='linear'){
  const output=clone(mask),at=output.keyframes.findIndex(k=>k.sourceFrame===sourceFrame),key={sourceFrame,interpolation,geometry:clone(geometry)};
  if(at<0){if(output.keyframes.length>=limits.keyframes)throw new Error('Remove a keyframe before adding another. This mask supports up to '+limits.keyframes+'.');output.keyframes.push(key);output.keyframes.sort((a,b)=>a.sourceFrame-b.sourceFrame);}else output.keyframes[at]=key;
  return output;
}
export function deleteMaskKey(mask,sourceFrame){if(mask.keyframes.length===1)throw new Error('Keep at least one keyframe, or remove the whole mask.');const output=clone(mask);output.keyframes=output.keyframes.filter(k=>k.sourceFrame!==sourceFrame);return output;}
export function editPolygonTopology(mask,pointId,action,newId=crypto.randomUUID()){
  if(mask.kind!=='polygon')throw new Error('Select a polygon mask first.');const count=mask.keyframes[0].geometry.points.length,index=mask.keyframes[0].geometry.points.findIndex(p=>p.id===pointId);
  if(index<0)throw new Error('Select a polygon vertex.');if(action==='insert'&&count>=limits.vertices)throw new Error('A polygon supports up to '+limits.vertices+' vertices.');if(action==='remove'&&count<=3)throw new Error('A polygon needs at least three vertices.');
  if(!['insert','remove'].includes(action))throw new Error('Choose insert or remove vertex.');
  const output=clone(mask);for(const key of output.keyframes){const points=key.geometry.points;if(points[index]?.id!==pointId)throw new Error('The polygon vertex order changed between keyframes.');if(action==='remove')points.splice(index,1);else{const a=points[index],b=points[(index+1)%points.length];points.splice(index+1,0,{id:newId,xQ16:Math.round((a.xQ16+b.xQ16)/2),yQ16:Math.round((a.yQ16+b.yQ16)/2)});}}return output;
}
export function reorderMask(masks,id,direction){const output=clone(masks),index=output.findIndex(m=>m.id===id),next=index+direction;if(index<0||next<0||next>=output.length)return output;[output[index],output[next]]=[output[next],output[index]];output[0].combine='replace';return output;}
export function maskGeometryAt(mask,frame){return clone(editMaskGeometry(mask,frame));}
export function maskDraftKey(projectId,sequenceId,clipId){return 'hv-mask-draft:'+projectId+':'+sequenceId+':'+clipId;}
export function maskDraftRecord(saved,clip,composite,frame,selectedMask,selectedVertex){const source=saved.timeline.sources.find(s=>s.id===clip.sourceId);return {schema:'hv-mask-draft/1',sequenceId:saved.sequence.id,clipId:clip.id,sourceId:source.id,sourceRevision:source.revision,historyRevision:saved.sequence.history.revision,composite:clone(composite),frame,selectedMask,selectedVertex};}
export function inspectMaskDraft(record,saved,clip){
  if(!record||record.schema!=='hv-mask-draft/1'||record.sequenceId!==saved.sequence.id||record.clipId!==clip.id||!record.composite||record.composite.schema!=='hv-edit-composite/1')return 'invalid';
  const source=saved.timeline.sources.find(s=>s.id===clip.sourceId);if(record.sourceId!==source.id||record.sourceRevision!==source.revision)return 'source-changed';
  return record.historyRevision===saved.sequence.history.revision?'current':'stale';
}
