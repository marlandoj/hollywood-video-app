import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync,mkdirSync} from "node:fs";
import {join,sep} from "node:path";
import {tmpdir} from "node:os";
import {ProjectService} from "../../api/src/index";
import type {Job} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {renderRecord,renderInputHash,renderShots} from "../../planner/src/shot-reuse";
import {editFactsRevision,editSourceAudio,editSourceLanguage,editSourceKnownFiles,editSourceRequiredPaths,editSourceVoiceWindows,validateEditSourceReceipt} from "../../planner/src/edit-sources";
import {EDIT_AUDIO_LANES} from "../../planner/src/edit-timeline";
import {changeEditSequence,createEditSequence,emptyEditLibrary} from "../../planner/src/edit-library";
import {editHistoryState} from "../../planner/src/edit-history";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {acceptEditAssemblyProposal,createEditAssemblyProposal,emptyEditAssemblyLibrary,reviseEditAssemblyProposal} from "../../planner/src/edit-assembly-proposals";
import {createEditAssemblyRenderPlan,editAssemblyRenderReview} from "../../planner/src/edit-assembly-jobs";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {readStateSnapshot,snapshotUsesComposite,stateSnapshotSchema,validateSnapshot,writeStateSnapshot,type StateSnapshot} from "../src/snapshots";

const now=Date.parse("2026-09-08T00:00:00.000Z"),bytes=Buffer.from("assembly-original"),sha=Bun.CryptoHasher.hash("sha256",bytes,"hex");
const seal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};
function fixture():StateSnapshot{
  process.env.HV_TOKEN_SECRET="assembly-snapshot-fixture-secret-over-thirty-two-characters";
  const service=new ProjectService(),owner=service.createAnonymousProject(now),projectId=owner.projectId,id="original",scriptText="EXT. FIELD - DAY\n\nGrass moves.";
  service.editScript(owner.token,scriptText,now);service.attestRights(owner.token,now);
  const job:Job={id,idempotencyKey:id,projectId,tier:"free",stage:"animatic",scriptVersion:1,scriptText,status:"done",queueAction:"run",queueReason:"capacity_available",queuedBehind:[],checkpointFrame:0,checkpointShots:0,totalFrames:60,retryPolicy:{maxRetries:0,backoffMs:0},retriesUsed:0,timeoutMs:60000,costCapUsd:5,budgetReservedUsd:0,costUsd:0,rightsAttestedAt:new Date(now).toISOString(),animaticJobId:null,animaticApprovedAt:null,nextEligibleAt:null,startedAt:new Date(now+1000).toISOString(),leaseExpiresAt:null,claimedBy:null,resumedCount:0,completedAt:new Date(now+2000).toISOString(),linkExpiresAt:"2099-01-01T00:00:00.000Z",notifications:[],providerPlan:createProviderPlan("animatic",5,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["legacy-mock"]'})};
  const file=(path:string)=>({path,bytes:bytes.length,sha256:sha}),shots=renderShots(job,now+1000),records=shots.map(shot=>renderRecord({projectId,jobId:id,shotId:shot.id,inputHash:renderInputHash(job,shot),origin:{jobId:id,shotId:shot.id},clip:{provider:"mock",model:"metadata-fixture",seed:shot.seed,durationSec:2,fingerprint:sha,audioMode:"silent-captioned"},files:{video:file(`${projectId}/${id}/clips/${shot.id}.mp4`)}}));
  job.output={mp4Path:`${projectId}/${id}/export.mp4`,captionsPath:`${projectId}/${id}/captions.vtt`,manifestPath:`${projectId}/${id}/provenance.json`,hlsPlaylistPath:`${projectId}/${id}/hls/index.m3u8`,shotRenders:records};
  const audio=editSourceAudio(job),facts={id,label:"Frozen original",revision:editFactsRevision(job,60,64,48,[]),frames:60,width:64,height:48,audio:EDIT_AUDIO_LANES.filter(lane=>audio[lane]),captions:[],...editSourceVoiceWindows(job)},files=new Map(editSourceKnownFiles(job).map(f=>[f.path,f]));for(const path of editSourceRequiredPaths(job))if(!files.has(path))files.set(path,file(path));
  const receipt=validateEditSourceReceipt(seal({schema:"hv-edit-source/1" as const,job,facts,audio,files:[...files.values()],language:editSourceLanguage(job),revision:""})),editorial=createEditSequence(emptyEditLibrary(),projectId,[receipt],"parent","Saved parent",id,64,48,0,now+3000),parent=deriveEditAssemblyParent(projectId,editorial,"parent");
  let library=createEditAssemblyProposal(emptyEditAssemblyLibrary(),{id:"proposal",label:"First assembly",purpose:"custom",ranges:[{id:"opening",fromFrame:10,toFrame:30,reason:"Keep the opening."}]},parent,0,now+4000);
  const proposal=library.proposals[0]!;library=acceptEditAssemblyProposal(library,proposal.id,proposal.revision,"accepted",parent,1,now+5000).library;
  library=reviseEditAssemblyProposal(library,proposal.id,{label:"Revised proposal",purpose:"trailer",ranges:[{id:"closing",fromFrame:40,toFrame:60,reason:"Lead with the close."}]},parent,2,proposal.revision);
  const projects=service.snapshot();projects.projects[0]!.editLibrary=editorial;projects.projects[0]!.assemblyLibrary=library;
  return {schema:"hv-state/7",projects,jobs:[job],ledger:{events:[],reservations:[]},reviews:[]};
}
function scratch(){const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-assembly-snapshot-")));return {root,close(){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-assembly-snapshot-"))throw new Error("Unsafe assembly snapshot cleanup");rmSync(root,{recursive:true,force:true});}};}

