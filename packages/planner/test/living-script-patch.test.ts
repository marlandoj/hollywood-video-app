import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {compileLivingScriptPatch,validateLivingScriptPatch,LIVING_SCRIPT_PATCH_LIMITS,type LivingScriptPatch,type LivingScriptPatchRequest} from "../src/living-script-patch";
import {compileEditScriptSource} from "../src/edit-script-source";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {renderRecord,renderInputHash,renderShots,type RenderFile} from "../src/shot-reuse";
import {compilePerformances,spokenText,type SpeechReport} from "../src/performances";
import {editFactsRevision,editSourceAudio,editSourceLanguage,editSourceKnownFiles,editSourceRequiredPaths,editSourceVoiceWindows,validateEditSourceReceipt,type EditSourceReceipt} from "../src/edit-sources";
import {EDIT_AUDIO_LANES,type EditSource} from "../src/edit-timeline";
import type {Job} from "../../queue/src/index";
import {parseFountain} from "../../parser/src/index";
import {proposeSceneCut} from "../src/scene-cuts";
import {directionSnapshot,type DirectionSnapshot} from "../src/direction";
import {castingSnapshot,characterRecord,type CastingSnapshot} from "../src/casting";
import {defaultMotionGraphic,motionGraphic,GRAPHIC_RECIPE,GRAPHIC_CHROME_VERSION} from "../src/motion-graphics";
import {graphicJobPlan,graphicInventory} from "../src/graphic-jobs";
import {compileGraphic} from "../../generator/src/graphic-composition";
import {graphicHash} from "../../generator/src/graphic-fonts";
import type {GraphicRenderReceipt} from "../../generator/src/graphic-receipt";

