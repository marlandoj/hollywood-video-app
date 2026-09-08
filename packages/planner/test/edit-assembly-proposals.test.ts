import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {editTimeline,type EditSource} from "../src/edit-timeline";
import type {EditAssemblyParent,EditAssemblyPurpose,EditAssemblyRange} from "../src/edit-assembly-types";
import {acceptEditAssemblyProposal,createEditAssemblyProposal,emptyEditAssemblyLibrary,reviseEditAssemblyProposal,validateEditAssemblyLibrary,EDIT_ASSEMBLY_LIBRARY_LIMITS} from "../src/edit-assembly-proposals";

const now=Date.parse("2026-09-08T00:00:00.000Z"),receipt=contentHash("original receipt"),source:EditSource={id:"original",revision:contentHash("source facts"),label:"Original",frames:3600,width:64,height:48,audio:["mix"],captions:[],voices:[],unmeasuredAudio:false};
function parent():EditAssemblyParent {return {sequenceId:"parent",historyRevision:contentHash("history"),timeline:editTimeline({schema:"hv-edit-timeline/1",width:64,height:48,frames:3600,sources:[source],clips:[{id:"picture",sourceId:source.id,lane:"picture",layer:0,link:null,at:0,from:0,frames:3600,gainDb:0,opacity:1,crop:null,envelope:{from:0,frames:3600,fadeIn:0,fadeOut:0}}],markers:[]}),sourceReceipts:[{sourceId:source.id,receiptRevision:receipt}]};}
const ranges=(frames=60):EditAssemblyRange[]=>[{id:"opening",fromFrame:30,toFrame:30+frames,reason:"Keep the opening exchange."}];
const input=(id="proposal",purpose:EditAssemblyPurpose="custom",selected=ranges())=>({id,label:"Reviewed alternate",purpose,ranges:selected});
const create=(purpose:EditAssemblyPurpose="custom",frames=60)=>createEditAssemblyProposal(emptyEditAssemblyLibrary(),input("proposal",purpose,ranges(frames)),parent(),0,now);
function seal<T extends {revision:string}>(value:T):T {const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;}

test("assembly proposals retain immutable parent snapshots and ordered repeated ranges through independent acceptance",()=>{
  const original=parent(),selected=[{id:"later",fromFrame:90,toFrame:120,reason:"Start with the reaction."},{id:"earlier",fromFrame:0,toFrame:30,reason:"Return to the setup."},{id:"repeat",fromFrame:90,toFrame:120,reason:"Repeat the reaction."}],before=structuredClone(original),empty=emptyEditAssemblyLibrary();
  const library=createEditAssemblyProposal(empty,input("proposal","trailer",selected),original,0,now),proposal=library.proposals[0]!;
  expect(empty.version).toBe(0);expect(empty.proposals).toEqual([]);expect(proposal.plan.frames).toBe(90);expect(proposal.plan.ranges.map(r=>r.id)).toEqual(["later","earlier","repeat"]);expect(original).toEqual(before);
  original.timeline.clips[0]!.opacity=.5;selected[0]!.reason="Changed caller state";expect(proposal.plan.parent).toEqual(before);expect(proposal.plan.ranges[0]!.reason).toBe("Start with the reaction.");
  const result=acceptEditAssemblyProposal(library,proposal.id,proposal.revision,"independent",parent(),library.version,now+1);expect(result.replayed).toBe(false);expect(result.library.version).toBe(2);expect(result.assembly).toMatchObject({id:"independent",proposalId:proposal.id,proposalRevision:proposal.revision,proposalCreatedAt:proposal.createdAt,acceptedAt:new Date(now+1).toISOString()});expect(result.assembly.plan).toEqual(proposal.plan);expect(result.assembly.target).toBeUndefined();
  result.assembly.plan.parent.timeline.clips[0]!.opacity=.25;result.library.proposals[0]!.plan.ranges[0]!.reason="Only this returned proposal changes";expect(result.library.assemblies[0]!.plan).toEqual(proposal.plan);expect(library.assemblies).toEqual([]);expect(library.proposals[0]!.plan.parent).toEqual(before);
});

