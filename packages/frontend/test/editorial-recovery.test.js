import {expect,test} from "bun:test";
import {savedEditorialEdit,matchesSavedEditorialEdit,savedEditorialSource,matchesSavedEditorialSource} from "../src/editorial.js";
import {createEditHistory,appendEdit,moveEditCursor} from "../../planner/src/edit-history";
import {initialEditTimeline} from "../../planner/src/edit-timeline";

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
