import {beforeAll,afterAll,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource,prepareEditSources} from "../../generator/src/edit-source-media";
import {editVtt,conformEdit,editFrameHashes} from "../../generator/src/edit-conform";
import {soundDigest} from "../../generator/src/sound-media";
import {soundProcessingCommand} from "../../generator/src/sound-finishing";
import {contentHash} from "../../generator/src/capabilities";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import {emptyEditLibrary,createEditSequence,changeEditSequence,type EditLibrary} from "../src/edit-library";
import {editHistoryReplay} from "../src/edit-history";
import {editRenderClips} from "../src/edit-transition-render";
import {EditTime} from "../src/edit-time";
import {editCaptionCues,type EditOperation} from "../src/edit-timeline";
import {parseEditCaptions} from "../src/edit-captions";
import type {DirectionSnapshot,DirectionEntry} from "../src/direction";
import type {EditSourceReceipt} from "../src/edit-sources";
import {compileLivingScriptPatch,type LivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact,type LivingScriptRenderInputs} from "../src/living-script-generation";
import {compileLivingScriptSourceMap,type LivingScriptSourceMap} from "../src/living-script-source-map";
import {compileLivingScriptRecut,type LivingScriptRecutInput} from "../src/living-script-recut";

let fixture:Awaited<ReturnType<typeof dubStudio>>,before:EditSourceReceipt,generated:EditSourceReceipt,patch:LivingScriptPatch,candidate:LivingScriptRenderInputs,sourceMap:LivingScriptSourceMap,library:EditLibrary,now:number;
beforeAll(async()=>{
  fixture=await dubStudio();await pinDuration();
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const retained=(await fixture.worker())!;expect(retained.failureReason??retained.cancelReason).toBeUndefined();expect(retained.status).toBe("done");
  before=await inspectEditSource(retained,"Original saved source",fixture.paths.artifactRoot,async()=>{});
  const index=compileEditScriptSource(before),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  patch=compileLivingScriptPatch(before,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:retained.scriptVersion,text:retained.scriptText},replacement:"Welcome back to the garden."});
  expect((await fixture.call(fixture.base+"/script","PUT",{text:patch.after.text},fixture.owner.token)).status).toBe(200);
  const direction=await pinDuration(),impact=compileLivingScriptGenerationImpact(before,patch,{...retained,scriptVersion:patch.after.version,scriptText:patch.after.text,direction});candidate=impact.candidateInputs;
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const completed=(await fixture.worker())!;expect(completed.failureReason??completed.cancelReason).toBeUndefined();expect(completed.status).toBe("done");
  generated=await inspectEditSource(completed,"Reviewed generated screenplay",fixture.paths.artifactRoot,async()=>{});sourceMap=compileLivingScriptSourceMap(before,patch,impact,generated);
  now=Date.parse(completed.completedAt!);library=createEditSequence(emptyEditLibrary(),fixture.owner.projectId,[before],"cut","Original saved cut",before.facts.id,320,180,0,now);
},180000);
afterAll(async()=>{await fixture?.close();});
/** Fixed owner-directed duration proves the same-duration case without assuming equal TTS lengths. */
async function pinDuration():Promise<DirectionSnapshot>{
  const review=await(await fixture.call(fixture.base+"/direction","GET",undefined,fixture.owner.token)).json() as {direction:DirectionSnapshot;scriptVersion:number;plan:DirectionEntry[]};
  const entry=review.plan.find(entry=>entry.source.id==="shot-1-1")!;
  const saved=await fixture.call(fixture.base+"/direction/shot-1-1","PUT",{settings:{durationFrames:180},expectedVersion:review.direction.version,expectedScriptVersion:review.scriptVersion,sourceHash:entry.sourceHash},fixture.owner.token);expect(saved.status).toBe(200);
  return (await saved.json() as {direction:DirectionSnapshot}).direction;
}
function context(value=library){const parent=deriveEditAssemblyParent(fixture.owner.projectId,value,"cut"),indexes=parent.sourceReceipts.map(binding=>compileEditScriptSource(value.sources.find(source=>source.revision===binding.receiptRevision)!));return {parent,navigation:projectEditScriptNavigation("cut",parent.historyRevision,parent.timeline,indexes)};}
function replacement(clipId="initial-0",frames=generated.facts.frames,from=0):EditOperation{return {kind:"replace",clipId,linked:true,sourceId:generated.facts.id,from,frames,timing:"preserve",ripple:false};}
function input(value=library,operations:EditOperation[]=[replacement()]):LivingScriptRecutInput{const {parent,navigation}=context(value);return {projectId:fixture.owner.projectId,library:value,sequenceId:"cut",historyRevision:parent.historyRevision,patch,candidate,navigationRevision:navigation.revision,generated,sourceMap,operations,newSequenceId:"revised-cut"};}
function change(value:EditLibrary,operation:EditOperation){return changeEditSequence(value,fixture.owner.projectId,"cut",{kind:"edit",operation,label:"Explicit parent setup"},value.version,value.sequences[0]!.history.revision,now);}

