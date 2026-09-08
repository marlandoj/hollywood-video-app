import {afterAll,beforeAll,expect,test} from "bun:test";
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {tmpdir} from "node:os";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {editFrameHashes} from "../../generator/src/edit-conform";
import type {Job} from "../../queue/src/index";
import {createEditSequence} from "../../planner/src/edit-library";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {bindOriginalEditSource,bindRetainedEditSource,type EditSourceBinding} from "../../planner/src/edit-jobs";
import type {EditSourceReceipt} from "../../planner/src/edit-sources";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {createLivingScriptProposal,emptyLivingScriptProposals} from "../../planner/src/living-script-proposals";
import {createLivingScriptJobPlan} from "../../planner/src/living-script-jobs";
import {createLivingScriptPreviewReview} from "../../planner/src/living-script-job-context";
import {currentCasting,castingSnapshot} from "../../planner/src/casting";
import {currentDirection,directionSnapshot} from "../../planner/src/direction";
import {renderShots} from "../../planner/src/shot-reuse";
import {readStateSnapshot,stateSnapshotSchema,validateSnapshot,writeStateSnapshot,type StateSnapshot} from "../src/snapshots";

let studio:Awaited<ReturnType<typeof dubStudio>>,base:StateSnapshot,preview:Job,carrier:Job,binding:EditSourceBinding,previewReceipt:EditSourceReceipt;
const oldPool=process.env.HV_PROVIDER_POOL;
beforeAll(async()=>{
  process.env.HV_PROVIDER_POOL='["mock"]';studio=await dubStudio();
  expect((await studio.call(studio.base+"/animatic/decision","POST",{animaticJobId:studio.film.id,decision:"approved"},studio.owner.token)).status).toBe(201);
  expect((await studio.call(studio.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),stage:"final",animaticJobId:studio.film.id},studio.owner.token)).status).toBe(202);
  const film=(await studio.worker())!;expect(film.status).toBe("done");
  const source=await inspectEditSource(film,"Retained final original",studio.paths.artifactRoot,async()=>{}),original=bindOriginalEditSource(source),projectId=film.projectId;
  let library=studio.projects.createEditSequence(studio.owner.token,[source],"parent","Original cut",source.facts.id,320,180,0,Date.now(),[original])!;
  library=studio.projects.changeEditSequence(studio.owner.token,"parent",{kind:"edit",label:"Short visible cut",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-source.facts.frames,ripple:true}},library.version,library.sequences[0]!.history.revision)!;
  const route=studio.base+"/editorial/sequences/parent/renders",quote=await(await studio.call(route,"GET",undefined,studio.owner.token)).json() as any;
  expect((await studio.call(route,"POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}},studio.owner.token)).status).toBe(202);
  carrier=(await studio.worker())!;expect(carrier.status).toBe("done");binding=bindRetainedEditSource(carrier,source.revision);
  const projects=studio.projects.snapshot(),project=projects.projects[0]!,at=Date.now(),parent=deriveEditAssemblyParent(projectId,library,"parent"),index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:film.scriptVersion,text:film.scriptText},replacement:"Welcome back to the garden."}),impact=compileLivingScriptGenerationImpact(source,patch,{...film,scriptVersion:patch.after.version,scriptText:patch.after.text},at),navigation=projectEditScriptNavigation("parent",parent.historyRevision,parent.timeline,[index]);
  const saved=createLivingScriptProposal(emptyLivingScriptProposals(projectId),projectId,library,{id:"pending-line",label:"Reviewed pending line",sequenceId:"parent",historyRevision:parent.historyRevision,editorialRevision:library.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline:{casting:currentCasting(projectId,project.castingHistory),direction:currentDirection(projectId,project.directionHistory)}},0,at);
  project.livingScriptProposals=saved.library;
  const plan=createLivingScriptJobPlan(saved.proposal,binding,{role:"preview",providerPlan:studio.film.providerPlan!},at);
  // Existing normal routes supply physical media. Recovery starts from the detached original
  // project, so the pending candidate version is deliberately absent from committed versions.
  expect((await studio.call(studio.base+"/script","PUT",{text:patch.after.text},studio.owner.token)).status).toBe(200);
  expect((await studio.call(studio.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true,forceShotIds:plan.shotReuse.forceShotIds},studio.owner.token)).status).toBe(202);
  const actual=(await studio.worker())!;expect(actual.failureReason??actual.cancelReason).toBeUndefined();expect(actual.status).toBe("done");preview={...actual,livingScript:plan};previewReceipt=await inspectEditSource(preview,"Pending candidate preview",studio.paths.artifactRoot,async()=>{});
  const cast=preview.casting??castingSnapshot(projectId,0,[],0),direction=preview.direction??directionSnapshot(projectId,0,[],0);
  project.animaticApprovals.push({animaticJobId:preview.id,scriptVersion:preview.scriptVersion,decision:"approved",note:"Reviewed exact pending preview",at:new Date(Date.parse(preview.completedAt!)+1).toISOString(),castingVersion:cast.version,castingRevision:cast.revision,directionVersion:direction.version,directionRevision:direction.revision,livingScriptReview:createLivingScriptPreviewReview(preview)});
  base={schema:"hv-state/10",projects,jobs:[carrier,preview],ledger:JSON.parse(readFileSync(studio.paths.costLedgerPath,"utf8")),reviews:[]};validateSnapshot(base);
},180000);
afterAll(async()=>{await studio?.close();if(oldPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=oldPool;});
const fixture=()=>structuredClone(base);
function scratch(){const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-pending-snap-")));return {root,close(){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-pending-snap-"))throw new Error("Unsafe pending recovery cleanup");rmSync(root,{recursive:true,force:true});}};}
function reordered(value:unknown):unknown{return Array.isArray(value)?value.map(reordered):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reordered(item)])):value;}
async function python(args:string[]){const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,stdout,stderr};}
function prepare(root:string,snapshot:StateSnapshot){writeStateSnapshot(root,snapshot);for(const job of [carrier,preview]){const target=join(root,"artifacts",job.projectId,job.id);mkdirSync(join(root,"artifacts",job.projectId),{recursive:true});cpSync(join(studio.paths.artifactRoot,job.projectId,job.id),target,{recursive:true});}}

