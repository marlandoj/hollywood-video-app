import {expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {EditPreviewSource} from "../src/edit-preview-media";
import {EditPreviewPageCache} from "../src/edit-preview-cache";
import {EditPreviewMix} from "../src/edit-preview-mix";
import {soundWav} from "../src/sound-audio";
import {soundProcessingCommand} from "../src/sound-finishing";
import {soundDigest} from "../src/sound-media";
import {conformEditPicture,editFrameHashes} from "../src/edit-picture";
import {contentHash} from "../src/capabilities";
import {decodePreviewPage,previewJpegDimensions,previewPcmSample} from "../../planner/src/edit-preview-protocol";
import {initialEditTimeline,editTimeline,applyEditOperation,type EditSource} from "../../planner/src/edit-timeline";
import {conformEdit,conformEditAudio,type EditConformSource} from "../src/edit-conform";
import {PreviewAudioRenderer,previewRequests,previewPicture} from "../../planner/src/edit-preview-render";
const access=async()=>{};
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe preview fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-edit-preview-"))),frames=127,picture=join(root,"picture.mp4"),pcm=Buffer.alloc(frames*1600*6);for(let i=0;i<frames*1600;i++)for(let c=0;c<2;c++)pcm.writeIntLE((i*997+c*1711)%16000000-8000000,i*6+c*3,3);
  try{writeFileSync(join(root,"sound.wav"),soundWav(pcm));await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","testsrc2=s=640x360:r=30","-frames:v",String(frames),"-c:v","libx264","-preset","medium","-crf","18","-g","90","-bf","3","-sc_threshold","0","-threads","1",picture],root,access);
    const file={path:"sound.wav",...await soundDigest(join(root,"sound.wav"))},media:EditConformSource={id:"original",picture:{path:"picture.mp4",...await soundDigest(picture)},audio:{effects:file,mix:file}},source:EditSource={id:media.id,revision:contentHash("preview-source"),label:"Moving B-frame source",frames,width:640,height:360,audio:["effects","mix"],captions:[],voices:[],unmeasuredAudio:false};
    return {root,frames,pcm,picture,source,media,close:()=>cleanup(root)};
  }catch(error){cleanup(root);throw error;}
}
test("preview pages retain B-frame source addresses, exact stereo PCM and the final partial page",async()=>{
  const f=await fixture();try{const baseline=await editFrameHashes(f.picture,f.frames,join(f.root,"baseline.txt"),f.root,access),source=await EditPreviewSource.prepare(f.source,f.media,f.root,join(f.root,"index"),access);
    expect(Object.keys(JSON.parse(readFileSync(join(f.root,"index/source-probe.json"),"utf8")).streams[0]).sort()).toEqual(["codec_type","height","r_frame_rate","width"]);
    expect(source.dimensions).toEqual({width:480,height:270});expect(Object.isFrozen(source.source.audio)).toBe(true);f.source.frames=60;f.source.audio.length=0;expect(source.identity(120).frames).toBe(7);
    for(const from of [60,120,0]){const result=await source.page(from,join(f.root,"page-"+from),access),decoded=await decodePreviewPage(readFileSync(join(f.root,result.file.path)),{sourceKey:source.sourceKey,from,sha256:result.file.sha256});
      expect(decoded.header.picture.map(p=>p.sourceSha256)).toEqual(baseline.slice(from,from+decoded.header.frames));expect(decoded.header.picture.map(p=>p.frame)).toEqual(Array.from({length:decoded.header.frames},(_,i)=>from+i));expect(previewJpegDimensions(decoded.picture[0]!)).toEqual(source.dimensions);expect(decoded.header.audio.map(a=>a.lane)).toEqual(["mix","effects"]);
      const expected=f.pcm.subarray(from*1600*6,(from+decoded.header.frames)*1600*6);expect(Buffer.from(decoded.audio.mix!)).toEqual(expected);expect(Buffer.from(decoded.audio.effects!)).toEqual(expected);expect(previewPcmSample(decoded.audio.mix!,0,1)).toBe(expected.readIntLE(3,3));expect(readdirSync(join(f.root,"page-"+from))).toEqual(["page.hvp"]);expect(result.file.bytes).toBeLessThan(16*1024**2);
    }
    for(const from of [-60,1,127,180,NaN])expect(()=>source.identity(from)).toThrow();
    const cache=new EditPreviewPageCache(f.root);try{const first=await cache.read(source,120,access),hit=await cache.read(source,120,access);expect(first.bytes).toEqual(hit.bytes);expect(cache.stats.pages).toBe(1);expect((await decodePreviewPage(hit.bytes,{sourceKey:source.sourceKey,from:120,sha256:hit.sha256})).header.picture.map(p=>p.sourceSha256)).toEqual(baseline.slice(120));}finally{await cache.close();}
  }finally{f.close();}
},60000);
test("browser preview mixes selected PCM pages exactly like full conform across fades, splits, slips and page boundaries",async()=>{
  const f=await fixture();try{const source=await EditPreviewSource.prepare(f.source,f.media,f.root,join(f.root,"index"),access),pages=new Map<number,Awaited<ReturnType<typeof decodePreviewPage>>>();
    for(const from of [0,60,120]){const result=await source.page(from,join(f.root,"audio-"+from),access,undefined,{includePicture:false,audioLanes:["effects","mix"]});const page=await decodePreviewPage(readFileSync(join(f.root,result.file.path)),{sourceKey:source.sourceKey,from,sha256:result.file.sha256});expect(page.picture).toEqual([]);expect(readdirSync(join(f.root,"audio-"+from))).toEqual(["page.hvp"]);pages.set(from,page);}
    let t=initialEditTimeline([f.source],f.source.id,640,360);t=applyEditOperation(t,{kind:"settings",clipId:"initial-1",gainDb:-12,opacity:1,crop:null,fadeIn:70,fadeOut:50});t=applyEditOperation(t,{kind:"unlink",clipId:"initial-1"});t=applyEditOperation(t,{kind:"split",clipId:"initial-1",linked:false,at:71,rightIds:{"initial-1":"right"},rightLink:null});t=applyEditOperation(t,{kind:"slip",clipId:"right",linked:false,delta:-3});
    const {revision:_r,...data}=t,copy={...t.clips.find(c=>c.id==="initial-1")!,id:"effects",lane:"effects" as const,link:null,at:7,from:15,frames:75,gainDb:-9,envelope:{from:8,frames:101,fadeIn:30,fadeOut:55}};t=editTimeline({...data,clips:[...data.clips,copy]});
    await conformEditAudio(t,[f.media],f.root,join(f.root,"conform-audio"),access);const full=readFileSync(join(f.root,"conform-audio/final.wav")).subarray(44),preview=Buffer.alloc(full.length),renderer=new PreviewAudioRenderer(t.clips),sizes=[127,511,1600,4096];let index=0;
    for(let at=0;at<t.frames*1600;){const size=Math.min(sizes[index++%sizes.length]!,t.frames*1600-at),left=new Float32Array(size),right=new Float32Array(size);expect(renderer.render(at,left,right,(_id,lane,from)=>pages.get(from)?.audio[lane])).toBe(true);for(let i=0;i<size;i++){preview.writeIntLE(left[i]!*8388608,(at+i)*6,3);preview.writeIntLE(right[i]!*8388608,(at+i)*6+3,3);}at+=size;}
    expect(preview).toEqual(full);const left=new Float32Array(128).fill(1),right=new Float32Array(128).fill(1);expect(renderer.render(95900,left,right,()=>undefined)).toBe(false);expect(renderer.missing).toEqual({sourceId:f.source.id,lane:"mix",from:0});expect([...left,...right].every(n=>n===0)).toBe(true);
    const mix=new EditPreviewMix(t,[source],f.root),mixed:Uint8Array[]=[];for(const from of [0,60,120]){const result=await mix.page(from,join(f.root,"timeline-mix-"+from),access),page=await decodePreviewPage(readFileSync(join(f.root,result.file.path)),{sourceKey:mix.sourceKey,from,sha256:result.file.sha256});expect(page.picture).toEqual([]);expect(page.header.audioLanes).toEqual(["mix"]);mixed.push(page.audio.mix!);}expect(Buffer.concat(mixed)).toEqual(full);
    const demand=previewRequests(t,70,3);expect(demand.find(r=>r.from===60)).toMatchObject({includePicture:true,audioLanes:["mix","effects"]});expect(previewPicture(t,126).map(p=>p.sourceFrame)).toEqual([126]);
  }finally{f.close();}
},60000);
test("sparse picture pages retain exact B-frame identities, distinguish cached selections and request only visible source frames",async()=>{
  const f=await fixture();try{
    const baseline=await editFrameHashes(f.picture,f.frames,join(f.root,"baseline.txt"),f.root,access),source=await EditPreviewSource.prepare(f.source,f.media,f.root,join(f.root,"index"),access),cache=new EditPreviewPageCache(f.root);
    try{for(const selected of [[61,71,119],[62],[120,126]]){
      const from=Math.floor(selected[0]!/60)*60,selection={includePicture:true,audioLanes:[] as [],pictureFrames:selected},first=await cache.read(source,from,access,undefined,selection),hit=await cache.read(source,from,access,undefined,selection),page=await decodePreviewPage(hit.bytes,{sourceKey:source.sourceKey,from,sha256:hit.sha256});
      expect(first.bytes).toEqual(hit.bytes);expect(page.header.picture.map(p=>p.frame)).toEqual(selected);expect(page.header.picture.map(p=>p.sourceSha256)).toEqual(selected.map(n=>baseline[n]));expect(page.picture.length).toBe(selected.length);expect(Object.keys(page.audio)).toEqual([]);expect(page.header.frames).toBe(Math.min(60,f.frames-from));
    }expect(cache.stats.pages).toBe(3);}finally{await cache.close();}
    for(const pictureFrames of [[],[59],[60,60],[61,60],[120],[NaN]])expect(()=>source.identity(60,{includePicture:true,audioLanes:[],pictureFrames})).toThrow();
    expect(()=>source.identity(60,{includePicture:false,audioLanes:["mix"],pictureFrames:[60]})).toThrow();
    const t=initialEditTimeline([f.source],f.source.id,640,360),{revision:_r,...data}=t,lower=t.clips.find(c=>c.lane==="picture")!,upper={...lower,id:"upper",layer:1,from:101,at:70,frames:1,link:null};
    const cut=editTimeline({...data,clips:[lower,upper]});expect(previewRequests(cut,70,2)).toEqual([{sourceId:f.source.id,from:60,includePicture:true,audioLanes:[],pictureFrames:[71,101]}]);
    const single=editTimeline({...data,clips:[{...lower,from:91,at:0,frames:1,link:null}]});expect(previewRequests(single,0,60)[0]?.pictureFrames).toEqual([91]);
  }finally{f.close();}
},60000);
test("server preview mixing rejects missing originals, overload and permission loss, and renders an empty window as exact silence",async()=>{
  const f=await fixture();try{
    const source=await EditPreviewSource.prepare(f.source,f.media,f.root,join(f.root,"index"),access),t=initialEditTimeline([f.source],f.source.id,640,360),missing=new EditPreviewMix(t,[],f.root);
    await expect(missing.page(0,join(f.root,"missing"),access)).rejects.toThrow("not prepared");expect(existsSync(join(f.root,"missing"))).toBe(false);
    const loud=applyEditOperation(t,{kind:"settings",clipId:"initial-1",gainDb:12,opacity:1,crop:null,fadeIn:0,fadeOut:0}),mix=new EditPreviewMix(loud,[source],f.root);
    await expect(mix.page(0,join(f.root,"overload"),access)).rejects.toThrow("would clip");expect(existsSync(join(f.root,"overload"))).toBe(false);
    const clean=new EditPreviewMix(t,[source],f.root);await expect(clean.page(0,join(f.root,"withdrawn-mix"),async()=>{if(existsSync(join(f.root,"withdrawn-mix")))throw new Error("permission withdrawn");})).rejects.toThrow("permission withdrawn");expect(existsSync(join(f.root,"withdrawn-mix"))).toBe(false);
    const controller=new AbortController();await expect(clean.page(0,join(f.root,"cancelled-mix"),async()=>{if(existsSync(join(f.root,"cancelled-mix")))controller.abort(new Error("cancelled mix"));},controller.signal)).rejects.toThrow("cancelled mix");expect(existsSync(join(f.root,"cancelled-mix"))).toBe(false);
    const {revision:_r,...data}=t,gap=new EditPreviewMix(editTimeline({...data,clips:[]}),[],f.root),result=await gap.page(120,join(f.root,"silence"),access),page=await decodePreviewPage(readFileSync(join(f.root,result.file.path)),{sourceKey:gap.sourceKey,from:120,sha256:result.file.sha256});expect(Buffer.from(page.audio.mix!)).toEqual(Buffer.alloc(7*1600*6));
  }finally{f.close();}
},60000);
test("preview refuses lane overload even if another lane would cancel it, and does not expose partial output",async()=>{
  const f=await fixture();try{const t=initialEditTimeline([f.source],f.source.id,640,360),clip=t.clips.find(c=>c.lane==="mix")!,renderer=new PreviewAudioRenderer([{...clip,gainDb:12},{...clip,id:"inverse",lane:"effects",gainDb:12}]),positive=Buffer.alloc(60*1600*6),negative=Buffer.alloc(60*1600*6);for(let i=0;i<60*1600*2;i++){positive.writeIntLE(3000000,i*3,3);negative.writeIntLE(-3000000,i*3,3);}const left=new Float32Array(128).fill(1),right=new Float32Array(128).fill(1);
    expect(()=>renderer.render(0,left,right,(_id,lane)=>lane==="mix"?positive:negative)).toThrow("would clip");expect([...left,...right].every(n=>n===0)).toBe(true);
  }finally{f.close();}
},60000);
test("indexed pages reject changed audio or picture and remove their own incomplete output",async()=>{
  const f=await fixture();try{const source=await EditPreviewSource.prepare(f.source,f.media,f.root,join(f.root,"index"),access),wav=readFileSync(join(f.root,"sound.wav"));wav[44+60*1600*6+9]^=1;writeFileSync(join(f.root,"sound.wav"),wav);
    await expect(source.page(60,join(f.root,"bad-audio"),access)).rejects.toThrow("samples changed");expect(existsSync(join(f.root,"bad-audio"))).toBe(false);writeFileSync(join(f.root,"sound.wav"),soundWav(f.pcm));
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-y","-f","lavfi","-i","color=red:s=640x360:r=30","-frames:v",String(f.frames),"-c:v","libx264","-threads","1",f.picture],f.root,access);
    await expect(source.page(60,join(f.root,"bad-picture"),access)).rejects.toThrow("different original frames");expect(existsSync(join(f.root,"bad-picture"))).toBe(false);
  }finally{f.close();}
},60000);
test("preview cancellation, withdrawn access and junctions cannot leave or create unowned media",async()=>{
  const f=await fixture(),outside=realpathSync(mkdtempSync(join(tmpdir(),"hv-preview-outside-")));try{const source=await EditPreviewSource.prepare(f.source,f.media,f.root,join(f.root,"index"),access),abort=new AbortController();abort.abort();await expect(source.page(0,join(f.root,"cancelled"),access,abort.signal)).rejects.toThrow();expect(existsSync(join(f.root,"cancelled"))).toBe(false);
    await expect(source.page(0,join(f.root,"withdrawn"),async()=>{if(existsSync(join(f.root,"withdrawn")))throw new Error("permission withdrawn");})).rejects.toThrow("permission withdrawn");expect(existsSync(join(f.root,"withdrawn"))).toBe(false);
    symlinkSync(outside,join(f.root,"link"),process.platform==="win32"?"junction":"dir");await expect(source.page(0,join(f.root,"link/new/page"),access)).rejects.toThrow("escaped");expect(readdirSync(outside)).toEqual([]);rmSync(join(f.root,"link"));
  }finally{f.close();cleanup(outside);}
},60000);


