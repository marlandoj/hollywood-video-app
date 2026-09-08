import {beforeAll,afterAll,expect,test} from "bun:test";
import {copyFileSync,cpSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,sep} from "node:path";
import {tmpdir} from "node:os";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {ProjectService,type PersistedProject} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {editFrameHashes} from "../../generator/src/edit-conform";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection,type DirectionSnapshot,type DirectionEntry} from "../../planner/src/direction";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {changeEditSequence,emptyEditLibrary} from "../../planner/src/edit-library";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {compileLivingScriptSourceMap} from "../../planner/src/living-script-source-map";
import {compileLivingScriptRecut,type LivingScriptRecutInput} from "../../planner/src/living-script-recut";
import {emptyLivingScriptProposals} from "../../planner/src/living-script-proposals";
import {emptyLivingScriptAcceptances} from "../../planner/src/living-script-acceptance-library";
import {readStateSnapshot,stateSnapshotSchema,validateSnapshot,writeStateSnapshot,type StateSnapshot} from "../src/snapshots";

let studio:Awaited<ReturnType<typeof dubStudio>>,base:StateSnapshot;
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};
beforeAll(async()=>{
  studio=await dubStudio();await pinDuration();
  expect((await studio.call(studio.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},studio.owner.token)).status).toBe(202);
  const film=(await studio.worker())!;expect(film.failureReason??film.cancelReason).toBeUndefined();expect(film.status).toBe("done");
  const projectId=studio.owner.projectId,source=await inspectEditSource(film,"Retained original screenplay",studio.paths.artifactRoot,async()=>{}),oldBinding=bindOriginalEditSource(source);
  studio.projects.createEditSequence(studio.owner.token,[source],"parent","Original saved cut",source.facts.id,320,180,0,Date.now(),[oldBinding]);const original=studio.projects.snapshot();
  const index=compileEditScriptSource(source),entry=index.entries.find(entry=>entry.kind==="dialogue")!,patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:film.scriptVersion,text:film.scriptText},replacement:"Welcome back to the garden.",protectedLines:[1]});
  expect((await studio.call(studio.base+"/script","PUT",{text:patch.after.text},studio.owner.token)).status).toBe(200);
  const direction=await pinDuration(),impact=compileLivingScriptGenerationImpact(source,patch,{...film,scriptVersion:patch.after.version,scriptText:patch.after.text,direction});
  expect((await studio.call(studio.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},studio.owner.token)).status).toBe(202);
  const generatedJob=(await studio.worker())!;expect(generatedJob.failureReason??generatedJob.cancelReason).toBeUndefined();expect(generatedJob.status).toBe("done");
  const generated=await inspectEditSource(generatedJob,"Reviewed actual revised screenplay",studio.paths.artifactRoot,async()=>{}),sourceMap=compileLivingScriptSourceMap(source,patch,impact,generated),at=Date.parse(generatedJob.completedAt!);
  // The service under test starts from the actual pre-patch snapshot; a separate fixture factory
  // obtained generated media through existing APIs without claiming pending-job authority.
  const detached=ProjectService.fromState(original),current=detached.peekProject(projectId)!,parent=deriveEditAssemblyParent(projectId,current.editLibrary,"parent"),navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]),baseline={casting:currentCasting(projectId,current.castingHistory),direction:currentDirection(projectId,current.directionHistory)};
  const proposal=detached.createLivingScriptProposal(studio.owner.token,{id:"proposal",label:"Reviewed greeting",sequenceId:"parent",historyRevision:parent.historyRevision,editorialRevision:current.editLibrary.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline},0,[{binding:oldBinding,current:film}],at)!.proposal;
  const recutInput:LivingScriptRecutInput={projectId,library:current.editLibrary,sequenceId:"parent",historyRevision:parent.historyRevision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,generated,sourceMap,operations:[{kind:"replace",clipId:"initial-0",linked:true,sourceId:generated.facts.id,from:0,frames:generated.facts.frames,timing:"preserve",ripple:false}],newSequenceId:"accepted-cut"},recut=compileLivingScriptRecut(recutInput,at+1);
  const accepted=detached.acceptLivingScriptProposal(studio.owner.token,proposal.request.id,proposal.revision,{id:"acceptance",name:"Accepted revised cut",reviewRevision:recut.revision,baseline,recutInput,recut},0,[{binding:oldBinding,current:film},{binding:bindOriginalEditSource(generated),current:generatedJob}],at+2)!;expect(accepted.replayed).toBe(false);
  base={schema:"hv-state/11",projects:detached.snapshot(),jobs:[film,generatedJob],ledger:JSON.parse(readFileSync(studio.paths.costLedgerPath,"utf8")),reviews:[]};validateSnapshot(base);
},180000);
afterAll(async()=>{await studio?.close();});
async function pinDuration():Promise<DirectionSnapshot>{const review=await(await studio.call(studio.base+"/direction","GET",undefined,studio.owner.token)).json() as {direction:DirectionSnapshot;scriptVersion:number;plan:DirectionEntry[]},entry=review.plan.find(entry=>entry.source.id==="shot-1-1")!;const saved=await studio.call(studio.base+"/direction/shot-1-1","PUT",{settings:{durationFrames:180},expectedVersion:review.direction.version,expectedScriptVersion:review.scriptVersion,sourceHash:entry.sourceHash},studio.owner.token);expect(saved.status).toBe(200);return (await saved.json() as {direction:DirectionSnapshot}).direction;}
const fixture=()=>structuredClone(base);
function scratch(){const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-linked-snap-")));return {root,close(){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-linked-snap-"))throw new Error("Unsafe linked acceptance snapshot cleanup");rmSync(root,{recursive:true,force:true});}};}
function reordered(value:unknown):unknown{return Array.isArray(value)?value.map(reordered):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reordered(item)])):value;}
async function python(args:string[]){const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,stdout,stderr};}
function receipts(project:PersistedProject){return [...project.livingScriptProposals!.proposals.flatMap(proposal=>proposal.editorial.sources),...project.livingScriptAcceptances!.records.flatMap(record=>[...record.request.recutInput.library.sources,record.request.recutInput.generated])];}
function prepare(root:string,snapshot:StateSnapshot){writeStateSnapshot(root,snapshot);for(const job of snapshot.jobs){mkdirSync(join(root,"artifacts",job.projectId),{recursive:true});cpSync(join(studio.paths.artifactRoot,job.projectId,job.id),join(root,"artifacts",job.projectId,job.id),{recursive:true});}for(const source of receipts(snapshot.projects.projects[0]!))for(const file of source.files){const path=join(root,"artifacts",file.path);mkdirSync(dirname(path),{recursive:true});copyFileSync(join(studio.paths.artifactRoot,file.path),path);}}
function forge(snapshot:StateSnapshot,change:(project:PersistedProject)=>void){const project=snapshot.projects.projects[0]!;change(project);const library=project.livingScriptAcceptances!;library.records=library.records.map(record=>reseal({...record,acceptance:reseal(record.acceptance)}));project.livingScriptAcceptances=reseal(library);return snapshot;}

