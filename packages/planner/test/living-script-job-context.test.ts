import {beforeAll,afterAll,expect,test} from "bun:test";
import {join} from "node:path";
import {readFileSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import type {VideoClip} from "../../generator/src/index";
import type {Job,JobInput} from "../../queue/src/index";
import type {AnimaticApproval} from "../../api/src/index";
import {createEditSequence,emptyEditLibrary} from "../src/edit-library";
import {deriveEditAssemblyParent} from "../src/edit-assembly-parent";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {assertEditSourceAvailable,assertEditOriginalSelection} from "../src/edit-sources";
import {compileEditScriptSource} from "../src/edit-script-source";
import {projectEditScriptNavigation} from "../src/edit-script-projection";
import {compileLivingScriptPatch} from "../src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../src/living-script-generation";
import {emptyLivingScriptProposals,createLivingScriptProposal,type LivingScriptProposal} from "../src/living-script-proposals";
import {createLivingScriptJobPlan,type LivingScriptJobPlan} from "../src/living-script-jobs";
import {currentCasting,castingSnapshot} from "../src/casting";
import {currentDirection,directionSnapshot} from "../src/direction";
import {renderShots,renderRecord} from "../src/shot-reuse";
import {validateLivingScriptJob,assertLivingScriptIdempotency,createLivingScriptPreviewReview,assertLivingScriptPreviewApproval,validateLivingScriptOutput,validateLivingScriptClips} from "../src/living-script-job-context";

let fixture:Awaited<ReturnType<typeof dubStudio>>,proposal:LivingScriptProposal,previewPlan:LivingScriptJobPlan,finalPlan:LivingScriptJobPlan,preview:Job,final:JobInput,approval:AnimaticApproval,clips:VideoClip[],now:number;
const oldPool=process.env.HV_PROVIDER_POOL;
function input(plan:LivingScriptJobPlan):JobInput {
  return {id:crypto.randomUUID(),idempotencyKey:plan.inputs.projectId+":"+crypto.randomUUID(),...plan.inputs,livingScript:plan,shotReuse:plan.shotReuse,totalFrames:renderShots(plan.inputs,Date.parse(plan.createdAt)).reduce((total,shot)=>total+Math.round(shot.durationSec*30),0),rightsAttestedAt:plan.binding.source.job.rightsAttestedAt,costCapUsd:10,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:120000,animaticJobId:null,animaticApprovedAt:null};
}
beforeAll(async()=>{
  process.env.HV_PROVIDER_POOL='["mock"]';fixture=await dubStudio();
  expect((await fixture.call(fixture.base+"/animatic/decision","POST",{animaticJobId:fixture.film.id,decision:"approved"},fixture.owner.token)).status).toBe(201);
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),stage:"final",animaticJobId:fixture.film.id},fixture.owner.token)).status).toBe(202);
  const sourceFilm=(await fixture.worker())!;expect(sourceFilm.failureReason??sourceFilm.cancelReason).toBeUndefined();expect(sourceFilm.status).toBe("done");
  const at=Date.now(),source=await inspectEditSource(sourceFilm,"Actual final source",fixture.paths.artifactRoot,async()=>{}),binding=bindOriginalEditSource(source),project=fixture.projects.peekProject(fixture.owner.projectId)!;
  const library=createEditSequence(emptyEditLibrary(),project.id,[source],"parent","Original final cut",source.facts.id,320,180,0,at),parent=deriveEditAssemblyParent(project.id,library,"parent"),index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:sourceFilm.scriptVersion,text:sourceFilm.scriptText},replacement:"Welcome back to the garden."}),impact=compileLivingScriptGenerationImpact(source,patch,{...sourceFilm,scriptVersion:patch.after.version,scriptText:patch.after.text},at),navigation=projectEditScriptNavigation("parent",parent.historyRevision,parent.timeline,[index]);
  proposal=createLivingScriptProposal(emptyLivingScriptProposals(project.id),project.id,library,{id:"final-line",label:"Review this final line",sequenceId:"parent",historyRevision:parent.historyRevision,editorialRevision:library.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}},0,at).proposal;
  finalPlan=createLivingScriptJobPlan(proposal,binding,{role:"render"},at);previewPlan=createLivingScriptJobPlan(proposal,binding,{role:"preview",providerPlan:fixture.film.providerPlan!},at);
  // Existing normal routes supply actual media only. Attaching its exact already-reviewed plan
  // below tests metadata validation, not a claim that pending-job worker admission is integrated.
  expect((await fixture.call(fixture.base+"/script","PUT",{text:patch.after.text},fixture.owner.token)).status).toBe(200);
  expect((await fixture.call(fixture.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true,forceShotIds:previewPlan.shotReuse.forceShotIds},fixture.owner.token)).status).toBe(202);
  const rendered=(await fixture.worker())!;expect(rendered.failureReason??rendered.cancelReason).toBeUndefined();expect(rendered.status).toBe("done");preview={...rendered,livingScript:previewPlan};
  clips=JSON.parse(readFileSync(join(fixture.paths.artifactRoot,rendered.projectId,rendered.id,"clips/manifest.json"),"utf8")) as VideoClip[];
  now=Date.parse(preview.completedAt!)+1;const casting=preview.casting??castingSnapshot(preview.projectId,0,[],0),direction=preview.direction??directionSnapshot(preview.projectId,0,[],0);
  approval={animaticJobId:preview.id,scriptVersion:preview.scriptVersion,decision:"approved",note:"Reviewed exact proposed line preview",at:new Date(now).toISOString(),castingVersion:casting.version,castingRevision:casting.revision,directionVersion:direction.version,directionRevision:direction.revision,livingScriptReview:createLivingScriptPreviewReview(preview)};
  final={...input(finalPlan),animaticJobId:preview.id,animaticApprovedAt:approval.at};
},180000);
afterAll(async()=>{await fixture?.close();if(oldPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=oldPool;});

test("actual completed pending preview metadata binds the exact final proposal, media, settings and saved approval",()=>{
  const original=contentHash({preview,final,approval}),review=createLivingScriptPreviewReview(preview),{revision,...data}=review;
  expect(revision).toBe(contentHash(data));expect(review.jobId).toBe(preview.id);expect(review.proposalRevision).toBe(proposal.revision);expect(review.planRevision).toBe(previewPlan.revision);expect(review.outputRevision).toBe(contentHash(preview.output));
  expect(()=>validateLivingScriptJob(preview)).not.toThrow();expect(()=>validateLivingScriptJob(final,now)).not.toThrow();expect(()=>assertLivingScriptPreviewApproval(final,preview,approval,now)).not.toThrow();expect(contentHash({preview,final,approval})).toBe(original);
  review.outputRevision="a".repeat(64);expect(createLivingScriptPreviewReview(preview)).toEqual(approval.livingScriptReview!);
});

test("actual identical media cannot change its pending proposal identity or masquerade as an ordinary original",async()=>{
  const source=await inspectEditSource(preview,"Pending preview original",fixture.paths.artifactRoot,async()=>{}),project=fixture.projects.peekProject(preview.projectId)!;
  expect(()=>assertEditSourceAvailable(source,preview,now)).not.toThrow();expect(()=>assertEditOriginalSelection(preview,preview,project,now)).not.toThrow();
  const alternate=createLivingScriptProposal(emptyLivingScriptProposals(preview.projectId),preview.projectId,proposal.editorial,{...proposal.request,id:"same-media-other-proposal"},0,Date.parse(proposal.createdAt)).proposal;
  const changed={...preview,livingScript:createLivingScriptJobPlan(alternate,previewPlan.binding,previewPlan.request,Date.parse(previewPlan.createdAt))},ordinary={...preview};delete ordinary.livingScript;
  expect(changed.output).toEqual(preview.output);expect(()=>validateLivingScriptJob(changed)).not.toThrow();
  for(const current of [changed,ordinary]){expect(()=>assertEditSourceAvailable(source,current,now)).toThrow("pending screenplay identity");expect(()=>assertEditOriginalSelection(preview,current,project,now)).toThrow("pending screenplay identity");}
  const ordinarySource=await inspectEditSource(ordinary,"Ordinary identical media",fixture.paths.artifactRoot,async()=>{});
  expect(()=>assertEditSourceAvailable(ordinarySource,preview,now)).toThrow("pending screenplay identity");expect(()=>assertEditOriginalSelection(ordinary,preview,project,now)).toThrow("pending screenplay identity");
},30000);

test("pending job isolation rejects every conflicting mode, self-carrier, mismatched frame budget and provider override",()=>{
  const base=input(previewPlan),modes=["shotTakes","characterSheet","dialogueReplacement","dialogueCheckpoint","audioTake","audioCheckpoint","audioOutput","lipSync","lipSyncPrepared","lipSyncCheckpoint","lipSyncReviews","soundMix","soundCheckpoint","pictureEdit","editCheckpoint","assemblyEdit","assemblyCheckpoint","graphicRender","graphicCheckpoint","graphicOutput","graphicProgress"];
  for(const mode of modes)expect(()=>validateLivingScriptJob({...base,[mode]:{}})).toThrow("isolated normal film");
  for(const id of [previewPlan.binding.owner.jobId,previewPlan.binding.source.job.id])expect(()=>validateLivingScriptJob({...base,id})).toThrow("independent carrier");
  expect(()=>validateLivingScriptJob({...base,totalFrames:base.totalFrames+1})).toThrow("frame budget");expect(()=>validateLivingScriptJob({...base,providerSpec:"other-provider"})).toThrow("pinned preview provider");
  expect(()=>validateLivingScriptJob({...base,costCapUsd:NaN})).toThrow();expect(()=>validateLivingScriptJob({...base,budgetReservedUsd:base.costCapUsd+1})).toThrow("budget");expect(()=>validateLivingScriptJob({...base,timeoutMs:0})).toThrow("timeout");
  expect(()=>validateLivingScriptJob({...base,animaticJobId:preview.id,animaticApprovedAt:approval.at})).toThrow("preview");expect(()=>validateLivingScriptJob({...final,animaticJobId:null})).toThrow("pending final");
});

test("idempotency binds submitted plan, settings, budget and timing while ignoring generated lifecycle and output fields",()=>{
  const asked=input(previewPlan),existing:Job={...preview,...asked,providerSpec:asked.providerSpec,status:"done",output:preview.output,startedAt:preview.startedAt,completedAt:preview.completedAt,linkExpiresAt:preview.linkExpiresAt};
  // Output ownership belongs to its real job; generated identity and lifecycle are not submitted.
  existing.id=preview.id;
  expect(()=>assertLivingScriptIdempotency(existing,{...asked,id:crypto.randomUUID(),traceparent:"new-trace",queueAction:"queue_behind",queueReason:"project_concurrency"})).not.toThrow();
  for(const change of [{costCapUsd:11},{budgetReservedUsd:1},{timeoutMs:130000},{retryPolicy:{maxRetries:3,backoffMs:1000}},{totalFrames:asked.totalFrames+1},{rightsAttestedAt:new Date(Date.parse(asked.rightsAttestedAt!)+1).toISOString()},{providerSpec:asked.providerPlan!.pool[0]!.spec}])expect(()=>assertLivingScriptIdempotency(existing,{...asked,...change})).toThrow();
  const {livingScript:_pending,...ordinary}=asked;expect(()=>assertLivingScriptIdempotency(existing,ordinary)).toThrow("different pending");expect(()=>assertLivingScriptIdempotency({...existing,livingScript:undefined},asked)).toThrow("different pending");
  const saved=createLivingScriptProposal(emptyLivingScriptProposals(proposal.projectId),proposal.projectId,proposal.editorial,{...proposal.request,id:"same-text-other-proposal",label:"Separately reviewed identity"},0,Date.parse(proposal.createdAt));
  const alternative=createLivingScriptJobPlan(saved.proposal,previewPlan.binding,previewPlan.request,Date.parse(previewPlan.createdAt));expect(alternative.inputs.scriptVersion).toBe(asked.scriptVersion);expect(alternative.inputs.scriptText).toBe(asked.scriptText);
  expect(()=>assertLivingScriptIdempotency(existing,{...asked,livingScript:alternative})).toThrow("different reviewed plan");
});

test("complete outputs and exact checkpoint prefixes reject missing, duplicate, reordered, tampered and derived media",()=>{
  expect(()=>validateLivingScriptOutput(preview,preview.output!)).not.toThrow();for(let count=0;count<=clips.length;count++)expect(()=>validateLivingScriptClips(preview,clips.slice(0,count))).not.toThrow();
  for(const shotRenders of [[],preview.output!.shotRenders!.slice(1),[...preview.output!.shotRenders!].reverse(),[preview.output!.shotRenders![0]!,preview.output!.shotRenders![0]!]])expect(()=>validateLivingScriptOutput(preview,{...preview.output!,shotRenders})).toThrow();
  const changed=structuredClone(preview.output!),item=changed.shotRenders![0]!,{schema:_schema,revision:_revision,...data}=item;changed.shotRenders![0]=renderRecord({...data,inputHash:"b".repeat(64)});expect(()=>validateLivingScriptOutput(preview,changed)).toThrow("inputs");
  const unexpected=structuredClone(preview.output!);unexpected.shotRenders![0]=renderRecord({...data,reusedFrom:{jobId:proposal.impact.generation.sourceFilmJobId,shotId:item.shotId,revision:item.revision}});expect(()=>validateLivingScriptOutput(preview,unexpected)).toThrow("not admitted for reuse");
  expect(()=>validateLivingScriptOutput(preview,{...preview.output!,sheetPath:"sheet.png"})).toThrow("normal film artifacts");expect(()=>validateLivingScriptOutput(preview,{...preview.output!,mp4Path:"foreign/job/export.mp4"})).toThrow("owning job");
  expect(()=>validateLivingScriptClips(preview,[...clips].reverse())).toThrow();expect(()=>validateLivingScriptClips(preview,[...clips,clips[0]!])).toThrow("prefix");
  const mismatch=structuredClone(clips);mismatch[0]!.durationSec++;expect(()=>validateLivingScriptClips(preview,mismatch)).toThrow("clip metadata");
  const missing=structuredClone(clips);delete missing[0]!.renderRecord;expect(()=>validateLivingScriptClips(preview,missing)).toThrow();
});

test("same-next-version alternate proposal, ordinary preview and changed review cannot approve a pending final",()=>{
  const another=createLivingScriptProposal(emptyLivingScriptProposals(proposal.projectId),proposal.projectId,proposal.editorial,{...proposal.request,id:"another-final-proposal"},0,Date.parse(proposal.createdAt)).proposal;
  const otherPlan=createLivingScriptJobPlan(another,finalPlan.binding,{role:"render"},Date.parse(finalPlan.createdAt));expect(otherPlan.inputs.scriptVersion).toBe(final.scriptVersion);expect(otherPlan.inputs.scriptText).toBe(final.scriptText);
  expect(()=>assertLivingScriptPreviewApproval({...final,livingScript:otherPlan},preview,approval,now)).toThrow("exact pending final proposal");
  const ordinary={...preview,livingScript:undefined};expect(()=>createLivingScriptPreviewReview(ordinary)).toThrow("completed pending preview");expect(()=>assertLivingScriptPreviewApproval(final,ordinary,approval,now)).toThrow();
  expect(()=>assertLivingScriptPreviewApproval({...final,livingScript:undefined},preview,approval,now)).toThrow("ordinary final");expect(()=>assertLivingScriptPreviewApproval({...final,livingScript:undefined},ordinary,approval,now)).toThrow("ordinary final");
  for(const mutate of [(value:AnimaticApproval)=>{value.decision="changes_requested";},(value:AnimaticApproval)=>{value.livingScriptReview!.outputRevision="c".repeat(64);},(value:AnimaticApproval)=>{value.livingScriptReview!.planRevision="d".repeat(64);},(value:AnimaticApproval)=>{value.animaticJobId="other-preview";},(value:AnimaticApproval)=>{value.castingRevision="e".repeat(64);},(value:AnimaticApproval)=>{value.directionVersion!++;}]){const altered=structuredClone(approval);mutate(altered);expect(()=>assertLivingScriptPreviewApproval(final,preview,altered,now)).toThrow();}
  expect(()=>assertLivingScriptPreviewApproval(final,preview,null,now)).toThrow("current saved approval");
});

test("preview completion, expiry and exact approval timestamps reject early, future, late and replaced approvals",()=>{
  for(const at of [Date.parse(preview.completedAt!)-1,now+1,Date.parse(preview.linkExpiresAt!)]){const changed={...approval,at:new Date(at).toISOString()};expect(()=>assertLivingScriptPreviewApproval({...final,animaticApprovedAt:changed.at},preview,changed,now)).toThrow("late, expired");}
  expect(()=>assertLivingScriptPreviewApproval(final,preview,{...approval,at:new Date(now+1).toISOString()},now+2)).toThrow("admitted approval time");
  expect(()=>assertLivingScriptPreviewApproval(final,preview,approval,Date.parse(preview.linkExpiresAt!))).toThrow("expired");
  expect(()=>assertLivingScriptPreviewApproval(final,{...preview,status:"cancelled"},approval,now)).toThrow("completed pending preview");
  expect(()=>assertLivingScriptPreviewApproval(final,{...preview,completedAt:new Date(now+1).toISOString()},approval,now)).toThrow("late, expired");
  expect(()=>assertLivingScriptPreviewApproval({...preview,...final,providerSpec:undefined,output:undefined,status:"running" as const,startedAt:new Date(now-1).toISOString()},preview,approval,now)).toThrow("late, expired");
  expect(createLivingScriptPreviewReview(JSON.parse(JSON.stringify(preview)))).toEqual(approval.livingScriptReview!);
});

test("hidden pending-context and nested output accessors are rejected without invocation",()=>{
  let reads=0;const job={...preview};Object.defineProperty(job,"livingScript",{enumerable:true,get(){reads++;return previewPlan;}});
  expect(()=>validateLivingScriptJob(job)).toThrow("without accessors");expect(()=>assertLivingScriptIdempotency(job,input(previewPlan))).toThrow("without accessors");expect(reads).toBe(0);
  const output={...preview.output!};Object.defineProperty(output,"shotRenders",{enumerable:true,get(){reads++;return preview.output!.shotRenders;}});expect(()=>validateLivingScriptOutput(preview,output)).toThrow("without accessors");expect(reads).toBe(0);
});
