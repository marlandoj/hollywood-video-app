import {afterAll,beforeAll,expect,test} from "bun:test";
import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {ProjectService} from "../../api/src/index";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource,bindRetainedEditSource,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {bootstrapLivingScriptDocument} from "../../planner/src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../../planner/src/living-script-shot-plan";
import {createLivingScriptStructureBase} from "../../planner/src/living-script-structure";
import type {Job} from "../../queue/src/index";
import {readStateSnapshot,writeStateSnapshot,validateSnapshot,type StateSnapshot} from "../src/snapshots";

let studio:Awaited<ReturnType<typeof dubStudio>>,base:StateSnapshot,carrier:Job,retained:EditSourceBinding;
beforeAll(async()=>{
  studio=await dubStudio();const receipt=await inspectEditSource(studio.film,"Canonical retained original",studio.paths.artifactRoot,async()=>{}),service=ProjectService.fromState(studio.projects.snapshot()),project=service.snapshot().projects[0]!,script=project.versions.at(-1)!;
  const documentBase=createLivingScriptStructureBase({projectId:project.id,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(receipt,{base:documentBase,ancestry:[]}),original=bindOriginalEditSource(receipt);
  service.bootstrapCurrentScreenplay(studio.owner.token,{id:"archive-origin",label:"Canonical origin custody",script,source:receipt,documentSource,originalPlan:bootstrapLivingScriptShotPlan(receipt,documentSource),baseline:{casting:currentCasting(project.id,project.castingHistory??[]),direction:currentDirection(project.id,project.directionHistory??[])}},0,{binding:original,current:studio.film});
  // The saved project deliberately has no editorial source catalog. Its only original
  // receipt is canonical ancestry, so the archive must collect that source itself.
  base={schema:"hv-state/12",projects:service.snapshot(),jobs:[],ledger:{events:[],reservations:[]},reviews:[]};expect(base.projects.projects[0]!.editLibrary).toBeUndefined();expect(validateSnapshot(base)).toBe(base);
  let library=studio.projects.createEditSequence(studio.owner.token,[receipt],"carrier-cut","Independent original carrier",receipt.facts.id,320,180,0,Date.now(),[original])!;
  library=studio.projects.changeEditSequence(studio.owner.token,"carrier-cut",{kind:"edit",label:"One second carrier",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-receipt.facts.frames,ripple:true}},library.version,library.sequences[0]!.history.revision)!;
  const route=studio.base+"/editorial/sequences/carrier-cut/renders",quote=await(await studio.call(route,"GET",undefined,studio.owner.token)).json() as any;
  expect((await studio.call(route,"POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}},studio.owner.token)).status).toBe(202);
  carrier=(await studio.worker())!;expect(carrier.failureReason??carrier.cancelReason).toBeUndefined();expect(carrier.status).toBe("done");retained=bindRetainedEditSource(carrier,receipt.revision);
},180000);
afterAll(async()=>{await studio?.close();});
async function python(args:string[]){const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,stdout,stderr};}
function prepare(name:string,jobs:Job[],copy:Job[]=[]){
  const root=join(studio.root,name),snapshot={...structuredClone(base),jobs:structuredClone(jobs)};writeStateSnapshot(root,snapshot);
  for(const job of copy){const to=join(root,"artifacts",job.projectId,job.id);mkdirSync(join(root,"artifacts",job.projectId),{recursive:true});cpSync(join(studio.paths.artifactRoot,job.projectId,job.id),to,{recursive:true});}
  return {root,snapshot};
}

test("schema twelve ancestry cannot archive without an original job or independently retained carrier",async()=>{
  const {root}=prepare("canonical-missing-carrier",[]),archive=join(studio.root,"missing-carrier.zip"),result=await python(["pack","--source",root,"--output",archive,"--project",studio.owner.projectId]);
  expect(result.status).not.toBe(0);expect(result.stderr).toContain("archive lost an editorial source job or retained carrier");expect(existsSync(archive)).toBe(false);
  const missing=prepare("canonical-missing-bytes",[studio.film]),missingArchive=join(studio.root,"missing-bytes.zip"),missingResult=await python(["pack","--source",missing.root,"--output",missingArchive,"--project",studio.owner.projectId]);
  expect(missingResult.status).not.toBe(0);expect(missingResult.stderr).toContain("execution checkpoint manifest is missing");expect(existsSync(missingArchive)).toBe(false);
},90000);

test("schema twelve restores exact canonical ancestry through retained originals without the expired original job or directory",async()=>{
  const {root,snapshot}=prepare("canonical-retained",[carrier],[carrier]),archive=join(studio.root,"canonical-retained.zip"),output=join(studio.root,"canonical-retained-restored"),original=base.projects.projects[0]!.currentScreenplay!.origin!.request.source;
  expect(snapshot.jobs.some(job=>job.id===original.job.id)).toBe(false);expect(existsSync(join(root,"artifacts",original.job.projectId,original.job.id))).toBe(false);
  const packed=await python(["pack","--source",root,"--output",archive,"--project",studio.owner.projectId]);expect(packed.stderr).toBe("");expect(packed.status).toBe(0);
  const unpacked=await python(["unpack","--source",archive,"--output",output]);expect(unpacked.stderr).toBe("");expect(unpacked.status).toBe(0);expect(readStateSnapshot(output)).toEqual(snapshot);
  expect(readFileSync(join(output,"state/projects.json"))).toEqual(readFileSync(join(root,"state/projects.json")));expect(readFileSync(join(output,"queue/jobs.json"))).toEqual(readFileSync(join(root,"queue/jobs.json")));
  const restored=readStateSnapshot(output),restoredBinding=bindRetainedEditSource(restored.jobs[0]!,original.revision);expect(restoredBinding.source).toEqual(original);
  for(const [index,file]of restoredBinding.files.entries()){expect(readFileSync(join(output,"artifacts",file.path))).toEqual(readFileSync(join(studio.paths.artifactRoot,retained.files[index]!.path)));expect(file.sha256).toBe(original.files[index]!.sha256);}
  const now=Date.now;Date.now=()=>Date.parse(original.job.linkExpiresAt!)+86400000;try{expect(validateSnapshot(restored)).toBe(restored);expect(restoredBinding.source.job.linkExpiresAt).toBe(original.job.linkExpiresAt);}finally{Date.now=now;}
  expect(ProjectService.fromState(restored.projects).snapshot()).toEqual(restored.projects);
},120000);

test("a retained canonical carrier with corrupt copied bytes cannot publish a new archive",async()=>{
  const {root}=prepare("canonical-corrupt-carrier",[carrier],[carrier]),file=join(root,"artifacts",retained.files[0]!.path);writeFileSync(file,"corrupt copied original");
  const archive=join(studio.root,"corrupt-carrier.zip"),result=await python(["pack","--source",root,"--output",archive,"--project",studio.owner.projectId]);expect(result.status).not.toBe(0);expect(result.stderr).toContain("missing or corrupt");expect(existsSync(archive)).toBe(false);
},60000);
