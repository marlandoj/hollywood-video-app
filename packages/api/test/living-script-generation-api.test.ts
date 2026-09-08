import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {CostLedger} from "../../operator/src/index";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {createLivingScriptPreviewReview,validateLivingScriptOutput,type LivingScriptPreviewReview} from "../../planner/src/living-script-job-context";
import type {Job} from "../../queue/src/index";
import type {LivingScriptGenerationQuote} from "../src/living-script-generation-api";
import type {PersistedState} from "../src/index";

let studio:Awaited<ReturnType<typeof dubStudio>>,original:Job,route:string,otherRoute:string,preview:Job,final:Job,review:LivingScriptPreviewReview;
let previewRequest:{quote:LivingScriptGenerationQuote;idempotencyKey:string;generationApproved:true;animaticJobId:null},renderQuote:LivingScriptGenerationQuote;
const oldPool=process.env.HV_PROVIDER_POOL;
const savedState=():PersistedState=>JSON.parse(readFileSync(studio.paths.statePath,"utf8"));
async function call(path:string,method="GET",body?:unknown,token?:string){const response=await studio.call(path,method,body,token??studio.owner.token);return {status:response.status,body:await response.json() as any};}
async function quote(role:"preview"|"render",path=route):Promise<LivingScriptGenerationQuote>{const result=await call(path+"/quote","POST",{role});expect(result.status,JSON.stringify(result.body.error??null)).toBe(200);expect(result.body.generationApproved).toBe(false);return result.body.quote;}
function publicPending(job:any){expect(job.livingScript).toBeDefined();expect(job.livingScript.binding).toBeUndefined();expect(job.livingScript.proposal).toBeUndefined();expect(job.livingScript.inputs).toBeUndefined();expect(job.scriptText).toBeUndefined();expect(job.output?.mp4Path).toBeUndefined();}
beforeAll(async()=>{
  process.env.HV_PROVIDER_POOL='["mock"]';studio=await dubStudio();
  expect((await call(studio.base+"/animatic/decision","POST",{animaticJobId:studio.film.id,decision:"approved"})).status).toBe(201);
  expect((await call(studio.base+"/jobs","POST",{idempotencyKey:"generation-api-original",stage:"final",animaticJobId:studio.film.id})).status).toBe(202);original=(await studio.worker())!;expect(original.status).toBe("done");
  const source=await inspectEditSource(original,"Original final",studio.paths.artifactRoot,async()=>{}),binding=bindOriginalEditSource(source),project=studio.projects.peekProject(studio.owner.projectId)!;
  const library=studio.projects.createEditSequence(studio.owner.token,[source],"pending-parent","Original cut",source.facts.id,320,180,0,Date.now(),[binding])!,parent=deriveEditAssemblyParent(project.id,library,"pending-parent"),index=compileEditScriptSource(source),line=index.entries.find(entry=>entry.kind==="dialogue")!,navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]);
  const patch=compileLivingScriptPatch(source,{entryId:line.id,indexRevision:index.revision,currentScript:{version:original.scriptVersion,text:original.scriptText},replacement:"Welcome back to the garden."}),impact=compileLivingScriptGenerationImpact(source,patch,{...original,scriptVersion:patch.after.version,scriptText:patch.after.text});
  const input={id:"http-line",label:"Revised greeting",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,editorialRevision:library.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}};
  studio.projects.createLivingScriptProposal(studio.owner.token,input,0,[{binding,current:original}]);studio.projects.createLivingScriptProposal(studio.owner.token,{...input,id:"other-http-line",label:"Separate reviewed proposal"},1,[{binding,current:original}]);
  route=studio.base+"/editorial/screenplay/proposals/http-line/generation";otherRoute=studio.base+"/editorial/screenplay/proposals/other-http-line/generation";
},180000);
afterAll(async()=>{await studio?.close();if(oldPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=oldPool;});

test("owner HTTP quote, actual preview, saved review and selective final preserve the current screenplay and cut",async()=>{
  const before=savedState().projects[0]!,originalBytes=readFileSync(join(studio.paths.artifactRoot,original.output!.mp4Path)),originalHash=contentHash(original),q=await quote("preview");
  expect(q.plan.request.role).toBe("preview");expect(q.plan.inputs.scriptText).not.toBe(original.scriptText);expect(q.budgetReservedUsd).toBe(0);expect(q.minimumEstimateUsd).toBe(0);expect(q.maximumEstimateUsd).toBe(0);
  previewRequest={quote:q,idempotencyKey:"preview-exact-retry",generationApproved:true,animaticJobId:null};const reserve=spyOn(CostLedger.prototype,"reserve");let admitted:any;
  try{const first=await call(route+"/jobs","POST",previewRequest);expect(first.status,JSON.stringify(first.body.error??null)).toBe(202);admitted=first.body;expect(admitted.replayed).toBe(false);expect(reserve).toHaveBeenCalledTimes(1);reserve.mockClear();
    const count=studio.store.all().length,retry=await call(route+"/jobs","POST",previewRequest);expect(retry.status).toBe(202);expect(retry.body.jobId).toBe(admitted.jobId);expect(retry.body.replayed).toBe(true);expect(studio.store.all()).toHaveLength(count);expect(reserve).not.toHaveBeenCalled();
  }finally{reserve.mockRestore();}
  preview=(await studio.worker())!;expect(preview.id).toBe(admitted.jobId);expect(preview.failureReason??preview.cancelReason).toBeUndefined();expect(preview.status).toBe("done");validateLivingScriptOutput(preview,preview.output!);
  const decision=await call(route+"/jobs/"+preview.id+"/decision");expect(decision.status).toBe(200);review=decision.body.review;expect(review).toEqual(createLivingScriptPreviewReview(preview));expect(decision.body.approval).toBeNull();publicPending(decision.body.job);
  const approved=await call(route+"/jobs/"+preview.id+"/decision","POST",{review,decision:"approved",note:"Reviewed this exact changed performance"});expect(approved.status,JSON.stringify(approved.body.error??null)).toBe(201);const stateBytes=readFileSync(studio.paths.statePath);
  const decisionRetry=await call(route+"/jobs/"+preview.id+"/decision","POST",{review,decision:"approved",note:"Reviewed this exact changed performance"});expect(decisionRetry.status).toBe(200);expect(decisionRetry.body.replayed).toBe(true);expect(readFileSync(studio.paths.statePath)).toEqual(stateBytes);
  renderQuote=await quote("render");expect(renderQuote.plan.request.role).toBe("render");expect(renderQuote.plan.shotReuse.shots.length).toBeGreaterThan(0);expect(renderQuote.plan.shotReuse.forceShotIds.length).toBeGreaterThan(0);
  const request={quote:renderQuote,idempotencyKey:"final-exact-retry",generationApproved:true,animaticJobId:preview.id},submitted=await call(route+"/jobs","POST",request);expect(submitted.status,JSON.stringify(submitted.body.error??null)).toBe(202);
  final=(await studio.worker())!;expect(final.id).toBe(submitted.body.jobId);expect(final.failureReason??final.cancelReason).toBeUndefined();expect(final.status).toBe("done");validateLivingScriptOutput(final,final.output!);
  expect(final.livingScript!.proposal.revision).toBe(preview.livingScript!.proposal.revision);expect(final.animaticApprovedAt).toBe(approved.body.approval.at);expect(readFileSync(join(studio.paths.artifactRoot,final.output!.captionsPath),"utf8")).toContain(renderQuote.plan.proposal.request.patch.replacement);
  for(const record of final.output!.shotRenders!.filter(record=>record.reusedFrom)){const prior=renderQuote.plan.shotReuse.shots.find(shot=>shot.shotId===record.shotId)!;expect(record.reusedFrom!.revision).toBe(prior.revision);for(const [role,file]of Object.entries(record.files))expect(readFileSync(join(studio.paths.artifactRoot,file.path))).toEqual(readFileSync(join(studio.paths.artifactRoot,prior.files[role as keyof typeof prior.files]!.path)));}
  const listed=await call(route+"/jobs");expect(listed.status).toBe(200);expect(listed.body.jobs.map((job:any)=>job.id).sort()).toEqual([preview.id,final.id].sort());for(const job of listed.body.jobs)publicPending(job);
  const after=savedState().projects[0]!;expect(after.versions).toEqual(before.versions);expect(after.editLibrary).toEqual(before.editLibrary);expect(after.castingHistory).toEqual(before.castingHistory);expect(after.directionHistory).toEqual(before.directionHistory);expect(after.livingScriptProposals).toEqual(before.livingScriptProposals);expect(after.livingScriptAcceptances).toBeUndefined();expect(contentHash(original)).toBe(originalHash);expect(readFileSync(join(studio.paths.artifactRoot,original.output!.mp4Path))).toEqual(originalBytes);expect(studio.ledger.monthSpend()).toBe(0);expect(studio.ledger.reservedUsd()).toBe(0);
  const reserveRetry=spyOn(CostLedger.prototype,"reserve");try{const result=await call(route+"/jobs","POST",request);expect(result.status).toBe(202);expect(result.body.jobId).toBe(final.id);expect(result.body.replayed).toBe(true);expect(reserveRetry).not.toHaveBeenCalled();}finally{reserveRetry.mockRestore();}
},180000);

test("changed quotes, other proposals and missing generation consent cannot spend or enqueue",async()=>{
  const q=await quote("preview"),count=studio.store.all().length,ledger=readFileSync(studio.paths.costLedgerPath),reserve=spyOn(CostLedger.prototype,"reserve");
  const wrong=structuredClone(q);wrong.totalFrames++;const {revision:_revision,...data}=wrong;wrong.revision=contentHash(data);
  try{for(const [path,body]of [[route,{...previewRequest,quote:wrong,idempotencyKey:"forged-quote-request"}],[otherRoute,previewRequest],[route,{...previewRequest,generationApproved:false,idempotencyKey:"no-generation-consent"}],[route,{...previewRequest,animaticJobId:preview.id}]] as const){const result=await call(path+"/jobs","POST",body);expect(result.status).toBeGreaterThanOrEqual(400);expect(result.status).toBeLessThan(500);}
    expect(studio.store.all()).toHaveLength(count);expect(readFileSync(studio.paths.costLedgerPath)).toEqual(ledger);expect(reserve).not.toHaveBeenCalled();
  }finally{reserve.mockRestore();}
});

test("stale runtime budgets invalidate new admission while exact admitted retries remain read-only",async()=>{
  const q=await quote("preview"),previous=process.env.HV_ANIMATIC_COST_CAP_USD,count=studio.store.all().length,reserve=spyOn(CostLedger.prototype,"reserve");process.env.HV_ANIMATIC_COST_CAP_USD=String(q.costCapUsd+1);
  try{const stale=await call(route+"/jobs","POST",{...previewRequest,quote:q,idempotencyKey:"stale-runtime-budget"});expect(stale.status).toBeGreaterThanOrEqual(400);expect(stale.status).toBeLessThan(500);expect(stale.body.error).toMatch(/configuration|budget|estimate|runtime/i);
    const retry=await call(route+"/jobs","POST",previewRequest);expect(retry.status).toBe(202);expect(retry.body.jobId).toBe(preview.id);expect(retry.body.replayed).toBe(true);expect(studio.store.all()).toHaveLength(count);expect(reserve).not.toHaveBeenCalled();
  }finally{reserve.mockRestore();if(previous===undefined)delete process.env.HV_ANIMATIC_COST_CAP_USD;else process.env.HV_ANIMATIC_COST_CAP_USD=previous;}
});

test("new changes requested decision preserves used approval history and blocks another final",async()=>{
  const old=savedState().projects[0]!.animaticApprovals.find(approval=>approval.animaticJobId===preview.id)!,count=studio.store.all().length;
  const updated=await call(route+"/jobs/"+preview.id+"/decision","POST",{review,decision:"changes_requested",note:"Revise the performance before another final"});expect(updated.status).toBe(201);
  const history=savedState().projects[0]!.animaticApprovals.filter(approval=>approval.animaticJobId===preview.id);expect(history).toHaveLength(2);expect(history[0]!.decision).toBe("changes_requested");expect(history[1]).toEqual(old);expect(studio.store.get(final.id)!.animaticApprovedAt).toBe(old.at);
  const state=readFileSync(studio.paths.statePath),again=await call(route+"/jobs/"+preview.id+"/decision","POST",{review,decision:"changes_requested",note:"Revise the performance before another final"});expect(again.status).toBe(200);expect(again.body.replayed).toBe(true);expect(readFileSync(studio.paths.statePath)).toEqual(state);
  const reserve=spyOn(CostLedger.prototype,"reserve");try{const rejected=await call(route+"/jobs","POST",{quote:renderQuote,idempotencyKey:"final-after-rejection",generationApproved:true,animaticJobId:preview.id});expect(rejected.status).toBeGreaterThanOrEqual(400);expect(rejected.status).toBeLessThan(500);expect(reserve).not.toHaveBeenCalled();expect(studio.store.all()).toHaveLength(count);}finally{reserve.mockRestore();}
},30000);

test("foreign owners, unrelated previews and forged media reviews cannot authorize pending generation",async()=>{
  const other=await call("/api/projects","POST"),count=studio.store.all().length;
  for(const [path,method,body,token]of [[route+"/quote","POST",{role:"preview"},other.body.token],[route+"/jobs","GET",undefined,other.body.token],[route+"/jobs/"+studio.film.id+"/decision","GET",undefined,studio.owner.token],[route+"/jobs/"+preview.id+"/decision","POST",{review:{...review,outputRevision:"a".repeat(64)},decision:"approved",note:"Wrong media"},studio.owner.token]] as const){const result=await call(path,method,body,token);expect(result.status).toBeGreaterThanOrEqual(400);expect(result.status).toBeLessThan(500);}
  expect(studio.store.all()).toHaveLength(count);
});

test("later screenplay edits block fresh quotes and admission without rewriting exact retry identity",async()=>{
  const q=await quote("preview");expect((await call(studio.base+"/script","PUT",{text:original.scriptText+"\n\nAn unrelated later change."})).status).toBe(200);const state=savedState(),count=studio.store.all().length,reserve=spyOn(CostLedger.prototype,"reserve");
  try{expect((await call(route+"/quote","POST",{role:"preview"})).status).toBeGreaterThanOrEqual(400);expect((await call(route+"/jobs","POST",{...previewRequest,quote:q,idempotencyKey:"stale-script-request"})).status).toBeGreaterThanOrEqual(400);
    const retry=await call(route+"/jobs","POST",previewRequest);expect(retry.status).toBe(202);expect(retry.body.jobId).toBe(preview.id);expect(retry.body.replayed).toBe(true);expect(savedState()).toEqual(state);expect(studio.store.all()).toHaveLength(count);expect(reserve).not.toHaveBeenCalled();
  }finally{reserve.mockRestore();}
});
