import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {reviewEditAssemblyBoundaries} from "../src/edit-assembly-boundaries";
import {createEditAssemblyPlan} from "../src/edit-assembly-clock";
import {applyEditOperation,editSpeechCuts,editTimeline,type EditClip,type EditLane,type EditSource,type EditTimeline,type EditVoiceWindow} from "../src/edit-timeline";
import type {EditAssemblyPlan,EditAssemblyRange} from "../src/edit-assembly-types";

const S=1600,Q=65536;
const voice=(id:string,start:number,end:number,lane:EditVoiceWindow['lane']='dialogue'):EditVoiceWindow=>({id,start,end,lane});
const source=(voices:EditVoiceWindow[]=[],unmeasuredAudio=false,id='original'):EditSource=>({id,revision:contentHash(id),label:'Retained source',frames:200,width:32,height:24,audio:['mix','dialogue','narration','music','ambience','effects'],captions:[],voices,unmeasuredAudio});
const clip=(id:string,lane:EditLane='mix',at=0,from=0,frames=100,sourceId='original'):EditClip=>({id,sourceId,lane,layer:0,at,from,frames,link:null,gainDb:0,opacity:1,crop:null,envelope:{from,frames,fadeIn:0,fadeOut:0}});
const timeline=(s:EditSource,clips=[clip('sound')],frames=100)=>editTimeline({schema:'hv-edit-timeline/1',width:32,height:24,frames,sources:[s],clips,markers:[]});
const range=(id:string,fromFrame:number,toFrame:number):EditAssemblyRange=>({id,fromFrame,toFrame,reason:'Retain this parent output range.'});
const plan=(t:EditTimeline,ranges=[range('whole',0,t.frames)])=>createEditAssemblyPlan({sequenceId:'parent',historyRevision:contentHash('history'),timeline:t,sourceReceipts:t.sources.map(s=>({sourceId:s.id,receiptRevision:contentHash('receipt-'+s.id)}))},ranges);
const reseal=(value:EditAssemblyPlan):EditAssemblyPlan=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)};};

test('new boundary review skips full parent output, continuous selections and inherited clip trims',()=>{
  const t=timeline(source([voice('whole',0,150*S)],true)),whole=reviewEditAssemblyBoundaries(plan(t)),continuous=reviewEditAssemblyBoundaries(plan(t,[range('a',0,25),range('b',25,60),range('c',60,100)]));
  expect(whole.speechCuts).toEqual([]);expect(whole.unmeasuredAudioCuts).toEqual([]);expect(continuous.speechCuts).toEqual([]);expect(continuous.unmeasuredAudioCuts).toEqual([]);
  const trimmed=timeline(source([voice('already-cut',19*S,31*S)],true),[clip('trimmed','mix',10,20,10)]);expect(editSpeechCuts(trimmed)).toEqual([{clipId:'trimmed',voiceId:'already-cut',edge:'in'},{clipId:'trimmed',voiceId:'already-cut',edge:'out'}]);
  const retained=reviewEditAssemblyBoundaries(plan(trimmed,[range('existing-clip',10,20)]));expect(retained.speechCuts).toEqual([]);expect(retained.unmeasuredAudioCuts).toEqual([]);
  const newlyTrimmed=reviewEditAssemblyBoundaries(plan(trimmed,[range('inside',11,19)]));expect(newlyTrimmed.speechCuts.map(c=>[c.edge,c.parentFrame,c.sourceSample])).toEqual([['in',11,21*S],['out',19,29*S]]);
});

test('strict source-window interiors match speech lanes and exclude exact voice endpoints',()=>{
  const voices=[voice('ends-at-in',2*S,10*S),voice('starts-at-in',10*S,30*S),voice('across',5*S,25*S),voice('ends-at-out',0,20*S),voice('starts-at-out',20*S,40*S),voice('narrator',5*S,25*S,'narration')],t=timeline(source(voices),['mix','dialogue','narration','music','picture','captions'].map(lane=>clip(lane,lane as EditLane))),review=reviewEditAssemblyBoundaries(plan(t,[range('selection',10,20)]));
  const rows=(lane:string,edge:string)=>review.speechCuts.filter(c=>c.lane===lane&&c.edge===edge).map(c=>c.voiceId).sort();
  expect(rows('mix','in')).toEqual(['across','ends-at-out','narrator']);expect(rows('mix','out')).toEqual(['across','narrator','starts-at-in']);expect(rows('dialogue','in')).toEqual(['across','ends-at-out']);expect(rows('dialogue','out')).toEqual(['across','starts-at-in']);expect(rows('narration','in')).toEqual(['narrator']);expect(rows('narration','out')).toEqual(['narrator']);expect(review.speechCuts.some(c=>['music','picture','captions'].includes(c.lane))).toBe(false);expect(review.unmeasuredAudioCuts).toEqual([]);
});

