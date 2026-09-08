import {afterAll,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {renderEditAssemblyJob,sealEditAssemblyJob,verifyEditAssemblyMedia} from "../../generator/src/edit-assembly-media";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {bindOriginalEditSource,validateEditBinding,type EditSourceBinding} from "../src/edit-jobs";
import {editAssemblyJson,editAssemblyRenderReview,createEditAssemblyRenderPlan,validateEditAssemblyRenderPlan,assertEditAssemblyPermission,validateEditAssemblyOutput,type EditAssemblyRenderPlan,type EditAssemblyOutputEnvelope} from "../src/edit-assembly-jobs";
import {createEditAssemblyProposal,emptyEditAssemblyLibrary,acceptEditAssemblyProposal,type AcceptedEditAssembly} from "../src/edit-assembly-proposals";
import {applyEditOperation,initialEditTimeline,editTimeline} from "../src/edit-timeline";
import type {EditAssemblyParent} from "../src/edit-assembly-types";

function seal<T extends {revision:string}>(value:T):T {const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;}
let fixture:Awaited<ReturnType<typeof dubStudio>>|undefined,assembly:AcceptedEditAssembly,binding:EditSourceBinding,plan:EditAssemblyRenderPlan,output:EditAssemblyOutputEnvelope;
let job:{id:string;projectId:string;assemblyEdit:EditAssemblyRenderPlan};
beforeAll(async()=>{
  fixture=await dubStudio();const receipt=await inspectEditSource(fixture.film,"Retained original",fixture.paths.artifactRoot,async()=>{});binding=bindOriginalEditSource(receipt);
  let timeline=initialEditTimeline([receipt.facts],receipt.facts.id,32,24);
  timeline=applyEditOperation(timeline,{kind:"split",clipId:"initial-0",linked:true,at:30,rightIds:{"initial-0":"later-picture","initial-1":"later-audio","initial-2":"later-captions"},rightLink:"later"});
  timeline=applyEditOperation(timeline,{kind:"retime",clipId:"initial-0",linked:true,from:0,frames:30,points:[{frame:0,rate:500},{frame:30,rate:1500}],ripple:false});
  timeline=applyEditOperation(timeline,{kind:"crossfade",leftId:"initial-0",rightId:"later-picture",linked:true,frames:9,alignment:"center",ids:{"initial-0":"picture-dissolve","initial-1":"sound-dissolve"}});
  const parent:EditAssemblyParent={sequenceId:"retained-parent",historyRevision:contentHash("saved history"),timeline,sourceReceipts:[{sourceId:receipt.facts.id,receiptRevision:receipt.revision}]};
  const library=createEditAssemblyProposal(emptyEditAssemblyLibrary(),{id:"proposal",label:"Repeated partial dissolve",purpose:"sixty-second",ranges:[
    {id:"dissolve",fromFrame:27,toFrame:34,reason:"Open inside the original dissolve."},
    {id:"earlier",fromFrame:2,toFrame:3,reason:"Return to the earlier ramped read."},
    {id:"repeat",fromFrame:27,toFrame:34,reason:"Repeat the retained transition."}
  ]},parent,0),proposal=library.proposals[0]!;
  assembly=acceptEditAssemblyProposal(library,proposal.id,proposal.revision,"accepted",parent,1).assembly;
  plan=createEditAssemblyRenderPlan(assembly,[binding],soundRuntimeRevision(),"local",contentHash("render-request"),editAssemblyRenderReview(assembly,[binding]));
  job={id:crypto.randomUUID(),projectId:fixture.owner.projectId,assemblyEdit:plan};const directory=join(fixture.paths.artifactRoot,job.projectId,job.id,"assembly");
  const rendered=await renderEditAssemblyJob(job,fixture.paths.artifactRoot,directory,async()=>assertEditAssemblyPermission(plan,fixture!.projects.peekProject(fixture!.owner.projectId)));
  output=await sealEditAssemblyJob(job,fixture.paths.artifactRoot,directory,rendered);
},180000);
afterAll(async()=>{await fixture?.close();});

test("assembly media survives database JSON object-key reordering without changing authenticated file bytes",async()=>{
  const reordered=(value:any):any=>Array.isArray(value)?value.map(reordered):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>b.localeCompare(a)).map(([key,item])=>[key,reordered(item)])):value;
  const storedJob=reordered(job),storedOutput=reordered(output);expect(JSON.stringify(storedOutput)).not.toBe(JSON.stringify(output));expect(contentHash(storedOutput)).toBe(contentHash(output));
  expect(()=>validateEditAssemblyOutput(storedJob,storedOutput)).not.toThrow();await verifyEditAssemblyMedia(storedJob,storedOutput,fixture!.paths.artifactRoot,async()=>assertEditAssemblyPermission(storedJob.assemblyEdit,fixture!.projects.peekProject(fixture!.owner.projectId)));
  const changed=reordered(storedOutput);changed.assembly.prepared.sources[0].media.picture.bytes++;expect(()=>validateEditAssemblyOutput(storedJob,changed)).toThrow();
},180000);

