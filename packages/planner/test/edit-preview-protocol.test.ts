import {expect,test} from "bun:test";
import {decodePreviewPage,encodePreviewPage,previewDigest,previewPcmSample,PREVIEW_MAX_BYTES,type PreviewPageIdentity} from "../src/edit-preview-protocol";
const base:PreviewPageIdentity={sourceKey:"a".repeat(64),sourceId:"original",sourceRevision:"b".repeat(64),engineVersion:"ffmpeg-sound-"+"c".repeat(64),sourceFrames:2,from:0,frames:2,width:16,height:16,includePicture:false,audioLanes:["mix"]};
const packet=()=>encodePreviewPage(base,[],[{lane:"mix",data:new Uint8Array(2*1600*6)}]);
const decode=async(bytes:Uint8Array,expected:Partial<{sourceKey:string;from:number;sha256:string}>={})=>decodePreviewPage(bytes,{sourceKey:base.sourceKey,from:0,sha256:await previewDigest(bytes),...expected});
function rewrite(bytes:Uint8Array,change:(header:any)=>void){const view=new DataView(bytes.buffer,bytes.byteOffset),size=view.getUint32(8,true),h=JSON.parse(new TextDecoder().decode(bytes.subarray(12,12+size)));change(h);const header=new TextEncoder().encode(JSON.stringify(h)),output=new Uint8Array(bytes.length-size+header.length);output.set(bytes.subarray(0,8));new DataView(output.buffer).setUint32(8,header.length,true);output.set(header,12);output.set(bytes.subarray(12+size),12+header.length);return output;}
test("audio-only preview pages preserve their explicit lane selection and signed 24-bit samples",async()=>{
  const data=await decode(await packet());expect(data.picture).toEqual([]);expect(Object.keys(data.audio)).toEqual(["mix"]);expect(data.header).toMatchObject(base);
  const pcm=new Uint8Array([0,0,128,255,255,127,255,255,255,0,0,0]);expect([previewPcmSample(pcm,0,0),previewPcmSample(pcm,0,1),previewPcmSample(pcm,1,0),previewPcmSample(pcm,1,1)]).toEqual([-8388608,8388607,-1,0]);expect(()=>previewPcmSample(pcm,2,0)).toThrow();
});
test("preview decoding rejects forged source identities, fields, offsets, lanes and timing even after resealing a packet",async()=>{
  const original=await packet();for(const change of [(h:any)=>h.from=60,(h:any)=>h.frames=1,(h:any)=>h.sourceFrames=1,(h:any)=>h.width=10000,(h:any)=>h.sampleRate=22050,(h:any)=>h.extra=true,(h:any)=>h.audio[0].offset=1,(h:any)=>h.audio[0].bytes--,(h:any)=>h.audio[0].sha256="d".repeat(64),(h:any)=>h.audio[0].lane="dialogue",(h:any)=>h.audioLanes=["mix","mix"],(h:any)=>h.includePicture=true,(h:any)=>h.picture=[null]])await expect(decode(rewrite(original,change))).rejects.toThrow();
  await expect(decode(original,{sourceKey:"d".repeat(64)})).rejects.toThrow();await expect(decode(original,{sha256:"d".repeat(64)})).rejects.toThrow();await expect(decode(original,{from:60})).rejects.toThrow();
});
test("preview packets reject missing, changed or unowned bytes and stay within their size limit",async()=>{
  const original=await packet(),changed=original.slice();changed[changed.length-1]=1;await expect(decode(changed)).rejects.toThrow();await expect(decode(original.subarray(0,original.length-1))).rejects.toThrow();const extra=new Uint8Array(original.length+1);extra.set(original);await expect(decode(extra)).rejects.toThrow();const oversized=new Uint8Array(PREVIEW_MAX_BYTES+1);await expect(decodePreviewPage(oversized,{sourceKey:base.sourceKey,from:0,sha256:"d".repeat(64)})).rejects.toThrow();
  await expect(encodePreviewPage({...base,audioLanes:[]},[],[])).rejects.toThrow();await expect(encodePreviewPage(base,[],[])).rejects.toThrow();
});
