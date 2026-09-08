import {beforeAll,afterAll,expect,spyOn,test} from "bun:test";
import * as fs from "node:fs";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {ProjectService,type PersistedState} from "../src/index";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {currentCasting,castingSnapshot} from "../../planner/src/casting";
import {currentDirection,directionSnapshot,type DirectionEntry,type DirectionSnapshot} from "../../planner/src/direction";
import {outputRevision} from "../../planner/src/dialogue-selection";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {deriveEditAssemblyParent,type EditAssemblyCarrier} from "../../planner/src/edit-assembly-parent";
import {editHistoryReplay} from "../../planner/src/edit-history";
import {editCaptionCues} from "../../planner/src/edit-timeline";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {compileLivingScriptSourceMap} from "../../planner/src/living-script-source-map";
import {compileLivingScriptRecut,type LivingScriptRecutInput} from "../../planner/src/living-script-recut";
import type {LivingScriptProposal} from "../../planner/src/living-script-proposals";
import type {LivingScriptAcceptanceRequest} from "../../planner/src/living-script-acceptance";
import {emptyLivingScriptAcceptances} from "../../planner/src/living-script-acceptance-library";

let fixture:Awaited<ReturnType<typeof dubStudio>>,original:PersistedState,baseline:PersistedState,proposal:LivingScriptProposal,request:LivingScriptAcceptanceRequest,acceptedTime:number;
let retained:EditAssemblyCarrier[],originalMp4:string,originalCaptions:string;
const digest=(path:string)=>createHash("sha256").update(fs.readFileSync(path)).digest("hex");
beforeAll(async()=>{
  fixture=await dubStudio();await pinDuration();
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const film=(await fixture.worker())!;expect(film.failureReason??film.cancelReason).toBeUndefined();expect(film.status).toBe("done");
  const before=await inspectEditSource(film,"Retained original screenplay",fixture.paths.artifactRoot,async()=>{}),oldBinding=bindOriginalEditSource(before),now=Date.now();
  const library=fixture.projects.createEditSequence(fixture.owner.token,[before],"parent","Original saved cut",before.facts.id,320,180,0,now,[oldBinding])!;
  fixture.projects.createEditSequence(fixture.owner.token,[before],"other-cut","Independent other cut",before.facts.id,320,180,library.version,now,[oldBinding]);
  expect(fixture.projects.selectDialogueVersion(fixture.owner.token,film,film.id,0,outputRevision(film),now)).not.toBeNull();
  // Capture the real pre-PUT state. Only the separate media factory below commits the proposed
  // text early; every acceptance service under test starts from this original snapshot.
  original=structuredClone(fixture.projects.snapshot());
  const index=compileEditScriptSource(before),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(before,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:film.scriptVersion,text:film.scriptText},replacement:"Welcome back to the garden.",protectedLines:[1]});
  expect((await fixture.call(fixture.base+"/script","PUT",{text:patch.after.text},fixture.owner.token)).status).toBe(200);
  const direction=await pinDuration(),impact=compileLivingScriptGenerationImpact(before,patch,{...film,scriptVersion:patch.after.version,scriptText:patch.after.text,direction});
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},fixture.owner.token)).status).toBe(202);
  const generatedFilm=(await fixture.worker())!;expect(generatedFilm.failureReason??generatedFilm.cancelReason).toBeUndefined();expect(generatedFilm.status).toBe("done");
  const generated=await inspectEditSource(generatedFilm,"Reviewed generated dialogue",fixture.paths.artifactRoot,async()=>{}),sourceMap=compileLivingScriptSourceMap(before,patch,impact,generated),at=Date.parse(generatedFilm.completedAt!);
  retained=[{binding:oldBinding,current:film},{binding:bindOriginalEditSource(generated),current:generatedFilm}];
  const detached=ProjectService.fromState(original),current=detached.peekProject(fixture.owner.projectId)!,parent=deriveEditAssemblyParent(current.id,current.editLibrary,"parent"),navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]);
  const settings={casting:currentCasting(current.id,current.castingHistory),direction:currentDirection(current.id,current.directionHistory)};
  proposal=detached.createLivingScriptProposal(fixture.owner.token,{id:"review-line",label:"Review garden welcome",sequenceId:"parent",historyRevision:parent.historyRevision,editorialRevision:current.editLibrary.revision,navigationRevision:navigation.revision,patch,baseline:settings,candidate:impact.candidateInputs},0,[retained[0]!],at)!.proposal;
  baseline=detached.snapshot();
  const recutInput:LivingScriptRecutInput={projectId:current.id,library:current.editLibrary,sequenceId:"parent",historyRevision:parent.historyRevision,patch,candidate:impact.candidateInputs,navigationRevision:navigation.revision,generated,sourceMap,operations:[{kind:"replace",clipId:"initial-0",linked:true,sourceId:generated.facts.id,from:0,frames:generated.facts.frames,timing:"preserve",ripple:false}],newSequenceId:"revised-cut"};
  const recut=compileLivingScriptRecut(recutInput,at+1);acceptedTime=at+2;
  request={id:"accept-line",name:"Revised welcome and independent cut",reviewRevision:recut.revision,baseline:settings,recutInput,recut};
  originalMp4=digest(join(fixture.paths.artifactRoot,film.output!.mp4Path));originalCaptions=fs.readFileSync(join(fixture.paths.artifactRoot,film.output!.captionsPath),"utf8");
},180000);
afterAll(async()=>{await fixture?.close();});

