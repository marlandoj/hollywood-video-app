import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {applyEditOperation,editTimeline,validateEditTimeline,type EditClip,type EditSource,type EditTimeline} from "../src/edit-timeline";
import {editCompositeGraph,editCompositeNeeded} from "../src/edit-composite";
import {appendEdit,createEditHistory,editHistoryState,editHistoryUsesComposite,moveEditCursor} from "../src/edit-history";
import type {EditComposite,EditMask} from "../src/edit-composite-types";
import {EditTime} from "../src/edit-time";
import {previewRequests} from "../src/edit-preview-render";
import {editCompositeReview} from "../src/edit-composite-review";
import {editRenderReview} from "../src/edit-jobs";

const source:EditSource={id:"original",revision:contentHash("original"),label:"Original picture",frames:90,width:64,height:48,audio:[],captions:[],voices:[],unmeasuredAudio:false};
const clip=(id:string,layer=0,at=0,from=10,frames=30):EditClip=>({id,sourceId:source.id,lane:"picture",layer,at,from,frames,link:null,gainDb:0,opacity:1,crop:null,envelope:{from,frames,fadeIn:0,fadeOut:0}});
const base=(clips:EditClip[]=[clip("picture")])=>editTimeline({schema:"hv-edit-timeline/1",width:64,height:48,frames:90,sources:[source],clips,markers:[]});
const mask=():EditMask=>({id:"subject",label:"Subject mask",sourceRevision:source.revision,kind:"rectangle",combine:"replace",invert:false,featherQ8:0,keyframes:[0,89].map(sourceFrame=>({sourceFrame,interpolation:"linear",geometry:{xQ16:0,yQ16:0,widthQ16:32768,heightQ16:65536}}))});
const setup=():EditComposite=>({schema:"hv-edit-composite/1",masks:[mask()]});
const apply=(t:EditTimeline,c=setup(),id="picture")=>applyEditOperation(t,{kind:"composite",clipId:id,composite:c});
const reseal=(t:EditTimeline)=>{const {revision:_revision,...data}=t;return editTimeline(data);};

test("composite operations promote only new timelines and preserve old history revisions on undo and branches",()=>{
  const original=base(),serialized=JSON.stringify(original),masked=apply(original);expect(original.schema).toBe("hv-edit-timeline/1");expect(JSON.stringify(original)).toBe(serialized);expect(masked.schema).toBe("hv-edit-timeline/2");expect(editCompositeNeeded(original)).toBe(false);expect(editCompositeNeeded(masked)).toBe(true);
  expect(()=>reseal({...masked,schema:"hv-edit-timeline/1"})).toThrow("schema 2");expect(validateEditTimeline(JSON.parse(JSON.stringify(masked)))).toEqual(masked);
  const removed=applyEditOperation(masked,{kind:"composite",clipId:"picture",composite:null});expect(removed.schema).toBe("hv-edit-timeline/2");expect(Object.hasOwn(removed.clips[0]!,"composite")).toBe(false);expect(editCompositeNeeded(removed)).toBe(false);
  let history=createEditHistory("mask-history",original);expect(editHistoryUsesComposite(history)).toBe(false);history=appendEdit(history,{kind:"composite",clipId:"picture",composite:setup()},"Mask the subject",history.revision,1);history=moveEditCursor(history,0,"undo","Undo mask",history.revision,2);expect(editHistoryState(history).timeline.revision).toBe(original.revision);expect(editHistoryUsesComposite(history)).toBe(true);
  history=appendEdit(history,{kind:"marker",marker:{id:"other",frame:1,label:"Another branch"}},"Try another branch",history.revision,3);history=moveEditCursor(history,1,"branch","Restore masked branch",history.revision,4);expect(editHistoryState(history).timeline).toEqual(masked);expect(history.events).toHaveLength(4);
});

