import {expect,test} from "bun:test";
import {subjectMotionPlan,subjectMotionRevision,sampleSubjectTrack,type SubjectMotionPlan} from "../src/subject-motion";
const frame=(frame:number,x:number,y:number,easing:"linear"|"smooth"="linear",visible=true)=>({frame,x,y,easing,visible});
function fixture():SubjectMotionPlan{return {schema:"hv-subject-motion/1",source:{sha256:"a".repeat(64),width:832,height:480},prompt:"A red ball moves across a table.",seed:7,subjects:[{id:"ball",label:"Red ball",tracks:[{id:"center",keyframes:[frame(0,0,0,"smooth"),frame(40,10000,10000,"linear",false),frame(80,0,0)]}]}]};}
test("subject tracks sample timed points and stepped visibility without flipping the coordinate origin",()=>{
  const plan=subjectMotionPlan(fixture()),track=plan.subjects[0]!.tracks[0]!;
  expect(sampleSubjectTrack(track,0)).toEqual({x:0,y:0,visible:true});
  expect(sampleSubjectTrack(track,10)).toEqual({x:1562.5,y:1562.5,visible:true});
  expect(sampleSubjectTrack(track,20)).toEqual({x:5000,y:5000,visible:true});
  expect(sampleSubjectTrack(track,40)).toEqual({x:10000,y:10000,visible:false});
  expect(sampleSubjectTrack(track,60)).toEqual({x:5000,y:5000,visible:false});
  expect(sampleSubjectTrack(track,80)).toEqual({x:0,y:0,visible:true});
  for(let i=0;i<=80;i++){const point=sampleSubjectTrack(track,i);expect(point.x).toBeGreaterThanOrEqual(0);expect(point.x).toBeLessThanOrEqual(10000);}
  expect(()=>sampleSubjectTrack(track,81)).toThrow();expect(()=>sampleSubjectTrack(track,.5)).toThrow();
});
test("native subject plans reject unsupported timing, stale-shaped sources and ambiguous point identities",()=>{
  const invalid:Array<(p:SubjectMotionPlan)=>void>=[
    p=>{p.source.width=1920;},p=>{p.source.sha256="not-a-hash";},p=>{p.seed=NaN;},p=>{p.subjects=[];},
    p=>{p.subjects.push(structuredClone(p.subjects[0]!));},p=>{p.subjects[0]!.tracks.push(structuredClone(p.subjects[0]!.tracks[0]!));},
    p=>{p.subjects[0]!.tracks[0]!.keyframes[1]!.frame=41;},p=>{p.subjects[0]!.tracks[0]!.keyframes[1]!.frame=0;},
    p=>{p.subjects[0]!.tracks[0]!.keyframes[0]!.visible=false;},p=>{p.subjects[0]!.tracks[0]!.keyframes[0]!.frame=4;},
    p=>{p.subjects[0]!.tracks[0]!.keyframes[2]!.frame=76;},p=>{p.subjects[0]!.tracks[0]!.keyframes[1]!.x=10001;},
    p=>{p.subjects[0]!.tracks[0]!.keyframes[1]!.y=-1;},p=>{p.subjects[0]!.tracks[0]!.keyframes[1]!.y=.5;},
    p=>{p.subjects[0]!.label=" ";},p=>{p.subjects[0]!.id="../source";},p=>{p.prompt="bad\u0000prompt";},
    p=>{Object.assign(p,{cameraPath:{}});},p=>{Object.assign(p.subjects[0]!.tracks[0]!.keyframes[1]!,{speed:1});},
    p=>{const second=structuredClone(p.subjects[0]!);second.id="other";p.subjects.push(second);},
  ];
  for(const change of invalid){const plan=fixture();change(plan);expect(()=>subjectMotionPlan(plan)).toThrow();}
});
test("source bytes, subject association, visibility, prompt and seed are revision bound",()=>{
  const original=fixture(),revision=subjectMotionRevision(original);
  for(const change of [(p:SubjectMotionPlan)=>{p.source.sha256="b".repeat(64);},(p:SubjectMotionPlan)=>{p.subjects[0]!.label="Blue ball";},(p:SubjectMotionPlan)=>{p.seed++;},(p:SubjectMotionPlan)=>{p.prompt+=" It slows down.";},(p:SubjectMotionPlan)=>{p.subjects[0]!.tracks[0]!.keyframes[1]!.visible=true;}]){const plan=fixture();change(plan);expect(subjectMotionRevision(plan)).not.toBe(revision);}
  const normalized=subjectMotionPlan(original);normalized.subjects[0]!.tracks[0]!.keyframes[0]!.x=800;
  expect(original.subjects[0]!.tracks[0]!.keyframes[0]!.x).toBe(0);
  expect(subjectMotionRevision({...original,prompt:" "+original.prompt+" "})).toBe(revision);
});
