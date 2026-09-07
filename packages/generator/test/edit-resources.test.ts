import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync,statfsSync} from "node:fs";
import {join,sep} from "node:path";
import {tmpdir} from "node:os";
import {contentHash} from "../src/capabilities";
import {assertEditFreeSpace,editWorkspaceGuard} from "../src/edit-workspace";
import {editStorageEstimate,assertEditStorageEstimate,EDIT_STORAGE_LIMITS} from "../../planner/src/edit-resources";
import {initialEditTimeline,type EditSource} from "../../planner/src/edit-timeline";
test("editorial capacity counts retained originals and all canonical lanes, and rejects an oversized lossless assembly",()=>{
  const source:EditSource={id:"film",label:"Original",revision:contentHash("resource-fixture"),frames:108000,width:1920,height:1080,audio:["mix"],voices:[],captions:[],unmeasuredAudio:true},timeline=initialEditTimeline([source],source.id,1920,1080);
  const large=editStorageEstimate(timeline,[]);expect(large.pictureBytes).toBe(108000*1920*1080*3);expect(large.outputBytes).toBeGreaterThan(EDIT_STORAGE_LIMITS.outputBytes);expect(()=>assertEditStorageEstimate(large)).toThrow("workspace estimate");
  const small=editStorageEstimate(initialEditTimeline([{...source,frames:30,width:640,height:360}],source.id,640,360),[]);expect(()=>assertEditStorageEstimate(small)).not.toThrow();expect(small.laneBytes).toBe(7*(44+30*1600*6));
  const retained=editStorageEstimate(initialEditTimeline([{...source,frames:30,width:640,height:360}],source.id,640,360),[{source:{facts:source,files:[{path:"project/film/master.wav",bytes:64,sha256:contentHash("record")}],audio:{mix:{kind:"copy48",path:"project/film/master.wav"},dialogue:{kind:"copy48",path:"project/film/dialogue.wav"}}}}]);expect(retained.originalBytes).toBe(64);expect(retained.canonicalBytes).toBe(2073600088);expect(retained.outputBytes-small.outputBytes).toBe(2073600152);
  expect(()=>assertEditStorageEstimate({...small,files:EDIT_STORAGE_LIMITS.files+1})).toThrow("too many source files");
});
test("editorial workspace checks available disk, owned paths and actual byte/file growth",()=>{
  const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,"hv-edit-capacity-")),owned=join(root,"owned");mkdirSync(owned);writeFileSync(join(owned,"first"),Buffer.alloc(32));writeFileSync(join(owned,"second"),Buffer.alloc(32));
  try{
    expect(()=>editWorkspaceGuard(root,()=>[owned],{bytes:64,files:2})()).not.toThrow();expect(()=>editWorkspaceGuard(root,()=>[owned],{bytes:63,files:2})()).toThrow("workspace capacity");expect(()=>editWorkspaceGuard(root,()=>[owned],{bytes:64,files:1})()).toThrow("workspace capacity");
    expect(()=>editWorkspaceGuard(root,()=>[parent])()).toThrow("escaped its owner");const disk=statfsSync(root,{bigint:true});expect(()=>assertEditFreeSpace(root,Number(disk.bavail*disk.bsize)+1)).toThrow("free workspace");
  }finally{const remove=()=>{if(!realpathSync(root).startsWith(parent+sep+"hv-edit-capacity-"))throw new Error("Unsafe resource fixture cleanup");rmSync(root,{recursive:true,force:true});};remove();}
});
