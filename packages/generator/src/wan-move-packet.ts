import {createHash} from "node:crypto";
import {lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {gateOrThrow} from "../../safety/src/index";
import {contentHash} from "./capabilities";
import {subjectMotionPlan,sampleSubjectTrack,SUBJECT_MOTION_FRAMES,SUBJECT_MOTION_FPS,SUBJECT_MOTION_STRIDE,type SubjectMotionPlan} from "../../planner/src/subject-motion";

export const WAN_MOVE_SOURCE_COMMIT="80c58a7d2ad175fa82a4d57f79f2a1415317dcfa";
const MAX_BYTES=4*1024**2;
export const MAX_MOTION_PLAN_BYTES=512*1024;
const sha256=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
const json=(value:unknown)=>Buffer.from(JSON.stringify(value,null,2)+"\n");
export type WanMovePacket=Record<"source.png"|"plan.json"|"tracks.npy"|"visibility.npy"|"manifest.json",Buffer>;
const FILES=["source.png","plan.json","tracks.npy","visibility.npy","manifest.json"] as const;

/** NPY 1.0, little endian float32 or one-byte booleans, C order, no pickle/object dtype. */
function npy(shape:number[],dtype:"<f4"|"|b1",payload:Buffer):Buffer {
  const description=`{'descr': '${dtype}', 'fortran_order': False, 'shape': (${shape.join(", ")}), }`;
  const padding=(64-(10+Buffer.byteLength(description)+1)%64)%64,header=Buffer.from(description+" ".repeat(padding)+"\n","ascii");
  const prefix=Buffer.from([147,78,85,77,80,89,1,0,0,0]);prefix.writeUInt16LE(header.length,8);
  return Buffer.concat([prefix,header,payload]);
}
function validatePng(bytes:Buffer,width:number,height:number):void {
  if(bytes.length<45||bytes.length>MAX_BYTES||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error("Provide a complete PNG of at most 4 MiB.");
  let offset=8,first=true,ended=false,hasData=false;
  while(offset+12<=bytes.length){
    const length=bytes.readUInt32BE(offset),end=offset+12+length,type=bytes.toString("ascii",offset+4,offset+8);
    if(end>bytes.length||!/^[A-Za-z]{4}$/.test(type))throw new Error("Invalid PNG chunk.");
    let crc=0xffffffff;for(const byte of bytes.subarray(offset+4,end-4)){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    if(((crc^0xffffffff)>>>0)!==bytes.readUInt32BE(end-4))throw new Error("Invalid PNG checksum.");
    if(first){if(type!=="IHDR"||length!==13||bytes.readUInt32BE(offset+8)!==width||bytes.readUInt32BE(offset+12)!==height)throw new Error("Source image dimensions differ from the plan.");first=false;}
    else if(type==="IHDR")throw new Error("Invalid duplicate PNG header.");
    if(type==="acTL")throw new Error("Use a still PNG, not an animation.");
    if(type==="IDAT")hasData=true;
    if(type==="IEND"){if(length!==0||end!==bytes.length)throw new Error("Invalid PNG ending.");ended=true;break;}
    offset=end;
  }
  if(!ended||!hasData)throw new Error("The source PNG is incomplete.");
}
const decodeArguments=["ffmpeg","-v","error","-xerror","-f","image2pipe","-c:v","png","-i","pipe:0","-frames:v","1","-f","null","-"];
function preparePacket(input:unknown,sourcePng:Buffer):SubjectMotionPlan {
  const plan=subjectMotionPlan(input);
  gateOrThrow([plan.prompt,...plan.subjects.map(subject=>subject.label)].join("\n"));
  if(sha256(sourcePng)!==plan.source.sha256)throw new Error("The source image changed. Place or review the points against its exact bytes.");
  validatePng(sourcePng,plan.source.width,plan.source.height);
  return plan;
}
export function compileWanMovePacket(input:unknown,sourcePng:Buffer):WanMovePacket {
  const plan=preparePacket(input,sourcePng),decoded=Bun.spawnSync(decodeArguments,{stdin:sourcePng,timeout:15000});
  if(decoded.exitCode!==0||decoded.stderr.length)throw new Error("The source PNG could not be decoded.");
  return encodePacket(plan,sourcePng);
}
/** API exports decode without blocking the event loop and cancel on client disconnect. */
export async function compileWanMovePacketAsync(input:unknown,sourcePng:Buffer,signal:AbortSignal):Promise<WanMovePacket> {
  const bytes=Buffer.from(sourcePng),plan=preparePacket(input,bytes),deadline=AbortSignal.any([signal,AbortSignal.timeout(15000)]);deadline.throwIfAborted();
  const child=Bun.spawn(decodeArguments,{stdin:bytes,stdout:"ignore",stderr:"pipe"}),abort=()=>{child.kill();};
  deadline.addEventListener("abort",abort,{once:true});
  try{if(deadline.aborted)abort();const [code,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);deadline.throwIfAborted();
    if(code!==0||stderr)throw new Error("The source PNG could not be decoded.");return encodePacket(plan,bytes);
  }finally{deadline.removeEventListener("abort",abort);}
}
function encodePacket(plan:SubjectMotionPlan,sourcePng:Buffer):WanMovePacket {
  const tracks=plan.subjects.flatMap(subject=>subject.tracks.map(track=>({subjectId:subject.id,trackId:track.id,track})));
  const positions=Buffer.alloc(SUBJECT_MOTION_FRAMES*tracks.length*2*4),visibility=Buffer.alloc(SUBJECT_MOTION_FRAMES*tracks.length);
  for(let frame=0;frame<SUBJECT_MOTION_FRAMES;frame++)for(const [index,{track}]of tracks.entries()){
    const point=sampleSubjectTrack(track,frame),slot=frame*tracks.length+index;
    positions.writeFloatLE(point.x/10000*(plan.source.width-1),slot*8);
    positions.writeFloatLE(point.y/10000*(plan.source.height-1),slot*8+4);
    visibility[slot]=point.visible?1:0;
  }
  const data={"source.png":Buffer.from(sourcePng),"plan.json":json(plan),"tracks.npy":npy([1,SUBJECT_MOTION_FRAMES,tracks.length,2],"<f4",positions),"visibility.npy":npy([1,SUBJECT_MOTION_FRAMES,tracks.length],"|b1",visibility)};
  const manifest={schema:"hv-wan-move-packet/1",status:"inputs-only",planRevision:contentHash(plan),
    model:{repository:"https://github.com/ali-vilab/Wan-Move",sourceCommit:WAN_MOVE_SOURCE_COMMIT,checkpoint:"Ruihang/Wan-Move-14B-480P"},
    coordinates:{origin:"top-left",units:"source-image-pixels",order:["x","y"],normalizedExtent:10000,pixelExtent:[plan.source.width-1,plan.source.height-1]},
    timeline:{frames:SUBJECT_MOTION_FRAMES,fps:SUBJECT_MOTION_FPS,lastSampleSeconds:80/SUBJECT_MOTION_FPS,encodedDurationSeconds:SUBJECT_MOTION_FRAMES/SUBJECT_MOTION_FPS,nativeConditioningStride:SUBJECT_MOTION_STRIDE},
    trackOrder:tracks.map(({subjectId,trackId})=>({subjectId,trackId})),
    inputArguments:["--task","wan-move-i2v","--size",`${plan.source.width}*${plan.source.height}`,"--image","source.png","--track","tracks.npy","--track_visibility","visibility.npy","--frame_num","81","--base_seed",String(plan.seed),"--prompt",plan.prompt],
    files:Object.fromEntries(Object.entries(data).map(([name,bytes])=>[name,{bytes:bytes.length,sha256:sha256(bytes)}]))};
  return {...data,"manifest.json":json({...manifest,revision:contentHash(manifest)})};
}
export function writeWanMovePacket(output:string,packet:WanMovePacket):string {
  const directory=resolve(output);
  // Reserving a new directory refuses existing exports. Manifest is written last as the completion marker.
  mkdirSync(directory,{mode:0o700});
  for(const name of FILES)writeFileSync(join(directory,name),packet[name],{flag:"wx",mode:0o600});
  return directory;
}
export function readPacketInput(path:string,max=MAX_BYTES):Buffer {
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw new Error("Use a regular file within the input size limit.");
  const bytes=readFileSync(path);if(bytes.length>max)throw new Error("Input exceeds its size limit.");return bytes;
}
/** Verify all bytes and semantics before passing a packet to a separately authorized GPU renderer. */
export function verifyWanMovePacket(directory:string):{revision:string;subjects:number;tracks:number;rendered:false} {
  if(lstatSync(directory).isSymbolicLink()||!lstatSync(directory).isDirectory()||readdirSync(directory).sort().join(",")!==[...FILES].sort().join(","))throw new Error("Use a complete input packet directory with exactly its five files.");
  const plan=subjectMotionPlan(JSON.parse(readPacketInput(join(directory,"plan.json"),MAX_MOTION_PLAN_BYTES).toString("utf8")));
  const expected=compileWanMovePacket(plan,readPacketInput(join(directory,"source.png")));
  for(const name of FILES)if(!readPacketInput(join(directory,name)).equals(expected[name]))throw new Error("The input packet changed: "+name+". Compile a new packet from the reviewed plan.");
  const manifest=JSON.parse(expected["manifest.json"].toString("utf8"));
  return {revision:manifest.revision,subjects:plan.subjects.length,tracks:manifest.trackOrder.length,rendered:false};
}
