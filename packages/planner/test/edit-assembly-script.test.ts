import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {projectEditAssemblyScript} from "../src/edit-assembly-script";
import {createEditAssemblyPlan} from "../src/edit-assembly-clock";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {applyEditOperation,editTimeline,type EditClip,type EditLane,type EditSource,type EditTimeline} from "../src/edit-timeline";
import type {EditAssemblyRange} from "../src/edit-assembly-types";
import type {EditScriptEntry,EditScriptSourceIndex,EditScriptWindow} from "../src/edit-script-types";

const S=1600,Q=65536,assemblyRevision=contentHash('assembly-record');
const source=(id='original'):EditSource=>({id,revision:contentHash('facts-'+id),label:id,frames:120,width:32,height:24,audio:['mix','dialogue'],captions:[],voices:[],unmeasuredAudio:false});
const clip=(id:string,lane:EditLane='picture',at=0,from=0,frames=60,sourceId='original',layer=0):EditClip=>({id,sourceId,lane,layer,at,from,frames,link:null,gainDb:0,opacity:1,crop:null,envelope:{from,frames,fadeIn:0,fadeOut:0}});
const timeline=(clips=[clip('picture')],sources=[source()],frames=100)=>editTimeline({schema:'hv-edit-timeline/1',width:32,height:24,frames,sources,clips,markers:[]});
const range=(id:string,fromFrame:number,toFrame:number):EditAssemblyRange=>({id,fromFrame,toFrame,reason:'Keep this parent interval.'});
const plan=(t:EditTimeline,ranges:EditAssemblyRange[])=>createEditAssemblyPlan({sequenceId:'parent',historyRevision:contentHash('history'),timeline:t,sourceReceipts:t.sources.map(s=>({sourceId:s.id,receiptRevision:contentHash('receipt-'+s.id)}))},ranges);
const window=(startSample:number,endSample:number,lanes:EditLane[]=['picture'],evidence:EditScriptWindow['evidence']='measured-speech'):EditScriptWindow=>({startSample,endSample,lanes,evidence});
const entry=(id:string,windows:EditScriptWindow[]):EditScriptEntry=>({id,kind:'dialogue',sceneIndex:0,startLine:3,endLine:3,text:'Same spoken words.',character:'MARLA',windows});
const seal=<T extends object>(value:T)=>({...value,revision:contentHash(value)});
const index=(s:EditSource,entries:EditScriptEntry[],script='INT. ROOM - DAY\n\nMARLA\nSame spoken words.'):EditScriptSourceIndex=>seal({schema:'hv-edit-script-source/1' as const,sourceId:s.id,sourceRevision:s.revision,receiptRevision:contentHash('receipt-'+s.id),label:s.label,language:'en',scriptRevision:contentHash(script),scriptText:script,entries,warnings:[]});

test('assembly script keeps repeated and reordered picture/speech/coverage occurrences with parent clip identities',()=>{
  const t=timeline([clip('picture','picture',0,10,30),clip('independent-sound','mix',3,11,30)]),p=plan(t,[range('later',10,15),range('early',1,5),range('repeat',1,5),range('omitted-gap',40,45)]);
  const sources=[index(t.sources[0]!,[entry('line',[window(12*S+100,14*S+200,['picture','mix']),window(10*S,20*S,['picture'],'shot-coverage')]),entry('other-line',[window(17*S,18*S,['picture'])])])];
  const parent=projectEditScriptNavigation(p.parent.sequenceId,p.parent.historyRevision,t,sources),result=projectEditAssemblyScript('assembly',assemblyRevision,p,sources);
  expect(result.schema).toBe('hv-edit-assembly-script/1');expect(result.parentNavigationRevision).toBe(parent.revision);expect(result.occurrences.some(o=>o.rangeId==='later'||o.rangeId==='omitted-gap')).toBe(false);expect(result.occurrences).toHaveLength(6);expect(new Set(result.occurrences.map(o=>o.id)).size).toBe(6);
  const a=result.occurrences.filter(o=>o.rangeId==='early'),b=result.occurrences.filter(o=>o.rangeId==='repeat');expect(a.map(o=>[o.clipId,o.lane,o.evidence])).toEqual([['picture','picture','shot-coverage'],['picture','picture','measured-speech'],['independent-sound','mix','measured-speech']]);
  for(const first of a){const second=b.find(o=>o.parentOccurrenceId===first.parentOccurrenceId)!;expect(second.startSample-first.startSample).toBe(4*S);expect(second.endSample-first.endSample).toBe(4*S);expect(second.sourceStartSample).toBe(first.sourceStartSample);expect(second.sourceEndSample).toBe(first.sourceEndSample);expect(second.id).not.toBe(first.id);expect(parent.occurrences.some(o=>o.id===first.parentOccurrenceId&&o.clipId===first.clipId)).toBe(true);}
  expect(a.find(o=>o.lane==='mix')).toMatchObject({startSample:8*S+100,endSample:9*S,parentStartSample:4*S+100,parentEndSample:5*S,sourceStartSample:12*S+100,sourceEndSample:13*S});expect(result.warnings.join(' ')).toContain('retained parent');
});

