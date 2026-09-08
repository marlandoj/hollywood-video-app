import {beforeAll,afterAll,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {compileEditScriptSource} from "../src/edit-script-source";
import {compileLivingScriptPatch,type LivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact,type LivingScriptGenerationImpact} from "../src/living-script-generation";
import {compileLivingScriptSourceMap,validateLivingScriptSourceMap,type LivingScriptSourceMap} from "../src/living-script-source-map";
import {editFactsRevision,editSourceAudio,editSourceLanguage,editSourceKnownFiles,editSourceRequiredPaths,editSourceVoiceWindows,validateEditSourceReceipt,type EditSourceReceipt} from "../src/edit-sources";
import {EDIT_AUDIO_LANES,type EditCaption,type EditSource} from "../src/edit-timeline";
import {renderRecord,renderShots,renderInputHash,type ShotRenderRecord,type RenderFile} from "../src/shot-reuse";
import {castingSnapshot} from "../src/casting";
import type {Job} from "../../queue/src/index";

let fixture:Awaited<ReturnType<typeof dubStudio>>,before:EditSourceReceipt,after:EditSourceReceipt,patch:LivingScriptPatch,impact:LivingScriptGenerationImpact,map:LivingScriptSourceMap;
const hash="a".repeat(64),other="b".repeat(64);
beforeAll(async()=>{
  fixture=await dubStudio();before=await inspectEditSource(fixture.film,"Original cut",fixture.paths.artifactRoot,async()=>{});patch=makePatch(before,"Welcome back to the garden.");
  impact=compileLivingScriptGenerationImpact(before,patch,{...fixture.film,scriptVersion:patch.after.version,scriptText:patch.after.text});
  expect((await fixture.call(fixture.base+"/script","PUT",{text:patch.after.text},fixture.owner.token)).status).toBe(200);
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const completed=(await fixture.worker())!;expect(completed.failureReason??completed.cancelReason).toBeUndefined();expect(completed.status).toBe("done");
  after=await inspectEditSource(completed,"Rendered proposed screenplay",fixture.paths.artifactRoot,async()=>{});map=compileLivingScriptSourceMap(before,patch,impact,after);
},180000);
afterAll(async()=>{await fixture?.close();});
function makePatch(receipt:EditSourceReceipt,replacement="Come inside."):LivingScriptPatch{const index=compileEditScriptSource(receipt),entry=index.entries.find(entry=>entry.kind==="dialogue")!;return compileLivingScriptPatch(receipt,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:receipt.job.scriptVersion,text:receipt.job.scriptText},replacement});}
function reseal<T extends {revision:string}>(value:T):T {const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;}
function rerender(record:ShotRenderRecord):ShotRenderRecord{const {schema:_schema,revision:_revision,...data}=record;return renderRecord(data);}
function resealReuse(plan:NonNullable<Job["shotReuse"]>):NonNullable<Job["shotReuse"]>{const {schema:_schema,revision:_revision,...data}=plan;return {schema:"hv-shot-reuse/1",...data,revision:contentHash(data)};}
function receipt(job:Job,frames:number,captions:EditCaption[]=[],previous:RenderFile[]=[]):EditSourceReceipt{
  const audio=editSourceAudio(job),facts:EditSource={id:job.id,label:"Closed retained correspondence fixture",revision:editFactsRevision(job,frames,320,180,captions),width:320,height:180,frames,audio:EDIT_AUDIO_LANES.filter(lane=>audio[lane]),captions,...editSourceVoiceWindows(job)};
  const known=editSourceKnownFiles(job),paths=new Set([...known.map(file=>file.path),...editSourceRequiredPaths(job)]),files=new Map([...previous.filter(file=>paths.has(file.path)),...known].map(file=>[file.path,file]));
  for(const path of paths)if(!files.has(path))files.set(path,{path,bytes:100,sha256:hash});
  const data={schema:"hv-edit-source/1" as const,job,facts,audio,files:[...files.values()],language:editSourceLanguage(job)};return validateEditSourceReceipt({...data,revision:contentHash(data)});
}
const rebind=(source:EditSourceReceipt,job:Job,frames=source.facts.frames)=>receipt(job,frames,source.facts.captions,source.files);
/** Synthetic receipt clocks complement the actual-media fixture; no physical media claim is made here. */
function metadataFilm(text:string,durations:number[],stage:"animatic"|"final"="final",original?:EditSourceReceipt,proposal?:LivingScriptPatch,generation?:LivingScriptGenerationImpact):EditSourceReceipt{
  const job=structuredClone(original?.job??before.job);job.id=crypto.randomUUID();job.idempotencyKey=job.id;job.stage=stage;job.scriptText=proposal?.after.text??text;job.scriptVersion=proposal?.after.version??1;
  delete job.shotReuse;delete job.direction;delete job.casting;delete job.output;
  if(original){if(original.job.casting)job.casting=structuredClone(original.job.casting);if(original.job.direction)job.direction=structuredClone(original.job.direction);job.providerPlan=original.job.providerPlan;}else job.providerPlan=createProviderPlan(stage,5,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["legacy-mock"]',HV_PROVIDER_POOL:'["mock"]'});
  const declared=renderShots(job,Date.parse(job.startedAt!));if(declared.length!==durations.length)throw new Error("Synthetic fixture needs one actual duration per declared shot.");
  const records=declared.map((shot,ordinal)=>{
    const reused=generation?.reusableRecords.find(record=>record.shotId===shot.id);
    if(reused){const {schema:_schema,revision:_revision,...data}=structuredClone(reused);return renderRecord({...data,jobId:job.id,reusedFrom:{jobId:reused.jobId,shotId:reused.shotId,revision:reused.revision},files:Object.fromEntries(Object.entries(reused.files).map(([role,file])=>[role,{...file,path:file.path.replace("/"+reused.jobId+"/","/"+job.id+"/")}])) as ShotRenderRecord["files"]});}
    return renderRecord({projectId:job.projectId,jobId:job.id,shotId:shot.id,inputHash:renderInputHash(job,shot),origin:{jobId:job.id,shotId:shot.id},clip:{provider:"mock",model:"clock-metadata-fixture",seed:shot.seed,durationSec:durations[ordinal]!/30,fingerprint:hash,audioMode:"silent-captioned"},files:{video:{path:`${job.projectId}/${job.id}/clips/${shot.id}.mp4`,bytes:100,sha256:hash}}});
  });
  if(generation){const data={projectId:job.projectId,shots:generation.reusableRecords,forceShotIds:[]};job.shotReuse={schema:"hv-shot-reuse/1",...data,revision:contentHash(data)};}
  job.output={mp4Path:`${job.projectId}/${job.id}/export.mp4`,captionsPath:`${job.projectId}/${job.id}/captions.vtt`,manifestPath:`${job.projectId}/${job.id}/provenance.json`,hlsPlaylistPath:`${job.projectId}/${job.id}/hls/index.m3u8`,shotRenders:records};
  const overlap=stage==="final"&&records.length>1?15:0;return receipt(job,records.reduce((total,record)=>total+Math.round(record.clip.durationSec*30),0)-overlap*(records.length-1));
}

test("actual selective local render maps complete source clocks, reused bytes and changed speech/caption identities",()=>{
  expect(map.schema).toBe("hv-living-script-source-map/1");expect(map.patchRevision).toBe(patch.revision);expect(map.generationRevision).toBe(impact.revision);expect(map.before.receiptRevision).toBe(before.revision);expect(map.after.receiptRevision).toBe(after.revision);
  expect(map.before.assembly).toEqual({mode:"concat",overlapFrames:0,fps:30,sampleRate:48000});expect(map.before.overlaps).toEqual([]);expect(map.after.overlaps).toEqual([]);
  expect(map.shots.map(shot=>[shot.shotId,shot.mapping])).toEqual([["shot-1-1","unbound-rendered"],["shot-1-2","exact-shot-local"]]);
  for(const side of ["before","after"] as const){let cursor=0;for(const shot of map.shots){const span=shot[side]!;expect(span.startFrame).toBe(cursor);expect(span.startSample).toBe(cursor*1600);expect(span.endFrame-span.startFrame).toBe(Math.round(span.record.clip.durationSec*30));expect(span.endSample).toBe(span.endFrame*1600);expect(span.exclusiveRanges).toEqual([{startFrame:span.startFrame,endFrame:span.endFrame,startSample:span.startSample,endSample:span.endSample}]);cursor=span.endFrame;}expect(cursor).toBe(map[side].frames);}
  const reused=map.shots[1]!,oldFile=reused.before!.record.files.video,newFile=reused.after!.record.files.video;expect(oldFile.path).not.toBe(newFile.path);expect(readFileSync(join(fixture.paths.artifactRoot,oldFile.path))).toEqual(readFileSync(join(fixture.paths.artifactRoot,newFile.path)));expect(oldFile.sha256).toBe(newFile.sha256);
  const entry=map.entries.find(entry=>entry.patched)!;expect(entry.before.id).toBe(patch.mapping.oldEntryId);expect(entry.after.id).not.toBe(entry.before.id);expect(entry.after.startLine).toBe(entry.before.startLine);expect(entry.after.text).toBe(patch.replacement);expect(entry.performedTextChanged).toBe(true);expect(entry.measuredSpeechChanged).toBe(true);expect(entry.before.windows.some(window=>window.lanes.includes("captions"))).toBe(true);expect(entry.after.windows.some(window=>window.lanes.includes("captions"))).toBe(true);
  expect(map.captionIdentitiesChanged).toBe(true);expect(map.before.captions).toEqual(before.facts.captions);expect(map.after.captions).toEqual(after.facts.captions);expect(map.entries.filter(entry=>entry.patched)).toHaveLength(1);expect(map).toEqual(reseal(map));expect(fixture.ledger.monthSpend()).toBe(0);
});

test("same input hashes cannot conceal a changed candidate screenplay version or cast snapshot",()=>{
  const version=structuredClone(after.job);version.scriptVersion++;const wrongVersion=rebind(after,version);expect(wrongVersion.job.output!.shotRenders!.map(record=>record.inputHash)).toEqual(after.job.output!.shotRenders!.map(record=>record.inputHash));expect(()=>compileLivingScriptSourceMap(before,patch,impact,wrongVersion)).toThrow("candidate bindings");
  const cast=structuredClone(after.job);cast.casting=castingSnapshot(cast.projectId,cast.casting!.version+1,cast.casting!.characters,Date.parse(cast.startedAt!));expect(()=>compileLivingScriptSourceMap(before,patch,impact,rebind(after,cast))).toThrow("candidate bindings");
  const changed=reseal({...impact,generateShotIds:[]});expect(()=>compileLivingScriptSourceMap(before,patch,changed,after)).toThrow("generation impact");
});

test("a fresh-looking unchanged render and a consistently resealed altered reuse receipt are rejected",()=>{
  const fresh=structuredClone(after.job),unchanged=fresh.output!.shotRenders![1]!;delete unchanged.reusedFrom;unchanged.origin={jobId:fresh.id,shotId:unchanged.shotId};fresh.output!.shotRenders![1]=rerender(unchanged);fresh.shotReuse=resealReuse({...fresh.shotReuse!,shots:[]});
  const validFresh=rebind(after,fresh);expect(()=>compileLivingScriptSourceMap(before,patch,impact,validFresh)).toThrow("reviewed unchanged");
  const altered=structuredClone(after.job),selected=altered.shotReuse!.shots[0]!;selected.files.video.sha256=other;selected.clip.fingerprint=other;const selectedSeal=rerender(selected);altered.shotReuse=resealReuse({...altered.shotReuse!,shots:[selectedSeal]});
  const used=altered.output!.shotRenders![1]!;used.files.video.sha256=other;used.clip.fingerprint=other;used.reusedFrom!.revision=selectedSeal.revision;altered.output!.shotRenders![1]=rerender(used);
  const validAltered=rebind(after,altered);expect(()=>compileLivingScriptSourceMap(before,patch,impact,validAltered)).toThrow("exact reviewed clip");
  const alternate=structuredClone(after.job),foreignId=crypto.randomUUID(),foreign=structuredClone(alternate.output!.shotRenders![0]!);foreign.jobId=foreignId;foreign.origin.jobId=foreignId;for(const file of Object.values(foreign.files))file.path=file.path.replace("/"+alternate.id+"/","/"+foreignId+"/");const selectedForeign=rerender(foreign),freshFirst=alternate.output!.shotRenders![0]!;freshFirst.origin=selectedForeign.origin;freshFirst.reusedFrom={jobId:foreignId,shotId:foreign.shotId,revision:selectedForeign.revision};alternate.output!.shotRenders![0]=rerender(freshFirst);alternate.shotReuse=resealReuse({...alternate.shotReuse!,shots:[...alternate.shotReuse!.shots,selectedForeign]});
  expect(()=>compileLivingScriptSourceMap(before,patch,impact,rebind(after,alternate))).toThrow("reviewed unchanged");
});

test("complete actual shot order, source duration and integer frame durations are independently required",()=>{
  const partial=structuredClone(after.job);partial.output!.shotRenders=partial.output!.shotRenders!.slice(0,1);delete partial.shotReuse;expect(()=>compileLivingScriptSourceMap(before,patch,impact,rebind(after,partial))).toThrow("complete ordered");
  const reordered=structuredClone(after.job);reordered.output!.shotRenders!.reverse();expect(()=>compileLivingScriptSourceMap(before,patch,impact,rebind(after,reordered))).toThrow("complete ordered");
  expect(()=>compileLivingScriptSourceMap(before,patch,impact,rebind(after,structuredClone(after.job),after.facts.frames+1))).toThrow("measured retained film frames");
  const fractional=structuredClone(after.job);fractional.output!.shotRenders![0]!.clip.durationSec+=0.0001;fractional.output!.shotRenders![0]=rerender(fractional.output!.shotRenders![0]!);expect(()=>compileLivingScriptSourceMap(before,patch,impact,rebind(after,fractional))).toThrow("exact frame clock");
  const missing=structuredClone(after);missing.files=missing.files.slice(1);expect(()=>compileLivingScriptSourceMap(before,patch,impact,reseal(missing))).toThrow();
});

test("actual duration changes retain separate source endpoints and odd crossfade overlap evidence",()=>{
  const text="INT. ROOM - DAY\n\nA lamp glows.\n\nMARLA\nAgain.\n\nEXT. PATH - DAY\n\nLeaves turn.",old=metadataFilm(text,[60,60]),edit=makePatch(old),review=compileLivingScriptGenerationImpact(old,edit,{...old.job,scriptVersion:edit.after.version,scriptText:edit.after.text}),next=metadataFilm(edit.after.text,[90,60],"final",old,edit,review),result=compileLivingScriptSourceMap(old,edit,review,next);
  expect(result.before.frames).toBe(105);expect(result.after.frames).toBe(135);expect(result.durationDeltaFrames).toBe(30);expect(result.shots.map(shot=>shot.durationDeltaFrames)).toEqual([30,0]);
  expect(result.shots[0]!.mapping).toBe("unbound-rendered");expect(result.shots[1]!.mapping).toBe("exact-shot-local");expect(result.shots[1]!.before!.startSample).toBe(45*1600);expect(result.shots[1]!.after!.startSample).toBe(75*1600);
  expect(result.before.overlaps).toEqual([{startFrame:45,endFrame:60,startSample:72000,endSample:96000,shotIds:["shot-1-1","shot-2-1"]}]);expect(result.after.overlaps).toEqual([{startFrame:75,endFrame:90,startSample:120000,endSample:144000,shotIds:["shot-1-1","shot-2-1"]}]);
  expect(result.shots[0]!.before!.exclusiveRanges[0]!.endFrame).toBe(45);expect(result.shots[1]!.after!.exclusiveRanges[0]!.startFrame).toBe(90);expect(result.warnings.join(" ")).toContain("without interpolating");expect(result.warnings.join(" ")).toContain("durations changed");
  const dialogue=result.entries.find(entry=>entry.patched)!;expect(dialogue.before.windows.every(window=>window.evidence==="shot-coverage")).toBe(true);expect(dialogue.after.windows.every(window=>window.evidence==="shot-coverage")).toBe(true);
});

test("short overlapping shots explicitly preserve three contributors and an entirely ambiguous middle shot",()=>{
  const text="INT. ROOM - DAY\n\nMARLA\nAgain.\n\nEXT. PATH - DAY\n\nLeaves turn.\n\nINT. HALL - NIGHT\n\nThe door closes.",old=metadataFilm(text,[16,16,16]),edit=makePatch(old),review=compileLivingScriptGenerationImpact(old,edit,{...old.job,scriptVersion:edit.after.version,scriptText:edit.after.text}),next=metadataFilm(edit.after.text,[16,16,16],"final",old,edit,review),result=compileLivingScriptSourceMap(old,edit,review,next);
  expect(result.before.frames).toBe(18);expect(result.before.overlaps.map(overlap=>[overlap.startFrame,overlap.endFrame,overlap.shotIds.length])).toEqual([[1,2,2],[2,16,3],[16,17,2]]);expect(result.shots[1]!.before!.exclusiveRanges).toEqual([]);expect(result.shots[1]!.after!.exclusiveRanges).toEqual([]);
});

test("repeated original spoken text maps each new entry by physical identity instead of first text match",()=>{
  const text="INT. ROOM - DAY\n\nMARLA\nAgain.\n\nMARLA\nAgain.",old=metadataFilm(text,[60],"animatic"),edit=makePatch(old),review=compileLivingScriptGenerationImpact(old,edit,{...old.job,scriptVersion:edit.after.version,scriptText:edit.after.text}),next=metadataFilm(edit.after.text,[60],"animatic",old,edit,review),result=compileLivingScriptSourceMap(old,edit,review,next),spoken=result.entries.filter(entry=>entry.before.kind==="dialogue");
  expect(spoken.map(entry=>[entry.before.startLine,entry.after.startLine,entry.patched,entry.after.text])).toEqual([[4,4,true,"Come inside."],[7,7,false,"Again."]]);expect(spoken[0]!.before.id).not.toBe(spoken[1]!.before.id);expect(spoken[0]!.after.id).not.toBe(spoken[1]!.after.id);
});

test("source-map seals reject forged intervals, lost overlaps, omitted entries and altered source identities",()=>{
  const edits:((value:LivingScriptSourceMap)=>void)[]=[value=>{value.after.sourceRevision=other;},value=>{value.before.receiptRevision=other;},value=>{value.generationRevision=other;},value=>{value.shots.pop();},value=>{value.shots[0]!.after!.endSample++;},value=>{value.shots[0]!.mapping="exact-shot-local";},value=>{value.entries.pop();},value=>{value.entries[0]!.after.id=other;},value=>{value.after.captions=[];},value=>{value.captionIdentitiesChanged=false;},value=>{value.warnings=[];}];
  for(const edit of edits){const changed=structuredClone(map);edit(changed);expect(()=>validateLivingScriptSourceMap(before,patch,impact,after,reseal(changed))).toThrow();}
  const original=contentHash({before,patch,impact,after,map}),copy=validateLivingScriptSourceMap(before,patch,impact,after,map);copy.shots[0]!.after!.record.files.video.sha256=other;copy.entries[0]!.after.text="changed";expect(contentHash({before,patch,impact,after,map})).toBe(original);
});

test("source correspondence rejects non-JSON tricks before executing an accessor",()=>{
  let reads=0;const hidden=Object.defineProperty({...impact},"candidateInputs",{enumerable:true,get(){reads++;return impact.candidateInputs;}});expect(()=>compileLivingScriptSourceMap(before,patch,hidden,after)).toThrow();expect(reads).toBe(0);
  const sparse=structuredClone(map);sparse.shots.length+=1;expect(()=>validateLivingScriptSourceMap(before,patch,impact,after,sparse)).toThrow();
  expect(()=>validateLivingScriptSourceMap(before,patch,impact,after,{...map,extra:undefined} as LivingScriptSourceMap)).toThrow();
  expect(()=>validateLivingScriptSourceMap(before,patch,impact,after,{...map,warnings:["x".repeat(8*1024**2)]})).toThrow("metadata capacity");
});

test("a valid retained localized dialogue source requires explicit additional layer correspondence",async()=>{
  const quote=await fixture.quote(),response=await fixture.call(fixture.base+"/dialogue/"+fixture.film.id,"POST",fixture.requestBody(quote),fixture.owner.token);expect(response.status).toBe(202);
  const completed=(await fixture.worker())!;expect(completed.failureReason??completed.cancelReason).toBeUndefined();expect(completed.status).toBe("done");const derived=await inspectEditSource(completed,"Localized retained performance",fixture.paths.artifactRoot,async()=>{});expect(derived.language).toBe("es");
  expect(()=>compileLivingScriptSourceMap(derived,patch,impact,after)).toThrow("separate verified mapping");expect(()=>compileLivingScriptSourceMap(before,patch,impact,derived)).toThrow("separate verified mapping");expect(fixture.ledger.monthSpend()).toBe(0);
},120000);
