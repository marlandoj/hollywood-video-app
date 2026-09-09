import {afterAll,afterEach,beforeAll,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {contentHash as hash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {prepareCurrentFilmMixedSourceFixture} from "./current-film-mixed-source.fixture";
import {assertCurrentFilmMixedCaptionMismatch} from "./current-film-mixed-caption.assertions";
import type {CurrentFilmMixedJob} from "../src/current-film-mixed-job-context";
import {currentFilmMixedSourceClock,type CurrentFilmMixedSourceClock} from "../src/current-film-mixed-source-clock";
import {compileEditScriptSource,resolveEditCurrentFilmScriptSource,resolveEditCurrentFilmMixedScriptSource,type EditCurrentFilmScriptSource} from "../src/edit-script-source";
import {validateEditScriptSourceIndex,projectEditScriptNavigation} from "../src/edit-script-projection";
import {parseEditCaptions} from "../src/edit-captions";
import type {EditSourceReceipt} from "../src/edit-sources";
import {applyEditOperation,initialEditTimeline} from "../src/edit-timeline";
import {emptyEditLibrary,createEditSequence,admitEditSource,validateEditLibrary} from "../src/edit-library";
import {ProjectService} from "../../api/src/index";
import {EditApi} from "../../api/src/edit-api";
import {CapacityController} from "../../queue/src/index";

let fixture:Awaited<ReturnType<typeof prepareCurrentFilmMixedSourceFixture>>,job:CurrentFilmMixedJob,source:EditSourceReceipt;
let clock:CurrentFilmMixedSourceClock,resolved:EditCurrentFilmScriptSource,originalRevision:string;
let setupActive=false,phaseActive=false,failed=false,activeController:AbortController|undefined;
async function phase<T>(run:()=>Promise<T>):Promise<T>{
  if(failed||phaseActive)throw new Error("The preceding mixed navigation phase must settle first.");
  phaseActive=true;try{return await run();}catch(error){failed=true;throw error;}finally{phaseActive=false;}
}
function ready():void {if(failed||phaseActive||!resolved)throw new Error("Retain the completed actual /4 navigation fixture first.");}
beforeAll(async()=>{
  setupActive=true;try{fixture=await prepareCurrentFilmMixedSourceFixture();originalRevision=hash(fixture.f.job);}
  finally{setupActive=false;}
},600000);
afterEach(()=>{if(phaseActive){failed=true;activeController?.abort(new Error("Mixed navigation phase exceeded its unchanged deadline."));}});
afterAll(async()=>{
  if(setupActive||phaseActive||fixture?.active){
    console.error("Mixed navigation fixture still owns unfinished work; stopping the runner and preserving its files.");process.exit(1);
  }
  await fixture?.close();
});

test("actual mixed worker settles a moved native adoption and fresh output before source inspection",()=>phase(async()=>{
  job=await fixture.run();
  expect(job.status).toBe("done");expect(job.currentFilmProof).toBeDefined();
  expect(job.currentFilmCheckpoint!.rows.some(row=>row.kind==="reused")).toBe(true);
  expect(job.currentFilmCheckpoint!.rows.some(row=>row.kind==="generated")).toBe(true);
}),600000);

test("actual mixed delivery is inspected separately and its complete caption track is retained",()=>phase(async()=>{
  const controller=new AbortController();activeController=controller;
  try{
    source=await inspectEditSource(job,"Moved native performance and fresh picture",fixture.root,async()=>{controller.signal.throwIfAborted();},controller.signal);
    expect(source.schema).toBe("hv-edit-source/4");
    expect(source.facts.captions).toEqual(parseEditCaptions(readFileSync(join(fixture.root,job.output!.captionsPath),"utf8"),source.facts.frames));
    clock=currentFilmMixedSourceClock(job);resolved=resolveEditCurrentFilmMixedScriptSource(source);
  }finally{activeController=undefined;}
}),180000);

test("mixed navigation uses target physical scenes and duplicate lines without relabelling original execution",()=>{
  ready();const before=hash(source),index=resolved.index,document=job.currentFilm.target.state.context.plan.document;
  expect(index).toEqual(compileEditScriptSource(source));expect(validateEditScriptSourceIndex(index,source.facts)).toEqual(index);
  expect(index.scriptText).toBe(document.context.base.text);expect(index.scriptRevision).toBe(document.scriptRevision);expect(resolved.documentRevision).toBe(document.revision);
  expect(index.schema).toBe("hv-edit-script-source/1");expect(index.sourceId).toBe(job.id);
  const lines=index.entries.filter(entry=>entry.kind==="dialogue"&&entry.text==="Welcome home.");
  expect(lines.length).toBeGreaterThanOrEqual(2);expect(new Set(lines.map(line=>line.id)).size).toBe(lines.length);
  expect(new Set(lines.map(line=>resolved.entries.find(link=>link.entryId===line.id)!.lineIds[0])).size).toBe(lines.length);
  for(const scene of document.scenes){
    const link=resolved.entries.find(entry=>entry.kind==="scene"&&entry.sceneId===scene.id)!;
    expect(link.lineIds).toEqual([scene.headingLineId]);expect(index.entries.find(entry=>entry.id===link.entryId)).toMatchObject({sceneIndex:scene.sceneIndex,startLine:scene.startLine,text:scene.heading});
  }
  for(const link of resolved.entries.filter(entry=>entry.kind==="dialogue")){
    expect(link.lineIds).toHaveLength(1);
    const physical=document.lines.find(line=>line.id===link.lineIds[0])!,entry=index.entries.find(line=>line.id===link.entryId)!;
    expect(entry.startLine).toBe(physical.line);expect(entry.endLine).toBe(physical.line);expect(entry.text).toBe(physical.text.trim());
    expect(document.scenes.find(scene=>scene.id===link.sceneId)!.beats.some(beat=>beat.id===link.beatId)).toBe(true);
  }
  const moved=clock.spans.find(span=>span.execution.kind==="reused")!,original=fixture.f.job.currentFilmCheckpoint!.rows[fixture.sourceOrdinal]!;
  expect(moved.originalRecord).toEqual(original.record);expect(moved.originalCapture).toEqual(original.capture);
  expect(moved.originalRecord.jobId).not.toBe(job.id);expect(moved.target.ordinal).not.toBe(fixture.sourceOrdinal);
  expect(moved.correspondence!.lines.some(line=>line.source!.line!==line.target!.line)).toBe(true);
  expect(hash(source)).toBe(before);expect(hash(fixture.f.job)).toBe(originalRevision);
  const publicText=JSON.stringify(index);
  for(const privateMarker of ["hv-current-film-job/3","hv-shot-execution-capture/1","hv-current-film-prepared-proof/1","originalRecord","ownedFiles"])expect(publicText).not.toContain(privateMarker);
  expect(()=>resolveEditCurrentFilmScriptSource(source)).toThrow(/version-two/);
  expect(()=>resolveEditCurrentFilmMixedScriptSource(fixture.f.receipt)).toThrow(/version-four/);
},60000);

test("original native line samples bind exact target occurrences while captions remain a separate measured lane",()=>{
  ready();const index=resolved.index;
  let adopted=0,measured=0;
  for(const span of clock.spans){
    for(const line of span.spoken){
      measured++;if(span.execution.kind==="reused")adopted++;
      const link=resolved.entries.find(entry=>entry.kind==="dialogue"&&entry.lineIds[0]===line.lineId)!,entry=index.entries.find(entry=>entry.id===link.entryId)!;
      const speech=entry.windows.find(window=>window.shotId===span.target.renderId&&window.evidence==="measured-speech"&&!window.lanes.includes("captions"))!;
      expect([speech.startSample,speech.endSample]).toEqual([Math.round((span.startFrame*735+line.recordStartSample)*48000/22050),Math.round((span.startFrame*735+line.recordEndSample)*48000/22050)]);
      expect(speech.lanes).toEqual(["picture","mix","dialogue"]);expect(entry.performedText).toBe(line.performedText);
      expect(entry.windows).toContainEqual({startSample:span.startFrame*1600,endSample:span.endFrame*1600,lanes:["picture"],evidence:"shot-coverage",shotId:span.target.renderId});
      const captions=entry.windows.filter(window=>window.shotId===span.target.renderId&&window.lanes.includes("captions"));
      expect(captions.length).toBeGreaterThan(0);
      for(const cue of captions){expect(cue.lanes).toEqual(["captions"]);expect(source.facts.captions.some(actual=>actual.start===cue.startSample&&actual.end===cue.endSample)).toBe(true);}
    }
    // Picture coverage of an unspoken beat never becomes dialogue/caption timing.
    if(!span.spoken.length)for(const entry of index.entries)for(const window of entry.windows.filter(value=>value.shotId===span.target.renderId)){
      expect(window.evidence).toBe("shot-coverage");expect(window.lanes).toEqual(["picture"]);
    }
  }
  expect(measured).toBeGreaterThan(1);expect(adopted).toBeGreaterThan(1);
  expect(index.warnings).toEqual([]);
},60000);

test("the entire ordered caption track must match before any mixed caption identity is bound",()=>{
  ready();assertCurrentFilmMixedCaptionMismatch(source);
},60000);

test("retained mixed lines project through duplicate and trimmed picture occurrences without collapsing equal text",()=>{
  ready();const index=resolved.index;
  let timeline=initialEditTimeline([source.facts],source.facts.id,320,180);
  const picture=timeline.clips.find(clip=>clip.lane==="picture")!,at=timeline.frames;
  timeline=applyEditOperation(timeline,{kind:"duration",frames:at*2});
  timeline=applyEditOperation(timeline,{kind:"unlink",clipId:picture.id});
  timeline=applyEditOperation(timeline,{kind:"duplicate",clipId:picture.id,linked:false,at,ids:{[picture.id]:"second-mixed-picture"},link:null,ripple:false});
  timeline=applyEditOperation(timeline,{kind:"trim",clipId:"second-mixed-picture",linked:false,edge:"in",delta:1,ripple:false});
  const navigation=projectEditScriptNavigation("mixed-source-index-cut","a".repeat(64),timeline,[index]);
  const equal=index.entries.filter(entry=>entry.kind==="dialogue"&&entry.text==="Welcome home.");
  for(const line of equal){
    const occurrences=navigation.occurrences.filter(row=>row.entryId===line.id&&row.lane==="picture");
    expect(new Set(occurrences.map(row=>row.clipId))).toEqual(new Set([picture.id,"second-mixed-picture"]));
    for(const occurrence of occurrences.filter(row=>row.clipId==="second-mixed-picture"))expect(occurrence.startSample-occurrence.sourceStartSample).toBe(at*1600);
  }
  expect(new Set(navigation.occurrences.filter(row=>equal.some(entry=>entry.id===row.entryId)).map(row=>row.entryId)).size).toBe(equal.length);
},60000);

test("changed target/proof/clock identity refuses and returned physical links never mutate the source",()=>{
  ready();
  for(const mutate of [
    (value:EditSourceReceipt)=>{value.job.currentFilm!.materialization.documentRevision="f".repeat(64);},
    (value:EditSourceReceipt)=>{value.job.output!.currentFilm!.assembly.spans[0]!.startFrame++;},
    (value:EditSourceReceipt)=>{delete value.job.currentFilmProof;},
    (value:EditSourceReceipt)=>{value.schema="hv-edit-source/3";},
  ]){
    const changed=structuredClone(source);mutate(changed);expect(()=>compileEditScriptSource(changed)).toThrow();
  }
  const before=hash(source),copy=resolveEditCurrentFilmMixedScriptSource(source);copy.entries[0]!.lineIds[0]="f".repeat(64);copy.index.entries[0]!.text="changed returned navigation";
  expect(hash(source)).toBe(before);expect(resolveEditCurrentFilmMixedScriptSource(source)).toEqual(resolved);
},60000);

test("saved sequence libraries refuse mixed receipts on create, admission and reload while retaining version-three sources",()=>{
  ready();const projectId=job.projectId,empty=emptyEditLibrary(),emptyRevision=hash(empty),message="Mixed-film editing isn't available in saved sequences yet.";
  expect(fixture.f.receipt.schema).toBe("hv-edit-source/3");
  const library=createEditSequence(empty,projectId,[fixture.f.receipt],"supported-current-source","Retained current source",fixture.f.receipt.facts.id,320,180,0);
  expect(validateEditLibrary(library,projectId)).toEqual(library);
  const original=fixture.f.plan.library.origin!.request.source;
  const legacy=createEditSequence(empty,projectId,[original],"supported-original-source","Retained original source",original.facts.id,320,180,0);
  const admitted=admitEditSource(legacy,projectId,legacy.sequences[0]!.id,fixture.f.receipt,legacy.version,legacy.sequences[0]!.history.revision);
  expect(admitted.sources.some(receipt=>receipt.revision===fixture.f.receipt.revision)).toBe(true);
  const previous=hash(library);
  expect(()=>createEditSequence(empty,projectId,[source],"mixed-not-yet-saved","Mixed source",source.facts.id,320,180,0)).toThrow(message);
  expect(()=>admitEditSource(library,projectId,library.sequences[0]!.id,source,library.version,library.sequences[0]!.history.revision)).toThrow(message);
  expect(hash(empty)).toBe(emptyRevision);expect(hash(library)).toBe(previous);
  const loaded=structuredClone(library);loaded.sources.push(structuredClone(source));loaded.version++;
  const {revision:_revision,...body}=loaded;loaded.revision=hash(body);
  expect(()=>validateEditLibrary(JSON.parse(JSON.stringify(loaded)),projectId)).toThrow(message);
  const state=fixture.context.projects.snapshot(),stateRevision=hash(state);
  const imported=structuredClone(state);imported.projects.find(project=>project.id===projectId)!.editLibrary=loaded;
  expect(()=>ProjectService.fromState(imported)).toThrow(message);
  expect(hash(state)).toBe(stateRevision);expect(hash(library)).toBe(previous);
},60000);

test("public source choices exclude mixed films and direct requests refuse before inspection",async()=>{
  ready();const projects=fixture.context.projects,token=fixture.f.studio.owner.token,project=projects.authorize(token)!;
  const api=new EditApi({root:fixture.root,projects,ledger:fixture.context.ledger,monthlyBudgetUsd:5000,capacity:new CapacityController(),store:()=>fixture.store,view:async()=>({})});
  let refreshes=0;const refresh=async()=>{refreshes++;return projects.authorize(token);};
  try{
    const index=await api.handle([],new Request("http://fixture/editorial"),project,token,refresh);
    if(index instanceof Response)throw new Error("Expected the editorial source index.");
    expect(index.status).toBe(200);
    const choices=(index.body as {sources:{jobId:string}[]}).sources.map(value=>value.jobId);
    expect(choices).toContain(fixture.f.job.id);expect(choices).not.toContain(job.id);
    await expect(api.handle(["sources",job.id],new Request("http://fixture/editorial/sources/"+job.id),project,token,refresh)).rejects.toThrow("Mixed-film editing isn't available in saved sequences yet.");
    expect(refreshes).toBe(0);
  }finally{await api.close();}
},60000);
