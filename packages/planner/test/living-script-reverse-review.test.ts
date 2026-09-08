import {afterAll,beforeAll,expect,test} from "bun:test";
import {dubStudio,DUB_SCRIPT} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {createEditSequence,emptyEditLibrary,changeEditSequence,type EditLibrary} from "../src/edit-library";
import {editHistoryReplay} from "../src/edit-history";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {createLivingScriptStructureBase,type LivingScriptStructureBase} from "../src/living-script-structure";
import {compileLivingScriptReverseReview,validateLivingScriptReverseReview,LIVING_SCRIPT_REVERSE_LIMITS,type LivingScriptReverseInput,type LivingScriptReverseReview} from "../src/living-script-reverse-review";
import {EDIT_AUDIO_LANES,type EditLane,type EditOperation,type EditSource} from "../src/edit-timeline";
import {renderRecord,renderShots,renderInputHash,type RenderFile} from "../src/shot-reuse";
import {editSourceAudio,editSourceVoiceWindows,editFactsRevision,editSourceKnownFiles,editSourceRequiredPaths,validateEditSourceReceipt} from "../src/edit-sources";
import {castingSnapshot} from "../src/casting";

let fixture:Awaited<ReturnType<typeof dubStudio>>,library:EditLibrary,script:LivingScriptStructureBase,index:ReturnType<typeof compileEditScriptSource>;
beforeAll(async()=>{
  fixture=await dubStudio(undefined,DUB_SCRIPT+"\n\nEXT. GARDEN - NIGHT\n\nSpud leaves.\n\nSPUD\nWelcome to the garden.");
  const source=await inspectEditSource(fixture.film,"Original screenplay film",fixture.paths.artifactRoot,async()=>{});index=compileEditScriptSource(source);
  library=createEditSequence(emptyEditLibrary(),fixture.owner.projectId,[source],"reverse-cut","Original cut",source.facts.id,320,180,0);
  script=createLivingScriptStructureBase({projectId:fixture.owner.projectId,version:fixture.film.scriptVersion,text:fixture.film.scriptText,locks:[]});
},180000);
afterAll(async()=>{await fixture?.close();});
function snapshot(value:EditLibrary){const parent=deriveEditAssemblyParent(fixture.owner.projectId,value,"reverse-cut"),indexes=parent.sourceReceipts.map(binding=>compileEditScriptSource(value.sources.find(source=>source.revision===binding.receiptRevision)!));return {library:value,historyRevision:parent.historyRevision,navigationRevision:projectEditScriptNavigation("reverse-cut",parent.historyRevision,parent.timeline,indexes).revision};}
function input(before:EditLibrary,after:EditLibrary,current=script):LivingScriptReverseInput{return {projectId:fixture.owner.projectId,script:current,sequenceId:"reverse-cut",before:snapshot(before),after:snapshot(after)};}
const compile=(before:EditLibrary,after:EditLibrary,current=script)=>compileLivingScriptReverseReview(input(before,after,current));
const timeline=(value:EditLibrary)=>editHistoryReplay(value.sequences[0]!.history).state.timeline;
function change(value:EditLibrary,operation:EditOperation){return changeEditSequence(value,fixture.owner.projectId,"reverse-cut",{kind:"edit",operation,label:"Reviewed test operation"},value.version,value.sequences[0]!.history.revision);}
function cursor(value:EditLibrary,target:number,reason:"undo"|"branch"="undo"){return changeEditSequence(value,fixture.owner.projectId,"reverse-cut",{kind:"cursor",target,reason,label:"Reviewed branch selection"},value.version,value.sequences[0]!.history.revision);}
const spoken=()=>index.entries.find(entry=>entry.kind==="dialogue")!;
const window=()=>spoken().windows.find(window=>window.evidence==="measured-speech"&&window.lanes.includes("mix"))!;
const lane=(review:LivingScriptReverseReview,kind:EditLane="mix",entryId=spoken().id)=>review.entries.find(value=>value.entry.id===entryId)!.lanes.find(value=>value.lane===kind)!;
const measured=(review:LivingScriptReverseReview,kind:EditLane="mix")=>lane(review,kind).windows.find(value=>value.window.evidence==="measured-speech")!;
const trimTo=(before:EditLibrary,frame:number,clipId="initial-0",linked=true)=>change(before,{kind:"trim",clipId,linked,edge:"out",delta:frame-timeline(before).clips.find(clip=>clip.id===clipId)!.frames,ripple:false});
const reseal=(review:LivingScriptReverseReview)=>{const {revision:_revision,...data}=review;return {...data,revision:contentHash(data)};};

