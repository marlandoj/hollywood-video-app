import {beforeAll,afterAll,expect,test,spyOn} from "bun:test";
import {join} from "node:path";
import {readFileSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {DeterministicMockProvider} from "../../generator/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {compileLivingScriptSourceMap} from "../../planner/src/living-script-source-map";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {createLivingScriptJobPlan,type LivingScriptJobPlan} from "../../planner/src/living-script-jobs";
import {createLivingScriptPreviewReview,validateLivingScriptOutput} from "../../planner/src/living-script-job-context";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {renderShots} from "../../planner/src/shot-reuse";
import {DurableJobStore,type JobInput,type Job} from "../src/index";
import {ProjectService} from "../../api/src/index";
import {processNextJob} from "../src/worker";

let fixture:Awaited<ReturnType<typeof dubStudio>>,original:Job,render:LivingScriptJobPlan,previewPlan:LivingScriptJobPlan;
const oldPool=process.env.HV_PROVIDER_POOL;
beforeAll(async()=>{
  process.env.HV_PROVIDER_POOL='["mock"]';fixture=await dubStudio();
  expect((await fixture.call(fixture.base+"/animatic/decision","POST",{animaticJobId:fixture.film.id,decision:"approved"},fixture.owner.token)).status).toBe(201);
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:"worker-final-original",stage:"final",animaticJobId:fixture.film.id},fixture.owner.token)).status).toBe(202);
  original=(await fixture.worker())!;expect(original.status).toBe("done");
  const source=await inspectEditSource(original,"Original final",fixture.paths.artifactRoot,async()=>{}),binding=bindOriginalEditSource(source),project=fixture.projects.peekProject(fixture.owner.projectId)!;
  const library=fixture.projects.createEditSequence(fixture.owner.token,[source],"pending-parent","Original cut",source.facts.id,320,180,0,Date.now(),[binding])!,parent=deriveEditAssemblyParent(project.id,library,"pending-parent");
  const index=compileEditScriptSource(source),line=index.entries.find(entry=>entry.kind==="dialogue")!,navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]);
  const patch=compileLivingScriptPatch(source,{entryId:line.id,indexRevision:index.revision,currentScript:{version:original.scriptVersion,text:original.scriptText},replacement:"Welcome back to the garden."}),impact=compileLivingScriptGenerationImpact(source,patch,{...original,scriptVersion:patch.after.version,scriptText:patch.after.text});
  const proposal=fixture.projects.createLivingScriptProposal(fixture.owner.token,{id:"worker-line",label:"Revised greeting",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,editorialRevision:library.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}},0,[{binding,current:original}])!.proposal;
  render=createLivingScriptJobPlan(proposal,binding,{role:"render"});previewPlan=createLivingScriptJobPlan(proposal,binding,{role:"preview",providerPlan:fixture.film.providerPlan!});
},180000);
afterAll(async()=>{await fixture?.close();if(oldPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=oldPool;});
function input(plan:LivingScriptJobPlan,preview?:Job,at?:string):JobInput {
  return {id:crypto.randomUUID(),idempotencyKey:plan.inputs.projectId+":"+crypto.randomUUID(),...plan.inputs,livingScript:plan,shotReuse:plan.shotReuse,
    totalFrames:renderShots(plan.inputs).reduce((total,shot)=>total+Math.round(shot.durationSec*30),0),retryPolicy:{maxRetries:1,backoffMs:0},timeoutMs:120000,costCapUsd:original.costCapUsd,budgetReservedUsd:0,
    ...(plan.inputs.stage==="animatic"?{providerSpec:plan.inputs.providerPlan!.pool[0]!.spec}:{}),rightsAttestedAt:original.rightsAttestedAt,animaticJobId:preview?.id??null,animaticApprovedAt:at??null};
}

test("actual pending preview, saved approval, interrupted selective final and reload preserve the original screenplay until acceptance",async()=>{
  const before=fixture.projects.snapshot().projects[0]!,originalHash=contentHash(original),originalMp4=readFileSync(join(fixture.paths.artifactRoot,original.output!.mp4Path));
  fixture.store.enqueue(input(previewPlan));const preview=(await fixture.worker())!;expect(preview.failureReason??preview.cancelReason).toBeUndefined();expect(preview.status).toBe("done");validateLivingScriptOutput(preview,preview.output!);
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:preview.idempotencyKey.slice(preview.projectId.length+1)},fixture.owner.token)).status).toBe(409);
  expect(fixture.projects.snapshot().projects[0]!.versions).toEqual(before.versions);expect(preview.scriptText).toBe(render.inputs.scriptText);
  const review=createLivingScriptPreviewReview(preview),decision=fixture.projects.recordLivingScriptDecision(fixture.owner.token,preview,review,"approved","Use this revised performance",{binding:render.binding,current:original})!;
  expect(decision.replayed).toBe(false);const saved=fixture.projects.snapshot();
  expect(fixture.projects.recordLivingScriptDecision(fixture.owner.token,preview,review,"approved","Use this revised performance",{binding:render.binding,current:original})!.replayed).toBe(true);expect(fixture.projects.snapshot()).toEqual(saved);
  expect((await fixture.call(fixture.base+"/animatic/decision","POST",{animaticJobId:preview.id,decision:"approved"},fixture.owner.token)).status).toBe(409);
  const request=input(render,preview,decision.approval.at),admitted=fixture.store.enqueue(request),checkpoint=fixture.store.checkpoint.bind(fixture.store),generate=DeterministicMockProvider.prototype.generate;
  const calls:string[]=[],provider=spyOn(DeterministicMockProvider.prototype,"generate").mockImplementation(function(this:DeterministicMockProvider,...args:Parameters<typeof generate>){calls.push(args[2].shotId!);return generate.apply(this,args);});
  let injected=false;const failure=spyOn(fixture.store,"checkpoint").mockImplementation((...args:Parameters<typeof checkpoint>)=>{checkpoint(...args);if(args[0]===admitted.id&&!injected){injected=true;throw new Error("Injected interruption after durable shot checkpoint");}});
  let interrupted:Job;try{interrupted=(await fixture.worker())!;}finally{failure.mockRestore();}
  expect(interrupted!.status).toBe("queued");expect(interrupted!.checkpointShots).toBe(1);expect(injected).toBe(true);expect(calls).toEqual(render.shotReuse.forceShotIds);
  const manifest=join(fixture.paths.artifactRoot,original.projectId,admitted.id,"clips/manifest.json"),prefix=JSON.parse(readFileSync(manifest,"utf8"))[0],prefixBytes=readFileSync(prefix.path);
  const projects=new ProjectService(fixture.paths.statePath),store=new DurableJobStore(fixture.paths.queuePath);let completed:Job;
  try{completed=(await processNextJob(store,fixture.paths.artifactRoot,{projects,ledger:fixture.ledger,reviewQueue:fixture.reviews}))!;}finally{provider.mockRestore();}
  expect(completed!.failureReason??completed!.cancelReason).toBeUndefined();expect(completed!.status).toBe("done");expect(completed!.resumedCount).toBeGreaterThanOrEqual(0);expect(calls).toEqual(render.shotReuse.forceShotIds);
  expect(readFileSync(prefix.path)).toEqual(prefixBytes);validateLivingScriptOutput(completed!,completed!.output!);
  const generated=await inspectEditSource(completed!,"Pending final",fixture.paths.artifactRoot,async()=>{}),mapping=compileLivingScriptSourceMap(render.binding.source,render.proposal.request.patch,render.proposal.impact.generation,generated);
  expect(mapping.shots.filter(shot=>shot.treatment==="unchanged").length).toBe(render.shotReuse.shots.length);
  for(const record of completed!.output!.shotRenders!.filter(record=>record.reusedFrom)){const old=render.shotReuse.shots.find(value=>value.shotId===record.shotId)!;expect(record.reusedFrom!.revision).toBe(old.revision);for(const [kind,file]of Object.entries(record.files))expect(readFileSync(join(fixture.paths.artifactRoot,file.path))).toEqual(readFileSync(join(fixture.paths.artifactRoot,old.files[kind as keyof typeof old.files]!.path)));}
  const after=projects.snapshot().projects[0]!;expect(after.versions).toEqual(before.versions);expect(after.editLibrary).toEqual(before.editLibrary);expect(after.directionHistory).toEqual(before.directionHistory);expect(after.castingHistory).toEqual(before.castingHistory);expect(after.livingScriptAcceptances).toBeUndefined();
  expect(contentHash(original)).toBe(originalHash);expect(readFileSync(join(fixture.paths.artifactRoot,original.output!.mp4Path))).toEqual(originalMp4);expect(readFileSync(join(fixture.paths.artifactRoot,completed!.output!.captionsPath),"utf8")).toContain(render.proposal.request.patch.replacement);expect(fixture.ledger.monthSpend()).toBe(0);
},180000);

test("stale pending generation fails before provider dispatch and does not change the saved screenplay",async()=>{
  fixture.projects.editScript(fixture.owner.token,original.scriptText+"\n\nAnother change.");const before=fixture.projects.snapshot(),request=input(previewPlan);request.retryPolicy.maxRetries=0;fixture.store.enqueue(request);
  const provider=spyOn(DeterministicMockProvider.prototype,"generate");let result:Job;try{result=(await fixture.worker())!;expect(provider).not.toHaveBeenCalled();}finally{provider.mockRestore();}
  expect(result!.status).toBe("failed");expect(result!.failureReason).toContain("changed before pending generation");expect(fixture.projects.snapshot()).toEqual(before);expect(fixture.ledger.monthSpend()).toBe(0);
},30000);
