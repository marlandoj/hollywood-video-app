import type {EditMask,EditMaskBox,EditMaskPoint} from "./edit-composite-types";
export type EditMaskGeometry=EditMaskBox|{points:EditMaskPoint[]};
export type EditCompositeCheckpoint=()=>Promise<void>;
/** Keys belong to original decoded source frames; each key controls its outgoing segment. */
export function editMaskGeometry(mask:EditMask,sourceFrame:number):EditMaskGeometry{
  const keys=mask.keyframes;let index=0;while(index+1<keys.length&&keys[index+1]!.sourceFrame<=sourceFrame)index++;
  const left=keys[index]!,right=keys[index+1],u=sourceFrame<=left.sourceFrame||!right||left.interpolation==="hold"?0:(sourceFrame-left.sourceFrame)/(right.sourceFrame-left.sourceFrame),value=(a:number,b:number)=>Math.round(a+(b-a)*u);
  if("points"in left.geometry){const points=left.geometry.points,other=right&&"points"in right.geometry?right.geometry.points:points;return {points:points.map((p,i)=>({id:p.id,xQ16:value(p.xQ16,other[i]!.xQ16),yQ16:value(p.yQ16,other[i]!.yQ16)}))};}
  const a=left.geometry,b=right&&!("points"in right.geometry)?right.geometry:a;return {xQ16:value(a.xQ16,b.xQ16),yQ16:value(a.yQ16,b.yQ16),widthQ16:value(a.widthQ16,b.widthQ16),heightQ16:value(a.heightQ16,b.heightQ16)};
}
/** Four samples per axis, half-open even/odd scanlines; feather sees geometry beyond the source edge. */
function* maskSteps(mask:EditMask,sourceFrame:number,width:number,height:number):Generator<void,Uint8Array>{
  const radius=Math.floor(mask.featherQ8/256),fraction=mask.featherQ8%256,pad=radius+(fraction?1:0),w=width+pad*2,h=height+pad*2,coverage=new Uint8Array(w*h),geometry=editMaskGeometry(mask,sourceFrame),polygon="points"in geometry?geometry.points.map(p=>({x:p.xQ16*width/65536,y:p.yQ16*height/65536})):null,box="points"in geometry?null:{x:geometry.xQ16*width/65536,y:geometry.yQ16*height/65536,w:geometry.widthQ16*width/65536,h:geometry.heightQ16*height/65536};
  for(let sy=0;sy<h*4;sy++){
    const y=(sy+.5)/4-pad,intersections:number[]=[];
    if(polygon){for(let i=0;i<polygon.length;i++){const a=polygon[i]!,b=polygon[(i+1)%polygon.length]!;if(y>=Math.min(a.y,b.y)&&y<Math.max(a.y,b.y))intersections.push(a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y));}intersections.sort((a,b)=>a-b);}
    else if(box&&y>=box.y&&y<box.y+box.h){if(mask.kind==="rectangle")intersections.push(box.x,box.x+box.w);else{const delta=(y-box.y-box.h/2)/(box.h/2),half=box.w/2*Math.sqrt(Math.max(0,1-delta*delta));intersections.push(box.x+box.w/2-half,box.x+box.w/2+half);}}
    const row=Math.floor(sy/4)*w;
    for(let i=0;i+1<intersections.length;i+=2){const begin=Math.max(0,Math.ceil((intersections[i]!+pad)*4-.5)),end=Math.min(w*4,Math.ceil((intersections[i+1]!+pad)*4-.5));for(let x=begin;x<end;){const pixel=Math.floor(x/4),stop=Math.min(end,(pixel+1)*4);coverage[row+pixel]!+=stop-x;x=stop;}}
    if(sy%128===127)yield;
  }
  for(let p=0;p<coverage.length;p++){coverage[p]=Math.floor((coverage[p]!*255+8)/16);if(p%(w*32)===0)yield;}
  let filtered=coverage;
  if(mask.featherQ8){
    const horizontal=new Uint8Array(w*h),prefix=new Uint32Array(Math.max(w,h)+1),denominator=256*(2*radius+1)+2*fraction;
    for(let y=0;y<h;y++){const offset=y*w;prefix[0]=0;for(let x=0;x<w;x++)prefix[x+1]=prefix[x]!+coverage[offset+x]!;for(let x=0;x<w;x++){const start=Math.max(0,x-radius),end=Math.min(w,x+radius+1),outer=(x-radius-1>=0?coverage[offset+x-radius-1]!:0)+(x+radius+1<w?coverage[offset+x+radius+1]!:0);horizontal[offset+x]=Math.floor(((prefix[end]!-prefix[start]!)*256+outer*fraction+denominator/2)/denominator);}if(y%32===31)yield;}
    for(let x=0;x<w;x++){prefix[0]=0;for(let y=0;y<h;y++)prefix[y+1]=prefix[y]!+horizontal[y*w+x]!;for(let y=0;y<h;y++){const start=Math.max(0,y-radius),end=Math.min(h,y+radius+1),outer=(y-radius-1>=0?horizontal[(y-radius-1)*w+x]!:0)+(y+radius+1<h?horizontal[(y+radius+1)*w+x]!:0);coverage[y*w+x]=Math.floor(((prefix[end]!-prefix[start]!)*256+outer*fraction+denominator/2)/denominator);}if(x%32===31)yield;}
    filtered=new Uint8Array(width*height);for(let y=0;y<height;y++)filtered.set(coverage.subarray((y+pad)*w+pad,(y+pad)*w+pad+width),y*width);
  }
  if(mask.invert)for(let p=0;p<filtered.length;p++)filtered[p]=255-filtered[p]!;return filtered;
}
export function rasterEditMask(mask:EditMask,sourceFrame:number,width:number,height:number):Uint8Array{const steps=maskSteps(mask,sourceFrame,width,height);let step=steps.next();while(!step.done)step=steps.next();return step.value;}
export async function rasterEditMaskAsync(mask:EditMask,sourceFrame:number,width:number,height:number,checkpoint:EditCompositeCheckpoint):Promise<Uint8Array>{const steps=maskSteps(mask,sourceFrame,width,height);let step=steps.next();while(!step.done){await checkpoint();step=steps.next();}return step.value;}
function combine(target:Uint8Array,source:Uint8Array,kind:EditMask["combine"]){for(let p=0;p<target.length;p++)target[p]=kind==="replace"?source[p]!:kind==="union"?Math.max(target[p]!,source[p]!):kind==="intersect"?Math.min(target[p]!,source[p]!):Math.max(0,target[p]!-source[p]!);}
export function rasterEditMasks(masks:EditMask[],sourceFrame:number,width:number,height:number):Uint8Array{const target=new Uint8Array(width*height);target.fill(255);for(const mask of masks)combine(target,rasterEditMask(mask,sourceFrame,width,height),mask.combine);return target;}
export async function rasterEditMasksAsync(masks:EditMask[],sourceFrame:number,width:number,height:number,checkpoint:EditCompositeCheckpoint):Promise<Uint8Array>{const target=new Uint8Array(width*height);target.fill(255);for(const mask of masks){combine(target,await rasterEditMaskAsync(mask,sourceFrame,width,height,checkpoint),mask.combine);await checkpoint();}return target;}
/** Rec.709 display-RGB integer luma, then alpha. Invisible RGB contributes no matte coverage. */
export function editMatteCoverage(r:number,g:number,b:number,a:number,channel:"alpha"|"luma",invert=false):number{const coverage=channel==="alpha"?a:Math.floor((Math.floor((13933*r+46871*g+4732*b+32768)/65536)*a+127)/255);return invert?255-coverage:coverage;}
