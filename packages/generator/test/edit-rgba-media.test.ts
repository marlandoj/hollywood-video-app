import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {contentHash} from "../src/capabilities";
import {soundDigest} from "../src/sound-media";
import {soundProcessingCommand} from "../src/sound-finishing";
import {conformEdit,type EditConformSource} from "../src/edit-conform";
import {readEditFrameHashes} from "../src/edit-picture";
import {applyEditOperation,editTimeline,type EditClip,type EditSource,type EditTimeline} from "../../planner/src/edit-timeline";
import {editStorageEstimate} from "../../planner/src/edit-resources";
import {EditPreviewSource} from "../src/edit-preview-media";
import {decodePreviewPage,encodePreviewPage,previewDigest,previewPngDimensions,PREVIEW_RECIPE} from "../../planner/src/edit-preview-protocol";
import {previewPicture,previewRequests} from "../../planner/src/edit-preview-render";
import {decodePng} from "@hyperframes/engine";
import {editRgbaGroups} from "../../planner/src/edit-rgba";
import {editRenderClips} from "../../planner/src/edit-transition-render";
import {editRgbaResize} from "../src/edit-rgba-picture";

const access=async()=>{},width=64,height=48,frames=90,frameBytes=width*height*4;
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe alpha fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function decoded(root:string,input:string,name:string,concat=false){const file=join(root,name);await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe",...(concat?["-f","concat","-safe","0"]:[]),"-threads","1","-i",input,"-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-f","rawvideo",file],root,access);return readFileSync(file);}
function color(id:string,frame:number,x:number):number[]{return id==="film"?[40,120,200,255]:id==="a"?[180+frame%40,20,30,x<16?255:x<48?128:0]:[5,25,180+frame%40,x<8?255:x>=24?192:0];}
function clip(id:string,sourceId:string,at:number,from:number,count:number,layer:number,opacity=1):EditClip{return {id,sourceId,lane:"picture",layer,link:null,at,from,frames:count,gainDb:0,opacity,crop:null,envelope:{from,frames:count,fadeIn:0,fadeOut:0}};}
async function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-rgba-media-"))),sources:EditSource[]=[],media:EditConformSource[]=[],original=new Map<string,Buffer>();
  try{for(const id of ["film","a","b"]){const rgba=Buffer.alloc(frameBytes*frames);for(let f=0;f<frames;f++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=f*frameBytes+(y*width+x)*4;rgba.set(color(id,f,x),p);}writeFileSync(join(root,id+".raw"),rgba);
      const picture=join(root,id+".mkv");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","rawvideo","-pixel_format","rgba","-video_size","64x48","-framerate","30","-i",join(root,id+".raw"),"-an","-c:v","ffv1","-level","3","-threads","1","-pix_fmt",id==="film"?"yuv420p":"bgra",picture],root,access);
      sources.push({id,revision:contentHash(id),label:id,frames,width,height,audio:[],captions:[],voices:[],unmeasuredAudio:false,...(id==="film"?{}:{media:"graphic-rgba" as const})});media.push({id,picture:{path:id+".mkv",...await soundDigest(picture)},audio:{}});original.set(id,await decoded(root,picture,id+"-decoded.raw"));
    }
    const timeline=(clips:EditClip[],count=12,h=48)=>editTimeline({schema:"hv-edit-timeline/1",width,height:h,frames:count,sources,clips,markers:[]});
    return {root,sources,media,original,timeline,async render(t:EditTimeline,name:string){const result=await conformEdit(t,media,root,join(root,name),access);return {result,pixels:await decoded(root,join(root,name,"picture/index.ffconcat"),name+"-decoded.raw",true)};},close:()=>cleanup(root)};
  }catch(error){cleanup(root);throw error;}
}
function pixel(bytes:Buffer,frame:number,x:number,y=16,h=48):number[]{return [...bytes.subarray((frame*width*h+y*width+x)*4,(frame*width*h+y*width+x)*4+4)];}
function over(background:number[],foreground:number[],weight:number):number[]{const a=foreground[3]!*weight/255;return [...background.slice(0,3).map((v,i)=>Math.round(v*(1-a)+foreground[i]!*a)),255];}
function closeColor(actual:number[],expected:number[],tolerance=3){for(let i=0;i<3;i++)expect(Math.abs(actual[i]!-expected[i]!)).toBeLessThanOrEqual(tolerance);expect(actual[3]).toBe(255);}

