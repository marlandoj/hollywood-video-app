import {beforeAll,afterAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {compileLivingScriptPatch,type LivingScriptPatch} from "../src/living-script-patch";
import type {LivingScriptRenderInputs} from "../src/living-script-generation";
import {compileLivingScriptCutImpact} from "../src/living-script-cut-impact";
import {createEditSequence,emptyEditLibrary,changeEditSequence,type EditLibrary} from "../src/edit-library";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import type {EditOperation} from "../src/edit-timeline";
let fixture:Awaited<ReturnType<typeof dubStudio>>,library:EditLibrary,patch:LivingScriptPatch,candidate:LivingScriptRenderInputs;
beforeAll(async()=>{
  fixture=await dubStudio();const source=await inspectEditSource(fixture.film,"Source film",fixture.paths.artifactRoot,async()=>{});
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const second=await fixture.worker();if(second?.status!=="done")throw new Error("Second retained source failed.");
  const other=await inspectEditSource(second,"Independent retained film",fixture.paths.artifactRoot,async()=>{});
  library=createEditSequence(emptyEditLibrary(),fixture.owner.projectId,[source,other],"cut","Saved cut",source.facts.id,320,180,0);
  const index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:fixture.film.scriptVersion,text:fixture.film.scriptText},replacement:"Welcome back to the garden."});
  candidate={...fixture.film,scriptVersion:patch.after.version,scriptText:patch.after.text};
},180000);
afterAll(async()=>{await fixture?.close();});
function context(value:EditLibrary){const parent=deriveEditAssemblyParent(fixture.owner.projectId,value,"cut"),indexes=parent.sourceReceipts.map(binding=>compileEditScriptSource(value.sources.find(source=>source.revision===binding.receiptRevision)!));return {parent,navigation:projectEditScriptNavigation("cut",parent.historyRevision,parent.timeline,indexes)};}
function compile(value=library){const {parent,navigation}=context(value);return compileLivingScriptCutImpact(fixture.owner.projectId,value,"cut",parent.historyRevision,patch,candidate,navigation.revision);}
function change(value:EditLibrary,operation:EditOperation){return changeEditSequence(value,fixture.owner.projectId,"cut",{kind:"edit",operation,label:"Test saved edit"},value.version,value.sequences[0]!.history.revision);}

test("cut impact freezes the full parent and binds every selected source lane without mutating history",()=>{
  const before=contentHash(library),result=compile();expect(result.parent).toEqual(context(library).parent);expect(result.editorialLibraryRevision).toBe(library.revision);
  expect(result.clips.map(item=>item.clip.id)).toEqual(["initial-0","initial-1","initial-2"]);expect(result.relatedSourceIds).toEqual([patch.sourceId]);
  expect(result.selectedLineOccurrences.length).toBeGreaterThan(0);expect(result.selectedLineOccurrences.every(value=>value.entryId===patch.mapping.oldEntryId&&value.sourceId===patch.sourceId)).toBe(true);
  expect(result.clips.find(item=>item.clip.lane==="captions")!.reviewReasons.join(" ")).toContain("actual replacement source");
  expect(contentHash(library)).toBe(before);result.parent.timeline.clips[0]!.from++;expect(contentHash(library)).toBe(before);
});

test("repeated ranges retain distinct exact occurrences and every source clock needs mapping",()=>{
  const frames=context(library).parent.timeline.frames,extended=change(library,{kind:"duration",frames:frames*2}),repeated=change(extended,{kind:"duplicate",clipId:"initial-0",linked:true,at:frames,ids:{"initial-0":"copy-picture","initial-1":"copy-mix","initial-2":"copy-captions"},link:"copy-link",ripple:false}),result=compile(repeated);
  expect(result.clips).toHaveLength(6);expect(result.selectedLineOccurrences.some(value=>value.clipId==="copy-picture"&&value.startFrame>=frames)).toBe(true);
  expect(result.clips.every(item=>item.reviewReasons.some(reason=>reason.includes("complete retained source range")))).toBe(true);
  expect(new Set(result.selectedLineOccurrences.map(value=>value.id)).size).toBe(result.selectedLineOccurrences.length);
});

