import {mountEditorialPreview} from './preview-controller.js';

/** A display clock, never an editable or flattened copy of the parent composition. */
export function assemblyPreviewView(detail){
  if(!detail)return null;const item=detail.item,parent=item?.parent;
  if(!item||typeof item.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(item.id)||![item.revision,item.planRevision].every(revision=>typeof revision==='string'&&/^[a-f0-9]{64}$/.test(revision))||!Number.isSafeInteger(item.frames)||item.frames<1||item.frames>108000||![parent?.width,parent?.height].every(value=>Number.isSafeInteger(value)&&value>=2&&value%2===0)||parent.width>1920||parent.height>1080)throw new Error('Load a valid saved assembly before previewing.');
  return {assemblyPreview:{id:item.id,revision:item.revision,planRevision:item.planRevision,kind:item.acceptedAt?'accepted':'proposals'},timeline:{schema:'hv-edit-assembly-preview-view/1',revision:item.planRevision,frames:item.frames,width:parent.width,height:parent.height}};
}
export function mountEditAssemblyPreview({parent,client,current}){
  const preview=mountEditorialPreview({parent,client,current,assembly:true});
  return {...preview,bind:detail=>preview.bind(assemblyPreviewView(detail))};
}