async function pinDuration():Promise<DirectionSnapshot>{
  const review=await(await fixture.call(fixture.base+"/direction","GET",undefined,fixture.owner.token)).json() as {direction:DirectionSnapshot;scriptVersion:number;plan:DirectionEntry[]},entry=review.plan.find(entry=>entry.source.id==="shot-1-1")!;
  const saved=await fixture.call(fixture.base+"/direction/shot-1-1","PUT",{settings:{durationFrames:180},expectedVersion:review.direction.version,expectedScriptVersion:review.scriptVersion,sourceHash:entry.sourceHash},fixture.owner.token);expect(saved.status).toBe(200);return (await saved.json() as {direction:DirectionSnapshot}).direction;
}
const fresh=()=>ProjectService.fromState(baseline);
const carriers=()=>structuredClone(retained);
const project=(state:PersistedState)=>state.projects.find(project=>project.id===fixture.owner.projectId)!;
function persisted(name:string){const path=join(fixture.root,name+"-projects.json");fs.writeFileSync(path,JSON.stringify(baseline));return {path,service:new ProjectService(path)};}
function accept(service:ProjectService,body=request,version=0,current=carriers(),now=acceptedTime){return service.acceptLivingScriptProposal(fixture.owner.token,proposal.request.id,proposal.revision,body,version,current,now)!;}

test("empty acceptance ledgers preserve historical snapshot shape and roundtrip hashes",()=>{
  const service=fresh(),state=service.snapshot();expect(project(state).livingScriptAcceptances).toBeUndefined();expect(service.peekProject(fixture.owner.projectId)!.livingScriptAcceptances).toEqual(emptyLivingScriptAcceptances(fixture.owner.projectId));
  expect(ProjectService.fromState(state).snapshot()).toEqual(state);expect(contentHash(ProjectService.fromState(state).snapshot())).toBe(contentHash(state));
});