test("native overlays preserve lower footage, partial alpha, layered fades, source seeks and bounded RGBA storage",async()=>{
  const f=await fixture();try{
    const a=clip("title","a",2,31,8,1,.75);a.envelope.fadeIn=2;a.envelope.fadeOut=2;const t=f.timeline([clip("background","film",0,0,12,0),a,clip("mark","b",4,41,4,2,.5)]),{result,pixels}=await f.render(t,"overlay");
    expect(result.picture.recipe.schema).toBe("hv-edit-picture/5");expect(result.picture.parts.filter(p=>p.at>=2&&p.at<10).every(p=>p.layers.some(l=>l.clipId==="background"))).toBe(true);expect(result.pictureFrames).toHaveLength(12);expect(result.picture.parts.every(p=>p.frames<=60)).toBe(true);
    for(let frame=0;frame<12;frame++)for(const x of [8,24,40,56]){let expected=pixel(f.original.get("film")!,frame,x);if(frame>=2&&frame<10){const phase=frame-2,weight=Math.floor(255*.75*Math.max(0,Math.min(1,phase/2,(8-phase)/2)))/255;expected=over(expected,color("a",31+phase,x),weight);}if(frame>=4&&frame<8)expected=over(expected,color("b",41+frame-4,x),Math.floor(255*.5)/255);closeColor(pixel(pixels,frame,x),expected);}
    for(const id of ["a","b"]){const evidence=result.picture.sourceFrameFiles.find(s=>s.sourceId===id)!,hashes=readEditFrameHashes(join(f.root,"overlay",evidence.file),frames);expect(hashes).toEqual(Array.from({length:frames},(_,n)=>createHash("sha256").update(f.original.get(id)!.subarray(n*frameBytes,(n+1)*frameBytes)).digest("hex")));}
    const estimate=editStorageEstimate(t,[]);expect(estimate.rgbaScratchBytes).toBeGreaterThanOrEqual(width*height*4*60*4);expect(estimate.workspaceBytes).toBe(estimate.outputBytes*3+estimate.rgbaScratchBytes!);
    const opaque=f.timeline([clip("background","film",0,0,12,0)]);expect(editStorageEstimate(opaque,[]).rgbaScratchBytes).toBeUndefined();
    const spanning=clip("spanning","a",0,0,65,1);spanning.envelope.fadeOut=30;const long=await f.render(f.timeline([clip("background","film",0,0,65,0),spanning],65),"part-boundary");expect(long.result.picture.parts.map(p=>p.frames)).toEqual([60,5]);for(const frame of [0,59,60,64])for(const x of [8,24,56])closeColor(pixel(long.pixels,frame,x),over(pixel(f.original.get("film")!,frame,x),color("a",frame,x),Math.floor(255*Math.min(1,(65-frame)/30))/255));
  }finally{f.close();}
},60000);

test("native dissolves add weighted premultiplied colors and reveal footage where either graphic is transparent",async()=>{
  const f=await fixture();try{
    const base=f.timeline([clip("background","film",0,0,12,0),clip("left","a",0,20,6,1,.8),clip("right","b",6,40,6,1,.6)]),t=applyEditOperation(base,{kind:"crossfade",leftId:"left",rightId:"right",linked:false,frames:4,alignment:"center",ids:{left:"graphic-dissolve"}}),{pixels,result}=await f.render(t,"dissolve");
    for(let frame=0;frame<12;frame++)for(const x of [4,8,24,40,56]){const background=pixel(f.original.get("film")!,frame,x);let expected:number[];
      if(frame<4)expected=over(background,color("a",20+frame,x),Math.floor(255*.8)/255);
      else if(frame>=8)expected=over(background,color("b",40+frame-6,x),Math.floor(255*.6)/255);
      else{const u=(frame-4)/4,a=color("a",20+frame,x),b=color("b",40+frame-6,x),wa=a[3]!*Math.floor(255*.8)*(1-u)/65025,wb=b[3]!*Math.floor(255*.6)*u/65025;expected=[...background.slice(0,3).map((v,i)=>Math.round(v*(1-wa-wb)+a[i]!*wa+b[i]!*wb)),255];}
      closeColor(pixel(pixels,frame,x),expected);
    }
    expect(result.picture.parts.find(p=>p.at===4)!.layers.map(l=>l.clipId)).toEqual(["background","left","right"]);
    const unity=editRenderClips(t).map(c=>({...c,opacity:1})).filter(c=>c.id!=="background");for(let frame=4;frame<8;frame++)expect(editRgbaGroups(unity,frame)[0]!.reduce((sum,l)=>sum+l.alpha,0)).toBe(255);
  }finally{f.close();}
},60000);

