import {expect,test} from "bun:test";
import {deflateSync} from "node:zlib";
import {decodePreviewPage,encodePreviewPage,previewDigest,previewPngDimensions,PREVIEW_RECIPE,PREVIEW_RGBA_RECIPE,type PreviewPageIdentity} from "../src/edit-preview-protocol";

const signature=Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type:string,data:Uint8Array){
  const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(type,4,"ascii");bytes.set(data,8);let crc=0xffffffff;
  for(const value of bytes.subarray(4,-4)){crc^=value;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}
  bytes.writeUInt32BE((crc^0xffffffff)>>>0,bytes.length-4);return bytes;
}
function ihdr(patch:(header:Buffer)=>void=()=>{}){const h=Buffer.alloc(13);h.writeUInt32BE(16,0);h.writeUInt32BE(16,4);h[8]=8;h[9]=6;patch(h);return chunk("IHDR",h);}
const image=()=>chunk("IDAT",deflateSync(Buffer.alloc(16*(1+16*4)))),end=()=>chunk("IEND",new Uint8Array());
const png=(parts:Uint8Array[]=[ihdr(),image(),end()])=>Buffer.concat([signature,...parts]);
const base:PreviewPageIdentity={sourceKey:"a".repeat(64),sourceId:"native-original",sourceRevision:"b".repeat(64),engineVersion:"ffmpeg-sound-"+"c".repeat(64),sourceFrames:2,from:0,frames:2,width:16,height:16,includePicture:true,audioLanes:[],pictureEncoding:"png-rgba"};
const packet=()=>encodePreviewPage(base,[0,1].map(frame=>({frame,sourceSha256:"d".repeat(64),data:png()})),[]);
const decode=async(bytes:Uint8Array)=>decodePreviewPage(bytes,{sourceKey:base.sourceKey,from:0,sha256:await previewDigest(bytes)});
function rewrite(bytes:Uint8Array,change:(header:any)=>void){const size=new DataView(bytes.buffer,bytes.byteOffset).getUint32(8,true),header=JSON.parse(new TextDecoder().decode(bytes.subarray(12,12+size)));change(header);const encoded=new TextEncoder().encode(JSON.stringify(header)),result=new Uint8Array(bytes.length-size+encoded.length);result.set(bytes.subarray(0,8));new DataView(result.buffer).setUint32(8,encoded.length,true);result.set(encoded,12);result.set(bytes.subarray(12+size),12+encoded.length);return result;}

test("native preview packets bind PNG encoding to schema, recipe, dimensions and picture-only selection",async()=>{
  const original=await packet(),decoded=await decode(original);expect(decoded.header).toMatchObject({...base,schema:"hv-edit-preview-page/2",recipe:PREVIEW_RGBA_RECIPE});expect(decoded.picture).toHaveLength(2);expect(decoded.audio).toEqual({});
  for(const change of [(h:any)=>h.schema="hv-edit-preview-page/1",(h:any)=>h.recipe=PREVIEW_RECIPE,(h:any)=>delete h.pictureEncoding,(h:any)=>h.pictureEncoding="jpeg",(h:any)=>h.width=18,(h:any)=>h.audioLanes=["mix"],(h:any)=>{delete h.pictureEncoding;h.schema="hv-edit-preview-page/1";h.recipe=PREVIEW_RECIPE;}])await expect(decode(rewrite(original,change))).rejects.toThrow();
  await expect(encodePreviewPage({...base,includePicture:false,audioLanes:["mix"]},[],[{lane:"mix",data:new Uint8Array(2*1600*6)}])).rejects.toThrow("native-alpha");
});

test("PNG inspection accepts the native frame envelope, offset views and declared pixel units",()=>{
  const bytes=png(),wrapped=Buffer.concat([Buffer.alloc(9),bytes,Buffer.alloc(7)]);expect(previewPngDimensions(wrapped.subarray(9,-7))).toEqual({width:16,height:16});
  for(const unit of [0,1]){const physical=Buffer.alloc(9);physical.writeUInt32BE(1,0);physical.writeUInt32BE(1,4);physical[8]=unit;expect(previewPngDimensions(png([ihdr(),chunk("pHYs",physical),image(),end()]))).toEqual({width:16,height:16});}
});

test("PNG inspection rejects unsupported coding, overlarge dimensions and malformed metadata before image decoding",()=>{
  for(const change of [(h:Buffer)=>h.writeUInt32BE(0,0),(h:Buffer)=>h.writeUInt32BE(481,0),(h:Buffer)=>h.writeUInt32BE(271,4),(h:Buffer)=>h[8]=16,(h:Buffer)=>h[9]=2,(h:Buffer)=>h[10]=1,(h:Buffer)=>h[11]=1,(h:Buffer)=>h[12]=1])expect(()=>previewPngDimensions(png([ihdr(change),image(),end()]))).toThrow();
  const physical=Buffer.alloc(9);physical[8]=2;expect(()=>previewPngDimensions(png([ihdr(),chunk("pHYs",physical),image(),end()]))).toThrow("pixel metadata");
  for(const type of ["acTL","fcTL","fdAT","tEXt","iCCP","eXIf"] )expect(()=>previewPngDimensions(png([ihdr(),chunk(type,new Uint8Array([1])),image(),end()]))).toThrow("unsupported PNG chunk");
});

test("PNG inspection bounds chunks and rejects checksum, order, truncation and trailing-byte changes",()=>{
  const original=png(),changed=Buffer.from(original);changed[changed.length-1]^=1;expect(()=>previewPngDimensions(changed)).toThrow("checksum");
  for(const parts of [[image(),ihdr(),end()],[ihdr(),ihdr(),image(),end()],[ihdr(),end()],[ihdr(),chunk("IDAT",new Uint8Array()),end()],[ihdr(),image(),chunk("pHYs",Buffer.alloc(9)),end()],[ihdr(),chunk("pHYs",Buffer.alloc(9)),chunk("pHYs",Buffer.alloc(9)),image(),end()],[ihdr(),image(),chunk("IEND",new Uint8Array([0]))],[ihdr(),image()]])expect(()=>previewPngDimensions(png(parts))).toThrow();
  const hugeChunk=Buffer.from(original);hugeChunk.writeUInt32BE(0xffffffff,8);expect(()=>previewPngDimensions(hugeChunk)).toThrow("truncated");expect(()=>previewPngDimensions(original.subarray(0,-1))).toThrow();expect(()=>previewPngDimensions(Buffer.concat([original,Buffer.from([0])]))).toThrow();expect(()=>previewPngDimensions(Buffer.alloc(512*1024+1))).toThrow("envelope");
  expect(()=>previewPngDimensions(png([ihdr(),...Array.from({length:4095},()=>chunk("IDAT",new Uint8Array([0]))),end()]))).toThrow("chunk");
});