test("historical synthetic originals retain the schema six gate for abandoned mask branches",()=>{
  // This fixture predates execution capture; real worker receipts keep all their evidence.
  const snapshot=fixture(),project=snapshot.projects.projects[0]!;delete project.assemblyLibrary;
  expect(snapshot.jobs[0]!.executionCheckpoints).toBeUndefined();expect(snapshot.jobs[0]!.output!.shotExecutions).toBeUndefined();
  let library=project.editLibrary!,sequence=library.sequences[0]!,picture=editHistoryState(sequence.history).timeline.clips.find(clip=>clip.lane==="picture")!;
  library=changeEditSequence(library,project.id,sequence.id,{kind:"edit",label:"Historical mask",operation:{kind:"composite",clipId:picture.id,composite:{schema:"hv-edit-composite/1",masks:[{id:"historical",label:"Historical rectangle",kind:"rectangle",sourceRevision:library.sources[0]!.facts.revision,combine:"replace",invert:false,featherQ8:0,keyframes:[{sourceFrame:0,interpolation:"hold",geometry:{xQ16:0,yQ16:0,widthQ16:32768,heightQ16:65536}}]}]}}},library.version,sequence.history.revision,now+6000);
  sequence=library.sequences[0]!;const maskedHead=editHistoryState(sequence.history).head;
  project.editLibrary=changeEditSequence(library,project.id,sequence.id,{kind:"cursor",target:0,reason:"undo",label:"Retain abandoned mask"},library.version,sequence.history.revision,now+7000);
  snapshot.schema="hv-state/6";expect(editHistoryState(project.editLibrary.sequences[0]!.history).timeline.schema).toBe("hv-edit-timeline/1");expect(snapshotUsesComposite(snapshot.projects,snapshot.jobs)).toBe(true);expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/6");
  const restored=validateSnapshot(JSON.parse(JSON.stringify(snapshot)));for(const schema of ["hv-state/4","hv-state/5"] as const)expect(()=>validateSnapshot({...restored,schema})).toThrow("schema 6");
  library=restored.projects.projects[0]!.editLibrary!;sequence=library.sequences[0]!;const selected=changeEditSequence(library,project.id,sequence.id,{kind:"cursor",target:maskedHead,reason:"branch",label:"Restore historical mask"},library.version,sequence.history.revision,now+8000);
  expect(editHistoryState(selected.sequences[0]!.history).timeline.clips.find(clip=>clip.id===picture.id)!.composite!.masks![0]!.sourceRevision).toBe(library.sources[0]!.facts.revision);
});

