/** Browser-compatible wire format. This module deliberately has no runtime imports. */
export const PREVIEW_PAGE_FRAMES=60,PREVIEW_MAX_BYTES=16*1024**2,PREVIEW_MAX_HEADER=64*1024;
export const PREVIEW_RECIPE="jpeg-q5-lanczos-480x270-pcm24-v1";
export const PREVIEW_AUDIO_LANES=["mix","dialogue","narration","music","ambience","effects"] as const;
export type PreviewLane=typeof PREVIEW_AUDIO_LANES[number];
export interface PreviewSelection {includePicture:boolean;audioLanes:PreviewLane[];pictureFrames?:number[]}
export interface PreviewPageIdentity extends PreviewSelection {
  sourceKey:string;sourceId:string;sourceRevision:string;engineVersion:string;
  sourceFrames:number;from:number;frames:number;width:number;height:number;
}
interface PreviewSlice {offset:number;bytes:number;sha256:string}
export interface PreviewPageHeader extends PreviewPageIdentity {
  schema:"hv-edit-preview-page/1";recipe:typeof PREVIEW_RECIPE;fps:30;sampleRate:48000;
  picture:(PreviewSlice&{frame:number;sourceSha256:string})[];
  audio:(PreviewSlice&{lane:PreviewLane})[];
}
export interface DecodedPreviewPage {header:PreviewPageHeader;picture:Uint8Array[];audio:Partial<Record<PreviewLane,Uint8Array>>}
// AudioWorklet imports the PCM reader, but does not expose TextEncoder globally.
const magic=new Uint8Array([72,86,80,82,88,89,49,10]); // HVPRXY1\n
const fail=(message:string):never=>{throw new Error("Preview media: "+message);};
const integer=(v:unknown,min:number,max:number)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const hash=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
function keys(value:unknown,names:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!names.includes(k)))fail("unsupported fields.");}
export async function previewDigest(bytes:Uint8Array):Promise<string>{const digest=await crypto.subtle.digest("SHA-256",new Uint8Array(bytes));return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,"0")).join("");}
export function previewDimensions(width:number,height:number):{width:number;height:number}{
  if(!integer(width,16,3840)||!integer(height,16,2160))fail("invalid source dimensions.");
  const ratio=Math.min(1,480/width,270/height);return {width:Math.max(2,Math.floor(width*ratio/2)*2),height:Math.max(2,Math.floor(height*ratio/2)*2)};
}
function identity(h:PreviewPageIdentity):void {
  if(!hash(h.sourceKey)||!hash(h.sourceRevision)||typeof h.sourceId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(h.sourceId)||typeof h.engineVersion!=="string"||!/^ffmpeg-sound-[a-f0-9]{64}$/.test(h.engineVersion))fail("source identity changed.");
  if(!integer(h.sourceFrames,1,108000)||!integer(h.from,0,h.sourceFrames-1)||h.from%PREVIEW_PAGE_FRAMES||h.frames!==Math.min(PREVIEW_PAGE_FRAMES,h.sourceFrames-h.from))fail("source page timing changed.");
  if(!integer(h.width,2,480)||!integer(h.height,2,270)||h.width%2||h.height%2)fail("invalid proxy dimensions.");
  if(typeof h.includePicture!=="boolean"||!Array.isArray(h.audioLanes)||h.audioLanes.length>6||!h.includePicture&&!h.audioLanes.length)fail("choose picture or sound for the page.");
  let previous=-1;for(const lane of h.audioLanes){const index=PREVIEW_AUDIO_LANES.indexOf(lane);if(index<=previous)fail("invalid requested sound lanes.");previous=index;}
  if(h.pictureFrames!==undefined){
    if(!h.includePicture||!Array.isArray(h.pictureFrames)||!h.pictureFrames.length||h.pictureFrames.length>h.frames)fail("invalid requested picture frames.");
    let previous=h.from-1;for(const frame of h.pictureFrames){if(!integer(frame,h.from,h.from+h.frames-1)||frame<=previous)fail("invalid requested picture frames.");previous=frame;}
  }
}
export function previewPictureFrames(h:PreviewPageIdentity):number[]{return h.includePicture?h.pictureFrames??Array.from({length:h.frames},(_,i)=>h.from+i):[];}
/** Read dimensions before handing encoded data to a browser image decoder. */
export function previewJpegDimensions(data:Uint8Array):{width:number;height:number}{
  if(data.length<12||data.length>512*1024||data[0]!==255||data[1]!==216||data.at(-2)!==255||data.at(-1)!==217)fail("invalid JPEG envelope.");
  let at=2,dimensions:{width:number;height:number}|undefined;
  while(at<data.length-2){
    if(data[at++]!==255)fail("invalid JPEG marker.");while(data[at]===255)at++;
    const marker=data[at++];if(marker===undefined||at+2>data.length)fail("truncated JPEG marker.");
    const length=data[at]!*256+data[at+1]!;if(length<2||at+length>data.length-2)fail("truncated JPEG segment.");
    if(marker===192){if(dimensions||length<11||data[at+2]!==8)fail("unsupported JPEG frame.");dimensions={height:data[at+3]!*256+data[at+4]!,width:data[at+5]!*256+data[at+6]!};}
    else if(marker>=193&&marker<=207&&![196,200,204].includes(marker))fail("unsupported JPEG coding.");
    if(marker===218)return dimensions??fail("JPEG has no dimensions.");
    at+=length;
  }
  return fail("JPEG has no scan.");
}
function jpeg(data:Uint8Array,h:PreviewPageIdentity):void{const actual=previewJpegDimensions(data);if(actual.width!==h.width||actual.height!==h.height)fail("JPEG dimensions changed.");}
export async function encodePreviewPage(base:PreviewPageIdentity,pictures:{frame:number;sourceSha256:string;data:Uint8Array}[],audio:{lane:PreviewLane;data:Uint8Array}[]):Promise<Uint8Array>{
  keys(base,["sourceKey","sourceId","sourceRevision","engineVersion","sourceFrames","from","frames","width","height","includePicture","audioLanes","pictureFrames"]);identity(base);
  const header:PreviewPageHeader={...base,schema:"hv-edit-preview-page/1",recipe:PREVIEW_RECIPE,fps:30,sampleRate:48000,picture:[],audio:[]},payload:Uint8Array[]=[];let offset=0;
  const selected=previewPictureFrames(base);
  if(pictures.length!==selected.length||JSON.stringify(audio.map(a=>a.lane))!==JSON.stringify(base.audioLanes))fail("incomplete picture or sound page.");
  for(const [i,p]of pictures.entries()){if(p.frame!==selected[i]||!hash(p.sourceSha256))fail("picture frame identity changed.");jpeg(p.data,base);header.picture.push({frame:p.frame,sourceSha256:p.sourceSha256,offset,bytes:p.data.length,sha256:await previewDigest(p.data)});payload.push(p.data);offset+=p.data.length;}
  let previous=-1;for(const a of audio){const lane=PREVIEW_AUDIO_LANES.indexOf(a.lane);if(lane<=previous||a.data.length!==base.frames*1600*6)fail("sound lanes changed order or sample count.");previous=lane;header.audio.push({lane:a.lane,offset,bytes:a.data.length,sha256:await previewDigest(a.data)});payload.push(a.data);offset+=a.data.length;}
  const text=new TextEncoder().encode(JSON.stringify(header));if(text.length>PREVIEW_MAX_HEADER||offset+text.length+12>PREVIEW_MAX_BYTES)fail("page exceeds its memory limit.");
  const packet=new Uint8Array(12+text.length+offset);packet.set(magic);new DataView(packet.buffer).setUint32(8,text.length,true);packet.set(text,12);let at=12+text.length;for(const part of payload){packet.set(part,at);at+=part.length;}return packet;
}
export async function decodePreviewPage(packet:Uint8Array,expected:{sourceKey:string;from:number;sha256:string}):Promise<DecodedPreviewPage>{
  if(packet.length<12||packet.length>PREVIEW_MAX_BYTES||magic.some((n,i)=>packet[i]!==n)||!hash(expected.sha256)||await previewDigest(packet)!==expected.sha256)fail("page checksum or envelope changed.");
  const size=new DataView(packet.buffer,packet.byteOffset,packet.byteLength).getUint32(8,true);if(size>PREVIEW_MAX_HEADER||size<2||size>packet.length-12)fail("invalid header length.");
  let h:PreviewPageHeader;try{h=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(packet.subarray(12,12+size)));}catch{return fail("invalid header JSON.");}
  keys(h,["schema","recipe","fps","sampleRate","sourceKey","sourceId","sourceRevision","engineVersion","sourceFrames","from","frames","width","height","picture","audio","includePicture","audioLanes","pictureFrames"]);identity(h);
  const selected=previewPictureFrames(h);
  if(h.schema!=="hv-edit-preview-page/1"||h.recipe!==PREVIEW_RECIPE||h.fps!==30||h.sampleRate!==48000||h.sourceKey!==expected.sourceKey||h.from!==expected.from||!Array.isArray(h.picture)||h.picture.length!==selected.length||!Array.isArray(h.audio)||h.audio.length!==h.audioLanes.length)fail("page no longer matches the requested source.");
  const payload=packet.subarray(12+size),pictures:Uint8Array[]=[],audio:DecodedPreviewPage["audio"]={};let offset=0;
  async function slice(s:PreviewSlice):Promise<Uint8Array>{if(s.offset!==offset||!integer(s.bytes,1,payload.length-offset)||!hash(s.sha256))fail("invalid media offsets.");const data=payload.subarray(offset,offset+s.bytes);offset+=s.bytes;if(await previewDigest(data)!==s.sha256)fail("media checksum changed.");return data;}
  for(const [i,p]of h.picture.entries()){keys(p,["frame","sourceSha256","offset","bytes","sha256"]);if(p.frame!==selected[i]||!hash(p.sourceSha256))fail("picture frame order changed.");const data=await slice(p);jpeg(data,h);pictures.push(data);}
  let previous=-1;for(const [i,a]of h.audio.entries()){keys(a,["lane","offset","bytes","sha256"]);const lane=PREVIEW_AUDIO_LANES.indexOf(a.lane);if(lane<=previous||a.lane!==h.audioLanes[i]||a.bytes!==h.frames*1600*6)fail("sound lanes changed order or sample count.");previous=lane;audio[a.lane]=await slice(a);}
  if(offset!==payload.length)fail("unowned trailing media.");return {header:h,picture:pictures,audio};
}
export function previewPcmSample(pcm:Uint8Array,index:number,channel:0|1):number{
  const at=index*6+channel*3;if(!integer(index,0,Math.floor(pcm.length/6)-1)||channel!==0&&channel!==1)fail("sample is outside its page.");
  const value=pcm[at]!+pcm[at+1]!*256+pcm[at+2]!*65536;return value>=8388608?value-16777216:value;
}