test("proposal revisions preserve accepted provenance and reject stale library, proposal and parent bindings",()=>{
  const first=create(),proposal=first.proposals[0]!,accepted=acceptEditAssemblyProposal(first,proposal.id,proposal.revision,"assembly",parent(),1,now+1),change={label:"Shorter alternate",purpose:"trailer" as const,ranges:ranges(30)};
  expect(()=>createEditAssemblyProposal(first,input("new"),parent(),0,now)).toThrow("library changed");expect(()=>reviseEditAssemblyProposal(first,proposal.id,change,parent(),0,proposal.revision)).toThrow("library changed");expect(()=>reviseEditAssemblyProposal(first,proposal.id,change,parent(),1,contentHash("stale"))).toThrow("proposal changed");
  for(const mutate of [(p:EditAssemblyParent)=>p.sequenceId="other",(p:EditAssemblyParent)=>p.historyRevision=contentHash("undo then redo"),(p:EditAssemblyParent)=>p.sourceReceipts[0]!.receiptRevision=contentHash("new receipt"),(p:EditAssemblyParent)=>{const {revision:_revision,...data}=p.timeline;p.timeline=editTimeline({...data,markers:[{id:"new",frame:1,label:"New marker"}]});}]){
    const changed=parent();mutate(changed);expect(()=>reviseEditAssemblyProposal(first,proposal.id,change,changed,1,proposal.revision)).toThrow();expect(()=>acceptEditAssemblyProposal(first,proposal.id,proposal.revision,"new",changed,1,now+1)).toThrow();
  }
  const revised=reviseEditAssemblyProposal(accepted.library,proposal.id,change,parent(),2,proposal.revision);expect(revised.version).toBe(3);expect(revised.proposals[0]!.createdAt).toBe(proposal.createdAt);expect(revised.proposals[0]!.revision).not.toBe(proposal.revision);expect(revised.proposals[0]!.plan.parent).toEqual(proposal.plan.parent);expect(revised.assemblies[0]).toEqual(accepted.assembly);expect(validateEditAssemblyLibrary(revised)).toEqual(revised);
  const second=acceptEditAssemblyProposal(revised,proposal.id,revised.proposals[0]!.revision,"second-assembly",parent(),3,now+2);expect(second.library.assemblies).toHaveLength(2);expect(second.library.assemblies[0]!.plan.frames).toBe(60);expect(second.library.assemblies[1]!.plan.frames).toBe(30);
});

test("acceptance retries return the recorded identity after later changes and conflicting reuse never adds an assembly",()=>{
  const first=create(),proposal=first.proposals[0]!,saved=acceptEditAssemblyProposal(first,proposal.id,proposal.revision,"assembly",parent(),1,now+1),revised=reviseEditAssemblyProposal(saved.library,proposal.id,{label:"Changed proposal",purpose:"custom",ranges:ranges(90)},parent(),2,proposal.revision),changed=parent();changed.historyRevision=contentHash("parent changed after acceptance");
  const retry=acceptEditAssemblyProposal(revised,proposal.id,proposal.revision,"assembly",changed,1,now+100);expect(retry.replayed).toBe(true);expect(retry.library).toEqual(revised);expect(retry.assembly).toEqual(saved.assembly);expect(retry.library.assemblies).toHaveLength(1);
  for(const [id,revision,destination]of [[proposal.id,proposal.revision,"different-destination"],[proposal.id,revised.proposals[0]!.revision,"assembly"],["different-proposal",proposal.revision,"assembly"]])expect(()=>acceptEditAssemblyProposal(revised,id!,revision!,destination!,parent(),3,now+2)).toThrow("acceptance already belongs");
  expect(()=>acceptEditAssemblyProposal(first,proposal.id,contentHash("unreviewed"),"new",parent(),1,now+1)).toThrow("reviewed proposal changed");expect(()=>acceptEditAssemblyProposal(first,proposal.id,proposal.revision,"new",parent(),0,now+1)).toThrow("library changed");expect(()=>acceptEditAssemblyProposal(first,proposal.id,proposal.revision,"new",parent(),1,now-1)).toThrow("before its proposal");expect(first.assemblies).toEqual([]);
});

test("sixty-second acceptance explicitly records exact, short and long target outcomes without changing ranges",()=>{
  for(const frames of [1799,1800,1801]){const library=create("sixty-second",frames),proposal=library.proposals[0]!,result=acceptEditAssemblyProposal(library,proposal.id,proposal.revision,"accepted",parent(),1,now+1);expect(result.assembly.target).toEqual({frames:1800,status:frames===1800?"exact":frames<1800?"short":"long",deltaFrames:frames-1800});expect(result.assembly.plan).toEqual(proposal.plan);expect(result.assembly.plan.frames).toBe(frames);
    const malformed=structuredClone(result.library);malformed.assemblies[0]!.target!.status=frames===1800?"long":"exact";malformed.assemblies[0]=seal(malformed.assemblies[0]!);expect(()=>validateEditAssemblyLibrary(seal(malformed))).toThrow("actual sixty-second target");
  }
});

