import {expect,test} from "bun:test";
import {EditTime,editPhaseFrame} from "../../planner/src/edit-time";
import {addRetimeAudio} from "../../planner/src/edit-retime-audio";
import {applyEditOperation,editTimeline,initialEditTimeline,editCaptionCues,editSpeechCuts,editUnmeasuredCuts,type EditTimeline} from "../../planner/src/edit-timeline";
import {previewPicture,previewRequests} from "../../planner/src/edit-preview-render";
import {editGainQ20,editGainScale} from "../../planner/src/edit-sampling";
import {editStorageEstimate} from "../../planner/src/edit-resources";
const fixture=()=>initialEditTimeline([{id:"film",revision:"a".repeat(64),label:"Original",frames:90,width:64,height:48,audio:["mix"],captions:[{id:"line",start:16000,end:32000,text:"A line"}],voices:[{id:"line",start:16000,end:32000,lane:"dialogue"}],unmeasuredAudio:true}],"film",64,48);
const retime=(t=fixture(),from=5,frames=60,points=[{frame:0,rate:0},{frame:frames,rate:2000}])=>applyEditOperation(t,{kind:"retime",clipId:"initial-0",linked:true,from,frames,points,ripple:true});
const split=(t:EditTimeline,at:number,id="initial-0",prefix="right")=>{const c=t.clips.find(c=>c.id===id)!;return applyEditOperation(t,{kind:"split",clipId:id,linked:true,at,rightIds:Object.fromEntries(t.clips.filter(x=>x.link===c.link).map(x=>[x.id,prefix+"-"+x.lane])),rightLink:prefix});};
test("integrated speed ramps preserve source samples and envelope phase through split, roll, trim, move and slip",()=>{
  let original=fixture();original=applyEditOperation(original,{kind:"settings",clipId:"initial-1",gainDb:-6,opacity:1,crop:null,fadeIn:10,fadeOut:10});original=retime(original);const before=original.clips.find(c=>c.lane==="mix")!,clock=new EditTime(before);expect(clock.frame(30)).toBe(20);expect(clock.source(60*1600)).toBe(65*1600);
  const divided=split(original,23);for(const c of divided.clips.filter(c=>c.lane==="mix")){const time=new EditTime(c);for(let at=c.at*1600;at<(c.at+c.frames)*1600;at+=997){expect(time.source(at)).toBe(clock.source(at));expect(editGainQ20(c,time.phase(at),editGainScale(c))).toBe(editGainQ20(before,clock.phase(at),editGainScale(before)));}}
  const rolled=applyEditOperation(divided,{kind:"roll",leftId:"initial-0",rightId:"right-picture",linked:true,delta:3});for(const c of rolled.clips.filter(c=>c.lane==="picture"))for(let f=c.at;f<c.at+c.frames;f++)expect(new EditTime(c).source(f*1600)).toBe(clock.source(f*1600));
  const trimmed=applyEditOperation(divided,{kind:"trim",clipId:"right-picture",linked:true,edge:"in",delta:3,ripple:false}),right=trimmed.clips.find(c=>c.id==="right-picture")!;expect(new EditTime(right).source(26*1600)).toBe(clock.source(26*1600));expect(editPhaseFrame(right)).toBe(31);
  const slipped=applyEditOperation(trimmed,{kind:"slip",clipId:right.id,linked:true,delta:2}),slip=slipped.clips.find(c=>c.id===right.id)!;expect(new EditTime(slip).source(26*1600)).toBe(clock.source(26*1600)+3200);
  const moved=applyEditOperation(trimmed,{kind:"move",clipId:right.id,linked:true,at:20}),move=moved.clips.find(c=>c.id===right.id)!;expect(new EditTime(move).source(20*1600)).toBe(new EditTime(right).source(26*1600));
});
test("slide preserves the middle speed curve while moving adjacent boundaries",()=>{
  const t=split(split(retime(),20),40,"right-picture","last"),middle=t.clips.find(c=>c.id==="right-picture")!,moved=applyEditOperation(t,{kind:"slide",leftId:"initial-0",clipId:middle.id,rightId:"last-picture",linked:true,delta:3}),c=moved.clips.find(c=>c.id===middle.id)!;
  expect(c.timing).toEqual(middle.timing);expect(c.envelope).toEqual(middle.envelope);expect(c.frames).toBe(20);for(let i=0;i<20;i++)expect(new EditTime(c).source((c.at+i)*1600)).toBe(new EditTime(middle).source((middle.at+i)*1600));
});
test("freeze holds picture and captions, mutes audio, and keeps source speech boundaries visible",()=>{
  const t=retime(fixture(),15,120,[{frame:0,rate:0},{frame:120,rate:0}]),c=t.clips.find(c=>c.lane==="mix")!,audio=new Float64Array(4096);addRetimeAudio(c,new EditTime(c),0,2048,audio,0,90*1600,()=>{throw Error("A hold must not sample audio");});expect(audio.every(n=>n===0)).toBe(true);
  expect(previewPicture(t,119).map(p=>p.sourceFrame)).toEqual([15]);expect(editCaptionCues(t).map(c=>[c.start,c.end,c.text])).toEqual([[0,120*1600,"A line"]]);expect(editSpeechCuts(t)).toHaveLength(2);expect(editUnmeasuredCuts(t)).toEqual(["initial-1"]);expect(previewRequests(t,60,60).some(p=>p.sourceId==="film")).toBe(true);
  const restored=applyEditOperation(t,{kind:"retime",clipId:"initial-0",linked:true,from:0,frames:90,points:null,ripple:true});expect(restored).toEqual(fixture());
});
test("caption boundaries invert the same sample clock including a held cue end",()=>{
  const t=retime(fixture(),0,40,[{frame:0,rate:1000},{frame:10,rate:1000},{frame:20,rate:0},{frame:30,rate:0},{frame:40,rate:1000}]),time=new EditTime(t.clips[0]!),cue=editCaptionCues(t)[0]!;
  expect(cue.start).toBe(16000);expect(cue.end).toBe(64000);expect(time.source(cue.start)).toBe(16000);expect(time.source(cue.start-1)).toBeLessThan(16000);
  const ramp=retime(fixture(),0,45,[{frame:0,rate:2000},{frame:45,rate:2000}]);expect(editCaptionCues(ramp).map(c=>[c.start,c.end])).toEqual([[8000,16000]]);
});
test("retiming rejects invalid source coverage, malformed curves, mismatched linked clocks and impossible inherited fades",()=>{
  expect(()=>retime(fixture(),5,90,[{frame:0,rate:8000},{frame:90,rate:8000}])).toThrow("source");expect(()=>retime(fixture(),90)).toThrow();
  for(const points of [[{frame:1,rate:0},{frame:60,rate:1}],[{frame:0,rate:-1},{frame:60,rate:0}],[{frame:0,rate:0},{frame:30,rate:0},{frame:30,rate:0},{frame:60,rate:0}],[{frame:0,rate:0},{frame:61,rate:0}]])expect(()=>retime(fixture(),5,60,points)).toThrow();
  const {revision:_r,...data}=retime();data.clips[0]!.timing!.points[1]!.rate=1900;expect(()=>editTimeline(data)).toThrow("Linked");
  let faded=fixture();faded=applyEditOperation(faded,{kind:"settings",clipId:"initial-1",gainDb:0,opacity:1,crop:null,fadeIn:45,fadeOut:40});expect(()=>retime(faded)).toThrow("Fade");
});
test("retimed picture workspace accounts for selected and repeated full-resolution frames",()=>{
  const base=editStorageEstimate(fixture(),[]),timed=editStorageEstimate(retime(),[]);expect(base).not.toHaveProperty("retimingScratchBytes");expect(timed.retimingScratchBytes).toBeGreaterThan(64*48*60*3);expect(timed.workspaceBytes).toBe(timed.outputBytes*3+timed.retimingScratchBytes!);
});
test("varispeed is exact at unit speed and attenuates audio above the faster playback Nyquist limit",()=>{
  const t=retime(fixture(),5,10,[{frame:0,rate:1000},{frame:10,rate:1000}]),c=t.clips.find(c=>c.lane==="mix")!,output=new Float64Array(4096),wave=(i:number)=>Math.round(100000*Math.sin(2*Math.PI*.3*i));addRetimeAudio(c,new EditTime(c),0,2048,output,0,90*1600,wave);for(let i=0;i<2048;i++)expect(output[i*2]).toBe(wave(8000+i)||0);
  c.timing!.points.forEach(p=>p.rate=2000);output.fill(0);addRetimeAudio(c,new EditTime(c),0,2048,output,0,90*1600,wave);expect(Math.sqrt(output.reduce((sum,n)=>sum+n*n,0)/output.length)).toBeLessThan(300);
});
