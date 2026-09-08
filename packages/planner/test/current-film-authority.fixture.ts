import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {createProviderPlan} from "../../generator/src/catalog";
import {currentCasting,castingSnapshot} from "../src/casting";
import {currentDirection} from "../src/direction";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument} from "../src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../src/living-script-shot-plan";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBlock} from "../src/living-script-structure";
import {proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";
import {emptyCurrentScreenplayLibrary,bootstrapCurrentScreenplayLibrary,saveCurrentScreenplayProposal,acceptCurrentScreenplayProposal,currentScreenplayHead} from "../src/current-screenplay-library";
import {compileCurrentFilmJob} from "../src/current-film-jobs";
import type {PersistedProject} from "../../api/src/index";
import type {ReferenceAsset} from "../src/references";

/** Actual legacy worker origin. The optional image below is explicitly metadata-only catalog
 * evidence for authority rejection tests; it is never claimed as generated or loaded media. */
export async function currentFilmAuthorityFixture(withReference=false){
  const studio=await dubStudio(),project=structuredClone(studio.projects.snapshot().projects[0]!),at=Date.now()+100;
  const source=await inspectEditSource(studio.film,"Current authority original",studio.paths.artifactRoot,async()=>{}),script=project.versions.at(-1)!;
  let casting=currentCasting(project.id,project.castingHistory);const characters=structuredClone(casting.characters);
  characters[0]!.permission.expiresAt=new Date(at+45*86400000).toISOString();
  if(withReference){const asset:ReferenceAsset={schema:"hv-reference/1",id:crypto.randomUUID(),projectId:project.id,sha256:"a".repeat(64),originalSha256:"b".repeat(64),bytes:24,width:1,height:1,contentType:"image/png",createdAt:new Date(at).toISOString(),attestedAt:new Date(at).toISOString()};characters[0]!.references=[asset];project.referenceAssets=[asset];}
  casting=castingSnapshot(project.id,casting.version+1,characters,at);project.castingHistory=[...(project.castingHistory??[]),casting];project.deleteAfter=new Date(at+60*86400000).toISOString();
  const base=createLivingScriptStructureBase({projectId:project.id,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]});
  project.currentScreenplay=bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(project.id),{id:"current-authority-root",label:"Original authority",script,source,documentSource,originalPlan:bootstrapLivingScriptShotPlan(source,documentSource),baseline:{casting,direction:currentDirection(project.id,project.directionHistory)}},0,at).library;
  const plan=compileCurrentFilmJob(project.currentScreenplay,{kind:"accepted",revision:project.currentScreenplay.headRevision!},{role:"preview",tier:"free",providerPlan:createProviderPlan("animatic",5,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["mock"]'})},at+1);
  return {studio,project,plan,at};
}
export function currentFilmAuthorityProposal(project:PersistedProject,id:string,at:number,text="Welcome home.\nStay for a while.\n"){
  const library=project.currentScreenplay!,head=currentScreenplayHead(library)!,state=head.state,document=state.context.plan.document,line=document.lines.find(value=>value.text.includes("Welcome"))!;
  const patch=compileLivingScriptStructure(document.context.base,{baseRevision:document.context.base.revision,operations:[{id:"change-"+id,kind:"replace",block:livingScriptStructureBlock(document.context.base,line.line,line.line+1),text}]});
  const afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]}),capacity={tier:"free" as const,maxShots:24 as const};
  const plan=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument,capacity,requestId:"plan-"+id});
  if(!plan.review.candidate||plan.review.conflicts.length)throw new Error("Authority fixture requires a complete actual structural proposal.");
  const saved=saveCurrentScreenplayProposal(library,{id,label:"Authority "+id,expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,capacity,planRequest:plan.request,directionRequest:createCurrentDirectionRequest(state.direction,plan.review.candidate,{id:"direction-"+id,settings:[],lines:[],retired:[]})},library.version,at);
  const next={...structuredClone(project),currentScreenplay:saved.library};
  const pending=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},{role:"preview",tier:"free",providerPlan:createProviderPlan("animatic",5,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["mock"]'})},at+1);
  return {project:next,plan:pending,saved,accept(acceptedAt=at+2){const accepted=acceptCurrentScreenplayProposal(saved.library,{id:"accept-"+id,proposalRevision:saved.proposal.revision,expectedHeadRevision:head.revision},saved.library.version,acceptedAt);
    return {...structuredClone(next),currentScreenplay:accepted.library,versions:[...next.versions,...accepted.versions],castingHistory:[...(next.castingHistory??[]),accepted.acceptance.state.casting.candidate!]};}};
}