const hash="a".repeat(64),time=Date.parse("2026-01-01T00:00:00.000Z"),simple="INT. ROOM - DAY\n\nA lamp glows.\n\nMARLA\nAgain.";
const file=(path:string,bytes=100):RenderFile=>({path,bytes,sha256:hash});
/** Sealed, structurally valid retained metadata. These pure provenance fixtures produce no media. */
function film(scriptText:string,{speech=true,direction,casting,frames}:{speech?:boolean;direction?:DirectionSnapshot;casting?:CastingSnapshot;frames?:number}={}):EditSourceReceipt{
  const id=crypto.randomUUID(),projectId="script-project",job:Job={id,idempotencyKey:id,projectId,tier:"free",stage:"animatic",scriptVersion:1,scriptText,status:"done",queueAction:"run",queueReason:"capacity_available",queuedBehind:[],checkpointFrame:0,checkpointShots:0,totalFrames:0,retryPolicy:{maxRetries:0,backoffMs:0},retriesUsed:0,timeoutMs:60000,costCapUsd:5,budgetReservedUsd:0,costUsd:0,rightsAttestedAt:new Date(time).toISOString(),animaticJobId:null,animaticApprovedAt:null,nextEligibleAt:null,startedAt:new Date(time+1000).toISOString(),leaseExpiresAt:null,claimedBy:null,resumedCount:0,completedAt:new Date(time+2000).toISOString(),linkExpiresAt:"2099-01-01T00:00:00.000Z",notifications:[],providerPlan:createProviderPlan("animatic",5,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["legacy-mock"]'}),...(direction?{direction}:{})};
  if(casting)job.casting=casting;
  const shots=renderShots(job,time+1000),records=shots.map(shot=>{
    const lines=speech?compilePerformances(shot.dialogue,shot.performances):[];let cursor=0;
    const recorded=lines.map(line=>{cursor+=Math.round(line.beforeMs*22050/1000);const startSample=cursor;cursor+=7350;const endSample=cursor;cursor+=Math.round(line.afterMs*22050/1000);return {...line,startSample,endSample,spokenText:spokenText(line),pcmSha256:hash};});
    const report:SpeechReport|undefined=recorded.length?{schema:"hv-speech/1",engine:"espeak-ng",engineVersion:"espeak-"+hash,sampleRate:22050,totalSamples:cursor,lines:recorded}:undefined,durationSec=Math.max(60,Math.ceil(cursor/735))/30;
    return renderRecord({projectId,jobId:id,shotId:shot.id,inputHash:renderInputHash(job,shot),origin:{jobId:id,shotId:shot.id},clip:{provider:"mock",model:"metadata-fixture",seed:shot.seed,durationSec,fingerprint:hash,audioMode:report?"provided":"silent-captioned",...(report?{speech:report}:{})},files:{video:file(`${projectId}/${id}/clips/${shot.id}.mp4`),...(report?{audio:file(`${projectId}/${id}/clips/${shot.id}.wav`,44+report.totalSamples*2)}:{})}});
  });
  job.output={mp4Path:`${projectId}/${id}/export.mp4`,captionsPath:`${projectId}/${id}/captions.vtt`,manifestPath:`${projectId}/${id}/provenance.json`,hlsPlaylistPath:`${projectId}/${id}/hls/index.m3u8`,shotRenders:records};
  return receipt(job,frames??records.reduce((n,record)=>n+Math.round(record.clip.durationSec*30),0));
}
function receipt(job:Job,count:number):EditSourceReceipt{
  const captions:EditSource["captions"]=[],audio=editSourceAudio(job),facts:EditSource={id:job.id,label:"Retained patch fixture",revision:editFactsRevision(job,count,320,180,captions),width:320,height:180,frames:count,audio:EDIT_AUDIO_LANES.filter(lane=>audio[lane]),captions,...editSourceVoiceWindows(job),...(job.graphicOutput?{media:"graphic-rgba" as const}:{})};
  const files=new Map(editSourceKnownFiles(job).map(value=>[value.path,value]));for(const path of editSourceRequiredPaths(job))if(!files.has(path))files.set(path,file(path));
  const data={schema:job.graphicOutput?"hv-edit-source/2" as const:"hv-edit-source/1" as const,job,facts,audio,files:[...files.values()],language:editSourceLanguage(job)};return validateEditSourceReceipt({...data,revision:contentHash(data)});
}
function request(source:EditSourceReceipt,physicalLine?:number,replacement="Come inside."):LivingScriptPatchRequest{
  const index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue"&&(physicalLine===undefined||entry.startLine===physicalLine))!;
  return {entryId:entry.id,indexRevision:index.revision,currentScript:{version:source.job.scriptVersion,text:source.job.scriptText},replacement};
}
function reseal<T extends {revision:string}>(value:T):T {const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;}

test("repeated spoken lines use physical identity and preserve CRLF, whitespace and protected unrelated bytes",()=>{
  const text="Title: Café 🌿\r\n\r\n.INT. GARDEN - DAY\r\n\r\nA door opens.\r\n\r\nMARLA\r\n(quietly)\r\nAgain.\r\n/*\r\nAgain.\r\n*/\r\n \tAgain. \t\r\n\r\nMARLA\r\nAgain.\r\n\r\n[[Keep this note.]]\r\nCUT TO BLACK.\r\n",source=film(text),asked=request(source,13,"Welcome, friend."),original=contentHash({source,asked}),patch=compileLivingScriptPatch(source,asked);
  expect(patch.before.text).toBe(text);expect(patch.after.text).toBe(text.replace(" \tAgain. \t"," \tWelcome, friend. \t"));
  expect(patch.line).toMatchObject({physicalLine:13,beforeRaw:" \tAgain. \t",afterRaw:" \tWelcome, friend. \t",leadingWhitespace:" \t",trailingWhitespace:" \t",lineEnding:"\r\n",offsetUnit:"utf16"});
  expect(Buffer.from(patch.before.text.slice(0,patch.line.beforeStart))).toEqual(Buffer.from(patch.after.text.slice(0,patch.line.afterStart)));
  expect(Buffer.from(patch.before.text.slice(patch.line.beforeEnd))).toEqual(Buffer.from(patch.after.text.slice(patch.line.afterEnd)));
  expect(patch.after.text.split("\r\n").filter(line=>line==="Again.")).toHaveLength(3);
  expect(patch.mapping).toMatchObject({oldEntryId:asked.entryId,sceneIndex:0,sceneDialogueIndex:0,sceneDialogueLineIndex:2,beatLineIndex:2,newRetainedEntryId:null});
  expect(patch.before.version).toBe(1);expect(patch.after.version).toBe(2);expect(patch.after.sha256).toBe(createHash("sha256").update(patch.after.text).digest("hex"));
  expect(patch.before.scriptRevision).toBe(compileEditScriptSource(source).scriptRevision!);expect(patch.after.scriptRevision).toBe(contentHash({scriptVersion:2,scriptText:patch.after.text}));
  expect(patch.sourceFilm).toEqual({jobId:source.job.id,scriptVersion:1,scriptRevision:patch.before.scriptRevision});expect(patch.receiptRevision).toBe(source.revision);expect(patch.sourceRevision).toBe(source.facts.revision);
  expect(patch.mapping.beforeLineId).not.toBe(patch.mapping.afterLineId);expect(patch.affectedSceneIndexes).toEqual([0]);expect(patch.affectedShotIds).toEqual(["shot-1-1"]);expect(patch.shotCoverageComplete).toBe(true);
  expect(contentHash({source,asked})).toBe(original);expect(compileLivingScriptPatch(source,asked)).toEqual(patch);expect(validateLivingScriptPatch(source,patch)).toEqual(patch);expect(patch).toEqual(reseal(patch));
});

test("mixed line endings and an unterminated final line keep exact offsets and independently cloned receipts",()=>{
  const text="INT. ROOM - DAY\r\n\nMARLA\r\nAgain.\n\tAgain.  ",source=film(text),asked=request(source,5),patch=compileLivingScriptPatch(source,asked),validated=validateLivingScriptPatch(source,patch);
  expect(patch.line.lineEnding).toBe("");expect(patch.line.beforeEnd).toBe(text.length);expect(patch.line.afterEnd).toBe(patch.after.text.length);expect(patch.after.text).toBe("INT. ROOM - DAY\r\n\nMARLA\r\nAgain.\n\tCome inside.  ");
  validated.before.text="mutated";validated.affectedShotIds.push("other");validated.mapping.oldEntryId=hash;expect(patch.before.text).toBe(text);expect(patch.affectedShotIds).toEqual(["shot-1-1"]);expect(patch.mapping.oldEntryId).toBe(asked.entryId);
  source.job.scriptText="other";asked.currentScript.text="other";asked.replacement="other";expect(patch.before.text).toBe(text);expect(patch.replacement).toBe("Come inside.");
});

test("transition continuations preserve original dialogue block offsets for standard and accepted coverage",()=>{
  const text="INT. ROOM - DAY\n\nMARLA\nFirst line.\nCUT TO:\nContinued line.",cut=proposeSceneCut(parseFountain(text).scenes[0]!),direction=directionSnapshot("script-project",0,[],time,[cut]);
  for(const source of [film(text),film(text,{direction})]){
    const patch=compileLivingScriptPatch(source,request(source,6,"Continue through the doorway."));
    expect(patch.mapping).toMatchObject({sceneDialogueIndex:0,sceneDialogueLineIndex:1,beatLineIndex:0});expect(patch.line.physicalLine).toBe(6);expect(patch.after.text).toContain("First line.\nCUT TO:\nContinue through the doorway.");
    const parsed=parseFountain(patch.after.text);expect(parsed.scenes[0]!.dialogue).toEqual([{character:"MARLA",lines:["First line.","Continue through the doorway."]}]);expect(parsed.scenes[0]!.transitions).toEqual(["CUT TO:"]);
    const entry=compileEditScriptSource(source).entries.find(entry=>entry.id===patch.mapping.oldEntryId)!;expect(patch.affectedShotIds).toEqual([...new Set(entry.windows.map(window=>window.shotId).filter(Boolean))] as string[]);expect(patch.shotCoverageComplete).toBe(true);
  }
});

test("accepted coverage distinguishes repeated beat text and leaves unavailable shot alignment explicit",()=>{
  const text="INT. GARDEN - DAY\n\nA door opens.\n\nMARLA\nAgain.\n\nA door opens.\n\nMARLA\nAgain.",cut=proposeSceneCut(parseFountain(text).scenes[0]!),direction=directionSnapshot("script-project",0,[],time,[cut]),source=film(text,{direction});
  const first=compileLivingScriptPatch(source,request(source,6)),second=compileLivingScriptPatch(source,request(source,11));expect(first.mapping.oldEntryId).not.toBe(second.mapping.oldEntryId);expect(first.mapping.beatId).not.toBe(second.mapping.beatId);expect(first.affectedShotIds).toEqual([cut.shots[1]!.id]);expect(second.affectedShotIds).toEqual([cut.shots[3]!.id]);
  const unknown=film(simple,{speech:false,frames:59}),patch=compileLivingScriptPatch(unknown,request(unknown));expect(patch.shotCoverageComplete).toBe(false);expect(patch.affectedShotIds).toEqual([]);expect(patch.warnings.join(" ")).toContain("additional verified shot mapping");expect(patch.warnings.join(" ")).toContain("assembly duration");
});

test("source identity and exact current screenplay reject stale indices, foreign repeated entries and branch conflicts",()=>{
  const source=film(simple),asked=request(source),foreign=request(film(simple));
  for(const change of [{indexRevision:hash},{entryId:foreign.entryId},{indexRevision:foreign.indexRevision},{currentScript:{...asked.currentScript,version:2}},{currentScript:{...asked.currentScript,text:simple.replace("lamp","candle")}}])expect(()=>compileLivingScriptPatch(source,{...asked,...change})).toThrow();
  expect(()=>compileLivingScriptPatch(source,{...asked,currentScript:{...asked.currentScript,version:2}})).toThrow("stale version or branch");
  for(const entry of compileEditScriptSource(source).entries.filter(entry=>entry.kind!=="dialogue"))expect(()=>compileLivingScriptPatch(source,{...asked,entryId:entry.id})).toThrow("original spoken dialogue");
});

test("spoken replacements reject structural changes and protection syntax while ordinary uppercase and ellipsis remain speech",()=>{
  const source=film(simple),asked=request(source),invalid=[""," ","Again."," New text","New text ","Line\nOther","Line\r\nOther","Line\rOther","Line\u2028Other","Line\u2029Other","Line\0Other","Line\u007fOther","\ud800","[[note]]","A /* comment */ line","A */ close","(quietly)","INT. OTHER - NIGHT","CUT TO:","FADE OUT.",".New scene","# Section","= Synopsis","@MARLA","> Centered","~lyrics","!Action"];
  for(const replacement of invalid)expect(()=>compileLivingScriptPatch(source,{...asked,replacement})).toThrow();
  for(const replacement of ["NO!","...and come inside.","A \"quoted\" word, café 🌿.","Wait (quietly), then enter.","A\tword."]){const patch=compileLivingScriptPatch(source,{...asked,replacement});expect(parseFountain(patch.after.text).scenes[0]!.dialogue[0]!.lines).toEqual([replacement]);}
});

test("project locks are exact physical lines and parser-protected bytes cannot be supplied as entries",()=>{
  const source=film(simple),asked=request(source),count=simple.split("\n").length;
  expect(()=>compileLivingScriptPatch(source,{...asked,protectedLines:[6]})).toThrow("protected");expect(compileLivingScriptPatch(source,{...asked,protectedLines:[5,1]}).protectedLines).toEqual([1,5]);
  const sparse:number[]=[];sparse.length=2;
  for(const protectedLines of [null,[0],[count+1],[1,1],[1.5],["1"],sparse,[undefined]])expect(()=>compileLivingScriptPatch(source,{...asked,protectedLines} as LivingScriptPatchRequest)).toThrow();
  const guarded=film("INT. ROOM - DAY\n\nMARLA\nAgain.\n[[Again.]]\nAgain."),index=compileEditScriptSource(guarded);expect(index.entries.filter(entry=>entry.kind==="dialogue").map(entry=>entry.startLine)).toEqual([4,6]);
  const patch=compileLivingScriptPatch(guarded,request(guarded,6));expect(patch.after.text).toContain("Again.\n[[Again.]]\nCome inside.");
});

test("resealing cannot alter original bytes, impact identities, offsets or future retained entry identity",()=>{
  const source=film(simple),patch=compileLivingScriptPatch(source,request(source)),edits:((value:LivingScriptPatch)=>void)[]=[value=>{value.sourceId="another";},value=>{value.sourceRevision=hash;},value=>{value.receiptRevision=hash;},value=>{value.sourceFilm.jobId="another";},value=>{value.before.text+=" ";},value=>{value.before.sha256=hash;},value=>{value.after.text+=" ";},value=>{value.after.version++;},value=>{value.after.scriptRevision=hash;},value=>{value.line.beforeStart++;},value=>{value.line.afterRaw="other";},value=>{value.mapping.beatId="beat-1-99";},value=>{value.mapping.sceneDialogueLineIndex++;},value=>{value.mapping.afterLineId=hash;},value=>{value.mapping.newRetainedEntryId=hash as never;},value=>{value.affectedShotIds=[];},value=>{value.affectedSceneIndexes=[];},value=>{value.shotCoverageComplete=false;},value=>{value.warnings.push("invented");}];
  for(const edit of edits){const changed=structuredClone(patch);edit(changed);expect(()=>validateLivingScriptPatch(source,reseal(changed))).toThrow();}
  expect(()=>validateLivingScriptPatch(source,reseal({...patch,unsupported:true}))).toThrow();
  const corrupt=structuredClone(source);corrupt.facts.frames++;expect(()=>compileLivingScriptPatch(reseal(corrupt),request(source))).toThrow();
});

test("portable metadata validation rejects accessors and serialization tricks before invoking them",()=>{
  const source=film(simple),asked=request(source);let calls=0;
  const getter=Object.defineProperty({...asked},"replacement",{get(){calls++;return "Come inside.";},enumerable:true});expect(()=>compileLivingScriptPatch(source,getter)).toThrow();expect(calls).toBe(0);
  const inputGetter=Object.defineProperty({...source},"job",{get(){calls++;return source.job;},enumerable:true});expect(()=>compileLivingScriptPatch(inputGetter,asked)).toThrow();expect(calls).toBe(0);
  const cycle:any={...asked};cycle.self=cycle;
  const symbol={...asked,[Symbol("hidden")]:1},hidden=Object.defineProperty({...asked},"hidden",{value:1}),prototype=Object.assign(Object.create({inherited:true}),asked);
  for(const input of [cycle,symbol,hidden,prototype,{...asked,toJSON(){calls++;return asked;}},{...asked,replacement:undefined},{...asked,extra:true},null,[],{...asked,currentScript:{...asked.currentScript,extra:true}}])expect(()=>compileLivingScriptPatch(source,input as LivingScriptPatchRequest)).toThrow();
  for(const version of [NaN,Infinity,-0,1.5,0,Number.MAX_SAFE_INTEGER])expect(()=>compileLivingScriptPatch(source,{...asked,currentScript:{...asked.currentScript,version}})).toThrow();expect(calls).toBe(0);
});

test("capacity errors reject complete proposals rather than truncating script or replacement",()=>{
  const source=film(simple),asked=request(source);
  expect(()=>compileLivingScriptPatch(source,{...asked,replacement:"x".repeat(LIVING_SCRIPT_PATCH_LIMITS.replacementCharacters+1)})).toThrow();
  expect(()=>compileLivingScriptPatch(source,{...asked,currentScript:{...asked.currentScript,text:"x".repeat(LIVING_SCRIPT_PATCH_LIMITS.scriptCharacters+1)}})).toThrow();
  expect(()=>compileLivingScriptPatch(source,{...asked,replacement:"x".repeat(LIVING_SCRIPT_PATCH_LIMITS.requestBytes)})).toThrow("metadata capacity");
  const text="Title: "+"x".repeat(LIVING_SCRIPT_PATCH_LIMITS.scriptCharacters-simple.length-9)+"\n\n"+simple,large=film(text),largeAsked=request(large);expect(text.length).toBe(LIVING_SCRIPT_PATCH_LIMITS.scriptCharacters);expect(()=>compileLivingScriptPatch(large,largeAsked)).toThrow("character capacity");
  const maximal="x".repeat(LIVING_SCRIPT_PATCH_LIMITS.replacementCharacters),patch=compileLivingScriptPatch(source,{...asked,replacement:maximal});expect(patch.replacement.length).toBe(LIVING_SCRIPT_PATCH_LIMITS.replacementCharacters);expect(patch.after.text.endsWith(maximal)).toBe(true);
});

test("retained pronunciation changes remain separate from the original physical screenplay",()=>{
  const character=characterRecord({name:"MARLA",kind:"original-fictional",aliases:[],wardrobe:[],permission:{status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attested:true},voice:{pronunciations:[{word:"Again",say:"Once more"}]}},crypto.randomUUID(),time),casting=castingSnapshot("script-project",1,[character],time),source=film(simple,{casting}),index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  expect(entry.text).toBe("Again.");expect(entry.performedText).toBe("Once more.");
  const patch=compileLivingScriptPatch(source,request(source));expect(patch.line.beforeRaw).toBe("Again.");expect(patch.before.text).not.toContain("Once more.");expect(patch.after.text).toBe(simple.replace("Again.","Come inside."));expect(patch.warnings.join(" ")).toContain("performed or localized text remains historical");expect(source.job.output!.shotRenders![0]!.clip.speech!.lines[0]!.spokenText).toBe("Once more.");
  expect(()=>compileLivingScriptPatch(source,{...request(source),currentScript:{version:1,text:simple.replace("Again.",entry.performedText!)}})).toThrow("stale version or branch");
});

test("a retained graphic cannot borrow the current project screenplay to invent a patch anchor",()=>{
  const {revision:_default,...defaults}=defaultMotionGraphic("lower-third",320,180),plan=motionGraphic({...defaults,frames:6,enterFrames:1,exitFrames:1}),original=film(simple).job;
  const {providerPlan:_provider,output:_output,...rest}=original,specData={schema:"hv-owned-graphic/1" as const,projectId:original.projectId,id:crypto.randomUUID(),label:"A graphic",plan,createdAt:new Date(time).toISOString()},spec={...specData,revision:contentHash(specData)},graphicRender=graphicJobPlan(spec,"local",hash,time+1000),compiled=compileGraphic(plan);
  const reportData:Omit<GraphicRenderReceipt,"revision">={schema:"hv-graphic-render/1",plan,recipe:GRAPHIC_RECIPE,runtime:{browser:"HeadlessChrome/"+GRAPHIC_CHROME_VERSION,browserSha256:hash,ffmpegSha256:hash,platform:"linux/x64",enginePackageSha256:graphicHash(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json"))))},composition:{file:"index.html",sha256:compiled.htmlSha256},fonts:compiled.fonts.map(({data:_data,...font})=>font),license:{file:"INTER-LICENSE.txt",sha256:graphicHash(compiled.license)},frameIndex:{file:"rgba-frames.txt",sha256:hash},layout:{contentHeight:10,availableHeight:plan.height-2*plan.margin,overflow:false,fontsReady:true,creditPixelsPerSecond:null},frames:Array.from({length:plan.frames},(_,index)=>({file:`frames/${String(index).padStart(6,"0")}.png`,sha256:hash,rgbaSha256:hash,transparentPixels:plan.width*plan.height,visiblePixels:0})),master:{file:"graphic.mkv",sha256:hash,bytes:100}};
  const report={...reportData,revision:contentHash(reportData)},prefix=original.projectId+"/"+original.id+"/graphic-test/",outputData={schema:"hv-graphic-output/1" as const,planRevision:graphicRender.revision,report,masterPath:prefix+"graphic.mkv",manifestPath:prefix+"graphic.json",files:graphicInventory(report).map(entry=>({path:prefix+entry.file,sha256:entry.sha256??hash,bytes:entry.bytes??100}))};
  const job:Job={...rest,stage:"motion-graphic",scriptText:"",scriptVersion:0,totalFrames:plan.frames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},graphicRender,graphicOutput:{...outputData,revision:contentHash(outputData)}},source=receipt(job,plan.frames),index=compileEditScriptSource(source);
  expect(index.scriptText).toBeNull();expect(index.entries).toEqual([]);expect(()=>compileLivingScriptPatch(source,{entryId:hash,indexRevision:index.revision,currentScript:{version:1,text:simple},replacement:"Come inside."})).toThrow("no original screenplay dialogue");
});