test("real directed generated media adopts screenplay, cut, settings and ledger in one persisted JSON without changing original exports",()=>{
  const {path,service}=persisted("atomic-acceptance"),before=structuredClone(service.snapshot()),queue=fs.readFileSync(fixture.paths.queuePath,"utf8"),bodyHash=contentHash(request),writes:PersistedState[]=[];
  expect(project(before).versions.at(-1)!.text).toBe(request.recutInput.patch.before.text);expect(project(before).versions.some(version=>version.text===request.recutInput.patch.after.text)).toBe(false);
  const rename=fs.renameSync,spy=spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(to)===path)writes.push(JSON.parse(fs.readFileSync(from,"utf8")) as PersistedState);return rename(from,to);});
  let result:ReturnType<typeof accept>;try{result=accept(service);}finally{spy.mockRestore();}
  expect(result.replayed).toBe(false);expect(result.bundle).toBeDefined();expect(writes).toHaveLength(1);
  const adopted=project(writes[0]!),previous=project(before),bundle=result.bundle!;
  expect(adopted.versions).toEqual([...previous.versions,bundle.nextScript]);expect(adopted.editLibrary).toEqual(bundle.nextEditLibrary);expect(adopted.livingScriptAcceptances).toEqual(result.library);
  expect(adopted.castingHistory).toEqual(previous.castingHistory);expect(adopted.directionHistory).toEqual([...previous.directionHistory!,bundle.nextDirection]);
  expect(adopted.dialogueSelections).toEqual(previous.dialogueSelections);expect(adopted.animaticApprovals).toEqual(previous.animaticApprovals);expect(adopted.livingScriptProposals).toEqual(previous.livingScriptProposals);
  expect(adopted.editLibrary!.sequences.slice(0,previous.editLibrary!.sequences.length)).toEqual(previous.editLibrary!.sequences);expect(adopted.editLibrary!.sources.slice(0,previous.editLibrary!.sources.length)).toEqual(previous.editLibrary!.sources);
  expect(adopted.editLibrary!.sources.filter(source=>source.revision===request.recutInput.generated.revision)).toHaveLength(1);
  const child=adopted.editLibrary!.sequences.find(sequence=>sequence.id===request.recutInput.newSequenceId)!;
  expect(child.history).toEqual(request.recut.history);expect(editHistoryReplay(child.history).state.timeline).toEqual(request.recut.afterTimeline);
  expect(editCaptionCues(request.recut.afterTimeline).map(cue=>cue.text).join(" ")).toContain(request.recutInput.patch.replacement);expect(result.record.proposalRevision).toBe(proposal.revision);expect(result.record.request).toEqual(request);
  expect(new ProjectService(path).snapshot()).toEqual(writes[0]!);expect(service.snapshot()).toEqual(writes[0]!);expect(fs.readFileSync(fixture.paths.queuePath,"utf8")).toBe(queue);expect(contentHash(request)).toBe(bodyHash);
  const unchanged=request.recutInput.sourceMap.shots.find(shot=>shot.treatment==="unchanged")!;expect(fs.readFileSync(join(fixture.paths.artifactRoot,unchanged.before!.record.files.video.path))).toEqual(fs.readFileSync(join(fixture.paths.artifactRoot,unchanged.after!.record.files.video.path)));
  expect(digest(join(fixture.paths.artifactRoot,retained[0]!.current!.output!.mp4Path))).toBe(originalMp4);expect(fs.readFileSync(join(fixture.paths.artifactRoot,retained[0]!.current!.output!.captionsPath),"utf8")).toBe(originalCaptions);expect(fixture.ledger.monthSpend()).toBe(0);
  const committed=structuredClone(writes[0]!);result.record.request.name="Caller mutation";result.library.records.length=0;bundle.nextEditLibrary.sequences[0]!.label="Caller mutation";expect(service.snapshot()).toEqual(committed);expect(new ProjectService(path).snapshot()).toEqual(committed);
});

