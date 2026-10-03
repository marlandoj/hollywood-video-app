import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {applyEditOperation,editTimeline,type EditClip,type EditSource,type EditTimeline} from "../src/edit-timeline";
import {editCmx3600,editInterchangeCut,editOtio,editTimecode,type EditInterchangeSource} from "../src/edit-interchange";
import {frames,otioAsEvents,readEdl,readOtio} from "../../../test/fixtures/interchange-readers";

const source=(id:string,length:number,label:string):EditSource=>({id,revision:contentHash(["interchange",id]),label,frames:length,width:320,height:180,audio:["mix"],captions:[],voices:[],unmeasuredAudio:false});
const shot=(id:string,sourceId:string,lane:"picture"|"mix",at:number,length:number,link:string|null,layer=0):EditClip=>({id,sourceId,lane,layer,link,at,from:0,frames:length,gainDb:0,opacity:1,crop:null,envelope:{from:0,frames:length,fadeIn:0,fadeOut:0}});
const SOURCES=[source("job-garden",120,"Garden, wide"),source("job-gate",90,"Gate, close"),source("job-path",150,"Path, tracking")];
const named:EditInterchangeSource[]=SOURCES.map(s=>({sourceId:s.id,jobId:s.id,stage:"final",sourceRevision:s.revision}));
const HISTORY=contentHash("saved history");

/** Three shots, edited with the model's own operations: a ripple trim at each end of the middle shot, a slip, and a centred 10-frame dissolve. */
function cut():EditTimeline{
  let t=editTimeline({schema:"hv-edit-timeline/1",width:320,height:180,frames:360,sources:SOURCES,markers:[{id:"m1",frame:100,label:"Gate opens"}],clips:[
    shot("a","job-garden","picture",0,120,"la"),shot("a-mix","job-garden","mix",0,120,"la"),
    shot("b","job-gate","picture",120,90,"lb"),shot("b-mix","job-gate","mix",120,90,"lb"),
    shot("c","job-path","picture",210,150,"lc"),shot("c-mix","job-path","mix",210,150,"lc")]});
  t=applyEditOperation(t,{kind:"trim",clipId:"a",linked:true,edge:"out",delta:-20,ripple:true});
  t=applyEditOperation(t,{kind:"trim",clipId:"b",linked:true,edge:"in",delta:15,ripple:true});
  t=applyEditOperation(t,{kind:"trim",clipId:"c",linked:true,edge:"out",delta:-40,ripple:false});
  t=applyEditOperation(t,{kind:"slip",clipId:"c",linked:true,delta:20});
  t=applyEditOperation(t,{kind:"crossfade",leftId:"a",rightId:"b",linked:true,frames:10,alignment:"center",ids:{a:"x-pic","a-mix":"x-mix"}});
  return t;
}
// Worked by hand from the operations above, not from the exporter.
const HARD_CUTS=[
  {jobId:"job-garden",clipId:"a",sourceIn:0,sourceOut:100,recordIn:0,recordOut:100,dissolveIn:null},
  {jobId:"job-gate",clipId:"b",sourceIn:15,sourceOut:90,recordIn:100,recordOut:175,dissolveIn:{before:5,after:5}},
  {jobId:"job-path",clipId:"c",sourceIn:20,sourceOut:130,recordIn:175,recordOut:285,dissolveIn:null},
];
const CMX_EVENTS=[
  {jobId:"job-garden",sourceIn:0,sourceOut:95,recordIn:0,recordOut:95,dissolve:null},
  {jobId:"job-gate",sourceIn:10,sourceOut:90,recordIn:95,recordOut:175,dissolve:10},
  {jobId:"job-path",sourceIn:20,sourceOut:130,recordIn:175,recordOut:285,dissolve:null},
];

test("a three-shot cut with trims, a slip and a dissolve reads back from OTIO and from a CMX 3600 EDL as the same shots and frames",()=>{
  const timeline=cut();expect(timeline.frames).toBe(325);
  const exported=editInterchangeCut({sequenceId:"feature-cut",label:"The Garden — reel 1",historyRevision:HISTORY,timeline,sources:named});
  const otio=readOtio(editOtio(exported)),edl=readEdl(editCmx3600(exported));
  expect(otio.name).toBe("The Garden — reel 1");expect(otio.startFrame).toBe(108000);expect(otio.tracks.map(t=>[t.name,t.kind,t.frames])).toEqual([["V1","Video",325]]);
  expect(otio.tracks[0]!.clips.map(({name:_name,...c})=>c)).toEqual(HARD_CUTS);expect(otio.tracks[0]!.clips.map(c=>c.name)).toEqual(["Garden, wide","Gate, close","Path, tracking"]);
  expect(otio.markers).toEqual([{name:"Gate opens",frame:100}]);expect(otio.metadata).toMatchObject({hv:{sequenceId:"feature-cut",historyRevision:HISTORY,timelineRevision:timeline.revision}});
  expect(edl.title).toBe("The Garden — reel 1");expect(edl.fcm).toBe("NON-DROP FRAME");expect(edl.events).toEqual(CMX_EVENTS);expect(edl.names).toEqual(["Garden, wide","","Gate, close","Path, tracking"]);
  // The two files agree with each other, not only with the hand-worked values.
  expect(otioAsEvents(otio.tracks[0]!)).toEqual(edl.events);
  const text=editOtio(exported)+editCmx3600(exported);expect(text).not.toMatch(/:\/\/|token|signature|x-amz|\.mp4|\.wav/i);for(const s of SOURCES)expect(text).toContain("urn:hv:job:"+s.id);
  expect(exported.notCarried).toEqual(["Sound and caption lanes (mix) are not written; export picture is a reference cut for finishing.","Markers are written to the OTIO only."]);
});