test("schema seven retains current proposals and accepted older revisions after the current parent is removed",()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!,before=contentHash(project.assemblyLibrary);
  project.editLibrary=seal({...project.editLibrary!,sequences:[]});expect(validateSnapshot(snapshot)).toBe(snapshot);expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/7");
  expect(project.assemblyLibrary!.proposals[0]!.revision).not.toBe(project.assemblyLibrary!.assemblies[0]!.proposalRevision);expect(contentHash(project.assemblyLibrary)).toBe(before);
  const f=scratch();try{writeStateSnapshot(join(f.root,"saved"),snapshot);expect(readStateSnapshot(join(f.root,"saved"))).toEqual(snapshot);}finally{f.close();}
  for(const schema of ["hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6"] as const)expect(()=>validateSnapshot({...snapshot,schema})).toThrow("schema 7");
});

test("proposal-only recovery requires schema seven while empty and absent libraries preserve legacy schema and bytes",()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!;project.assemblyLibrary=seal({...project.assemblyLibrary!,assemblies:[]});expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/7");expect(()=>validateSnapshot({...snapshot,schema:"hv-state/6"})).toThrow("schema 7");
  delete project.assemblyLibrary;snapshot.schema="hv-state/4";const before=JSON.stringify(snapshot);expect(validateSnapshot(snapshot)).toEqual(snapshot);expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/4");expect(JSON.stringify(snapshot)).toBe(before);
  project.assemblyLibrary=emptyEditAssemblyLibrary();expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/4");expect(validateSnapshot(snapshot)).toBe(snapshot);
  delete project.editLibrary;snapshot.schema="hv-state/1";expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/1");expect(validateSnapshot(snapshot)).toBe(snapshot);expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs,true)).toBe("hv-state/2");
  const f=scratch();try{writeStateSnapshot(join(f.root,"legacy"),snapshot);expect(readStateSnapshot(join(f.root,"legacy"))).toEqual(snapshot);expect(JSON.parse(readFileSync(join(f.root,"legacy/snapshot.json"),"utf8")).schema).toBe("hv-state/1");}finally{f.close();}
});

test("restore rejects missing, foreign and substituted frozen-parent receipts and malformed collections",()=>{
  for(const accepted of [false,true]){
    const snapshot=fixture(),project=snapshot.projects.projects[0]!,library=project.assemblyLibrary!,item=(accepted?library.assemblies:library.proposals)[0]!;item.plan.parent.sourceReceipts[0]!.receiptRevision=contentHash("missing");
    expect(()=>validateSnapshot(snapshot)).toThrow();
  }
  const missing=fixture(),p=missing.projects.projects[0]!;p.editLibrary=seal({...p.editLibrary!,sources:[],sequences:[]});expect(()=>validateSnapshot(missing)).toThrow("owned original");
  const foreign=fixture(),source=foreign.projects.projects[0]!.editLibrary!.sources[0]!;source.job.projectId="foreign";expect(()=>validateSnapshot(foreign)).toThrow();
  const tampered=fixture(),parent=tampered.projects.projects[0]!.assemblyLibrary!.assemblies[0]!.plan.parent;parent.timeline.clips[0]!.opacity=.5;expect(()=>validateSnapshot(tampered)).toThrow("changed");
  for(const value of [null,{},[],{proposals:null,assemblies:[]},{proposals:[],assemblies:null}]){const invalid=fixture();invalid.projects.projects[0]!.assemblyLibrary=value as any;expect(()=>validateSnapshot(invalid)).toThrow();}
});

test("schema seven permits earlier effect gates but does not admit assembly media as ordinary pictureEdit jobs",()=>{
  const snapshot=fixture(),p=snapshot.projects.projects[0]!;p.graphicLibrary={schema:"invalid"} as any;expect(()=>validateSnapshot(snapshot)).not.toThrow("schema 5");
  delete p.graphicLibrary;const invalid=structuredClone(snapshot);invalid.jobs[0]!.stage="picture-edit";expect(()=>validateSnapshot(invalid)).toThrow("reviewed timeline");
});