test("source-bound mask keys survive split, slip, trim, hold, ramps and explicit replacement decisions",()=>{
  const masked=apply(base());let split=applyEditOperation(masked,{kind:"split",clipId:"picture",linked:false,at:15,rightIds:{picture:"right"},rightLink:null});expect(split.clips.map(c=>c.composite)).toEqual([setup(),setup()]);
  split=applyEditOperation(split,{kind:"slip",clipId:"right",linked:false,delta:2});expect(split.clips.find(c=>c.id==="right")!.composite).toEqual(setup());expect(new EditTime(split.clips.find(c=>c.id==="right")!).frame(15)).toBe(27);
  const held=applyEditOperation(masked,{kind:"retime",clipId:"picture",linked:false,from:40,frames:50,points:[{frame:0,rate:0},{frame:50,rate:0}],ripple:false});expect(held.clips[0]!.composite).toEqual(setup());expect(new EditTime(held.clips[0]!).frame(49)).toBe(40);
  const ramp=applyEditOperation(masked,{kind:"retime",clipId:"picture",linked:false,from:10,frames:20,points:[{frame:0,rate:1000},{frame:20,rate:2000}],ripple:false});expect(ramp.clips[0]!.composite).toEqual(setup());expect(new EditTime(ramp.clips[0]!).frame(10)).toBe(22);
  const other={...source,id:"replacement",revision:contentHash("replacement")},withOther=reseal({...masked,sources:[source,other]}),operation={kind:"replace" as const,clipId:"picture",linked:false,sourceId:other.id,from:10,frames:30,timing:"preserve" as const,ripple:false};
  expect(()=>applyEditOperation(withOther,operation)).toThrow("requires choosing");const rebound=applyEditOperation(withOther,{...operation,maskAction:"rebind"});expect(rebound.clips[0]!.composite!.masks![0]!.sourceRevision).toBe(other.revision);expect(withOther.clips[0]!.composite!.masks![0]!.sourceRevision).toBe(source.revision);
  expect(applyEditOperation(withOther,{...operation,maskAction:"remove"}).clips[0]!.composite).toBeUndefined();expect(applyEditOperation(withOther,{...operation,sourceId:source.id,maskAction:"remove"}).clips[0]!.composite).toEqual(setup());
  const short=reseal({...withOther,sources:[source,{...other,frames:50}]});expect(()=>applyEditOperation(short,{...operation,maskAction:"rebind"})).toThrow("source frame");
});

test("track matte graphs retain hidden dependencies and reject absent, self and temporally separated cycles",()=>{
  let t=base([clip("picture",0),clip("matte",1),clip("third",2),clip("fourth",3)]);for(const [id,layer]of [["picture",1],["matte",2],["third",3]] as const)t=apply(t,{schema:"hv-edit-composite/1",matte:{layer,channel:"alpha",invert:false}},id);
  t=applyEditOperation(t,{kind:"matte-only",layers:[3,1,2]});expect(t.matteOnlyLayers).toEqual([1,2,3]);expect(editCompositeGraph(t)).toEqual({layers:[0,1,2,3],order:[3,2,1,0],dependencies:{0:[1],1:[2],2:[3],3:[]}});
  expect(()=>apply(t,{schema:"hv-edit-composite/1",matte:{layer:0,channel:"luma",invert:true}},"fourth")).toThrow("0 → 1 → 2 → 3 → 0");expect(()=>apply(base(),{schema:"hv-edit-composite/1",matte:{layer:0,channel:"alpha",invert:false}})).toThrow("different picture layer");expect(()=>apply(base(),{schema:"hv-edit-composite/1",matte:{layer:3,channel:"alpha",invert:false}})).toThrow("containing retained");
  let separated=base([clip("picture",0,0),clip("late",1,50)]);separated=apply(separated,{schema:"hv-edit-composite/1",matte:{layer:1,channel:"alpha",invert:false}});expect(()=>apply(separated,{schema:"hv-edit-composite/1",matte:{layer:0,channel:"alpha",invert:false}},"late")).toThrow("cycle");
  expect(()=>applyEditOperation(t,{kind:"delete",clipId:"fourth",linked:false,ripple:false})).toThrow();expect(()=>applyEditOperation(base(),{kind:"matte-only",layers:[1]})).toThrow("contain");expect(()=>applyEditOperation(t,{kind:"matte-only",layers:[1,1]})).toThrow("distinct");expect(applyEditOperation(t,{kind:"matte-only",layers:[]}).matteOnlyLayers).toBeUndefined();
});