test("actual saved linked trim reviews exact original measured intervals and preserves complete immutable history/receipt context",()=>{
  const w=window(),middle=Math.floor((w.startSample+w.endSample)/3200);expect(middle*1600).toBeGreaterThan(w.startSample);expect(middle*1600).toBeLessThan(w.endSample);
  const after=trimTo(library,middle),beforeHash=contentHash({library,after,script}),review=compile(library,after),m=measured(review);
  expect(review.context).toEqual(input(library,after));expect(review.activeEdits.map(event=>event.operation.kind)).toEqual(["trim"]);
  expect(m.window).toEqual(w);expect(m.before.coverage).toBe("whole");expect(m.after.coverage).toBe("partial");
  expect(m.after.sourceSpans).toEqual([{startSample:w.startSample,endSample:middle*1600}]);expect(m.after.outputSamples).toBe(middle*1600-w.startSample);
  expect(review.entries.find(value=>value.entry.id===spoken().id)).toMatchObject({currentScriptMatch:true});expect(review.entries.find(value=>value.entry.id===spoken().id)!.currentLineIds).toHaveLength(1);
  expect(lane(review).reasons.join(" ")).toContain("No word deletion");expect(review.warnings.join(" ")).toContain("separate explicit structural proposal");
  expect(contentHash({library,after,script})).toBe(beforeHash);expect(validateLivingScriptReverseReview(JSON.parse(JSON.stringify(review)))).toEqual(review);
});

test("already cropped before occurrence stays partial relative to the full original line rather than becoming a false whole line",()=>{
  const w=window(),end=Math.floor((w.startSample+3*w.endSample)/6400),before=trimTo(library,end),after=trimTo(before,end-1),review=compile(before,after),m=measured(review);
  expect(m.before.coverage).toBe("partial");expect(m.after.coverage).toBe("partial");expect(m.window.startSample).toBe(w.startSample);expect(m.window.endSample).toBe(w.endSample);
  expect(m.before.sourceSpans[0]!.endSample).toBe(end*1600);expect(m.after.sourceSpans[0]!.endSample).toBe((end-1)*1600);
});

test("picture-only trim does not remove dialogue, and unaligned action/caption lanes remain explicitly unknown",()=>{
  const before=change(library,{kind:"unlink",clipId:"initial-0"}),after=trimTo(before,Math.floor((window().startSample+window().endSample)/3200),"initial-0",false),review=compile(before,after);
  expect(measured(review,"picture").after.coverage).toBe("partial");expect(measured(review,"mix").after.coverage).toBe("whole");
  expect(lane(review,"mix").occurrenceChanged).toBe(false);expect(lane(review,"picture").occurrenceChanged).toBe(true);
  const action=review.entries.find(value=>value.entry.kind==="action")!,sound=action.lanes.find(value=>value.lane==="mix")!;
  expect(sound.timing).toBe("unknown");expect(sound.windows).toEqual([]);expect(sound.reasons.join(" ")).toContain("cannot establish which words or actions");
  expect(action.lanes.find(value=>value.lane==="picture")!.timing).toBe("shot-coverage");expect(lane(review,"captions").lane).toBe("captions");
});

test("removing a complete measured interval on linked lanes records an omission without selecting words or script deletion",()=>{
  const delta=Math.ceil(window().endSample/1600),after=change(library,{kind:"trim",clipId:"initial-0",linked:true,edge:"in",delta,ripple:true}),review=compile(library,after),m=measured(review);
  expect(m.before.coverage).toBe("whole");expect(m.after.coverage).toBe("none");expect(m.after.occurrenceIds).toEqual([]);
  expect(lane(review).reasons.join(" ")).toContain("every other lane and repeated occurrence");
  expect(review.context.script).toEqual(script);expect(Object.hasOwn(review,"patch")).toBe(false);expect(Object.hasOwn(review,"replacement")).toBe(false);
});

