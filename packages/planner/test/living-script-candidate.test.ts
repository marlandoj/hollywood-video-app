import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {parseFountain} from "../../parser/src/index";
import type {Job} from "../../queue/src/index";
import {compileLivingScriptCandidate,type LivingScriptCandidateContext} from "../src/living-script-candidate";
import {compileLivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../src/living-script-generation";
import {compileEditScriptSource} from "../src/edit-script-source";
import {directionEntry,directionSnapshot,sourceDirection,type DirectionSnapshot} from "../src/direction";
import {castingSnapshot,characterRecord} from "../src/casting";
import {createScenePerformance} from "../src/performance-memory";
import {sceneCut,cutSource,proposeSceneCut,sourcePlan} from "../src/scene-cuts";
import {coverageSettings} from "../src/coverage";
import {lineSources,compilePerformances,spokenText,voiceProfile,type SpeechReport} from "../src/performances";
import {renderRecord,renderInputHash,renderShots,type RenderFile} from "../src/shot-reuse";
import {editFactsRevision,editSourceAudio,editSourceLanguage,editSourceKnownFiles,editSourceRequiredPaths,editSourceVoiceWindows,validateEditSourceReceipt,type EditSourceReceipt} from "../src/edit-sources";
import {EDIT_AUDIO_LANES,type EditSource} from "../src/edit-timeline";
import type {ReferenceAsset} from "../src/references";
import {CAST_INPUT} from "../../../test/fixtures/casting";

const projectId="candidate-project",at=Date.parse("2026-01-01T00:00:00.000Z"),hash="a".repeat(64),simple="INT. ROOM - DAY\n\nA lamp glows.\n\nMARLA\nAgain.\nAgain.";
const providerPlan=createProviderPlan("animatic",5,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["legacy-mock"]'});
const file=(path:string,bytes=100):RenderFile=>({path,bytes,sha256:hash});
/** Pure, fully validated retained film metadata; no provider or media work is needed for source rebinding. */
function film(scriptText:string,direction=directionSnapshot(projectId,0,[],at),casting=castingSnapshot(projectId,0,[],at)):EditSourceReceipt {
  const id=crypto.randomUUID(),job:Job={id,idempotencyKey:id,projectId,tier:"free",stage:"animatic",scriptVersion:1,scriptText,casting,direction,providerPlan,status:"done",queueAction:"run",queueReason:"capacity_available",queuedBehind:[],checkpointFrame:0,checkpointShots:0,totalFrames:0,retryPolicy:{maxRetries:0,backoffMs:0},retriesUsed:0,timeoutMs:60000,costCapUsd:5,budgetReservedUsd:0,costUsd:0,rightsAttestedAt:new Date(at).toISOString(),animaticJobId:null,animaticApprovedAt:null,nextEligibleAt:null,startedAt:new Date(at+1000).toISOString(),leaseExpiresAt:null,leaseVersion:0,claimedBy:null,resumedCount:0,completedAt:new Date(at+2000).toISOString(),linkExpiresAt:"2099-01-01T00:00:00.000Z",notifications:[]};
  const records=renderShots(job,at+1000).map(shot=>{let cursor=0;
    const lines=compilePerformances(shot.dialogue,shot.performances).map(line=>{cursor+=Math.round(line.beforeMs*22050/1000);const startSample=cursor;cursor+=7350;const endSample=cursor;cursor+=Math.round(line.afterMs*22050/1000);return {...line,startSample,endSample,spokenText:spokenText(line),pcmSha256:hash};});
    const speech:SpeechReport|undefined=lines.length?{schema:"hv-speech/1",engine:"espeak-ng",engineVersion:"espeak-"+hash,sampleRate:22050,totalSamples:cursor,lines}:undefined;
    return renderRecord({projectId,jobId:id,shotId:shot.id,inputHash:renderInputHash(job,shot),origin:{jobId:id,shotId:shot.id},clip:{provider:"mock",model:"candidate-metadata",seed:shot.seed,durationSec:Math.max(60,Math.ceil(cursor/735))/30,fingerprint:hash,audioMode:speech?"provided":"silent-captioned",...(shot.picturePerformance?{picturePerformance:shot.picturePerformance}:{}),...(speech?{speech}:{})},files:{video:file(`${projectId}/${id}/clips/${shot.id}.mp4`),...(speech?{audio:file(`${projectId}/${id}/clips/${shot.id}.wav`,44+speech.totalSamples*2)}:{})}});
  });
  const frames=records.reduce((sum,record)=>sum+Math.round(record.clip.durationSec*30),0);job.totalFrames=frames;job.checkpointFrame=frames;job.checkpointShots=records.length;
  job.output={mp4Path:`${projectId}/${id}/export.mp4`,captionsPath:`${projectId}/${id}/captions.vtt`,manifestPath:`${projectId}/${id}/provenance.json`,hlsPlaylistPath:`${projectId}/${id}/hls/index.m3u8`,shotRenders:records};
  const captions:EditSource["captions"]=[],audio=editSourceAudio(job),facts:EditSource={id,label:"Candidate fixture",revision:editFactsRevision(job,frames,320,180,captions),width:320,height:180,frames,audio:EDIT_AUDIO_LANES.filter(lane=>audio[lane]),captions,...editSourceVoiceWindows(job)},files=new Map(editSourceKnownFiles(job).map(value=>[value.path,value]));
  for(const path of editSourceRequiredPaths(job))if(!files.has(path))files.set(path,file(path));
  const data={schema:"hv-edit-source/1" as const,job,facts,audio,files:[...files.values()],language:editSourceLanguage(job)};return validateEditSourceReceipt({...data,revision:contentHash(data)});
}
function proposal(source:EditSourceReceipt,physicalLine?:number,replacement="Come inside.") {
  const index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue"&&(physicalLine===undefined||entry.startLine===physicalLine))!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:1,text:source.job.scriptText},replacement}),context:LivingScriptCandidateContext={projectId,currentScript:{version:1,text:source.job.scriptText},baseline:{casting:source.job.casting!,direction:source.job.direction!},stage:"animatic",tier:"free",providerPlan};return {patch,context};
}
function directed(text:string,coverage=false,anchors?:ReferenceAsset):DirectionSnapshot {
  const parsed=parseFountain(text),cuts=coverage?parsed.scenes.map(scene=>proposeSceneCut(scene,true)):undefined,base=directionSnapshot(projectId,3,[],at,cuts),shots=sourcePlan(parsed,base,7000,24);
  return directionSnapshot(projectId,4,shots.map(shot=>directionEntry(shot,{...sourceDirection(shot),performance:"Keep the hesitation.",durationFrames:180,seed:99,
    lines:lineSources(shot.dialogue).map(line=>({index:line.index,sourceHash:line.hash,rateWpm:130+line.index,pitch:40+line.index,level:90,beforeMs:150,afterMs:350,notes:"Let the thought land."})),
    ...(anchors?{frameAnchors:{frames:[{at:0,asset:anchors}],fallback:"storyboard"}}:{})})),at,cuts);
}
function artistic(settings:DirectionSnapshot["entries"][number]["settings"]) {return {...settings,...(settings.lines?{lines:settings.lines.map(({sourceHash:_sourceHash,...line})=>line)}:{})};}
function reseal<T extends {revision:string}>(value:T):T {const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;}

test("repeated physical dialogue preserves cues, CRLF, all line controls and unrelated directed shots",()=>{
  const text="INT. ROOM - DAY\r\n\r\nA lamp glows.\r\n\r\nMARLA\r\n(quietly)\r\nAgain.\r\n\tAgain.  \r\nCUT TO:\r\nContinued line.\r\n\r\nINT. GARDEN - DAY\r\n\r\nA leaf falls.\r\n\r\nMARLA\r\nAgain.",anchor:ReferenceAsset={schema:"hv-reference/1",id:crypto.randomUUID(),projectId,sha256:hash,originalSha256:hash,bytes:100,width:32,height:24,contentType:"image/png",createdAt:new Date(at).toISOString(),attestedAt:new Date(at).toISOString()},source=film(text,directed(text,false,anchor)),{patch,context}=proposal(source,8),before=contentHash({source,patch,context}),result=compileLivingScriptCandidate(source,patch,context,at+3000),next=result.candidateInputs.direction!;
  expect(result.candidateInputs.scriptText).toBe(patch.after.text);expect(result.candidateInputs.casting).toEqual(context.baseline.casting);expect(next.version).toBe(5);expect(next.createdAt).toBe(new Date(at+3000).toISOString());expect(result.baseline).toEqual(context.baseline);
  expect(result.changes.sceneCuts).toEqual([]);expect(result.changes.scenePerformances).toEqual([]);expect(result.changes.directions).toHaveLength(1);expect(result.changes.directions[0]!.shotId).toBe("shot-1-1");expect(result.changes.directions[0]!.lines).toEqual([{index:1,beforeSourceHash:context.baseline.direction.entries[0]!.settings.lines![1]!.sourceHash,afterSourceHash:next.entries[0]!.settings.lines![1]!.sourceHash,beforeText:"Again.",afterText:"Come inside."}]);
  for(const [index,entry]of next.entries.entries()){expect(artistic(entry.settings)).toEqual(artistic(context.baseline.direction.entries[index]!.settings));expect(entry.settings.frameAnchors).toEqual(context.baseline.direction.entries[index]!.settings.frameAnchors);}
  expect(next.entries[1]).toEqual(context.baseline.direction.entries[1]);expect(next.entries[0]!.settings.lines![0]).toEqual(context.baseline.direction.entries[0]!.settings.lines![0]);expect(next.entries[0]!.settings.lines![2]).toEqual(context.baseline.direction.entries[0]!.settings.lines![2]);
  const spoken=renderShots(result.candidateInputs,at+3000)[0]!.performances!;expect(spoken[1]!.source.cues).toEqual(["(quietly)"]);expect(spoken[1]!.notes).toBe("Let the thought land.");expect(spoken[1]!.voice.rateWpm).toBe(131);expect(spoken[1]!.beforeMs).toBe(150);
  expect(contentHash({source,patch,context})).toBe(before);expect(result).toEqual(reseal(result));expect(compileLivingScriptCandidate(source,patch,context,at+3000)).toEqual(result);
});

test("authored coverage and silent reaction directions follow the exact changed beat without replacing artistic plans",()=>{
  const text="INT. GARDEN - DAY\n\nA door opens.\n\nMARLA\nAgain.\n\nA bell rings.\n\nMARLA\nAgain.\n\nROBIN\nI hear you.",source=film(text,directed(text,true)),{patch,context}=proposal(source,11),result=compileLivingScriptCandidate(source,patch,context,at+3000),next=result.candidateInputs.direction!,oldCut=context.baseline.direction.sceneCuts![0]!,newCut=next.sceneCuts![0]!;
  expect(newCut.shots).toEqual(oldCut.shots);expect(newCut.notes).toBe(oldCut.notes);expect(newCut.sourceHash).not.toBe(oldCut.sourceHash);expect(result.changes.sceneCuts).toEqual([{sceneIndex:0,beforeRevision:oldCut.revision,afterRevision:newCut.revision}]);
  const selected=oldCut.shots.find(shot=>shot.beatIds.includes(patch.mapping.beatId))!,reaction=oldCut.shots.find(shot=>shot.afterBeatId===patch.mapping.beatId)!;expect(reaction).toBeDefined();
  expect(result.changes.directions.map(change=>change.shotId)).toEqual([selected.id,reaction.id]);expect(result.changes.directions.find(change=>change.shotId===selected.id)!.lines).toHaveLength(1);expect(result.changes.directions.find(change=>change.shotId===reaction.id)!.lines).toEqual([]);
  for(const [index,entry]of next.entries.entries())expect(artistic(entry.settings)).toEqual(artistic(context.baseline.direction.entries[index]!.settings));
  const unchanged=context.baseline.direction.entries.filter(entry=>![selected.id,reaction.id].includes(entry.source.id));for(const entry of unchanged)expect(next.entries.find(value=>value.source.id===entry.source.id)).toEqual(entry);
  expect(renderShots(result.candidateInputs,at+3000).map(shot=>shot.id)).toEqual(renderShots(source.job,at+1000).map(shot=>shot.id));expect(compileLivingScriptGenerationImpact(source,patch,result.candidateInputs,at+3000).generateShotIds).toEqual([selected.id,reaction.id]);
});

test("grouped authored beats preserve separate repeated dialogue block identities",()=>{
  const text="INT. ROOM - DAY\n\nMARLA\nAgain.\n\nMARLA\nAgain.",scene=parseFountain(text).scenes[0]!,cut=sceneCut(cutSource(scene),[{id:"shot-1-10001",beatIds:scene.beats!.filter(beat=>beat.kind!=="transition").map(beat=>beat.id),afterBeatId:null,coverage:coverageSettings({role:"master"}),durationFrames:180,notes:"Keep both beats in this shot."}]),base=directionSnapshot(projectId,1,[],at,[cut]),shot=sourcePlan(parseFountain(text),base,7000,24)[0]!,direction=directionSnapshot(projectId,2,[directionEntry(shot,{...sourceDirection(shot),lines:lineSources(shot.dialogue).map(line=>({index:line.index,sourceHash:line.hash,notes:"Distinct take "+line.index,rateWpm:100+line.index*50}))})],at,[cut]),source=film(text,direction),{patch,context}=proposal(source,7),result=compileLivingScriptCandidate(source,patch,context,at+3000);
  expect(result.changes.directions[0]!.lines).toMatchObject([{index:1,beforeText:"Again.",afterText:"Come inside."}]);expect(result.candidateInputs.direction!.entries[0]!.settings.lines![0]).toEqual(direction.entries[0]!.settings.lines![0]);expect(renderShots(result.candidateInputs,at+3000)[0]!.performances!.map(line=>({text:line.source.text,notes:line.notes,rate:line.voice.rateWpm}))).toEqual([{text:"Again.",notes:"Distinct take 0",rate:100},{text:"Come inside.",notes:"Distinct take 1",rate:150}]);
});

test("transition-continuation line addresses remain exact in normal and authored source plans",()=>{
  const text="INT. ROOM - DAY\n\nMARLA\nFirst line.\nCUT TO:\nContinued line.";
  for(const coverage of [false,true]){const source=film(text,directed(text,coverage)),{patch,context}=proposal(source,6),result=compileLivingScriptCandidate(source,patch,context,at+3000),lines=result.changes.directions.flatMap(change=>change.lines);
    expect(patch.mapping.sceneDialogueLineIndex).toBe(1);expect(patch.mapping.beatLineIndex).toBe(0);expect(lines).toHaveLength(1);expect(lines[0]).toMatchObject({index:coverage?0:1,beforeText:"Continued line.",afterText:"Come inside."});expect(renderShots(result.candidateInputs,at+3000).flatMap(shot=>shot.performances??[]).map(line=>line.source.text)).toEqual(["First line.","Come inside."]);
  }
});

test("scene performance rebinding preserves every vocal picture identity permission and reference field",()=>{
  const text=simple+"\n\nINT. GARDEN - DAY\n\nMARLA\nRest now.",parsed=parseFountain(text),id=crypto.randomUUID(),character=characterRecord({...CAST_INPUT,name:"MARLA",aliases:[],voice:voiceProfile({voice:"en-us",pronunciations:[{word:"Again",say:"once more"}]})},id,at),reference:ReferenceAsset={schema:"hv-reference/1",id:crypto.randomUUID(),projectId,sha256:hash,originalSha256:hash,bytes:100,width:32,height:24,contentType:"image/png",createdAt:new Date(at).toISOString(),attestedAt:new Date(at).toISOString()};
  character.sceneBindings=parsed.scenes.map(scene=>({sceneNumber:scene.index+1,heading:scene.heading}));character.references=[reference];character.libraryOrigin={projectId:crypto.randomUUID(),characterId:crypto.randomUUID(),shareId:crypto.randomUUID(),revision:hash,importedAt:new Date(at).toISOString()};character.scenePerformances=parsed.scenes.map(scene=>createScenePerformance(id,scene,{notes:"Retain the calm delivery.",controls:{emotion:"calm",speed:.8,volume:.9},picture:{emotion:"calm"},nativeVoice:{style:"whispering",intensity:1.6}}));
  const source=film(text,directed(text),castingSnapshot(projectId,6,[character],at)),{patch,context}=proposal(source,7),result=compileLivingScriptCandidate(source,patch,context,at+3000),casting=result.candidateInputs.casting!,next=casting.characters[0]!,old=context.baseline.casting.characters[0]!;
  expect(casting.version).toBe(7);expect(result.changes.scenePerformances).toHaveLength(1);expect(result.changes.scenePerformances[0]).toMatchObject({characterId:id,sceneNumber:1,beforeRevision:old.scenePerformances![0]!.revision,afterRevision:next.scenePerformances![0]!.revision});
  expect({...next,scenePerformances:undefined}).toEqual({...old,scenePerformances:undefined});expect(next.scenePerformances![1]).toEqual(old.scenePerformances![1]);
  const {sourceHash:_oldSource,revision:_oldRevision,...oldSettings}=old.scenePerformances![0]!,{sourceHash:_newSource,revision:_newRevision,...newSettings}=next.scenePerformances![0]!;expect(newSettings).toEqual(oldSettings);expect(next.permission).toEqual(old.permission);expect(next.voice).toEqual(old.voice);expect(next.references).toEqual(old.references);expect(next.libraryOrigin).toEqual(old.libraryOrigin);
  expect(()=>renderShots(result.candidateInputs,at+3000)).not.toThrow();expect(result.baseline.casting).toEqual(context.baseline.casting);
});

test("an undirected line keeps settings snapshots exact and returns detached immutable review data",()=>{
  const source=film(simple),{patch,context}=proposal(source,7),result=compileLivingScriptCandidate(source,patch,context,at+3000);expect(result.changes).toEqual({directions:[],sceneCuts:[],scenePerformances:[]});expect(result.candidateInputs.direction).toEqual(context.baseline.direction);expect(result.candidateInputs.casting).toEqual(context.baseline.casting);expect(result.createdAt).toBe(new Date(at+3000).toISOString());
  result.candidateInputs.direction!.entries.push(directionEntry(sourcePlan(parseFountain(simple))[0]!,{}));result.baseline.casting.characters.push(characterRecord({...CAST_INPUT,name:"OTHER"},crypto.randomUUID(),at));expect(context.baseline.direction.entries).toEqual([]);expect(context.baseline.casting.characters).toEqual([]);expect(source.job.scriptText).toBe(simple);expect(context.currentScript.text).toBe(simple);
});

test("newer current artistic settings take precedence over the historical film settings without saving the screenplay",()=>{
  const source=film(simple),{patch,context}=proposal(source,7),current=directed(simple),asked={...context,baseline:{...context.baseline,direction:current}},result=compileLivingScriptCandidate(source,patch,asked,at+3000);
  expect(result.baseline.direction).toEqual(current);expect(result.candidateInputs.direction!.version).toBe(current.version+1);expect(artistic(result.candidateInputs.direction!.entries[0]!.settings)).toEqual(artistic(current.entries[0]!.settings));expect(source.job.direction!.version).toBe(0);expect(source.job.scriptVersion).toBe(1);expect(asked.currentScript.text).toBe(simple);expect(result.sourceReceiptRevision).toBe(source.revision);
});

test("preexisting stale directions coverage or character memories require review instead of silent loss",()=>{
  const source=film(simple),{patch,context}=proposal(source),shot=sourcePlan(parseFountain(simple),context.baseline.direction,7000,24)[0]!,stale=directionSnapshot(projectId,1,[directionEntry({...shot,prompt:"A different prior scene."},{performance:"Do not discard."})],at);
  expect(()=>compileLivingScriptCandidate(source,patch,{...context,baseline:{...context.baseline,direction:stale}},at+3000)).toThrow("stale shot directions");
  const other=parseFountain(simple.replace("Again.","Earlier line.")),cut=proposeSceneCut(other.scenes[0]!),coverage=directionSnapshot(projectId,1,[],at,[cut]);expect(()=>compileLivingScriptCandidate(source,patch,{...context,baseline:{...context.baseline,direction:coverage}},at+3000)).toThrow("accepted coverage");
  const id=crypto.randomUUID(),character=characterRecord({...CAST_INPUT,name:"MARLA",aliases:[]},id,at);character.scenePerformances=[createScenePerformance(id,other.scenes[0]!,{notes:"Keep me."})];const casting=castingSnapshot(projectId,1,[character],at);expect(()=>compileLivingScriptCandidate(source,patch,{...context,baseline:{...context.baseline,casting}},at+3000)).toThrow("saved character performance");
});

test("exact current screenplay stage provider patch and normalized settings are all bound",()=>{
  const source=film(simple,directed(simple)),{patch,context}=proposal(source),changedPatch=reseal({...patch,replacement:"Forged replacement."});expect(()=>compileLivingScriptCandidate(source,changedPatch,context,at+3000)).toThrow();
  for(const changed of [{...context,currentScript:{...context.currentScript,version:2}},{...context,currentScript:{...context.currentScript,text:simple+"\n"}},{...context,projectId:"foreign"},{...context,stage:"final" as const},{...context,tier:"elevated" as const},{...context,providerPlan:createProviderPlan("final",5,undefined,{HV_PROVIDER_POOL:'["mock"]'})}])expect(()=>compileLivingScriptCandidate(source,patch,changed,at+3000)).toThrow();
  expect(()=>compileLivingScriptCandidate(source,patch,context,at-1)).toThrow("after its current settings");
  const bad=structuredClone(context);bad.baseline.direction.entries[0]!.settings.lines![0]!.sourceHash=hash;expect(()=>compileLivingScriptCandidate(source,patch,bad,at+3000)).toThrow();
  expect(()=>compileLivingScriptCandidate(source,patch,{...context,baseline:{...context.baseline,direction:{...context.baseline.direction,unreviewed:true}}} as LivingScriptCandidateContext,at+3000)).toThrow("complete cast and direction");
});

test("portable metadata guards run before accessors or hidden and sparse fields can affect hashes",()=>{
  const source=film(simple),{patch,context}=proposal(source);let reads=0;const trapped=Object.defineProperty({...context},"baseline",{enumerable:true,get(){reads++;return context.baseline;}});expect(()=>compileLivingScriptCandidate(source,patch,trapped,at+3000)).toThrow("accessors");expect(reads).toBe(0);
  const hidden=structuredClone(context);Object.defineProperty(hidden,Symbol("hidden"),{value:1});expect(()=>compileLivingScriptCandidate(source,patch,hidden,at+3000)).toThrow("hidden");
  const sparse=structuredClone(context);sparse.baseline.direction.entries.length=2;expect(()=>compileLivingScriptCandidate(source,patch,sparse,at+3000)).toThrow("dense");
  for(const now of [NaN,Infinity,-0])expect(()=>compileLivingScriptCandidate(source,patch,context,now)).toThrow("portable");expect(()=>compileLivingScriptCandidate(source,patch,{...context,unexpected:true} as LivingScriptCandidateContext,at+3000)).toThrow("exact pending");
  const cyclic=structuredClone(context) as LivingScriptCandidateContext&{self?:unknown};cyclic.self=cyclic;expect(()=>compileLivingScriptCandidate(source,patch,cyclic,at+3000)).toThrow("portable");
});
