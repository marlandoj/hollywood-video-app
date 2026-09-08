import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import * as fs from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {ProjectService,type PersistedState} from "../src/index";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash} from "../../generator/src/capabilities";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument} from "../../planner/src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../../planner/src/living-script-shot-plan";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBlock} from "../../planner/src/living-script-structure";
import {proposeShotPlanEvolution} from "../../planner/src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../../planner/src/living-script-current-direction";
import {currentScreenplayHead,type CurrentScreenplayBootstrapRequest} from "../../planner/src/current-screenplay-library";
import type {EditAssemblyCarrier} from "../../planner/src/edit-assembly-parent";
import {readStateSnapshot,writeStateSnapshot,validateSnapshot,stateSnapshotSchema,type StateSnapshot} from "../../storage/src/snapshots";

let fixture:Awaited<ReturnType<typeof dubStudio>>,baseline:PersistedState,bootstrap:CurrentScreenplayBootstrapRequest,carrier:EditAssemblyCarrier;
beforeAll(async()=>{
  fixture=await dubStudio();baseline=fixture.projects.snapshot();
  const source=await inspectEditSource(fixture.film,"Canonical screenplay original",fixture.paths.artifactRoot,async()=>{}),project=baseline.projects[0]!,script=project.versions.at(-1)!;
  const base=createLivingScriptStructureBase({projectId:project.id,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]});
  bootstrap={id:"root",label:"Original screenplay",script,source,documentSource,originalPlan:bootstrapLivingScriptShotPlan(source,documentSource),baseline:{casting:currentCasting(project.id,project.castingHistory??[]),direction:currentDirection(project.id,project.directionHistory??[])}};
  carrier={binding:bindOriginalEditSource(source),current:fixture.film};
},180000);
afterAll(async()=>{await fixture?.close();});
function initialize(){const service=ProjectService.fromState(baseline),result=service.bootstrapCurrentScreenplay(fixture.owner.token,bootstrap,0,carrier)!;return {service,result};}
test("bootstrap requires the exact saved settings and a currently available original carrier without partial state",()=>{
  const service=ProjectService.fromState(baseline),before=service.snapshot(),changed=structuredClone(bootstrap);
  changed.baseline.direction.createdAt=new Date(Date.parse(changed.baseline.direction.createdAt)+1).toISOString();
  expect(()=>service.bootstrapCurrentScreenplay(fixture.owner.token,changed,0,carrier)).toThrow();expect(service.snapshot()).toEqual(before);
  expect(()=>service.bootstrapCurrentScreenplay(fixture.owner.token,bootstrap,0,{...carrier,current:{...carrier.current!,status:"cancelled"}})).toThrow();expect(service.snapshot()).toEqual(before);
});
function propose(service:ProjectService,id="proposal",twoVersions=false){
  const library=service.peekProject(fixture.owner.projectId)!.currentScreenplay,head=currentScreenplayHead(library)!,context=head.state.context,document=context.plan.document;
  const line=document.lines.find(row=>row.text.includes("Welcome"))!,base=document.context.base;
  const patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"replace-line",kind:"replace",block:livingScriptStructureBlock(base,line.line,line.line+1),text:"Welcome home.\nStay for a while.\n"}]});
  let afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]});
  if(twoVersions){const nextBase=afterDocument.context.base,nextLine=afterDocument.lines.find(row=>row.text.includes("Come inside"))!,nextPatch=compileLivingScriptStructure(nextBase,{baseRevision:nextBase.revision,operations:[{id:"second-version",kind:"replace",block:livingScriptStructureBlock(nextBase,nextLine.line,nextLine.line+1),text:"Come inside, friend.\nThe gate is open.\n"}]});afterDocument=compileLivingScriptDocument({base:nextPatch.after,ancestry:[...afterDocument.context.ancestry,nextPatch]});}
  const capacity={tier:"free" as const,maxShots:24 as const},plan=proposeShotPlanEvolution({previous:context.plan,lineage:context.lineage,originals:context.originals,beforeDocument:document,afterDocument,capacity,requestId:id});
  expect(plan.review.conflicts).toEqual([]);
  const request={id,label:"Revised welcome",expectedHeadRevision:head.revision,beforeStateRevision:head.state.revision,afterDocument,planRequest:plan.request,directionRequest:createCurrentDirectionRequest(head.state.direction,plan.review.candidate!,{id:"direction-"+id,settings:[],lines:[],retired:[]}),capacity};
  const result=service.saveCurrentScreenplayProposal(fixture.owner.token,request,library.version)!;expect(result.proposal.candidate).not.toBeNull();
  return {result,request,acceptance:{id:"accept-"+id,proposalRevision:result.proposal.revision,expectedHeadRevision:head.revision}};
}
test("owner saves canonical proposals separately then atomically accepts exact script, cast and ancestry with no-write replay",()=>{
  const {service,result}=initialize(),original=service.snapshot(),sourceHash=contentHash(bootstrap.source),pending=propose(service,"proposal",true);
  expect(service.snapshot().projects[0]!.versions).toEqual(original.projects[0]!.versions);
  expect(service.peekProject(fixture.owner.projectId)!.currentScreenplay.headRevision).toBe(result.origin.revision);
  const accepted=service.acceptCurrentScreenplayProposal(fixture.owner.token,pending.acceptance,pending.result.library.version)!;
  expect(accepted.replayed).toBe(false);expect(accepted.versions).toHaveLength(2);expect(accepted.versions[1]!.parentVersion).toBe(accepted.versions[0]!.version);expect(accepted.versions[0]!.createdAt).toBe(accepted.versions[1]!.createdAt);
  const state=service.snapshot(),project=state.projects[0]!;
  expect(project.versions.at(-1)!.text).toContain("Welcome home.\nStay for a while.");
  expect(project.versions.slice(0,-2)).toEqual(original.projects[0]!.versions);
  expect(project.currentScreenplay!.headRevision).toBe(accepted.acceptance.revision);
  expect(currentCasting(project.id,project.castingHistory??[])).toEqual(accepted.acceptance.state.casting.candidate!);
  expect(ProjectService.fromState(JSON.parse(JSON.stringify(state))).snapshot()).toEqual(state);
  expect(service.acceptCurrentScreenplayProposal(fixture.owner.token,pending.acceptance,pending.result.library.version)!.replayed).toBe(true);expect(service.snapshot()).toEqual(state);
  expect(contentHash(bootstrap.source)).toBe(sourceHash);expect(project.editLibrary).toEqual(original.projects[0]!.editLibrary);expect(project.dialogueSelections).toEqual(original.projects[0]!.dialogueSelections);
},30000);
test("current rights, direct script edits and stale proposal identities cannot publish canonical ancestry",()=>{
  const {service}=initialize(),pending=propose(service),before=service.snapshot();
  expect(service.acceptCurrentScreenplayProposal("invalid",pending.acceptance,pending.result.library.version)).toBeNull();expect(service.snapshot()).toEqual(before);
  for(const change of ["rights","script"]){const state=structuredClone(before),project=state.projects[0]!;
    if(change==="rights")project.rightsAttestedAt=null;else project.versions.push({...project.versions.at(-1)!,version:project.versions.at(-1)!.version+1,parentVersion:project.versions.at(-1)!.version,text:"INT. OTHER - DAY\nA changed scene."});
    const changed=ProjectService.fromState(state),unchanged=changed.snapshot();expect(()=>changed.acceptCurrentScreenplayProposal(fixture.owner.token,pending.acceptance,pending.result.library.version)).toThrow();expect(changed.snapshot()).toEqual(unchanged);
  }
  expect(()=>service.acceptCurrentScreenplayProposal(fixture.owner.token,{...pending.acceptance,proposalRevision:"0".repeat(64)},pending.result.library.version)).toThrow();expect(service.snapshot()).toEqual(before);
},30000);
test("failed canonical acceptance disk publication leaves all live and stored members unchanged",()=>{
  const {service:initial}=initialize(),pending=propose(initial),path=join(fixture.paths.artifactRoot,"current-screenplay-state.json");fs.writeFileSync(path,JSON.stringify(initial.snapshot()));
  const service=new ProjectService(path),before=service.snapshot(),bytes=fs.readFileSync(path,"utf8"),rename=fs.renameSync;
  const fault=spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(to)===path)throw new Error("Canonical atomic publication failed");return rename(from,to);});
  try{expect(()=>service.acceptCurrentScreenplayProposal(fixture.owner.token,pending.acceptance,pending.result.library.version)).toThrow("Canonical atomic publication failed");expect(service.snapshot()).toEqual(before);expect(fs.readFileSync(path,"utf8")).toBe(bytes);}finally{fault.mockRestore();}
  expect(service.acceptCurrentScreenplayProposal(fixture.owner.token,pending.acceptance,pending.result.library.version)!.replayed).toBe(false);
},30000);

