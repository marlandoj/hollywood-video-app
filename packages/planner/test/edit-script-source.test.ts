import {afterAll,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {compileEditScriptSource} from "../src/edit-script-source";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {renderRecord,renderInputHash,renderShots,type RenderFile} from "../src/shot-reuse";
import {compilePerformances,spokenText,type SpeechReport} from "../src/performances";
import {editFactsRevision,editSourceAudio,editSourceLanguage,editSourceKnownFiles,editSourceRequiredPaths,editSourceVoiceWindows,validateEditSourceReceipt,type EditSourceReceipt} from "../src/edit-sources";
import {EDIT_AUDIO_LANES,type EditSource} from "../src/edit-timeline";
import {parseEditCaptions} from "../src/edit-captions";
import {buildCaptions} from "../../assembler/src/index";
import type {Job} from "../../queue/src/index";
import {parseFountain} from "../../parser/src/index";
import {proposeSceneCut} from "../src/scene-cuts";
import {directionSnapshot,type DirectionSnapshot} from "../src/direction";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {createLipSyncFixture,completeLipSyncFixture} from "../../../test/fixtures/lipsync";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {defaultMotionGraphic,motionGraphic,GRAPHIC_RECIPE,GRAPHIC_CHROME_VERSION} from "../src/motion-graphics";
import {graphicJobPlan,graphicInventory} from "../src/graphic-jobs";
import {compileGraphic} from "../../generator/src/graphic-composition";
import {graphicHash} from "../../generator/src/graphic-fonts";
import type {GraphicRenderReceipt} from "../../generator/src/graphic-receipt";

const scratch=realpathSync(mkdtempSync(join(tmpdir(),"hv-script-source-"))),hash="a".repeat(64),time=Date.parse("2026-01-01T00:00:00.000Z");
afterAll(()=>{if(!scratch.startsWith(realpathSync(tmpdir())+sep+"hv-script-source-"))throw new Error("Unsafe script fixture cleanup.");rmSync(scratch,{recursive:true,force:true});});
const file=(path:string,bytes=100):RenderFile=>({path,bytes,sha256:hash});
/** Structurally valid, sealed retained metadata. No provider/media generation occurs in these unit fixtures. */
function film(scriptText:string,{stage="animatic",speech=true,direction,frames}:{stage?:"animatic"|"final";speech?:boolean;direction?:DirectionSnapshot;frames?:number}={}):EditSourceReceipt{
  const id=crypto.randomUUID(),projectId="script-project",job:Job={id,idempotencyKey:id,projectId,tier:"free",stage,scriptVersion:1,scriptText,status:"done",queueAction:"run",queueReason:"capacity_available",queuedBehind:[],checkpointFrame:0,checkpointShots:0,totalFrames:0,retryPolicy:{maxRetries:0,backoffMs:0},retriesUsed:0,timeoutMs:60000,costCapUsd:5,budgetReservedUsd:0,costUsd:0,rightsAttestedAt:new Date(time).toISOString(),animaticJobId:null,animaticApprovedAt:null,nextEligibleAt:null,startedAt:new Date(time+1000).toISOString(),leaseExpiresAt:null,claimedBy:null,resumedCount:0,completedAt:new Date(time+2000).toISOString(),linkExpiresAt:"2099-01-01T00:00:00.000Z",notifications:[],providerPlan:createProviderPlan(stage,5,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["legacy-mock"]',HV_PROVIDER_POOL:'["mock"]'}),...(direction?{direction}:{})};
  const shots=renderShots(job,time+1000),records=shots.map(shot=>{
    const lines=speech?compilePerformances(shot.dialogue,shot.performances):[];let cursor=0;
    const recorded=lines.map(line=>{cursor+=Math.round(line.beforeMs*22050/1000);const startSample=cursor;cursor+=7350;const endSample=cursor;cursor+=Math.round(line.afterMs*22050/1000);return {...line,startSample,endSample,spokenText:spokenText(line),pcmSha256:hash};});
    const report:SpeechReport|undefined=recorded.length?{schema:"hv-speech/1",engine:"espeak-ng",engineVersion:"espeak-"+hash,sampleRate:22050,totalSamples:cursor,lines:recorded}:undefined;
    const durationSec=Math.max(60,Math.ceil(cursor/735))/30;
    return renderRecord({projectId,jobId:id,shotId:shot.id,inputHash:renderInputHash(job,shot),origin:{jobId:id,shotId:shot.id},clip:{provider:"mock",model:"metadata-fixture",seed:shot.seed,durationSec,fingerprint:hash,audioMode:report?"provided":"silent-captioned",...(report?{speech:report}:{})},files:{video:file(`${projectId}/${id}/clips/${shot.id}.mp4`),...(report?{audio:file(`${projectId}/${id}/clips/${shot.id}.wav`,44+report.totalSamples*2)}:{})}});
  });
  job.output={mp4Path:`${projectId}/${id}/export.mp4`,captionsPath:`${projectId}/${id}/captions.vtt`,manifestPath:`${projectId}/${id}/provenance.json`,hlsPlaylistPath:`${projectId}/${id}/hls/index.m3u8`,shotRenders:records};
  const overlap=stage==="final"&&!records.some(record=>record.clip.speech)?.5:0;
  buildCaptions(shots.map((shot,index)=>({...shot,durationSec:records[index]!.clip.durationSec})),join(scratch,id+".srt"),join(scratch,id+".vtt"),overlap,records.map(record=>record.clip.speech));
  const count=frames??records.reduce((n,record)=>n+Math.round(record.clip.durationSec*30),0)-Math.round(overlap*30)*(records.length-1);
  return receipt(job,count,parseEditCaptions(readFileSync(join(scratch,id+".vtt"),"utf8"),count));
}
function receipt(job:Job,frames:number,captions:EditSource["captions"]=[]):EditSourceReceipt{
  const audio=editSourceAudio(job),facts:EditSource={id:job.id,label:"Retained test source",revision:editFactsRevision(job,frames,320,180,captions),width:320,height:180,frames,audio:EDIT_AUDIO_LANES.filter(lane=>audio[lane]),captions,...editSourceVoiceWindows(job),...(job.graphicOutput?{media:"graphic-rgba" as const}:{})};
  const files=new Map(editSourceKnownFiles(job).map(value=>[value.path,value]));for(const path of editSourceRequiredPaths(job))if(!files.has(path))files.set(path,file(path));
  const data={schema:job.graphicOutput?"hv-edit-source/2" as const:"hv-edit-source/1" as const,job,facts,audio,files:[...files.values()],language:editSourceLanguage(job)};return validateEditSourceReceipt({...data,revision:contentHash(data)});
}

test("script source keeps exact physical lines and repeated spoken identities, including protected comments and parenthetical cues",()=>{
  const text="Title: Source fixture\r\n\r\n.INT. GARDEN - DAY\r\n\r\nA door opens.\r\n\r\nMARLA\r\n(quietly)\r\nAgain.\r\n/*\r\nAgain.\r\n*/\r\nAgain.\r\n\r\nMARLA\r\nAgain.\r\n\r\nCUT TO BLACK.\r\n\r\nEXT. PATH - NIGHT\r\n\r\nA door opens.";
  const source=film(text),before=contentHash(source),index=compileEditScriptSource(source),spoken=index.entries.filter(entry=>entry.kind==="dialogue");
  expect(spoken.map(entry=>[entry.text,entry.startLine,entry.endLine])).toEqual([["Again.",9,9],["Again.",13,13],["Again.",16,16]]);
  expect(new Set(spoken.map(entry=>entry.id)).size).toBe(3);expect(index.entries.filter(entry=>entry.kind==="scene").map(entry=>entry.startLine)).toEqual([3,20]);
  expect(spoken.map(entry=>entry.windows.find(window=>window.evidence==="measured-speech"&&!window.lanes.includes("captions"))!.startSample)).toEqual([0,25600,51200]);
  for(const entry of spoken){expect(entry.windows.some(window=>window.evidence==="shot-coverage"&&window.lanes.join(",")==="picture")).toBe(true);expect(entry.windows.some(window=>window.lanes.join(",")==="captions")).toBe(true);expect(entry.performedText).toBe("Again.");}
  expect(index.entries.find(entry=>entry.kind==="transition")!.unavailableReason).toContain("no separately timed");
  expect(index.scriptText).toBe(text);expect(index.sourceRevision).toBe(source.facts.revision);expect(index.receiptRevision).toBe(source.revision);expect(contentHash(source)).toBe(before);expect(compileEditScriptSource(source)).toEqual(index);
  const {revision,...data}=index;expect(revision).toBe(contentHash(data));
});

test("accepted coverage maps repeated source beats and local speech indices without matching text",()=>{
  const text="INT. GARDEN - DAY\n\nA door opens.\n\nMARLA\nAgain.\n\nA door opens.\n\nMARLA\nAgain.",cut=proposeSceneCut(parseFountain(text).scenes[0]!),direction=directionSnapshot("script-project",0,[],time,[cut]);
  const source=film(text,{direction}),index=compileEditScriptSource(source),spoken=index.entries.filter(entry=>entry.kind==="dialogue"),actions=index.entries.filter(entry=>entry.kind==="action");
  expect(spoken.map(entry=>entry.windows.find(window=>window.evidence==="measured-speech")!.shotId)).toEqual([cut.shots[1]!.id,cut.shots[3]!.id]);
  expect(actions.map(entry=>entry.windows[0]!.shotId)).toEqual([cut.shots[0]!.id,cut.shots[2]!.id]);
  expect(spoken.map(entry=>entry.windows.find(window=>window.evidence==="measured-speech")!.startSample)).toEqual([96000,288000]);
  expect(index.warnings).toEqual([]);
});

test("dialogue continued through a transition keeps original block offsets and accepted coverage's separate local blocks",()=>{
  const text="INT. ROOM - DAY\n\nMARLA\nFirst line.\nCUT TO:\nContinued line.",standard=compileEditScriptSource(film(text)),cut=proposeSceneCut(parseFountain(text).scenes[0]!),direction=directionSnapshot("script-project",0,[],time,[cut]),coverage=compileEditScriptSource(film(text,{direction}));
  for(const index of [standard,coverage]){const lines=index.entries.filter(entry=>entry.kind==="dialogue");expect(lines.map(entry=>[entry.text,entry.startLine,entry.endLine])).toEqual([["First line.",4,4],["Continued line.",6,6]]);expect(lines.every(entry=>entry.windows.some(window=>window.evidence==="measured-speech"&&window.lanes.includes("dialogue")))).toBe(true);expect(lines.every(entry=>entry.windows.some(window=>window.lanes.includes("captions")))).toBe(true);expect(index.entries.find(entry=>entry.kind==="transition")!.windows).toEqual([]);}
  const native=standard.entries.filter(entry=>entry.kind==="dialogue").map(entry=>entry.windows.find(window=>window.lanes.includes("dialogue"))!);expect(native.map(window=>window.startSample)).toEqual([0,25600]);expect(native[0]!.shotId).toBe(native[1]!.shotId);
  const accepted=coverage.entries.filter(entry=>entry.kind==="dialogue").map(entry=>entry.windows.find(window=>window.lanes.includes("dialogue"))!);expect(accepted.map(window=>window.startSample)).toEqual([96000,192000]);expect(accepted[0]!.shotId).not.toBe(accepted[1]!.shotId);
});

test("multiple caption cues for repeated long lines retain their ordered measured line identity",()=>{
  const repeated="Please keep the garden gate closed while the wind moves through the trees and the neighbours wait beside the path.",source=film("INT. GARDEN - DAY\n\nA gate closes.\n\nMARLA\n"+repeated+"\n"+repeated),index=compileEditScriptSource(source),lines=index.entries.filter(entry=>entry.kind==="dialogue");
  expect(lines).toHaveLength(2);expect(lines[0]!.id).not.toBe(lines[1]!.id);for(const entry of lines){const measured=entry.windows.find(window=>window.lanes.includes("dialogue"))!,captions=entry.windows.filter(window=>window.lanes.includes("captions"));expect(captions.length).toBeGreaterThan(1);expect(captions.every(window=>window.startSample>=measured.startSample-24&&window.endSample<=measured.endSample+24)).toBe(true);}expect(index.warnings).toEqual([]);
});

test("final assembly coverage uses retained overlapping shot clocks and refuses unexplained durations",()=>{
  const script="INT. ROOM - DAY\n\nA lamp glows.\n\nEXT. PATH - DAY\n\nLeaves turn.",source=film(script,{stage:"final",speech:false}),index=compileEditScriptSource(source),actions=index.entries.filter(entry=>entry.kind==="action");
  expect(source.facts.frames).toBe(105);expect(actions.map(entry=>entry.windows.map(window=>[window.startSample,window.endSample]))).toEqual([[[0,96000]],[[72000,168000]]]);
  const altered=structuredClone(source);altered.facts.frames=104;altered.facts.revision=editFactsRevision(altered.job,104,320,180,altered.facts.captions);const {revision:_revision,...data}=altered;altered.revision=contentHash(data);
  const unknown=compileEditScriptSource(altered);expect(unknown.entries.every(entry=>entry.windows.length===0&&entry.unavailableReason)).toBe(true);expect(unknown.warnings.join(" ")).toContain("assembly duration");
});

test("unmeasured dialogue and changed ordered caption evidence remain explicitly unbound",()=>{
  const text="INT. ROOM - DAY\n\nA lamp glows.\n\nMARLA\nAgain.",silent=compileEditScriptSource(film(text,{speech:false})),entry=silent.entries.find(entry=>entry.kind==="dialogue")!;
  expect(entry.windows.every(window=>window.evidence==="shot-coverage")).toBe(true);expect(entry.unavailableReason).toContain("No measured speech");expect(silent.warnings.join(" ")).toContain("without an individual measured line");
  const original=film(text),changed=structuredClone(original);changed.facts.captions[0]!.text="Changed caption";changed.facts.revision=editFactsRevision(changed.job,changed.facts.frames,320,180,changed.facts.captions);const {revision:_revision,...data}=changed;changed.revision=contentHash(data);
  const index=compileEditScriptSource(changed);expect(index.entries.every(value=>value.windows.every(window=>!window.lanes.includes("captions")))).toBe(true);expect(index.warnings.join(" ")).toContain("do not match");
  const forged=structuredClone(original);forged.job.scriptText+="\nChanged action.";expect(()=>compileEditScriptSource(forged)).toThrow();
});

test("real local translated dialogue and sound copies preserve original text while binding performed text and ordered captions",async()=>{
  const directory=join(scratch,"translated");mkdirSync(directory);const f=await dubStudio(directory);
  try{
    const original=compileEditScriptSource(await inspectEditSource(f.film,"Original screenplay",f.paths.artifactRoot,async()=>{})),quote=await f.quote();
    const response=await f.call(f.base+"/dialogue/"+f.film.id,"POST",f.requestBody(quote),f.owner.token);expect(response.status).toBe(202);const dub=(await f.worker())!;expect(dub.failureReason??dub.cancelReason).toBeUndefined();expect(dub.status).toBe("done");
    const translated=compileEditScriptSource(await inspectEditSource(dub,"Spanish performance",f.paths.artifactRoot,async()=>{}));expect(translated.language).toBe("es");expect(translated.scriptText).toBe(original.scriptText);expect(translated.scriptRevision).toBe(original.scriptRevision);
    const lines=translated.entries.filter(entry=>entry.kind==="dialogue");expect(lines.map(entry=>entry.text)).toEqual(["Welcome to the garden.","Come inside, friend."]);expect(lines.map(entry=>entry.performedText)).toEqual(["Bienvenida al jardín.","Entra, amigo."]);
    for(const entry of lines){expect(entry.windows.some(window=>window.lanes.includes("dialogue"))).toBe(true);expect(entry.windows.some(window=>window.lanes.includes("captions"))).toBe(true);expect(entry.unavailableReason).toBeUndefined();}
    const path=f.base+"/sound-mixes/"+dub.id,q=await(await f.call(path,"GET",undefined,f.owner.token)).json() as any;
    const mixedRequest=await f.call(path,"POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:q.sourceRevision,engineVersion:q.engineVersion,session:{reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[]}},f.owner.token);expect(mixedRequest.status).toBe(202);const mixed=(await f.worker())!;expect(mixed.failureReason??mixed.cancelReason).toBeUndefined();expect(mixed.status).toBe("done");
    const sound=compileEditScriptSource(await inspectEditSource(mixed,"Retained sound version",f.paths.artifactRoot,async()=>{}));expect(sound.language).toBe("es");expect(sound.scriptRevision).toBe(original.scriptRevision);expect(sound.entries.filter(entry=>entry.kind==="dialogue").map(({id:_id,...entry})=>entry)).toEqual(lines.map(({id:_id,...entry})=>entry));expect(sound.revision).not.toBe(translated.revision);expect(sound.entries[0]!.id).not.toBe(translated.entries[0]!.id);expect(f.ledger.monthSpend()).toBe(0);
  }finally{await f.close(false);}
},120000);

test("accepted local lip-sync retains narration and original dialogue identities through copied caption and measured sample evidence",async()=>{
  const directory=join(scratch,"lipsync");mkdirSync(directory);const configured={HV_TOKEN_SECRET:"script-source-local-fixture-secret-at-least-thirty-two",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'},previous=Object.fromEntries(Object.keys(configured).map(key=>[key,process.env[key]]));Object.assign(process.env,configured);
  try{
    const f=await createLipSyncFixture(directory,true),result=await completeLipSyncFixture(f);f.store.reviewLipSync(result.done.id,{mouthSync:4,faceStability:4,expression:4,decision:"accept",notes:"Synthetic source-index fixture only."},0,contentHash(result.done.output));const job=f.store.get(result.done.id)!;
    const source=await inspectEditSource(job,"Accepted local picture performance",f.artifacts,async()=>{}),index=compileEditScriptSource(source),narration=index.entries.find(entry=>entry.kind==="narration")!;
    expect(index.scriptText).toBe(f.film.scriptText);expect(index.entries.filter(entry=>entry.kind==="dialogue").map(entry=>entry.text)).toEqual(["Hello.","Welcome to our garden."]);
    expect(narration.text).toBe("Another voice guides the story.");expect(narration.startLine).toBeNull();expect(narration.endLine).toBeNull();expect(narration.windows.some(window=>window.lanes.join(",")==="picture,mix,narration")).toBe(true);expect(narration.windows.some(window=>window.lanes.join(",")==="captions")).toBe(true);expect(narration.windows.every(window=>window.evidence==="measured-speech")).toBe(true);
    const measured=index.entries.filter(entry=>entry.kind==="dialogue").flatMap(entry=>entry.windows.filter(window=>window.lanes.includes("dialogue")));expect(measured).toHaveLength(2);expect(measured.every(window=>window.endSample<=source.facts.frames*1600)).toBe(true);expect(index.warnings).toEqual([]);
  }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},120000);

test("graphics produce a sealed explicit no-script index without borrowing project screenplay",()=>{
  const {revision:_default,...defaults}=defaultMotionGraphic("lower-third",320,180),plan=motionGraphic({...defaults,frames:6,enterFrames:1,exitFrames:1}),original=film("INT. GARDEN - DAY\n\nA door opens.").job;
  const {providerPlan:_provider,output:_output,...rest}=original,specData={schema:"hv-owned-graphic/1" as const,projectId:original.projectId,id:crypto.randomUUID(),label:"A graphic",plan,createdAt:new Date(time).toISOString()},spec={...specData,revision:contentHash(specData)},graphicRender=graphicJobPlan(spec,"local",hash,time+1000),compiled=compileGraphic(plan);
  const reportData:Omit<GraphicRenderReceipt,"revision">={schema:"hv-graphic-render/1",plan,recipe:GRAPHIC_RECIPE,runtime:{browser:"HeadlessChrome/"+GRAPHIC_CHROME_VERSION,browserSha256:hash,ffmpegSha256:hash,platform:"linux/x64",enginePackageSha256:graphicHash(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json"))))},composition:{file:"index.html",sha256:compiled.htmlSha256},fonts:compiled.fonts.map(({data:_data,...font})=>font),license:{file:"INTER-LICENSE.txt",sha256:graphicHash(compiled.license)},frameIndex:{file:"rgba-frames.txt",sha256:hash},layout:{contentHeight:10,availableHeight:plan.height-2*plan.margin,overflow:false,fontsReady:true,creditPixelsPerSecond:null},frames:Array.from({length:plan.frames},(_,index)=>({file:`frames/${String(index).padStart(6,"0")}.png`,sha256:hash,rgbaSha256:hash,transparentPixels:plan.width*plan.height,visiblePixels:0})),master:{file:"graphic.mkv",sha256:hash,bytes:100}};
  const report={...reportData,revision:contentHash(reportData)},prefix=original.projectId+"/"+original.id+"/graphic-test/",outputData={schema:"hv-graphic-output/1" as const,planRevision:graphicRender.revision,report,masterPath:prefix+"graphic.mkv",manifestPath:prefix+"graphic.json",files:graphicInventory(report).map(entry=>({path:prefix+entry.file,sha256:entry.sha256??hash,bytes:entry.bytes??100}))};
  const job:Job={...rest,stage:"motion-graphic",scriptText:"",scriptVersion:0,totalFrames:plan.frames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},graphicRender,graphicOutput:{...outputData,revision:contentHash(outputData)}};
  const source=receipt(job,plan.frames),index=compileEditScriptSource(source);expect(index.scriptText).toBeNull();expect(index.scriptRevision).toBeNull();expect(index.entries).toEqual([]);expect(index.warnings).toEqual(["This graphic has no screenplay source or measured speech alignment."]);expect(index.language).toBe("und");
});

test("actual final assembly overlap matches the retained decoded frame count before shot coverage is bound",async()=>{
  const directory=join(scratch,"crossed-final");mkdirSync(directory);const f=await dubStudio(directory,"INT. ROOM - DAY\n\nA lamp glows.\n\nEXT. PATH - DAY\n\nLeaves turn."),previous=process.env.HV_PROVIDER_POOL;process.env.HV_PROVIDER_POOL='["mock"]';
  try{
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:f.film.id,decision:"approved"},f.owner.token)).status).toBe(201);
    expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:f.film.id,idempotencyKey:crypto.randomUUID()},f.owner.token)).status).toBe(202);const result=(await f.worker())!;expect(result.failureReason??result.cancelReason).toBeUndefined();expect(result.status).toBe("done");
    const source=await inspectEditSource(result,"Final crossed picture",f.paths.artifactRoot,async()=>{}),index=compileEditScriptSource(source),durations=result.output!.shotRenders!.map(record=>Math.round(record.clip.durationSec*30));
    expect(source.facts.frames).toBe(durations[0]!+durations[1]!-15);expect(index.entries.filter(entry=>entry.kind==="action").map(entry=>entry.windows[0]!.startSample)).toEqual([0,(durations[0]!-15)*1600]);expect(index.warnings).toEqual([]);
  }finally{if(previous===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=previous;await f.close(false);}
},60000);

test("oversized navigation refuses the complete source instead of silently truncating screenplay text",()=>{
  const source=film("Title: "+"x".repeat(8*1024**2)+"\n\nINT. ROOM - DAY\n\nA lamp glows.");
  expect(()=>compileEditScriptSource(source)).toThrow("response size limit");
});