test("removing one repeated clip preserves the other full occurrence and repeated equal spoken text remains source-position distinct",()=>{
  const frames=timeline(library).frames,extended=change(library,{kind:"duration",frames:frames*2}),ids=Object.fromEntries(timeline(library).clips.map(clip=>[clip.id,"copy-"+clip.id]));
  const repeated=change(extended,{kind:"duplicate",clipId:"initial-0",linked:true,at:frames,ids,link:"copy",ripple:false}),after=change(repeated,{kind:"delete",clipId:"initial-0",linked:true,ripple:true}),review=compile(repeated,after),m=measured(review);
  expect(m.before.clipIds).toHaveLength(2);expect(m.after.clipIds).toEqual(["copy-initial-1"]);expect(m.after.coverage).toBe("whole");
  expect(lane(review).repeatedBefore).toBe(true);expect(lane(review).repeatedAfter).toBe(false);expect(lane(review).reasons.join(" ")).toContain("Removing one occurrence");
  const same=review.entries.filter(value=>value.entry.kind==="dialogue"&&value.entry.text==="Welcome to the garden.");expect(same).toHaveLength(2);expect(same[0]!.entry.id).not.toBe(same[1]!.entry.id);expect(same[0]!.currentLineIds).not.toEqual(same[1]!.currentLineIds);
});

test("scene reorder derives real linked history output order while preserving each original scene window",()=>{
  const second=index.entries.find(entry=>entry.kind==="scene"&&entry.sceneIndex===1)!,at=second.windows[0]!.startSample/1600,ids=Object.fromEntries(timeline(library).clips.map(clip=>[clip.id,"right-"+clip.id]));
  expect(Number.isInteger(at)).toBe(true);
  const before=change(library,{kind:"split",clipId:"initial-0",linked:true,at,rightIds:ids,rightLink:"right"}),after=change(before,{kind:"reorder",clipId:"right-initial-0",at:0}),review=compile(before,after),order=review.sceneOrder.find(value=>value.lane==="picture")!;
  expect(order.before[0]!.entryId).not.toBe(second.id);expect(order.after[0]!.entryId).toBe(second.id);expect(order.after[0]!.startSample).toBe(0);
  expect(review.activeEdits.map(event=>event.operation)).toEqual([{kind:"reorder",clipId:"right-initial-0",at:0}]);
  expect(review.entries.find(value=>value.entry.id===second.id)!.lanes.find(value=>value.lane==="picture")!.windows.every(value=>value.before.coverage==="whole"&&value.after.coverage==="whole")).toBe(true);
});

test("splitting one measured line across adjacent clips is fragmented coverage rather than a repeated occurrence",()=>{
  const at=Math.floor((window().startSample+window().endSample)/3200),ids=Object.fromEntries(timeline(library).clips.map(clip=>[clip.id,"split-"+clip.id])),after=change(library,{kind:"split",clipId:"initial-0",linked:true,at,rightIds:ids,rightLink:"split"}),review=compile(library,after);
  expect(measured(review).after.clipIds).toHaveLength(2);expect(measured(review).after.coverage).toBe("whole");expect(lane(review).repeatedAfter).toBe(false);expect(lane(review).repeatedBefore).toBe(false);
});

test("active descendant path excludes abandoned edits, rejects undo-only and preexisting branch reactivation",()=>{
  const marker=change(library,{kind:"marker",marker:{id:"discarded",frame:0,label:"Abandoned"}}),back=cursor(marker,0),after=trimTo(back,Math.ceil(window().endSample/1600)),review=compile(library,after);
  expect(review.appendedEvents.map(event=>event.kind)).toEqual(["edit","cursor","edit"]);expect(review.activeEdits.map(event=>event.operation.kind)).toEqual(["trim"]);expect(review.activeEdits[0]!.sequence).toBe(3);
  expect(()=>compile(marker,back)).toThrow(/descendant|branch/);expect(()=>compile(library,back)).toThrow(/active descendant/);
  const selectedOld=cursor(back,1,"branch");expect(()=>compile(back,selectedOld)).toThrow(/older branch/);
  expect(()=>compile(marker,after)).toThrow(/descendant|branch/);
});

test("same screenplay bytes under a different version stay historical-unresolved and do not acquire current physical IDs",()=>{
  const after=trimTo(library,Math.ceil(window().endSample/1600)),other=createLivingScriptStructureBase({projectId:script.projectId,version:script.version+1,text:script.text,locks:[]}),review=compile(library,after,other);
  expect(review.entries.every(value=>!value.currentScriptMatch&&value.currentLineIds.length===0)).toBe(true);expect(review.warnings.join(" ")).toContain("Equal text cannot establish");
});