test("linked acceptance and proposal-only state retain original execution evidence in schema eleven",()=>{
  const snapshot=fixture();expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/11");expect(validateSnapshot(snapshot)).toBe(snapshot);
  for(const schema of ["hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7","hv-state/8","hv-state/9","hv-state/10"] as const)expect(()=>validateSnapshot({...snapshot,schema})).toThrow("schema 11");
  const inventories=snapshot.jobs.map(job=>contentHash(job.output!.shotExecutions));delete snapshot.projects.projects[0]!.livingScriptAcceptances;
  expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/11");expect(validateSnapshot(snapshot)).toBe(snapshot);expect(snapshot.jobs.map(job=>contentHash(job.output!.shotExecutions))).toEqual(inventories);
});

test("JSONB reordering preserves the exact accepted project payload through snapshot and service restoration",()=>{
  const snapshot=reordered(fixture()) as StateSnapshot,serialized=JSON.stringify(snapshot),f=scratch();
  try{expect(validateSnapshot(snapshot)).toBe(snapshot);expect(JSON.stringify(snapshot)).toBe(serialized);writeStateSnapshot(join(f.root,"saved"),snapshot);const restored=readStateSnapshot(join(f.root,"saved"));expect(restored).toEqual(snapshot);
    expect(ProjectService.fromState(restored.projects).snapshot()).toEqual(restored.projects);expect(contentHash(restored.projects.projects[0]!.livingScriptAcceptances)).toBe(contentHash(base.projects.projects[0]!.livingScriptAcceptances));
  }finally{f.close();}
});