test("native holds retain RGBA source frames and fitted crop padding remains transparent",async()=>{
  const f=await fixture();try{
    const base=f.timeline([clip("background","film",0,0,12,0),clip("held","a",0,31,12,1)]),t=applyEditOperation(base,{kind:"retime",clipId:"held",linked:false,from:31,frames:12,points:[{frame:0,rate:0},{frame:6,rate:0},{frame:12,rate:2000}],ripple:false}),{pixels,result}=await f.render(t,"held");
    const selected=Array.from({length:12},(_,frame)=>31+Math.floor(Math.max(0,frame-6)**2/6));expect(result.picture.parts[0]!.layers.find(l=>l.clipId==="held")!.sourceFrames).toEqual(selected);
    for(let frame=0;frame<12;frame++)for(const x of [8,24,40])closeColor(pixel(pixels,frame,x),over(pixel(f.original.get("film")!,frame,x),color("a",selected[frame]!,x),1));
    const cropped=clip("crop","a",0,31,4,1);cropped.crop={x:0,y:0,width:32,height:48};const cut=f.timeline([clip("background","film",0,0,4,0),cropped],4,64),crop=await f.render(cut,"cropped");for(let frame=0;frame<4;frame++)for(const x of [3,60])closeColor(pixel(crop.pixels,frame,x,32,64),pixel(f.original.get("film")!,frame,x,24));
    expect(crop.result.picture.parts[0]!.layers[1]!.filter).toContain("color=black@0");expect(editStorageEstimate(t,[]).retimingScratchBytes).toBeGreaterThanOrEqual(width*height*4*60*3);
  }finally{f.close();}
},60000);

test("film and native graphics dissolve in either direction without losing lower layers or source handles",async()=>{
  const f=await fixture();try{
    for(const [leftId,rightId]of [["film","a"],["a","film"]]){
      const base=f.timeline([clip("background","film",0,0,12,0),clip("left",leftId!,0,20,6,1,.8),clip("right",rightId!,6,40,6,1,.6)]),t=applyEditOperation(base,{kind:"crossfade",leftId:"left",rightId:"right",linked:false,frames:4,alignment:"center",ids:{left:"mixed-dissolve"}}),{pixels,result}=await f.render(t,leftId+"-to-"+rightId);
      const original=(id:string,frame:number,x:number)=>pixel(f.original.get(id)!,frame,x);
      for(let frame=0;frame<12;frame++)for(const x of [8,24,40,56]){
        const background=original("film",frame,x),left=original(leftId!,20+frame,x),right=original(rightId!,40+frame-6,x);let expected:number[];
        if(frame<4)expected=over(background,left,Math.floor(255*.8)/255);
        else if(frame>=8)expected=over(background,right,Math.floor(255*.6)/255);
        else{const u=(frame-4)/4,a=left[3]!*Math.floor(255*.8)*(1-u)/65025,b=right[3]!*Math.floor(255*.6)*u/65025;expected=[...background.slice(0,3).map((v,i)=>Math.round(v*(1-a-b)+left[i]!*a+right[i]!*b)),255];}
        closeColor(pixel(pixels,frame,x),expected);
      }
      expect(result.picture.parts.find(p=>p.at===4)!.layers.map(l=>l.clipId)).toEqual(["background","left","right"]);
    }
  }finally{f.close();}
},60000);

test("native resizing excludes hidden RGB from partially transparent edge colors",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-rgba-media-")));try{
    const input=Buffer.alloc(frameBytes);for(let y=0;y<height;y++)for(let x=0;x<width;x++)input.set(x<31?[240,30,10,255]:[0,0,255,0],(y*width+x)*4);writeFileSync(join(root,"edge.raw"),input);
    for(const mode of ["bicubic","lanczos"]){const output=join(root,mode+".raw");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-filter_threads","1","-f","rawvideo","-pixel_format","rgba","-video_size",`${width}x${height}`,"-i",join(root,"edge.raw"),"-vf",editRgbaResize(`scale=32:24:flags=${mode}`),"-frames:v","1","-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-f","rawvideo",output],root,access);
      const resized=readFileSync(output);expect(resized.length).toBe(32*24*4);let partial=0;
      for(let x=0;x<32;x++){const p=(12*32+x)*4,alpha=resized[p+3]!;if(alpha>8&&alpha<247){partial++;expect(Math.abs(resized[p]!-240)).toBeLessThanOrEqual(2);expect(Math.abs(resized[p+1]!-30)).toBeLessThanOrEqual(2);expect(Math.abs(resized[p+2]!-10)).toBeLessThanOrEqual(2);}}
      expect(partial).toBeGreaterThan(0);expect(resized[(12*32+30)*4+3]).toBe(0);
    }
  }finally{cleanup(root);}
},30000);

