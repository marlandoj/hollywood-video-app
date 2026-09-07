import {previewPicture} from '../../planner/src/edit-preview-render';
/** Draw each source before releasing it, so dense overlaps do not require every decoded image in memory. */
export async function composePreviewFrame(timeline,frame,context,surface,lookup){
  const layers=previewPicture(timeline,frame),width=context.canvas.width,height=context.canvas.height,layerContext=surface.getContext('2d',{alpha:false});
  if(surface.width!==width||surface.height!==height)throw new Error('Preview composition dimensions changed.');
  context.save();
  try{
    context.globalAlpha=1;context.globalCompositeOperation='source-over';context.fillStyle='#000';context.fillRect(0,0,width,height);
    for(const {clip,sourceFrame,alpha}of layers){
      const image=await lookup(clip.sourceId,sourceFrame),source=timeline.sources.find(s=>s.id===clip.sourceId);
      if(!image||!source)throw new Error('Preview source changed.');
      const crop=clip.crop??{x:0,y:0,width:source.width,height:source.height},scale=Math.min(width/crop.width,height/crop.height),fittedWidth=crop.width*scale,fittedHeight=crop.height*scale;
      layerContext.globalAlpha=1;layerContext.globalCompositeOperation='source-over';layerContext.fillStyle='#000';layerContext.fillRect(0,0,width,height);
      layerContext.drawImage(image,crop.x*image.width/source.width,crop.y*image.height/source.height,crop.width*image.width/source.width,crop.height*image.height/source.height,(width-fittedWidth)/2,(height-fittedHeight)/2,fittedWidth,fittedHeight);
      context.globalAlpha=alpha/255;context.drawImage(surface,0,0);
    }
  }finally{context.restore();}
}