test("accepted prefixes survive later edits and rolling settings history without weakening retained version checks",()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!,record=project.livingScriptAcceptances!.records[0]!,at=Date.parse(record.acceptance.acceptedAt)+1000;
  for(const id of ["parent","accepted-cut"]){const library=project.editLibrary!,sequence=library.sequences.find(sequence=>sequence.id===id)!;project.editLibrary=changeEditSequence(library,project.id,id,{kind:"edit",operation:{kind:"marker",marker:{id:"later",frame:1,label:"Later note"}},label:"Later note"},library.version,sequence.history.revision,at);}
  const last=project.versions.at(-1)!;project.versions.push({version:last.version+1,parentVersion:last.version,text:last.text+"\n",createdAt:new Date(at).toISOString()});project.castingHistory=[];project.directionHistory=[];
  expect(validateSnapshot(snapshot)).toBe(snapshot);
  for(const version of [record.acceptance.beforeScript.version,record.acceptance.afterScript.version]){const missing=structuredClone(snapshot);missing.projects.projects[0]!.versions=project.versions.filter(item=>item.version!==version);expect(()=>validateSnapshot(missing)).toThrow();}
});

test("rehashed requests, baseline settings, proposal identity and parent or child prefixes cannot forge restoration",()=>{
  const changes:Array<(project:PersistedProject)=>void>=[
    project=>{project.versions.at(-1)!.text+="Changed";},project=>{project.livingScriptAcceptances!.records[0]!.acceptance.parent.historyRevision="a".repeat(64);},project=>{project.livingScriptAcceptances!.records[0]!.acceptance.sequence.historyRevision="a".repeat(64);},
    project=>{project.livingScriptAcceptances!.records[0]!.acceptance.afterDirectionRevision="a".repeat(64);},project=>{project.livingScriptAcceptances!.records[0]!.request.baseline.direction.createdAt="2000-01-01T00:00:00.000Z";},project=>{project.livingScriptAcceptances!.records[0]!.request.name="Unreviewed name";},project=>{project.livingScriptAcceptances!.records[0]!.proposalRevision="a".repeat(64);},
    project=>{project.editLibrary=reseal({...project.editLibrary!,sequences:project.editLibrary!.sequences.filter(sequence=>sequence.id!=="parent")});},project=>{project.editLibrary=reseal({...project.editLibrary!,sequences:project.editLibrary!.sequences.filter(sequence=>sequence.id!=="accepted-cut")});},
  ];for(const change of changes)expect(()=>validateSnapshot(forge(fixture(),change))).toThrow();
  const missing=fixture();delete missing.projects.projects[0]!.livingScriptProposals;expect(()=>validateSnapshot(missing)).toThrow("immutable screenplay proposal");
  const noCut=fixture();noCut.projects.projects[0]!.editLibrary=emptyEditLibrary();expect(()=>validateSnapshot(noCut)).toThrow("independently retained original sources");
},15000);

test("absent and sealed empty ledgers retain legacy schema and byte shape; malformed empties are rejected",()=>{
  const service=new ProjectService(),owner=service.createAnonymousProject(),snapshot:StateSnapshot={schema:"hv-state/1",projects:service.snapshot(),jobs:[],ledger:{events:[],reservations:[]},reviews:[]},project=snapshot.projects.projects[0]!;
  expect(project.livingScriptAcceptances).toBeUndefined();const serialized=JSON.stringify(snapshot);expect(validateSnapshot(snapshot)).toBe(snapshot);expect(JSON.stringify(snapshot)).toBe(serialized);
  project.livingScriptProposals=emptyLivingScriptProposals(owner.projectId);project.livingScriptAcceptances=emptyLivingScriptAcceptances(owner.projectId);expect(stateSnapshotSchema(snapshot.projects,[])).toBe("hv-state/1");expect(validateSnapshot(snapshot)).toBe(snapshot);
  for(const invalid of [null,{},[],{records:[],version:0},{...project.livingScriptAcceptances,revision:"a".repeat(64)}])for(const schema of ["hv-state/1","hv-state/9"] as const){const value=structuredClone(snapshot);value.schema=schema;value.projects.projects[0]!.livingScriptAcceptances=invalid as any;expect(()=>validateSnapshot(value)).toThrow();}
});

