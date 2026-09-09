// PRIVATE, UNAPPLIED, UNEXECUTED. Intended storage/test helper. No tests register
// here and no worker is called here: the owning phased fixture executes each
// returned JobInput through its existing held-worker cancellation/drain guard.
import {expect} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {ProjectService,type PersistedState} from "../../api/src/index";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import type {WorkerContext} from "../../queue/src/worker";
import {VersionStore} from "../../parser/src/index";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {createProviderPlan} from "../../generator/src/catalog";
import {contentHash as hash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {verifyEditMedia} from "../../generator/src/edit-media";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {bindOriginalEditSource,createEditPlan,editRenderReview} from "../../planner/src/edit-jobs";
import {editHistoryState} from "../../planner/src/edit-history";
import {assertEditOriginalSelection,validateEditSourceReceipt,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {createLivingScriptJobPlan,type LivingScriptJobPlan} from "../../planner/src/living-script-jobs";
import {validateLivingScriptOutput} from "../../planner/src/living-script-job-context";
import {emptyLivingScriptProposals} from "../../planner/src/living-script-proposals";
import {renderShots} from "../../planner/src/shot-reuse";
import {bootstrapLivingScriptDocument} from "../../planner/src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../../planner/src/living-script-shot-plan";
import {createLivingScriptStructureBase} from "../../planner/src/living-script-structure";
import {currentFilmV3Job} from "../../planner/src/current-film-runtime-context";
import {compileCurrentFilmProofClosure} from "../../planner/src/current-film-proof-closure";
import {validateCurrentScreenplayRecovery} from "../src/current-screenplay-snapshots";
import {stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../src/snapshots";

type Options={state:PersistedState;jobs:Job[];context:WorkerContext;root:string;workingRoot:string;token:string;receipt:EditSourceReceipt};
function required<T>(value:T|null|undefined,message:string):T {if(value===undefined||value===null)throw new Error(message);return value;}
function ownerAt(snapshot:StateSnapshot,path:string[]):EditSourceReceipt {
  let value:unknown=snapshot;
  for(const key of path){const field=value&&typeof value==="object"?Object.getOwnPropertyDescriptor(value,key):undefined;
    if(!field||!Object.hasOwn(field,"value"))throw new Error("The authentic owner path is absent.");value=field.value;}
  return value as EditSourceReceipt;
}

export function prepareLegacyMixedSourceOwners(options:Options){
  validateEditSourceReceipt(options.receipt);const mixed=currentFilmV3Job(options.receipt.job);
  if(options.receipt.schema!=="hv-edit-source/4"||mixed.stage!=="final")throw new Error("Use the already-settled genuine final /4 fixture.");
  const final=structuredClone(options.receipt),sourceRevision=hash(final),parentState=hash(options.state),parentJobs=hash(options.jobs);
  const createdIds=["legacy-wrapper-current-animatic","legacy-wrapper-pending-animatic","legacy-wrapper-editorial-carrier"];
  if(createdIds.some(id=>options.jobs.some(job=>job.id===id)||existsSync(join(options.root,mixed.projectId,id))))throw new Error("Use fresh isolated legacy-wrapper owners.");
  const folder=mkdtempSync(join(options.workingRoot,"legacy-wrapper-")),statePath=join(folder,"state.json"),queuePath=join(folder,"jobs.json"),ledgerPath=join(folder,"costs.json"),reviewsPath=join(folder,"reviews.json");
  writeFileSync(statePath,JSON.stringify(options.state));writeFileSync(queuePath,JSON.stringify(options.jobs));
  const projects=new ProjectService(statePath),store=new DurableJobStore(queuePath),ledger=new CostLedger(ledgerPath),reviewQueue=new OperatorReviewQueue(reviewsPath);
  const context:WorkerContext={...options.context,projects,ledger,reviewQueue},project=required(projects.authorize(options.token),"Actual owner is unavailable"),latest=required(project.versions.latest(),"Retain the current script");
  const casting=currentCasting(project.id,project.castingHistory),direction=currentDirection(project.id,project.directionHistory),providerPlan=createProviderPlan("animatic",5,undefined,{...process.env,HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});
  const ordinaryInput:JobInput={id:"legacy-wrapper-current-animatic",idempotencyKey:project.id+":legacy-wrapper-current-animatic",projectId:project.id,stage:"animatic",tier:"free",
    scriptVersion:latest.version,scriptText:latest.text,casting,...(direction.version?{direction}:{}),providerPlan,providerSpec:providerPlan.pool[0]!.spec,
    totalFrames:0,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,costCapUsd:5,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:120000};
  ordinaryInput.totalFrames=renderShots(ordinaryInput).reduce((sum,shot)=>sum+Math.round(shot.durationSec*30),0);
  let ordinary:EditSourceReceipt|undefined,wrapper:EditSourceReceipt|undefined,pendingPlan:LivingScriptJobPlan|undefined,carrierInput:JobInput|undefined;
  let beforeFiles:Map<string,{bytes:number;sha256:string}>|undefined;
  const allFiles=()=>new Map(final.files.map(file=>{const data=readFileSync(join(options.root,file.path));return [file.path,{bytes:data.byteLength,sha256:createHash("sha256").update(data).digest("hex")}] as const;}));
  const verifyOriginals=()=>{expect(hash(final)).toBe(sourceRevision);expect(hash(options.state)).toBe(parentState);expect(hash(options.jobs)).toBe(parentJobs);
    expect(allFiles()).toEqual(required(beforeFiles,"Record source bytes before starting the branch"));};
  const currentProject=()=>required(projects.authorize(options.token),"The branch owner is unavailable");
  const savedJob=(result:Job,id:string)=>{expect(result.id).toBe(id);expect(result.status).toBe("done");expect(result.failureReason??result.cancelReason).toBeUndefined();expect(store.get(id)).toEqual(result);return result;};
  const access=(job:Job,outer:()=>Promise<void>)=>async()=>{await outer();assertEditOriginalSelection(job,store.get(job.id),currentProject());};
  const snapshot=():StateSnapshot=>({schema:"hv-state/16",projects:projects.snapshot(),jobs:store.all().filter(job=>job.id!==wrapper?.job.id),
    ledger:existsSync(ledgerPath)?JSON.parse(readFileSync(ledgerPath,"utf8")) as StateSnapshot["ledger"]:{events:[],reservations:[]},
    reviews:existsSync(reviewsPath)?JSON.parse(readFileSync(reviewsPath,"utf8")) as StateSnapshot["reviews"]:[]});
  function assertOwner(state:StateSnapshot,path:string[]):void {
    const owned=ownerAt(state,path);expect(owned.schema).toBe("hv-edit-source/1");expect(owned).toEqual(required(wrapper,"Complete actual pending media first"));
    expect(state.jobs.some(job=>job.id===owned.job.id)).toBe(false);
    const library=required(owned.job.livingScript,"Retain actual pending plan").proposal.editorial;
    expect(library.schema).toBe("hv-edit-library/2");const index=library.sources.findIndex(receipt=>receipt.revision===final.revision);
    expect(index).toBeGreaterThanOrEqual(0);const nested=library.sources[index]!;expect(nested).toEqual(final);
    const before=JSON.stringify(state);expect(stateSnapshotSchema(state.projects,state.jobs)).toBe("hv-state/16");expect(validateSnapshot(state)).toBe(state);expect(JSON.stringify(state)).toBe(before);
    const captures=validateCurrentScreenplayRecovery(state.projects,state.jobs),original=currentFilmV3Job(nested.job);
    for(const row of original.currentFilmCheckpoint!.rows)if(row.kind==="generated")expect(captures.has(row.capture)).toBe(true);
    const missing=structuredClone(state);missing.projects.projects.find(value=>value.id===project.id)!.livingScriptProposals=emptyLivingScriptProposals(project.id);
    expect(()=>validateSnapshot(missing)).toThrow("saved screenplay proposal");
    const conflict=structuredClone(state),actual=conflict.jobs.find(job=>job.id===final.job.id)!;
    actual.linkExpiresAt=new Date(Date.parse(actual.linkExpiresAt!)+1000).toISOString();expect(()=>validateSnapshot(conflict)).toThrow();
    const alias=structuredClone(state);Object.assign(alias.projects.projects[0]!,{abandonedLegacyOwner:structuredClone(owned)});expect(()=>validateSnapshot(alias)).toThrow("unowned");
    let reads=0;const hostile=structuredClone(state),at=ownerAt(hostile,path);
    Object.defineProperty(at.job,"livingScript",{enumerable:true,get(){reads++;return owned.job.livingScript;}});expect(()=>validateSnapshot(hostile)).toThrow();expect(reads).toBe(0);
    verifyOriginals();
  }
  return {projects,store,context,folder,createdIds,ordinaryInput,
    begin(){beforeFiles=allFiles();for(const file of final.files)expect(beforeFiles.get(file.path)).toEqual({bytes:file.bytes,sha256:file.sha256});
      expect(store.enqueue(ordinaryInput).currentFilm).toBeUndefined();},
    async propose(result:Job,outer:()=>Promise<void>,signal:AbortSignal):Promise<JobInput>{
      const job=savedJob(result,ordinaryInput.id);ordinary=await inspectEditSource(job,"Actual current-script ordinary animatic",options.root,access(job,outer),signal);
      expect(ordinary.schema).toBe("hv-edit-source/1");expect(job.scriptVersion).toBe(latest.version);expect(job.scriptText).toBe(latest.text);
      const binding=bindOriginalEditSource(ordinary),finalBinding=bindOriginalEditSource(final),p=currentProject();
      const library=required(projects.createEditSequence(options.token,[ordinary,final],"legacy-wrapper-parent","Legacy line with unselected mixed original",job.id,320,180,p.editLibrary.version,Date.now(),[binding,finalBinding]),"Save actual source catalog");
      const parent=deriveEditAssemblyParent(p.id,library,"legacy-wrapper-parent"),index=compileEditScriptSource(ordinary),line=required(index.entries.find(entry=>entry.kind==="dialogue"),"The real ordinary film needs dialogue");
      const navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,parent.sourceReceipts.map(ref=>compileEditScriptSource(required(library.sources.find(source=>source.revision===ref.receiptRevision),"Keep every exact parent original"))));
      const patch=compileLivingScriptPatch(ordinary,{entryId:line.id,indexRevision:index.revision,currentScript:{version:job.scriptVersion,text:job.scriptText},replacement:"Welcome to this quiet garden."});
      const impact=compileLivingScriptGenerationImpact(ordinary,patch,{projectId:job.projectId,stage:job.stage,tier:job.tier,scriptVersion:patch.after.version,scriptText:patch.after.text,
        ...(job.casting?{casting:job.casting}:{}),...(job.direction?{direction:job.direction}:{}),providerPlan:job.providerPlan});
      const proposal=required(projects.createLivingScriptProposal(options.token,{id:"legacy-wrapper-line",label:"Actual pending legacy line",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,
        editorialRevision:library.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline:{casting:currentCasting(p.id,p.castingHistory),direction:currentDirection(p.id,p.directionHistory)}},p.livingScriptProposals.version,
        [{binding,current:job},{binding:finalBinding,current:final.job}]),"Save actual pending proposal").proposal;
      expect(proposal.editorial.sources.find(source=>source.revision===final.revision)).toEqual(final);expect(proposal.request.patch.receiptRevision).toBe(ordinary.revision);
      expect(proposal.impact.parent.timeline.clips.every(clip=>clip.sourceId!==final.facts.id)).toBe(true);
      pendingPlan=createLivingScriptJobPlan(proposal,binding,{role:"render"});expect(pendingPlan.inputs.stage).toBe("animatic");
      const input:JobInput={...pendingPlan.inputs,id:createdIds[1]!,idempotencyKey:project.id+":"+createdIds[1],livingScript:pendingPlan,shotReuse:pendingPlan.shotReuse,
        totalFrames:renderShots(pendingPlan.inputs).reduce((sum,shot)=>sum+Math.round(shot.durationSec*30),0),rightsAttestedAt:p.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
        costCapUsd:5,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:120000};
      store.enqueue(input);verifyOriginals();return input;
    },
    async retain(result:Job,outer:()=>Promise<void>,signal:AbortSignal):Promise<JobInput>{
      const job=savedJob(result,createdIds[1]!);validateLivingScriptOutput(job,required(job.output,"Real pending output required"));expect(job.livingScript).toEqual(pendingPlan);expect(job.currentFilm).toBeUndefined();
      wrapper=await inspectEditSource(job,"Actual legacy pending owner with frozen mixed history",options.root,access(job,outer),signal);expect(wrapper.schema).toBe("hv-edit-source/1");
      const p=currentProject(),binding=bindOriginalEditSource(wrapper);let library=required(projects.createEditSequence(options.token,[wrapper],"legacy-wrapper-carrier","Retain actual legacy wrapper",job.id,320,180,p.editLibrary.version,Date.now(),[binding]),"Save wrapper sequence");
      const wrapperIndex=library.sources.findIndex(receipt=>receipt.revision===wrapper!.revision);assertOwner(snapshot(),["projects","projects","0","editLibrary","sources",String(wrapperIndex)]);
      const sequence=required(library.sequences.find(value=>value.id==="legacy-wrapper-carrier"),"Keep exact wrapper cut");
      library=required(projects.changeEditSequence(options.token,sequence.id,{kind:"edit",label:"One second preserving full handles",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-wrapper.facts.frames,ripple:true}},library.version,sequence.history.revision),"Trim wrapper cut");
      const cut=required(library.sequences.find(value=>value.id===sequence.id),"Keep trimmed wrapper cut"),timeline=editHistoryState(cut.history).timeline;
      carrierInput={id:createdIds[2]!,idempotencyKey:project.id+":"+createdIds[2],projectId:project.id,tier:"free",stage:"picture-edit",scriptVersion:job.scriptVersion,scriptText:job.scriptText,
        pictureEdit:createEditPlan(cut,[binding],soundRuntimeRevision(),"local",hash("legacy-wrapper-carrier"),editRenderReview(timeline)),totalFrames:30,rightsAttestedAt:p.rightsAttestedAt,
        animaticJobId:null,animaticApprovedAt:null,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000};store.enqueue(carrierInput);return carrierInput;
    },
    async verifyCarrier(result:Job,outer:()=>Promise<void>,signal:AbortSignal):Promise<void>{
      const job=savedJob(result,createdIds[2]!);expect(job.pictureEdit).toEqual(carrierInput!.pictureEdit);expect(job.output).toEqual(job.editCheckpoint);await verifyEditMedia(job,job.output!,options.root,outer,signal);
      const state=snapshot(),index=state.jobs.findIndex(value=>value.id===job.id),body=state.jobs[index]!,bindingIndex=body.pictureEdit!.bindings.findIndex(value=>value.source.revision===wrapper!.revision);
      assertOwner(state,["jobs",String(index),"pictureEdit","bindings",String(bindingIndex),"source"]);
      for(const field of ["output","editCheckpoint"]){const prepared=body[field as "output"|"editCheckpoint"]!.editorial!.prepared.sources,receiptIndex=prepared.findIndex(value=>value.receipt.revision===wrapper!.revision);
        assertOwner(state,["jobs",String(index),field,"editorial","prepared","sources",String(receiptIndex),"receipt"]);}
      expect(ledger.monthSpend()).toBe(0);verifyOriginals();
    },
    rejectCanonicalReplacement(){
      const source=required(wrapper,"Complete actual pending wrapper"),p=currentProject(),before=projects.snapshot(),library=p.currentScreenplay;
      const proposalVersions=VersionStore.hydrate(p.versions.history()),script=proposalVersions.commit(source.job.scriptText);
      expect(script.version).toBe(source.job.scriptVersion); // Candidate only; no owner version committed.
      const base=createLivingScriptStructureBase({projectId:p.id,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]});
      const request={id:"unsupported-wrapper-rebootstrap",label:"Unsupported replacement origin",script,source,documentSource,originalPlan:bootstrapLivingScriptShotPlan(source,documentSource),
        baseline:{casting:currentCasting(p.id,p.castingHistory),direction:currentDirection(p.id,p.directionHistory)}};
      expect(()=>projects.bootstrapCurrentScreenplay(options.token,request,library.version,{binding:bindOriginalEditSource(source),current:source.job})).toThrow("immutable screenplay bootstrap");
      expect(projects.snapshot()).toEqual(before);
      const own=mixed.currentFilmProof!.specification,missing={...own.frozenContext,jobs:own.frozenContext.jobs.filter(value=>value.id!==mixed.animaticJobId)};
      expect(()=>compileCurrentFilmProofClosure(mixed.currentFilm,missing,own.target)).toThrow("target final requires its actual saved preview");
      verifyOriginals();
    },
    verifyOriginals,
  };
}