test("a scene entry's unchanged second-shot coverage is not reported as a changed-shot occurrence",()=>{
  const result=compile(),source=library.sources.find(source=>source.revision===patch.receiptRevision)!,index=compileEditScriptSource(source),scene=index.entries.find(entry=>entry.kind==="scene")!;
  const all=context(library).navigation.occurrences.filter(value=>value.sourceId===patch.sourceId&&value.entryId===scene.id),changed=result.changedShotOccurrences.filter(value=>value.sourceId===patch.sourceId&&value.entryId===scene.id);
  expect(all).toHaveLength(2);expect(changed).toHaveLength(1);
  expect(changed[0]!.sourceEndSample).toBe(Math.round(fixture.film.output!.shotRenders![0]!.clip.durationSec*48000));
  expect(result.clips).toHaveLength(3);
});

test("matte dependency closure includes unrelated originals and follows two layers",()=>{
  const parent=context(library).parent,base=parent.timeline.clips[0]!,other=parent.timeline.sources.find(source=>source.id!==patch.sourceId)!;
  const value=change(library,{kind:"insert",clips:[{...structuredClone(base),id:"matte-dependent-one",sourceId:other.id,link:null,layer:1,composite:{schema:"hv-edit-composite/1",matte:{layer:0,channel:"luma",invert:false}}},{...structuredClone(base),id:"matte-dependent-two",sourceId:other.id,link:null,layer:2,composite:{schema:"hv-edit-composite/1",matte:{layer:1,channel:"alpha",invert:false}}}]});
  const result=compile(change(value,{kind:"matte-only",layers:[0,1]}));
  expect(result.clips.filter(item=>item.sourceTreatment==="matte-dependent").map(item=>item.clip.id)).toEqual(["matte-dependent-one","matte-dependent-two"]);
  expect(result.relatedSourceIds).not.toContain(other.id);expect(result.parent.timeline.matteOnlyLayers).toEqual([0,1]);
  expect(result.clips.find(item=>item.clip.id==="matte-dependent-two")!.reviewReasons.join(" ")).toContain("matte input");
});

test("saved history and navigation changes invalidate the original review context",()=>{
  const {parent,navigation}=context(library),changed=change(library,{kind:"marker",marker:{id:"new-marker",frame:1,label:"Changed parent"}});
  expect(()=>compileLivingScriptCutImpact(fixture.owner.projectId,changed,"cut",parent.historyRevision,patch,candidate,navigation.revision)).toThrow("history changed");
  const current=context(changed);expect(()=>compileLivingScriptCutImpact(fixture.owner.projectId,changed,"cut",current.parent.historyRevision,patch,candidate,navigation.revision)).toThrow("navigation changed");
  expect(()=>compileLivingScriptCutImpact("other-project",library,"cut",parent.historyRevision,patch,candidate,navigation.revision)).toThrow();
});

test("a matte clip outside every changed source span does not become a replacement dependency",()=>{
  const parent=context(library).parent,base=parent.timeline.clips[0]!,other=parent.timeline.sources.find(source=>source.id!==patch.sourceId)!;
  const extended=change(library,{kind:"duration",frames:parent.timeline.frames*2}),later=change(extended,{kind:"insert",clips:[{...structuredClone(base),id:"later-matte",sourceId:other.id,link:null,layer:1,at:parent.timeline.frames,composite:{schema:"hv-edit-composite/1",matte:{layer:0,channel:"luma",invert:false}}}]});
  expect(compile(later).clips.some(item=>item.clip.id==="later-matte")).toBe(false);
});

test("matte chains propagate only the intersected changed interval",()=>{
  const parent=context(library).parent,base=parent.timeline.clips[0]!,other=parent.timeline.sources.find(source=>source.id!==patch.sourceId)!;
  const unlinked=change(library,{kind:"unlink",clipId:base.id}),short=change(unlinked,{kind:"trim",clipId:base.id,linked:false,edge:"out",delta:10-base.frames,ripple:false});
  const value=change(short,{kind:"insert",clips:[{...structuredClone(base),id:"partial-matte",sourceId:other.id,link:null,layer:1,frames:20,composite:{schema:"hv-edit-composite/1",matte:{layer:0,channel:"luma",invert:false}}},{...structuredClone(base),id:"disjoint-dependent",sourceId:other.id,link:null,layer:2,at:10,frames:10,composite:{schema:"hv-edit-composite/1",matte:{layer:1,channel:"luma",invert:false}}}]});
  const result=compile(value);expect(result.clips.find(item=>item.clip.id==="partial-matte")!.affectedOutputRanges).toEqual([{startFrame:0,endFrame:10}]);
  expect(result.clips.some(item=>item.clip.id==="disjoint-dependent")).toBe(false);
});
