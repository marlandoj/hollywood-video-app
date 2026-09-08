import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {contentHash} from "../src/capabilities";
import {conformEdit,conformEditAssembly,type EditConformSource} from "../src/edit-conform";
import {soundWav} from "../src/sound-audio";
import {soundDigest} from "../src/sound-media";
import {soundProcessingCommand} from "../src/sound-finishing";
import {createEditAssemblyPlan} from "../../planner/src/edit-assembly-clock";
import {parseEditCaptions} from "../../planner/src/edit-captions";
import {EDIT_AUDIO_LANES,initialEditTimeline,applyEditOperation,type EditSource} from "../../planner/src/edit-timeline";

function removeAssemblyFixture(root:string):void {
  if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe assembly export cleanup");
  rmSync(root,{recursive:true,force:true});
}

test("full assembly export binds independent lossless picture, all PCM, caption clocks, MP4 and HLS to its frozen parent",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-assembly-export-")));
  try{
    const video=join(root,"original.mkv"),wav=join(root,"original.wav"),pcm=Buffer.alloc(90*1600*6);
    for(let sample=0;sample<90*1600;sample++)for(let channel=0;channel<2;channel++)pcm.writeIntLE(((sample*(channel+3))%10001)-5000,sample*6+channel*3,3);
    writeFileSync(wav,soundWav(pcm));
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","testsrc2=size=32x24:rate=30:duration=3","-an","-c:v","ffv1","-threads","1",video],root,async()=>{});
    const source:EditSource={id:"original",label:"Synthetic retained film",revision:contentHash("original"),frames:90,width:32,height:24,audio:["mix"],captions:[{id:"whole",start:1,end:90*1600,text:"Retained & repeated <words>"}],voices:[{id:"spoken",start:1,end:90*1600,lane:"dialogue"}],unmeasuredAudio:false};
    let timeline=initialEditTimeline([source],source.id,32,24);
    timeline=applyEditOperation(timeline,{kind:"split",clipId:"initial-0",linked:true,at:30,rightIds:{"initial-0":"right-picture","initial-1":"right-audio","initial-2":"right-captions"},rightLink:"right"});
    timeline=applyEditOperation(timeline,{kind:"crossfade",leftId:"initial-0",rightId:"right-picture",linked:true,frames:9,alignment:"center",ids:{"initial-0":"picture-dissolve","initial-1":"sound-dissolve"}});
    const media:EditConformSource[]=[{id:source.id,picture:{path:"original.mkv",...await soundDigest(video)},audio:{mix:{path:"original.wav",...await soundDigest(wav)}}}];
    const plan=createEditAssemblyPlan({sequenceId:"original-cut",historyRevision:contentHash("original history"),timeline,sourceReceipts:[{sourceId:source.id,receiptRevision:contentHash("retained receipt")}]},[
      {id:"later",fromFrame:63,toFrame:72,reason:"Open on later retained frames."},
      {id:"dissolve",fromFrame:27,toFrame:34,reason:"Keep part of the original dissolve."},
      {id:"earlier",fromFrame:14,toFrame:25,reason:"Return to earlier coverage."},
      {id:"repeat",fromFrame:27,toFrame:34,reason:"Repeat the retained dissolve."}
    ]);
    const frozen=JSON.stringify(plan),parent=await conformEdit(timeline,media,root,join(root,"parent"),async()=>{});
    const output=join(root,"assembly"),result=await conformEditAssembly(plan,media,root,output,async()=>{});
    expect(plan.frames).toBe(34);expect(JSON.stringify(plan)).toBe(frozen);
    expect(result.picture.pictureFrames).toEqual(plan.ranges.flatMap(range=>parent.pictureFrames.slice(range.fromFrame,range.toFrame)));
    for(const lane of [...EDIT_AUDIO_LANES,"final"]){
      const original=readFileSync(join(root,"parent/audio",lane+".wav")).subarray(44),selected=Buffer.concat(plan.ranges.map(range=>original.subarray(range.fromFrame*1600*6,range.toFrame*1600*6)));
      expect(readFileSync(join(output,"audio",lane+".wav")).subarray(44).equals(selected)).toBe(true);
    }
    const captions=readFileSync(join(output,"captions.vtt"),"utf8"),parsed=parseEditCaptions(captions,plan.frames);
    expect(parsed.at(-1)!.end).toBe(plan.frames*1600);expect(parsed.every(cue=>cue.text===source.captions[0]!.text)).toBe(true);
    expect(result.captionsSha256).toBe(createHash("sha256").update(captions).digest("hex"));
    expect(JSON.parse(readFileSync(join(output,"assembly.json"),"utf8"))).toEqual(plan);
    expect(JSON.parse(readFileSync(join(output,"timeline.json"),"utf8"))).toEqual(timeline);
    expect(JSON.parse(readFileSync(join(output,"conform.json"),"utf8"))).toEqual(result);
    const probe=JSON.parse(readFileSync(join(output,"export-probe.json"),"utf8"));expect(probe.streams.find((stream:any)=>stream.codec_type==="video").r_frame_rate).toBe("30/1");
    expect(readFileSync(join(output,"export-frames.txt"),"utf8").split(/\r?\n/).filter(line=>line&&!line.startsWith("#"))).toHaveLength(plan.frames);
    expect(readFileSync(join(output,"hls/index.m3u8"),"utf8")).toContain("#EXT-X-ENDLIST");
    const {revision,...data}=result;expect(revision).toBe(contentHash(data));expect(result.schema).toBe("hv-edit-assembly-conform/1");
    expect(result.rangeReview.repeatedFrames).toBe(7);expect(result.sourceFiles).toHaveLength(2);
    await expect(conformEditAssembly(plan,media,root,output,async()=>{})).rejects.toThrow("new owned");
    await expect(conformEditAssembly(plan,media,root,join(root,"withdrawn"),async()=>{throw new Error("rights withdrawn");})).rejects.toThrow("rights withdrawn");
  }finally{removeAssemblyFixture(root);}
},60000);