test("assembly render plans bind exact acceptance, original carriers, all reviews and independent child media",()=>{
  const copy=validateEditAssemblyRenderPlan(plan,Date.now());expect(copy).toEqual(assembly.plan);expect(copy).not.toBe(assembly.plan);copy.ranges[0]!.reason="Changed returned value";expect(assembly.plan.ranges[0]!.reason).not.toBe(copy.ranges[0]!.reason);
  expect(plan.review).toEqual(editAssemblyRenderReview(assembly,[binding]));expect(plan.assembly.target).toEqual({frames:1800,status:"short",deltaFrames:-1785});
  const created=createEditAssemblyRenderPlan(assembly,[binding],plan.engineVersion,"s3",contentHash("second request"),plan.review);created.assembly.plan.ranges[0]!.reason="Changed caller copy";created.bindings[0]!.owner.jobId="other";expect(plan.assembly).toEqual(assembly);expect(plan.bindings).toEqual([binding]);
  expect(()=>validateEditAssemblyOutput(job,output)).not.toThrow();expect(output.assembly.conform.picture.pictureFrames).toHaveLength(15);
  expect(output.assembly.conform.picture.pictureFrames.slice(0,7)).toEqual(output.assembly.conform.picture.pictureFrames.slice(8));
  expect(output.assembly.conform.picture.picture.parts.some(part=>part.layers.length===2)).toBe(true);expect(output.assembly.conform.picture.picture.parts.some(part=>part.layers.some(layer=>layer.sourceFrames))).toBe(true);
  expect(output.assembly.conform.plan.parent.timeline.frames).toBeGreaterThan(output.assembly.conform.audio.frames);expect(output.assembly.prepared.sources[0]!.receipt).toEqual(binding.source);
});

test("resealing cannot bypass acceptance, original receipt facts, carrier or review identity",()=>{
  const changes:((bad:any)=>void)[]=[
    bad=>bad.schema="hv-edit-plan/1",bad=>bad.engineVersion="ffmpeg-unrecorded",bad=>bad.storage="elsewhere",bad=>bad.requestHash="short",
    bad=>bad.assembly.acceptedAt="2020-01-01T00:00:00.000Z",bad=>bad.assembly.target.status="exact",bad=>bad.assembly.proposalRevision=contentHash("changed proposal"),
    bad=>bad.assembly.plan.parent.sourceReceipts[0].receiptRevision=contentHash("foreign original"),bad=>bad.bindings=[],bad=>bad.bindings.push(structuredClone(bad.bindings[0])),
    bad=>bad.bindings[0].source.facts.width++,bad=>bad.review.accepted=false,
    ...Object.keys(plan.review).filter(key=>key!=="accepted").map(key=>(bad:any)=>bad.review[key]=contentHash("unreviewed "+key))
  ];
  for(const change of changes){const bad=structuredClone(plan);change(bad);expect(()=>validateEditAssemblyRenderPlan(seal(bad))).toThrow();}
  const carrier=structuredClone(binding);carrier.owner.jobId="later-original-carrier";carrier.files=carrier.files.map(file=>({...file,path:carrier.owner.projectId+"/"+carrier.owner.jobId+"/original/"+file.path}));Object.assign(carrier,seal(carrier));expect(()=>validateEditBinding(carrier)).not.toThrow();
  const stale=seal({...structuredClone(plan),bindings:[carrier]});expect(()=>validateEditAssemblyRenderPlan(stale)).toThrow("Review the current assembly");
  const reviewed=seal({...stale,review:editAssemblyRenderReview(assembly,[carrier])});expect(validateEditAssemblyRenderPlan(reviewed).revision).toBe(assembly.plan.revision);expect(reviewed.review.sourceBindingsRevision).not.toBe(plan.review.sourceBindingsRevision);
  const reordered=structuredClone(plan);reordered.assembly.plan.ranges.reverse();reordered.assembly.plan=seal(reordered.assembly.plan);reordered.assembly=seal(reordered.assembly);expect(()=>validateEditAssemblyRenderPlan(seal(reordered))).toThrow();
});