test("sealed libraries reject malformed and rehashed nested records, changed originals and duplicate identities",()=>{
  const first=create(),proposal=first.proposals[0]!,saved=acceptEditAssemblyProposal(first,proposal.id,proposal.revision,"assembly",parent(),1,now+1).library;
  for(const mutate of [(x:any)=>x.unexpected=true,(x:any)=>x.proposals[0].plan.ranges[0].unexpected=true,(x:any)=>x.proposals[0].plan.ranges[0].toFrame=-1,(x:any)=>x.proposals[0].plan.parent.historyRevision="short",(x:any)=>x.proposals[0].plan.parent.timeline.clips[0].sourceId="foreign",(x:any)=>x.proposals[0].plan.parent.sourceReceipts[0].receiptRevision="short",(x:any)=>x.proposals[0].createdAt="yesterday",(x:any)=>x.proposals[0].purpose="automatic-masterpiece",(x:any)=>x.proposals.push(structuredClone(x.proposals[0])),(x:any)=>x.assemblies.push(structuredClone(x.assemblies[0])),(x:any)=>x.assemblies.push({...structuredClone(x.assemblies[0]),id:"copy"}),(x:any)=>x.assemblies[0].proposalRevision=contentHash("other"),(x:any)=>x.assemblies[0].target={frames:1800,status:"exact",deltaFrames:0}]){
    const bad=structuredClone(saved);mutate(bad);for(const p of bad.proposals){p.plan=seal(p.plan);Object.assign(p,seal(p));}for(const a of bad.assemblies)Object.assign(a,seal(a));expect(()=>validateEditAssemblyLibrary(seal(bad))).toThrow();
  }
  const detached=structuredClone(saved),changedParent=parent();changedParent.historyRevision=contentHash("new parent");detached.proposals[0]!.plan.parent=changedParent;detached.proposals[0]!.plan=seal(detached.proposals[0]!.plan);detached.proposals[0]=seal(detached.proposals[0]!);expect(()=>validateEditAssemblyLibrary(seal(detached))).toThrow("immutable proposal parent");
  expect(()=>createEditAssemblyProposal(first,input(),parent(),1,now)).toThrow("new proposal identity");expect(()=>createEditAssemblyProposal(first,{...input("new"),label:" padded "},parent(),1,now)).toThrow("readable");expect(()=>createEditAssemblyProposal(first,{...input("new"),job:{path:"secret"}} as any,parent(),1,now)).toThrow("supported assembly fields");expect(()=>validateEditAssemblyLibrary({...saved,revision:"short"})).toThrow("complete assembly revision");
  expect(()=>validateEditAssemblyLibrary({...saved,proposals:[null]} as any)).toThrow("supported assembly fields");expect(()=>validateEditAssemblyLibrary({...saved,assemblies:[null]} as any)).toThrow("supported assembly fields");
});

test("proposal and accepted-library bounds reject overflow without truncation or partial state",()=>{
  let library=emptyEditAssemblyLibrary();for(let i=0;i<EDIT_ASSEMBLY_LIBRARY_LIMITS.proposals;i++)library=createEditAssemblyProposal(library,input("proposal-"+i),parent(),library.version,now+i);
  expect(library.proposals).toHaveLength(32);expect(()=>createEditAssemblyProposal(library,input("overflow"),parent(),library.version,now+40)).toThrow("32 proposals");
  for(const proposal of library.proposals)library=acceptEditAssemblyProposal(library,proposal.id,proposal.revision,"assembly-"+proposal.id,parent(),library.version,now+100).library;expect(library.assemblies).toHaveLength(32);
  const first=library.proposals[0]!,revised=reviseEditAssemblyProposal(library,first.id,{label:"Another revision",purpose:"custom",ranges:ranges(90)},parent(),library.version,first.revision);expect(()=>acceptEditAssemblyProposal(revised,first.id,revised.proposals[0]!.revision,"overflow",parent(),revised.version,now+101)).toThrow("32 accepted assemblies");expect(revised.assemblies).toHaveLength(32);
  const huge=structuredClone(library),text="界".repeat(700000);for(const proposal of huge.proposals)proposal.label=text;expect(()=>validateEditAssemblyLibrary(huge)).toThrow("64 MiB");expect(()=>validateEditAssemblyLibrary(seal({...create(),version:0}))).toThrow("initial assembly library");
});

test("proposal boundaries reject nonportable data before invoking getters or JSON coercion",()=>{
  const library=create();let invoked=false;const accessor=structuredClone(library);Object.defineProperty(accessor.proposals[0]!,"label",{enumerable:true,get(){invoked=true;return "Hidden getter";}});expect(()=>validateEditAssemblyLibrary(accessor)).toThrow("plain enumerable");expect(invoked).toBe(false);
  for(const mutate of [(x:any)=>x.proposals.extra=true,(x:any)=>x.proposals[Symbol("hidden")]=true,(x:any)=>delete x.proposals[0],(x:any)=>x.proposals[0].plan.parent=x,(x:any)=>Object.defineProperty(x,"hidden",{value:true}),(x:any)=>x.version=-0,(x:any)=>x.proposals[0].createdAt=new Date(now)]){const bad=structuredClone(library);mutate(bad);expect(()=>validateEditAssemblyLibrary(bad)).toThrow();}
  const value=input("other");Object.defineProperty(value,"label",{enumerable:true,get(){invoked=true;return "Hidden getter";}});expect(()=>createEditAssemblyProposal(library,value,parent(),1,now)).toThrow("plain enumerable");expect(invoked).toBe(false);
});