test("pending jobs and decisions require schema ten without committing the proposed next screenplay",()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!;expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/10");expect(project.versions.some(version=>version.version===preview.scriptVersion)).toBe(false);expect(validateSnapshot(snapshot)).toBe(snapshot);
  for(const schema of ["hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9"] as const)expect(()=>validateSnapshot({...snapshot,schema})).toThrow("schema 10");
  snapshot.jobs=snapshot.jobs.filter(job=>job.id!==preview.id);project.animaticApprovals=project.animaticApprovals.filter(approval=>!approval.livingScriptReview);expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/8");snapshot.schema="hv-state/8";expect(validateSnapshot(snapshot)).toBe(snapshot);
});

test("reordered JSON preserves pending proposal, original history and decision through disk after later script edits",()=>{
  const snapshot=reordered(fixture()) as StateSnapshot,project=snapshot.projects.projects[0]!,before=project.versions.at(-1)!;
  project.versions.push({version:before.version+1,parentVersion:before.version,text:before.text+"\nLater unrelated revision.",createdAt:new Date(Date.parse(preview.completedAt!)+2000).toISOString()});project.castingHistory=[];project.directionHistory=[];
  const serialized=JSON.stringify(snapshot),f=scratch();try{expect(validateSnapshot(snapshot)).toBe(snapshot);expect(JSON.stringify(snapshot)).toBe(serialized);writeStateSnapshot(join(f.root,"state"),snapshot);expect(readStateSnapshot(join(f.root,"state"))).toEqual(snapshot);}finally{f.close();}
  const lost=structuredClone(snapshot);lost.projects.projects[0]!.versions=project.versions.slice(1);expect(()=>validateSnapshot(lost)).toThrow();
});

test("nested retained pending originals cannot hide the schema marker or forge their generation context",()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!;project.editLibrary=createEditSequence(project.editLibrary!,project.id,[previewReceipt],"preview-cut","Retained pending candidate",previewReceipt.facts.id,320,180,project.editLibrary!.version,Date.parse(preview.completedAt!)+2);
  snapshot.jobs=snapshot.jobs.filter(job=>job.id!==preview.id);expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/10");expect(validateSnapshot(snapshot)).toBe(snapshot);
  expect(()=>validateSnapshot({...snapshot,schema:"hv-state/9"})).toThrow("schema 10");
  const stripped=structuredClone(snapshot);stripped.jobs.push({...structuredClone(preview),livingScript:undefined});expect(()=>validateSnapshot(stripped)).toThrow("different pending");
  project.editLibrary.sources.find(source=>source.job.id===preview.id)!.job.livingScript!.inputs.scriptText+="!";expect(()=>validateSnapshot(snapshot)).toThrow();
});