test("schema twelve independently archives accepted ancestry and saved proposals with original media and restores the next review",async()=>{
  const {service}=initialize(),pending=propose(service);service.acceptCurrentScreenplayProposal(fixture.owner.token,pending.acceptance,pending.result.library.version);
  const snapshot:StateSnapshot={schema:"hv-state/12",projects:service.snapshot(),jobs:[fixture.film],ledger:{events:fixture.ledger.all(),reservations:[]},reviews:[]};
  expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/12");expect(validateSnapshot(snapshot)).toBe(snapshot);
  for(const schema of ["hv-state/1","hv-state/10","hv-state/11"] as const)expect(()=>validateSnapshot({...snapshot,schema})).toThrow("schema 12");
  const hidden=structuredClone(snapshot);Object.assign(hidden.projects.projects[0]!,{abandoned:{currentScreenplay:hidden.projects.projects[0]!.currentScreenplay}});expect(()=>validateSnapshot(hidden)).toThrow("unowned");
  const altered=structuredClone(snapshot);altered.projects.projects[0]!.versions.at(-1)!.text+="\nChanged";expect(()=>validateSnapshot(altered)).toThrow();
  const source=join(fixture.root,"canonical-source"),archive=join(fixture.root,"canonical.zip"),restored=join(fixture.root,"canonical-restored");writeStateSnapshot(source,snapshot);
  const media=join(source,"artifacts",fixture.owner.projectId,fixture.film.id);fs.mkdirSync(join(source,"artifacts",fixture.owner.projectId),{recursive:true});fs.cpSync(join(fixture.paths.artifactRoot,fixture.owner.projectId,fixture.film.id),media,{recursive:true});
  const run=async(args:string[])=>{const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};};
  const pack=await run(["pack","--source",source,"--output",archive,"--project",fixture.owner.projectId]);expect(pack.stderr).toBe("");expect(pack.code).toBe(0);
  const unpack=await run(["unpack","--source",archive,"--output",restored]);expect(unpack.stderr).toBe("");expect(unpack.code).toBe(0);
  const recovered=readStateSnapshot(restored);expect(recovered).toEqual(snapshot);
  for(const record of fixture.film.output!.shotRenders!)for(const file of Object.values(record.files))expect(fs.readFileSync(join(restored,"artifacts",file.path))).toEqual(fs.readFileSync(join(fixture.paths.artifactRoot,file.path)));
  const next=ProjectService.fromState(recovered.projects),head=next.peekProject(fixture.owner.projectId)!.currentScreenplay.headRevision;
  expect(propose(next,"after-restore").result.proposal.candidate).not.toBeNull();expect(next.peekProject(fixture.owner.projectId)!.currentScreenplay.headRevision).toBe(head);
},120000);
