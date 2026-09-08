import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {defaultMotionGraphic,motionGraphic} from "../../planner/src/motion-graphics";
import {currentGraphics} from "../../planner/src/graphic-library";
import {graphicJobPlan} from "../../planner/src/graphic-jobs";
import {initialEditTimeline,editTimeline} from "../../planner/src/edit-timeline";
import {assertEditOriginalPermission,assertEditSourceAvailable,assertEditSourcePermission,editFactsRevision,validateEditSourceReceipt,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {inspectEditSource,prepareEditSources,verifyPreparedEditSources,validatePreparedEditSources,EDIT_SOURCE_RECIPE} from "../src/edit-source-media";
import {contentHash} from "../src/capabilities";
import {soundDigest} from "../src/sound-media";
import type {DialogueArtifactReader} from "../src/dialogue-replacement";

const empty=async()=>{};
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe graphic source fixture cleanup");rmSync(root,{recursive:true,force:true});}
function reseal(receipt:EditSourceReceipt){receipt.facts.revision=editFactsRevision(receipt.job,receipt.facts.frames,receipt.facts.width,receipt.facts.height,receipt.facts.captions);const {revision:_revision,...data}=receipt;receipt.revision=contentHash(data);return receipt;}
const renderTest=process.env.HV_GRAPHICS_CHROME_PATH?test:test.skip;
renderTest("retained native graphics keep alpha, source identity and independent recovery without invented audio or caption lanes",async()=>{
  const secret=process.env.HV_TOKEN_SECRET;process.env.HV_TOKEN_SECRET="graphic-editorial-fixture-secret-at-least-thirty-two-characters";
  const root=realpathSync(mkdtempSync(join(tmpdir(),"hv-edit-graphic-"))),statePath=join(root,"projects.json"),artifactRoot=join(root,"artifacts"),projects=new ProjectService(statePath),owner=projects.createAnonymousProject();projects.attestRights(owner.token);
  try{
    const {revision:_defaultRevision,...defaults}=defaultMotionGraphic("lower-third",320,180),plan=motionGraphic({...defaults,text:"Marla",secondary:"A fictional character",frames:6,enterFrames:1,exitFrames:1}),id=crypto.randomUUID();
    const saved=projects.saveGraphic(owner.token,{kind:"save",id,label:"Marla lower third",plan},0)!,spec=currentGraphics(saved,owner.projectId)[0]!.spec,project=projects.peekProject(owner.projectId)!,store=new DurableJobStore(join(root,"jobs.json")),ledger=new CostLedger(join(root,"ledger.json"));
    store.enqueue({id:crypto.randomUUID(),projectId:owner.projectId,idempotencyKey:crypto.randomUUID(),tier:"free",stage:"motion-graphic",scriptVersion:0,scriptText:"",rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.frames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:120000,graphicRender:graphicJobPlan(spec,"local",contentHash({fixture:"editorial-graphic"}))});
    const done=(await processNextJob(store,artifactRoot,{projects,ledger,reviewQueue:new OperatorReviewQueue(join(root,"reviews.json")),graphics:{chromePath:process.env.HV_GRAPHICS_CHROME_PATH!}}))!;
    expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.costUsd).toBe(0);
    const receipt=await inspectEditSource(done,spec.label,artifactRoot,empty);expect(receipt.schema).toBe("hv-edit-source/2");expect(receipt.facts).toMatchObject({media:"graphic-rgba",frames:6,width:320,height:180,audio:[],captions:[],voices:[],unmeasuredAudio:false});expect(receipt.audio).toEqual({});expect(receipt.language).toBe("und");expect(receipt.files).toHaveLength(done.graphicOutput!.files.length);
    expect(()=>validateEditSourceReceipt(JSON.parse(JSON.stringify(receipt)))).not.toThrow();const timeline=initialEditTimeline([receipt.facts],done.id,640,360);expect(timeline.clips.map(c=>c.lane)).toEqual(["picture"]);
    const {revision:_timelineRevision,...timelineData}=timeline;for(const lane of ["captions","mix"] as const)expect(()=>editTimeline({...timelineData,clips:[{...timeline.clips[0]!,lane}]})).toThrow("picture layer");
    for(const patch of [{media:undefined},{media:"opaque"},{audio:["mix"]},{captions:[{id:"invented",start:0,end:1600,text:"Marla"}]},{voices:[{id:"invented",lane:"dialogue",start:0,end:1600}]},{unmeasuredAudio:true},{frames:5},{width:318}]){const changed=structuredClone(receipt);Object.assign(changed.facts,patch);expect(()=>validateEditSourceReceipt(reseal(changed))).toThrow();}
    const downgraded=structuredClone(receipt);downgraded.schema="hv-edit-source/1";delete downgraded.facts.media;expect(()=>validateEditSourceReceipt(reseal(downgraded))).toThrow();
    assertEditSourceAvailable(receipt,done);assertEditSourcePermission(receipt,project);expect(()=>assertEditSourceAvailable(receipt,{...done,graphicOutput:undefined})).toThrow("changed or expired");expect(()=>assertEditSourceAvailable(receipt,done,Date.parse(done.linkExpiresAt!))).toThrow("changed or expired");
    expect(()=>assertEditSourcePermission(receipt,{...project,rightsAttestedAt:null})).toThrow("permission");expect(()=>assertEditSourcePermission(receipt,{...project,id:"someone-else"})).toThrow("permission");
    projects.saveGraphic(owner.token,{kind:"availability",id,available:false},1);expect(()=>assertEditOriginalPermission(receipt,projects.peekProject(owner.projectId))).toThrow("permission");projects.saveGraphic(owner.token,{kind:"availability",id,available:true},2);
    const expired=Date.parse(done.linkExpiresAt!);expect(()=>assertEditOriginalPermission(receipt,{...projects.peekProject(owner.projectId)!,deleteAfter:new Date(expired+86400000).toISOString()},expired)).not.toThrow();
    const prepared=await prepareEditSources([receipt],artifactRoot,join(artifactRoot,"prepared"),empty),source=prepared.sources[0]!;expect(source.media.picture.sha256).toBe(done.graphicOutput!.report.master.sha256);expect(source.media.picture.path).toEndWith("/graphic.mkv");expect(source.media.audio).toEqual({});expect(source.conversions).toEqual([]);expect(source.copies.map(c=>c.original)).toEqual(receipt.files);
    const wrongRecipe={...prepared,recipeRevision:contentHash(EDIT_SOURCE_RECIPE)};expect(()=>validatePreparedEditSources(wrongRecipe,"prepared")).toThrow("preparation");
    const canonical=realpathSync(artifactRoot),original=realpathSync(join(canonical,done.projectId,done.id)),hidden=original+"-hidden";if(!original.startsWith(canonical+sep)||!hidden.startsWith(canonical+sep))throw new Error("Unsafe source recovery move");renameSync(original,hidden);
    try{await verifyPreparedEditSources(prepared,artifactRoot,join(artifactRoot,"prepared"),empty);}finally{renameSync(hidden,original);}
    const info=async(path:string)=>({path,...await soundDigest(join(artifactRoot,path))}),reader:DialogueArtifactReader={async response(projectId,jobId,path){expect([projectId,jobId]).toEqual([done.projectId,done.id]);const file=await info(path);return new Response(Bun.file(join(artifactRoot,path)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});}};
    expect(await inspectEditSource(done,spec.label,artifactRoot,empty,undefined,reader,info)).toEqual(receipt);
    const png=join(artifactRoot,done.graphicOutput!.files.find(f=>f.path.endsWith("000002.png"))!.path),bytes=readFileSync(png),changed=Buffer.from(bytes);changed[100]^=1;writeFileSync(png,changed);try{await expect(prepareEditSources([receipt],artifactRoot,join(artifactRoot,"changed"),empty)).rejects.toThrow("checksum");}finally{writeFileSync(png,bytes);}
    projects.createEditSequence(owner.token,[receipt],crypto.randomUUID(),"Graphic source",done.id,640,360,0);
    const snapshot:StateSnapshot={schema:"hv-state/5",projects:new ProjectService(statePath).snapshot(),jobs:[],ledger:{events:[],reservations:[]},reviews:[]};expect(validateSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    const lost=structuredClone(snapshot);delete lost.projects.projects[0]!.graphicLibrary;expect(()=>validateSnapshot({...lost,schema:"hv-state/4"})).toThrow("schema 5");expect(()=>validateSnapshot(lost)).toThrow("saved owner revision");
    const abort=new AbortController();abort.abort();await expect(inspectEditSource(done,spec.label,artifactRoot,empty,abort.signal)).rejects.toThrow();
  }finally{if(secret===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=secret;cleanup(root);}
},120000);