test("retimed B-frame picture, speech and fades agree between server preview, source-page playback and full export",async()=>{
  const f=await fixture();try{
    const source=await EditPreviewSource.prepare(f.source,f.media,f.root,join(f.root,"index"),access);let t=initialEditTimeline([f.source],f.source.id,640,360);
    t=applyEditOperation(t,{kind:"settings",clipId:"initial-1",gainDb:-12,opacity:1,crop:null,fadeIn:3,fadeOut:4});t=applyEditOperation(t,{kind:"retime",clipId:"initial-0",linked:true,from:60,frames:60,points:[{frame:0,rate:500},{frame:20,rate:1500},{frame:35,rate:0},{frame:45,rate:0},{frame:60,rate:2000}],ripple:true});
    t=applyEditOperation(t,{kind:"split",clipId:"initial-0",linked:true,at:29,rightIds:{"initial-0":"right-picture","initial-1":"right-mix","initial-2":"right-captions"},rightLink:"right"});
    const report=await conformEdit(t,[f.media],f.root,join(f.root,"export"),access),full=readFileSync(join(f.root,"export/audio/final.wav")).subarray(44),baseline=await editFrameHashes(f.picture,f.frames,join(f.root,"baseline.txt"),f.root,access);
    expect(report.picture.recipe.schema).toBe("hv-edit-picture/3");const wanted=Array.from({length:t.frames},(_,i)=>previewPicture(t,i)[0]!.sourceFrame);expect(report.pictureFrames).toEqual(wanted.map(f=>baseline[f]!));expect(report.picture.parts.flatMap(p=>p.layers.flatMap(l=>l.sourceFrames??[]))).toEqual(wanted);
    expect(readdirSync(join(f.root,"export")).some(p=>p.startsWith(".picture-work"))).toBe(false);expect(full.subarray(35*1600*6,45*1600*6).every(n=>n===0)).toBe(true);
    const mixed=new EditPreviewMix(t,[source],f.root),page=await mixed.page(0,join(f.root,"mix"),access),decoded=await decodePreviewPage(readFileSync(join(f.root,page.file.path)),{sourceKey:mixed.sourceKey,from:0,sha256:page.file.sha256});expect(Buffer.from(decoded.audio.mix!)).toEqual(full);
    const pages=new Map<number,Uint8Array>();for(const from of [0,60,120])pages.set(from,await source.audioPage(from,"mix",access));const renderer=new PreviewAudioRenderer(t.clips,4096,t.sources),preview=Buffer.alloc(full.length);
    for(let at=0;at<t.frames*1600;at+=4096){const n=Math.min(4096,t.frames*1600-at),left=new Float32Array(n),right=new Float32Array(n);expect(renderer.render(at,left,right,(_id,_lane,from)=>pages.get(from))).toBe(true);for(let i=0;i<n;i++){preview.writeIntLE(left[i]!*8388608,(at+i)*6,3);preview.writeIntLE(right[i]!*8388608,(at+i)*6+3,3);}}
    expect(preview).toEqual(full);const left=new Float32Array(128).fill(1),right=new Float32Array(128).fill(1);expect(renderer.render(0,left,right,()=>undefined)).toBe(false);expect([...left,...right].every(n=>n===0)).toBe(true);
    let calls=0;await expect(mixed.page(0,join(f.root,"withdrawn-retime"),async()=>{if(++calls===4)throw new Error("Retime access withdrawn");})).rejects.toThrow("withdrawn");expect(existsSync(join(f.root,"withdrawn-retime"))).toBe(false);
  }finally{f.close();}
},60000);

test("maximum-speed selections and final-source-frame holds conform without sampling past retained picture",async()=>{
  const f=await fixture();try{const baseline=await editFrameHashes(f.picture,f.frames,join(f.root,"baseline.txt"),f.root,access);
    for(const [label,from,frames,rate]of [["fast",0,15,8000],["hold",126,61,0]] as const){let t=initialEditTimeline([f.source],f.source.id,640,360);t=applyEditOperation(t,{kind:"retime",clipId:"initial-0",linked:true,from,frames,points:[{frame:0,rate},{frame:frames,rate}],ripple:true});const directory=join(f.root,label);mkdirSync(directory);const result=await conformEditPicture(t,new Map([[f.source.id,f.picture]]),directory,access);expect(result.pictureFrames).toEqual(Array.from({length:frames},(_,i)=>baseline[from+i*rate/1000]!));}
  }finally{f.close();}
},60000);