test('ramp boundary source addresses match an independent integrated Q16 clock without flooring to source frames',()=>{
  const c=clip('ramp','dialogue',3,20,30);c.timing={from:20,offset:7,points:[{frame:0,rate:500},{frame:37,rate:1750}]};const integral=(frame:number)=>{const x=(frame-3+7)*S;return Math.round((20*S+.5*x+(1.75-.5)*x*x/(2*37*S))*Q)/Q;};c.from=Math.floor(integral(3)/S);c.envelope.frames=37;
  const t=timeline(source([voice('line',0,150*S)]),[c]),result=reviewEditAssemblyBoundaries(plan(t,[range('ramp-window',8,19)]));expect(result.speechCuts).toHaveLength(2);expect(result.speechCuts.map(c=>[c.edge,c.sourceSample,c.outputFrame])).toEqual([['in',integral(8),0],['out',integral(19),11]]);expect(result.speechCuts.some(c=>c.sourceSample%1!==0)).toBe(true);expect(result.speechCuts.every(c=>!c.mutedHold)).toBe(true);
});

test('odd dissolve boundaries include both borrowed audio handles and retain repeated range identities',()=>{
  const s=source([voice('outgoing-handle',39*S,43*S),voice('incoming-handle',56*S,60*S)]),left=clip('left','mix',0,10,30),right=clip('right','mix',30,60,30),base=timeline(s,[left,right],60),t=applyEditOperation(base,{kind:'crossfade',leftId:'left',rightId:'right',linked:false,frames:7,alignment:'center',ids:{left:'odd-fade'}}),result=reviewEditAssemblyBoundaries(plan(t,[range('first',28,32),range('repeat',28,32)]));
  expect(result.speechCuts.map(c=>[c.rangeId,c.clipId,c.voiceId,c.edge,c.parentFrame,c.outputFrame,c.sourceSample])).toEqual([['first','right','incoming-handle','in',28,0,58*S],['first','left','outgoing-handle','out',32,4,42*S],['repeat','right','incoming-handle','in',28,4,58*S],['repeat','left','outgoing-handle','out',32,8,42*S]]);
  expect(reviewEditAssemblyBoundaries(plan(base,[range('uncrossfaded',28,32)])).speechCuts).toEqual([]);
  const both=timeline(source([voice('broad',0,150*S)]),[left,right],60),crossed=applyEditOperation(both,{kind:'crossfade',leftId:'left',rightId:'right',linked:false,frames:7,alignment:'center',ids:{left:'odd-fade'}});expect(reviewEditAssemblyBoundaries(plan(crossed,[range('inside-fade',28,32)])).speechCuts.map(c=>[c.edge,c.clipId])).toEqual([['in','left'],['in','right'],['out','left'],['out','right']]);
});

test('held speech is flagged as muted and unknown audio boundaries remain distinct from measured lane evidence',()=>{
  const held=clip('hold','dialogue',10,40,20);held.timing={from:40,offset:0,points:[{frame:0,rate:0},{frame:20,rate:0}]};const t=timeline(source([voice('held-line',39*S,41*S)],true),[held,clip('bed','music')]),review=reviewEditAssemblyBoundaries(plan(t,[range('held',12,18)]));
  expect(review.speechCuts.map(c=>[c.clipId,c.edge,c.sourceSample,c.mutedHold])).toEqual([['hold','in',40*S,true],['hold','out',40*S,true]]);expect(review.unmeasuredAudioCuts.map(c=>[c.clipId,c.edge,c.mutedHold])).toEqual([['hold','in',true],['bed','in',false],['hold','out',true],['bed','out',false]]);expect(review.speechCuts.some(c=>c.clipId==='bed')).toBe(false);
  const ramp=clip('isolated-zero','mix',0,20,20);ramp.timing={from:20,offset:0,points:[{frame:0,rate:1000},{frame:10,rate:0},{frame:20,rate:1000}]};const endpoint=reviewEditAssemblyBoundaries(plan(timeline(source([voice('line',0,100*S)]),[ramp]),[range('until-zero',8,10),range('from-zero',10,12)]));expect(endpoint.speechCuts.map(c=>[c.edge,c.parentFrame,c.mutedHold])).toEqual([['in',8,false],['out',12,false]]);
  const isolated=reviewEditAssemblyBoundaries(plan(timeline(source([voice('line',0,100*S)]),[ramp]),[range('from-zero',10,12)]));expect(isolated.speechCuts.find(c=>c.edge==='in')!.mutedHold).toBe(true);
});

