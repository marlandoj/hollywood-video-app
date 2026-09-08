import {expect,test} from "bun:test";
import {existsSync,readFileSync,realpathSync,renameSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../src/capabilities";
import {inspectEditSource,prepareEditSources,verifyPreparedEditSources,validatePreparedEditSources,withEditSourceAccess} from "../src/edit-source-media";
import {soundDigest} from "../src/sound-media";
import {soundWavHeader} from "../src/sound-audio";
import {conformEdit} from "../src/edit-conform";
import {assertEditOriginalPermission,assertEditSourceAvailable,assertEditSourcePermission,editFactsRevision,validateEditSourceReceipt} from "../../planner/src/edit-sources";
import {initialEditTimeline} from "../../planner/src/edit-timeline";
import type {DialogueArtifactReader} from "../src/dialogue-replacement";
import {ProjectService} from "../../api/src/index";
import {editHistoryState} from "../../planner/src/edit-history";
import {validateEditLibrary} from "../../planner/src/edit-library";
import {snapshotUsesComposite,validateSnapshot,writeStateSnapshot,readStateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
test("editorial admission derives retained film facts and rejects changed receipts, permission, provenance and streamed media",async()=>{
  const f=await dubStudio();try{
    const root=f.paths.artifactRoot,access=async()=>{if(!f.projects.peekProject(f.owner.projectId)?.rightsAttestedAt)throw new Error("rights withdrawn");};
    const receipt=await inspectEditSource(f.film,"Original film",root,access);expect(receipt.facts.voices).toHaveLength(2);expect(receipt.facts.unmeasuredAudio).toBe(false);expect(receipt.facts.audio).toEqual(["mix","dialogue"]);expect(receipt.language).toBe("en");
    const portable=JSON.parse(JSON.stringify(receipt)),warm=validateEditSourceReceipt(portable);warm.facts.frames=1;expect(validateEditSourceReceipt(portable)).toEqual(receipt);const altered=structuredClone(portable);altered.facts.voices[0].end++;expect(()=>validateEditSourceReceipt(altered)).toThrow();
    for(const target of ["root","facts"]){const hidden=structuredClone(portable);(target==="root"?hidden:hidden.facts).unsupported=undefined;expect(()=>validateEditSourceReceipt(hidden)).toThrow();}
    const disguised={...portable,toJSON:()=>portable};expect(()=>validateEditSourceReceipt(disguised)).toThrow();const nonfinite=structuredClone(portable);nonfinite.facts.frames=NaN;expect(()=>validateEditSourceReceipt(nonfinite)).toThrow();expect(validateEditSourceReceipt(portable)).toEqual(receipt);
    expect(()=>assertEditSourceAvailable(receipt,f.film)).not.toThrow();expect(()=>assertEditSourcePermission(receipt,f.projects.peekProject(f.owner.projectId))).not.toThrow();
    expect(()=>assertEditSourceAvailable(receipt,undefined)).toThrow("changed or expired");expect(()=>assertEditSourceAvailable(receipt,{...f.film,output:undefined})).toThrow("changed or expired");expect(()=>assertEditSourceAvailable(receipt,f.film,Date.parse(f.film.linkExpiresAt!))).toThrow("changed or expired");
    expect(()=>assertEditSourcePermission(receipt,{...f.projects.peekProject(f.owner.projectId)!,rightsAttestedAt:null})).toThrow("permission");
    const prepared=await prepareEditSources([receipt],root,join(root,"prepared-film"),access),s=prepared.sources[0]!,wav=readFileSync(join(root,s.media.audio.dialogue!.path));
    expect(wav.length).toBe(44+receipt.facts.frames*1600*6);expect(wav.subarray(0,44).equals(soundWavHeader(receipt.facts.frames*1600))).toBe(true);expect(wav.subarray(44).some(b=>b!==0)).toBe(true);
    expect(s.conversions.find(c=>c.lane==="dialogue")).toMatchObject({kind:"film-dialogue",padSamples:0,discardSamples:0});expect(s.copies.map(c=>c.original)).toEqual(receipt.files);
    const originalDirectory=realpathSync(join(root,f.film.projectId,f.film.id));if(!originalDirectory.startsWith(realpathSync(root)+sep))throw new Error("Unsafe recovery test source move");renameSync(originalDirectory,originalDirectory+"-hidden");
    try{await verifyPreparedEditSources(prepared,root,join(root,"prepared-film"),access);}finally{renameSync(originalDirectory+"-hidden",originalDirectory);}
    const forgedAudio=structuredClone(prepared),audioPath=join(root,s.media.audio.dialogue!.path),changedWav=Buffer.from(wav);changedWav[200]^=1;writeFileSync(audioPath,changedWav);const audioSha=(await soundDigest(audioPath)).sha256;forgedAudio.sources[0]!.media.audio.dialogue!.sha256=audioSha;forgedAudio.sources[0]!.conversions.find(c=>c.lane==="dialogue")!.output.sha256=audioSha;
    const {revision:_audioRevision,...audioData}=forgedAudio;forgedAudio.revision=contentHash(audioData);expect(()=>validatePreparedEditSources(forgedAudio,"prepared-film")).not.toThrow();writeFileSync(join(root,"prepared-film/sources.json"),JSON.stringify(forgedAudio));
    await expect(verifyPreparedEditSources(forgedAudio,root,join(root,"prepared-film"),access)).rejects.toThrow("do not reproduce");writeFileSync(audioPath,wav);writeFileSync(join(root,"prepared-film/sources.json"),JSON.stringify(prepared));
    const forged=structuredClone(receipt);forged.facts.width-=2;forged.facts.revision=editFactsRevision(forged.job,forged.facts.frames,forged.facts.width,forged.facts.height,forged.facts.captions);const {revision:_revision,...data}=forged;forged.revision=contentHash(data);expect(()=>validateEditSourceReceipt(forged)).not.toThrow();
    await expect(prepareEditSources([forged],root,join(root,"forged-facts"),access)).rejects.toThrow("changed since inspection");
    const info=async(path:string)=>({path,...await soundDigest(join(root,path))}),reader:DialogueArtifactReader={async response(projectId,jobId,path){expect([projectId,jobId]).toEqual([f.film.projectId,f.film.id]);const file=await info(path);return new Response(Bun.file(join(root,path)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});}};
    expect(await inspectEditSource(f.film,"Original film",root,access,undefined,reader,info)).toEqual(receipt);
    const badReader:DialogueArtifactReader={async response(...args){const r=(await reader.response(...args))!;r.headers.set("etag",'"'+"0".repeat(64)+'"');return r;}};
    await expect(inspectEditSource(f.film,"Original film",root,access,undefined,badReader,info)).rejects.toThrow("changed or disappeared");
    const path=join(root,f.film.output!.manifestPath),bytes=readFileSync(path),manifest=JSON.parse(bytes.toString());manifest.credentials.claim="Changed provenance";writeFileSync(path,JSON.stringify(manifest));
    await expect(inspectEditSource(f.film,"Original film",root,access)).rejects.toThrow("original picture provenance");writeFileSync(path,bytes);
    const abort=new AbortController();abort.abort();await expect(inspectEditSource(f.film,"Original film",root,access,abort.signal)).rejects.toThrow();
    const film=readFileSync(join(root,f.film.output!.mp4Path)),changed=Buffer.from(film);changed[100]^=1;writeFileSync(join(root,f.film.output!.mp4Path),changed);
    await expect(prepareEditSources([receipt],root,join(root,"changed-media"),access)).rejects.toThrow("checksum");writeFileSync(join(root,f.film.output!.mp4Path),film);
    expect(existsSync(join(root,"prepared-film",f.film.id,"scratch"))).toBe(false);
    const sequenceId=crypto.randomUUID(),library=f.projects.createEditSequence(f.owner.token,[receipt],sequenceId,"First assembly",receipt.job.id,640,360,0)!;expect(library.version).toBe(1);
    expect(f.projects.createEditSequence("invalid-token",[receipt],crypto.randomUUID(),"Unauthorized",receipt.job.id,640,360,1)).toBeNull();
    const secondConsole=new ProjectService(f.paths.statePath),originalRevision=library.sequences[0]!.history.revision;
    let updated=f.projects.changeEditSequence(f.owner.token,sequenceId,{kind:"edit",operation:{kind:"marker",marker:{id:"note",frame:10,label:"Keep this read"}},label:"Mark the first read"},1,originalRevision)!;
    expect(()=>secondConsole.changeEditSequence(f.owner.token,sequenceId,{kind:"rename",label:"Stale title"},1,originalRevision)).toThrow("another window");
    updated=secondConsole.changeEditSequence(f.owner.token,sequenceId,{kind:"cursor",target:0,reason:"undo",label:"Undo marker"},2,updated.sequences[0]!.history.revision)!;
    updated=f.projects.changeEditSequence(f.owner.token,sequenceId,{kind:"edit",operation:{kind:"marker",marker:{id:"alternate",frame:20,label:"Alternate point"}},label:"Try another marker"},3,updated.sequences[0]!.history.revision)!;
    updated=secondConsole.changeEditSequence(f.owner.token,sequenceId,{kind:"cursor",target:1,reason:"branch",label:"Return to first assembly"},4,updated.sequences[0]!.history.revision)!;
    expect(editHistoryState(updated.sequences[0]!.history).timeline.markers[0]!.id).toBe("note");expect(updated.sequences[0]!.history.events).toHaveLength(4);
    const state:StateSnapshot={schema:"hv-state/4",projects:new ProjectService(f.paths.statePath).snapshot(),jobs:[],ledger:{events:[],reservations:[]},reviews:[]};expect(()=>validateSnapshot({...state,schema:"hv-state/3"})).toThrow("schema 4");
    // Production snapshot directory fsync is Linux-only. Local project-file persistence is exercised above on both consoles.
    const saved=join(f.root,"edit-state");let restored:StateSnapshot;if(process.platform==="win32")restored=validateSnapshot(JSON.parse(JSON.stringify(state)));else{writeStateSnapshot(saved,state);restored=readStateSnapshot(saved);}expect(restored.projects.projects[0]!.editLibrary).toEqual(updated);
    const reloaded=ProjectService.fromState(restored.projects).peekProject(f.owner.projectId)!.editLibrary;expect(editHistoryState(reloaded.sequences[0]!.history).head).toBe(1);
    const picture=editHistoryState(updated.sequences[0]!.history).timeline.clips.find(c=>c.lane==="picture")!;
    updated=f.projects.changeEditSequence(f.owner.token,sequenceId,{kind:"edit",label:"Mask the retained original",operation:{kind:"composite",clipId:picture.id,composite:{schema:"hv-edit-composite/1",masks:[{id:"subject",label:"Subject",sourceRevision:receipt.facts.revision,kind:"rectangle",combine:"replace",invert:false,featherQ8:0,keyframes:[{sourceFrame:0,interpolation:"hold",geometry:{xQ16:0,yQ16:0,widthQ16:32768,heightQ16:65536}}]}]}}},updated.version,updated.sequences[0]!.history.revision)!;
    const maskedHistory=updated.sequences[0]!.history,maskedNode=editHistoryState(maskedHistory).head;
    const renderPath=f.base+"/editorial/sequences/"+sequenceId+"/renders",quoteResponse=await f.call(renderPath,"GET",undefined,f.owner.token);expect(quoteResponse.status).toBe(200);const quote=await quoteResponse.json() as any;
    expect(quote.review.compositingRevision).toBe(contentHash(quote.compositing));expect(quote.compositing.clips[0]).toMatchObject({clipId:picture.id,maskCount:1,keyframeCount:1});
    const request=(review:unknown)=>({idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review}),{compositingRevision:_compositing,...missingReview}=quote.review,jobCount=f.store.all().length,holds=await f.ledger.reservedUsd();
    for(const review of [{...missingReview,accepted:true},{...quote.review,accepted:true,compositingRevision:"0".repeat(64)},{...quote.review,accepted:false}]){const denied=await f.call(renderPath,"POST",request(review),f.owner.token);expect(denied.status).toBe(400);expect(await denied.text()).toContain("Review the current masks, mattes");}
    expect(f.store.all()).toHaveLength(jobCount);expect(await f.ledger.reservedUsd()).toBe(holds);
    const accepted=await f.call(renderPath,"POST",request({...quote.review,accepted:true}),f.owner.token);expect(accepted.status).toBe(202);const acceptedId=(await accepted.json() as {jobId:string}).jobId;expect(f.store.get(acceptedId)!.pictureEdit!.review.compositingRevision).toBe(quote.review.compositingRevision);
    updated=secondConsole.changeEditSequence(f.owner.token,sequenceId,{kind:"cursor",target:1,reason:"undo",label:"Keep the mask as an alternate"},updated.version,maskedHistory.revision)!;
    const maskedState:StateSnapshot={...state,schema:"hv-state/6",projects:new ProjectService(f.paths.statePath).snapshot()};expect(snapshotUsesComposite(maskedState.projects,[])).toBe(true);expect(editHistoryState(updated.sequences[0]!.history).timeline.schema).toBe("hv-edit-timeline/1");
    for(const schema of ["hv-state/4","hv-state/5"] as const)expect(()=>validateSnapshot({...maskedState,schema})).toThrow("schema 6");
    let maskRestore:StateSnapshot;if(process.platform==="win32")maskRestore=validateSnapshot(JSON.parse(JSON.stringify(maskedState)));else{const maskSaved=join(f.root,"masked-edit-state");writeStateSnapshot(maskSaved,maskedState);maskRestore=readStateSnapshot(maskSaved);}
    const restoredProjects=ProjectService.fromState(maskRestore.projects),restoredLibrary=restoredProjects.peekProject(f.owner.projectId)!.editLibrary;expect(restoredLibrary).toEqual(updated);
    const selected=restoredProjects.changeEditSequence(f.owner.token,sequenceId,{kind:"cursor",target:maskedNode,reason:"branch",label:"Restore authored mask"},restoredLibrary.version,restoredLibrary.sequences[0]!.history.revision)!;
    expect(editHistoryState(selected.sequences[0]!.history).timeline.clips.find(c=>c.id===picture.id)!.composite!.masks![0]!.sourceRevision).toBe(receipt.facts.revision);
    const lost=structuredClone(updated);lost.sources=[];const {revision:_libraryRevision,...lostData}=lost;lost.revision=contentHash(lostData);expect(()=>validateEditLibrary(lost,f.owner.projectId)).toThrow("original source receipt");
  }finally{await f.close();}
},120000);
test("editorial preparation preserves dubbed narration, dry stems, caption language and a finished sound master exactly",async()=>{
  const f=await dubStudio();try{
    const take=await f.seedNarration("Another story begins.","es","Comienza otra historia."),q=await f.quote(),read=q.narration.takes.find((a:any)=>a.jobId===take.id);
    expect((await f.call(f.base+"/dialogue/"+f.film.id,"POST",{...f.requestBody(q),narration:{language:"es",reviewed:true,cues:[{id:crypto.randomUUID(),role:"voice-over",startSample:0,gainDb:-12,duckDb:-18,attackMs:100,releaseMs:200,auditionJobId:take.id,auditionRevision:read.revision}]}},f.owner.token)).status).toBe(202);
    const dialogue=(await f.worker())!;expect(dialogue.failureReason).toBeUndefined();expect(dialogue.status).toBe("done");
    const root=f.paths.artifactRoot,access=async()=>{},receipt=await inspectEditSource(dialogue,"Spanish dialogue and narration",root,access),prepared=await prepareEditSources([receipt],root,join(root,"prepared-dialogue"),access);
    expect(receipt.language).toBe("es");expect(receipt.facts.audio).toEqual(["mix","dialogue","narration"]);expect(receipt.facts.voices.filter(v=>v.lane==="narration")).toHaveLength(1);expect(receipt.facts.captions.some(c=>c.text.includes("Comienza"))).toBe(true);expect(prepared.sources[0]!.conversions.every(c=>c.padSamples===0&&c.discardSamples===0)).toBe(true);
    validateEditSourceReceipt(JSON.parse(JSON.stringify(receipt)));const policyPath=join(f.root,"policies.json"),policies=readFileSync(policyPath);writeFileSync(policyPath,JSON.stringify({schema:"hv-audio-policies/1",policies:[]}));try{expect(()=>assertEditOriginalPermission(receipt,f.projects.peekProject(f.owner.projectId))).toThrow();}finally{writeFileSync(policyPath,policies);}expect(()=>assertEditOriginalPermission(receipt,f.projects.peekProject(f.owner.projectId))).not.toThrow();
    const path=f.base+"/sound-mixes/"+dialogue.id,quote=await(await f.call(path,"GET",undefined,f.owner.token)).json() as any;
    expect((await f.call(path,"POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:quote.sourceRevision,engineVersion:quote.engineVersion,session:{reviewed:true,dialogueGainDb:-3,narrationGainDb:0,cues:[],finishing:{schema:"hv-sound-finishing/1",mode:"measure"}}},f.owner.token)).status).toBe(202);
    const sound=(await f.worker())!;expect(sound.failureReason).toBeUndefined();expect(sound.status).toBe("done");const master=await inspectEditSource(sound,"Finished Spanish soundtrack",root,access),output=await prepareEditSources([master],root,join(root,"prepared-sound"),access),s=output.sources[0]!;
    expect(master.language).toBe("es");expect(s.media.audio.mix!.sha256).toBe(sound.output!.sound!.report.finishing!.masterSha256);expect(s.conversions.every(c=>c.kind==="copy48"&&c.output.sha256===c.inputSha256&&c.padSamples===0&&c.discardSamples===0)).toBe(true);
    const timeline=initialEditTimeline([master.facts],master.facts.id,640,360),render=await conformEdit(timeline,[s.media],root,join(root,"conformed-sound"),access);
    expect(render.audio.final).toBe(sound.output!.sound!.report.finishing!.masterSha256);expect(render.speechCuts).toEqual([]);expect(readFileSync(join(root,"conformed-sound/captions.vtt"),"utf8")).toContain("Comienza");
    expect(()=>assertEditSourcePermission(master,f.projects.peekProject(f.owner.projectId))).not.toThrow();
  }finally{await f.close();}
},180000);

test("crossfaded films retain their assembled duration without inventing an isolated dialogue lane",async()=>{
  const f=await dubStudio(undefined,"INT. GARDEN - DAY\n\nLeaves turn.\n\nEXT. GATE - NIGHT\n\nThe gate closes."),oldPool=process.env.HV_PROVIDER_POOL;try{
    expect((await inspectEditSource(f.film,"Silent preview",f.paths.artifactRoot,async()=>{})).facts.audio).toEqual(["mix"]);
    process.env.HV_PROVIDER_POOL='["mock"]';expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:f.film.id,decision:"approved"},f.owner.token)).status).toBe(201);
    expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:f.film.id,idempotencyKey:"silent-final"},f.owner.token)).status).toBe(202);const film=(await f.worker())!;expect(film.failureReason).toBeUndefined();expect(film.status).toBe("done");
    const root=f.paths.artifactRoot,receipt=await inspectEditSource(film,"Silent crossed shots",root,async()=>{});
    expect(receipt.facts.voices).toEqual([]);expect(receipt.facts.unmeasuredAudio).toBe(true);expect(receipt.facts.audio).toEqual(["mix"]);
    const concatenated=film.output!.shotRenders!.reduce((sum,s)=>sum+Math.round(s.clip.durationSec*30),0);expect(receipt.facts.frames).toBeLessThan(concatenated);
    const prepared=await prepareEditSources([receipt],root,join(root,"prepared-silent"),async()=>{});expect(prepared.sources[0]!.conversions).toHaveLength(1);expect(readFileSync(join(root,prepared.sources[0]!.media.audio.mix!.path)).length).toBe(44+receipt.facts.frames*1600*6);
  }finally{if(oldPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=oldPool;await f.close();}
},60000);

test("source validation observes permission withdrawal during a retained-media verifier and drains it before returning",async()=>{
  let calls=0,observed=false;
  await expect(withEditSourceAccess(async()=>{if(++calls===2)throw new Error("permission withdrawn during copy");},undefined,signal=>new Promise<void>((resolve,reject)=>{signal.addEventListener("abort",()=>{observed=true;reject(signal.reason);},{once:true});}))).rejects.toThrow("permission withdrawn during copy");
  expect(observed).toBe(true);expect(calls).toBe(2);
},10000);
