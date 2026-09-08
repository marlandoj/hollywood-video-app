import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {decodePng} from "@hyperframes/engine";
import {contentHash} from "../src/capabilities";
import {EditPreviewSource} from "../src/edit-preview-media";
import {EditPreviewPageCache} from "../src/edit-preview-cache";
import {EditAssemblyPreviewMix} from "../src/edit-assembly-preview-mix";
import {EditAssemblyPreviewPicture} from "../src/edit-assembly-preview-picture";
import {conformEditAudio,type EditConformSource} from "../src/edit-conform";
import {conformEditPicture,editFrameHashes,type EditPictureResult} from "../src/edit-picture";
import {soundWav} from "../src/sound-audio";
import {soundDigest} from "../src/sound-media";
import {soundProcessingCommand} from "../src/sound-finishing";
import {createEditAssemblyPlan,EditAssemblyClock} from "../../planner/src/edit-assembly-clock";
import {decodePreviewPage} from "../../planner/src/edit-preview-protocol";
import {applyEditOperation,editTimeline,type EditClip,type EditSource,type EditTimeline} from "../../planner/src/edit-timeline";
const access=async()=>{},hash=(value:Uint8Array)=>createHash("sha256").update(value).digest("hex");
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-assembly-preview-")||realpathSync(root)!==root)throw new Error("Unsafe assembly preview cleanup");rmSync(root,{recursive:true,force:true});}
async function fixture(width=64,height=48,frames=90){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-assembly-preview-"))),sources:EditSource[]=[],prepared:EditPreviewSource[]=[],media:EditConformSource[]=[],paths=new Map<string,string>();
  try{
    const pcm=Buffer.alloc(frames*1600*6);for(let sample=0;sample<frames*1600;sample++)for(let channel=0;channel<2;channel++)pcm.writeIntLE((sample*(31+channel*7)%100001)-50000,sample*6+channel*3,3);writeFileSync(join(root,"audio.wav"),soundWav(pcm));const audio={path:"audio.wav",...await soundDigest(join(root,"audio.wav"))};
    for(const id of ["film","graphic"]){const native=id==="graphic",w=native?width/2:width,path=join(root,id+".mkv");
      if(native){const raw=Buffer.alloc(w*height*4*frames);for(let frame=0;frame<frames;frame++)for(let y=0;y<height;y++)for(let x=0;x<w;x++)raw.set([180+frame%60,20+y%20,30+x%80,x<w/2?95:220],(frame*w*height+y*w+x)*4);writeFileSync(join(root,"native.rgba"),raw);await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","rawvideo","-pixel_format","rgba","-video_size",`${w}x${height}`,"-framerate","30","-i",join(root,"native.rgba"),"-frames:v",String(frames),"-an","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","bgra",path],root,access);}
      else await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i",`testsrc2=size=${width}x${height}:rate=30`,"-frames:v",String(frames),"-an","-c:v","libx264","-preset","veryfast","-g","90","-bf","3","-sc_threshold","0","-threads","1",path],root,access);
      const source:EditSource={id,revision:contentHash(id),label:id,width:w,height,frames,audio:native?[]:["mix","effects"],captions:[],voices:[],unmeasuredAudio:false,...(native?{media:"graphic-rgba" as const}:{})},input:EditConformSource={id,picture:{path:id+".mkv",...await soundDigest(path)},audio:native?{}:{mix:audio,effects:audio}};
      sources.push(source);media.push(input);paths.set(id,path);prepared.push(await EditPreviewSource.prepare(source,input,root,join(root,id+"-index"),access));
    }
    return {root,sources,prepared,media,paths,pcm,width,height,frames,close:()=>cleanup(root)};
  }catch(error){cleanup(root);throw error;}
}
function clip(id:string,sourceId:string,layer:number,at:number,from:number,frames:number,lane:EditClip["lane"]="picture",opacity=1):EditClip{return {id,sourceId,lane,layer,at,from,frames,link:null,gainDb:0,opacity,crop:null,envelope:{from,frames,fadeIn:0,fadeOut:0}};}
function plan(timeline:EditTimeline,ranges=[{id:"later",fromFrame:59,toFrame:70,reason:"Retain the original transition."},{id:"earlier",fromFrame:2,toFrame:3,reason:"Return to the setup."},{id:"repeat",fromFrame:63,toFrame:67,reason:"Repeat the retained frames."}]){return createEditAssemblyPlan({sequenceId:"saved-parent",historyRevision:contentHash("history"),timeline,sourceReceipts:timeline.sources.map(source=>({sourceId:source.id,receiptRevision:contentHash("receipt-"+source.id)}))},ranges);}
async function pixels(root:string,path:string,width:number,height:number){const output=join(root,crypto.randomUUID()+".rgba");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-threads","1","-i",path,"-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-f","rawvideo",output],root,access);const data=readFileSync(output);expect(data.length%(width*height*4)).toBe(0);rmSync(output);return data;}
async function parentPixels(root:string,picture:EditPictureResult,directory:string){const output=join(root,crypto.randomUUID()+".rgba");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-f","concat","-safe","0","-threads","1","-i",join(directory,picture.concatFile),"-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-f","rawvideo",output],root,access);const data=readFileSync(output);rmSync(output);return data;}

test("lossless preview inputs preserve cached film YUV and native alpha at B-frame and page boundaries",async()=>{
  const f=await fixture();try{
    for(const source of f.prepared){const format=source.source.media?"rgba":"yuv420p",baseline=await editFrameHashes(f.paths.get(source.source.id)!,f.frames,join(f.root,source.source.id+"-expected.txt"),f.root,access,undefined,format);
      for(const frame of [0,59,60,89]){const directory=join(f.root,source.source.id+"-lossless-"+frame),file=await source.losslessFrame(frame,directory,access),hashes=await editFrameHashes(file,1,join(directory,"checked.txt"),f.root,access,undefined,format);expect(hashes).toEqual([baseline[frame]!]);expect(readdirSync(directory).sort()).toEqual(["checked.txt","frame.mkv"]);}
      for(const frames of [[0,1,59,60,89],[0,1,59,60,60,89]]){const directory=join(f.root,source.source.id+"-batch-"+frames.length),file=await source.losslessFrames(frames,directory,access),hashes=await editFrameHashes(file,frames.length,join(directory,"checked.txt"),f.root,access,undefined,format);expect(hashes).toEqual(frames.map(frame=>baseline[frame]!));expect(readdirSync(directory).sort()).toEqual(["checked.txt","frame.mkv"]);}
    }
    const source=f.prepared[1]!,abort=new AbortController();abort.abort(new Error("cancel input"));await expect(source.losslessFrame(0,join(f.root,"cancelled"),access,abort.signal)).rejects.toThrow("cancel input");expect(existsSync(join(f.root,"cancelled"))).toBe(false);
    await expect(source.losslessFrames([0,1],join(f.root,"cancelled-batch"),access,abort.signal)).rejects.toThrow("cancel input");expect(existsSync(join(f.root,"cancelled-batch"))).toBe(false);
    for(const frames of [[],[1,0],Array.from({length:17},(_,i)=>i),[NaN],[90]])await expect(source.losslessFrames(frames,join(f.root,"invalid-batch"),access)).rejects.toThrow("sixteen ordered");
    let calls=0;await expect(source.losslessFrame(0,join(f.root,"withdrawn"),async()=>{if(++calls>=3)throw new Error("input rights revoked");})).rejects.toThrow("rights revoked");expect(existsSync(join(f.root,"withdrawn"))).toBe(false);
    const original=readFileSync(f.paths.get("graphic")!),changed=join(f.root,"replacement.mkv");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","color=c=yellow:s=32x48:r=30","-frames:v","90","-an","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","bgra",changed],f.root,access);writeFileSync(f.paths.get("graphic")!,readFileSync(changed));
    await expect(source.losslessFrame(60,join(f.root,"changed"),access)).rejects.toThrow("changed");expect(existsSync(join(f.root,"changed"))).toBe(false);await expect(source.losslessFrames([59,60,60],join(f.root,"changed-batch"),access)).rejects.toThrow("changed");expect(existsSync(join(f.root,"changed-batch"))).toBe(false);writeFileSync(f.paths.get("graphic")!,original);
  }finally{f.close();}
},60000);

test("child soundtrack pages equal selected full-parent PCM across reorders, repetitions, holds, ramps and odd dissolves",async()=>{
  const f=await fixture();try{
    const left=clip("left","film",0,0,0,30,"mix"),right=clip("right","film",0,30,30,60,"mix"),effect=clip("effects","film",0,12,15,70,"effects");left.gainDb=-3;left.envelope.fadeIn=8;right.gainDb=-6;effect.gainDb=-9;effect.envelope.fadeIn=10;effect.envelope.fadeOut=10;
    left.timing={from:0,offset:0,points:[{frame:0,rate:500},{frame:30,rate:1500}]};right.timing={from:30,offset:0,points:[{frame:0,rate:1000},{frame:10,rate:0},{frame:20,rate:0},{frame:60,rate:1000}]};
    const timeline=applyEditOperation(editTimeline({schema:"hv-edit-timeline/1",width:64,height:48,frames:90,sources:f.sources,clips:[left,right,effect],markers:[]}),{kind:"crossfade",leftId:"left",rightId:"right",linked:false,frames:9,alignment:"center",ids:{left:"sound-dissolve"}}),assembly=plan(timeline,[
      {id:"later",fromFrame:56,toFrame:66,reason:"Start later."},{id:"dissolve",fromFrame:23,toFrame:36,reason:"Keep the partial dissolve."},{id:"earlier",fromFrame:1,toFrame:56,reason:"Include the held parent segment."},{id:"repeat",fromFrame:23,toFrame:36,reason:"Repeat the dissolve."}
    ]),clock=new EditAssemblyClock(assembly),mix=new EditAssemblyPreviewMix(assembly,f.prepared,f.root);
    await conformEditAudio(timeline,f.media,f.root,join(f.root,"full-audio"),access);const full=readFileSync(join(f.root,"full-audio/final.wav")).subarray(44),expected=Buffer.concat(assembly.ranges.map(range=>full.subarray(range.fromFrame*1600*6,range.toFrame*1600*6))),cache=new EditPreviewPageCache(f.root);const actual:Uint8Array[]=[];
    try{for(const from of [0,60]){const response=await cache.read(mix,from,access),decoded=await decodePreviewPage(response.bytes,{sourceKey:mix.sourceKey,from,sha256:response.sha256});expect(decoded.header).toMatchObject({sourceId:"timeline-audio",sourceRevision:assembly.revision,sourceFrames:91,frames:from?31:60});expect(decoded.picture).toEqual([]);actual.push(decoded.audio.mix!);expect((await cache.read(mix,from,access)).bytes).toEqual(response.bytes);}expect(Buffer.concat(actual)).toEqual(expected);expect(clock.frame(60).parentFrame).toBe(38);expect(cache.stats.pages).toBe(2);}finally{await cache.close();}
    for(const from of [-60,1,91,NaN])expect(()=>mix.identity(from)).toThrow();expect(()=>mix.identity(0,{includePicture:false,audioLanes:["effects"]})).toThrow();
    const missing=new EditAssemblyPreviewMix(assembly,[f.prepared[1]!],f.root);await expect(missing.page(0,join(f.root,"missing-audio"),access)).rejects.toThrow("not prepared");expect(existsSync(join(f.root,"missing-audio"))).toBe(false);
    const destination=join(f.root,"revoked-audio");await expect(mix.page(0,destination,async()=>{if(existsSync(join(destination,"page.hvp")))throw new Error("rights revoked before audio return");})).rejects.toThrow("rights revoked");expect(existsSync(destination)).toBe(false);
    const changed=plan(timeline,assembly.ranges.slice().reverse());expect(new EditAssemblyPreviewMix(changed,f.prepared,f.root).sourceKey).not.toBe(mix.sourceKey);
  }finally{f.close();}
},60000);

test("sparse child picture pages equal full-parent decoded pixels for film, native alpha, masks, mattes and off-range effects",async()=>{
  const f=await fixture();try{
    for(const mode of ["film","native","effects","off-range"]){
      const left=clip("left",mode==="film"?"film":"graphic",1,0,5,65,"picture",.8),right=clip("right","film",1,65,40,10,"picture",.6),clips=[clip("background","film",0,0,0,75),left,right];left.timing={from:5,offset:0,points:[{frame:0,rate:500},{frame:65,rate:1500}]};right.envelope.fadeIn=3;
      if(mode==="effects"){
        const matte=clip("held-matte","film",2,0,4,64);matte.timing={from:4,offset:0,points:[{frame:0,rate:0},{frame:64,rate:0}]};clips.push(matte,clip("late-matte","film",2,70,40,5));
        left.composite={schema:"hv-edit-composite/1",matte:{layer:2,channel:"luma",invert:false},masks:[{id:"ellipse",label:"Original moving ellipse",sourceRevision:f.sources[1]!.revision,kind:"ellipse",combine:"replace",invert:false,featherQ8:256,keyframes:[{sourceFrame:0,interpolation:"linear",geometry:{xQ16:0,yQ16:0,widthQ16:32768,heightQ16:65536}},{sourceFrame:89,interpolation:"hold",geometry:{xQ16:32768,yQ16:0,widthQ16:32768,heightQ16:65536}}]}]};right.composite={schema:"hv-edit-composite/1",matte:{layer:2,channel:"alpha",invert:true}};
      }
      if(mode==="off-range"){const outside=clip("outside-effect","film",3,72,0,3);outside.composite={schema:"hv-edit-composite/1",placement:{xQ16:0,yQ16:0,scaleQ16:65536,rotationMilliDegrees:0}};clips.push(outside);}
      const timeline=applyEditOperation(editTimeline({schema:mode==="effects"||mode==="off-range"?"hv-edit-timeline/2":"hv-edit-timeline/1",width:64,height:48,frames:75,sources:f.sources,clips,markers:[],...(mode==="effects"?{matteOnlyLayers:[2]}:{})}),{kind:"crossfade",leftId:"left",rightId:"right",linked:false,frames:7,alignment:"center",ids:{left:"odd-dissolve"}}),assembly=plan(timeline),clock=new EditAssemblyClock(assembly),directory=join(f.root,"parent-"+mode);mkdirSync(directory);const rendered=await conformEditPicture(timeline,f.paths,directory,access),full=await parentPixels(f.root,rendered.picture,directory),preview=new EditAssemblyPreviewPicture(assembly,f.prepared,f.root),cache=new EditPreviewPageCache(f.root);
      try{for(const frame of mode==="off-range"?[4,6]:[0,4,6,12]){const selection={includePicture:true,audioLanes:[] as [],pictureFrames:[frame]},response=await cache.read(preview,0,access,undefined,selection),decoded=await decodePreviewPage(response.bytes,{sourceKey:preview.sourceKey,from:0,sha256:response.sha256}),parentFrame=clock.frame(frame).parentFrame,expected=full.subarray(parentFrame*64*48*4,(parentFrame+1)*64*48*4);
        expect(decoded.header).toMatchObject({schema:"hv-edit-preview-page/3",sourceId:"timeline-picture",sourceRevision:assembly.revision,sourceFrames:16,pictureFrames:[frame],picturePurpose:"timeline-composite",pictureEncoding:"png-rgba"});expect(decoded.header.picture[0]!.sourceSha256).toBe(hash(expected));expect(Buffer.from(decodePng(Buffer.from(decoded.picture[0]!)).data)).toEqual(expected);expect((await cache.read(preview,0,access,undefined,selection)).bytes).toEqual(response.bytes);
      }
        const selection={includePicture:true,audioLanes:[] as [],pictureFrames:Array.from({length:16},(_,frame)=>frame)},response=await cache.read(preview,0,access,undefined,selection),decoded=await decodePreviewPage(response.bytes,{sourceKey:preview.sourceKey,from:0,sha256:response.sha256});expect(decoded.header.pictureFrames).toEqual(selection.pictureFrames);
        for(const frame of selection.pictureFrames){const parentFrame=clock.frame(frame).parentFrame,expected=full.subarray(parentFrame*64*48*4,(parentFrame+1)*64*48*4);expect(decoded.header.picture[frame]!.sourceSha256).toBe(hash(expected));expect(Buffer.from(decodePng(Buffer.from(decoded.picture[frame]!)).data)).toEqual(expected);}
        expect((await cache.read(preview,0,access,undefined,selection)).bytes).toEqual(response.bytes);
      }finally{await cache.close();}
      for(const pictureFrames of [[0,0],[1,0],Array.from({length:17},(_,i)=>i)])expect(()=>preview.identity(0,{includePicture:true,audioLanes:[],pictureFrames})).toThrow("sixteen distinct");expect(()=>preview.identity(60,{includePicture:true,audioLanes:[],pictureFrames:[60]})).toThrow();
      const cancelled=new AbortController();cancelled.abort(new Error("stop assembly picture"));await expect(preview.page(0,join(f.root,mode+"-cancelled"),access,cancelled.signal,{includePicture:true,audioLanes:[],pictureFrames:[4]})).rejects.toThrow("stop assembly picture");expect(existsSync(join(f.root,mode+"-cancelled"))).toBe(false);
    }
  }finally{f.close();}
},180000);

test("finished assembly pictures resize once after the full parent render and reject revocation or source loss",async()=>{
  const f=await fixture(640,360,3);try{
    const timeline=editTimeline({schema:"hv-edit-timeline/1",width:640,height:360,frames:3,sources:f.sources,clips:[clip("original","film",0,0,0,3)],markers:[]}),assembly=plan(timeline,[{id:"last",fromFrame:2,toFrame:3,reason:"Use the final retained frame."}]),preview=new EditAssemblyPreviewPicture(assembly,f.prepared,f.root),selection={includePicture:true,audioLanes:[] as [],pictureFrames:[0]},result=await preview.page(0,join(f.root,"page"),access,undefined,selection),decoded=await decodePreviewPage(readFileSync(join(f.root,result.file.path)),{sourceKey:preview.sourceKey,from:0,sha256:result.file.sha256});
    const original=await pixels(f.root,f.paths.get("film")!,640,360),expected=original.subarray(2*640*360*4);expect(decoded.header.picture[0]!.sourceSha256).toBe(hash(expected));expect(preview.dimensions).toEqual({width:480,height:270});writeFileSync(join(f.root,"expected.rgba"),expected);
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-filter_threads","1","-f","rawvideo","-pixel_format","rgba","-video_size","640x360","-i",join(f.root,"expected.rgba"),"-vf","scale=480:270:flags=lanczos+accurate_rnd,format=rgba,setsar=1","-frames:v","1","-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-f","rawvideo",join(f.root,"small.rgba")],f.root,access);expect(Buffer.from(decodePng(Buffer.from(decoded.picture[0]!)).data)).toEqual(readFileSync(join(f.root,"small.rgba")));expect(readdirSync(join(f.root,"page"))).toEqual(["page.hvp"]);
    const destination=join(f.root,"revoked");await expect(preview.page(0,destination,async()=>{if(existsSync(join(destination,"page.hvp")))throw new Error("picture rights revoked before return");},undefined,selection)).rejects.toThrow("rights revoked");expect(existsSync(destination)).toBe(false);
    const missing=new EditAssemblyPreviewPicture(assembly,[f.prepared[1]!],f.root);await expect(missing.page(0,join(f.root,"missing"),access,undefined,selection)).rejects.toThrow("outside the prepared");expect(existsSync(join(f.root,"missing"))).toBe(false);
    const changed=structuredClone(assembly);changed.ranges[0]!.fromFrame=1;expect(()=>new EditAssemblyPreviewPicture(changed,f.prepared,f.root)).toThrow("changed");expect(()=>new EditAssemblyPreviewMix(assembly,[f.prepared[0]!,f.prepared[0]!],f.root)).toThrow("unchanged original");
  }finally{f.close();}
},60000);

test("bounded picture blocks preserve sixty reordered child frames and reuse completed packets",async()=>{
  const f=await fixture(640,360,120);try{
    const timeline=editTimeline({schema:"hv-edit-timeline/1",width:320,height:180,frames:120,sources:f.sources,clips:[clip("original","film",0,0,0,120)],markers:[]}),assembly=plan(timeline,[{id:"later",fromFrame:90,toFrame:120,reason:"Start with the retained end."},{id:"repeat",fromFrame:90,toFrame:120,reason:"Repeat the retained end."}]),preview=new EditAssemblyPreviewPicture(assembly,f.prepared,f.root),directory=join(f.root,"parent-blocks");mkdirSync(directory);
    const rendered=await conformEditPicture(timeline,f.paths,directory,access),full=await parentPixels(f.root,rendered.picture,directory),clock=new EditAssemblyClock(assembly),cache=new EditPreviewPageCache(f.root),durations:number[]=[],packets:Uint8Array[]=[],selections=[0,16,32,48].map(start=>({includePicture:true,audioLanes:[] as [],pictureFrames:Array.from({length:Math.min(16,60-start)},(_,index)=>start+index)}));
    try{
      for(const selection of selections){const started=performance.now(),result=await cache.read(preview,0,access,undefined,selection);durations.push(performance.now()-started);packets.push(result.bytes);const decoded=await decodePreviewPage(result.bytes,{sourceKey:preview.sourceKey,from:0,sha256:result.sha256});expect(decoded.header.pictureFrames).toEqual(selection.pictureFrames);
        for(const [index,frame]of selection.pictureFrames.entries()){const parentFrame=clock.frame(frame).parentFrame,expected=full.subarray(parentFrame*320*180*4,(parentFrame+1)*320*180*4);expect(decoded.header.picture[index]!.sourceSha256).toBe(hash(expected));expect(Buffer.from(decodePng(Buffer.from(decoded.picture[index]!)).data)).toEqual(expected);}
      }
      const warm=performance.now();for(const [index,selection]of selections.entries())expect((await cache.read(preview,0,access,undefined,selection)).bytes).toEqual(packets[index]!);const warmMs=performance.now()-warm;expect(cache.stats.pages).toBe(4);expect(packets.every(packet=>packet.byteLength<16*1024**2)).toBe(true);
      console.info(JSON.stringify({workload:"60 child pictures, 320x180, 640x360 B-frame original, repeated parent 90..120",coldBlockMs:durations.map(value=>Math.round(value)),coldTotalMs:Math.round(durations.reduce((sum,value)=>sum+value,0)),warmFourBlocksMs:Math.round(warmMs),packetBytes:packets.map(packet=>packet.byteLength)}));
    }finally{await cache.close();}
  }finally{f.close();}
},90000);