test('boundary review seals the exact plan and refuses malformed input without aliasing retained evidence',()=>{
  const p=plan(timeline(source([voice('line',0,150*S)])),[range('first',10,20),range('reordered',5,8)]),before=JSON.stringify(p),result=reviewEditAssemblyBoundaries(p),{revision,...data}=result;expect(revision).toBe(contentHash(data));expect(result.planRevision).toBe(p.revision);expect(reviewEditAssemblyBoundaries(structuredClone(p))).toEqual(result);result.speechCuts[0]!.sourceSample=0;expect(reviewEditAssemblyBoundaries(p).speechCuts[0]!.sourceSample).toBe(10*S);expect(JSON.stringify(p)).toBe(before);
  const changed=structuredClone(p);changed.ranges[0]!.reason='Changed';expect(()=>reviewEditAssemblyBoundaries(changed)).toThrow('changed');const outside=structuredClone(p);outside.ranges[0]!.toFrame=101;expect(()=>reviewEditAssemblyBoundaries(reseal(outside))).toThrow();const extra=structuredClone(p) as any;extra.extra=true;expect(()=>reviewEditAssemblyBoundaries(extra)).toThrow();expect(()=>reviewEditAssemblyBoundaries(null as any)).toThrow();
});

test('measured and unmeasured boundary counts reject overflow instead of silently truncating',()=>{
  const voices=Array.from({length:4096},(_,i)=>voice('v'+i,0,100*S)),clips=Array.from({length:13},(_,i)=>clip('sound-'+i,'mix',0,0,20)),p=plan(timeline(source(voices),clips,20),[range('inside',5,6)]);expect(()=>reviewEditAssemblyBoundaries(p)).toThrow('too many measured');
  const unknown=timeline(source([],true),Array.from({length:256},(_,i)=>clip('sound-'+i,'music',0,0,20)),20),ranges=Array.from({length:256},(_,i)=>range('r'+i,5,6));expect(()=>reviewEditAssemblyBoundaries(plan(unknown,ranges))).toThrow('too many unmeasured');
});

test('bounded boundary counts still reject an oversized serialized review',()=>{
  const id='s'.repeat(128),voices=Array.from({length:512},(_,i)=>voice(('v'+i).padEnd(128,'x'),0,100*S)),clips=Array.from({length:16},(_,i)=>clip(('c'+i).padEnd(128,'x'),'mix',0,0,20,id)),p=plan(timeline(source(voices,false,id),clips,20),[range('r'.repeat(128),5,6)]);expect(()=>reviewEditAssemblyBoundaries(p)).toThrow('8 MiB');
});

test('the serialized review limit includes its final revision field',()=>{
  const limit=8*1024**2,id='s'.repeat(128),rangeId='r'.repeat(128),clipIds=Array.from({length:8},(_,i)=>('c'+i).padEnd(128,'x'));
  const row=(edge:'in'|'out',clipId:string,voiceId:string)=>({rangeId,clipId,sourceId:id,lane:'mix',edge,outputFrame:edge==='in'?0:1,parentFrame:edge==='in'?5:6,sourceSample:edge==='in'?5*S:6*S,mutedHold:false,voiceId});
  const shell={schema:'hv-edit-assembly-boundaries/1',planRevision:'0'.repeat(64),speechCuts:[] as ReturnType<typeof row>[],unmeasuredAudioCuts:[]},baseBytes=Buffer.byteLength(JSON.stringify(shell)),perVoice=clipIds.length*(Buffer.byteLength(JSON.stringify(row('in',clipIds[0]!,'v'.repeat(128))))+Buffer.byteLength(JSON.stringify(row('out',clipIds[0]!,'v'.repeat(128))))+2),count=Math.floor((limit-baseBytes+1)/perVoice)+1;
  // Eight clips and two edges repeat each voice ID sixteen times. Shorten IDs to put the
  // unsealed data just below the cap while its required revision pushes the result over it.
  let shortening=Math.ceil((baseBytes+count*perVoice-1-limit+16)/16);const voiceIds=Array.from({length:count},(_,i)=>{const prefix='v'+i,remove=Math.min(shortening,128-prefix.length);shortening-=remove;return prefix.padEnd(128-remove,'x');});expect(shortening).toBe(0);
  const speechCuts=(['in','out'] as const).flatMap(edge=>clipIds.flatMap(clipId=>voiceIds.map(voiceId=>row(edge,clipId,voiceId)))),data={...shell,speechCuts};expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(limit);expect(Buffer.byteLength(JSON.stringify({...data,revision:'0'.repeat(64)}))).toBeGreaterThan(limit);
  const p=plan(timeline(source(voiceIds.map(v=>voice(v,0,100*S)),false,id),clipIds.map(c=>clip(c,'mix',0,0,20,id)),20),[range(rangeId,5,6)]);expect(()=>reviewEditAssemblyBoundaries(p)).toThrow('8 MiB');
});