test("Python schema seven archive invokes the canonical validator and keeps originals used only by a frozen parent",async()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!;project.editLibrary=seal({...project.editLibrary!,sequences:[]});const f=scratch();
  try{
    const source=join(f.root,"source"),target=join(f.root,"restored"),archive=join(f.root,"assembly.zip");writeStateSnapshot(source,snapshot);
    for(const file of project.editLibrary.sources[0]!.files){const path=join(source,"artifacts",file.path);mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,bytes);}
    const run=async(args:string[])=>{const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,stdout,stderr};};
    const packed=await run(["pack","--source",source,"--output",archive,"--project",project.id]);expect(packed.stderr).toBe("");expect(packed.status).toBe(0);
    const unpacked=await run(["unpack","--source",archive,"--output",target]);expect(unpacked.stderr).toBe("");expect(unpacked.status).toBe(0);expect(readStateSnapshot(target)).toEqual(snapshot);
    for(const file of project.editLibrary.sources[0]!.files)expect(readFileSync(join(target,"artifacts",file.path))).toEqual(bytes);
    const bad=structuredClone(snapshot);bad.projects.projects[0]!.assemblyLibrary!.proposals[0]!.plan.ranges[0]!.reason="A changed sealed reason";writeFileSync(join(source,"state/projects.json"),JSON.stringify(bad.projects));
    const rejected=await run(["pack","--source",source,"--output",join(f.root,"invalid.zip"),"--project",project.id]);expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain("invalid sealed assembly");
    const invalid=structuredClone(snapshot),library=invalid.projects.projects[0]!.assemblyLibrary!,proposal=library.proposals[0]!;library.assemblies=[];proposal.plan.parent.timeline.clips[0]!.opacity=2;
    proposal.plan.parent.timeline=seal(proposal.plan.parent.timeline);proposal.plan=seal(proposal.plan);library.proposals[0]=seal(proposal);invalid.projects.projects[0]!.assemblyLibrary=seal(library);
    writeFileSync(join(source,"state/projects.json"),JSON.stringify(invalid.projects));const invalidRecipe=await run(["pack","--source",source,"--output",join(f.root,"invalid-recipe.zip"),"--project",project.id]);expect(invalidRecipe.status).not.toBe(0);expect(invalidRecipe.stderr).toContain("invalid sealed assembly");
  }finally{f.close();}
},60000);

test("Python validates cancelled assembly job plans without a current assembly library and preserves their original files",async()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!,assembly=project.assemblyLibrary!.assemblies[0]!,binding=bindOriginalEditSource(project.editLibrary!.sources[0]!);
  const plan=createEditAssemblyRenderPlan(assembly,[binding],"ffmpeg-sound-"+contentHash("retained-test-runtime"),"local",contentHash("cancelled-request"),editAssemblyRenderReview(assembly,[binding]),now+6000),{output:_output,providerPlan:_providerPlan,...origin}=snapshot.jobs[0]!;
  snapshot.jobs.push({...origin,id:"cancelled-assembly",idempotencyKey:"cancelled-assembly",stage:"assembly-edit",status:"cancelled",totalFrames:assembly.plan.frames,costCapUsd:0,assemblyEdit:plan,startedAt:null,completedAt:null,linkExpiresAt:null});delete project.assemblyLibrary;
  expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/7");expect(validateSnapshot(snapshot)).toBe(snapshot);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/6"})).toThrow("schema 7");
  for(const status of ["queued","running"] as const){const active=structuredClone(snapshot);active.jobs[1]!.status=status;expect(()=>validateSnapshot(active)).toThrow("drained");}
  const f=scratch();try{
    const source=join(f.root,"source"),target=join(f.root,"restored"),archive=join(f.root,"cancelled.zip");writeStateSnapshot(source,snapshot);
    for(const file of binding.source.files){const path=join(source,"artifacts",file.path);mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,bytes);}
    const run=async(args:string[])=>{const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [status,stderr]=await Promise.all([child.exited,new Response(child.stderr).text(),new Response(child.stdout).text()]);return {status,stderr};};
    const packed=await run(["pack","--source",source,"--output",archive,"--project",project.id]);expect(packed.stderr).toBe("");expect(packed.status).toBe(0);const unpacked=await run(["unpack","--source",archive,"--output",target]);expect(unpacked.stderr).toBe("");expect(unpacked.status).toBe(0);expect(readStateSnapshot(target)).toEqual(snapshot);
    for(const file of binding.source.files)expect(readFileSync(join(target,"artifacts",file.path))).toEqual(bytes);
    snapshot.jobs[1]!.assemblyEdit!.requestHash=contentHash("changed");writeFileSync(join(source,"queue/jobs.json"),JSON.stringify(snapshot.jobs));const rejected=await run(["pack","--source",source,"--output",join(f.root,"changed.zip"),"--project",project.id]);expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain("invalid sealed assembly");
  }finally{f.close();}
},60000);