test("held original positions retain point coverage and muted audio duration across an actual trim",()=>{
  const at=Math.ceil(window().startSample/1600);expect(at*1600).toBeLessThan(window().endSample);
  const unlinked=change(library,{kind:"unlink",clipId:"initial-1"}),before=change(unlinked,{kind:"retime",clipId:"initial-1",linked:false,from:at,frames:30,points:[{frame:0,rate:0},{frame:30,rate:0}],ripple:false}),after=trimTo(before,20,"initial-1",false),review=compile(before,after),m=measured(review);
  expect(m.before.coverage).toBe("held-only");expect(m.after.coverage).toBe("held-only");expect(m.after.heldPositions).toEqual([at*1600]);expect(m.after.sourceSpans).toEqual([]);
  expect(m.before.mutedOutputSamples).toBe(30*1600);expect(m.after.mutedOutputSamples).toBe(20*1600);expect(lane(review).after.every(value=>value.held&&value.muted)).toBe(true);
});

test("ramped source endpoint preserves fractional Q16 phase checked against an independent speed integral",()=>{
  const unlinked=change(library,{kind:"unlink",clipId:"initial-1"}),from=Math.floor(window().startSample/1600),before=change(unlinked,{kind:"retime",clipId:"initial-1",linked:false,from,frames:30,points:[{frame:0,rate:501},{frame:30,rate:1498}],ripple:false}),after=trimTo(before,1,"initial-1",false),review=compile(before,after),m=measured(review);
  const sourceAt=(sample:number)=>Math.round((from*1600+.501*sample+(.997*sample*sample)/(2*30*1600))*65536)/65536;
  const expectedEnd=sourceAt(1600);expect(expectedEnd%1).not.toBe(0);expect(expectedEnd).toBeLessThan(window().endSample);expect(expectedEnd).toBeGreaterThan(window().startSample);
  expect(m.after.sourceSpans.at(-1)!.endSample).toBe(expectedEnd);expect(m.after.coverage).toBe("partial");
});

test("borrowed odd dissolve handles survive actual history replay and remain separately identified during trim review",()=>{
  const t=timeline(library),total=t.frames,mid=Math.floor(total/2),ids=Object.fromEntries(t.clips.map(clip=>[clip.id,"right-"+clip.id]));
  const split=change(library,{kind:"split",clipId:"initial-0",linked:true,at:mid,rightIds:ids,rightLink:"right"});
  const before=change(split,{kind:"crossfade",leftId:"initial-0",rightId:"right-initial-0",linked:true,frames:5,alignment:"center",ids:{"initial-0":"picture-fade","initial-1":"audio-fade"}}),after=change(before,{kind:"trim",clipId:"right-initial-0",linked:true,edge:"out",delta:-1,ripple:false}),review=compile(before,after);
  expect(review.entries.some(value=>value.lanes.some(lane=>lane.before.some(occurrence=>occurrence.transition)))).toBe(true);
  const navigation=projectEditScriptNavigation("reverse-cut",before.sequences[0]!.history.revision,timeline(before),[index]);
  const actual=review.entries.flatMap(value=>value.lanes.flatMap(lane=>lane.before)).sort((a,b)=>a.id.localeCompare(b.id)),expected=navigation.occurrences.slice().sort((a,b)=>a.id.localeCompare(b.id));
  expect(actual).toEqual(expected);expect(review.entries.some(value=>value.lanes.some(lane=>lane.reasons.join(" ").includes("borrowed transition")))).toBe(true);
});

test("stale or tampered saved history, navigation, source receipts and resealed evidence are rejected",()=>{
  const after=trimTo(library,Math.ceil(window().endSample/1600)),asked=input(library,after),review=compileLivingScriptReverseReview(asked);
  expect(()=>compileLivingScriptReverseReview({...asked,projectId:"foreign"})).toThrow();
  expect(()=>compileLivingScriptReverseReview({...asked,before:{...asked.before,historyRevision:asked.after.historyRevision}})).toThrow(/history/);
  expect(()=>compileLivingScriptReverseReview({...asked,after:{...asked.after,navigationRevision:asked.before.navigationRevision}})).toThrow(/navigation/);
  const changed=structuredClone(asked);changed.after.library.sequences[0]!.history.events[0]!.timelineRevision="a".repeat(64);expect(()=>compileLivingScriptReverseReview(changed)).toThrow();
  const receipt=structuredClone(asked);receipt.after.library.sources[0]!.job.scriptText+="\nChanged";expect(()=>compileLivingScriptReverseReview(receipt)).toThrow();
  for(const mutate of [(value:LivingScriptReverseReview)=>{value.activeEdits=[];},(value:LivingScriptReverseReview)=>{value.entries[0]!.currentScriptMatch=false;},(value:LivingScriptReverseReview)=>{measured(value).after.coverage="none";},(value:LivingScriptReverseReview)=>{value.sourceBindings[0]!.receiptRevision="a".repeat(64);},(value:LivingScriptReverseReview)=>{value.sceneOrder=[];}]){const forged=structuredClone(review);mutate(forged);expect(contentHash(forged)).not.toBe(contentHash(review));expect(()=>validateLivingScriptReverseReview(reseal(forged))).toThrow(/changed/);}
  let invoked=0;const accessor=Object.defineProperty({...asked},"after",{enumerable:true,get(){invoked++;return asked.after;}});expect(()=>compileLivingScriptReverseReview(accessor)).toThrow(/plain/);expect(invoked).toBe(0);
  const extra=Object.assign({},asked,{frames:999});expect(()=>compileLivingScriptReverseReview(extra)).toThrow(/complete/);
});

