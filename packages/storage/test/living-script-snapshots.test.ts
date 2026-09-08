import {afterAll,beforeAll,expect,test} from "bun:test";
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,sep} from "node:path";
import {tmpdir} from "node:os";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {ProjectService} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {createLivingScriptProposal,emptyLivingScriptProposals} from "../../planner/src/living-script-proposals";
import {createEditSequence,emptyEditLibrary} from "../../planner/src/edit-library";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {readStateSnapshot,stateSnapshotSchema,validateSnapshot,writeStateSnapshot,type StateSnapshot} from "../src/snapshots";

let studio:Awaited<ReturnType<typeof dubStudio>>,base:StateSnapshot;
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;};
beforeAll(async()=>{
  studio=await dubStudio();const now=Date.now(),source=await inspectEditSource(studio.film,"Original film",studio.paths.artifactRoot,async()=>{}),projectId=studio.owner.projectId;
  const editorial=createEditSequence(emptyEditLibrary(),projectId,[source],"cut","Saved cut",source.facts.id,320,180,0,now),index=compileEditScriptSource(source),entry=index.entries.find(value=>value.kind==="dialogue")!;
  const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:studio.film.scriptVersion,text:studio.film.scriptText},replacement:"Welcome back to the garden."});
  const candidate=compileLivingScriptGenerationImpact(source,patch,{...studio.film,scriptVersion:patch.after.version,scriptText:patch.after.text},now).candidateInputs,parent=deriveEditAssemblyParent(projectId,editorial,"cut"),navigation=projectEditScriptNavigation("cut",parent.historyRevision,parent.timeline,[index]);
  const project=studio.projects.snapshot().projects[0]!,baseline={casting:currentCasting(projectId,project.castingHistory),direction:currentDirection(projectId,project.directionHistory)};
  const request={id:"retained-line",label:"Reviewed greeting",sequenceId:"cut",historyRevision:parent.historyRevision,editorialRevision:editorial.revision,navigationRevision:navigation.revision,patch,candidate,baseline};
  const proposals=createLivingScriptProposal(emptyLivingScriptProposals(projectId),projectId,editorial,request,0,now).library,projects=studio.projects.snapshot();
  projects.projects[0]!.editLibrary=editorial;projects.projects[0]!.livingScriptProposals=proposals;
  base={schema:"hv-state/8",projects,jobs:[structuredClone(studio.film)],ledger:JSON.parse(readFileSync(studio.paths.costLedgerPath,"utf8")),reviews:[]};
  validateSnapshot(base);
},180000);
afterAll(async()=>{await studio?.close();});
const fixture=()=>structuredClone(base);
function scratch(){const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-living-snap-")));return {root,close(){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-living-snap-"))throw new Error("Unsafe screenplay snapshot cleanup");rmSync(root,{recursive:true,force:true});}};}
function reordered(value:unknown):unknown{return Array.isArray(value)?value.map(reordered):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reordered(item)])):value;}
async function python(args:string[]){const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,stdout,stderr};}
function prepare(root:string,snapshot:StateSnapshot){writeStateSnapshot(root,snapshot);const sources=snapshot.projects.projects[0]!.livingScriptProposals!.proposals.flatMap(p=>p.editorial.sources);for(const source of sources)for(const file of source.files){const path=join(root,"artifacts",file.path);mkdirSync(dirname(path),{recursive:true});copyFileSync(join(studio.paths.artifactRoot,file.path),path);}}

test("a saved screenplay review requires schema eight and cannot be downgraded",()=>{
  const snapshot=fixture();expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/8");expect(validateSnapshot(snapshot)).toBe(snapshot);
  for(const schema of ["hv-state/1","hv-state/2","hv-state/3","hv-state/4","hv-state/5","hv-state/6","hv-state/7"] as const)expect(()=>validateSnapshot({...snapshot,schema})).toThrow("schema 8");
});

test("frozen proposal identity survives JSONB key reordering and snapshot restoration without rewriting input bytes",()=>{
  const snapshot=reordered(fixture()) as StateSnapshot,serialized=JSON.stringify(snapshot),revision=contentHash(base.projects.projects[0]!.livingScriptProposals),f=scratch();
  try{expect(validateSnapshot(snapshot)).toBe(snapshot);expect(JSON.stringify(snapshot)).toBe(serialized);expect(contentHash(snapshot.projects.projects[0]!.livingScriptProposals)).toBe(revision);
    writeStateSnapshot(join(f.root,"saved"),snapshot);const restored=readStateSnapshot(join(f.root,"saved"));expect(restored).toEqual(snapshot);expect(contentHash(restored.projects.projects[0]!.livingScriptProposals)).toBe(revision);
  }finally{f.close();}
});

test("historical review survives current cut removal and later screenplay edits but requires its exact original project version",()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!,proposal=project.livingScriptProposals!.proposals[0]!,revision=proposal.revision;delete project.editLibrary;
  project.versions.push({...project.versions[0]!,version:2,text:"INT. OTHER ROOM - NIGHT\n\nAn unrelated later version."});
  expect(project.versions.some(v=>v.text===proposal.request.patch.after.text)).toBe(false);expect(validateSnapshot(snapshot)).toBe(snapshot);expect(proposal.revision).toBe(revision);
  for(const versions of [[],project.versions.slice(1),[{...project.versions[0]!,text:"Changed original"}]])expect(()=>validateSnapshot({...snapshot,projects:{...snapshot.projects,projects:[{...project,versions}]}})).toThrow("exact original project version");
});