test("mask validation enforces original identity, portable geometry, stable polygon topology and finite work",()=>{
  const polygon:EditMask={...mask(),kind:"polygon",keyframes:[0,89].map(sourceFrame=>({sourceFrame,interpolation:"linear",geometry:{points:[{id:"a",xQ16:0,yQ16:0},{id:"b",xQ16:65536,yQ16:0},{id:"c",xQ16:32768,yQ16:65536}]}}))};expect(apply(base(),{schema:"hv-edit-composite/1",masks:[polygon]}).clips[0]!.composite!.masks![0]).toEqual(polygon);
  const patches=[(c:any)=>c.masks[0].sourceRevision="f".repeat(64),(c:any)=>c.masks[0].keyframes.reverse(),(c:any)=>c.masks[0].keyframes[0].sourceFrame=-1,(c:any)=>c.masks[0].keyframes[1].sourceFrame=90,(c:any)=>c.masks[0].keyframes[0].geometry.widthQ16=NaN,(c:any)=>c.masks[0].keyframes[0].geometry.widthQ16=0,(c:any)=>c.masks[0].keyframes[0].geometry.xQ16=131073,(c:any)=>c.masks[0].featherQ8=32769,(c:any)=>c.masks[0].combine="intersect",(c:any)=>c.masks.push(c.masks[0]),(c:any)=>c.masks=[],(c:any)=>c.masks[0].script="alert(1)"];
  for(const patch of patches){const changed=setup();patch(changed);expect(()=>apply(base(),changed)).toThrow();}
  for(const patch of [(m:any)=>m.keyframes[1].geometry.points.reverse(),(m:any)=>m.keyframes[1].geometry.points[1].id="a",(m:any)=>m.keyframes[0].geometry.points[0].xQ16=0.5]){const changed=structuredClone(polygon);patch(changed);expect(()=>apply(base(),{schema:"hv-edit-composite/1",masks:[changed]})).toThrow();}
  for(const changed of [{schema:"hv-edit-composite/1"},{...setup(),matte:undefined},{...setup(),placement:{xQ16:0,yQ16:0,scaleQ16:0,rotationMilliDegrees:0}}])expect(()=>apply(base(),changed as EditComposite)).toThrow();
  const audio=base([{...clip("caption"),lane:"captions"}]);expect(()=>apply(audio,setup(),"caption")).toThrow("picture clip");
  const keys=Array.from({length:65},(_,sourceFrame)=>({sourceFrame,interpolation:"hold" as const,geometry:{points:Array.from({length:64},(_,i)=>({id:"v"+i,xQ16:i*100,yQ16:i%2*10000}))}})),many:EditMask={...polygon,keyframes:keys};
  expect(()=>editTimeline({schema:"hv-edit-timeline/2",width:64,height:48,frames:90,sources:[source],markers:[],clips:Array.from({length:16},(_,i)=>({...clip("c"+i,i%4),composite:{schema:"hv-edit-composite/1",masks:[many]}}))})).toThrow("65,536");
});