test("forged jobs, output records, missing proposals and historical preview approvals fail closed",()=>{
  const changes:Array<(snapshot:StateSnapshot)=>void>=[
    snapshot=>{snapshot.jobs[1]!.scriptText+="!";},snapshot=>{snapshot.jobs[1]!.livingScript!.revision="a".repeat(64);},snapshot=>{delete snapshot.jobs[1]!.output!.shotRenders;},snapshot=>{snapshot.jobs[1]!.output!.shotRenders!.reverse();},
    snapshot=>{snapshot.projects.projects[0]!.livingScriptProposals=emptyLivingScriptProposals(preview.projectId);},snapshot=>{snapshot.jobs=snapshot.jobs.filter(job=>job.id!==preview.id);},
    snapshot=>{snapshot.projects.projects[0]!.animaticApprovals.at(-1)!.livingScriptReview!.outputRevision="a".repeat(64);},snapshot=>{snapshot.projects.projects[0]!.animaticApprovals.at(-1)!.directionRevision="a".repeat(64);},
    snapshot=>{delete snapshot.projects.projects[0]!.animaticApprovals.at(-1)!.livingScriptReview;},
    snapshot=>{snapshot.projects.projects[0]!.animaticApprovals.at(-1)!.at=preview.linkExpiresAt!;},snapshot=>{snapshot.projects.projects[0]!.animaticApprovals.at(-1)!.at=new Date(Date.parse(preview.completedAt!)-1).toISOString();},
    snapshot=>{snapshot.jobs[0]!.output!.captionsPath="forged";},snapshot=>{snapshot.jobs[1]!.livingScript=undefined;},
  ];for(const change of changes){const snapshot=fixture();change(snapshot);expect(()=>validateSnapshot(snapshot)).toThrow();}
  const rejected=fixture();rejected.projects.projects[0]!.animaticApprovals.at(-1)!.decision="changes_requested";expect(validateSnapshot(rejected)).toBe(rejected);
});

test("pending final restores only its exact historically valid preview approval and cannot lend it to a normal final",()=>{
  const snapshot=fixture(),proposal=preview.livingScript!.proposal,plan=createLivingScriptJobPlan(proposal,binding,{role:"render"},Date.parse(preview.livingScript!.createdAt)),approval=snapshot.projects.projects[0]!.animaticApprovals.at(-1)!;
  const failed:Job={...structuredClone(preview),...plan.inputs,id:"failed-pending-final",idempotencyKey:"failed-pending-final",livingScript:plan,shotReuse:plan.shotReuse,providerSpec:undefined,output:undefined,status:"failed",cost:undefined,costUsd:0,checkpointFrame:0,checkpointShots:0,totalFrames:renderShots(plan.inputs,Date.parse(plan.createdAt)).reduce((n,shot)=>n+Math.round(shot.durationSec*30),0),startedAt:approval.at,completedAt:approval.at,animaticJobId:preview.id,animaticApprovedAt:approval.at};snapshot.jobs.push(failed);expect(validateSnapshot(snapshot)).toBe(snapshot);
  const latest={...structuredClone(approval),decision:"changes_requested" as const,note:"Later owner review requests another pass",at:new Date(Date.parse(approval.at)+1).toISOString()};snapshot.projects.projects[0]!.animaticApprovals.unshift(latest);
  expect(snapshot.projects.projects[0]!.animaticApprovals.find(item=>item.animaticJobId===preview.id)!.decision).toBe("changes_requested");expect(validateSnapshot(snapshot)).toBe(snapshot);
  const f=scratch();try{writeStateSnapshot(join(f.root,"later-decision"),snapshot);expect(readStateSnapshot(join(f.root,"later-decision"))).toEqual(snapshot);}finally{f.close();}
  failed.animaticApprovedAt=new Date(Date.parse(approval.at)+1).toISOString();expect(()=>validateSnapshot(snapshot)).toThrow();failed.animaticApprovedAt=approval.at;failed.livingScript=undefined;expect(()=>validateSnapshot(snapshot)).toThrow("ordinary final");
},30000);

