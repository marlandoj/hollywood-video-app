import {expect,test} from "bun:test";
import {savedEditorialEdit,matchesSavedEditorialEdit,savedEditorialSource,matchesSavedEditorialSource,editorialCrossfadeOperation,editorialMaskReview} from "../src/editorial.js";
import {createEditHistory,appendEdit,moveEditCursor,editHistoryState} from "../../planner/src/edit-history";
import {initialEditTimeline} from "../../planner/src/edit-timeline";
import {newMask} from '../src/mask-draft.js';
import {editRenderReview} from '../../planner/src/edit-jobs';
import {editCompositeReview} from '../../planner/src/edit-composite-review';

test('atomic mask edits recover a lost reply only for the exact authored composite, including after undo',()=>{
  const source={id:'source',revision:'a'.repeat(64),label:'Original',frames:90,width:320,height:180,audio:[],captions:[],voices:[],unmeasuredAudio:false},history=createEditHistory('history',initialEditTimeline([source],source.id,320,180)),current={libraryVersion:1,sequence:{id:'sequence',history}},composite={schema:'hv-edit-composite/1',masks:[newMask('rectangle',source,0,()=> 'mask')]},change={kind:'edit',label:'Author mask',operation:{kind:'composite',clipId:'initial-0',composite}},saved=JSON.parse(JSON.stringify(savedEditorialEdit(current,change))),committed={libraryVersion:2,sequence:{...current.sequence,history:appendEdit(history,change.operation,change.label,history.revision)}};
  expect(matchesSavedEditorialEdit(committed,saved)).toBe(true);expect(matchesSavedEditorialEdit(current,saved)).toBe(false);
  const wrong=structuredClone(saved);wrong.body.change.operation.composite.masks[0].featherQ8=256;expect(matchesSavedEditorialEdit(committed,wrong)).toBe(false);
  const undone={...committed,sequence:{...committed.sequence,history:moveEditCursor(committed.sequence.history,0,'undo','Undo mask',committed.sequence.history.revision)}};expect(matchesSavedEditorialEdit(undone,saved)).toBe(true);expect(editHistoryState(undone.sequence.history).timeline.clips[0].composite).toBeUndefined();
});

test('mask export review rejects absent or stale composition warnings before rendering the saved revision',()=>{
  const source={id:'source',revision:'a'.repeat(64),label:'Original',frames:90,width:320,height:180,audio:[],captions:[],voices:[],unmeasuredAudio:false};let history=createEditHistory('history',initialEditTimeline([source],source.id,320,180));history=appendEdit(history,{kind:'composite',clipId:'initial-0',composite:{schema:'hv-edit-composite/1',masks:[newMask('ellipse',source,0,()=> 'mask')]}},'Mask',history.revision);
  const timeline=editHistoryState(history).timeline,current={timeline},quote={timelineRevision:timeline.revision,review:editRenderReview(timeline),compositing:editCompositeReview(timeline)};expect(editorialMaskReview(current,quote)).toEqual(quote.compositing);expect(quote.compositing.warnings.length).toBeGreaterThan(0);
  for(const patch of [{timelineRevision:'b'.repeat(64)},{review:{...quote.review,timelineRevision:'b'.repeat(64)}},{review:{...quote.review,compositingRevision:undefined}},{compositing:undefined},{compositing:{...quote.compositing,timelineRevision:'b'.repeat(64)}},{compositing:{...quote.compositing,warnings:[{}]}}])expect(()=>editorialMaskReview(current,{...quote,...patch})).toThrow('review changed');
  const clean=initialEditTimeline([source],source.id,320,180);expect(editorialMaskReview({timeline:clean},{timelineRevision:clean.revision,review:editRenderReview(clean)})).toBeUndefined();
});
test('crossfade edits keep every track identity through saved response recovery and later duration changes',()=>{
  const source={id:'source',revision:'a'.repeat(64),label:'Original',frames:90,width:64,height:48,audio:['mix'],captions:[],voices:[],unmeasuredAudio:true};let history=createEditHistory('history',initialEditTimeline([source],source.id,64,48));history=appendEdit(history,{kind:'split',clipId:'initial-0',linked:true,at:45,rightIds:{'initial-0':'right-picture','initial-1':'right-mix','initial-2':'right-captions'},rightLink:'right'},'Split',history.revision,1);
  const timeline=editHistoryState(history).timeline;let next=0;const op=editorialCrossfadeOperation(timeline,'initial-0','right-picture',true,8,'center',()=>`fade-${next++}`);expect(Object.keys(op.ids).sort()).toEqual(['initial-0','initial-1']);expect(next).toBe(2);
  const current={libraryVersion:2,sequence:{id:'sequence',history}},saved=JSON.parse(JSON.stringify(savedEditorialEdit(current,{kind:'edit',operation:op,label:'Crossfade'})));history=appendEdit(history,op,'Crossfade',history.revision,2);const actual={libraryVersion:3,sequence:{id:'sequence',history}};expect(matchesSavedEditorialEdit(actual,saved)).toBe(true);
  const updated=editorialCrossfadeOperation(editHistoryState(history).timeline,'initial-0','right-picture',true,10,'start',()=>{throw new Error('Existing transition needs no new ID');});expect(updated.ids).toEqual(op.ids);expect(matchesSavedEditorialEdit(actual,{...saved,body:{...saved.body,change:{...saved.body.change,operation:updated}}})).toBe(false);
});