test("preview demand retains opaque occluded and independent-clock matte dependencies while excluding unused hidden tracks",()=>{
  const originals=[source,...["matte","chain","unused"].map(id=>({...source,id,revision:contentHash(id)}))],clips=[clip("picture"),{...clip("matte",1,10,70,5),sourceId:"matte"},{...clip("chain",2,10,30,1),sourceId:"chain"},{...clip("unused",3,0,40,30),sourceId:"unused"}];
  let t=reseal({...base(),sources:originals,clips});t=apply(t,{schema:"hv-edit-composite/1",matte:{layer:1,channel:"alpha",invert:false}});t=apply(t,{schema:"hv-edit-composite/1",matte:{layer:2,channel:"luma",invert:true}},"matte");t=applyEditOperation(t,{kind:"matte-only",layers:[1,2,3]});
  expect(previewRequests(t,10,2)).toEqual([{sourceId:"original",from:0,includePicture:true,audioLanes:[],pictureFrames:[20,21]},{sourceId:"matte",from:60,includePicture:true,audioLanes:[],pictureFrames:[70,71]},{sourceId:"chain",from:0,includePicture:true,audioLanes:[],pictureFrames:[30]}]);
  expect(previewRequests(t,0,1)).toEqual([{sourceId:"original",from:0,includePicture:true,audioLanes:[],pictureFrames:[10]}]);
  const legacy=base([clip("lower"),clip("upper",1,0,50,30)]);expect(previewRequests(legacy,0,1)).toEqual([{sourceId:"original",from:0,includePicture:true,audioLanes:[],pictureFrames:[50]}]);
  const masked=apply(legacy,setup(),"lower");expect(previewRequests(masked,0,1)).toEqual([{sourceId:"original",from:0,includePicture:true,audioLanes:[],pictureFrames:[10,50]}]);
});

test("compositing review distinguishes normal and inverted track gaps and accepts adjacent or overlapping coverage",()=>{
  const original=base([clip("picture",0,10,0,20),clip("matte-start",1,10,0,9),clip("matte-end",1,20,30,10)]);expect(editCompositeReview(original)).toBeNull();expect(Object.hasOwn(editRenderReview(original),"compositingRevision")).toBe(false);
  for(const invert of [false,true]){const t=apply(original,{schema:"hv-edit-composite/1",matte:{layer:1,channel:"alpha",invert}}),review=editCompositeReview(t)!;
    expect(review.warnings).toEqual(["Clip picture uses picture 1 through a track gap. The "+(invert?"inverted matte reveals":"matte hides")+" the clip during that gap."]);expect(editRenderReview(t).compositingRevision).toBe(contentHash(review));
    for(const at of [18,19]){const covered=reseal({...t,clips:t.clips.map(c=>c.id==="matte-end"?{...c,at,frames:30-at,envelope:{...c.envelope,frames:30-at}}:c)});expect(editCompositeReview(covered)!.warnings).toEqual([]);expect(editRenderReview(covered).compositingRevision).not.toBe(editRenderReview(t).compositingRevision);}
  }
  const unused=applyEditOperation(original,{kind:"matte-only",layers:[1]});expect(editCompositeReview(unused)!.warnings).toEqual(["Picture 1 is matte-only and has no saved consumers; it is hidden from the exported picture."]);
});

test("compositing review includes matte gaps in borrowed dissolve handles and revisions change with authored settings",()=>{
  let t=apply(base([clip("picture",0,0,10,20),clip("next",0,20,20,20),clip("matte",1,0,0,20)]),{schema:"hv-edit-composite/1",masks:[mask()],matte:{layer:1,channel:"luma",invert:false}});
  expect(editCompositeReview(t)!.warnings).toHaveLength(1);const before=editRenderReview(t).compositingRevision;
  t=applyEditOperation(t,{kind:"crossfade",leftId:"picture",rightId:"next",linked:false,frames:10,alignment:"center",ids:{picture:"dissolve"}});expect(editCompositeReview(t)!.warnings).toContain("Clip picture uses picture 1 through a track gap. The matte hides the clip during that gap.");expect(editRenderReview(t).compositingRevision).not.toBe(before);
  const changed=structuredClone(t.clips.find(c=>c.id==="picture")!.composite!);changed.masks![0]!.featherQ8=512;const feathered=apply(t,changed);expect(editRenderReview(feathered).compositingRevision).not.toBe(editRenderReview(t).compositingRevision);
});
