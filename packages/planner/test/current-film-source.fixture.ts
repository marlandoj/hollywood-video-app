import {join} from "node:path";
import {writeFileSync} from "node:fs";
import {currentFilmAuthorityFixture} from "./current-film-authority.fixture";
import {ProjectService} from "../../api/src/index";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {createProviderPlan} from "../../generator/src/catalog";
import {compileCurrentFilmJob,type CurrentFilmJobV2} from "../src/current-film-jobs";
import {createCurrentFilmPreviewReview,currentFilmV2Job,type CurrentFilmV2Job} from "../src/current-film-job-context";
import {currentScreenplayHead,saveCurrentScreenplayProposal,acceptCurrentScreenplayProposal} from "../src/current-screenplay-library";
import {compileLivingScriptDocument} from "../src/living-script-document";
import {compileLivingScriptStructure,livingScriptStructureBlock,livingScriptStructureBoundary} from "../src/living-script-structure";
import {proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";

/** Real no-cost original + pending canonical multiline/inserted-scene film.
 * This helper registers no tests. All media live in dubStudio's owned scratch. */
export async function currentFilmSourceFixture(){
  const origin=await currentFilmAuthorityFixture();
  try{
    const {studio}=origin,originalProject=structuredClone(origin.project),library=origin.project.currentScreenplay!,head=currentScreenplayHead(library)!,state=head.state,document=state.context.plan.document;
    const line=document.lines.find(value=>value.text.includes("Welcome"))!,base=document.context.base;
    const patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[
      {id:"repeat-spoken-line",kind:"replace",block:livingScriptStructureBlock(base,line.line,line.line+1),text:"Welcome home.\nWelcome home.\n"},
      {id:"introduce-source-scene",kind:"insert",at:livingScriptStructureBoundary(base,1),text:"EXT. LANTERN - NIGHT\nA blue lantern glows.\n\n"},
    ]}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]}),capacity={tier:"free" as const,maxShots:24 as const};
    const evolution=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument,capacity,requestId:"source-fixture-plan"});
    if(!evolution.review.candidate||evolution.review.conflicts.length)throw new Error("The source fixture needs a complete structural shot plan.");
    const saved=saveCurrentScreenplayProposal(library,{id:"source-fixture-proposal",label:"Inserted scene and repeated dialogue",expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,capacity,planRequest:evolution.request,directionRequest:createCurrentDirectionRequest(state.direction,evolution.review.candidate,{id:"source-fixture-direction",settings:[],lines:[],retired:[]})},library.version,Date.now());
    const queuePath=join(studio.root,"current-source-jobs.json");writeFileSync(queuePath,JSON.stringify([studio.film]));
    const project={...structuredClone(origin.project),currentScreenplay:saved.library},projects=ProjectService.fromState({...studio.projects.snapshot(),projects:[project]}),store=new DurableJobStore(queuePath);
    const context={projects,ledger:new CostLedger(join(studio.root,"current-source-ledger.json")),reviewQueue:new OperatorReviewQueue(join(studio.root,"current-source-reviews.json"))};
    const plan=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},{role:"preview",tier:"free",providerPlan:createProviderPlan("animatic",5,undefined,{...process.env,HV_ANIMATIC_PROVIDER_POOL:'["mock"]'})});
    const input=(id:string,p:CurrentFilmJobV2):JobInput=>({id,projectId:p.projectId,idempotencyKey:id,tier:p.render.tier,stage:p.render.stage,scriptVersion:p.materialization.script.version,scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,currentFilm:p,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000});
    const run=async(request:JobInput):Promise<CurrentFilmV2Job>=>{store.enqueue(request);const result=await processNextJob(store,studio.paths.artifactRoot,context);if(!result||result.status!=="done")throw new Error("Current source fixture worker failed: "+(result?.failureReason??result?.cancelReason));return currentFilmV2Job(result);};
    const job=await run(input("current-source-preview",plan)),receipt=await inspectEditSource(job,"Canonical pending source",studio.paths.artifactRoot,async()=>{});
    const accept=(at=Date.now())=>{const accepted=acceptCurrentScreenplayProposal(saved.library,{id:"accept-source-fixture",proposalRevision:saved.proposal.revision,expectedHeadRevision:head.revision},saved.library.version,at);
      return {...structuredClone(project),currentScreenplay:accepted.library,versions:[...project.versions,...accepted.versions],castingHistory:[...(project.castingHistory??[]),accepted.acceptance.state.casting.candidate!]};};
    const renderFinal=async()=>{
      const review=createCurrentFilmPreviewReview(job),decision=projects.recordCurrentFilmDecision(studio.owner.token,job,review,"approved","Use actual source fixture preview")!;
      const finalPlan=compileCurrentFilmJob(saved.library,plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5,undefined,{...process.env,HV_PROVIDER_POOL:'["mock"]'})});
      const previous=process.env.HV_PROVIDER_POOL;process.env.HV_PROVIDER_POOL='["mock"]';try{const final=await run({...input("current-source-final",finalPlan),animaticJobId:job.id,animaticApprovedAt:decision.approval.at});
        return {job:final,receipt:await inspectEditSource(final,"Canonical overlapping final",studio.paths.artifactRoot,async()=>{})};
      }finally{if(previous===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=previous;}
    };
    return {studio,originalProject,project,projects,store,context,plan,job,receipt,saved,patch,accept,renderFinal,close:()=>studio.close()};
  }catch(error){await origin.studio.close();throw error;}
}
