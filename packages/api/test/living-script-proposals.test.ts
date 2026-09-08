import {beforeAll,afterAll,expect,test} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {ProjectService} from "../src/index";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {deriveEditAssemblyParent,type EditAssemblyCarrier} from "../../planner/src/edit-assembly-parent";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {emptyLivingScriptProposals,type LivingScriptProposalRequest} from "../../planner/src/living-script-proposals";
import {castingSnapshot,currentCasting} from "../../planner/src/casting";
import {directionSnapshot,currentDirection,directionEntry} from "../../planner/src/direction";
import {renderShots} from "../../planner/src/shot-reuse";

let fixture:Awaited<ReturnType<typeof dubStudio>>,baseline:ReturnType<ProjectService["snapshot"]>,binding:EditSourceBinding,input:LivingScriptProposalRequest,now:number;
beforeAll(async()=>{
  fixture=await dubStudio();now=Date.now();
  const source=await inspectEditSource(fixture.film,"Retained screenplay original",fixture.paths.artifactRoot,async()=>{});binding=bindOriginalEditSource(source);
  const editorial=fixture.projects.createEditSequence(fixture.owner.token,[source],"parent","Saved parent",source.facts.id,320,180,0,now,[binding])!,parent=deriveEditAssemblyParent(fixture.owner.projectId,editorial,"parent"),index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:fixture.film.scriptVersion,text:fixture.film.scriptText},replacement:"Welcome back to the garden."}),generation=compileLivingScriptGenerationImpact(source,patch,{...fixture.film,scriptVersion:patch.after.version,scriptText:patch.after.text},now);
  const navigation=projectEditScriptNavigation("parent",parent.historyRevision,parent.timeline,[index]);
  const project=fixture.projects.peekProject(fixture.owner.projectId)!;
  input={id:"line-proposal",label:"Review the garden welcome",sequenceId:"parent",historyRevision:parent.historyRevision,editorialRevision:editorial.revision,navigationRevision:navigation.revision,patch,baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)},candidate:generation.candidateInputs};baseline=fixture.projects.snapshot();
},180000);
afterAll(async()=>{await fixture?.close();});
const fresh=()=>ProjectService.fromState(structuredClone(baseline));
const carriers=():EditAssemblyCarrier[]=>[{binding:structuredClone(binding),current:fixture.store.get(binding.owner.jobId)}];
function save(service:ProjectService,request=input,version=0,current=carriers()) {return service.createLivingScriptProposal(fixture.owner.token,request,version,current,now)!;}

test("empty proposal state preserves historical snapshot shape and exact roundtrip hashes",()=>{
  const service=fresh(),snapshot=service.snapshot(),project=snapshot.projects.find(project=>project.id===fixture.owner.projectId)!;
  expect(project.livingScriptProposals).toBeUndefined();expect(service.peekProject(project.id)!.livingScriptProposals).toEqual(emptyLivingScriptProposals(project.id));
  expect(ProjectService.fromState(snapshot).snapshot()).toEqual(snapshot);expect(contentHash(ProjectService.fromState(snapshot).snapshot())).toBe(contentHash(snapshot));
});

test("real-source proposal persists and reloads without committing screenplay, editorial changes or jobs",()=>{
  const service=fixture.projects,before=service.peekProject(fixture.owner.projectId)!,editorial=structuredClone(before.editLibrary),versions=before.versions.history(),queue=readFileSync(fixture.paths.queuePath,"utf8"),requestHash=contentHash(input),result=save(service);
  expect(result.replayed).toBe(false);expect(result.library.version).toBe(1);expect(result.proposal.request).toEqual(input);expect(result.proposal.requestRevision).toBe(requestHash);
  expect(result.proposal.impact.parent.historyRevision).toBe(input.historyRevision);expect(result.proposal.impact.parent.timeline).toEqual(deriveEditAssemblyParent(fixture.owner.projectId,editorial,"parent").timeline);
  expect(service.peekProject(fixture.owner.projectId)!.editLibrary).toEqual(editorial);expect(service.peekProject(fixture.owner.projectId)!.versions.history()).toEqual(versions);
  const reloaded=new ProjectService(fixture.paths.statePath);expect(reloaded.peekProject(fixture.owner.projectId)!.livingScriptProposals).toEqual(result.library);
  expect(reloaded.snapshot().projects.find(project=>project.id===fixture.owner.projectId)!.livingScriptProposals).toEqual(result.library);
  expect(readFileSync(fixture.paths.queuePath,"utf8")).toBe(queue);expect(contentHash(input)).toBe(requestHash);expect(fixture.ledger.monthSpend()).toBe(0);
  const frozen=structuredClone(result.proposal);result.proposal.request.label="Caller mutation";result.library.proposals[0]!.impact.parent.timeline.clips[0]!.from++;
  expect(new ProjectService(fixture.paths.statePath).peekProject(fixture.owner.projectId)!.livingScriptProposals.proposals[0]).toEqual(frozen);
});