test("live admission rejects expired carriers while independent checkpoints still check current original permissions",()=>{
  const afterExpiry=Date.parse(binding.owner.linkExpiresAt)+1;expect(()=>validateEditAssemblyRenderPlan(plan,afterExpiry)).toThrow("unavailable or changed");
  expect(()=>validateEditAssemblyRenderPlan(plan)).not.toThrow();expect(()=>validateEditAssemblyOutput(job,output)).not.toThrow();
  const expired=structuredClone(binding);expired.owner.linkExpiresAt=new Date(Date.parse(expired.owner.completedAt)+1).toISOString();Object.assign(expired,seal(expired));
  const retained=seal({...structuredClone(plan),bindings:[expired],review:editAssemblyRenderReview(assembly,[expired])});
  expect(()=>validateEditAssemblyRenderPlan(retained,Date.now())).toThrow("unavailable or changed");
  expect(()=>assertEditAssemblyPermission(retained,fixture!.projects.peekProject(job.projectId))).not.toThrow();
  expect(()=>assertEditAssemblyPermission(plan,null)).toThrow();const project=structuredClone(fixture!.projects.peekProject(job.projectId)!);project.rightsAttestedAt=null;expect(()=>assertEditAssemblyPermission(plan,project)).toThrow();
  expect(()=>validateEditAssemblyRenderPlan(plan,Number.NaN)).toThrow();expect(()=>validateEditAssemblyRenderPlan(plan,-1)).toThrow();
});

test("portable render boundaries reject unknown fields, accessors, hidden values and non-JSON coercion",()=>{
  for(const change of [(bad:any)=>bad.extra=true,(bad:any)=>bad.bindings[0].unknown=true,(bad:any)=>bad.review.unrecognized=true,(bad:any)=>bad.assembly.target.hidden=undefined,(bad:any)=>bad.bindings[0].owner.when=new Date(),(bad:any)=>bad.bindings[0].files[0].bytes=Number.NaN,(bad:any)=>bad.bindings[0].files[0].bytes=-0,(bad:any)=>Object.defineProperty(bad.review,"hidden",{value:true}),(bad:any)=>bad.review[Symbol("hidden")]=true,(bad:any)=>bad.bindings[2]=bad.bindings[0],(bad:any)=>bad.review.circular=bad]){
    const bad=structuredClone(plan);change(bad);expect(()=>validateEditAssemblyRenderPlan(bad)).toThrow();
  }
  let reads=0;const getter=structuredClone(plan);Object.defineProperty(getter,"storage",{enumerable:true,get(){reads++;return "local";}});expect(()=>validateEditAssemblyRenderPlan(getter)).toThrow();expect(reads).toBe(0);
  expect(()=>validateEditAssemblyOutput({id:job.id,projectId:job.projectId},output)).toThrow("own reviewed");const {assembly:_assembly,...missing}=output;expect(()=>validateEditAssemblyOutput(job,missing)).toThrow();
});

test("render admission applies full retained-parent capacity to repeated child ranges without truncating them",()=>{
  const parent=structuredClone(assembly.plan.parent),{revision:_revision,...data}=parent.timeline;parent.timeline=editTimeline({...data,width:1920,height:1080});
  const library=createEditAssemblyProposal(emptyEditAssemblyLibrary(),{id:"large-proposal",label:"Repeated 1080p parent windows",purpose:"custom",ranges:Array.from({length:256},(_,index)=>({id:"repeat-"+index,fromFrame:0,toFrame:30,reason:"Keep each requested repeat."}))},parent,0),proposal=library.proposals[0]!;
  const accepted=acceptEditAssemblyProposal(library,proposal.id,proposal.revision,"large-accepted",parent,1).assembly,review=editAssemblyRenderReview(accepted,[binding]);
  expect(accepted.plan.frames).toBe(7680);expect(accepted.plan.ranges).toHaveLength(256);
  expect(()=>createEditAssemblyRenderPlan(accepted,[binding],plan.engineVersion,"local",contentHash("large request"),review)).toThrow("workspace estimate");
  expect(accepted.plan.ranges).toHaveLength(256);expect(accepted.plan.frames).toBe(7680);
});