test("the EDL is laid out as CMX 3600 columns with a zero-length outgoing cut before each dissolve",()=>{
  const edl=editCmx3600(editInterchangeCut({sequenceId:"feature-cut",label:"Reel\n1",historyRevision:HISTORY,timeline:cut(),sources:named}));
  expect(edl.split("\n").slice(0,8)).toEqual([
    "TITLE: Reel 1","FCM: NON-DROP FRAME","",
    "001  HV01     V     C        00:00:00:00 00:00:03:05 01:00:00:00 01:00:03:05","* FROM CLIP NAME: Garden, wide","* SOURCE FILE: urn:hv:job:job-garden","",
    "002  HV01     V     C        00:00:03:05 00:00:03:05 01:00:03:05 01:00:03:05",
  ]);
  expect(edl).toContain("\n002  HV02     V     D    010 00:00:00:10 00:00:03:00 01:00:03:05 01:00:05:25\n* FROM CLIP NAME: Garden, wide\n* TO CLIP NAME: Gate, close\n");
  expect(edl).toContain("\n003  HV03     V     C        00:00:00:20 00:00:04:10 01:00:05:25 01:00:09:15\n");
  expect([0,29,30,1799,1800,107999,108000,215999].map(editTimecode)).toEqual(["00:00:00:00","00:00:00:29","00:00:01:00","00:00:59:29","00:01:00:00","00:59:59:29","01:00:00:00","01:59:59:29"]);
  for(const n of [0,29,30,1799,1800,107999,108000,215999])expect(frames(editTimecode(n))).toBe(n);
});

test("every picture layer becomes its own OTIO video track with gaps, and the EDL says it carries layer 1 only",()=>{
  const timeline=applyEditOperation(cut(),{kind:"insert",clips:[{...shot("title","job-path","picture",30,20,null,1)}]}),exported=editInterchangeCut({sequenceId:"feature-cut",label:"Layers",historyRevision:HISTORY,timeline,sources:named});
  const otio=readOtio(editOtio(exported));expect(otio.tracks.map(t=>[t.name,t.frames])).toEqual([["V1",325],["V2",325]]);expect(otio.tracks[1]!.clips).toEqual([{name:"Path, tracking",jobId:"job-path",clipId:"title",sourceIn:0,sourceOut:20,recordIn:30,recordOut:50,dissolveIn:null}]);
  expect(readEdl(editCmx3600(exported)).events).toEqual(CMX_EVENTS);expect(exported.notCarried).toContain("The EDL carries picture layer 1 only; the OTIO carries every picture layer.");
});

test("what the files cannot say exactly is refused by name or listed, never written approximately",()=>{
  const base=cut(),sources=named;
  const ramp=applyEditOperation(base,{kind:"retime",clipId:"c",linked:true,from:20,frames:110,points:[{frame:0,rate:1000},{frame:110,rate:1000}],ripple:false});
  expect(()=>editInterchangeCut({sequenceId:"s",label:"x",historyRevision:HISTORY,timeline:ramp,sources})).toThrow("Clip c changes speed");
  const stacked=applyEditOperation(base,{kind:"insert",clips:[shot("under","job-garden","picture",10,40,null,1),shot("over","job-gate","picture",30,20,null,1)]});
  expect(()=>editInterchangeCut({sequenceId:"s",label:"x",historyRevision:HISTORY,timeline:stacked,sources})).toThrow("Clips under and over overlap on picture layer 2");
  expect(()=>editInterchangeCut({sequenceId:"s",label:"x",historyRevision:HISTORY,timeline:base,sources:sources.slice(1)})).toThrow("Clip a has no retained original");
  expect(()=>editInterchangeCut({sequenceId:"s",label:"x",historyRevision:HISTORY,timeline:base,sources:sources.map(s=>({...s,sourceRevision:contentHash("another receipt")}))})).toThrow("no retained original");
  expect(()=>editInterchangeCut({sequenceId:"s",label:"x",historyRevision:HISTORY,timeline:{...base,frames:base.frames+1},sources})).toThrow("changed");
  const graded=applyEditOperation(base,{kind:"settings",clipId:"c",gainDb:0,opacity:0.5,crop:{x:0,y:0,width:160,height:90},fadeIn:0,fadeOut:12});
  expect(editInterchangeCut({sequenceId:"s",label:"x",historyRevision:HISTORY,timeline:graded,sources}).notCarried).toEqual(expect.arrayContaining(["Picture fades to and from black are not written.","Picture opacity is not written.","Picture crops are not written."]));
  const long=applyEditOperation(editTimeline({schema:"hv-edit-timeline/1",width:320,height:180,frames:4000,sources:[source("job-long",4000,"Long")],markers:[],clips:[shot("l","job-long","picture",0,2000,null),{...shot("r","job-long","picture",2000,2000,null),from:2000,envelope:{from:2000,frames:2000,fadeIn:0,fadeOut:0}}]}),{kind:"crossfade",leftId:"l",rightId:"r",linked:false,frames:1000,alignment:"center",ids:{l:"x"}});
  const longCut=editInterchangeCut({sequenceId:"s",label:"x",historyRevision:HISTORY,timeline:long,sources:[{sourceId:"job-long",jobId:"job-long",stage:"final",sourceRevision:source("job-long",4000,"Long").revision}]});
  expect(()=>editCmx3600(longCut)).toThrow("longer than the 999 frames");expect(readOtio(editOtio(longCut)).tracks[0]!.clips[1]!.dissolveIn).toEqual({before:500,after:500});
});