test("exact acceptance retry survives later saved script and cut edits without another write or changing explicit export selection",()=>{
  const {path,service}=persisted("acceptance-retry"),first=accept(service),receipt=structuredClone(first.record);
  service.editScript(fixture.owner.token,request.recutInput.patch.after.text+"\n\nThe garden rests.",acceptedTime+1);
  for(const id of ["parent","revised-cut"]){const editorial=service.peekProject(fixture.owner.projectId)!.editLibrary,sequence=editorial.sequences.find(sequence=>sequence.id===id)!;service.changeEditSequence(fixture.owner.token,id,{kind:"edit",label:"Later note",operation:{kind:"marker",marker:{id:"later-"+id,frame:0,label:"Later saved note"}}},editorial.version,sequence.history.revision,acceptedTime+2);}
  const before=service.snapshot(),bytes=fs.readFileSync(path,"utf8"),rename=fs.renameSync;let writes=0;
  const spy=spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(to)===path)writes++;return rename(from,to);});
  try{const replay=accept(service,request,0,carriers(),acceptedTime+3);expect(replay.replayed).toBe(true);expect(replay.bundle).toBeUndefined();expect(replay.record).toEqual(receipt);expect(replay.library.version).toBe(1);}finally{spy.mockRestore();}
  expect(writes).toBe(0);expect(service.snapshot()).toEqual(before);expect(fs.readFileSync(path,"utf8")).toBe(bytes);expect(new ProjectService(path).snapshot()).toEqual(before);expect(project(before).dialogueSelections).toEqual(project(baseline).dialogueSelections);
  expect(()=>accept(service,{...request,name:"Changed body on same identity"})).toThrow("different reviewed body");expect(()=>accept(service,{...request,id:"second-acceptance"},1)).toThrow("already has a different acceptance");expect(fs.readFileSync(path,"utf8")).toBe(bytes);expect(service.snapshot()).toEqual(before);
});

test("stale screenplay, full editorial library, settings baseline and ledger version reject without partial mutations",()=>{
  const version=fresh(),v=version.snapshot();expect(()=>accept(version,request,1)).toThrow("ledger changed");expect(version.snapshot()).toEqual(v);
  const script=fresh();script.editScript(fixture.owner.token,request.recutInput.patch.before.text+"\n\nAnother edit.",acceptedTime);const s=script.snapshot();expect(()=>accept(script)).toThrow("screenplay changed");expect(script.snapshot()).toEqual(s);
  const editor=fresh(),library=editor.peekProject(fixture.owner.projectId)!.editLibrary,other=library.sequences.find(sequence=>sequence.id==="other-cut")!;
  editor.changeEditSequence(fixture.owner.token,other.id,{kind:"edit",label:"Unrelated cut change",operation:{kind:"marker",marker:{id:"other-note",frame:1,label:"Other note"}}},library.version,other.history.revision,acceptedTime);const e=editor.snapshot();expect(()=>accept(editor)).toThrow("editorial library changed");expect(editor.snapshot()).toEqual(e);
  for(const kind of ["casting","direction"] as const){const state=structuredClone(baseline),p=project(state);if(kind==="casting"){const current=p.castingHistory!.at(-1)!;p.castingHistory!.push(castingSnapshot(p.id,current.version+1,current.characters,acceptedTime));}else{const current=p.directionHistory!.at(-1)!;p.directionHistory!.push(directionSnapshot(p.id,current.version+1,current.entries,acceptedTime));}const service=ProjectService.fromState(state),previous=service.snapshot();expect(()=>accept(service)).toThrow("reviewed screenplay baseline");expect(service.snapshot()).toEqual(previous);}
});

test("proposal, reviewed operations and generated-source tampering fail before any project fields change",()=>{
  const service=fresh(),before=service.snapshot(),changed=structuredClone(request);changed.recutInput.generated.facts.frames++;
  expect(()=>accept(service,changed)).toThrow();expect(service.snapshot()).toEqual(before);
  const ops=structuredClone(request);ops.recutInput.operations.push({kind:"marker",marker:{id:"unreviewed",frame:0,label:"Unreviewed operation"}});expect(()=>accept(service,ops)).toThrow();expect(service.snapshot()).toEqual(before);
  expect(()=>accept(service,{...request,reviewRevision:"a".repeat(64)})).toThrow();expect(service.snapshot()).toEqual(before);
  expect(()=>service.acceptLivingScriptProposal(fixture.owner.token,proposal.request.id,"b".repeat(64),request,0,carriers(),acceptedTime)).toThrow();expect(service.snapshot()).toEqual(before);
});