test("actual selective source produces an independent executable recut with new measured captions and exact bindings",()=>{
  expect(generated.facts.frames).toBe(before.facts.frames);
  const args=input(),original=contentHash(args),oldCaptions=readFileSync(join(fixture.paths.artifactRoot,before.job.output!.captionsPath),"utf8"),result=compileLivingScriptRecut(args,now);
  expect(result.history.id).toBe("revised-cut");expect(result.history.root).toEqual(context().parent.timeline);expect(result.parent).toEqual(context().parent);
  expect(result.history.events.map(event=>event.kind==="edit"?event.operation.kind:event.kind)).toEqual(["source","replace"]);
  expect(result.history.events[0]!.kind==="edit"&&result.history.events[0]!.operation).toEqual({kind:"source",source:generated.facts,receiptRevision:generated.revision});
  expect(result.operations).toEqual(args.operations);expect(result.afterTimeline).toEqual(editHistoryReplay(result.history).state.timeline);
  expect(result.afterTimeline.clips.every(clip=>clip.sourceId===generated.facts.id)).toBe(true);
  expect(result.sourceReceipts).toEqual([before,generated].sort((a,b)=>a.facts.id.localeCompare(b.facts.id)).map(source=>({sourceId:source.facts.id,receiptRevision:source.revision})));
  expect(result.beforeSource.receiptRevision).toBe(before.revision);expect(result.afterSource.receiptRevision).toBe(generated.revision);expect(result.sourceMapRevision).toBe(sourceMap.revision);
  expect(result.newLineEntryId).toBe(sourceMap.entries.find(entry=>entry.patched)!.after.id);
  expect(result.mappedNewLineOccurrences.length).toBeGreaterThan(0);expect(result.mappedNewLineOccurrences.every(occurrence=>occurrence.sourceId===generated.facts.id&&occurrence.entryId===result.newLineEntryId)).toBe(true);
  expect(result.mappedNewLineOccurrences.some(occurrence=>occurrence.lane==="captions"&&occurrence.evidence==="measured-speech")).toBe(true);
  expect(editCaptionCues(result.afterTimeline).map(cue=>cue.text).join(" ")).toContain(patch.replacement);expect(editVtt(result.afterTimeline)).not.toContain("Welcome to the garden.");
  expect(readFileSync(join(fixture.paths.artifactRoot,generated.job.output!.captionsPath),"utf8")).toContain(patch.replacement);
  expect(readFileSync(join(fixture.paths.artifactRoot,before.job.output!.captionsPath),"utf8")).toBe(oldCaptions);expect(contentHash(args)).toBe(original);
  const {revision,...data}=result;expect(revision).toBe(contentHash(data));expect(compileLivingScriptRecut(args,now)).toEqual(result);
  result.history.root.clips[0]!.from++;result.afterTimeline.clips[0]!.from++;result.operations.length=0;expect(contentHash(args)).toBe(original);
});

