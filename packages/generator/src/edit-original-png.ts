import {createHash} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import {editFail} from "../../planner/src/edit-errors";
import {soundProcessingCommand} from "./sound-finishing";
import {assertEditFreeSpace,editWorkspaceGuard} from "./edit-workspace";

export async function editOriginalPng(frame:{width:number;height:number;data:Uint8Array},root:string,path:string,access:()=>Promise<void>,signal?:AbortSignal,dimensions?:{width:number;height:number}){
  root=realpathSync(root);path=resolve(path);if(!path.startsWith(root+sep)||existsSync(path)||!Number.isSafeInteger(frame.width)||!Number.isSafeInteger(frame.height)||frame.width<2||frame.width>3840||frame.height<2||frame.height>2160||frame.data.length!==frame.width*frame.height*4)editFail("Choose a bounded original picture frame.");
  const parent=dirname(path);if(parent!==root&&!parent.startsWith(root+sep)||realpathSync(parent)!==parent)editFail("Original frame output escaped its workspace.");
  if(dimensions&&(!Number.isSafeInteger(dimensions.width)||!Number.isSafeInteger(dimensions.height)||dimensions.width<2||dimensions.width>480||dimensions.height<2||dimensions.height>270))editFail("Choose bounded final preview dimensions.");
  await access();signal?.throwIfAborted();assertEditFreeSpace(root,128*1024**2);mkdirSync(path);if(lstatSync(path).isSymbolicLink()||realpathSync(path)!==path)editFail("Original frame output escaped its workspace.");
  const input=join(path,"frame.rgba"),output=join(path,"frame.png"),disk=editWorkspaceGuard(root,()=>[path],{bytes:128*1024**2,files:2}),permission=async()=>{signal?.throwIfAborted();await access();disk();};
  try{
    writeFileSync(input,frame.data,{flag:"wx"});await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_threads","1","-f","rawvideo","-pixel_format","rgba","-video_size",`${frame.width}x${frame.height}`,"-framerate","30","-threads","1","-i",input,...(dimensions?["-vf",`scale=${dimensions.width}:${dimensions.height}:flags=lanczos+accurate_rnd,format=rgba,setsar=1`]:[]),"-frames:v","1","-an","-c:v","png","-threads","1","-pix_fmt","rgba",output],path,permission,signal);
    if(statSync(output).size>64*1024**2)editFail("Original picture exceeds its frame capacity.");await permission();const bytes=readFileSync(output);return {bytes,sha256:createHash("sha256").update(bytes).digest("hex")};
  }finally{if(realpathSync(path)!==path||!path.startsWith(root+sep))editFail("Original frame cleanup escaped its workspace.");rmSync(path,{recursive:true,force:true});}
}