test("both first acceptance and exact retry require current original and generated carriers and current rights",()=>{
  for(const replay of [false,true]){
    const service=fresh();if(replay)accept(service);const previous=service.snapshot();
    for(const i of [0,1]){
      for(const change of ["missing","expired","cancelled","changed","foreign"] as const){const current=carriers(),item=current[i]!;
        if(change==="missing")item.current=undefined;else if(change==="expired")item.current!.linkExpiresAt=new Date(0).toISOString();else if(change==="cancelled")item.current!.status="cancelled";else if(change==="changed")item.current!.output!.mp4Path+=".changed";else item.binding.owner.projectId="foreign-project";
        expect(()=>accept(service,request,0,current)).toThrow();expect(service.snapshot()).toEqual(previous);
      }
    }
    const noRights=structuredClone(previous);project(noRights).rightsAttestedAt=null;const denied=ProjectService.fromState(noRights),deniedBefore=denied.snapshot();expect(()=>accept(denied)).toThrow();expect(denied.snapshot()).toEqual(deniedBefore);
    const revoked=ProjectService.fromState(previous),current=revoked.peekProject(fixture.owner.projectId)!;expect(revoked.revokeCharacterPermission(fixture.owner.token,fixture.id,currentCasting(current.id,current.castingHistory).version,acceptedTime+1)).not.toBeNull();const revokedBefore=revoked.snapshot();expect(()=>accept(revoked,request,0,carriers(),acceptedTime+2)).toThrow();expect(revoked.snapshot()).toEqual(revokedBefore);
  }
});

test("null review or acceptance metadata cannot be restored as an absent legacy default",()=>{
  for(const key of ["livingScriptProposals","livingScriptAcceptances"] as const){const state=structuredClone(baseline);Object.assign(project(state),{[key]:null});expect(()=>ProjectService.fromState(state)).toThrow();}
});

test("foreign and invalid owners cannot accept or replay a saved proposal",()=>{
  const service=fresh();accept(service);const other=service.createAnonymousProject(acceptedTime),before=service.snapshot();
  expect(()=>service.acceptLivingScriptProposal(other.token,proposal.request.id,proposal.revision,request,0,carriers(),acceptedTime)).toThrow();expect(service.snapshot()).toEqual(before);
  expect(service.acceptLivingScriptProposal("invalid",proposal.request.id,proposal.revision,request,0,carriers(),acceptedTime)).toBeNull();expect(service.snapshot()).toEqual(before);expect(service.peekProject(other.projectId)!.livingScriptAcceptances.version).toBe(0);
});

