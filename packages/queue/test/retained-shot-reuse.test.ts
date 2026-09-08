import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {readFileSync,realpathSync,renameSync,writeFileSync,existsSync,readdirSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource,bindRetainedEditSource,assertEditBindingAvailable,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {compileRetainedShotReuse,retainedShotReuseFiles,type RetainedShotReuse} from "../../planner/src/retained-shot-reuse";
import {assertRenderedOrigin,renderShots,type ShotRenderRecord} from "../../planner/src/shot-reuse";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {emptyLivingScriptProposals,createLivingScriptProposal} from "../../planner/src/living-script-proposals";
import {createLivingScriptJobPlan,validateLivingScriptJobPlan,assertLivingScriptGenerationCurrent} from "../../planner/src/living-script-jobs";
import {copyReusableClip,verifySealedClip} from "../src/shot-reuse";
import type {Job} from "../src/index";

let fixture:Awaited<ReturnType<typeof dubStudio>>,binding:EditSourceBinding,record:ShotRenderRecord,context:RetainedShotReuse;
beforeAll(async()=>{
  fixture=await dubStudio();const source=await inspectEditSource(fixture.film,"Original retained speech",fixture.paths.artifactRoot,async()=>{}),original=bindOriginalEditSource(source);
  let library=fixture.projects.createEditSequence(fixture.owner.token,[source],"reuse-parent","Short carrier export",source.facts.id,320,180,0,Date.now(),[original])!;
  library=fixture.projects.changeEditSequence(fixture.owner.token,"reuse-parent",{kind:"edit",label:"Retain a short visible cut",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-source.facts.frames,ripple:true}},library.version,library.sequences[0]!.history.revision)!;
  const route=fixture.base+"/editorial/sequences/reuse-parent/renders",quoteResponse=await fixture.call(route,"GET",undefined,fixture.owner.token);expect(quoteResponse.status).toBe(200);
  const quote=await quoteResponse.json() as {sequence:{historyRevision:string};sourceBindingsRevision:string;engineVersion:string;review:Record<string,unknown>};
  expect((await fixture.call(route,"POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}},fixture.owner.token)).status).toBe(202);
  const done=(await fixture.worker())!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");
  binding=bindRetainedEditSource(done,source.revision);assertEditBindingAvailable(binding,done);record=fixture.film.output!.shotRenders![0]!;context=compileRetainedShotReuse(record,binding);
},180000);
afterAll(async()=>{await fixture?.close();});
const destination=(label:string):Job=>({...structuredClone(fixture.film),id:label+"-"+crypto.randomUUID()});
const signal=()=>new AbortController().signal;
async function withoutOriginal<T>(run:()=>Promise<T>):Promise<T>{
  const root=realpathSync(fixture.paths.artifactRoot),source=realpathSync(join(root,fixture.film.projectId,fixture.film.id)),hidden=source+"-retained-reuse-hidden";
  if(source!==resolve(root,fixture.film.projectId,fixture.film.id)||!source.startsWith(root+sep)||!hidden.startsWith(root+sep)||existsSync(hidden))throw new Error("Unsafe retained reuse fixture move.");
  renameSync(source,hidden);try{return await run();}finally{renameSync(hidden,source);}
}

test("copying from a real editorial carrier survives missing original files and preserves original shot provenance",async()=>{
  const root=fixture.paths.artifactRoot,files=retainedShotReuseFiles(context),before=contentHash(context),job=destination("retained-copy");
  await withoutOriginal(async()=>{
    await expect(copyReusableClip(record,destination("missing-original"),root,signal())).rejects.toThrow("unavailable");
    const copied=await copyReusableClip(record,job,root,signal(),undefined,context),result=copied.renderRecord!;
    expect(result.jobId).toBe(job.id);expect(result.origin).toEqual(record.origin);expect(result.reusedFrom).toEqual({jobId:record.jobId,shotId:record.shotId,revision:record.revision});expect(result.clip).toEqual(record.clip);
    for(const [role,file]of Object.entries(result.files)){expect(file.path).toStartWith(job.projectId+"/"+job.id+"/clips/");expect([file.sha256,file.bytes]).toEqual([files[role as keyof typeof files]!.sha256,files[role as keyof typeof files]!.bytes]);expect(readFileSync(join(root,file.path))).toEqual(readFileSync(join(root,files[role as keyof typeof files]!.path)));}
    expect(copied.cost.total_cost_usd).toBe(0);expect(contentHash(context)).toBe(before);
    const data={projectId:job.projectId,shots:[record],forceShotIds:[]},admitted={...job,shotReuse:{schema:"hv-shot-reuse/1" as const,...data,revision:contentHash(data)}};
    assertRenderedOrigin(result,admitted);await verifySealedClip(admitted,renderShots(job).find(shot=>shot.id===record.shotId)!,copied,root,signal());
  });
},30000);

test("retained remote reads use the carrier owner and mapped keys, while ordinary five-argument reads preserve original identities",async()=>{
  const root=fixture.paths.artifactRoot,requests:{project:string;job:string;key:string}[]=[],mapped=retainedShotReuseFiles(context);
  const artifacts={response:async(project:string,job:string,key:string)=>{requests.push({project,job,key});const file=binding.files.find(file=>file.path===key)??Object.values(record.files).find(file=>file.path===key)!;return new Response(new Uint8Array(readFileSync(join(root,key))),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});}};
  await withoutOriginal(async()=>{const copied=await copyReusableClip(record,destination("retained-remote"),root,signal(),artifacts,context);expect(copied.renderRecord!.reusedFrom!.jobId).toBe(record.jobId);expect(requests).toEqual(Object.values(mapped).map(file=>({project:binding.owner.projectId,job:binding.owner.jobId,key:file.path})));});
  requests.length=0;const ordinary=await copyReusableClip(record,destination("ordinary-remote"),root,signal(),artifacts);expect(requests).toEqual(Object.values(record.files).map(file=>({project:record.projectId,job:record.jobId,key:file.path})));expect(ordinary.renderRecord!.origin).toEqual(record.origin);
},30000);

test("mismatched retained context or destination project fails before creating a copy directory",async()=>{
  const root=fixture.paths.artifactRoot;
  for(const [changedRecord,changedJob,changedContext]of [[fixture.film.output!.shotRenders![1]!,destination("other-record"),context],[record,{...destination("foreign"),projectId:"foreign-project"},context],[record,destination("forged-context"),{...context,revision:"a".repeat(64)}]] as const){
    await expect(copyReusableClip(changedRecord,changedJob,root,signal(),undefined,changedContext)).rejects.toThrow();expect(existsSync(join(root,changedJob.projectId,changedJob.id))).toBe(false);
  }
  const aborted=new AbortController(),job=destination("aborted");aborted.abort(new Error("Stop retained copy"));await expect(copyReusableClip(record,job,root,aborted.signal,undefined,context)).rejects.toThrow("Stop retained copy");expect(existsSync(join(root,job.projectId,job.id))).toBe(false);
});

test("tampered carrier bytes fail checksum or size verification without leaving partial copy files",async()=>{
  const root=fixture.paths.artifactRoot,file=retainedShotReuseFiles(context).video,path=join(root,file.path),original=readFileSync(path);
  try{
    const changed=Buffer.from(original);changed[changed.length-1]^=1;writeFileSync(path,changed);const job=destination("tampered-carrier");
    await expect(copyReusableClip(record,job,root,signal(),undefined,context)).rejects.toThrow("checksum");expect(readdirSync(join(root,job.projectId,job.id,"clips"))).toEqual([]);
    writeFileSync(path,Buffer.concat([original,Buffer.from([1])]));const oversized=destination("oversized-carrier");await expect(copyReusableClip(record,oversized,root,signal(),undefined,context)).rejects.toThrow("recorded size");expect(readdirSync(join(root,oversized.projectId,oversized.id,"clips"))).toEqual([]);
  }finally{writeFileSync(path,original);}
});

test("new pending generation survives original expiry through a real retained carrier while historical restore grants no renewed access",()=>{
  const source=binding.source,carrier=fixture.store.get(binding.owner.jobId)!,project=structuredClone(fixture.projects.snapshot().projects.find(value=>value.id===fixture.owner.projectId)!);
  // Both expiries come from actual worker completions. The later editorial render naturally
  // supplies a short interval in which its independently owned files outlive the original film.
  const originalExpiry=Date.parse(source.job.linkExpiresAt!),retainedExpiry=Date.parse(carrier.linkExpiresAt!),now=originalExpiry+1;
  // Keep the detached project's retention current independently of its media. This test changes
  // neither source/carrier completion and expiry nor the real saved rights attestation.
  project.deleteAfter=new Date(retainedExpiry+86400000).toISOString();
  expect(now).toBeLessThan(retainedExpiry);expect(Date.parse(project.deleteAfter)).toBeGreaterThan(retainedExpiry+1);expect(project.rightsAttestedAt).not.toBeNull();
  expect(binding.owner.linkExpiresAt).toBe(carrier.linkExpiresAt!);expect(binding.owner.jobId).not.toBe(source.job.id);
  const originalState=contentHash(project),library=project.editLibrary!,parent=deriveEditAssemblyParent(project.id,library,"reuse-parent"),index=compileEditScriptSource(source),entry=index.entries.find(value=>value.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:project.versions.at(-1)!.version,text:project.versions.at(-1)!.text},replacement:"Welcome back to the garden."}),impact=compileLivingScriptGenerationImpact(source,patch,{...source.job,scriptVersion:patch.after.version,scriptText:patch.after.text},now);
  const navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]),request={id:"retained-pending-line",label:"Revise after original retention ends",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,editorialRevision:library.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}};
  const saved=createLivingScriptProposal(emptyLivingScriptProposals(project.id),project.id,library,request,0,now),current={...project,livingScriptProposals:saved.library},before=contentHash(current);
  const plan=createLivingScriptJobPlan(saved.proposal,binding,{role:"render"},now);
  expect(plan.binding).toEqual(binding);expect(plan.shotReuse.shots).toEqual(impact.reusableRecords);expect(plan.shotReuse.shots.length).toBeGreaterThan(0);expect(plan.inputs.scriptText).toBe(patch.after.text);
  expect(()=>assertLivingScriptGenerationCurrent(plan,current,carrier,now)).not.toThrow();expect(current.versions.at(-1)!.text).toBe(patch.before.text);expect(current.editLibrary).toEqual(library);
  expect(()=>createLivingScriptJobPlan(saved.proposal,bindOriginalEditSource(source),{role:"render"},now)).toThrow("unavailable");
  expect(()=>assertLivingScriptGenerationCurrent(plan,current,source.job,now)).toThrow();expect(()=>assertLivingScriptGenerationCurrent(plan,current,undefined,now)).toThrow();expect(()=>assertLivingScriptGenerationCurrent(plan,current,{...carrier,status:"cancelled"},now)).toThrow();
  expect(()=>assertLivingScriptGenerationCurrent(plan,{...current,rightsAttestedAt:null},carrier,now)).toThrow("unavailable");
  const expired=retainedExpiry+1,clock=spyOn(Date,"now").mockReturnValue(expired);
  try{
    expect(validateLivingScriptJobPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(()=>createLivingScriptJobPlan(saved.proposal,binding,{role:"render"},expired)).toThrow("unavailable");expect(()=>assertLivingScriptGenerationCurrent(plan,current,carrier,expired)).toThrow("unavailable");
  }finally{clock.mockRestore();}
  expect(contentHash(project)).toBe(originalState);expect(contentHash(current)).toBe(before);
});
