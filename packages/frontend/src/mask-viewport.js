import {EDIT_COMPOSITE_LIMITS as limits} from '../../planner/src/edit-composite-types';

const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));

/**
 * How far one arrow-key press moves a handle, in source pixels.
 *
 * Declared once because it is stated in three places that have to agree: the
 * keydown handler that implements it, this viewport's accessible name, and the
 * mask editor's own instructions paragraph. All three read it from here.
 */
export const MASK_STEP_PIXELS={normal:1,shift:10,alt:.1};
const plural=n=>n===1?'1 pixel':n+' pixels';
/** The instruction sentence, in the words the name and the editor both use. */
export const MASK_STEP_SENTENCE='Arrow keys move '+plural(MASK_STEP_PIXELS.normal)
  +'; Shift moves '+plural(MASK_STEP_PIXELS.shift)+'; Alt moves '+plural(MASK_STEP_PIXELS.alt)+'.';
/**
 * How the keyboard chooses a handle. HV-039-22: before this, only a pointer could (`pointerdown`
 * set `selectedHandle`), so the arrow keys moved whichever handle the mouse had last chosen -- the
 * whole shape, unless a pointer had picked a corner -- while this viewport's name told a keyboard
 * user to "select a handle". Stated once, for the name and the editor's paragraph.
 */
export const MASK_HANDLE_SENTENCE='Space selects the next handle; Shift+Space selects the previous one.';
export const MASK_VIEWPORT_LABEL='Mask shape editor. '+MASK_HANDLE_SENTENCE+' '+MASK_STEP_SENTENCE;
const HANDLE_NAMES={nw:'Top-left corner',ne:'Top-right corner',sw:'Bottom-left corner',se:'Bottom-right corner',move:'Whole shape'};

