import {afterAll,beforeAll,expect,test} from "bun:test";
import {join} from "node:path";
import {currentFilmAuthorityFixture,currentFilmAuthorityProposal} from "./current-film-authority.fixture";
import {ProjectService,type PersistedProject} from "../../api/src/index";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {assertCurrentFilmSourcePermission} from "../src/current-film-source-permission";
import {castingSnapshot,currentCasting} from "../src/casting";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {compileCurrentFilmJob} from "../src/current-film-jobs";
import {currentScreenplayHead,saveCurrentScreenplayProposal,acceptCurrentScreenplayProposal} from "../src/current-screenplay-library";
import {compileLivingScriptStructure,livingScriptStructureBoundary} from "../src/living-script-structure";
import {compileLivingScriptDocument} from "../src/living-script-document";
import {proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";
import {validateCompletedCurrentFilmSource,createCurrentFilmPreviewReview,validateCurrentFilmPreviewReview,currentFilmV2Job} from "../src/current-film-job-context";
import {assertEditBindingAvailable,bindOriginalEditSource} from "../src/edit-jobs";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {editValidationKey} from "../src/edit-validation-key";

let fixture:Awaited<ReturnType<typeof currentFilmAuthorityFixture>>,job:Job,accepted:PersistedProject;
beforeAll(async()=>{
  fixture=await currentFilmAuthorityFixture();const {studio,project}=fixture,plan=compileCurrentFilmJob(project.currentScreenplay!,fixture.plan.selector,{role:"preview",tier:"free",providerPlan:createProviderPlan("animatic",5)});
  const state=studio.projects.snapshot();state.projects=[project];const projects=ProjectService.fromState(state),store=new DurableJobStore(join(studio.root,"source-permission-queue.json"));
  const input:JobInput={id:"current-source-permission",projectId:project.id,idempotencyKey:"current-source-permission",tier:plan.render.tier,stage:plan.render.stage,
    scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,currentFilm:plan,
    rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
  store.enqueue(input);job=(await processNextJob(store,studio.paths.artifactRoot,{projects,ledger:new CostLedger(join(studio.root,"source-permission-ledger.json")),reviewQueue:new OperatorReviewQueue(join(studio.root,"source-permission-review.json"))}))!;
  expect(job.failureReason??job.cancelReason).toBeUndefined();expect(job.status).toBe("done");
  accepted=currentFilmAuthorityProposal(project,"later-source-head",Date.now()).accept(Date.now()+1);
},180000);
afterAll(async()=>{await fixture?.studio.close();});

test("warm carrier checks still reject changed evidence, missing owners, expiry and withdrawn permission",async()=>{
  const receipt=await inspectEditSource(job,"Carrier cache evidence",fixture.studio.paths.artifactRoot,async()=>{}),binding=bindOriginalEditSource(receipt),now=Date.now();
  expect(editValidationKey({binding,current:job},256*1024**2)).not.toBeNull();
  expect(()=>assertEditBindingAvailable(binding,job,now)).not.toThrow();
  expect(()=>assertEditBindingAvailable(structuredClone(binding),structuredClone(job),now)).not.toThrow();
  expect(()=>assertEditBindingAvailable(binding,job,Date.parse(binding.owner.linkExpiresAt))).toThrow();
  expect(()=>assertEditBindingAvailable(binding,job,NaN)).toThrow();
  expect(()=>assertEditBindingAvailable(binding,undefined,now)).toThrow();
  const changed=structuredClone(job);changed.output!.currentFilm!.assembly.frames++;
  expect(()=>assertEditBindingAvailable(binding,changed,now)).toThrow();
  const altered=structuredClone(binding);altered.source.job.currentFilm!.materialization.script.text="Changed inside a saved revision";
  expect(()=>assertEditBindingAvailable(altered,job,now)).toThrow();
  const revoked={...fixture.project,rightsAttestedAt:null};
  expect(()=>assertCurrentFilmSourcePermission(job,revoked,now)).toThrow();
  let reads=0;const accessor=Object.defineProperty({},"current",{enumerable:true,get(){reads++;return job;}});
  expect(editValidationKey(accessor,256*1024**2)).toBeNull();expect(reads).toBe(0);
  expect(editValidationKey({optional:undefined},1024)).not.toBe(editValidationKey({},1024));
  expect(editValidationKey({optional:undefined},1024)).not.toBe(editValidationKey({optional:"undefined"},1024));
  for(const value of [[undefined],{number:NaN},{number:-0},new Date(),{toJSON(){return {};}}])expect(editValidationKey(value,1024)).toBeNull();
},30000);
test("completed source cache requires full portable job evidence and returns isolated plan data",()=>{
  const plan=validateCompletedCurrentFilmSource(job);plan.materialization.script.text="Changed returned copy";
  expect(validateCompletedCurrentFilmSource(job).materialization.script.text).toBe(job.scriptText);
  let reads=0;const accessor=structuredClone(job);Object.defineProperty(accessor,"currentFilm",{enumerable:true,get(){reads++;return job.currentFilm;}});
  expect(()=>validateCompletedCurrentFilmSource(accessor)).toThrow();expect(reads).toBe(0);
  expect(()=>validateCompletedCurrentFilmSource({...job,status:"queued"})).toThrow();
  expect(()=>validateCompletedCurrentFilmSource({...job,linkExpiresAt:job.completedAt})).toThrow();
  const altered=structuredClone(job);altered.output!.currentFilm!.assembly.frames++;
  expect(()=>validateCompletedCurrentFilmSource(altered)).toThrow();
},30000);
test("repeated completed preview reviews remain exact and detached after warming source validation",()=>{
  const before=contentHash(job);validateCompletedCurrentFilmSource(job);
  const original=createCurrentFilmPreviewReview(job),second=createCurrentFilmPreviewReview(structuredClone(job));
  expect(second).toEqual(original);expect(second).not.toBe(original);
  second.outputRevision="a".repeat(64);second.targetRevision="b".repeat(64);
  expect(createCurrentFilmPreviewReview(job)).toEqual(original);expect(validateCurrentFilmPreviewReview(job,original)).toEqual(original);
  expect(contentHash(job)).toBe(before);
},30000);
test("changed valid output metadata gets its own review while a warmed valid body cannot hide later corruption",()=>{
  const original=createCurrentFilmPreviewReview(job),changed=currentFilmV2Job(structuredClone(job));
  // Metadata-only alternate delivery identity: no new bytes, custody or render
  // are claimed. The pure output validator permits this distinct owned path.
  changed.output!.mp4Path=`${changed.projectId}/${changed.id}/review-cache-alternate/export.mp4`;
  expect(()=>validateCompletedCurrentFilmSource(changed)).not.toThrow();
  const alternate=createCurrentFilmPreviewReview(changed);
  expect(alternate.outputRevision).toBe(contentHash(changed.output));expect(alternate.outputRevision).not.toBe(original.outputRevision);
  expect(alternate.revision).not.toBe(original.revision);expect(()=>validateCurrentFilmPreviewReview(changed,original)).toThrow("changed");
  expect(createCurrentFilmPreviewReview(structuredClone(changed))).toEqual(alternate);
  changed.output!.currentFilm!.assembly.frames++;
  expect(()=>createCurrentFilmPreviewReview(changed)).toThrow();
  expect(createCurrentFilmPreviewReview(job)).toEqual(original);
},30000);
test("warm preview review refuses changed status, stage, lifetime, capture and accessor bodies",()=>{
  const original=createCurrentFilmPreviewReview(job);
  for(const change of [
    (value:Job)=>{value.status="running";},(value:Job)=>{value.stage="final";},(value:Job)=>{delete value.output;},
    (value:Job)=>{value.completedAt=new Date(Date.parse(value.startedAt!)-1).toISOString();},
    (value:Job)=>{value.linkExpiresAt=value.completedAt;},
    (value:Job)=>{currentFilmV2Job(value).currentFilmCheckpoint!.rows[0]!.capture.observation.attempt++;},
    (value:Job)=>{value.routeDecisions=[];},
  ]){const changed=structuredClone(job);change(changed);expect(()=>createCurrentFilmPreviewReview(changed)).toThrow();}
  let reads=0;const changed=structuredClone(job);
  Object.defineProperty(changed,"currentFilm",{enumerable:true,get(){reads++;return job.currentFilm;}});
  expect(()=>createCurrentFilmPreviewReview(changed)).toThrow();expect(reads).toBe(0);
  const nested=currentFilmV2Job(structuredClone(job));
  Object.defineProperty(nested.currentFilmCheckpoint!.rows[0]!.capture.observation,"attempt",{enumerable:true,get(){reads++;return 1;}});
  expect(()=>createCurrentFilmPreviewReview(nested)).toThrow();expect(reads).toBe(0);
  expect(createCurrentFilmPreviewReview(job)).toEqual(original);
},30000);
test("retained V2 permission follows saved ancestry after acceptance without requiring current generation inputs",()=>{
  const now=Date.now()+1000,before=contentHash(job);expect(()=>assertCurrentFilmSourcePermission(job,fixture.project,now)).not.toThrow();
  expect(accepted.currentScreenplay!.headRevision).not.toBe(job.currentFilm!.baseline.headRevision);
  expect(()=>assertCurrentFilmSourcePermission(job,accepted,now)).not.toThrow();expect(contentHash(job)).toBe(before);
  const expiredOriginal={...job,linkExpiresAt:new Date(now-1).toISOString()};expect(()=>assertCurrentFilmSourcePermission(expiredOriginal,accepted,now)).not.toThrow();
},30000);
test("retained V2 permission rechecks current rights, character revocation and exact saved ancestry",()=>{
  const now=Date.now()+1000;
  for(const change of [(p:PersistedProject)=>{p.rightsAttestedAt=null;},(p:PersistedProject)=>{p.deleteAfter=new Date(now).toISOString();},(p:PersistedProject)=>{p.currentScreenplay=undefined;},(p:PersistedProject)=>{p.versions=p.versions.slice(0,-1);}]){
    const project=structuredClone(accepted);change(project);expect(()=>assertCurrentFilmSourcePermission(job,project,now)).toThrow();
  }
  const project=structuredClone(accepted),cast=currentCasting(project.id,project.castingHistory),characters=structuredClone(cast.characters);characters[0]!.permission.status="revoked";
  project.castingHistory!.push(castingSnapshot(project.id,cast.version+1,characters,now));expect(()=>assertCurrentFilmSourcePermission(job,project,now)).toThrow();
},30000);
test("current scoped permission must bind the retained physical scene, and an unrelated screenplay cannot impersonate ancestry",()=>{
  const now=Date.now()+1000,project=structuredClone(accepted),cast=currentCasting(project.id,project.castingHistory),characters=structuredClone(cast.characters),slot=job.currentFilm!.materialization.slots.find(row=>row.shot.characterIds?.length)!;
  const character=characters.find(value=>value.id===slot.shot.characterIds![0])!;character.permission.scope="scenes";character.permission.sceneNumbers=[slot.sceneIndex+1];character.sceneBindings=[{sceneNumber:slot.sceneIndex+1,heading:slot.heading}];
  project.castingHistory!.push(castingSnapshot(project.id,cast.version+1,characters,now));expect(()=>assertCurrentFilmSourcePermission(job,project,now)).not.toThrow();
  character.sceneBindings[0]!.heading="INT. DIFFERENT - NIGHT";project.castingHistory!.push(castingSnapshot(project.id,cast.version+2,characters,now));expect(()=>assertCurrentFilmSourcePermission(job,project,now)).toThrow("physical scene");
  const unrelated=structuredClone(accepted),last=unrelated.versions.at(-1)!;unrelated.versions.push({...last,version:last.version+1,parentVersion:last.version,text:last.text+"\nUnrelated edit.\n",createdAt:new Date(now).toISOString()});
  expect(()=>assertCurrentFilmSourcePermission(job,unrelated,now)).toThrow("ancestry");
},30000);
test("retained scene permission follows its physical heading when an accepted insertion changes scene numbers",()=>{
  const now=Date.now()+1000,project=structuredClone(fixture.project),library=project.currentScreenplay!,head=currentScreenplayHead(library)!,state=head.state,document=state.context.plan.document;
  const patch=compileLivingScriptStructure(document.context.base,{baseRevision:document.context.base.revision,operations:[{id:"move-original-address",kind:"insert",at:livingScriptStructureBoundary(document.context.base,1),text:"EXT. NEW PLACE - NIGHT\nA lamp glows.\n\n"}]}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]}),capacity={tier:"free" as const,maxShots:24 as const};
  const evolution=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument,capacity,requestId:"source-permission-reorder"});
  expect(evolution.review.conflicts).toEqual([]);
  const saved=saveCurrentScreenplayProposal(library,{id:"source-permission-insert",label:"Insert a scene",expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,capacity,planRequest:evolution.request,directionRequest:createCurrentDirectionRequest(state.direction,evolution.review.candidate!,{id:"source-permission-direction",settings:[],lines:[],retired:[]})},library.version,now);
  const result=acceptCurrentScreenplayProposal(saved.library,{id:"source-permission-accept",proposalRevision:saved.proposal.revision,expectedHeadRevision:head.revision},saved.library.version,now+1);
  project.currentScreenplay=result.library;project.versions.push(...result.versions);const cast=result.acceptance.state.casting.candidate!,characters=structuredClone(cast.characters),character=characters[0]!;
  character.permission.scope="scenes";character.permission.sceneNumbers=[2];character.sceneBindings=[{sceneNumber:2,heading:document.scenes[0]!.heading}];
  project.castingHistory!.push(castingSnapshot(project.id,cast.version+1,characters,now+2));
  expect(()=>assertCurrentFilmSourcePermission(job,project,now+3)).not.toThrow();
  character.permission.sceneNumbers=[1];character.sceneBindings=[{sceneNumber:1,heading:"EXT. NEW PLACE - NIGHT"}];project.castingHistory!.push(castingSnapshot(project.id,cast.version+2,characters,now+2));
  expect(()=>assertCurrentFilmSourcePermission(job,project,now+3)).toThrow();
},30000);
