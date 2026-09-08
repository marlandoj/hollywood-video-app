import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {contentHash} from "../src/capabilities";
import {conformEditAudio,conformEditAssemblyAudio,type EditConformSource} from "../src/edit-conform";
import {soundWav,soundWavHeader} from "../src/sound-audio";
import {soundDigest} from "../src/sound-media";
import {createEditAssemblyPlan} from "../../planner/src/edit-assembly-clock";
import {EDIT_AUDIO_LANES,editTimeline,type EditClip,type EditSource,type EditTransition} from "../../planner/src/edit-timeline";

async function fixture(alignment:"center"|"start"|"end"){
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-assembly-audio-")));
  const close=()=>{if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe assembly audio cleanup");rmSync(root,{recursive:true,force:true});};
  try{
    const source:EditSource={id:"original",revision:contentHash("assembly audio fixture"),label:"Six synthetic lanes",frames:120,width:32,height:24,audio:[...EDIT_AUDIO_LANES],voices:[],captions:[],unmeasuredAudio:false};
    const audio:EditConformSource["audio"]={};
    for(const [index,lane]of EDIT_AUDIO_LANES.entries()){
      const pcm=Buffer.alloc(source.frames*1600*6);
      for(let sample=0;sample<source.frames*1600;sample++)for(let channel=0;channel<2;channel++)pcm.writeIntLE(((sample*(index+3)+channel*91)%20003)-10001,sample*6+channel*3,3);
      const path=lane+".wav";writeFileSync(join(root,path),soundWav(pcm));audio[lane]={path,...await soundDigest(join(root,path))};
    }
    const clips:EditClip[]=[],transitions:EditTransition[]=[];
    for(const lane of EDIT_AUDIO_LANES){
      for(const side of ["left","right"] as const){
        const from=side==="left"?10:70,clip:EditClip={id:lane+"-"+side,sourceId:source.id,lane,layer:0,link:null,at:side==="left"?0:30,from,frames:30,gainDb:-3,opacity:1,crop:null,envelope:{from,frames:30,fadeIn:0,fadeOut:0}};
        if(lane==="dialogue"&&side==="left")clip.timing={from,offset:0,points:[{frame:0,rate:500},{frame:30,rate:1500}]};
        if(lane==="ambience"&&side==="right")clip.timing={from,offset:0,points:[{frame:0,rate:0},{frame:30,rate:0}]};
        clips.push(clip);
      }
      transitions.push({id:lane+"-transition",kind:"crossfade",leftId:lane+"-left",rightId:lane+"-right",frames:9,alignment});
    }
    clips.push({...structuredClone(clips[0]!),id:"overlap",at:15,from:15,frames:20,gainDb:-6,envelope:{from:15,frames:20,fadeIn:5,fadeOut:5}});
    const timeline=editTimeline({schema:"hv-edit-timeline/1",width:32,height:24,frames:60,sources:[source],clips,markers:[],transitions});
    const plan=createEditAssemblyPlan({sequenceId:"parent",historyRevision:contentHash("saved parent"),timeline,sourceReceipts:[{sourceId:source.id,receiptRevision:contentHash("receipt")}]},[
      {id:"later",fromFrame:31,toFrame:37,reason:"Begin within the outgoing transition."},
      {id:"earlier",fromFrame:24,toFrame:32,reason:"Retain partial fade and ramp timing."},
      {id:"held",fromFrame:41,toFrame:45,reason:"Preserve muted held ambience."},
      {id:"repeat",fromFrame:31,toFrame:37,reason:"Repeat the same retained performance."}
    ]);
    const media:EditConformSource[]=[{id:source.id,picture:{path:"unused.mkv",sha256:contentHash("unused"),bytes:1},audio}];
    return {root,close,plan,timeline,media};
  }catch(error){close();throw error;}
}

for(const alignment of ["center","start","end"] as const)test(`assembly audio matches all seven parent waveforms across partial ${alignment} dissolves, ramps, holds and reordered repeats`,async()=>{
  const f=await fixture(alignment);try{
    const parent=join(f.root,"parent"),child=join(f.root,"child");
    await conformEditAudio(f.timeline,f.media,f.root,parent,async()=>{});
    const report=await conformEditAssemblyAudio(f.plan,f.media,f.root,child,async()=>{});
    for(const lane of [...EDIT_AUDIO_LANES,"final"]){
      const source=readFileSync(join(parent,lane+".wav")).subarray(44),actual=readFileSync(join(child,lane+".wav"));
      const selected=Buffer.concat(f.plan.ranges.map(range=>source.subarray(range.fromFrame*1600*6,range.toFrame*1600*6)));
      expect(actual.subarray(0,44).equals(soundWavHeader(f.plan.frames*1600))).toBe(true);
      expect(actual.subarray(44).equals(selected)).toBe(true);
      expect(actual.length).toBe(44+f.plan.frames*1600*6);
    }
    expect(report.planRevision).toBe(f.plan.revision);expect(report.parentTimelineRevision).toBe(f.timeline.revision);expect(report.join).toBe("cut");
    const {revision,...data}=report;expect(revision).toBe(contentHash(data));
    const held=readFileSync(join(child,"ambience.wav")).subarray(44+(6+8)*1600*6,44+(6+8+4)*1600*6);expect(held.every(value=>value===0)).toBe(true);
  }finally{f.close();}
},60000);

test("assembly audio preserves current permission, cancellation and source integrity fences",async()=>{
  const f=await fixture("center");try{
    await expect(conformEditAssemblyAudio(f.plan,f.media,f.root,join(f.root,"denied"),async()=>{throw new Error("permission withdrawn");})).rejects.toThrow("permission withdrawn");
    const controller=new AbortController();controller.abort(new Error("cancelled assembly"));
    await expect(conformEditAssemblyAudio(f.plan,f.media,f.root,join(f.root,"cancel"),async()=>{},controller.signal)).rejects.toThrow();
    const path=join(f.root,"mix.wav"),changed=readFileSync(path);changed[45]^=1;writeFileSync(path,changed);
    await expect(conformEditAssemblyAudio(f.plan,f.media,f.root,join(f.root,"changed"),async()=>{})).rejects.toThrow("source changed");
  }finally{f.close();}
},60000);