test("expired pending preview and carrier restore historically without renewing either media lifetime",()=>{
  const snapshot=fixture(),now=Date.now,previewExpiry=preview.linkExpiresAt,carrierExpiry=carrier.linkExpiresAt;
  Date.now=()=>Math.max(Date.parse(previewExpiry!),Date.parse(carrierExpiry!))+86400000;
  try{expect(validateSnapshot(snapshot)).toBe(snapshot);expect(snapshot.jobs[0]!.linkExpiresAt).toBe(carrierExpiry);expect(snapshot.jobs[1]!.linkExpiresAt).toBe(previewExpiry);}finally{Date.now=now;}
});

test("Python archive roundtrip is independent of removed original media and preserves exact pending state bytes",async()=>{
  const snapshot=reordered(fixture()) as StateSnapshot,f=scratch();try{
    const source=join(f.root,"source"),target=join(f.root,"restored"),archive=join(f.root,"pending.zip");prepare(source,snapshot);expect(existsSync(join(source,"artifacts",preview.projectId,binding.source.job.id))).toBe(false);
    const packed=await python(["pack","--source",source,"--output",archive,"--project",preview.projectId]);expect(packed.stderr).toBe("");expect(packed.status).toBe(0);const restored=await python(["unpack","--source",archive,"--output",target]);expect(restored.stderr).toBe("");expect(restored.status).toBe(0);
    expect(readStateSnapshot(target)).toEqual(snapshot);for(const file of ["state/projects.json","queue/jobs.json"])expect(readFileSync(join(source,file))).toEqual(readFileSync(join(target,file)));
    for(const file of binding.files)expect(readFileSync(join(target,"artifacts",file.path))).toEqual(readFileSync(join(studio.paths.artifactRoot,file.path)));
    expect(await inspectEditSource(preview,previewReceipt.facts.label,join(target,"artifacts"),async()=>{})).toEqual(previewReceipt);
    const hashes=await editFrameHashes(join(target,"artifacts",preview.output!.mp4Path),previewReceipt.facts.frames,join(f.root,"restored.hashes"),f.root,async()=>{}),original=await editFrameHashes(join(studio.paths.artifactRoot,preview.output!.mp4Path),previewReceipt.facts.frames,join(f.root,"original.hashes"),f.root,async()=>{});expect(hashes).toEqual(original);
  }finally{f.close();}
},120000);

test("Python rejects downgraded, forged and incomplete pending custody before publishing an archive",async()=>{
  const snapshot=fixture(),f=scratch();try{const source=join(f.root,"source");prepare(source,snapshot);const manifest=readFileSync(join(source,"snapshot.json"),"utf8"),jobs=readFileSync(join(source,"queue/jobs.json"));
    const reject=async(name:string,part:string)=>{const destination=join(f.root,name+".zip"),result=await python(["pack","--source",source,"--output",destination,"--project",preview.projectId]);expect(result.status).not.toBe(0);expect(result.stderr).toContain(part);expect(existsSync(destination)).toBe(false);};
    writeFileSync(join(source,"snapshot.json"),JSON.stringify({...JSON.parse(manifest),schema:"hv-state/9"}));await reject("downgrade","schema 10");writeFileSync(join(source,"snapshot.json"),manifest);
    const forged=fixture();forged.jobs[1]!.scriptText+="!";writeFileSync(join(source,"queue/jobs.json"),JSON.stringify(forged.jobs));await reject("context","invalid sealed pending screenplay jobs");writeFileSync(join(source,"queue/jobs.json"),jobs);
    writeFileSync(join(source,"queue/jobs.json"),JSON.stringify(snapshot.jobs.filter(job=>job.id!==carrier.id)));await reject("carrier","carrier job");writeFileSync(join(source,"queue/jobs.json"),jobs);
    const previewFile=Object.values(preview.output!.shotRenders![0]!.files)[0]!,previewPath=join(source,"artifacts",previewFile.path),previewBytes=readFileSync(previewPath);writeFileSync(previewPath,"corrupt");await reject("preview-bytes","shot media is missing or corrupt");writeFileSync(previewPath,previewBytes);
    const hls=join(source,"artifacts",preview.output!.hlsPlaylistPath),hlsBytes=readFileSync(hls);rmSync(hls);await reject("preview-hls","completed media is missing");writeFileSync(hls,hlsBytes);
    const path=join(source,"artifacts",binding.files[0]!.path);writeFileSync(path,"corrupt");await reject("bytes","missing or corrupt");
  }finally{f.close();}
},120000);
