import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {dubStudio,DUB_SCRIPT} from "../../../test/fixtures/dub-studio";
import {compileEditScriptSource} from "../src/edit-script-source";
import {createLivingScriptStructureBase,livingScriptStructureLines,livingScriptStructureBlock as block,livingScriptStructureBoundary as boundary,compileLivingScriptStructure,type LivingScriptStructureBase,type LivingScriptStructureOperation,type LivingScriptStructurePatch} from "../src/living-script-structure";
import {compileLivingScriptDocument,validateLivingScriptDocument,bootstrapLivingScriptDocument,validateLivingScriptDocumentSource,LIVING_SCRIPT_DOCUMENT_LIMITS,type LivingScriptDocumentContext} from "../src/living-script-document";

const make=(text:string,version=1)=>createLivingScriptStructureBase({projectId:"document-project",version,text,locks:[]});
const rebase=(base:LivingScriptStructureBase,changes:Partial<Pick<LivingScriptStructureBase,"version"|"projectId"|"locks">>)=>createLivingScriptStructureBase({projectId:base.projectId,version:base.version,text:base.text,locks:base.locks,...changes});
const patch=(base:LivingScriptStructureBase,operations:LivingScriptStructureOperation[])=>compileLivingScriptStructure(base,{baseRevision:base.revision,operations});
const compile=(base:LivingScriptStructureBase,ancestry:LivingScriptStructurePatch[]=[])=>compileLivingScriptDocument({base,ancestry});
const count=(base:LivingScriptStructureBase)=>livingScriptStructureLines(base).length;
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};
const TEXT="Title: Café 🌿\r\n\r\nINT. SAME - DAY\r\n[[Retain this note.]]\r\nALICE\r\nAgain.\r\n\r\nINT. SAME - DAY\r\n/*\r\nINT. FALSE - NIGHT\r\n*/\r\nALICE\r\nAgain.\r\n";