test("explicit range repetition preserves distinct new-line occurrences without deduplication",()=>{
  const frames=generated.facts.frames,operations:EditOperation[]=[replacement(),{kind:"duration",frames:frames*2},{kind:"duplicate",clipId:"initial-0",linked:true,at:frames,ids:{"initial-0":"again-picture","initial-1":"again-mix","initial-2":"again-captions"},link:"again",ripple:false}],result=compileLivingScriptRecut(input(library,operations),now);
  expect(result.operations).toEqual(operations);expect(result.afterTimeline.clips).toHaveLength(6);expect(result.afterTimeline.frames).toBe(frames*2);
  const first=result.mappedNewLineOccurrences.filter(occurrence=>occurrence.clipId==="initial-0"),again=result.mappedNewLineOccurrences.filter(occurrence=>occurrence.clipId==="again-picture");
  expect(again.map(occurrence=>[occurrence.startSample-frames*1600,occurrence.endSample-frames*1600,occurrence.evidence])).toEqual(first.map(occurrence=>[occurrence.startSample,occurrence.endSample,occurrence.evidence]));
  expect(new Set(result.mappedNewLineOccurrences.map(occurrence=>occurrence.id)).size).toBe(result.mappedNewLineOccurrences.length);
});

test("ramp phase, split clocks and odd dissolve handles replay exactly through explicit source replacement",()=>{
  let value=change(library,{kind:"retime",clipId:"initial-0",linked:true,from:10,frames:120,points:[{frame:0,rate:500},{frame:120,rate:1500}],ripple:false});
  value=change(value,{kind:"split",clipId:"initial-0",linked:true,at:60,rightIds:{"initial-0":"right-picture","initial-1":"right-mix","initial-2":"right-captions"},rightLink:"right"});
  value=change(value,{kind:"crossfade",leftId:"initial-0",rightId:"right-picture",linked:true,frames:3,alignment:"center",ids:{"initial-0":"fade-picture","initial-1":"fade-mix"}});
  const {parent}=context(value),picture=parent.timeline.clips.filter(clip=>clip.lane==="picture"),operations=picture.map(clip=>replacement(clip.id,clip.frames,clip.from));
  const result=compileLivingScriptRecut(input(value,operations),now);
  expect(result.afterTimeline.transitions).toEqual(parent.timeline.transitions);
  for(const clip of parent.timeline.clips){const next=result.afterTimeline.clips.find(next=>next.id===clip.id)!;expect(next.timing).toEqual(clip.timing);expect(next.envelope).toEqual(clip.envelope);}
  const old=editRenderClips(parent.timeline),next=editRenderClips(result.afterTimeline);
  for(const clip of old){const replacement=next.find(item=>item.id===clip.id)!;expect([replacement.at,replacement.frames,replacement.crossfades]).toEqual([clip.at,clip.frames,clip.crossfades]);
    const a=new EditTime(clip),b=new EditTime(replacement);for(const sample of [clip.at*1600,clip.at*1600+1,(clip.at+clip.frames)*1600-1])expect(b.source(sample)).toBe(a.source(sample));
  }
});