test("a reviewed future candidate cannot grant a new actor permission even when its actual generated film never uses that actor",async()=>{
  // Propose a new physical line against the latest actual film, so the normal reuse picker
  // selects that exact film's unchanged shot rather than a later alternative original.
  const beforeSource=retained[1]!.binding.source,factory=fixture.projects.peekProject(fixture.owner.projectId)!,cast=currentCasting(factory.id,factory.castingHistory),atStart=Date.now();
  const library=fixture.projects.createEditSequence(fixture.owner.token,[beforeSource],"future-parent","Before the next line review",beforeSource.facts.id,320,180,factory.editLibrary.version,atStart,[retained[1]!.binding])!,originalFactory=fixture.projects.snapshot();
  const index=compileEditScriptSource(beforeSource),entry=index.entries.find(entry=>entry.kind==="dialogue")!,patch=compileLivingScriptPatch(beforeSource,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:beforeSource.job.scriptVersion,text:beforeSource.job.scriptText},replacement:"Please come back to the garden."});
  expect((await fixture.call(fixture.base+"/script","PUT",{text:patch.after.text},fixture.owner.token)).status).toBe(200);
  const direction=await pinDuration(),actorId=crypto.randomUUID();
  const saved=await fixture.call(fixture.base+"/cast/"+actorId,"PUT",{expectedVersion:cast.version,character:{...CAST_INPUT,name:"Unused visitor",aliases:[]}},fixture.owner.token);expect(saved.status).toBe(200);
  const candidateCast=currentCasting(factory.id,fixture.projects.peekProject(factory.id)!.castingHistory),impact=compileLivingScriptGenerationImpact(beforeSource,patch,{...beforeSource.job,scriptVersion:patch.after.version,scriptText:patch.after.text,direction,casting:candidateCast});
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true,forceShotIds:impact.generateShotIds},fixture.owner.token)).status).toBe(202);
  const film=(await fixture.worker())!;expect(film.failureReason??film.cancelReason).toBeUndefined();expect(film.status).toBe("done");
  const generated=await inspectEditSource(film,"Actual candidate with ungranted actor",fixture.paths.artifactRoot,async()=>{}),sourceMap=compileLivingScriptSourceMap(beforeSource,patch,impact,generated),at=Date.parse(film.completedAt!);
  const service=ProjectService.fromState(originalFactory),parent=deriveEditAssemblyParent(factory.id,library,"future-parent"),navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]),settings={casting:cast,direction:currentDirection(factory.id,project(originalFactory).directionHistory)};
  const savedProposal=service.createLivingScriptProposal(fixture.owner.token,{...proposal.request,id:"future-actor-proposal",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,editorialRevision:library.revision,navigationRevision:navigation.revision,patch,baseline:settings,candidate:impact.candidateInputs},0,[retained[1]!],at)!.proposal;
  const recutInput:LivingScriptRecutInput={projectId:factory.id,library,sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,generated,sourceMap,operations:[{kind:"replace",clipId:"initial-0",linked:true,sourceId:generated.facts.id,from:0,frames:generated.facts.frames,timing:"preserve",ripple:false}],newSequenceId:"future-actor-cut"},recut=compileLivingScriptRecut(recutInput,at+1),body:LivingScriptAcceptanceRequest={...request,id:"accept-future-actor",baseline:settings,recutInput,recut,reviewRevision:recut.revision};
  const current=[retained[1]!,{binding:bindOriginalEditSource(generated),current:film}],snapshot=structuredClone(service.snapshot());
  expect(project(snapshot).castingHistory!.at(-1)!.characters.some(character=>character.id===actorId)).toBe(false);expect(candidateCast.characters.some(character=>character.id===actorId)).toBe(true);
  expect(()=>service.acceptLivingScriptProposal(fixture.owner.token,savedProposal.request.id,savedProposal.revision,body,0,current,at+2)).toThrow("new or changed character permissions");expect(service.snapshot()).toEqual(snapshot);
  expect(service.peekProject(fixture.owner.projectId)!.versions.latest()!.text).toBe(patch.before.text);expect(service.peekProject(fixture.owner.projectId)!.livingScriptAcceptances.version).toBe(0);
},120000);

test("a failed atomic disk rename leaves both persisted and live project state unchanged and the exact request retryable",()=>{
  const {path,service}=persisted("acceptance-rename-fault"),previous=structuredClone(service.snapshot()),bytes=fs.readFileSync(path,"utf8"),rename=fs.renameSync;let failures=0;
  const spy=spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(to)===path){failures++;throw new Error("Synthetic acceptance rename failure");}return rename(from,to);});
  try{expect(()=>accept(service)).toThrow("Synthetic acceptance rename failure");expect(failures).toBe(1);expect(service.snapshot()).toEqual(previous);expect(fs.readFileSync(path,"utf8")).toBe(bytes);}finally{spy.mockRestore();}
  expect(new ProjectService(path).snapshot()).toEqual(previous);const retry=accept(service);expect(retry.replayed).toBe(false);expect(retry.library.version).toBe(1);expect(new ProjectService(path).peekProject(fixture.owner.projectId)!.livingScriptAcceptances).toEqual(retry.library);
});
