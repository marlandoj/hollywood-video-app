import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync,existsSync,copyFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {contentHash} from "../src/capabilities";
import {soundProcessingCommand} from "../src/sound-finishing";
import {conformEditPicture,conformEditAssemblyPicture,editPictureRecipe,type EditPictureResult} from "../src/edit-picture";
import {createEditAssemblyPlan} from "../../planner/src/edit-assembly-clock";
import {applyEditOperation,editTimeline,type EditClip,type EditSource,type EditTimeline} from "../../planner/src/edit-timeline";
import type {EditAssemblyRange} from "../../planner/src/edit-assembly-types";

const access=async()=>{},W=32,H=24,N=90,B=W*H*4;
const range=(id:string,fromFrame:number,toFrame:number):EditAssemblyRange=>({id,fromFrame,toFrame,reason:"Preserve the selected parent output."});
const clip=(id:string,sourceId:string,layer:number,at=0,from=0,frames=75,opacity=1):EditClip=>({id,sourceId,lane:"picture",layer,at,from,frames,link:null,gainDb:0,opacity,crop:null,envelope:{from,frames,fadeIn:0,fadeOut:0}});
const plan=(timeline:EditTimeline,ranges:EditAssemblyRange[])=>createEditAssemblyPlan({sequenceId:"parent",historyRevision:contentHash("history"),timeline,sourceReceipts:timeline.sources.map(s=>({sourceId:s.id,receiptRevision:contentHash("receipt-"+s.id)}))},ranges);
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe assembly fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function fixture(ids:string[]){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-assembly-picture-"))),sources:EditSource[]=[],paths=new Map<string,string>();
  try{for(const [index,id]of ids.entries()){
    const native=['a','b','matte'].includes(id),width=id==='narrow'?16:W,s:EditSource={id,revision:contentHash(id),label:id,frames:N,width,height:H,audio:[],captions:[],voices:[],unmeasuredAudio:false,...(native?{media:'graphic-rgba' as const}:{})},raw=Buffer.alloc(width*H*4*N);
    for(let f=0;f<N;f++)for(let y=0;y<H;y++)for(let x=0;x<width;x++){const rgba=id==='matte'?[255,255,255,f%3===0?96:220]:[(35+index*47+f*3)%256,(80+index*19+f)%256,(170+index*31+f*2)%256,native?(x<width/2?120:220):255];raw.set(rgba,(f*width*H+y*width+x)*4);}writeFileSync(join(root,id+'.raw'),raw);
    const path=join(root,id+'.mkv');await soundProcessingCommand(['ffmpeg','-v','error','-nostdin','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${H}`,'-framerate','30','-i',join(root,id+'.raw'),'-frames:v',String(N),'-an','-c:v','ffv1','-level','3','-threads','1','-pix_fmt',native?'bgra':'yuv420p',path],root,access);sources.push(s);paths.set(id,path);
  }
  return {root,sources,paths,directory(name:string){const directory=join(root,name);mkdirSync(directory);return directory;},timeline(clips:EditClip[],frames=75){return editTimeline({schema:clips.some(c=>c.composite)?'hv-edit-timeline/2':'hv-edit-timeline/1',width:W,height:H,frames,sources,clips,markers:[]});},close:()=>cleanup(root)};
  }catch(error){cleanup(root);throw error;}
}
async function decode(directory:string,picture:EditPictureResult){const output=join(directory,'decoded.raw');await soundProcessingCommand(['ffmpeg','-v','error','-nostdin','-protocol_whitelist','file,pipe','-f','concat','-safe','0','-threads','1','-i',join(directory,picture.concatFile),'-an','-c:v','rawvideo','-threads','1','-pix_fmt','rgba','-f','rawvideo',output],directory,access);return readFileSync(output);}
async function compare(f:Awaited<ReturnType<typeof fixture>>,timeline:EditTimeline,ranges:EditAssemblyRange[]){
  const before=JSON.stringify(timeline),assembly=plan(timeline,ranges),parentDirectory=f.directory('parent'),childDirectory=f.directory('child'),parent=await conformEditPicture(timeline,f.paths,parentDirectory,access),child=await conformEditAssemblyPicture(assembly,f.paths,childDirectory,access),selected=ranges.flatMap(r=>Array.from({length:r.toFrame-r.fromFrame},(_,i)=>r.fromFrame+i));
  expect(child.pictureFrames).toEqual(selected.map(frame=>parent.pictureFrames[frame]!));const parentPixels=await decode(parentDirectory,parent.picture),childPixels=await decode(childDirectory,child.picture);expect(childPixels).toEqual(Buffer.concat(selected.map(frame=>parentPixels.subarray(frame*B,(frame+1)*B))));
  expect(child.picture.parts.every(p=>p.frames<=60)).toBe(true);let at=0;for(const part of child.picture.parts){expect(part.at).toBe(at);at+=part.frames;}expect(at).toBe(assembly.frames);expect(child.frames).toBe(selected.length);
  expect(child.picture.recipe).toEqual(parent.picture.recipe);expect(child.parentRecipeRevision).toBe(contentHash(editPictureRecipe(timeline)));expect(child.parentTimelineRevision).toBe(timeline.revision);expect(child.planRevision).toBe(assembly.revision);const {revision,...data}=child;expect(revision).toBe(contentHash(data));
  expect(child.picture.sourceFrameFiles.map(s=>s.sourceId)).toEqual(parent.picture.sourceFrameFiles.map(s=>s.sourceId));for(const file of child.picture.sourceFrameFiles)expect(readFileSync(join(childDirectory,file.file))).toEqual(readFileSync(join(parentDirectory,file.file)));
  expect(JSON.stringify(timeline)).toBe(before);expect(readdirSync(childDirectory).some(name=>name.startsWith('.picture-work-'))).toBe(false);return {parent,child,childPixels};
}

test("assembly film conform preserves reordered partial odd dissolves, ramp addresses and repeated output frames",async()=>{
  const f=await fixture(['film','other']);try{
    const left=clip('left','other',1,0,5,65,.8),right=clip('right','film',1,65,40,10,.6);left.envelope.fadeOut=3;right.envelope.fadeIn=4;left.timing={from:5,offset:0,points:[{frame:0,rate:500},{frame:65,rate:1500}]};
    const t=applyEditOperation(f.timeline([clip('background','film',0),left,right]),{kind:'crossfade',leftId:'left',rightId:'right',linked:false,frames:7,alignment:'center',ids:{left:'odd-dissolve'}}),ranges=[range('fade',63,67),range('earlier',58,63),range('later',67,70),range('repeat',63,67)],{child,parent}=await compare(f,t,ranges);
    expect(parent.picture.recipe.schema).toBe('hv-edit-picture/4');expect(parent.picture.parts.map(p=>p.frames)).toEqual([60,2,7,6]);expect(child.picture.parts[0]!.at).toBe(0);expect(child.picture.parts[0]!.frames).toBe(4);expect(child.picture.parts[0]!.layers.map(l=>l.clipId)).toEqual(['background','left','right']);
    expect(child.picture.parts[0]!.layers.find(l=>l.clipId==='right')!.from).toBe(38);expect(child.picture.parts[0]!.layers.find(l=>l.clipId==='left')!.sourceFrames).toEqual([67,68,70,71]);
  }finally{f.close();}
},120000);

test("assembly native composition retains matte gaps, masks, holds and overlapping parent stacking order",async()=>{
  const f=await fixture(['film','a','b','matte']);try{
    const left=clip('left','a',1,0,5,65,.8),right=clip('right','b',1,65,40,10,.6),matte=clip('held-matte','matte',2,0,4,64),clips=[clip('background','film',0),left,right,matte,clip('late-matte','matte',2,70,40,5),clip('z-behind','a',3,0,10,75,.2),clip('a-front','b',3,2,10,70,.3)];
    left.timing={from:5,offset:0,points:[{frame:0,rate:500},{frame:65,rate:1500}]};matte.timing={from:4,offset:0,points:[{frame:0,rate:0},{frame:64,rate:0}]};
    left.composite={schema:'hv-edit-composite/1',matte:{layer:2,channel:'alpha',invert:false},masks:[{id:'mask',label:'Moving source ellipse',sourceRevision:f.sources.find(s=>s.id==='a')!.revision,kind:'ellipse',combine:'replace',invert:false,featherQ8:256,keyframes:[{sourceFrame:0,interpolation:'linear',geometry:{xQ16:0,yQ16:0,widthQ16:32768,heightQ16:65536}},{sourceFrame:89,interpolation:'hold',geometry:{xQ16:32768,yQ16:0,widthQ16:32768,heightQ16:65536}}]}]};right.composite={schema:'hv-edit-composite/1',matte:{layer:2,channel:'luma',invert:true}};
    let t=applyEditOperation(f.timeline(clips),{kind:'matte-only',layers:[2]});t=applyEditOperation(t,{kind:'crossfade',leftId:'left',rightId:'right',linked:false,frames:7,alignment:'center',ids:{left:'native-dissolve'}});
    const {child,parent}=await compare(f,t,[range('fade-and-gap',63,67),range('span-edge',59,63),range('repeat',63,67),range('opening',0,3),range('late',72,75)]);
    expect(parent.picture.recipe.schema).toBe('hv-edit-picture/6');expect(parent.picture.parts.some(p=>p.frames===60)).toBe(true);expect(child.picture.parts[0]!.layers.filter(l=>['z-behind','a-front'].includes(l.clipId)).map(l=>l.clipId)).toEqual(['z-behind','a-front']);
    expect(child.picture.parts[0]!.layers.find(l=>l.clipId==='held-matte')!.sourceFrames).toEqual([4]);expect(child.picture.parts[1]!.layers.some(l=>l.clipId==='held-matte')).toBe(false);expect(child.pictureFrames[0]).toBe(child.pictureFrames[8]);
  }finally{f.close();}
},120000);

test("off-range effects retain the parent render recipe and errors never return an assembly result",async()=>{
  const f=await fixture(['film','narrow']);try{
    const narrow=clip('narrow-picture','narrow',1,0,0,8),outside=clip('outside-effect','film',2,10,0,2);outside.composite={schema:'hv-edit-composite/1',placement:{xQ16:0,yQ16:0,scaleQ16:65536,rotationMilliDegrees:0}};
    const t=f.timeline([clip('background','film',0,0,0,12),narrow,outside],12),{child,childPixels}=await compare(f,t,[range('only-plain-clips',1,3)]);expect(child.picture.recipe.schema).toBe('hv-edit-picture/6');expect(child.picture.parts.every(p=>p.layers.every(l=>l.clipId!=='outside-effect'))).toBe(true);expect([...childPixels.subarray(0,3)].some(v=>v>20)).toBe(true);
    const assembly=plan(t,[range('selected',1,3)]),aborted=new AbortController();aborted.abort(new Error('cancel assembly'));const abortDir=f.directory('aborted');await expect(conformEditAssemblyPicture(assembly,f.paths,abortDir,access,aborted.signal)).rejects.toThrow('cancel assembly');expect(readdirSync(abortDir)).toEqual([]);
    const revokeDir=f.directory('revoked');let checks=0;await expect(conformEditAssemblyPicture(assembly,f.paths,revokeDir,async()=>{if(++checks>1)throw new Error('owner revoked');})).rejects.toThrow('owner revoked');expect(readdirSync(revokeDir).some(name=>name.startsWith('.picture-work-'))).toBe(false);
    const finalRevokeDir=f.directory('final-revoked');await expect(conformEditAssemblyPicture(assembly,f.paths,finalRevokeDir,async()=>{if(existsSync(join(finalRevokeDir,'picture/index.ffconcat')))throw new Error('owner revoked before report');})).rejects.toThrow('owner revoked before report');expect(readdirSync(finalRevokeDir).some(name=>name.startsWith('.picture-work-'))).toBe(false);
    const missing=f.directory('missing');await expect(conformEditAssemblyPicture(assembly,new Map(),missing,access)).rejects.toThrow('source is unavailable');expect(readdirSync(missing).some(name=>name.startsWith('.picture-work-'))).toBe(false);
    const changedDir=f.directory('changed'),paths=new Map(f.paths),changedPath=join(f.root,'changed-film.mkv');copyFileSync(f.paths.get('film')!,changedPath);paths.set('film',changedPath);let changed=false;
    await expect(conformEditAssemblyPicture(assembly,paths,changedDir,async()=>{if(!changed&&existsSync(join(changedDir,'picture/source-1-frames.txt'))){writeFileSync(changedPath,'changed source');changed=true;}})).rejects.toThrow();expect(changed).toBe(true);expect(readdirSync(changedDir).some(name=>name.startsWith('.picture-work-'))).toBe(false);
    const stale=f.directory('stale'),bad=structuredClone(assembly);bad.ranges[0]!.fromFrame=0;await expect(conformEditAssemblyPicture(bad,f.paths,stale,access)).rejects.toThrow('changed');expect(readdirSync(stale)).toEqual([]);
  }finally{f.close();}
},120000);