test("source masks require an explicit remove or rebind choice and preserve parent effects",()=>{
  const value=change(library,{kind:"composite",clipId:"initial-0",composite:{schema:"hv-edit-composite/1",masks:[{id:"mask",label:"Retained source mask",sourceRevision:before.facts.revision,kind:"rectangle",combine:"replace",invert:false,featherQ8:640,keyframes:[{sourceFrame:0,interpolation:"linear",geometry:{xQ16:0,yQ16:0,widthQ16:32768,heightQ16:65536}},{sourceFrame:30,interpolation:"hold",geometry:{xQ16:4096,yQ16:0,widthQ16:32768,heightQ16:65536}}]}],placement:{xQ16:0,yQ16:0,scaleQ16:65536,rotationMilliDegrees:10000}}}),original=contentHash(value);
  expect(()=>compileLivingScriptRecut(input(value),now)).toThrow("Remove masks or Rebind masks");
  const operation=replacement();if(operation.kind!=="replace")throw new Error("Fixture operation changed.");
  const rebound=compileLivingScriptRecut(input(value,[{...operation,maskAction:"rebind"}]),now),effect=rebound.afterTimeline.clips[0]!.composite!;
  expect(effect.masks![0]!.sourceRevision).toBe(generated.facts.revision);expect(effect.masks![0]!.keyframes).toEqual(context(value).parent.timeline.clips[0]!.composite!.masks![0]!.keyframes);
  const removed=compileLivingScriptRecut(input(value,[{...operation,maskAction:"remove"}]),now);expect(removed.afterTimeline.clips[0]!.composite!.masks).toBeUndefined();expect(removed.afterTimeline.clips[0]!.composite!.placement).toEqual(effect.placement);expect(contentHash(value)).toBe(original);
});

test("stale parent, navigation, candidate and tampered generated correspondence cannot execute",()=>{
  const args=input(),changed=change(library,{kind:"marker",marker:{id:"changed",frame:1,label:"New saved parent"}});
  expect(()=>compileLivingScriptRecut({...args,library:changed},now)).toThrow("history changed");
  expect(()=>compileLivingScriptRecut({...input(changed),navigationRevision:args.navigationRevision},now)).toThrow("navigation changed");
  expect(()=>compileLivingScriptRecut({...args,candidate:{...candidate,scriptText:before.job.scriptText}},now)).toThrow("exact proposed screenplay");
  const altered=structuredClone(generated);altered.facts.frames++;expect(()=>compileLivingScriptRecut({...args,generated:altered},now)).toThrow();
  const {revision:_revision,...mapData}=sourceMap,wrongMap={...mapData,durationDeltaFrames:123};expect(()=>compileLivingScriptRecut({...args,sourceMap:{...wrongMap,revision:contentHash(wrongMap)}},now)).toThrow("correspondence changed");
  expect(()=>compileLivingScriptRecut({...args,newSequenceId:"cut"},now)).toThrow("new independent");expect(()=>compileLivingScriptRecut(args,NaN)).toThrow("review time");
});

test("every selected original clip must be replaced or removed and the generated source must actually be used",()=>{
  const isolated=replacement();if(isolated.kind!=="replace")throw new Error("Fixture operation changed.");
  expect(()=>compileLivingScriptRecut(input(library,[{kind:"unlink",clipId:"initial-0"},{...isolated,linked:false}]),now)).toThrow("every clip using the selected original");
  expect(()=>compileLivingScriptRecut(input(library,[{kind:"delete",clipId:"initial-0",linked:true,ripple:false}]),now)).toThrow("at least one actual clip");
  expect(()=>compileLivingScriptRecut(input(library,[replacement(),{kind:"source",source:before.facts,receiptRevision:before.revision}]),now)).toThrow("only new original");
  expect(()=>compileLivingScriptRecut(input(library,[replacement("initial-0",generated.facts.frames+1)]),now)).toThrow();
});

test("related localized-source clips require explicit removal or separately reviewed replacement",async()=>{
  const quote=await fixture.quote(before.job.id),admitted=await fixture.call(fixture.base+"/dialogue/"+before.job.id,"POST",fixture.requestBody(quote),fixture.owner.token);expect(admitted.status).toBe(202);
  const completed=(await fixture.worker())!;expect(completed.failureReason??completed.cancelReason).toBeUndefined();expect(completed.status).toBe("done");
  const derived=await inspectEditSource(completed,"Retained localized performance",fixture.paths.artifactRoot,async()=>{});
  const start=createEditSequence(emptyEditLibrary(),fixture.owner.projectId,[before,derived],"cut","Cut with localized source",before.facts.id,320,180,0,now),base=context(start).parent.timeline.clips[0]!;
  const value=change(start,{kind:"insert",clips:[{...base,id:"derived-picture",sourceId:derived.facts.id,layer:1,link:null}]});
  expect(()=>compileLivingScriptRecut(input(value),now)).toThrow("remains unresolved");
  const result=compileLivingScriptRecut(input(value,[replacement(),{kind:"delete",clipId:"derived-picture",linked:false,ripple:false}]),now);
  expect(result.parent.timeline.clips.some(clip=>clip.id==="derived-picture")).toBe(true);expect(result.afterTimeline.clips.some(clip=>clip.id==="derived-picture")).toBe(false);expect(result.sourceReceipts.some(binding=>binding.receiptRevision===derived.revision)).toBe(true);
},120000);