test("valid dense lane metadata rejects incrementally before accumulating an oversized entry-by-clip review",()=>{
  // Metadata-only adversary: sealed original records and ordinary history operations. No files
  // are rendered or presented as readable media; this compiler grants no byte-custody authority.
  const text="INT. GARDEN - DAY\n\n"+Array.from({length:1500},(_,i)=>"Action "+i+".").join("\n"),job=structuredClone(library.sources[0]!.job),digest="a".repeat(64),file=(path:string):RenderFile=>({path,bytes:100,sha256:digest});
  job.scriptText=text;job.casting=castingSnapshot(job.projectId,0,[],0);delete job.shotReuse;
  const shots=renderShots(job,Date.parse(job.startedAt!)),records=shots.map(shot=>renderRecord({projectId:job.projectId,jobId:job.id,shotId:shot.id,inputHash:renderInputHash(job,shot),origin:{jobId:job.id,shotId:shot.id},clip:{provider:"mock",model:"bounded-metadata",seed:shot.seed,durationSec:2,fingerprint:digest,audioMode:"silent-captioned"},files:{video:file(job.projectId+"/"+job.id+"/clips/"+shot.id+".mp4")}}));
  job.output={...job.output!,shotRenders:records};job.totalFrames=records.length*60;job.checkpointFrame=job.totalFrames;job.checkpointShots=records.length;
  const audio=editSourceAudio(job),facts:EditSource={id:job.id,label:"Capacity metadata",revision:editFactsRevision(job,job.totalFrames,320,180,[]),frames:job.totalFrames,width:320,height:180,audio:EDIT_AUDIO_LANES.filter(lane=>audio[lane]),captions:[],...editSourceVoiceWindows(job)},files=new Map(editSourceKnownFiles(job).map(value=>[value.path,value]));
  for(const path of editSourceRequiredPaths(job))if(!files.has(path))files.set(path,file(path));
  const receiptData={schema:"hv-edit-source/1" as const,job,facts,language:"en",audio,files:[...files.values()]},receipt=validateEditSourceReceipt({...receiptData,revision:contentHash(receiptData)}),retainedIndex=compileEditScriptSource(receipt);
  expect(retainedIndex.entries).toHaveLength(1501);
  const initial=createEditSequence(emptyEditLibrary(),job.projectId,[receipt],"reverse-cut","Capacity cut",facts.id,320,180,0),original=timeline(initial).clips.find(clip=>clip.lane==="mix")!,cleared=change(initial,{kind:"delete",clipId:"initial-0",linked:true,ripple:false});
  const clips=Array.from({length:256},(_,i)=>({...original,id:("clip-"+i+"-").padEnd(128,"x"),link:null,frames:2,envelope:{from:0,frames:2,fadeIn:0,fadeOut:0}})),before=change(cleared,{kind:"insert",clips}),after=trimTo(before,1,clips[0]!.id,false),current=createLivingScriptStructureBase({projectId:job.projectId,version:job.scriptVersion,text,locks:[]}),asked=input(before,after,current);
  // Both independent navigations are small (picture is absent and action has no speech timing),
  // yet merely duplicating full lane clip IDs per entry would exceed the complete response cap.
  expect(Buffer.byteLength(JSON.stringify(asked))).toBeLessThan(4*1024**2);
  const idBytes=Buffer.byteLength(JSON.stringify(clips.map(clip=>clip.id)));
  expect(retainedIndex.entries.length*idBytes*2).toBeGreaterThan(LIVING_SCRIPT_REVERSE_LIMITS.metadataBytes);
  const originalHash=contentHash(asked);expect(()=>compileLivingScriptReverseReview(asked)).toThrow("incremental output capacity");expect(contentHash(asked)).toBe(originalHash);
},60000);