test('clipped ramp occurrences match enumerated original-clock membership and recompute curved source endpoints',()=>{
  const c=clip('ramp','dialogue',3,10,30);c.timing={from:10,offset:7,points:[{frame:0,rate:500},{frame:37,rate:1750}]};c.envelope.frames=37;
  const original=(sample:number)=>{const x=sample-3*S+7*S;return Math.round((10*S+500*x/1000+1250*x*x/(2*37*S*1000))*Q)/Q;};c.from=Math.floor(original(3*S)/S);
  const w=window(14*S+123,29*S+456,['dialogue']),t=timeline([c]),ranges=[range('late',15,22),range('early',4,10),range('gap',50,52),range('late-again',15,22)],p=plan(t,ranges),sources=[index(t.sources[0]!,[entry('ramped',[w])])],result=projectEditAssemblyScript('assembly',assemblyRevision,p,sources),expected:number[]=[],actual:number[]=[];let offset=0;
  for(const r of ranges){for(let parentSample=r.fromFrame*S;parentSample<r.toFrame*S;parentSample++)if(parentSample>=3*S&&parentSample<33*S&&original(parentSample)>=w.startSample&&original(parentSample)<w.endSample)expected.push(offset+parentSample-r.fromFrame*S);offset+=(r.toFrame-r.fromFrame)*S;}
  for(const o of result.occurrences){for(let sample=o.startSample;sample<o.endSample;sample++)actual.push(sample);expect(o.sourceStartSample).toBe(Math.max(w.startSample,original(o.parentStartSample)));expect(o.sourceEndSample).toBe(Math.min(w.endSample,original(o.parentEndSample)));expect(o.startFrame).toBe(Math.floor(o.startSample/S));expect(o.endFrame).toBe(Math.ceil(o.endSample/S));expect(o.held).toBe(false);}
  expect(actual).toEqual(expected);expect(result.occurrences.some(o=>o.sourceStartSample%1!==0)).toBe(true);
  const parent=projectEditScriptNavigation('parent',p.parent.historyRevision,t,sources).occurrences[0]!,part=result.occurrences[0]!,linear=parent.sourceStartSample+(parent.sourceEndSample-parent.sourceStartSample)*(part.parentStartSample-parent.startSample)/(parent.endSample-parent.startSample);expect(Math.abs(part.sourceStartSample-linear)).toBeGreaterThan(100);
});

test('source versions remain distinct and a graphic retains its explicit absence of screenplay evidence',()=>{
  const a=source('a'),b=source('b'),graphic:EditSource={...source('graphic'),audio:[],media:'graphic-rgba'},t=timeline([clip('a-picture','picture',0,0,10,'a'),clip('b-picture','picture',10,0,10,'b'),clip('graphic-picture','picture',0,0,20,'graphic',1)],[a,b,graphic]),p=plan(t,[range('reverse-b',10,20),range('reverse-a',0,10)]),first=index(a,[entry('same-id',[window(0,10*S)])],'Original screenplay'),second=index(b,[{...entry('same-id',[window(0,10*S)]),performedText:'Localized performance.'}],'Revised screenplay'),noScript=seal({schema:'hv-edit-script-source/1' as const,sourceId:graphic.id,sourceRevision:graphic.revision,receiptRevision:contentHash('receipt-graphic'),label:graphic.label,language:'und',scriptRevision:null,scriptText:null,entries:[],warnings:['This graphic has no screenplay source.']}),result=projectEditAssemblyScript('assembly',assemblyRevision,p,[noScript,second,first]);
  expect(result.sources.map(s=>s.sourceId)).toEqual(['a','b','graphic']);expect(result.sources.map(s=>s.scriptText)).toEqual(['Original screenplay','Revised screenplay',null]);expect(result.sources[1]!.entries[0]!.performedText).toBe('Localized performance.');expect(result.sources[2]!.warnings).toEqual(noScript.warnings);expect(result.occurrences.map(o=>[o.sourceId,o.entryId,o.clipId,o.rangeId,o.startSample])).toEqual([['b','same-id','b-picture','reverse-b',0],['a','same-id','a-picture','reverse-a',10*S]]);expect(result.occurrences[0]!.id).not.toBe(result.occurrences[1]!.id);
});