test("exact persisted retry survives later screenplay and cut changes without refreshing or rewriting the review",()=>{
  const path=join(fixture.root,"proposal-retry-projects.json");writeFileSync(path,JSON.stringify(baseline));
  const service=new ProjectService(path),oldProposal=structuredClone(save(service).proposal);
  expect(service.editScript(fixture.owner.token,input.patch.before.text+"\n\nThe gate closes.",now+1)!.version).toBe(input.patch.before.version+1);
  const parent=service.peekProject(fixture.owner.projectId)!.editLibrary;
  service.changeEditSequence(fixture.owner.token,"parent",{kind:"edit",label:"Later saved cut",operation:{kind:"marker",marker:{id:"later",frame:0,label:"Later note"}}},parent.version,input.historyRevision,now+2);
  const bytes=readFileSync(path,"utf8"),state=service.snapshot(),queue=readFileSync(fixture.paths.queuePath,"utf8"),replayed=service.createLivingScriptProposal(fixture.owner.token,input,0,carriers(),now+3)!;
  expect(replayed.replayed).toBe(true);expect(replayed.proposal).toEqual(oldProposal);expect(replayed.library.version).toBe(1);expect(service.snapshot()).toEqual(state);expect(readFileSync(path,"utf8")).toBe(bytes);expect(readFileSync(fixture.paths.queuePath,"utf8")).toBe(queue);
  expect(()=>service.createLivingScriptProposal(fixture.owner.token,{...input,label:"Different body on same key"},0,carriers(),now+4)).toThrow("different screenplay proposal");expect(readFileSync(path,"utf8")).toBe(bytes);
  expect(()=>service.createLivingScriptProposal(fixture.owner.token,{...input,id:"new-stale-request"},1,carriers(),now+4)).toThrow("editorial library changed");expect(service.snapshot()).toEqual(state);
});

test("new proposals require exact library version and current screenplay, cast and direction",()=>{
  const version=fresh(),versionBefore=version.snapshot();expect(()=>save(version,input,1)).toThrow("proposals changed");expect(version.snapshot()).toEqual(versionBefore);
  const screenplay=fresh();screenplay.editScript(fixture.owner.token,input.patch.before.text+"\n\nAn unrelated new action.",now+1);const textBefore=screenplay.snapshot();expect(()=>save(screenplay)).toThrow("current screenplay changed");expect(screenplay.snapshot()).toEqual(textBefore);
  const cast=fresh();expect(cast.saveCharacter(fixture.owner.token,fixture.id,{...CAST_INPUT,appearance:"A russet potato with larger round glasses."},fixture.film.casting!.version,now+1)).not.toBeNull();const castBefore=cast.snapshot();expect(()=>save(cast)).toThrow("current cast or direction changed");expect(cast.snapshot()).toEqual(castBefore);
  const state=structuredClone(baseline),project=state.projects.find(project=>project.id===fixture.owner.projectId)!;project.directionHistory=[...(project.directionHistory??[]),directionSnapshot(project.id,1,[],now+1)];const direction=ProjectService.fromState(state),directionBefore=direction.snapshot();expect(()=>save(direction)).toThrow("current cast or direction changed");expect(direction.snapshot()).toEqual(directionBefore);
});

test("historical replay permits later cast and direction versions but does not alter frozen candidate bindings",()=>{
  const service=fresh(),saved=save(service),state=service.snapshot(),project=state.projects.find(project=>project.id===fixture.owner.projectId)!,cast=project.castingHistory!.at(-1)!;
  project.castingHistory=[...project.castingHistory!,castingSnapshot(project.id,cast.version+1,cast.characters,now+1)];project.directionHistory=[...(project.directionHistory??[]),directionSnapshot(project.id,1,[],now+1)];
  const restored=ProjectService.fromState(state),before=restored.snapshot(),replay=save(restored);
  expect(replay.replayed).toBe(true);expect(replay.proposal).toEqual(saved.proposal);expect(replay.proposal.request.candidate).toEqual(input.candidate);expect(restored.snapshot()).toEqual(before);
  expect(()=>save(restored,{...input,id:"fresh-under-old-bindings"},1)).toThrow("current cast or direction changed");expect(restored.snapshot()).toEqual(before);
});

test("new and replayed reviews both reject unavailable, expired, changed and foreign current carriers",()=>{
  for(const replay of [false,true]){
    const service=fresh();if(replay)save(service);const previous=service.snapshot(),film=structuredClone(fixture.film),changed=structuredClone(film);changed.output!.mp4Path+=".changed";
    const invalid:EditAssemblyCarrier[][]=[[],[{binding,current:undefined}],[{binding,current:{...film,linkExpiresAt:new Date(0).toISOString()}}],[{binding,current:{...film,status:"cancelled"}}],[{binding,current:changed}],[{binding:{...binding,owner:{...binding.owner,projectId:"foreign-project"}},current:film}]];
    for(const current of invalid){expect(()=>save(service,input,0,current)).toThrow();expect(service.snapshot()).toEqual(previous);}
  }
});