test("native preview packets retain PNG alpha and authenticated RGBA frames, and reject old-format or corrupted payloads",async()=>{
  const f=await fixture();try{
    const source=f.sources.find(s=>s.id==="a")!,media=f.media.find(s=>s.id==="a")!,preview=await EditPreviewSource.prepare(source,media,f.root,join(f.root,"preview-index"),access);
    for(const [from,pictureFrames]of [[0,[0,31,59]],[60,[60,89]]] as const){
      const result=await preview.page(from,join(f.root,"page-"+from),access,undefined,{includePicture:true,audioLanes:[],pictureFrames:[...pictureFrames]}),bytes=readFileSync(join(f.root,result.file.path)),packet=await decodePreviewPage(bytes,{sourceKey:preview.sourceKey,from,sha256:result.file.sha256});
      expect(packet.header).toMatchObject({schema:"hv-edit-preview-page/2",pictureEncoding:"png-rgba",width,height});expect(packet.audio).toEqual({});expect(packet.picture).toHaveLength(pictureFrames.length);
      for(const [i,frame]of pictureFrames.entries()){const png=decodePng(Buffer.from(packet.picture[i]!));expect([png.width,png.height]).toEqual([width,height]);expect(packet.header.picture[i]!.sourceSha256).toBe(createHash("sha256").update(f.original.get("a")!.subarray(frame*frameBytes,(frame+1)*frameBytes)).digest("hex"));for(const x of [8,24,40]){const original=color("a",frame,x),actual=[...png.data.subarray((16*width+x)*4,(16*width+x)*4+4)];expect(actual[3]).toBe(original[3]);if(original[3])for(let ch=0;ch<3;ch++)expect(Math.abs(actual[ch]!-original[ch]!)).toBeLessThanOrEqual(1);}}
      const changed=Buffer.from(packet.picture[0]!);changed[20]^=1;expect(()=>previewPngDimensions(changed)).toThrow("checksum");
      const identity={...result.identity};delete identity.pictureEncoding;await expect(encodePreviewPage(identity,packet.picture.map((data,i)=>({frame:pictureFrames[i]!,sourceSha256:packet.header.picture[i]!.sourceSha256,data})),[])).rejects.toThrow("JPEG");
      const size=bytes.readUInt32LE(8),old={...packet.header,schema:"hv-edit-preview-page/1",recipe:PREVIEW_RECIPE};delete old.pictureEncoding;const header=Buffer.from(JSON.stringify(old)),envelope=Buffer.from(bytes.subarray(0,12));envelope.writeUInt32LE(header.length,8);const disguised=Buffer.concat([envelope,header,bytes.subarray(12+size)]);await expect(decodePreviewPage(disguised,{sourceKey:preview.sourceKey,from,sha256:await previewDigest(disguised)})).rejects.toThrow("JPEG");
    }
    const t=f.timeline([clip("background","film",0,0,12,0),clip("title","a",0,0,12,1)]);expect(previewPicture(t,0).map(p=>p.clip.id)).toEqual(["background","title"]);expect(previewRequests(t,0,1).map(r=>r.sourceId)).toEqual(["film","a"]);
    const largeInput=Buffer.alloc(512*384*4*2);for(let frame=0;frame<2;frame++)for(let y=0;y<384;y++)for(let x=0;x<512;x++)largeInput.set(color("a",frame,Math.floor(x/8)),(frame*512*384+y*512+x)*4);writeFileSync(join(f.root,"large.raw"),largeInput);
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","rawvideo","-pixel_format","rgba","-video_size","512x384","-framerate","30","-i",join(f.root,"large.raw"),"-frames:v","2","-an","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","bgra",join(f.root,"large.mkv")],f.root,access);
    const large={...source,width:512,height:384,frames:2},largeMedia={...media,picture:{path:"large.mkv",...await soundDigest(join(f.root,"large.mkv"))}},resized=await EditPreviewSource.prepare(large,largeMedia,f.root,join(f.root,"large-index"),access),small=await resized.page(0,join(f.root,"small-page"),access),smallPacket=await decodePreviewPage(readFileSync(join(f.root,small.file.path)),{sourceKey:resized.sourceKey,from:0,sha256:small.file.sha256}),smallPng=decodePng(Buffer.from(smallPacket.picture[0]!));expect([smallPng.width,smallPng.height]).toEqual([360,270]);expect(smallPng.data[(100*360+180)*4+3]).toBe(128);expect(smallPng.data[(100*360+340)*4+3]).toBe(0);expect([...smallPng.data.subarray((100*360+180)*4,(100*360+180)*4+3)]).toEqual([180,20,30]);
    const abort=new AbortController();abort.abort();await expect(preview.page(0,join(f.root,"aborted"),access,abort.signal)).rejects.toThrow();await expect(preview.page(0,join(f.root,"withdrawn"),async()=>{throw new Error("graphic withdrawn");})).rejects.toThrow("graphic withdrawn");
  }finally{f.close();}
},60000);
