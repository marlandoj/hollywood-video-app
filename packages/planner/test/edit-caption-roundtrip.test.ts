import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {editVtt} from "../../generator/src/edit-conform";
import {editAssemblyVtt} from "../../generator/src/edit-assembly-captions";
import {parseEditCaptions} from "../src/edit-captions";
import {createEditAssemblyPlan} from "../src/edit-assembly-clock";
import {EDIT_MAX_FRAMES,initialEditTimeline,type EditSource} from "../src/edit-timeline";

const S=1600,text="A & B < C > D";
function timeline(frames:number,captionText=text){const source:EditSource={id:"original",revision:contentHash("original"),label:"Original",frames,width:64,height:48,audio:[],captions:[{id:"line",start:0,end:frames*S,text:captionText}],voices:[],unmeasuredAudio:false};return initialEditTimeline([source],source.id,64,48);}
function timestamp(ms:number):string {return "00:00:"+String(Math.floor(ms/1000)).padStart(2,"0")+"."+String(ms%1000).padStart(3,"0");}
const cue=(startMs:number,endMs:number)=>"WEBVTT\n\noriginal-cue\n"+timestamp(startMs)+" --> "+timestamp(endMs)+"\nA &amp; B\n";

test("editVtt roundtrips final cues at one, two, three and sixty-one frame boundaries",()=>{
  for(const frames of [1,2,3,61]){const t=timeline(frames),vtt=editVtt(t),parsed=parseEditCaptions(vtt,frames);expect(vtt).toContain(" --> "+timestamp(Math.ceil(frames*S/48)));expect(parsed).toHaveLength(1);expect(parsed[0]).toMatchObject({start:0,end:frames*S,text});expect(parseEditCaptions(vtt,frames)).toEqual(parsed);}
});

test("editAssemblyVtt roundtrips clipped parent captions at exact child frame ends",()=>{
  const t=timeline(90),parent={sequenceId:"sequence",historyRevision:contentHash("history"),timeline:t,sourceReceipts:t.sources.map(s=>({sourceId:s.id,receiptRevision:contentHash("receipt")}))};
  for(const frames of [1,2,3,61]){const plan=createEditAssemblyPlan(parent,[{id:"selection",fromFrame:10,toFrame:10+frames,reason:"Retain the selected exchange."}]),vtt=editAssemblyVtt(plan),parsed=parseEditCaptions(vtt,frames);expect(vtt).toContain(" --> "+timestamp(Math.ceil(frames*S/48)));expect(parsed).toHaveLength(1);expect(parsed[0]).toMatchObject({start:0,end:frames*S,text});expect(plan.parent.timeline).toEqual(t);}
});

test("caption parser permits only the exact final millisecond ceiling and preserves existing IDs",()=>{
  for(const frames of [1,2,3,61]){const allowedMs=Math.ceil(frames*S/48),parsed=parseEditCaptions(cue(0,allowedMs),frames);expect(parsed[0]!.end).toBe(frames*S);expect(()=>parseEditCaptions(cue(0,allowedMs+1),frames)).toThrow("timing");expect(()=>parseEditCaptions(cue(allowedMs,allowedMs+1),frames)).toThrow("timing");}
  for(const [frames,startMs,endMs,end]of [[2,0,67,3200],[3,0,100,4800],[90,100,900,43200]]){const parsed=parseEditCaptions(cue(startMs!,endMs!),frames!);expect(parsed).toEqual([{id:"caption-"+contentHash({index:0,identifier:"original-cue",start:startMs!*48,end,text:"A & B"}),start:startMs!*48,end:end!,text:"A & B"}]);}
});

test("caption parser still rejects invalid source duration and malformed or out-of-source cues",()=>{
  for(const frames of [0,-1,1.5,NaN,Infinity,EDIT_MAX_FRAMES+1])expect(()=>parseEditCaptions(cue(0,34),frames)).toThrow("Caption source frames");
  for(const vtt of [cue(0,0),cue(100,99),cue(100,101),cue(0,101),"WEBVTT\n\n00:00:00.000 --> 00:00:60.000\nInvalid seconds\n","WEBVTT\n\n00:00:00.000 --> 00:00:00.1000\nInvalid milliseconds\n"])expect(()=>parseEditCaptions(vtt,3)).toThrow();
});

test("both caption writers roundtrip entity-expanded text up to the decoded character limit",()=>{
  for(const captionText of ["&".repeat(1000),"&".repeat(4000),"A"+"\u00a0".repeat(3998)+"B"]){
    const t=timeline(3,captionText),plan=createEditAssemblyPlan({sequenceId:"sequence",historyRevision:contentHash("history"),timeline:t,sourceReceipts:[{sourceId:"original",receiptRevision:contentHash("receipt")}]},[{id:"selected",fromFrame:0,toFrame:3,reason:"Retain the complete caption."}]);
    for(const vtt of [editVtt(t),editAssemblyVtt(plan)]){const parsed=parseEditCaptions(vtt,3);expect(parsed).toHaveLength(1);expect(parsed[0]).toMatchObject({start:0,end:4800,text:captionText});expect(parseEditCaptions(vtt,3)).toEqual(parsed);}
  }
});

test("caption entity decoding bounds raw expansion separately and keeps plain-text parsing and identities",()=>{
  const track=(rawText:string)=>"WEBVTT\n\nentities\n00:00:00.000 --> 00:00:00.100\n"+rawText+"\n",raw="A"+"&nbsp;".repeat(3999),decoded="A"+"\u00a0".repeat(3999),parsed=parseEditCaptions(track(raw),3);expect(raw.length).toBe(23995);expect(parsed).toEqual([{id:"caption-"+contentHash({index:0,identifier:"entities",start:0,end:4800,text:decoded}),start:0,end:4800,text:decoded}]);
  const existing=parseEditCaptions(track("&amp;&lt;&gt;&lrm;&rlm;&nbsp;"),3),text="&<>\u200e\u200f\u00a0";expect(existing).toEqual([{id:"caption-"+contentHash({index:0,identifier:"entities",start:0,end:4800,text}),start:0,end:4800,text}]);expect(parseEditCaptions(track("&amp;nbsp;"),3)[0]!.text).toBe("&nbsp;");
  for(const rawText of ["x".repeat(4001),"&amp;".repeat(4001),"A"+"&nbsp;".repeat(4000)])expect(()=>parseEditCaptions(track(rawText),3)).toThrow(rawText.length>24000?"cannot be edited losslessly":"4000 decoded");
  expect(()=>parseEditCaptions(track("&nbsp;".repeat(4000)+"A"),3)).toThrow("cannot be edited losslessly");for(const rawText of ["&nbsp;","&nbsp;".repeat(4000)," \t "])expect(()=>parseEditCaptions(track(rawText),3)).toThrow();expect(()=>parseEditCaptions(track("<b>Text</b>"),3)).toThrow("cannot be edited losslessly");
  expect(()=>parseEditCaptions(track("x".repeat(8*1024**2)),3)).toThrow("too large");
});