test("rehashed forged impact, malformed collections and foreign frozen context fail recovery",()=>{
  const forged=fixture(),project=forged.projects.projects[0]!,library=project.livingScriptProposals!,proposal=library.proposals[0]!;proposal.impact.generation.generateShotIds=[];proposal.impact=reseal(proposal.impact);library.proposals[0]=reseal(proposal);project.livingScriptProposals=reseal(library);
  expect(()=>validateSnapshot(forged)).toThrow("impact no longer matches");
  for(const value of [null,{},[],{version:0,proposals:null},{version:0,proposals:[]}]){const snapshot=fixture();snapshot.projects.projects[0]!.livingScriptProposals=value as any;expect(()=>validateSnapshot(snapshot)).toThrow();}
  const foreign=fixture();foreign.projects.projects[0]!.livingScriptProposals!.proposals[0]!.editorial.sources[0]!.job.projectId="another-project";expect(()=>validateSnapshot(foreign)).toThrow();
});

test("absent and valid empty defaults preserve legacy schemas and serialized project payloads",()=>{
  const service=new ProjectService(),owner=service.createAnonymousProject(),projects=service.snapshot(),snapshot:StateSnapshot={schema:"hv-state/1",projects,jobs:[],ledger:{events:[],reservations:[]},reviews:[]};
  expect(projects.projects[0]!.livingScriptProposals).toBeUndefined();const serialized=JSON.stringify(snapshot);expect(validateSnapshot(snapshot)).toBe(snapshot);expect(JSON.stringify(snapshot)).toBe(serialized);
  const empty=emptyLivingScriptProposals(owner.projectId);projects.projects[0]!.livingScriptProposals=empty;expect(stateSnapshotSchema(projects,[])).toBe("hv-state/1");expect(validateSnapshot(snapshot)).toBe(snapshot);
  projects.projects[0]!.livingScriptProposals=reseal({...empty,version:1});expect(stateSnapshotSchema(projects,[])).toBe("hv-state/8");expect(()=>validateSnapshot(snapshot)).toThrow("schema 8");
});

test("Python schema eight archives preserve frozen-only original bytes and every submitted proposal byte",async()=>{
  const snapshot=reordered(fixture()) as StateSnapshot,project=snapshot.projects.projects[0]!;delete project.editLibrary;const f=scratch();
  try{const source=join(f.root,"source"),target=join(f.root,"restored"),archive=join(f.root,"review.zip");prepare(source,snapshot);
    const packed=await python(["pack","--source",source,"--output",archive,"--project",project.id]);expect(packed.stderr).toBe("");expect(packed.status).toBe(0);
    const unpacked=await python(["unpack","--source",archive,"--output",target]);expect(unpacked.stderr).toBe("");expect(unpacked.status).toBe(0);expect(readStateSnapshot(target)).toEqual(snapshot);
    expect(readFileSync(join(target,"state/projects.json"))).toEqual(readFileSync(join(source,"state/projects.json")));
    for(const receipt of project.livingScriptProposals!.proposals[0]!.editorial.sources)for(const file of receipt.files)expect(readFileSync(join(target,"artifacts",file.path))).toEqual(readFileSync(join(studio.paths.artifactRoot,file.path)));
    expect(JSON.parse(readFileSync(join(target,"snapshot.json"),"utf8")).schema).toBe("hv-state/8");
  }finally{f.close();}
},60000);

test("Python rejects downgraded or rehashed forged proposals and missing historical media carriers",async()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!;delete project.editLibrary;const f=scratch();
  try{const source=join(f.root,"source");prepare(source,snapshot);const manifest=readFileSync(join(source,"snapshot.json"),"utf8");
    const reject=async(name:string,part:string)=>{const result=await python(["pack","--source",source,"--output",join(f.root,name+".zip"),"--project",project.id]);expect(result.status).not.toBe(0);expect(result.stderr).toContain(part);};
    writeFileSync(join(source,"snapshot.json"),JSON.stringify({...JSON.parse(manifest),schema:"hv-state/7"}));await reject("downgraded","schema 8");writeFileSync(join(source,"snapshot.json"),manifest);
    const forged=structuredClone(snapshot.projects),library=forged.projects[0]!.livingScriptProposals!;library.proposals[0]!.impact.generation.generateShotIds=[];library.proposals[0]!.impact=reseal(library.proposals[0]!.impact);library.proposals[0]=reseal(library.proposals[0]!);forged.projects[0]!.livingScriptProposals=reseal(library);
    writeFileSync(join(source,"state/projects.json"),JSON.stringify(forged));await reject("forged","invalid sealed screenplay proposal");writeFileSync(join(source,"state/projects.json"),JSON.stringify(snapshot.projects));
    const wrong=structuredClone(snapshot.projects);wrong.projects[0]!.versions[0]!.text+="!";writeFileSync(join(source,"state/projects.json"),JSON.stringify(wrong));await reject("original-version","invalid sealed screenplay proposal");writeFileSync(join(source,"state/projects.json"),JSON.stringify(snapshot.projects));
    writeFileSync(join(source,"queue/jobs.json"),"[]");await reject("missing-carrier","source job");writeFileSync(join(source,"queue/jobs.json"),JSON.stringify(snapshot.jobs));
    const file=project.livingScriptProposals!.proposals[0]!.editorial.sources[0]!.files[0]!;writeFileSync(join(source,"artifacts",file.path),"corrupt");await reject("corrupt-media","missing or corrupt");
  }finally{f.close();}
},60000);