test("operation admission rejects count overflow and nonportable data before executing accessors",()=>{
  expect(()=>compileLivingScriptRecut(input(library,[]),now)).toThrow("one to 999");
  expect(()=>compileLivingScriptRecut(input(library,Array.from({length:1000},()=>replacement())),now)).toThrow("one to 999");
  let reads=0;const trap=Object.defineProperty({},"kind",{enumerable:true,get(){reads++;return "replace";}}) as EditOperation;
  expect(()=>compileLivingScriptRecut(input(library,[trap]),now)).toThrow("enumerable");expect(reads).toBe(0);
  const sparse=input();sparse.operations.length=2;expect(()=>compileLivingScriptRecut(sparse,now)).toThrow("dense");
  const args=input();Object.defineProperty(args.operations,Symbol("hidden"),{value:true});expect(()=>compileLivingScriptRecut(args,now)).toThrow();
});

test("actual editorial conform decodes the revised film and an explicit repeated-range recut with exact retained PCM",async()=>{
  const root=fixture.paths.artifactRoot,access=async()=>{},oldMp4=await soundDigest(join(root,before.job.output!.mp4Path)),oldCaptions=readFileSync(join(root,before.job.output!.captionsPath),"utf8");
  const native=createEditSequence(emptyEditLibrary(),fixture.owner.projectId,[before],"cut","Native-size original cut",before.facts.id,before.facts.width,before.facts.height,0,now),oldHistory=contentHash(native),recut=compileLivingScriptRecut(input(native),now);
  const prepared=await prepareEditSources([before,generated],root,join(root,"recut-qualified-sources"),access),media=prepared.sources.map(source=>source.media),fresh=media.find(source=>source.id===generated.facts.id)!;
  const expectedFrames=await editFrameHashes(join(root,generated.job.output!.mp4Path),generated.facts.frames,join(root,"recut-original-frame-hashes.txt"),root,access),expectedPcm=readFileSync(join(root,fresh.audio.mix!.path)).subarray(44);
  const unchanged=sourceMap.shots.find(shot=>shot.treatment==="unchanged")!;
  expect(readFileSync(join(root,unchanged.before!.record.files.video.path))).toEqual(readFileSync(join(root,unchanged.after!.record.files.video.path)));
  const fullDirectory=join(root,"recut-qualified-full"),full=await conformEdit(recut.afterTimeline,media,root,fullDirectory,access);
  expect(full.timelineRevision).toBe(recut.afterTimeline.revision);expect(full.pictureFrames).toEqual(expectedFrames);
  expect(readFileSync(join(fullDirectory,"audio/final.wav")).subarray(44)).toEqual(expectedPcm);
  const captions=readFileSync(join(fullDirectory,"captions.vtt"),"utf8");expect(captions).toContain(patch.replacement);expect(captions).not.toContain("Welcome to the garden.");
  expect(parseEditCaptions(captions,recut.afterTimeline.frames).map(({start,end,text})=>({start,end,text}))).toEqual(generated.facts.captions.map(({start,end,text})=>({start,end,text})));

  // Independent expected intervals, in child order: fresh opening, repeated opening, unchanged shot.
  const retainedStart=unchanged.after!.startFrame;expect(unchanged.after!.frames).toBeGreaterThanOrEqual(30);
  const tail=context(native).parent.timeline.clips.map(clip=>({...structuredClone(clip),id:"retained-"+clip.lane,sourceId:generated.facts.id,link:"retained",at:120,from:retainedStart,frames:30,envelope:{from:retainedStart,frames:30,fadeIn:0,fadeOut:0}}));
  const operations:EditOperation[]=[replacement("initial-0",60),{kind:"duration",frames:150},{kind:"duplicate",clipId:"initial-0",linked:true,at:60,ids:{"initial-0":"again-picture","initial-1":"again-mix","initial-2":"again-captions"},link:"again",ripple:false},{kind:"insert",clips:tail}];
  const repeated=compileLivingScriptRecut(input(native,operations),now),directory=join(root,"recut-qualified-repeated"),report=await conformEdit(repeated.afterTimeline,media,root,directory,access);
  expect(report.pictureFrames).toEqual([...expectedFrames.slice(0,60),...expectedFrames.slice(0,60),...expectedFrames.slice(retainedStart,retainedStart+30)]);
  expect(readFileSync(join(directory,"audio/final.wav")).subarray(44)).toEqual(Buffer.concat([expectedPcm.subarray(0,60*1600*6),expectedPcm.subarray(0,60*1600*6),expectedPcm.subarray(retainedStart*1600*6,(retainedStart+30)*1600*6)]));
  const repeatedCaptions=parseEditCaptions(readFileSync(join(directory,"captions.vtt"),"utf8"),150),first=repeatedCaptions.filter(cue=>cue.start<60*1600),second=repeatedCaptions.filter(cue=>cue.start>=60*1600&&cue.start<120*1600);
  expect(first.length).toBeGreaterThan(0);expect(second.map(cue=>({start:cue.start-60*1600,end:cue.end-60*1600,text:cue.text}))).toEqual(first.map(({start,end,text})=>({start,end,text})));expect(new Set(repeatedCaptions.map(cue=>cue.id)).size).toBe(repeatedCaptions.length);
  for(const [destination,frames]of [[fullDirectory,recut.afterTimeline.frames],[directory,150]] as const){
    const path=join(destination,"export.mp4"),probePath=join(destination,"independent-decode-probe.json");
    await soundProcessingCommand(["ffprobe","-v","error","-count_frames","-show_streams","-show_format","-of","json","-o",probePath,path],root,access);
    const probe=JSON.parse(readFileSync(probePath,"utf8")) as {streams:{codec_type:string;codec_name:string;nb_read_frames?:string;width?:number;height?:number;r_frame_rate?:string;sample_rate?:string;channels?:number}[];format:{duration:string}};
    const picture=probe.streams.find(stream=>stream.codec_type==="video")!,audio=probe.streams.find(stream=>stream.codec_type==="audio")!;
    expect([picture.codec_name,picture.width,picture.height,picture.r_frame_rate,Number(picture.nb_read_frames)]).toEqual(["h264",generated.facts.width,generated.facts.height,"30/1",frames]);
    expect([audio.codec_name,audio.sample_rate,audio.channels]).toEqual(["aac","48000",2]);expect(Math.abs(Number(probe.format.duration)-frames/30)).toBeLessThanOrEqual(1/30);
    await soundProcessingCommand(["ffmpeg","-v","error","-xerror","-nostdin","-i",path,"-map","0:v:0","-map","0:a:0","-f","null","-"],root,access);
    expect(readFileSync(join(destination,"hls/index.m3u8"),"utf8")).toContain("#EXT-X-ENDLIST");
  }
  expect(await soundDigest(join(root,before.job.output!.mp4Path))).toEqual(oldMp4);expect(readFileSync(join(root,before.job.output!.captionsPath),"utf8")).toBe(oldCaptions);expect(contentHash(native)).toBe(oldHistory);
  expect(recut.parent.timeline).toEqual(context(native).parent.timeline);expect(repeated.parent).toEqual(recut.parent);expect(fixture.ledger.monthSpend()).toBe(0);
},180000);