test("current project rights and character revocation fence both first creation and exact replay",()=>{
  for(const replay of [false,true]){
    const service=fresh();if(replay)save(service);const state=service.snapshot(),project=state.projects.find(project=>project.id===fixture.owner.projectId)!;project.rightsAttestedAt=null;
    const noRights=ProjectService.fromState(state),before=noRights.snapshot();expect(()=>save(noRights)).toThrow();expect(noRights.snapshot()).toEqual(before);
    const revoked=fresh();if(replay)save(revoked);expect(revoked.revokeCharacterPermission(fixture.owner.token,fixture.id,fixture.film.casting!.version,now+1)).not.toBeNull();const revokedBefore=revoked.snapshot();expect(()=>save(revoked)).toThrow();expect(revoked.snapshot()).toEqual(revokedBefore);
  }
});

test("foreign and invalid owners cannot create or replay another project's proposal",()=>{
  const service=fresh();save(service);const other=service.createAnonymousProject(now),before=service.snapshot();
  expect(()=>service.createLivingScriptProposal(other.token,input,0,carriers(),now)).toThrow();expect(service.snapshot()).toEqual(before);
  expect(service.createLivingScriptProposal("invalid",input,0,carriers(),now)).toBeNull();expect(service.snapshot()).toEqual(before);expect(service.peekProject(other.projectId)!.livingScriptProposals.version).toBe(0);
});

test("a directed retained line can review rebased candidate direction before changing the saved screenplay",()=>{
  const service=fresh(),originalShot=renderShots(fixture.film).find(shot=>shot.id==="shot-1-1")!,settings={durationFrames:180};
  expect(service.saveShotDirection(fixture.owner.token,originalShot.id,settings,0,fixture.film.scriptVersion,directionEntry(originalShot,{}).sourceHash,24,now)).not.toBeNull();
  const current=service.peekProject(fixture.owner.projectId)!,reviewBaseline={casting:currentCasting(current.id,current.castingHistory),direction:currentDirection(current.id,current.directionHistory)},proposedShot=renderShots(input.candidate).find(shot=>shot.id===originalShot.id)!;
  const direction=directionSnapshot(current.id,reviewBaseline.direction.version+1,[directionEntry(proposedShot,settings)],now+1);
  const request:LivingScriptProposalRequest={...input,id:"directed-line",baseline:reviewBaseline,candidate:{...input.candidate,direction}};
  const originalVersions=current.versions.history(),originalEditorial=structuredClone(current.editLibrary),queue=readFileSync(fixture.paths.queuePath,"utf8"),unchanged=service.snapshot();
  expect(()=>save(service,{...request,candidate:{...request.candidate,direction:reviewBaseline.direction}})).toThrow("changed or disappeared");expect(service.snapshot()).toEqual(unchanged);
  const saved=save(service,request);expect(saved.replayed).toBe(false);expect(saved.proposal.request.baseline).toEqual(reviewBaseline);
  expect(saved.proposal.request.candidate.direction).toEqual(direction);expect(saved.proposal.impact.generation.candidateInputs.direction).toEqual(direction);
  expect(saved.proposal.impact.generation.shots.find(shot=>shot.shotId===originalShot.id)!.afterPlannedFrames).toBe(180);
  const retained=service.peekProject(current.id)!;expect(retained.versions.history()).toEqual(originalVersions);expect(retained.editLibrary).toEqual(originalEditorial);expect(currentDirection(retained.id,retained.directionHistory)).toEqual(reviewBaseline.direction);
  expect(readFileSync(fixture.paths.queuePath,"utf8")).toBe(queue);expect(ProjectService.fromState(service.snapshot()).peekProject(current.id)!.livingScriptProposals.proposals[0]).toEqual(saved.proposal);
  expect(service.saveShotDirection(fixture.owner.token,originalShot.id,{durationFrames:150},reviewBaseline.direction.version,fixture.film.scriptVersion,directionEntry(originalShot,{}).sourceHash,24,now+2)).not.toBeNull();
  const later=service.snapshot();expect(()=>save(service,{...request,id:"stale-directed-line"},1)).toThrow("current cast or direction changed");expect(service.snapshot()).toEqual(later);
  const retry=save(service,request);expect(retry.replayed).toBe(true);expect(retry.proposal).toEqual(saved.proposal);expect(service.snapshot()).toEqual(later);
});

test("candidate binding edits require the reviewed next version instead of changing a baseline version or skipping versions",()=>{
  const service=fresh(),shot=renderShots(input.candidate)[0]!,before=service.snapshot();
  for(const version of [input.baseline.direction.version,input.baseline.direction.version+2]){
    const direction=directionSnapshot(fixture.owner.projectId,version,[directionEntry(shot,{durationFrames:180})],now);
    expect(()=>save(service,{...input,candidate:{...input.candidate,direction}})).toThrow();expect(service.snapshot()).toEqual(before);
  }
});