/** Keep nested seals valid so failures establish semantic validation, rather than only a stale wrapper hash. */
function resealOutput(value:EditAssemblyOutputEnvelope):EditAssemblyOutputEnvelope {
  value.assembly.conform.picture=seal(value.assembly.conform.picture);value.assembly.conform.audio=seal(value.assembly.conform.audio);value.assembly.conform=seal(value.assembly.conform);value.assembly=seal(value.assembly);return value;
}
test("assembly output rejects resealed parent-clock, span, recipe, waveform and caption substitutions",()=>{
  const changes:((bad:EditAssemblyOutputEnvelope)=>void)[]=[
    bad=>bad.assembly.schema="hv-edit-output/1" as any,
    bad=>bad.assembly.conform.picture.parentTimelineRevision=contentHash("other parent"),
    bad=>bad.assembly.conform.picture.parentRecipeRevision=contentHash("simplified recipe"),
    bad=>bad.assembly.conform.picture.picture.parts[0]!.at++,
    bad=>bad.assembly.conform.picture.picture.parts[0]!.frames++,
    bad=>bad.assembly.conform.picture.picture.parts[0]!.layers.reverse(),
    bad=>bad.assembly.conform.picture.picture.parts.flatMap(part=>part.layers).find(layer=>layer.sourceFrames)!.sourceFrames![0]!++,
    bad=>bad.assembly.conform.picture.picture.parts[0]!.layers[0]!.from++,
    bad=>bad.assembly.conform.picture.picture.parts[0]!.layers[0]!.filter="null",
    bad=>bad.assembly.conform.picture.picture.parts.pop(),
    bad=>bad.assembly.conform.picture.picture.sourceFrameFiles=[],
    bad=>bad.assembly.conform.picture.pictureFrames.pop(),
    bad=>bad.assembly.conform.audio.frames=bad.assembly.conform.plan.parent.timeline.frames,
    bad=>bad.assembly.conform.audio.parentRecipeRevision=contentHash("changed parent audio"),
    bad=>bad.assembly.conform.audio.peaks.final=8388609,
    bad=>bad.assembly.conform.audio.audio.mix=contentHash("replaced samples"),
    bad=>bad.assembly.conform.captionsSha256=contentHash("wrong selected cues"),
    bad=>bad.assembly.conform.rangeReview.repeatedFrames=0,
    bad=>bad.assembly.conform.boundaryReview.revision=contentHash("other boundaries"),
    bad=>bad.assembly.conform.parentCrossfades=[],
    bad=>bad.assembly.conform.sourceFiles=[],
    bad=>bad.assembly.prepared.sources[0]!.copies[0]!.copy.sha256=contentHash("changed original")
  ];
  for(const change of changes){const bad=structuredClone(output);change(bad);expect(()=>validateEditAssemblyOutput(job,resealOutput(bad))).toThrow();}
  expect(()=>validateEditAssemblyOutput({...job,projectId:"another-project"},output)).toThrow("owner");expect(()=>validateEditAssemblyOutput({...job,id:binding.owner.jobId},output)).toThrow("owner");
});

test("assembly artifact inventory requires exact independently retained sources, child PCM, manifests and owned HLS",()=>{
  const changes:((bad:EditAssemblyOutputEnvelope)=>void)[]=[
    bad=>bad.mp4Path="foreign/owner/assembly/conform/export.mp4",
    bad=>bad.manifestPath=bad.manifestPath.replace("provenance.json","../provenance.json"),
    bad=>bad.assembly.files.push({...bad.assembly.files[0]!}),
    bad=>bad.assembly.files[0]!.path="foreign/job/file.wav",
    bad=>bad.assembly.files[0]!.bytes=8*1024**3+1,
    bad=>bad.assembly.files=bad.assembly.files.filter(file=>!file.path.endsWith("/conform/assembly.json")),
    bad=>bad.assembly.files=bad.assembly.files.filter(file=>!file.path.includes("/original/")),
    bad=>bad.assembly.files=bad.assembly.files.filter(file=>!file.path.endsWith(".ts")),
    bad=>bad.assembly.files.find(file=>file.path.endsWith("conform/audio/final.wav"))!.bytes+=6,
    bad=>bad.assembly.files.find(file=>file.path.endsWith("conform/audio/final.wav"))!.sha256=contentHash("changed sound"),
    bad=>bad.assembly.files.find(file=>file.path.endsWith("conform/timeline.json"))!.sha256=contentHash("flattened parent"),
    bad=>bad.assembly.files.find(file=>file.path.endsWith("conform/captions.vtt"))!.sha256=contentHash("changed cues"),
    bad=>bad.assembly.files.push({path:bad.manifestPath.replace("provenance.json","unrecognized.txt"),bytes:1,sha256:contentHash("extra")})
  ];
  for(const change of changes){const bad=structuredClone(output);change(bad);expect(()=>validateEditAssemblyOutput(job,resealOutput(bad))).toThrow();}
  const huge=structuredClone(output);for(let i=0;i<7;i++)huge.assembly.files.push({path:huge.manifestPath.replace("provenance.json","conform/hls/segment-"+String(i+10000)+".ts"),bytes:8*1024**3,sha256:contentHash("large")});expect(()=>validateEditAssemblyOutput(job,resealOutput(huge))).toThrow("capacity");
  const tooMany=structuredClone(output);tooMany.assembly.files=Array.from({length:80001},()=>({...output.assembly.files[0]!}));expect(()=>validateEditAssemblyOutput(job,resealOutput(tooMany))).toThrow("artifact inventory");
  const reportFile=output.assembly.files.find(file=>file.path.endsWith("conform/conform.json"))!,text=editAssemblyJson(output.assembly.conform);expect(reportFile.sha256).toBe(createHash("sha256").update(text).digest("hex"));expect(reportFile.bytes).toBe(Buffer.byteLength(text));
});