/** Source-space viewport. Only geometry drafts change here; saved preview identities never do. */
export function mountMaskViewport({parent,source,onGeometry,onVertex,onError,canChange}){
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d'),caption=document.createElement('p'),announcement=document.createElement('p');canvas.width=640;canvas.height=Math.max(2,Math.round(640*source.height/source.width));canvas.className='mask-viewport';canvas.tabIndex=0;canvas.setAttribute('aria-label',MASK_VIEWPORT_LABEL);
  // Not `role="img"`. This canvas is focusable and operated with the arrow
  // keys, so calling it an image told assistive technology that a widget was a
  // static picture -- WCAG 4.1.2 -- and pruned it from the accessibility tree,
  // which is also why nothing could report which handle was selected.
  //
  // `application` is the narrowest role that works: it is the one role that
  // reliably makes a screen reader hand the arrow keys to the widget instead of
  // consuming them for browse-mode navigation. Dropping the role entirely would
  // have left the widget named and focusable but keyboard-inoperable under a
  // screen reader.
  //
  // It is not free, and the cost is worth naming rather than waving away: a
  // canvas's fallback content *is* its accessible subtree, and that is the
  // standard route to exposing canvas-drawn handles as real focusable children
  // (`role="slider"` per handle, with `aria-valuenow`). `application`
  // forecloses that route for as long as it is here. It is accepted because
  // that handle tree does not exist yet and the arrow keys have to work today.
  //
  // So name comes from `aria-label`, description from the caption, and value
  // entirely from the live region below -- which is a *sibling*, outside the
  // application element, or it would be pruned with everything else inside.
  canvas.setAttribute('role','application');
  const captionId='mask-view-caption-'+crypto.randomUUID();caption.id=captionId;caption.className='mask-view-caption';canvas.setAttribute('aria-describedby',captionId);
  // The caption is rewritten on every paint, including on every pointermove, so
  // it cannot be the live region: it would announce during a drag. State is
  // announced here instead, only on discrete changes and never twice running
  // with the same text.
  announcement.className='mask-view-announcement';announcement.setAttribute('aria-live','polite');
  parent.append(canvas,caption,announcement);
  let image=null,coverage=null,geometry=null,kind=null,selectedVertex=null,selectedHandle='move',mode='source',drag=null,drawMode=false,frame=0,drawingPoints=[],drawOriginal=null;
  const xy=(xQ16,yQ16)=>[xQ16/65536*canvas.width,yQ16/65536*canvas.height];
  let announced=null;
  const round=value=>Math.round(value*10)/10;
  /** The selected handle and where it now sits, in the source pixels the coordinate fields use. */
  function announce(){
    const id=kind==='polygon'?selectedVertex:selectedHandle,list=handles(),handle=list.find(h=>h.id===id);
    if(!geometry||!handle){if(announced!==''){announced='';announcement.textContent='';}return;}
    const name=kind==='polygon'?'Vertex '+(list.findIndex(h=>h.id===id)+1)+' of '+list.length:HANDLE_NAMES[id]??'Handle',
      text=name+' at source pixel '+round(handle.x/65536*source.width)+', '+round(handle.y/65536*source.height)+'.';
    if(text===announced)return;announced=text;announcement.textContent=text;
  }
  const handles=()=>!geometry?[]:kind==='polygon'?geometry.points.map(p=>({id:p.id,x:p.xQ16,y:p.yQ16})):[{id:'nw',x:geometry.xQ16,y:geometry.yQ16},{id:'ne',x:geometry.xQ16+geometry.widthQ16,y:geometry.yQ16},{id:'sw',x:geometry.xQ16,y:geometry.yQ16+geometry.heightQ16},{id:'se',x:geometry.xQ16+geometry.widthQ16,y:geometry.yQ16+geometry.heightQ16},{id:'move',x:geometry.xQ16+geometry.widthQ16/2,y:geometry.yQ16+geometry.heightQ16/2}];
  function paint(){
    context.clearRect(0,0,canvas.width,canvas.height);const size=16;for(let y=0;y<canvas.height;y+=size)for(let x=0;x<canvas.width;x+=size){context.fillStyle=((x/size+y/size)%2)?'#3a4048':'#252a31';context.fillRect(x,y,size,size);}
    if(mode==='coverage'){if(coverage)context.drawImage(coverage,0,0,canvas.width,canvas.height);}else if(image)context.drawImage(image,0,0,canvas.width,canvas.height);
    if(geometry){context.strokeStyle='#f2c76c';context.fillStyle='rgba(242,199,108,.10)';context.lineWidth=2;context.beginPath();if(kind==='polygon'){for(const [i,p]of geometry.points.entries()){const [x,y]=xy(p.xQ16,p.yQ16);if(i)context.lineTo(x,y);else context.moveTo(x,y);}context.closePath();}else{const [x,y]=xy(geometry.xQ16,geometry.yQ16),[w,h]=xy(geometry.widthQ16,geometry.heightQ16);if(kind==='ellipse')context.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);else context.rect(x,y,w,h);}context.fill();context.stroke();const rect=canvas.getBoundingClientRect(),radius=5*canvas.width/Math.max(1,rect.width);for(const handle of handles()){const [x,y]=xy(handle.x,handle.y);context.beginPath();context.arc(x,y,radius,0,Math.PI*2);context.fillStyle=handle.id===(kind==='polygon'?selectedVertex:selectedHandle)?'#fff':'#f2c76c';context.fill();context.strokeStyle='#111';context.stroke();}}
    if(drawMode&&kind==='polygon'&&drawingPoints.length){context.beginPath();drawingPoints.forEach((p,i)=>{const [x,y]=xy(p.xQ16,p.yQ16);if(i)context.lineTo(x,y);else context.moveTo(x,y);});context.strokeStyle='#fff';context.lineWidth=3;context.stroke();}caption.textContent=(mode==='coverage'?'Draft authored-mask coverage':'Original source with draft mask outline')+' · source frame '+frame+'. '+(drawMode?(kind==='polygon'?'Click vertices, then choose Finish polygon or press Enter. Escape cancels. ':'Drag to redraw this '+kind+'. '):'')+'Save masks and mattes before reviewing the final composite.';
  }
  const point=event=>{const rect=canvas.getBoundingClientRect();return {xQ16:clamp(Math.round((event.clientX-rect.left)/rect.width*65536),limits.coordinateMinQ16,limits.coordinateMaxQ16),yQ16:clamp(Math.round((event.clientY-rect.top)/rect.height*65536),limits.coordinateMinQ16,limits.coordinateMaxQ16)};};
  function changed(next){try{onGeometry(next);geometry=next;paint();}catch(error){onError(error.message);}}
  function move(start,dx,dy,handle){const next=structuredClone(start),bounded=(v)=>clamp(Math.round(v),limits.coordinateMinQ16,limits.coordinateMaxQ16);if(kind==='polygon'){const p=next.points.find(p=>p.id===handle);if(!p)return next;p.xQ16=bounded(p.xQ16+dx);p.yQ16=bounded(p.yQ16+dy);return next;}if(handle==='move'){next.xQ16=clamp(next.xQ16+dx,limits.coordinateMinQ16,limits.coordinateMaxQ16-next.widthQ16);next.yQ16=clamp(next.yQ16+dy,limits.coordinateMinQ16,limits.coordinateMaxQ16-next.heightQ16);return next;}let left=next.xQ16,right=left+next.widthQ16,top=next.yQ16,bottom=top+next.heightQ16;if(handle.includes('w'))left=Math.min(right-1,bounded(left+dx));if(handle.includes('e'))right=Math.max(left+1,bounded(right+dx));if(handle.includes('n'))top=Math.min(bottom-1,bounded(top+dy));if(handle.includes('s'))bottom=Math.max(top+1,bounded(bottom+dy));return {xQ16:left,yQ16:top,widthQ16:right-left,heightQ16:bottom-top};}
  canvas.addEventListener('pointerdown',event=>{if(!geometry||!canChange()||event.button>0)return;event.preventDefault();canvas.focus();const at=point(event),rect=canvas.getBoundingClientRect();if(drawMode&&kind==='polygon'){if(drawingPoints.length>=limits.vertices){onError('Finish the polygon at up to 64 vertices.');return;}drawingPoints.push({id:crypto.randomUUID(),...at});paint();return;}if(drawMode&&kind!=='polygon'){drag={start:at,geometry:structuredClone(geometry),handle:'draw'};}else{const candidates=handles().map(h=>({...h,d:Math.hypot((h.x-at.xQ16)/65536*rect.width,(h.y-at.yQ16)/65536*rect.height)})).sort((a,b)=>a.d-b.d),hit=candidates[0];if(!hit||hit.d>22)return;selectedHandle=hit.id;if(kind==='polygon'){selectedVertex=hit.id;onVertex(hit.id);}drag={start:at,geometry:structuredClone(geometry),handle:hit.id};announce();}canvas.setPointerCapture(event.pointerId);paint();});
  canvas.addEventListener('pointermove',event=>{if(!drag||!canChange())return;const at=point(event),dx=at.xQ16-drag.start.xQ16,dy=at.yQ16-drag.start.yQ16;if(drag.handle==='draw'){geometry={xQ16:Math.min(at.xQ16,drag.start.xQ16),yQ16:Math.min(at.yQ16,drag.start.yQ16),widthQ16:Math.max(1,Math.abs(dx)),heightQ16:Math.max(1,Math.abs(dy))};paint();}else changed(move(drag.geometry,dx,dy,drag.handle));});
  /** HV-039-22: the keyboard's way to choose a corner, the whole shape or a vertex, in the order `handles()` lists them. */
  function selectNext(step){const list=handles(),current=kind==='polygon'?selectedVertex:selectedHandle,at=list.findIndex(h=>h.id===current),next=list[((at<0?(step>0?-1:0):at)+step+list.length)%list.length];if(!next)return;
    if(kind==='polygon'){selectedVertex=next.id;onVertex(next.id);}else selectedHandle=next.id;paint();announce();}
  const finish=()=>{if(!drag)return;const authored=drag.handle==='draw',result=geometry;if(authored&&drawOriginal)geometry=drawOriginal;drag=null;drawMode=false;drawOriginal=null;if(authored)changed(result);else paint();announce();};function cancelDrawing(){if(drawOriginal)geometry=drawOriginal;drag=null;drawMode=false;drawOriginal=null;drawingPoints=[];paint();}function finishPolygon(){if(!drawMode||kind!=='polygon')return;if(drawingPoints.length<3)throw new Error('Place at least three polygon vertices first.');const next={points:structuredClone(drawingPoints)};drawingPoints=[];drawMode=false;drawOriginal=null;changed(next);}canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',()=>{if(drawMode)cancelDrawing();else finish();});
  canvas.addEventListener('keydown',event=>{if(drawMode&&event.key==='Escape'){event.preventDefault();cancelDrawing();return;}if(drawMode&&kind==='polygon'&&event.key==='Enter'&&canChange()){event.preventDefault();try{finishPolygon();}catch(error){onError(error.message);}return;}if(event.key===' '&&!drawMode&&geometry&&canChange()){event.preventDefault();selectNext(event.shiftKey?-1:1);return;}if(!geometry||!canChange()||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const distance=event.shiftKey?MASK_STEP_PIXELS.shift:event.altKey?MASK_STEP_PIXELS.alt:MASK_STEP_PIXELS.normal,dx=(event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0)*Math.round(distance/source.width*65536),dy=(event.key==='ArrowDown'?1:event.key==='ArrowUp'?-1:0)*Math.round(distance/source.height*65536);changed(move(geometry,dx,dy,kind==='polygon'?selectedVertex:selectedHandle));announce();});
  return {canvas,caption,announcement,set(value){({geometry,kind,selectedVertex,mode,frame}=value);coverage=value.coverage??null;paint();announce();},image(bitmap){image=bitmap;paint();},draw(){drawOriginal=structuredClone(geometry);drawMode=true;drawingPoints=[];canvas.focus();paint();},cancelDrawing,finishPolygon,get drawing(){return drawMode;},dispose(){drag=null;image=null;coverage=null;}};
}