test("physical document preserves all CRLF/Unicode/protected bytes and distinguishes equal scene and dialogue occurrences",()=>{
  const base=make(TEXT,41),before=contentHash(base),document=compile(base);
  expect(document.lines.map(line=>line.text).join("")).toBe(TEXT);expect(document.lines).toHaveLength(13);
  expect(document.scenes.map(scene=>scene.sceneIndex)).toEqual([0,1]);expect(document.scenes.map(scene=>scene.heading)).toEqual(["INT. SAME - DAY","INT. SAME - DAY"]);
  expect(document.scenes[0]!.id).not.toBe(document.scenes[1]!.id);expect(document.lines[5]!.id).not.toBe(document.lines[12]!.id);
  expect(document.scenes.map(scene=>scene.beats.length)).toEqual([1,1]);expect(document.scenes[1]!.startLine).toBe(8);expect(document.complete).toBe(true);
  expect(document.unbound).toEqual([]);expect(document.relations).toEqual([]);expect(contentHash(base)).toBe(before);
  expect(validateLivingScriptDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
});

test("whole equal-heading scene move separates stable identity from current parser order and physical addresses",()=>{
  const base=make(TEXT),before=compile(base),move=patch(base,[{id:"move-first",kind:"move",block:block(base,3,8),to:boundary(base,count(base)+1)}]),after=compile(move.after,[move]);
  expect(after.scenes.map(scene=>scene.id)).toEqual([before.scenes[1]!.id,before.scenes[0]!.id]);expect(after.scenes.map(scene=>scene.sceneIndex)).toEqual([0,1]);
  expect(after.scenes.map(scene=>scene.beats[0]!.id)).toEqual([before.scenes[1]!.beats[0]!.id,before.scenes[0]!.beats[0]!.id]);
  expect(after.scenes[0]!.beats[0]!.parserBeatId).toBe("beat-1-1");expect(after.lines.find(line=>line.id===before.lines[5]!.id)!.line).toBe(12);
  expect(after.lines.find(line=>line.id===before.lines[5]!.id)!.physicalLineId).not.toBe(before.lines[5]!.physicalLineId);
  expect(after.relations.filter(relation=>relation.kind==="scene").every(relation=>relation.treatment==="moved")).toBe(true);
  expect(after.lines.map(line=>line.text).join("")).toBe(move.after.text);expect(after.rootScriptRevision).toBe(base.scriptRevision);
});

test("new dialogue in an existing physical beat preserves the cue-anchored identity but reports changed membership",()=>{
  const base=make("INT. ROOM - DAY\n\nALICE\nFirst.\n"),before=compile(base),insert=patch(base,[{id:"add-dialogue",kind:"insert",at:boundary(base,5),text:"Second.\n"}]),after=compile(insert.after,[insert]);
  expect(after.scenes[0]!.id).toBe(before.scenes[0]!.id);expect(after.scenes[0]!.beats[0]!.id).toBe(before.scenes[0]!.beats[0]!.id);
  expect(after.scenes[0]!.beats[0]!.lineIds).toHaveLength(3);expect(after.lines[4]!.origin.patchRevision).toBe(insert.revision);
  expect(after.relations.filter(relation=>relation.kind==="beat").map(relation=>relation.treatment)).toEqual(["changed"]);
  expect(after.lines[3]!.id).toBe(before.lines[3]!.id);expect(after.lines[3]!.physicalLineId).not.toBe(before.lines[3]!.physicalLineId);
});

test("equal-text replacement introduces a different physical identity and never restores replaced ancestry",()=>{
  const base=make("INT. ROOM - DAY\n\nALICE\nAgain.\n"),before=compile(base),replace=patch(base,[{id:"replace-equal",kind:"replace",block:block(base,4,5),text:"Again.\n"}]),after=compile(replace.after,[replace]);
  expect(after.context.base.text).toBe(base.text);expect(after.lines[3]!.id).not.toBe(before.lines[3]!.id);expect(after.removedLines).toEqual([{id:before.lines[3]!.id,patchRevision:replace.revision,treatment:"replaced"}]);
  expect(after.relations.some(relation=>relation.kind==="beat"&&relation.treatment==="changed")).toBe(true);
  const heading=patch(base,[{id:"same-heading",kind:"replace",block:block(base,1,2),text:"INT. ROOM - DAY\n"}]),reheaded=compile(heading.after,[heading]);
  expect(reheaded.scenes[0]!.id).not.toBe(before.scenes[0]!.id);expect(reheaded.relations.filter(relation=>relation.kind==="scene").map(relation=>relation.treatment)).toEqual(["replaced","introduced"]);
});

test("scene insertion and deletion retain original identities only for surviving physical scenes",()=>{
  const base=make("INT. A - DAY\nOne waits.\n\nEXT. B - NIGHT\nTwo waits.\n"),old=compile(base),insert=patch(base,[{id:"new-scene",kind:"insert",at:boundary(base,4),text:"INT. NEW - DAY\nNew waits.\n\n"}]),middle=compile(insert.after,[insert]);
  expect(middle.scenes.map(scene=>scene.sceneIndex)).toEqual([0,1,2]);expect(middle.scenes[0]!.id).toBe(old.scenes[0]!.id);expect(middle.scenes[2]!.id).toBe(old.scenes[1]!.id);
  expect(old.scenes.some(scene=>scene.id===middle.scenes[1]!.id)).toBe(false);
  const remove=patch(insert.after,[{id:"delete-a",kind:"delete",block:block(insert.after,1,4)}]),after=compile(remove.after,[insert,remove]);
  expect(after.scenes.map(scene=>scene.id)).toEqual([middle.scenes[1]!.id,old.scenes[1]!.id]);expect(after.relations.some(relation=>relation.kind==="scene"&&relation.beforeIds[0]===old.scenes[0]!.id&&relation.treatment==="deleted")).toBe(true);
  expect(after.lines.some(line=>line.id===old.lines[0]!.id)).toBe(false);expect(validateLivingScriptDocument(after)).toEqual(after);
});

test("dialogue split and merge preserve physical lines but create explicit non-inherited beat identities",()=>{
  const base=make("INT. ROOM - DAY\n\nALICE\nFirst.\nSecond.\n"),before=compile(base),split=patch(base,[{id:"split-dialogue",kind:"insert",at:boundary(base,5),text:"CUT TO:\n"}]),middle=compile(split.after,[split]),relation=middle.relations.find(value=>value.kind==="beat"&&value.treatment==="split")!;
  expect(relation.beforeIds).toEqual([before.scenes[0]!.beats[0]!.id]);expect(relation.afterIds).toHaveLength(2);expect(relation.afterIds).not.toContain(relation.beforeIds[0]!);
  expect(middle.scenes[0]!.beats.map(beat=>beat.kind)).toEqual(["dialogue","transition","dialogue"]);
  expect(middle.lines[5]!.id).toBe(before.lines[4]!.id);
  const merge=patch(split.after,[{id:"merge-dialogue",kind:"delete",block:block(split.after,5,6)}]),after=compile(merge.after,[split,merge]),merged=after.relations.find(value=>value.patchRevision===merge.revision&&value.treatment==="merged")!;
  expect(after.context.base.text).toBe(base.text);expect(merged.beforeIds).toEqual(relation.afterIds);expect(merged.afterIds).toEqual([after.scenes[0]!.beats[0]!.id]);
  expect(after.scenes[0]!.beats[0]!.id).not.toBe(before.scenes[0]!.beats[0]!.id);expect(after.lines[4]!.id).toBe(before.lines[4]!.id);
});

test("removing a character cue reports a role change instead of assigning the old spoken beat to action",()=>{
  const base=make("INT. ROOM - DAY\n\nALICE\nFirst.\n"),before=compile(base),remove=patch(base,[{id:"remove-cue",kind:"delete",block:block(base,3,4)}]),after=compile(remove.after,[remove]);
  expect(after.scenes[0]!.beats[0]!.kind).toBe("action");expect(after.scenes[0]!.beats[0]!.id).not.toBe(before.scenes[0]!.beats[0]!.id);
  expect(after.relations.find(relation=>relation.kind==="beat")!.treatment).toBe("role-changed");expect(after.lines[2]!.id).toBe(before.lines[3]!.id);
});

test("unsupported constructs and multiline notes retain bytes with explicit unbound evidence instead of invented scenes",()=>{
  const text="Unknown preamble\n[[\nINT. FAKE - NIGHT\nNot a scene.\n]]\nINT. REAL - DAY\nA waits.\n",document=compile(make(text));
  expect(document.lines.map(line=>line.text).join("")).toBe(text);expect(document.complete).toBe(false);expect(document.scenes.map(scene=>scene.heading)).toEqual(["INT. REAL - DAY"]);
  expect(document.scenes[0]!.sceneIndex).toBe(1);expect(document.unbound.some(value=>value.reason.includes("Multiline note"))).toBe(true);expect(document.unbound.flatMap(value=>value.lineIds)).toContain(document.lines[0]!.id);
});

test("contiguous ancestry binds exact versions, locks and every patch; resealed identities and accessors are rejected",()=>{
  const base=make("INT. ROOM - DAY\nA waits.\n"),one=patch(base,[{id:"first",kind:"insert",at:boundary(base,3),text:"B waits.\n"}]),two=patch(one.after,[{id:"second",kind:"insert",at:boundary(one.after,4),text:"C waits.\n"}]);
  expect(()=>compile(two.after,[two,one])).toThrow(/ancestry/);expect(()=>compile(two.after,[one])).toThrow(/exact current/);
  expect(()=>compile(rebase(two.after,{version:two.after.version+1}),[one,two])).toThrow(/exact current/);
  const locked=rebase(two.after,{locks:[{startLine:2,endLine:3}]});expect(()=>compile(locked,[one,two])).toThrow(/exact current/);
  const bad=structuredClone(one);bad.correspondence[0]!.afterLine=2;expect(()=>compile(one.after,[reseal(bad)])).toThrow(/correspondence|restoration/);
  const document=compile(two.after,[one,two]),tampered=structuredClone(document);tampered.scenes[0]!.id="a".repeat(64);expect(()=>validateLivingScriptDocument(reseal(tampered))).toThrow(/identities or ancestry/);
  let calls=0;const getter={ancestry:[],get base(){calls++;return base;}};expect(()=>compileLivingScriptDocument(getter)).toThrow(/accessors/);expect(calls).toBe(0);
  expect(()=>compileLivingScriptDocument({base,ancestry:[],ignored:true} as LivingScriptDocumentContext)).toThrow(/exact/);
  expect(()=>compileLivingScriptDocument({base,ancestry:Array(LIVING_SCRIPT_DOCUMENT_LIMITS.ancestry+1).fill(null)})).toThrow(/32 contiguous/);
});

test("dense many-to-one parser relations remain bounded and preserve the exact complete parent inventory",()=>{
  const base=make("INT. ROOM - DAY\n\n"+Array.from({length:1200},(_,index)=>"Action "+index+".\n").join("")),before=compile(base),merge=patch(base,[{id:"one-dialogue",kind:"insert",at:boundary(base,3),text:"ALICE\n"}]),fingerprint=contentHash({base,merge}),after=compile(merge.after,[merge]),relation=after.relations.find(value=>value.kind==="beat"&&value.treatment==="merged")!;
  expect(before.scenes[0]!.beats).toHaveLength(1200);expect(relation.beforeIds).toEqual(before.scenes[0]!.beats.map(beat=>beat.id));expect(relation.afterIds).toHaveLength(1);
  expect(after.scenes[0]!.beats[0]!.lineIds).toHaveLength(1201);expect(contentHash({base,merge})).toBe(fingerprint);
});

test("real retained film bootstrap binds exact original entries through reorder and rejects replaced or foreign-version roots",async()=>{
  const fixture=await dubStudio(undefined,DUB_SCRIPT+"\n\nEXT. GARDEN - NIGHT\n\nSpud leaves.\n\nSPUD\nWelcome to the garden.\n");
  try{
    const source=await inspectEditSource(fixture.film,"Legacy film",fixture.paths.artifactRoot,async()=>{}),index=compileEditScriptSource(source),base=createLivingScriptStructureBase({projectId:fixture.owner.projectId,version:source.job.scriptVersion,text:source.job.scriptText,locks:[]}),second=index.entries.find(entry=>entry.kind==="scene"&&entry.sceneIndex===1)!.startLine!,first=index.entries.find(entry=>entry.kind==="scene"&&entry.sceneIndex===0)!.startLine!;
    const move=patch(base,[{id:"reverse-order",kind:"move",block:block(base,second,count(base)+1),to:boundary(base,first)}]),context={base:move.after,ancestry:[move]},originalHash=contentHash(source),bound=bootstrapLivingScriptDocument(source,context);
    expect(bound.source.indexRevision).toBe(index.revision);expect(bound.entries.every(entry=>["retained","moved"].includes(entry.status))).toBe(true);expect(bound.entries.some(entry=>entry.status==="moved")).toBe(true);
    const same=index.entries.filter(entry=>entry.kind==="dialogue"&&entry.text==="Welcome to the garden."),mapped=same.map(entry=>bound.entries.find(value=>value.entryId===entry.id)!);
    expect(mapped).toHaveLength(2);expect(mapped[0]!.originalLineIds).not.toEqual(mapped[1]!.originalLineIds);expect(mapped[0]!.currentLineIds).not.toEqual(mapped[1]!.currentLineIds);
    expect(validateLivingScriptDocumentSource(source,JSON.parse(JSON.stringify(bound)))).toEqual(bound);expect(contentHash(source)).toBe(originalHash);
    const replace=patch(base,[{id:"same-spoken-words",kind:"replace",block:block(base,same[0]!.startLine!,same[0]!.startLine!+1),text:livingScriptStructureLines(base)[same[0]!.startLine!-1]!.text}]),replaced=bootstrapLivingScriptDocument(source,{base:replace.after,ancestry:[replace]});
    expect(replaced.entries.find(entry=>entry.entryId===same[0]!.id)).toMatchObject({status:"replaced",currentLineIds:[]});
    const later=rebase(base,{version:base.version+1});expect(()=>bootstrapLivingScriptDocument(source,{base:later,ancestry:[]})).toThrow(/exact document ancestry root/);
    const foreign=rebase(base,{projectId:"foreign-project"});expect(()=>bootstrapLivingScriptDocument(source,{base:foreign,ancestry:[]})).toThrow(/exact document ancestry root/);
    const tampered=structuredClone(bound);tampered.source.indexRevision="b".repeat(64);expect(()=>validateLivingScriptDocumentSource(source,reseal(tampered))).toThrow(/binding changed/);
    const wrong=structuredClone(source);wrong.job.scriptText+="\nTampered.";expect(()=>bootstrapLivingScriptDocument(wrong,{base,ancestry:[]})).toThrow();
  }finally{await fixture.close();}
},180000);