test('caption and picture dissolve handles retain transition evidence while zero-speed audio alone is muted',()=>{
  const clips=(['picture','mix','captions'] as const).flatMap(lane=>[{...clip('left-'+lane,lane,0,10,30),link:'left'},{...clip('right-'+lane,lane,30,60,30),link:'right'}]);
  const held:EditClip[]=(['picture','mix','captions'] as const).map(lane=>({...clip('held-'+lane,lane,70,40,10),timing:{from:40,offset:0,points:[{frame:0,rate:0},{frame:10,rate:0}]}}));
  const t=applyEditOperation(timeline([...clips,...held]),{kind:'crossfade',leftId:'left-picture',rightId:'right-picture',linked:true,frames:7,alignment:'center',ids:{'left-picture':'picture-fade','left-mix':'audio-fade'}}),p=plan(t,[range('dissolve',28,32),range('hold',72,75)]),sources=[index(t.sources[0]!,[entry('incoming',[window(58*S+7,59*S+9,['picture','mix','captions'])]),entry('held',[window(40*S,41*S,['picture','mix','captions'])])])],result=projectEditAssemblyScript('assembly',assemblyRevision,p,sources);
  const incoming=result.occurrences.filter(o=>o.entryId==='incoming');expect(incoming).toHaveLength(3);expect(incoming.every(o=>o.transition&&o.rangeId==='dissolve'&&o.parentStartSample===28*S+7&&o.startSample===7)).toBe(true);
  const holds=result.occurrences.filter(o=>o.rangeId==='hold');expect(holds).toHaveLength(3);for(const o of holds){expect(o).toMatchObject({sourceStartSample:40*S,sourceEndSample:40*S,parentStartSample:72*S,parentEndSample:75*S,startSample:4*S,endSample:7*S,held:true,transition:false});expect(o.muted).toBe(o.lane==='mix');}
  const zero=clip('zero','mix',0,20,20);zero.timing={from:20,offset:0,points:[{frame:0,rate:1000},{frame:10,rate:0},{frame:20,rate:1000}]};const z=timeline([zero]),zeroResult=projectEditAssemblyScript('assembly',assemblyRevision,plan(z,[range('from-zero',10,12)]),[index(z.sources[0]!,[entry('whole',[window(0,120*S,['mix'])])])]);expect(zeroResult.occurrences.map(o=>[o.startSample,o.endSample,o.held,o.muted])).toEqual([[0,1,true,true],[1,2*S,false,false]]);
});

test('navigation validates exact assembly and receipt identities, rejects tampering and owns all returned data',()=>{
  const t=timeline(),p=plan(t,[range('keep',1,4)]),sources=[index(t.sources[0]!,[entry('line',[window(0,10*S)])])],before=JSON.stringify({p,sources}),result=projectEditAssemblyScript('assembly',assemblyRevision,p,sources),{revision,...data}=result;expect(revision).toBe(contentHash(data));expect(projectEditAssemblyScript('assembly',assemblyRevision,p,sources)).toEqual(result);expect(projectEditAssemblyScript('other',assemblyRevision,p,sources).revision).not.toBe(revision);expect(projectEditAssemblyScript('assembly',contentHash('next'),p,sources).revision).not.toBe(revision);
  result.sources[0]!.entries[0]!.text='Changed';result.occurrences[0]!.sourceStartSample=0;expect(JSON.stringify({p,sources})).toBe(before);expect(projectEditAssemblyScript('assembly',assemblyRevision,p,sources).occurrences[0]!.sourceStartSample).toBe(S);
  for(const [id,rev]of [['bad id',assemblyRevision],['assembly','wrong']])expect(()=>projectEditAssemblyScript(id!,rev!,p,sources)).toThrow();expect(()=>projectEditAssemblyScript('assembly',assemblyRevision,{...p,frames:1},sources)).toThrow('changed');
  const wrongReceipt=structuredClone(sources[0]!);wrongReceipt.receiptRevision=contentHash('wrong-receipt');const {revision:_old,...wrongData}=wrongReceipt;expect(()=>projectEditAssemblyScript('assembly',assemblyRevision,p,[seal(wrongData)])).toThrow('receipt binding');
  for(const mutate of [(s:any)=>s.entries[0].windows[0].startSample=.5,(s:any)=>s.sourceRevision=contentHash('other'),(s:any)=>s.entries[0].windows[0].lanes=['missing'],(s:any)=>s.entries[0].performedText=undefined,(s:any)=>s.extra=true]){const bad=structuredClone(sources[0]!);mutate(bad);expect(()=>projectEditAssemblyScript('assembly',assemblyRevision,p,[bad])).toThrow();}
  expect(()=>projectEditAssemblyScript('assembly',assemblyRevision,p,[])).toThrow('every original');const omitted=projectEditAssemblyScript('assembly',assemblyRevision,plan(t,[range('gap',80,90)]),sources);expect(omitted.occurrences).toEqual([]);expect(omitted.sources).toEqual(sources);
});

test('expanded occurrence count and final serialized response are bounded without returning partial navigation',()=>{
  const t=timeline(),sources=[index(t.sources[0]!,Array.from({length:400},(_,i)=>entry('line-'+i,[window(0,S)])))],ranges=Array.from({length:256},(_,i)=>range('repeat-'+i,0,1));expect(()=>projectEditAssemblyScript('assembly',assemblyRevision,plan(t,ranges),sources)).toThrow('100,000-occurrence');
  const withinCount=[index(t.sources[0]!,Array.from({length:80},(_,i)=>entry('line-'+i,[window(0,S)])))];expect(()=>projectEditAssemblyScript('assembly',assemblyRevision,plan(t,ranges),withinCount)).toThrow('8 MiB');
  const huge=index(t.sources[0]!,[{...entry('large',[]),text:'界'.repeat(3*1024**2)}]);expect(()=>projectEditAssemblyScript('assembly',assemblyRevision,plan(t,[range('one',0,1)]),[huge])).toThrow('8 MiB');
});
