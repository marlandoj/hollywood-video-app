import {previewPicture} from '../../planner/src/edit-preview-render';
import {editRgbaGroups,editRgbaNeeded} from '../../planner/src/edit-rgba';
import {editCompositeNeeded} from '../../planner/src/edit-composite';
const pairSurfaces=new WeakMap();
/** Draw each source before releasing it, so dense overlaps do not require every decoded image in memory. */
export async function composePreviewFrame(timeline,frame,context,surface,lookup){
  if(editCompositeNeeded(timeline)){const image=await lookup('timeline-picture',frame);if(!image)throw new Error('The saved effect composition is unavailable.');context.save();try{context.globalAlpha=1;context.globalCompositeOperation='source-over';context.fillStyle='#000';context.fillRect(0,0,context.canvas.width,context.canvas.height);context.drawImage(image,0,0,context.canvas.width,context.canvas.height);}finally{context.restore();}return;}
  const layers=previewPicture(timeline,frame),width=context.canvas.width,height=context.canvas.height,layerContext=surface.getContext('2d',{alpha:true}),native=editRgbaNeeded({sources:timeline.sources??[]},layers.map(l=>l.clip)),groups=native?editRgbaGroups(layers.map(l=>l.clip),frame):layers.map(l=>[l]);let pairSurface,pairContext;
  if(surface.width!==width||surface.height!==height)throw new Error('Preview composition dimensions changed.');
  context.save();
  try{
    context.globalAlpha=1;context.globalCompositeOperation='source-over';context.fillStyle='#000';context.fillRect(0,0,width,height);
    for(const group of groups){
      if(group.length===2){if(!pairSurface){pairSurface=pairSurfaces.get(surface);if(!pairSurface){pairSurface=surface.ownerDocument?.createElement('canvas')??new OffscreenCanvas(width,height);pairSurfaces.set(surface,pairSurface);}if(pairSurface.width!==width)pairSurface.width=width;if(pairSurface.height!==height)pairSurface.height=height;pairContext=pairSurface.getContext('2d',{alpha:true});}pairContext.clearRect(0,0,width,height);}
      for(const {clip,alpha}of group){
      const sourceFrame=layers.find(l=>l.clip.id===clip.id).sourceFrame;
      const image=await lookup(clip.sourceId,sourceFrame),source=timeline.sources.find(s=>s.id===clip.sourceId);
      if(!image||!source)throw new Error('Preview source changed.');
      const crop=clip.crop??{x:0,y:0,width:source.width,height:source.height},scale=Math.min(width/crop.width,height/crop.height),fittedWidth=crop.width*scale,fittedHeight=crop.height*scale;
      layerContext.globalAlpha=1;layerContext.globalCompositeOperation='source-over';if(source.media==='graphic-rgba')layerContext.clearRect(0,0,width,height);else{layerContext.fillStyle='#000';layerContext.fillRect(0,0,width,height);}
      layerContext.drawImage(image,crop.x*image.width/source.width,crop.y*image.height/source.height,crop.width*image.width/source.width,crop.height*image.height/source.height,(width-fittedWidth)/2,(height-fittedHeight)/2,fittedWidth,fittedHeight);
      if(group.length===2){pairContext.globalAlpha=alpha/255;pairContext.globalCompositeOperation='lighter';pairContext.drawImage(surface,0,0);}else{context.globalAlpha=alpha/255;context.drawImage(surface,0,0);}
      }
      if(group.length===2){context.globalAlpha=1;context.drawImage(pairSurface,0,0);}
    }
  }finally{context.restore();}
}