test("schema eleven Python roundtrip retains exact project JSON and independently decoded original and generated media",async()=>{
  const snapshot=reordered(fixture()) as StateSnapshot,project=snapshot.projects.projects[0]!,f=scratch();
  try{const source=join(f.root,"source"),target=join(f.root,"restored"),archive=join(f.root,"accepted.hv.zip");prepare(source,snapshot);
    const packed=await python(["pack","--source",source,"--output",archive,"--project",project.id]);expect(packed.stderr).toBe("");expect(packed.status).toBe(0);const unpacked=await python(["unpack","--source",archive,"--output",target]);expect(unpacked.stderr).toBe("");expect(unpacked.status).toBe(0);
    expect(readStateSnapshot(target)).toEqual(snapshot);expect(readFileSync(join(target,"state/projects.json"))).toEqual(readFileSync(join(source,"state/projects.json")));
    const unique=new Map(receipts(project).map(receipt=>[receipt.revision,receipt]));let index=0;
    for(const receipt of unique.values()){for(const file of receipt.files)expect(readFileSync(join(target,"artifacts",file.path))).toEqual(readFileSync(join(studio.paths.artifactRoot,file.path)));
      const recovered=await inspectEditSource(receipt.job,receipt.facts.label,join(target,"artifacts"),async()=>{});expect(recovered).toEqual(receipt);
      const originalHashes=await editFrameHashes(join(studio.paths.artifactRoot,receipt.job.output!.mp4Path),receipt.facts.frames,join(f.root,"original-"+index+".hashes"),f.root,async()=>{}),recoveredHashes=await editFrameHashes(join(target,"artifacts",receipt.job.output!.mp4Path),receipt.facts.frames,join(f.root,"restored-"+index+".hashes"),f.root,async()=>{});expect(recoveredHashes).toEqual(originalHashes);index++;
    }expect(index).toBe(2);expect(JSON.parse(readFileSync(join(target,"snapshot.json"),"utf8")).schema).toBe("hv-state/11");
  }finally{f.close();}
},120000);

test("Python rejects downgraded, forged or incomplete acceptance archives before publication",async()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!,f=scratch();
  try{const source=join(f.root,"source");prepare(source,snapshot);const manifest=readFileSync(join(source,"snapshot.json"),"utf8"),originalProjects=readFileSync(join(source,"state/projects.json"));
    const reject=async(name:string,part:string)=>{const result=await python(["pack","--source",source,"--output",join(f.root,name+".zip"),"--project",project.id]);expect(result.status).not.toBe(0);expect(result.stderr).toContain(part);};
    writeFileSync(join(source,"snapshot.json"),JSON.stringify({...JSON.parse(manifest),schema:"hv-state/10"}));await reject("downgrade","schema 11");writeFileSync(join(source,"snapshot.json"),manifest);
    for(const [name,change] of [["request",(p:PersistedProject)=>{p.livingScriptAcceptances!.records[0]!.request.name="Forged retry";}],["version",(p:PersistedProject)=>{p.versions.at(-1)!.text+="!";}],["prefix",(p:PersistedProject)=>{p.livingScriptAcceptances!.records[0]!.acceptance.parent.historyRevision="a".repeat(64);}]] as const){const wrong=forge(fixture(),change);writeFileSync(join(source,"state/projects.json"),JSON.stringify(wrong.projects));await reject(name,"invalid sealed shot execution recovery data");}writeFileSync(join(source,"state/projects.json"),originalProjects);
    const generated=project.livingScriptAcceptances!.records[0]!.request.recutInput.generated;writeFileSync(join(source,"queue/jobs.json"),JSON.stringify(snapshot.jobs.filter(job=>job.id!==generated.job.id)));await reject("carrier","source job");writeFileSync(join(source,"queue/jobs.json"),JSON.stringify(snapshot.jobs));
    const file=generated.files[0]!;writeFileSync(join(source,"artifacts",file.path),"corrupt");await reject("media","missing or corrupt");
  }finally{f.close();}
},120000);
