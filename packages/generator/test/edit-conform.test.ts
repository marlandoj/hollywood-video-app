import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {contentHash} from "../src/capabilities";
import {soundWav} from "../src/sound-audio";
import {soundDigest} from "../src/sound-media";
import {soundProcessingCommand} from "../src/sound-finishing";
import {conformEdit,conformEditAudio,editFrameHashes,type EditConformSource} from "../src/edit-conform";
import {applyEditOperation,editTimeline,initialEditTimeline,type EditTimeline,type EditSource} from "../../planner/src/edit-timeline";
async function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-editorial-"))),picture=join(root,"source.mkv"),pcm=Buffer.alloc(90*1600*6);for(let i=0;i<90*1600;i++)for(let ch=0;ch<2;ch++)pcm.writeIntLE(Math.round(3000000*Math.sin(i*2*Math.PI*(ch?330:440)/48000)),i*6+ch*3,3);writeFileSync(join(root,"source.wav"),soundWav(pcm));
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin",...['red','green','blue'].flatMap(c=>["-f","lavfi","-i",`color=c=${c}:s=64x48:r=30:d=1`]),"-filter_complex","[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]","-map","[out]","-an","-c:v","ffv1","-level","3",picture],root,async()=>{});
  const s:EditSource={id:"film",revision:contentHash("source"),label:"Synthetic red green blue",frames:90,width:64,height:48,audio:["mix"],unmeasuredAudio:false,voices:[{id:"red",start:4800,end:40000,lane:"dialogue"},{id:"green",start:52800,end:88000,lane:"dialogue"},{id:"blue",start:100800,end:136000,lane:"dialogue"}],captions:[{id:"red",start:4800,end:40000,text:"Red line"},{id:"green",start:52800,end:88000,text:"Green line"},{id:"blue",start:100800,end:136000,text:"Blue line"}]};
  const media:EditConformSource[]=[{id:s.id,picture:{path:"source.mkv",...await soundDigest(picture)},audio:{mix:{path:"source.wav",...await soundDigest(join(root,"source.wav"))}}}];return {root,pcm,media,timeline:initialEditTimeline([s],s.id,64,48),async render(t:EditTimeline,name:string){return conformEdit(t,media,root,join(root,name),async()=>{});},close(){if(!root.startsWith(realpathSync(tmpdir())+sep))throw new Error("Unsafe editorial test cleanup");rmSync(root,{recursive:true,force:true});}};
}
function split(t:EditTimeline){t=applyEditOperation(t,{kind:"split",clipId:"initial-0",linked:true,at:30,rightIds:{"initial-0":"b-video","initial-1":"b-mix","initial-2":"b-captions"},rightLink:"b"});return applyEditOperation(t,{kind:"split",clipId:"b-video",linked:true,at:60,rightIds:{"b-video":"c-video","b-mix":"c-mix","b-captions":"c-captions"},rightLink:"c"});}
test("full-resolution conform reorders actual frames, exact PCM and captions without an extra or repeated end frame",async()=>{
  const f=await fixture();try{const original=await editFrameHashes(join(f.root,"source.mkv"),90,join(f.root,"original-frames.txt"),f.root,async()=>{}),t=applyEditOperation(split(f.timeline),{kind:"reorder",clipId:"b-video",at:60}),report=await f.render(t,"reordered");expect(report.pictureFrames).toEqual([...original.slice(0,30),...original.slice(60),...original.slice(30,60)]);const expected=Buffer.concat([f.pcm.subarray(0,30*1600*6),f.pcm.subarray(60*1600*6),f.pcm.subarray(30*1600*6,60*1600*6)]);expect(readFileSync(join(f.root,"reordered/audio/final.wav")).subarray(44).equals(expected)).toBe(true);const captions=readFileSync(join(f.root,"reordered/captions.vtt"),"utf8");expect(captions.indexOf("Blue line")).toBeLessThan(captions.indexOf("Green line"));expect(captions).toContain("00:00:02.100 --> 00:00:02.834");expect(report.speechCuts).toEqual([]);expect(readFileSync(join(f.root,"reordered/hls/index.m3u8"),"utf8")).toContain("#EXT-X-ENDLIST");
  }finally{f.close();}
},60000);
test("split picture/audio fades preserve playback exactly and a moved upper layer ends at its declared boundary",async()=>{
  const f=await fixture();try{let t=applyEditOperation(f.timeline,{kind:"settings",clipId:"initial-0",opacity:.8,gainDb:0,crop:null,fadeIn:45,fadeOut:30});t=applyEditOperation(t,{kind:"settings",clipId:"initial-1",opacity:1,gainDb:-3,crop:null,fadeIn:45,fadeOut:30});const a=await f.render(t,"whole"),b=await f.render(split(t),"split");expect(b.pictureFrames).toEqual(a.pictureFrames);expect(b.audio).toEqual(a.audio);
    const layer={...structuredClone(f.timeline.clips.find(c=>c.lane==="picture")!),id:"upper",link:null,layer:1,from:60,at:20,frames:10,envelope:{from:60,frames:10,fadeIn:0,fadeOut:0}};const over=applyEditOperation(f.timeline,{kind:"insert",clips:[layer]}),r=await f.render(over,"overlay"),original=await editFrameHashes(join(f.root,"source.mkv"),90,join(f.root,"reference-frames.txt"),f.root,async()=>{});expect(r.pictureFrames.slice(0,20)).toEqual(original.slice(0,20));expect(r.pictureFrames.slice(20,30)).toEqual(original.slice(60,70));expect(r.pictureFrames.slice(30)).toEqual(original.slice(30));
  }finally{f.close();}
},60000);
test("editorial conform refuses changed source timing, overlapping audio overload, cancellation and withdrawn access",async()=>{
  const f=await fixture();try{const {revision:_revision,...data}=f.timeline,wrong=editTimeline({...data,sources:data.sources.map(s=>({...s,frames:91}))});await expect(f.render(wrong,"bad-source")).rejects.toThrow("decoded frame count");const c=f.timeline.clips.find(c=>c.lane==="mix")!,over=applyEditOperation(f.timeline,{kind:"insert",clips:[{...structuredClone(c),id:"loud-two",link:null},{...structuredClone(c),id:"loud-three",link:null}]});await expect(conformEditAudio(over,f.media,f.root,join(f.root,"overload"),async()=>{})).rejects.toThrow("would clip");
    const abort=new AbortController();abort.abort();await expect(conformEdit(f.timeline,f.media,f.root,join(f.root,"cancelled"),async()=>{},abort.signal)).rejects.toThrow();await expect(conformEdit(f.timeline,f.media,f.root,join(f.root,"withdrawn"),async()=>{throw new Error("rights withdrawn");})).rejects.toThrow("rights withdrawn");
  }finally{f.close();}
},60000);
test("slipped split clips preserve source addresses and a deleted range yields black picture and exact silence",async()=>{
  const f=await fixture();try{const original=await editFrameHashes(join(f.root,"source.mkv"),90,join(f.root,"reference-frames.txt"),f.root,async()=>{}),slipped=applyEditOperation(split(f.timeline),{kind:"slip",clipId:"b-video",linked:true,delta:-4}),r=await f.render(slipped,"slipped");expect(r.pictureFrames).toEqual([...original.slice(0,30),...original.slice(26,56),...original.slice(60)]);const audio=readFileSync(join(f.root,"slipped/audio/final.wav")).subarray(44);expect(audio.subarray(30*1600*6,60*1600*6).equals(f.pcm.subarray(26*1600*6,56*1600*6))).toBe(true);
    const gap=applyEditOperation(split(f.timeline),{kind:"delete",clipId:"b-video",linked:true,ripple:false}),g=await f.render(gap,"gap"),black=Buffer.alloc(64*48*3/2,128);black.fill(16,0,64*48);const blackHash=createHash("sha256").update(black).digest("hex");expect(g.pictureFrames.slice(30,60)).toEqual(Array(30).fill(blackHash));expect(g.pictureFrames.slice(60)).toEqual(original.slice(60));expect(readFileSync(join(f.root,"gap/audio/final.wav")).subarray(44+30*1600*6,44+60*1600*6).every(b=>b===0)).toBe(true);
  }finally{f.close();}
},60000);
