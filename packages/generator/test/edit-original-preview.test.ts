import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {decodePng} from "@hyperframes/engine";
import {EditPreviewSource} from "../src/edit-preview-media";
import {EditPreviewComposite} from "../src/edit-preview-composite";
import {editOriginalPng} from "../src/edit-original-png";
import {soundProcessingCommand} from "../src/sound-finishing";
import {soundDigest} from "../src/sound-media";
import {contentHash} from "../src/capabilities";
import {editTimeline,type EditSource,type EditClip} from "../../planner/src/edit-timeline";
import {composeEditCompositeFrame} from "../../planner/src/edit-composite-render";
import {decodePreviewPage,encodePreviewPage,PREVIEW_RGBA_RECIPE,previewDigest} from "../../planner/src/edit-preview-protocol";
const access=async()=>{},hash=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
function cleanup(root:string){const parent=realpathSync(tmpdir());if(!root.startsWith(parent+sep+"hv-original-preview-")||realpathSync(root)!==root)throw new Error("Unsafe original preview cleanup");rmSync(root,{recursive:true,force:true});}
async function fixture(width=64,height=48,frames=91){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-original-preview-"))),sources:EditSource[]=[],prepared:EditPreviewSource[]=[],originals=new Map<string,Buffer>(),paths=new Map<string,string>();
  try{
    for(const id of ["film","graphic"]){const path=join(root,id+".mkv");if(id==="film")await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i",`testsrc2=s=${width}x${height}:r=30`,"-frames:v",String(frames),"-an","-c:v","libx264","-preset","veryfast","-g","90","-bf","3","-sc_threshold","0","-threads","1",path],root,access);
      else{const raw=Buffer.alloc(width*height*4*frames);for(let f=0;f<frames;f++)for(let y=0;y<height;y++)for(let x=0;x<width;x++)raw.set([170+f%40,20,30,x<width/3?0:x<width*2/3?128:255],(f*width*height+y*width+x)*4);writeFileSync(join(root,"native.raw"),raw);await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","rawvideo","-pixel_format","rgba","-video_size",`${width}x${height}`,"-framerate","30","-i",join(root,"native.raw"),"-frames:v",String(frames),"-an","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","bgra",path],root,access);}
      paths.set(id,path);const s:EditSource={id,revision:contentHash(id),label:id,width,height,frames,audio:[],captions:[],voices:[],unmeasuredAudio:false,...(id==="graphic"?{media:"graphic-rgba" as const}:{})};sources.push(s);const media={id,picture:{path:id+".mkv",...await soundDigest(path)},audio:{}};prepared.push(await EditPreviewSource.prepare(s,media,root,join(root,id+"-index"),access));
      const raw=join(root,id+"-decoded.raw");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-threads","1","-i",path,"-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-fps_mode","passthrough","-f","rawvideo",raw],root,access);originals.set(id,readFileSync(raw));
    }
    return {root,sources,prepared,originals,paths};
  }catch(error){cleanup(root);throw error;}
}
function clip(id:string,sourceId:string,layer:number,from=0):EditClip{return {id,sourceId,layer,lane:"picture",at:0,from,frames:2,gainDb:0,opacity:1,link:null,crop:null,envelope:{from,frames:2,fadeIn:0,fadeOut:0}};}

test("lossless original lookup verifies B-frame seeks at zero, page seam and final frame; native PNG alpha survives",async()=>{
  const f=await fixture();try{
    for(const source of f.prepared)for(const frame of [0,59,60,90]){const directory=join(f.root,source.source.id+"-frame-"+frame),result=await source.rawFrame(frame,directory,access),original=f.originals.get(source.source.id)!.subarray(frame*64*48*4,(frame+1)*64*48*4);expect(result.data).toEqual(original);expect(result.sourceSha256).toBe(hash(original));expect(existsSync(directory)).toBe(false);const png=await editOriginalPng(result,f.root,join(f.root,source.source.id+"-png-"+frame),access),decoded=decodePng(png.bytes);expect([decoded.width,decoded.height]).toEqual([64,48]);expect(Buffer.from(decoded.data).equals(original)).toBe(true);expect(png.sha256).toBe(hash(png.bytes));}
    const source=f.prepared[1]!,abort=new AbortController();abort.abort();await expect(source.rawFrame(0,join(f.root,"aborted"),access,abort.signal)).rejects.toThrow();expect(existsSync(join(f.root,"aborted"))).toBe(false);let calls=0;await expect(source.rawFrame(1,join(f.root,"withdrawn"),async()=>{if(++calls>=3)throw new Error("source withdrawn after decode");})).rejects.toThrow("withdrawn");expect(existsSync(join(f.root,"withdrawn"))).toBe(false);
    const originalFile=readFileSync(f.paths.get("graphic")!),replacement=join(f.root,"changed.mkv");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","color=c=yellow:s=64x48:r=30","-frames:v","91","-an","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","bgra",replacement],f.root,access);writeFileSync(f.paths.get("graphic")!,readFileSync(replacement));await expect(source.rawFrame(60,join(f.root,"changed-frame"),access)).rejects.toThrow("changed");expect(existsSync(join(f.root,"changed-frame"))).toBe(false);writeFileSync(f.paths.get("graphic")!,originalFile);
    const raw=await source.rawFrame(0,join(f.root,"png-original"),access);await expect(editOriginalPng(raw,f.root,join(f.root,"png-aborted"),access,abort.signal)).rejects.toThrow();let pngAccess=0;await expect(editOriginalPng(raw,f.root,join(f.root,"png-withdrawn"),async()=>{if(++pngAccess>=3)throw new Error("PNG source withdrawn");})).rejects.toThrow("withdrawn");expect(existsSync(join(f.root,"png-withdrawn"))).toBe(false);
  }finally{cleanup(f.root);}
},60000);

test("sparse composite PNG identity binds full-resolution composition before one final resize",async()=>{
  const f=await fixture(640,360,3);try{
    const clips=[clip("base","film",0),clip("foreground","graphic",1),clip("matte","film",2,1)];clips[1]!.composite={schema:"hv-edit-composite/1",masks:[{id:"ellipse",label:"Foreground mask",kind:"ellipse",sourceRevision:f.sources[1]!.revision,combine:"replace",invert:false,featherQ8:512,keyframes:[{sourceFrame:0,interpolation:"linear",geometry:{xQ16:8192,yQ16:8192,widthQ16:49152,heightQ16:49152}}]}],matte:{layer:2,channel:"luma",invert:false}};
    const timeline=editTimeline({schema:"hv-edit-timeline/2",width:640,height:360,frames:2,sources:f.sources,clips,markers:[],matteOnlyLayers:[2]}),preview=new EditPreviewComposite(timeline,f.prepared,f.root),selection={includePicture:true,audioLanes:[] as [],pictureFrames:[1]},page=await preview.page(0,join(f.root,"composite-page"),access,undefined,selection),bytes=readFileSync(join(f.root,page.file.path)),decoded=await decodePreviewPage(bytes,{sourceKey:preview.sourceKey,from:0,sha256:page.file.sha256});
    expect(decoded.header).toMatchObject({schema:"hv-edit-preview-page/3",sourceId:"timeline-picture",picturePurpose:"timeline-composite",pictureFrames:[1],width:480,height:270});expect(decoded.picture).toHaveLength(1);expect(decoded.audio).toEqual({});
    const full=await composeEditCompositeFrame(timeline,1,(id,frame)=>({width:640,height:360,data:f.originals.get(id)!.subarray(frame*640*360*4,(frame+1)*640*360*4)}));expect(decoded.header.picture[0]!.sourceSha256).toBe(hash(full));writeFileSync(join(f.root,"expected-full.rgba"),full);
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-filter_threads","1","-f","rawvideo","-pixel_format","rgba","-video_size","640x360","-i",join(f.root,"expected-full.rgba"),"-vf","scale=480:270:flags=lanczos+accurate_rnd,format=rgba,setsar=1","-frames:v","1","-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-f","rawvideo",join(f.root,"expected-small.rgba")],f.root,access);expect(Buffer.from(decodePng(Buffer.from(decoded.picture[0]!)).data)).toEqual(readFileSync(join(f.root,"expected-small.rgba")));
    const jpegPage=await f.prepared[0]!.page(0,join(f.root,"film-jpeg"),access,undefined,selection),jpeg=await decodePreviewPage(readFileSync(join(f.root,jpegPage.file.path)),{sourceKey:f.prepared[0]!.sourceKey,from:0,sha256:jpegPage.file.sha256});await expect(encodePreviewPage(page.identity,[{frame:1,sourceSha256:hash(full),data:jpeg.picture[0]!}],[])).rejects.toThrow("PNG");
    expect(()=>preview.identity(0,{...selection,pictureFrames:[0,1]})).toThrow("one exact frame");const changed=applyPlacement(timeline),other=new EditPreviewComposite(changed,f.prepared,f.root);expect(other.sourceKey).not.toBe(preview.sourceKey);const missing=new EditPreviewComposite(timeline,[f.prepared[1]!],f.root);await expect(missing.page(0,join(f.root,"missing"),access,undefined,selection)).rejects.toThrow("dependency");expect(existsSync(join(f.root,"missing"))).toBe(false);
    const abort=new AbortController();abort.abort();await expect(preview.page(0,join(f.root,"aborted-composite"),access,abort.signal,selection)).rejects.toThrow();let checks=0;await expect(preview.page(0,join(f.root,"withdrawn-composite"),async()=>{if(++checks>=2)throw new Error("composite revoked");},undefined,selection)).rejects.toThrow("revoked");expect(existsSync(join(f.root,"withdrawn-composite"))).toBe(false);
    // A resealed old PNG header is still a different purpose and must fail the protocol's pairing checks.
    const size=bytes.readUInt32LE(8),header={...decoded.header,schema:"hv-edit-preview-page/2",recipe:PREVIEW_RGBA_RECIPE},json=Buffer.from(JSON.stringify(header)),prefix=Buffer.from(bytes.subarray(0,12));prefix.writeUInt32LE(json.length,8);const disguised=Buffer.concat([prefix,json,bytes.subarray(12+size)]);await expect(decodePreviewPage(disguised,{sourceKey:preview.sourceKey,from:0,sha256:await previewDigest(disguised)})).rejects.toThrow("requested source");
  }finally{cleanup(f.root);}
},120000);
function applyPlacement(t:ReturnType<typeof editTimeline>){const {revision:_revision,...data}=structuredClone(t);data.clips.find(c=>c.id==="foreground")!.composite!.placement={xQ16:1,yQ16:0,scaleQ16:65536,rotationMilliDegrees:0};return editTimeline(data);}