test("lost browser edit responses match the event chain, including the first edit and undo after reopen",()=>{
  const source={id:"source",revision:"a".repeat(64),label:"Retained source",frames:90,width:640,height:360,audio:["mix"],captions:[],voices:[],unmeasuredAudio:true};
  const history=createEditHistory("history",initialEditTimeline([source],source.id,640,360));
  const initial={libraryVersion:1,sequence:{id:"sequence",label:"Assembly",history}};
  const change={kind:"edit",label:"Place opening marker",operation:{kind:"marker",marker:{id:"opening",frame:15,label:"Opening"}}};
  const saved=JSON.parse(JSON.stringify(savedEditorialEdit(initial,change)));
  expect(saved.previousEventRevision).not.toBe(saved.body.expectedHistoryRevision);
  const committed={libraryVersion:2,sequence:{...initial.sequence,history:appendEdit(history,change.operation,change.label,history.revision)}};
  expect(matchesSavedEditorialEdit(committed,saved)).toBe(true);
  expect(matchesSavedEditorialEdit(initial,saved)).toBe(false);
  const undo={kind:"cursor",reason:"undo",target:0,label:"Undo marker"},retry=JSON.parse(JSON.stringify(savedEditorialEdit(committed,undo)));
  const undone={libraryVersion:3,sequence:{...initial.sequence,history:moveEditCursor(committed.sequence.history,0,"undo",undo.label,committed.sequence.history.revision)}};
  expect(matchesSavedEditorialEdit(undone,retry)).toBe(true);
  expect(matchesSavedEditorialEdit(undone,saved)).toBe(true);
  expect(matchesSavedEditorialEdit({...undone,sequence:{...undone.sequence,id:"another"}},retry)).toBe(false);
  const concurrent={...committed,sequence:{...committed.sequence,history:appendEdit(history,{...change.operation,marker:{...change.operation.marker,frame:16}},change.label,history.revision)}};
  expect(matchesSavedEditorialEdit(concurrent,saved)).toBe(false);
  expect(matchesSavedEditorialEdit(undone,{...retry,previousEventRevision:"b".repeat(64)})).toBe(false);
});

test("lost source-admission replies recover only the exact receipt and append position even after undo",()=>{
  const source={id:"source",revision:"a".repeat(64),label:"First",frames:90,width:640,height:360,audio:["mix"],captions:[],voices:[],unmeasuredAudio:true},history=createEditHistory("history",initialEditTimeline([source],source.id,640,360)),initial={libraryVersion:1,sequence:{id:"sequence",history}},item={jobId:"carrier",sourceRevision:"b".repeat(64),facts:{...source,id:"later",label:"Later"}},saved=JSON.parse(JSON.stringify(savedEditorialSource(initial,item))),operation={kind:"source",source:item.facts,receiptRevision:item.sourceRevision};
  const committed={libraryVersion:2,sequence:{...initial.sequence,history:appendEdit(history,operation,"Add original: Later",history.revision)}};expect(matchesSavedEditorialSource(committed,saved)).toBe(true);expect(matchesSavedEditorialSource(initial,saved)).toBe(false);
  const undone={...committed,sequence:{...committed.sequence,history:moveEditCursor(committed.sequence.history,0,"undo","Undo addition",committed.sequence.history.revision)}};expect(matchesSavedEditorialSource(undone,saved)).toBe(true);
  for(const patch of [{sourceId:"different"},{eventCount:1},{previousEventRevision:"c".repeat(64)},{sequenceId:"another"},{body:{...saved.body,sourceRevision:"c".repeat(64)}}])expect(matchesSavedEditorialSource(committed,{...saved,...patch})).toBe(false);
});
