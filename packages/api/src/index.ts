import {sourcePlan,staleSceneCuts,cutSource,cutProposal,proposeSceneCut,sceneCut,validateCutProposal,SceneCutConflict,type CutProposal,type CutBinding,type SceneCut} from "../../planner/src/scene-cuts";
import {shotTakeShots,validateShotTakes,assertTakeCatalog,type ShotTakePlan} from "../../planner/src/takes";
import {assertMotionStudyCurrent,createMotionStudy,emptyMotionStudies,validateMotionStudies,type MotionContext,type MotionStudies} from "../../planner/src/motion-studies";
import { REVIEW_MAX_VIEWS, mintProjectToken, mintReviewToken, verifyToken } from "./tokens";
import { reviewViewLimit, reviewViewerKnown, type ReviewViewer } from "./review-views";
import { mayApprove, reviewPermission, type ReviewPermission } from "./review-capability";
import { parseFountain, VersionStore, type ScriptVersion } from "../../parser/src/index";
import { readJsonFile, writeJsonFile } from "./persist";
import {HistoricalValidationCache} from "./historical-validation-cache";
import { CastingConflict, characterRecord, castingMatches, castingSnapshot, currentCasting, charactersForScene, type CastingSnapshot } from "../../planner/src/casting";
import { MAX_REFERENCE_ASSETS, validateReference, type ReferenceAsset } from "../../planner/src/references";
import { referenceLockRecord } from "../../planner/src/reference-lock";
import {assertFrameAnchorCatalog} from "../../planner/src/frame-anchors";
import { characterSheetShots, type CharacterSheetPlan } from "../../planner/src/sheets";
export interface ReferenceBatchOptions {expectedScriptVersion?:number;replaceExisting?:boolean;sheet?:CharacterSheetPlan}
import { ActorShareUnavailable, assertShareable, createActorShare, importedActor, MAX_ACTOR_SHARES, validateActorShare, type ActorShare } from "../../planner/src/actor-library";
import { verifyActorToken } from "./actor-token";
import { contentHash } from "../../generator/src/capabilities";
import {createScenePerformance,scenePerformanceSource} from "../../planner/src/performance-memory";
import {picturePerformance} from "../../planner/src/picture-performance";
import {audioRecord,audioNumber} from "../../planner/src/audio-performances";
import {currentDirection,directionEntry,directionMatches,directionSettings,directionSnapshot,DirectionConflict,validateDirection,type DirectionSnapshot} from "../../planner/src/direction";
import {continuityReport} from "../../planner/src/continuity";
import {continuityRepair,continuityRepairSummary} from "../../planner/src/continuity-repair";

import {GENERATION_REVOKED_NOTICE, type GenerationRevoker, type Job} from "../../queue/src/index";
import {emptySoundLibrary,validateSoundLibrary,updateSoundLibrary,type SoundLibrary,type SoundAsset} from "../../planner/src/sound-assets";
import {emptyGraphicLibrary,validateGraphicLibrary,updateGraphicLibrary,type GraphicLibrary,type GraphicChange} from "../../planner/src/graphic-library";
import {emptyEditLibrary,validateEditLibrary,createEditSequence,changeEditSequence,admitEditSource,type EditLibrary,type EditSequenceChange} from "../../planner/src/edit-library";
import {emptyEditAssemblyLibrary,createEditAssemblyProposal,reviseEditAssemblyProposal,acceptEditAssemblyProposal,type EditAssemblyLibrary,type EditAssemblyProposalInput,type EditAssemblyProposalRevision} from "../../planner/src/edit-assembly-proposals";
import {emptyLivingScriptProposals,validateProjectLivingScriptProposals,createLivingScriptProposal,type LivingScriptProposals,type LivingScriptProposalRequest} from "../../planner/src/living-script-proposals";
import {emptyLivingScriptAcceptances,validateProjectLivingScriptAcceptances,acceptLivingScriptProposal,type LivingScriptAcceptances,type LivingScriptAcceptanceRecord} from "../../planner/src/living-script-acceptance-library";
import type {LivingScriptAcceptanceRequest} from "../../planner/src/living-script-acceptance";
import {assertLivingScriptGenerationCurrent} from "../../planner/src/living-script-jobs";
import {createLivingScriptPreviewReview,type LivingScriptPreviewReview} from "../../planner/src/living-script-job-context";
import {emptyCurrentScreenplayLibrary,validateProjectCurrentScreenplay,currentScreenplayHead,bootstrapCurrentScreenplayLibrary,saveCurrentScreenplayProposal,acceptCurrentScreenplayProposal,type CurrentScreenplayLibrary,type CurrentScreenplayState} from "../../planner/src/current-screenplay-library";
import {assertCurrentScreenplaySettings} from "../../planner/src/current-screenplay-authority";
import {assertCurrentFilmGenerationCurrent} from "../../planner/src/current-film-authority";
import {validateCurrentFilmPreviewReview,type CurrentFilmPreviewReview} from "../../planner/src/current-film-job-context";
import {deriveEditAssemblyParent,validateProjectAssemblyLibrary,assertEditAssemblyCarriers,validateEditAssemblyExpected,type EditAssemblyCarrier,type EditAssemblyExpected,type EditAssemblyRevisionExpected} from "../../planner/src/edit-assembly-parent";
import {editFail,editId} from "../../planner/src/edit-timeline";
import {assertEditSourcePermission,assertEditOriginalPermission,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {validateEditBinding,assertEditBindingAvailable,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {emptyDialogueSelections,validateDialogueSelections,selectDialogueOutput,validateOutputBinding,assertSelectedOutput,type DialogueSelections,type OutputBinding} from "../../planner/src/dialogue-selection";
export interface Project {
  id: string;
  createdAt: string;
  versions: VersionStore;
  deleteAfter: string;
  operatorExtensions: { extendedAt: string; days: number; reason: string }[];
  rightsAttestedAt: string | null;
  animaticApprovals: AnimaticApproval[];
  castingHistory: CastingSnapshot[];
  referenceAssets: ReferenceAsset[];
  actorShares: ActorShare[];
  directionHistory: DirectionSnapshot[];
  motionStudies:MotionStudies;
  dialogueSelections:DialogueSelections;
  soundLibrary:SoundLibrary;
  editLibrary:EditLibrary;
  assemblyLibrary:EditAssemblyLibrary;
  livingScriptProposals:LivingScriptProposals;
  livingScriptAcceptances:LivingScriptAcceptances;
  currentScreenplay:CurrentScreenplayLibrary;
  graphicLibrary:GraphicLibrary;
}

export type ReviewDecision = "approved" | "changes_requested";

export interface AnimaticApproval {
  currentFilmReview?:import("../../planner/src/current-film-job-context").CurrentFilmPreviewReview;
  livingScriptReview?:import("../../planner/src/living-script-job-context").LivingScriptPreviewReview;
  takeRevision?:string;
  animaticJobId: string;
  scriptVersion: number;
  decision: ReviewDecision;
  note: string;
  at: string;
  castingVersion?: number;
  castingRevision?: string;
  directionVersion?: number;
  directionRevision?: string;
}

export interface ReviewLink {
  outputBinding?:OutputBinding;
  /** HV-029-05: the owner's view limit. Absent on links minted before it, which keep REVIEW_MAX_VIEWS. */
  maxViews?: number;
  /** HV-029-05: SHA-256 of each viewer id that was shown the cut; one per counted view. */
  viewers?: string[];
  token: string;
  projectId: string;
  permission: ReviewPermission;
  views: number;
  revoked: boolean;
  decision: ReviewDecision | null;
  decisionNote: string | null;
}

export interface PersistedProject {
  id: string;
  createdAt: string;
  deleteAfter: string;
  operatorExtensions: { extendedAt: string; days: number; reason: string }[];
  rightsAttestedAt: string | null;
  animaticApprovals: AnimaticApproval[];
  versions: ScriptVersion[];
  castingHistory?: CastingSnapshot[];
  referenceAssets?: ReferenceAsset[];
  actorShares?: ActorShare[];
  directionHistory?: DirectionSnapshot[];
  motionStudies?:MotionStudies;
  dialogueSelections?:DialogueSelections;
  soundLibrary?:SoundLibrary;
  editLibrary?:EditLibrary;
  assemblyLibrary?:EditAssemblyLibrary;
  livingScriptProposals?:LivingScriptProposals;
  livingScriptAcceptances?:LivingScriptAcceptances;
  currentScreenplay?:CurrentScreenplayLibrary;
  graphicLibrary?:GraphicLibrary;
}

export interface PersistedState {
  version: 1;
  projects: PersistedProject[];
  reviewLinks: ReviewLink[];
  takenDown: string[];
  takedownLog: { projectId: string; at: string; reason: string }[];
}

type HistoricalProjectInput={projectId:string;versions:ScriptVersion[];editorial:EditLibrary;assembly:EditAssemblyLibrary;proposals:LivingScriptProposals;acceptances:LivingScriptAcceptances};
// Shared pure metadata results also serve freshly constructed PostgreSQL state adapters.
// Current project fields, VersionStore instances and permission decisions are always rebuilt.
const historicalProjects=new HistoricalValidationCache((input:HistoricalProjectInput)=>{
  const editorial=validateEditLibrary(input.editorial,input.projectId);
  const proposals=validateProjectLivingScriptProposals(input.proposals,input.projectId,input.versions);
  const acceptances=validateProjectLivingScriptAcceptances(input.acceptances,proposals,{projectId:input.projectId,versions:input.versions,editorial});
  const assembly=validateProjectAssemblyLibrary(input.assembly,input.projectId,editorial);
  return {editorial,proposals,acceptances,assembly};
});

/** Server-selected carrier metadata is fenced again by PostgreSQL before this synchronous check. */
function assertLinkedAcceptanceCarriers(record:LivingScriptAcceptanceRecord,project:Project,carriers:EditAssemblyCarrier[],now:number):void {
  const input=record.request.recutInput,expected=record.request.recut.sourceReceipts,receipts=[...input.library.sources,input.generated];
  if(!Array.isArray(carriers)||carriers.length!==expected.length||new Set(carriers.map(carrier=>carrier?.binding?.source?.facts?.id)).size!==carriers.length)editFail("Retain one current carrier for every linked acceptance original, including generated media.");
  for(const identity of expected){
    const source=receipts.find(source=>source.revision===identity.receiptRevision&&source.facts.id===identity.sourceId),carrier=carriers.find(carrier=>carrier?.binding?.source?.facts?.id===identity.sourceId);
    if(!source||!carrier||carrier.binding.owner.projectId!==project.id||contentHash(carrier.binding.source)!==contentHash(source))editFail("The linked acceptance carrier lost its exact original receipt.");
    assertEditBindingAvailable(carrier.binding,carrier.current,now);assertEditOriginalPermission(source,project,now);
  }
}
/** A screenplay/cut review does not attest new actors, expand permission or import reference assets. */
function assertLinkedSettingsAuthority(project:Project,candidate:CastingSnapshot,direction:DirectionSnapshot):void {
  const current=currentCasting(project.id,project.castingHistory);
  for(const character of candidate.characters){
    const saved=current.characters.find(saved=>saved.id===character.id);
    if(!saved||contentHash(saved.permission)!==contentHash(character.permission)||contentHash(saved.sceneBindings)!==contentHash(character.sceneBindings)||contentHash(saved.libraryOrigin??null)!==contentHash(character.libraryOrigin??null))editFail("Review new or changed character permissions through the current casting controls before accepting a linked screenplay.");
    for(const reference of character.references??[])if(!project.referenceAssets.some(asset=>contentHash(asset)===contentHash(reference)))editFail("The proposed cast reference is unavailable in this project's current asset catalog.");
  }
  for(const entry of direction.entries)assertFrameAnchorCatalog(entry.settings.frameAnchors,project.id,project.referenceAssets);
}

export class ProjectService {
  private projects = new Map<string, Project>();
  private reviewLinks = new Map<string, ReviewLink>();
  takedownLog: { projectId: string; at: string; reason: string }[] = [];
  private takenDown = new Set<string>();

  constructor(private statePath?: string) {
    this.reload();
  }

  private reload(): void {
    if (!this.statePath) return;
    // HV-038-06: an unreadable state file used to read as "no projects yet", and the next save
    // wrote that emptiness over every anonymous project in the studio. It refuses now, so the file
    // is still there to be restored.
    let state: PersistedState | null;
    try { state = readJsonFile<PersistedState>(this.statePath); }
    catch (error) { throw new Error("The studio state file at " + this.statePath + " is unreadable; no project is served until it is restored.", {cause: error}); }
    if (!state) return;
    this.loadState(state);
  }

  private loadState(state: PersistedState): void {
    this.projects.clear();
    this.reviewLinks.clear();
    for (const project of state.projects ?? []) {
      for(const direction of project.directionHistory??[])for(const entry of direction.entries)assertFrameAnchorCatalog(entry.settings.frameAnchors,project.id,project.referenceAssets??[]);
      const {editorial,proposals,acceptances,assembly}=historicalProjects.get({projectId:project.id,versions:project.versions??[],editorial:project.editLibrary??emptyEditLibrary(),assembly:project.assemblyLibrary??emptyEditAssemblyLibrary(),proposals:project.livingScriptProposals===undefined?emptyLivingScriptProposals(project.id):project.livingScriptProposals,acceptances:project.livingScriptAcceptances===undefined?emptyLivingScriptAcceptances(project.id):project.livingScriptAcceptances});
      this.projects.set(project.id, {
        id: project.id,
        createdAt: project.createdAt,
        deleteAfter: project.deleteAfter,
        operatorExtensions: project.operatorExtensions ?? [],
        rightsAttestedAt: project.rightsAttestedAt ?? null,
        animaticApprovals: project.animaticApprovals ?? [],
        castingHistory: structuredClone(project.castingHistory ?? []),
        referenceAssets: (project.referenceAssets ?? []).map(asset => validateReference(asset,project.id)),
        actorShares:(project.actorShares??[]).map(share=>validateActorShare(share,project.id)),
        directionHistory:(project.directionHistory??[]).map(value=>validateDirection(value,project.id)),
        motionStudies:validateMotionStudies(project.motionStudies??emptyMotionStudies(),project.id,project.referenceAssets??[]),
        dialogueSelections:validateDialogueSelections(project.dialogueSelections??emptyDialogueSelections()),
        soundLibrary:validateSoundLibrary(project.soundLibrary??emptySoundLibrary(),project.id),
        editLibrary:editorial,
        assemblyLibrary:assembly,
        livingScriptProposals:proposals,
        livingScriptAcceptances:acceptances,
        currentScreenplay:validateProjectCurrentScreenplay(project.currentScreenplay,{projectId:project.id,versions:project.versions??[]}),
        graphicLibrary:validateGraphicLibrary(project.graphicLibrary??emptyGraphicLibrary(),project.id),
        versions: VersionStore.hydrate(project.versions ?? []),
      });
    }
    for (const link of state.reviewLinks ?? []) {if(link.outputBinding)validateOutputBinding(link.outputBinding);this.reviewLinks.set(link.token, link);}
    this.takenDown = new Set(state.takenDown ?? []);
    this.takedownLog = state.takedownLog ?? [];
  }

  static fromState(state: PersistedState): ProjectService {
    const service = new ProjectService();
    service.loadState(structuredClone(state));
    return service;
  }

  snapshot(): PersistedState {
    return {
      version: 1,
      projects: [...this.projects.values()].map((project) => ({
        id: project.id,
        createdAt: project.createdAt,
        deleteAfter: project.deleteAfter,
        operatorExtensions: project.operatorExtensions,
        rightsAttestedAt: project.rightsAttestedAt,
        animaticApprovals: project.animaticApprovals,
        castingHistory: structuredClone(project.castingHistory),
        ...(project.referenceAssets.length ? {referenceAssets:structuredClone(project.referenceAssets)} : {}),
        ...(project.actorShares.length ? {actorShares:structuredClone(project.actorShares)} : {}),
        ...(project.directionHistory.length ? {directionHistory:structuredClone(project.directionHistory)} : {}),
        ...(project.motionStudies.version ? {motionStudies:structuredClone(project.motionStudies)} : {}),
        ...(project.dialogueSelections.version ? {dialogueSelections:structuredClone(project.dialogueSelections)} : {}),
        ...(project.soundLibrary.version ? {soundLibrary:structuredClone(project.soundLibrary)} : {}),
        ...(project.editLibrary.version ? {editLibrary:structuredClone(project.editLibrary)} : {}),
        ...(project.assemblyLibrary.version ? {assemblyLibrary:structuredClone(project.assemblyLibrary)} : {}),
        ...(project.livingScriptProposals.version ? {livingScriptProposals:structuredClone(project.livingScriptProposals)} : {}),
        ...(project.livingScriptAcceptances.version ? {livingScriptAcceptances:structuredClone(project.livingScriptAcceptances)} : {}),
        ...(project.currentScreenplay.version ? {currentScreenplay:structuredClone(project.currentScreenplay)} : {}),
        ...(project.graphicLibrary.version ? {graphicLibrary:structuredClone(project.graphicLibrary)} : {}),
        versions: project.versions.history(),
      })),
      reviewLinks: [...this.reviewLinks.values()],
      takenDown: [...this.takenDown],
      takedownLog: this.takedownLog,
    };
  }

  private persist(): void {
    if (this.statePath) writeJsonFile(this.statePath, this.snapshot());
  }

  createAnonymousProject(now = Date.now()): { projectId: string; token: string; expiresAt: string } {
    this.reload();
    const id = crypto.randomUUID();
    this.projects.set(id, {
      id,
      createdAt: new Date(now).toISOString(),
      versions: new VersionStore(),
      deleteAfter: new Date(now + 30 * 24 * 3600 * 1000).toISOString(),
      operatorExtensions: [],
      rightsAttestedAt: null,
      animaticApprovals: [],
      castingHistory: [],
      referenceAssets: [],
      actorShares: [],
      directionHistory: [],
      motionStudies:emptyMotionStudies(),
      dialogueSelections:emptyDialogueSelections(),
      soundLibrary:emptySoundLibrary(),
      editLibrary:emptyEditLibrary(),
      assemblyLibrary:emptyEditAssemblyLibrary(),
      livingScriptProposals:emptyLivingScriptProposals(id),
      livingScriptAcceptances:emptyLivingScriptAcceptances(id),
      currentScreenplay:emptyCurrentScreenplayLibrary(id),
      graphicLibrary:emptyGraphicLibrary(),
    });
    this.persist();
    return { projectId: id, token: mintProjectToken(id, now), expiresAt: new Date(now + 72 * 3600 * 1000).toISOString() };
  }

  saveGraphic(token:string,input:GraphicChange,expectedVersion:number,now=Date.now()):GraphicLibrary|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const library=updateGraphicLibrary(project.graphicLibrary,project.id,input,expectedVersion,now);project.graphicLibrary=library;this.persist();return structuredClone(library);
  }
  saveSoundAsset(token:string,input:SoundAsset|{assetId:string;available:boolean},expectedVersion:number,now=Date.now()):SoundLibrary|null{
    const project=this.authorize(token,now);if(!project)return null;if(!project.rightsAttestedAt)throw new Error("Confirm project rights before saving sound assets.");
    const library=updateSoundLibrary(project.soundLibrary,project.id,expectedVersion,input,now);project.soundLibrary=library;this.persist();return structuredClone(library);
  }
  createEditSequence(token:string,receipts:EditSourceReceipt[],id:string,label:string,firstId:string,width:number,height:number,expectedVersion:number,now=Date.now(),bindings?:EditSourceBinding[]):EditLibrary|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    if(bindings){if(bindings.length!==receipts.length)throw new Error("Editorial source bindings changed.");for(const [i,source]of receipts.entries()){if(validateEditBinding(bindings[i]!,now).source.revision!==source.revision)throw new Error("Editorial source bindings changed.");assertEditOriginalPermission(source,project,now);}}
    else for(const source of receipts)assertEditSourcePermission(source,project,now);
    const next=createEditSequence(project.editLibrary,project.id,receipts,id,label,firstId,width,height,expectedVersion,now);project.editLibrary=next;this.persist();return structuredClone(next);
  }
  admitEditSource(token:string,id:string,binding:EditSourceBinding,expectedVersion:number,expectedHistoryRevision:string,now=Date.now()):EditLibrary|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;validateEditBinding(binding,now);assertEditOriginalPermission(binding.source,project,now);
    const next=admitEditSource(project.editLibrary,project.id,id,binding.source,expectedVersion,expectedHistoryRevision,now);project.editLibrary=next;this.persist();return structuredClone(next);
  }
  changeEditSequence(token:string,id:string,change:EditSequenceChange,expectedVersion:number,expectedHistoryRevision:string,now=Date.now()):EditLibrary|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const next=changeEditSequence(project.editLibrary,project.id,id,change,expectedVersion,expectedHistoryRevision,now);project.editLibrary=next;this.persist();return structuredClone(next);
  }
  createAssemblyProposal(token:string,sequenceId:string,input:EditAssemblyProposalInput,expected:EditAssemblyExpected,carriers:EditAssemblyCarrier[],now=Date.now()):EditAssemblyLibrary|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;validateEditAssemblyExpected(expected);
    const parent=deriveEditAssemblyParent(project.id,project.editLibrary,sequenceId,expected.historyRevision),next=createEditAssemblyProposal(project.assemblyLibrary,input,parent,expected.libraryVersion,now);assertEditAssemblyCarriers(parent,project,carriers,now);
    project.assemblyLibrary=validateProjectAssemblyLibrary(next,project.id,project.editLibrary);this.persist();return structuredClone(project.assemblyLibrary);
  }
  /** Internal canonical state operations. Public structural cut acceptance is wired separately
   * once its full media/history transaction is available. These never select an export. */
  private assertCurrentScreenplayHead(project:Project,state:CurrentScreenplayState,now:number):void {
    const head=currentScreenplayHead(project.currentScreenplay),script=project.versions.latest();
    if(!head||!script||contentHash(script)!==contentHash(head.script))editFail("The saved screenplay changed outside this structural ancestry. Reconcile the exact current version first.");
    if(contentHash(project.currentScreenplay.origin!.request.baseline.direction)!==contentHash(currentDirection(project.id,project.directionHistory)))editFail("Legacy shot direction changed after the structural review. Reconcile those settings first.");
    assertCurrentScreenplaySettings(state,{projectId:project.id,documentRevision:head.state.context.plan.document.revision,casting:currentCasting(project.id,project.castingHistory),rightsAttestedAt:project.rightsAttestedAt,deleteAfter:project.deleteAfter,referenceAssets:project.referenceAssets},now);
  }
  private publishCurrentScreenplay(projectId:string,library:CurrentScreenplayLibrary,versions:ScriptVersion[]=[],casting?:CastingSnapshot):void {
    const state=this.snapshot(),project=state.projects.find(value=>value.id===projectId)!;
    for(const version of versions){
      const previous=project.versions.at(-1);
      if(!previous||version.parentVersion!==previous.version||version.version!==previous.version+1||project.versions.some(saved=>saved.version===version.version))editFail("Retain every exact consecutive screenplay version in this acceptance.");
      project.versions.push(structuredClone(version));
    }
    project.currentScreenplay=structuredClone(library);
    if(casting&&casting.revision!==currentCasting(project.id,project.castingHistory??[]).revision)project.castingHistory=[...(project.castingHistory??[]),structuredClone(casting)].slice(-100);
    const validated=ProjectService.fromState(state).snapshot();
    if(this.statePath)writeJsonFile(this.statePath,validated);
    this.loadState(validated);
  }
  bootstrapCurrentScreenplay(token:string,request:Parameters<typeof bootstrapCurrentScreenplayLibrary>[1],expectedVersion:number,carrier:EditAssemblyCarrier,now=Date.now()):ReturnType<typeof bootstrapCurrentScreenplayLibrary>|null {
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const result=bootstrapCurrentScreenplayLibrary(project.currentScreenplay,request,expectedVersion,now);
    if(carrier.binding.owner.projectId!==project.id||contentHash(carrier.binding.source)!==contentHash(result.origin.request.source))editFail("Retain the exact original film in a current project carrier before establishing its screenplay ancestry.");
    assertEditBindingAvailable(carrier.binding,carrier.current,now);assertEditOriginalPermission(carrier.binding.source,project,now);
    if(result.replayed)return structuredClone(result);
    const script=project.versions.latest();
    if(!script||contentHash(script)!==contentHash(result.origin.request.script)||contentHash(result.origin.request.baseline.casting)!==contentHash(currentCasting(project.id,project.castingHistory))||contentHash(result.origin.request.baseline.direction)!==contentHash(currentDirection(project.id,project.directionHistory)))editFail("Review the exact current screenplay, cast and direction before establishing their ancestry.");
    assertCurrentScreenplaySettings(result.origin.state,{projectId:project.id,documentRevision:result.origin.state.context.plan.document.revision,casting:currentCasting(project.id,project.castingHistory),rightsAttestedAt:project.rightsAttestedAt,deleteAfter:project.deleteAfter,referenceAssets:project.referenceAssets},now);
    this.publishCurrentScreenplay(project.id,result.library);return structuredClone(result);
  }
  saveCurrentScreenplayProposal(token:string,request:Parameters<typeof saveCurrentScreenplayProposal>[1],expectedVersion:number,now=Date.now()):ReturnType<typeof saveCurrentScreenplayProposal>|null {
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const result=saveCurrentScreenplayProposal(project.currentScreenplay,request,expectedVersion,now);
    if(result.replayed)return structuredClone(result);
    const head=currentScreenplayHead(project.currentScreenplay)!;
    // Unresolved reviews may be saved for repair, but never bypass baseline authority.
    this.assertCurrentScreenplayHead(project,result.proposal.candidate??head.state,now);
    this.publishCurrentScreenplay(project.id,result.library);return structuredClone(result);
  }
  acceptCurrentScreenplayProposal(token:string,request:Parameters<typeof acceptCurrentScreenplayProposal>[1],expectedVersion:number,now=Date.now()):ReturnType<typeof acceptCurrentScreenplayProposal>|null {
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const result=acceptCurrentScreenplayProposal(project.currentScreenplay,request,expectedVersion,now);
    if(result.replayed)return structuredClone(result);
    this.assertCurrentScreenplayHead(project,result.acceptance.state,now);
    this.publishCurrentScreenplay(project.id,result.library,result.versions,result.acceptance.state.casting.candidate!);
    return structuredClone(result);
  }
  /** Internal review persistence only. Generation and linked acceptance need their own current fences. */
  createLivingScriptProposal(token:string,input:LivingScriptProposalRequest,expectedVersion:number,carriers:EditAssemblyCarrier[],now=Date.now()):ReturnType<typeof createLivingScriptProposal>|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const result=createLivingScriptProposal(project.livingScriptProposals,project.id,project.editLibrary,input,expectedVersion,now);
    assertEditAssemblyCarriers(result.proposal.impact.parent,project,carriers,now);
    if(!result.replayed){
      const current=project.versions.latest(),before=result.proposal.request.patch.before,baseline=result.proposal.request.baseline;
      if(!current||current.version!==before.version||current.text!==before.text)editFail("The current screenplay changed. Review the line against its exact saved version.");
      if(!castingMatches(baseline.casting,currentCasting(project.id,project.castingHistory))||!directionMatches(baseline.direction,currentDirection(project.id,project.directionHistory)))editFail("The current cast or direction changed. Review the screenplay generation context again.");
      project.livingScriptProposals=result.library;this.persist();
    }
    return structuredClone(result);
  }
  /** Publish the full detached bundle in one state write; no member is applied before validation.
   * This is synchronous single-writer JSON behavior. PostgreSQL supplies the concurrent project fence. */
  acceptLivingScriptProposal(token:string,proposalId:string,proposalRevision:string,request:LivingScriptAcceptanceRequest,expectedVersion:number,carriers:EditAssemblyCarrier[],now=Date.now()):ReturnType<typeof acceptLivingScriptProposal>|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const script=project.versions.latest();if(!script)editFail("Retain the original screenplay before accepting its revised cut.");
    const result=acceptLivingScriptProposal(project.livingScriptAcceptances,project.livingScriptProposals,{projectId:project.id,editorial:project.editLibrary,currentScript:{version:script.version,text:script.text},currentCasting:currentCasting(project.id,project.castingHistory),currentDirection:currentDirection(project.id,project.directionHistory)},proposalId,proposalRevision,request,expectedVersion,now);
    assertLinkedAcceptanceCarriers(result.record,project,carriers,now);
    if(result.replayed)return structuredClone(result);
    const bundle=result.bundle;assertLinkedSettingsAuthority(project,bundle.nextCasting,bundle.nextDirection);
    const state=this.snapshot(),next=state.projects.find(value=>value.id===project.id)!;
    if(next.versions.some(version=>version.version===bundle.nextScript.version))editFail("The proposed screenplay version already exists. Review the current branch.");
    next.versions=[...next.versions,structuredClone(bundle.nextScript)];next.editLibrary=bundle.nextEditLibrary;next.livingScriptAcceptances=result.library;
    if(bundle.nextCasting.revision!==currentCasting(project.id,project.castingHistory).revision)next.castingHistory=[...(next.castingHistory??[]),bundle.nextCasting].slice(-100);
    if(bundle.nextDirection.revision!==currentDirection(project.id,project.directionHistory).revision)next.directionHistory=[...(next.directionHistory??[]),bundle.nextDirection].slice(-100);
    const detached=ProjectService.fromState(state),accepted=detached.peekProject(project.id)!;assertLinkedAcceptanceCarriers(result.record,accepted,carriers,now);
    const validated=detached.snapshot();if(this.statePath)writeJsonFile(this.statePath,validated);
    this.loadState(validated);return structuredClone(result);
  }
  reviseAssemblyProposal(token:string,proposalId:string,input:EditAssemblyProposalRevision,expected:EditAssemblyRevisionExpected,carriers:EditAssemblyCarrier[],now=Date.now()):EditAssemblyLibrary|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;validateEditAssemblyExpected(expected,true);editId(proposalId);
    const proposal=project.assemblyLibrary.proposals.find(p=>p.id===proposalId);if(!proposal)editFail("Choose a saved assembly proposal.");const parent=deriveEditAssemblyParent(project.id,project.editLibrary,proposal.plan.parent.sequenceId,expected.historyRevision),next=reviseEditAssemblyProposal(project.assemblyLibrary,proposalId,input,parent,expected.libraryVersion,expected.proposalRevision);assertEditAssemblyCarriers(parent,project,carriers,now);
    project.assemblyLibrary=validateProjectAssemblyLibrary(next,project.id,project.editLibrary);this.persist();return structuredClone(project.assemblyLibrary);
  }
  acceptAssemblyProposal(token:string,proposalId:string,proposalRevision:string,assemblyId:string,expected:EditAssemblyExpected,carriers:EditAssemblyCarrier[],now=Date.now()):ReturnType<typeof acceptEditAssemblyProposal>|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;validateEditAssemblyExpected(expected);editId(proposalId);editId(assemblyId);
    const previous=project.assemblyLibrary.assemblies.find(a=>a.id===assemblyId&&a.proposalId===proposalId&&a.proposalRevision===proposalRevision),proposal=project.assemblyLibrary.proposals.find(p=>p.id===proposalId);if(!previous&&!proposal)editFail("Choose a saved assembly proposal.");
    const parent=previous?previous.plan.parent:deriveEditAssemblyParent(project.id,project.editLibrary,proposal!.plan.parent.sequenceId,expected.historyRevision),result=acceptEditAssemblyProposal(project.assemblyLibrary,proposalId,proposalRevision,assemblyId,parent,expected.libraryVersion,now);assertEditAssemblyCarriers(parent,project,carriers,now);
    validateProjectAssemblyLibrary(result.library,project.id,project.editLibrary);if(!result.replayed){project.assemblyLibrary=result.library;this.persist();}return structuredClone(result);
  }
  authorize(token: string, now = Date.now()): Project | null {
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "project") return null;
    this.reload();
    if (this.takenDown.has(payload.projectId)) return null;
    return this.projects.get(payload.projectId) ?? null;
  }

  editScript(token: string, text: string, now = Date.now()): { version: number } | null {
    const project = this.authorize(token, now);
    if (!project) return null;
    const version = project.versions.commit(text).version;
    this.persist();
    return { version };
  }

  getVersion(token: string, version: number, now = Date.now()): string | null {
    return this.authorize(token, now)?.versions.get(version)?.text ?? null;
  }
  private castProject(token: string, expectedVersion: number, now: number): Project | null {
    const project = this.authorize(token, now);
    if (!project || Date.parse(project.deleteAfter) <= now) return null;
    if (!Number.isInteger(expectedVersion) || currentCasting(project.id, project.castingHistory).version !== expectedVersion)
      throw new CastingConflict("The cast changed in another session. Reload the cast before saving.");
    return project;
  }
  private saveCast(project: Project, characters: CastingSnapshot["characters"], now: number): CastingSnapshot {
    const version = currentCasting(project.id, project.castingHistory).version + 1;
    const snapshot = castingSnapshot(project.id, version, characters, now);
    project.castingHistory.push(snapshot);
    project.castingHistory = project.castingHistory.slice(-100);
    this.persist(); return structuredClone(snapshot);
  }
  saveCharacter(token: string, id: string, input: unknown, expectedVersion: number, now = Date.now()): CastingSnapshot | null {
    const project = this.castProject(token, expectedVersion, now); if (!project) return null;
    const character = characterRecord(input, id, now);
    const parsed = parseFountain(project.versions.latest()?.text ?? "");
    const sceneNumbers = [...new Set([...character.wardrobe.flatMap(value => value.sceneNumber === null ? [] : [value.sceneNumber]), ...character.permission.sceneNumbers])];
    character.sceneBindings = sceneNumbers.map(sceneNumber => {
      const scene = parsed.scenes.find(scene => scene.index + 1 === sceneNumber);
      if (!scene) throw new Error("Scene " + sceneNumber + " does not exist in the current screenplay.");
      return {sceneNumber, heading: scene.heading};
    });
    const characters = currentCasting(project.id, project.castingHistory).characters;
    const index = characters.findIndex(value => value.id === id);
    if (index >= 0 && characters[index]!.references !== undefined) character.references = characters[index]!.references;
    if(index>=0)for(const key of ["audioVoice","scenePerformances","referenceLock","libraryOrigin","costumePresets"] as const)if(characters[index]![key]!==undefined)Object.assign(character,{[key]:structuredClone(characters[index]![key])});
    if (index < 0) characters.push(character); else characters[index] = character;
    return this.saveCast(project, characters, now);
  }
  /**
   * HV-017-09. The look is locked through its own route, not through a character save, because the
   * images it names live only on the stored record: a creator's own save never carries them.
   */
  saveCharacterReferenceLock(token:string,id:string,input:unknown|null,expectedVersion:number,now=Date.now()):CastingSnapshot|null{
    const project=this.castProject(token,expectedVersion,now);if(!project)return null;
    const characters=currentCasting(project.id,project.castingHistory).characters,character=characters.find(value=>value.id===id);
    if(!character)throw new CastingConflict("This character was removed. Reload the cast.");
    if(input===null)delete character.referenceLock;
    else character.referenceLock=referenceLockRecord(input,character.references??[],now);
    // castingSnapshot re-judges the lock against the character's own images, unknown fields included.
    return this.saveCast(project,characters,now);
  }
  saveCharacterAudioVoice(token:string,id:string,profile:import("../../planner/src/audio-performances").AudioVoiceProfile|null,expectedVersion:number,now=Date.now()):CastingSnapshot|null{
    const project=this.castProject(token,expectedVersion,now);if(!project)return null;
    const characters=currentCasting(project.id,project.castingHistory).characters,character=characters.find(c=>c.id===id);
    if(!character)throw new CastingConflict("This character was removed. Reload the cast.");
    if(profile===null)delete character.audioVoice;else character.audioVoice=structuredClone(profile);
    // castingSnapshot validates the dedicated profile, including unknown fields.
    return this.saveCast(project,characters,now);
  }
  saveScenePerformance(token:string,id:string,input:unknown,expectedVersion:number,now=Date.now()):CastingSnapshot|null{
    const project=this.castProject(token,expectedVersion,now);if(!project)return null;
    const body=audioRecord(input,["expectedScriptVersion","sceneNumber","sourceHash","notes","controls","picture","nativeVoice","remove"]),script=project.versions.latest();
    if(!script||body.expectedScriptVersion!==script.version)throw new CastingConflict("The screenplay changed. Reload and review the scene before saving its performance.");
    const sceneNumber=audioNumber(body.sceneNumber,1,1000,"Scene number",true),scene=parseFountain(script.text).scenes.find(s=>s.index+1===sceneNumber);
    if(body.sourceHash!==(scene?scenePerformanceSource(scene):null))throw new CastingConflict("The scene changed. Reload and review its performance before saving.");
    const characters=currentCasting(project.id,project.castingHistory).characters,character=characters.find(c=>c.id===id);
    if(!character)throw new CastingConflict("This character was removed. Reload the cast.");
    const records=(character.scenePerformances??[]).filter(p=>p.sceneNumber!==sceneNumber);
    if(body.remove===true){if(body.notes!==undefined||body.controls!==undefined||body.picture!==undefined||body.nativeVoice!==undefined)throw new Error("Remove scene direction without replacement settings.");}
    else{if(body.remove!==undefined||!scene)throw new Error("Choose a current screenplay scene.");records.push(createScenePerformance(id,scene,{notes:body.notes,controls:body.controls,...(body.picture===undefined?{}:{picture:body.picture}),...(body.nativeVoice===undefined?{}:{nativeVoice:body.nativeVoice})}));}
    if(records.length)character.scenePerformances=records.sort((a,b)=>a.sceneNumber-b.sceneNumber);else delete character.scenePerformances;
    return this.saveCast(project,characters,now);
  }
  private directionProject(token:string,expectedVersion:number,now:number):Project|null {
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    if(!Number.isSafeInteger(expectedVersion)||currentDirection(project.id,project.directionHistory).version!==expectedVersion)throw new DirectionConflict("The shot directions changed. Reload before saving.");
    return project;
  }
  private coverageBinding(project:Project,maxShots:24|60):CutBinding {
    return {projectId:project.id,scriptVersion:project.versions.latest()?.version??0,castingRevision:currentCasting(project.id,project.castingHistory).revision,directionRevision:currentDirection(project.id,project.directionHistory).revision,maxShots};
  }
  private coverageImpact(project:Project,proposal:CutProposal) {
    const parsed=parseFountain(project.versions.latest()!.text),current=currentDirection(project.id,project.directionHistory);
    if(contentHash(proposal.binding)!==contentHash(this.coverageBinding(project,proposal.binding.maxShots)))throw new SceneCutConflict("The screenplay, cast or direction changed. Review a new coverage proposal before accepting.");
    const source=parsed.scenes.find(s=>s.index===proposal.sceneIndex);
    if(proposal.cut&&(!source||contentHash(cutSource(source))!==proposal.cut.sourceHash))throw new SceneCutConflict("The scene source changed. Review a new proposal.");
    const cuts=[...(current.sceneCuts??[]).filter(c=>c.source.sceneIndex!==proposal.sceneIndex),...(proposal.cut?[proposal.cut]:[])];
    const reviewPlan=(direction:DirectionSnapshot)=>{
      let shots=sourcePlan(parsed,direction,7000,proposal.binding.maxShots,true);
      // Review compares accepted sources; stale cuts remain visible until explicitly replaced or removed.
      for(const cut of staleSceneCuts(parsed,direction)){
        const s=cut.source,scene={index:s.sceneIndex,heading:s.heading,action:s.beats.flatMap(b=>b.kind==="action"?[b.text]:[]),dialogue:s.beats.flatMap(b=>b.kind==="dialogue"?[{character:b.character,lines:b.lines}]:[]),transitions:s.beats.flatMap(b=>b.kind==="transition"?[b.text]:[]),beats:s.beats.map(b=>({...b,startLine:0,endLine:0}))};
        shots=[...shots.filter(shot=>shot.sceneIndex!==s.sceneIndex),...sourcePlan({...parsed,scenes:[scene]},{...direction,sceneCuts:[cut]},7000,proposal.binding.maxShots,true)];
      }
      return shots.sort((a,b)=>a.sceneIndex-b.sceneIndex);
    };
    const before=reviewPlan(current),after=reviewPlan({...current,sceneCuts:cuts});
    const removeDirectionIds=current.entries.filter(e=>e.source.sceneIndex===proposal.sceneIndex&&!after.some(s=>s.id===e.source.id&&directionEntry(s,{}).sourceHash===e.sourceHash)).map(e=>e.source.id);
    const duration=(shots:typeof before)=>shots.reduce((sum,s)=>{const saved=current.entries.find(e=>e.source.id===s.id&&e.sourceHash===directionEntry(s,{}).sourceHash);return sum+(saved?.settings.durationFrames===null||saved?.settings.durationFrames===undefined?s.durationSec:saved.settings.durationFrames/30);},0);
    return {cuts,beforeShots:before.length,afterShots:after.length,beforeSeconds:duration(before),afterSeconds:duration(after),overBudget:after.length>proposal.binding.maxShots,removeDirectionIds,
      removedShotIds:before.filter(s=>s.sceneIndex===proposal.sceneIndex&&!after.some(a=>a.id===s.id)).map(s=>s.id),
      plan:after.filter(s=>s.sceneIndex===proposal.sceneIndex).map(s=>({...directionEntry(s,{}),durationSec:s.durationSec})),
      beats:source?.beats??[]};
  }
  reviewSceneCut(token:string,input:unknown,now=Date.now()) {
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!["sceneIndex","maxShots","includeReactions","remove","edits","binding"].includes(k)))throw new Error("Use supported coverage proposal fields.");
    const value=input as {sceneIndex:number;maxShots:24|60;includeReactions?:boolean;remove?:boolean;edits?:{shots:SceneCut["shots"];notes:string};binding?:CutBinding};
    if(!Number.isInteger(value.sceneIndex)||value.sceneIndex<0||value.sceneIndex>999||![24,60].includes(value.maxShots)||[value.includeReactions,value.remove].some(v=>v!==undefined&&typeof v!=="boolean"))throw new Error("Choose a scene and the 24-shot or 60-shot plan.");
    const binding=this.coverageBinding(project,value.maxShots),parsed=parseFountain(project.versions.latest()?.text??""),scene=parsed.scenes.find(s=>s.index===value.sceneIndex);
    if(parsed.rejected||binding.scriptVersion<1||(!scene&&!value.remove))throw new Error("Save a valid screenplay and choose an existing scene.");
    if((value.edits&&!value.binding)||(value.binding&&contentHash(value.binding)!==contentHash(binding)))throw new SceneCutConflict("The screenplay, cast or direction changed. Your coverage draft is retained; review a new proposal before accepting.");
    if(value.edits&&(!value.edits||Object.keys(value.edits).sort().join(",")!=="notes,shots"))throw new Error("Edit only shot choices and coverage notes.");
    if(value.remove&&(value.edits||value.includeReactions))throw new Error("Review coverage removal separately from shot edits.");
    if(value.remove&&!currentDirection(project.id,project.directionHistory).sceneCuts?.some(c=>c.source.sceneIndex===value.sceneIndex))throw new Error("This scene has no accepted coverage to remove.");
    const cut=value.remove?null:value.edits?sceneCut(cutSource(scene!),value.edits.shots,value.edits.notes):proposeSceneCut(scene!,value.includeReactions);
    const proposal=cutProposal(binding,value.sceneIndex,cut),impact=this.coverageImpact(project,proposal);
    return {proposal,impact};
  }
  acceptSceneCut(token:string,input:CutProposal,removeDirectionIds:unknown,now=Date.now()):DirectionSnapshot|null {
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const proposal=validateCutProposal(input),impact=this.coverageImpact(project,proposal),current=currentDirection(project.id,project.directionHistory);
    if(impact.overBudget)throw new SceneCutConflict(`This cut needs ${impact.afterShots} shots; the selected tier permits ${proposal.binding.maxShots}. Edit it before accepting.`);
    if(!Array.isArray(removeDirectionIds)||removeDirectionIds.some(id=>typeof id!=="string")||contentHash([...removeDirectionIds].sort())!==contentHash([...impact.removeDirectionIds].sort()))throw new SceneCutConflict("Review and explicitly acknowledge the listed saved directions before replacing these source shots.");
    return this.saveDirectionSnapshot(project,current.entries.filter(e=>!impact.removeDirectionIds.includes(e.source.id)),now,impact.cuts);
  }
  /** HV-021-02: the film's own continuity report and the one repair the Supervisor will propose from it. */
  /**
   * HV-021-04: the repair is computed beside the report, not instead of it.
   *
   * `continuityRepair` refuses a film with more drift than one repair can carry, and that refusal
   * used to propagate out of the review route -- so the creator lost the **report** as well, which
   * is the diagnostic that would have told them which scenes to fix. A film of 60 shots with all
   * five look fields drifting reaches 295 edits against a limit of 240, so this is reachable on the
   * tier the route itself offers. The refusal is carried now, beside a report that still reads.
   */
  private continuityState(project:Project,maxShots:24|60){
    const script=project.versions.latest(),parsed=parseFountain(script?.text??"");
    const direction=currentDirection(project.id,project.directionHistory),casting=currentCasting(project.id,project.castingHistory);
    const shots=sourcePlan(parsed,direction,7000,maxShots,true);
    const report=continuityReport(shots,casting,direction,parsed);
    let proposal:ReturnType<typeof continuityRepair>|null=null,unavailable:string|null=null;
    try{proposal=continuityRepair(report);}catch(error){unavailable=(error as Error).message;}
    return {script,parsed,direction,shots,report,proposal,unavailable};
  }
  reviewContinuityRepair(token:string,maxShots:24|60,now=Date.now()){
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const {report,proposal,unavailable,script}=this.continuityState(project,maxShots);
    return {report,proposal,unavailable,summary:proposal?continuityRepairSummary(proposal):null,scriptVersion:script?.version??0};
  }
  /**
   * The edits are recomputed here and the caller's copy must match them exactly, so a repair can only
   * ever apply what the creator was actually shown. A shot whose look drifted but whose direction was
   * never saved cannot be repaired from here, and says so rather than inventing an entry.
   */
  acceptContinuityRepair(token:string,edits:unknown,expectedVersion:number,expectedScriptVersion:number,maxShots:24|60=24,now=Date.now()):DirectionSnapshot|null {
    const project=this.directionProject(token,expectedVersion,now);if(!project)return null;
    const {script,shots,proposal,unavailable}=this.continuityState(project,maxShots);
    if(!script||script.version!==expectedScriptVersion)throw new DirectionConflict("The screenplay changed. Review a new continuity repair before accepting.");
    if(!proposal)throw new Error(unavailable??"No continuity repair can be made for this film.");
    if(!proposal.edits.length)throw new Error("Nothing in this film's declared look can be held automatically.");
    if(!Array.isArray(edits)||contentHash(edits)!==contentHash(proposal.edits))
      throw new DirectionConflict("The film changed since this continuity repair was read. Review a new one before accepting.");
    const current=currentDirection(project.id,project.directionHistory),entries=new Map(current.entries.map(entry=>[entry.source.id,entry]));
    for(const edit of proposal.edits){
      const entry=entries.get(edit.shotId);
      if(!entry)throw new DirectionConflict("Shot "+edit.shotId+" has no saved direction to repair. Save its direction first.");
      if(!shots.some(value=>value.id===edit.shotId))throw new DirectionConflict("Shot "+edit.shotId+" is no longer in the current screenplay plan.");
      // Only the settings move. The entry keeps the source and the hash it was saved against, so a
      // repair can never re-bind a shot to a source the creator did not review.
      entries.set(edit.shotId,{...entry,settings:directionSettings({...entry.settings,[edit.field]:edit.to})});
    }
    return this.saveDirectionSnapshot(project,[...entries.values()],now);
  }
  private saveDirectionSnapshot(project:Project,entries:DirectionSnapshot["entries"],now:number,sceneCuts=currentDirection(project.id,project.directionHistory).sceneCuts):DirectionSnapshot {
    for(const entry of entries)assertFrameAnchorCatalog(entry.settings.frameAnchors,project.id,project.referenceAssets);
    const saved=directionSnapshot(project.id,currentDirection(project.id,project.directionHistory).version+1,entries,now,sceneCuts);
    project.directionHistory=[...project.directionHistory,saved].slice(-100);this.persist();return structuredClone(saved);
  }
  /**
   * HV-030-03: the look approval. The creator attests, once, that the crew's cast
   * members are original characters they may use, and every pending original
   * character is permitted for the project in one cast version. A real person's
   * consent is never given here; that stays in the cast editor (docs/CASTING.md).
   */
  permitPendingCast(token:string,attested:boolean,expectedVersion:number,now=Date.now()):CastingSnapshot|null{
    const project=this.castProject(token,expectedVersion,now);if(!project)return null;
    if(attested!==true)throw new Error("Confirm that these are original characters you may use.");
    const current=currentCasting(project.id,project.castingHistory);
    const pending=current.characters.filter(character=>character.kind==="original-fictional"&&character.permission.status==="pending");
    if(!pending.length)return structuredClone(current);
    const attestedAt=new Date(now).toISOString();
    const characters=current.characters.map(character=>pending.includes(character)?{...character,permission:{status:"permitted" as const,scope:"project" as const,sceneNumbers:[],expiresAt:null,attestedAt}}:character);
    const snapshot=castingSnapshot(project.id,current.version+1,characters,now);
    project.castingHistory=[...project.castingHistory,snapshot].slice(-100);this.persist();return structuredClone(snapshot);
  }
  /**
   * HV-030-02: the crew's plan, applied in one step -- one new cast version and one new
   * direction version, so a crew pass is a single entry in each history. Every record
   * meets the validators a creator's own save meets. The caller has already dropped
   * anything the creator set (packages/planner/src/crew/production-plan.ts crewChanges).
   */
  applyCrewChanges(token:string,changes:{characters:{id:string;input:unknown}[];directions:{shotId:string;input:unknown}[];voices?:{characterId:string;profile:import("../../planner/src/audio-performances").AudioVoiceProfile}[]},expected:{scriptVersion:number;castingVersion:number;directionVersion:number},maxShots=24,now=Date.now()):{casting:CastingSnapshot;direction:DirectionSnapshot}|null{
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const script=project.versions.latest();if(!script||script.version!==expected.scriptVersion)throw new DirectionConflict("The screenplay changed while the crew was working. Ask the crew again.");
    let casting=currentCasting(project.id,project.castingHistory),direction=currentDirection(project.id,project.directionHistory);
    if(casting.version!==expected.castingVersion)throw new CastingConflict("The cast changed while the crew was working. Ask the crew again.");
    if(direction.version!==expected.directionVersion)throw new DirectionConflict("The shot directions changed while the crew was working. Ask the crew again.");
    if(![24,60].includes(maxShots))throw new Error("Choose the 24-shot or 60-shot planning limit.");
    // HV-022-02: the crew's voices go only to characters without one, in the same cast version.
    const voices=(changes.voices??[]).filter(({characterId})=>!casting.characters.find(character=>character.id===characterId)?.audioVoice);
    if(changes.characters.length||voices.length){
      const added=changes.characters.map(({id,input})=>characterRecord(input,id,now));
      if(added.some(character=>casting.characters.some(existing=>existing.id===character.id)))throw new CastingConflict("The crew may only add cast members.");
      const characters=[...structuredClone(casting.characters),...added];
      for(const {characterId,profile}of voices){const character=characters.find(value=>value.id===characterId);if(!character)throw new CastingConflict("The crew voiced a character who is not in the cast.");character.audioVoice=structuredClone(profile);}
      casting=castingSnapshot(project.id,casting.version+1,characters,now);
    }
    let entries=direction.entries;
    if(changes.directions.length){
      const shots=sourcePlan(parseFountain(script.text),direction,7000,maxShots);
      const replaced=new Set(changes.directions.map(change=>change.shotId));
      if(direction.entries.some(entry=>replaced.has(entry.source.id)))throw new DirectionConflict("The crew may only direct shots you have not directed.");
      entries=[...direction.entries,...changes.directions.map(change=>{const shot=shots.find(value=>value.id===change.shotId);if(!shot)throw new DirectionConflict("A shot the crew planned is no longer in the screenplay.");return directionEntry(shot,change.input);})];
    }
    if(changes.characters.length||voices.length){project.castingHistory=[...project.castingHistory,casting].slice(-100);}
    if(changes.directions.length){direction=directionSnapshot(project.id,direction.version+1,entries,now,direction.sceneCuts);project.directionHistory=[...project.directionHistory,direction].slice(-100);}
    if(changes.characters.length||voices.length||changes.directions.length)this.persist();
    return {casting:structuredClone(casting),direction:structuredClone(direction)};
  }
  saveShotDirection(token:string,shotId:string,input:unknown,expectedVersion:number,expectedScriptVersion:number,sourceHash:string,maxShots=24,now=Date.now()):DirectionSnapshot|null {
    const project=this.directionProject(token,expectedVersion,now);if(!project)return null;
    const script=project.versions.latest();if(!script||script.version!==expectedScriptVersion)throw new DirectionConflict("The screenplay changed. Reload and review this shot before saving its direction.");
    if(![24,60].includes(maxShots))throw new Error("Choose the 24-shot or 60-shot planning limit.");
    const shot=sourcePlan(parseFountain(script.text),currentDirection(project.id,project.directionHistory),7000,maxShots).find(value=>value.id===shotId);if(!shot)throw new DirectionConflict("This shot is no longer in the current screenplay plan.");
    const entry=directionEntry(shot,input);if(sourceHash!==entry.sourceHash)throw new DirectionConflict("The source shot changed. Reload and review it before saving.");
    if(entry.settings.picture?.length){const parsed=parseFountain(script.text);picturePerformance(charactersForScene(currentCasting(project.id,project.castingHistory),shot.sceneIndex,parsed),parsed.scenes[shot.sceneIndex]!,entry.settings.picture);}
    const current=currentDirection(project.id,project.directionHistory);return this.saveDirectionSnapshot(project,[...current.entries.filter(value=>value.source.id!==shotId),entry],now);
  }
  storeFrameAnchorAsset(token:string,reference:ReferenceAsset,expectedVersion:number,expectedScriptVersion:number,maxShots=24,now=Date.now()):ReferenceAsset|null {
    const project=this.directionProject(token,expectedVersion,now);if(!project)return null;
    const asset=validateReference(reference,project.id),source=asset.source;if(source?.kind!=="shot-anchor")throw new Error("Use a shot anchor upload.");
    const script=project.versions.latest();if(!script||script.version!==expectedScriptVersion)throw new DirectionConflict("The screenplay changed. Reload before adding an anchor image.");
    if(![24,60].includes(maxShots))throw new Error("Choose the 24-shot or 60-shot planning limit.");
    const shot=sourcePlan(parseFountain(script.text),currentDirection(project.id,project.directionHistory),7000,maxShots).find(value=>value.id===source.shotId);
    if(!shot||directionEntry(shot,{}).sourceHash!==source.sourceHash)throw new DirectionConflict("The source shot changed. Reload before adding an anchor image.");
    if(project.referenceAssets.length>=MAX_REFERENCE_ASSETS)throw new Error("This project has reached its historical image limit.");
    if(project.referenceAssets.some(value=>value.id===asset.id))throw new Error("This image is already stored.");
    project.referenceAssets.push(asset);this.persist();return structuredClone(asset);
  }
  private motionContext(project:Project):MotionContext {
    const script=project.versions.latest();return {projectId:project.id,scriptText:script?.text??"",scriptVersion:script?.version??0,casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory),assets:project.referenceAssets};
  }
  saveMotionStudy(token:string,shotId:string,input:unknown,expected:{version:number;scriptVersion:number;directionVersion:number;castingRevision:string},now=Date.now()):MotionStudies|null {
    const project=this.directionProject(token,expected?.directionVersion,now);if(!project)return null;
    const context=this.motionContext(project),current=project.motionStudies;
    if(!Number.isSafeInteger(expected.version)||expected.version!==current.version||expected.scriptVersion!==context.scriptVersion||expected.castingRevision!==context.casting.revision)throw new DirectionConflict("The screenplay, cast or movement plans changed. Reload and review before saving.");
    const study=createMotionStudy(context,shotId,input,current.version+1,now),studies=[...current.studies.filter(value=>value.source.id!==shotId),study];
    if(studies.length>60)throw new Error("Keep up to 60 movement plans. Remove an unused plan first.");
    project.motionStudies=validateMotionStudies({schema:"hv-motion-studies/1",version:current.version+1,studies},project.id,project.referenceAssets);this.persist();return structuredClone(project.motionStudies);
  }
  removeMotionStudy(token:string,shotId:string,expectedVersion:number,revision:string,now=Date.now()):MotionStudies|null {
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const current=project.motionStudies,study=current.studies.find(s=>s.source.id===shotId);
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==current.version||!study||study.revision!==revision)throw new DirectionConflict("The movement plan changed. Reload before removing it.");
    project.motionStudies={schema:"hv-motion-studies/1",version:current.version+1,studies:current.studies.filter(s=>s!==study)};this.persist();return structuredClone(project.motionStudies);
  }
  currentMotionStudy(token:string,shotId:string,revision:string,now=Date.now()) {
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    const study=project.motionStudies.studies.find(s=>s.source.id===shotId);
    if(!study||study.revision!==revision)throw new DirectionConflict("The movement plan changed. Reload before exporting it.");
    return assertMotionStudyCurrent(study,this.motionContext(project),now);
  }
  adoptShotTake(token:string,input:ShotTakePlan,takeId:string,expectedVersion:number,expectedScriptVersion:number,now=Date.now()):DirectionSnapshot|null {
    const project=this.directionProject(token,expectedVersion,now);if(!project)return null;
    const plan=validateShotTakes(input),script=project.versions.latest();
    if(plan.projectId!==project.id||!script||script.version!==expectedScriptVersion||script.version!==plan.scriptVersion)throw new DirectionConflict("The source screenplay changed. Generate new takes before adopting.");
    const base=plan.directionVersion===0?directionSnapshot(project.id,0,[],0):project.directionHistory.find(d=>d.version===plan.directionVersion&&d.revision===plan.directionRevision);
    if(!base)throw new DirectionConflict("The take group's base direction is no longer retained. Generate a new group.");
    shotTakeShots(plan,currentCasting(project.id,project.castingHistory),parseFountain(script.text),base,script.version,now);assertTakeCatalog(plan,project.referenceAssets);
    const take=plan.takes.find(t=>t.id===takeId);if(!take)throw new Error("Choose one of this group's completed takes.");
    const shot=sourcePlan(parseFountain(script.text),currentDirection(project.id,project.directionHistory),7000,plan.maxShots).find(s=>s.id===plan.source.id);
    if(!shot||directionEntry(shot,{}).sourceHash!==plan.sourceHash)throw new DirectionConflict("The accepted coverage changed this take source. Generate a new group.");
    const entry=directionEntry(shot,take.settings),current=currentDirection(project.id,project.directionHistory);
    return this.saveDirectionSnapshot(project,[...current.entries.filter(e=>e.source.id!==shot.id),entry],now);
  }
  removeShotDirection(token:string,shotId:string,expectedVersion:number,now=Date.now()):DirectionSnapshot|null {
    const project=this.directionProject(token,expectedVersion,now);if(!project)return null;
    const current=currentDirection(project.id,project.directionHistory);if(!current.entries.some(value=>value.source.id===shotId))throw new Error("This shot has no saved direction.");
    return this.saveDirectionSnapshot(project,current.entries.filter(value=>value.source.id!==shotId),now);
  }
  restoreDirection(token:string,version:number,expectedVersion:number,now=Date.now()):DirectionSnapshot|null {
    const project=this.directionProject(token,expectedVersion,now);if(!project)return null;
    const saved=version===0?directionSnapshot(project.id,0,[],0):project.directionHistory.find(value=>value.version===version);
    if(!saved)throw new Error("Choose an available direction version.");return this.saveDirectionSnapshot(project,saved.entries,now,saved.sceneCuts??[]);
  }
  shareCharacter(token:string,id:string,expectedVersion:number,attested:boolean,now=Date.now()):ActorShare|null {
    const project=this.castProject(token,expectedVersion,now);if(!project)return null;
    if(attested!==true)throw new Error("Confirm you may share this actor's directions and reference images for copying into other projects.");
    const active=project.actorShares.filter(share=>!share.revokedAt && Date.parse(share.expiresAt)>now);
    if(active.length>=MAX_ACTOR_SHARES)throw new Error("This project has 48 active actor shares. Revoke an existing share first.");
    const share=createActorShare(currentCasting(project.id,project.castingHistory),id,project.deleteAfter,now);
    project.actorShares=[...active,share];this.persist();return structuredClone(share);
  }
  revokeActorShare(token:string,characterId:string,shareId:string,now=Date.now()):ActorShare|null {
    const project=this.authorize(token,now);if(!project || Date.parse(project.deleteAfter)<=now)return null;
    const share=project.actorShares.find(value=>value.id===shareId && value.character.id===characterId);if(!share)throw new ActorShareUnavailable();
    share.revokedAt??=new Date(now).toISOString();this.persist();return structuredClone(share);
  }
  sharedActor(token:string,now=Date.now()):ActorShare {
    const payload=verifyActorToken(token,now);if(!payload)throw new ActorShareUnavailable();this.reload();
    const project=this.projects.get(payload.projectId),share=project?.actorShares.find(value=>value.id===payload.shareId);
    if(!project || this.takenDown.has(project.id) || Date.parse(project.deleteAfter)<=now || !share || share.revokedAt || share.revision!==payload.revision
      || Date.parse(share.expiresAt)!==payload.exp)throw new ActorShareUnavailable();
    validateActorShare(share,project.id);
    const current=currentCasting(project.id,project.castingHistory).characters.find(character=>character.id===share.character.id);if(!current)throw new ActorShareUnavailable();assertShareable(current,now);
    if((share.character.references??[]).some(asset=>!project.referenceAssets.some(value=>contentHash(value)===contentHash(asset))))throw new ActorShareUnavailable();
    return structuredClone(share);
  }
  importSharedActor(token:string,shareToken:string,references:ReferenceAsset[],expectedVersion:number,options:{name:string;aliases:string[];attested:boolean},now=Date.now()):CastingSnapshot|null {
    const share=this.sharedActor(shareToken,now),project=this.castProject(token,expectedVersion,now);if(!project)return null;
    if(project.id===share.projectId)throw new Error("Import this shared actor into a different project.");
    if(options.attested!==true)throw new Error("Review the shared actor and confirm that you want to copy its directions and images into this project.");
    if(project.referenceAssets.length+references.length>MAX_REFERENCE_ASSETS)throw new Error("This project has reached its historical reference limit.");
    if(new Set(references.map(asset=>asset.id)).size!==references.length || references.some(asset=>project.referenceAssets.some(existing=>existing.id===asset.id)))throw new Error("The actor references are already stored.");
    const character=importedActor(share,crypto.randomUUID(),project.id,options.name,options.aliases,references,now),current=currentCasting(project.id,project.castingHistory);
    const next=castingSnapshot(project.id,current.version+1,[...current.characters,character],now);
    project.referenceAssets.push(...structuredClone(references));project.castingHistory.push(next);project.castingHistory=project.castingHistory.slice(-100);this.persist();return structuredClone(next);
  }
  useCostumePreset(token:string,id:string,index:number,sceneNumber:number|null,expectedVersion:number,remove=false,now=Date.now(),expectedScriptVersion?:number):CastingSnapshot|null {
    const project=this.castProject(token,expectedVersion,now);if(!project)return null;
    const characters=currentCasting(project.id,project.castingHistory).characters,character=characters.find(value=>value.id===id),preset=character?.costumePresets?.[index];
    if(!Number.isSafeInteger(index) || index<0 || !preset)throw new Error("Choose a saved costume preset.");
    if(remove)character!.costumePresets!.splice(index,1);
    else {
      if(project.versions.latest()?.version!==expectedScriptVersion)throw new CastingConflict("The screenplay changed. Reload the cast before assigning a costume preset.");
      const parsed=parseFountain(project.versions.latest()?.text??"");
      for(const binding of character!.sceneBindings)if(parsed.scenes.find(scene=>scene.index+1===binding.sceneNumber)?.heading!==binding.heading)throw new CastingConflict("Scene "+binding.sceneNumber+" changed. Review and save this character first.");
      const scene=parsed.scenes.find(value=>value.index+1===sceneNumber);
      if(sceneNumber!==null && (!Number.isInteger(sceneNumber)||!scene))throw new Error("Choose the default wardrobe or a scene in this screenplay.");
      character!.wardrobe=[...character!.wardrobe.filter(value=>value.sceneNumber!==sceneNumber),{sceneNumber,description:preset.description}];
      if(scene && !character!.sceneBindings.some(binding=>binding.sceneNumber===sceneNumber))character!.sceneBindings.push({sceneNumber:sceneNumber!,heading:scene.heading});
    }
    return this.saveCast(project,characters,now);
  }
  removeCharacter(token: string, id: string, expectedVersion: number, now = Date.now()): CastingSnapshot | null {
    const project = this.castProject(token, expectedVersion, now); if (!project) return null;
    const characters = currentCasting(project.id, project.castingHistory).characters;
    if (!characters.some(character => character.id === id)) throw new Error("This character is not in the current cast.");
    return this.saveCast(project, characters.filter(character => character.id !== id), now);
  }
  revokeCharacterPermission(token: string, id: string, expectedVersion: number, now = Date.now()): CastingSnapshot | null {
    const project = this.castProject(token, expectedVersion, now); if (!project) return null;
    const characters = currentCasting(project.id, project.castingHistory).characters;
    const character = characters.find(character => character.id === id);
    if (!character) throw new Error("This character is not in the current cast.");
    // Revocation must work even if the screenplay no longer contains a bound scene.
    character.permission = {...character.permission, status: "revoked", attestedAt: null};
    return this.saveCast(project, characters, now);
  }
  addCharacterReference(token: string, id: string, reference: ReferenceAsset, expectedVersion: number, now = Date.now(), expectedScriptVersion?:number): CastingSnapshot | null {
    return this.addCharacterReferences(token,id,[reference],expectedVersion,now,{expectedScriptVersion});
  }
  addCharacterReferences(token:string,id:string,references:ReferenceAsset[],expectedVersion:number,now=Date.now(),options:ReferenceBatchOptions={}):CastingSnapshot|null {
    const project = this.castProject(token,expectedVersion,now);if (!project) return null;
    if(options.expectedScriptVersion!==undefined && project.versions.latest()?.version!==options.expectedScriptVersion)throw new CastingConflict("The screenplay changed after this sheet. Generate a new sheet before adopting its view.");
    if(!Array.isArray(references) || !references.length || references.length>4)throw new Error("Choose one to four reference images.");
    const assets = references.map(reference=>validateReference(reference,project.id)), characters = currentCasting(project.id,project.castingHistory).characters;
    const character = characters.find(character => character.id === id);
    if (!character) throw new Error("Save the character before adding a reference.");
    if(options.sheet) {
      if(options.sheet.characterId!==id)throw new Error("This sheet belongs to a different character.");
      characterSheetShots(options.sheet,currentCasting(project.id,project.castingHistory),parseFountain(project.versions.latest()?.text??""),now);
    }
    const previous=options.replaceExisting?[]:character.references??[];
    // HV-017-10: replacing images the locked look names would leave the look pointing at images the
    // character no longer holds. That is the creator's decision, and it is refused here by name
    // rather than left to the snapshot validator, which would throw without saying whose look it was.
    if(options.replaceExisting&&character.referenceLock?.assets.length)
      throw new CastingConflict("Replacing these images would break "+character.name+"'s locked look. Unlock the look, or lock it to other images, before replacing them.");
    if (previous.length + assets.length > 4) throw new Error("A character supports up to four reference images. Replace the current references or select fewer views.");
    if (project.referenceAssets.length + assets.length > MAX_REFERENCE_ASSETS) throw new Error("This project has reached its 96-image reference limit.");
    if(new Set(assets.map(asset=>asset.id)).size!==assets.length || assets.some(asset=>project.referenceAssets.some(value=>value.id===asset.id)))throw new Error("This reference is already stored.");
    character.references = [...previous,...assets];
    const next = castingSnapshot(project.id,currentCasting(project.id,project.castingHistory).version + 1,characters,now);
    project.referenceAssets.push(...assets);project.castingHistory.push(next);project.castingHistory = project.castingHistory.slice(-100);
    this.persist();return structuredClone(next);
  }
  removeCharacterReference(token: string, id: string, referenceId: string, expectedVersion: number, now = Date.now()): CastingSnapshot | null {
    const project = this.castProject(token,expectedVersion,now);if (!project) return null;
    const characters = currentCasting(project.id,project.castingHistory).characters, character = characters.find(character => character.id === id);
    if (!character?.references?.some(asset => asset.id === referenceId)) throw new Error("This reference is not in the character's current cast.");
    // Removing a locked image would leave the look pointing at an image the character no longer holds,
    // so the choice is the creator's and is made explicitly rather than by a silent unlock.
    if (character.referenceLock?.assets.some(asset => asset.id === referenceId)) throw new CastingConflict("This image is part of " + character.name + "'s locked look. Unlock the look, or lock it to other images, before removing this one.");
    // Historical casts and queued renders retain their immutable image bytes until project retention.
    character.references = character.references.filter(asset => asset.id !== referenceId);
    return this.saveCast(project,characters,now);
  }
  restoreCasting(token: string, version: number, expectedVersion: number, now = Date.now()): CastingSnapshot | null {
    const project = this.castProject(token, expectedVersion, now); if (!project) return null;
    const saved = version === 0 ? castingSnapshot(project.id, 0, [], 0) : project.castingHistory.find(snapshot => snapshot.version === version);
    if (!saved) throw new Error("This cast version does not exist.");
    // Restoring direction cannot restore a revoked permission. The owner must attest again.
    const characters = saved.characters.map(character => ({...character, permission: {...character.permission, status: "pending" as const, attestedAt: null}}));
    return this.saveCast(project, characters, now);
  }

  attestRights(token: string, now = Date.now()): Project | null {
    const project = this.authorize(token, now);
    if (!project) return null;
    project.rightsAttestedAt = new Date(now).toISOString();
    this.persist();
    return project;
  }

  /** A pending preview is reviewed against its saved proposal, while the original remains current. */
  recordLivingScriptDecision(token:string,preview:Job,review:LivingScriptPreviewReview,decision:ReviewDecision,note:string,carrier:EditAssemblyCarrier,now=Date.now()):{approval:AnimaticApproval;replayed:boolean}|null{
    const project=this.authorize(token,now);if(!project)return null;
    if(!preview.livingScript||preview.projectId!==project.id||preview.livingScript.request.role!=="preview"||!["approved","changes_requested"].includes(decision)||typeof note!=="string"||note.length>2000)editFail("Review a completed pending preview for this project.");
    if(!Number.isFinite(now)||Date.parse(preview.completedAt??"")>now||!Number.isFinite(Date.parse(preview.linkExpiresAt??""))||Date.parse(preview.linkExpiresAt!)<=now)editFail("The pending preview is no longer available for review.");
    const expected=createLivingScriptPreviewReview(preview);if(contentHash(expected)!==contentHash(review))editFail("The pending preview changed after its review was opened.");
    if(contentHash(carrier.binding)!==contentHash(preview.livingScript.binding))editFail("The pending preview original carrier changed.");
    assertLivingScriptGenerationCurrent(preview.livingScript,project,carrier.current,now);
    const previous=project.animaticApprovals.find(value=>value.animaticJobId===preview.id);
    if(previous?.livingScriptReview&&contentHash(previous.livingScriptReview)===contentHash(expected)&&previous.decision===decision&&previous.note===note)return {approval:structuredClone(previous),replayed:true};
    if(previous&&Date.parse(previous.at)>=now)editFail("The preview decision just changed. Retry after refreshing its review.");
    const settings=preview.livingScript.proposal.request.candidate,casting=settings.casting??castingSnapshot(project.id,0,[],0),direction=settings.direction??directionSnapshot(project.id,0,[],0);
    const approval:AnimaticApproval={animaticJobId:preview.id,scriptVersion:preview.scriptVersion,decision,note,at:new Date(now).toISOString(),castingVersion:casting.version,castingRevision:casting.revision,directionVersion:direction.version,directionRevision:direction.revision,livingScriptReview:expected};
    // The first decision is current; older decisions remain evidence for already admitted films.
    const state=this.snapshot(),saved=state.projects.find(value=>value.id===project.id)!;saved.animaticApprovals=[approval,...saved.animaticApprovals];
    const detached=ProjectService.fromState(state).snapshot();if(this.statePath)writeJsonFile(this.statePath,detached);this.loadState(detached);
    return {approval:structuredClone(approval),replayed:false};
  }
  /** Append an exact current-film decision without publishing its proposed screenplay. */
  recordCurrentFilmDecision(token:string,preview:Job,review:CurrentFilmPreviewReview,decision:ReviewDecision,note:string,now=Date.now()):{approval:AnimaticApproval;replayed:boolean}|null {
    const project=this.authorize(token,now);if(!project)return null;
    const expected=validateCurrentFilmPreviewReview(preview,review),plan=preview.currentFilm!;
    if(preview.projectId!==project.id||!["approved","changes_requested"].includes(decision)||typeof note!=="string"||note.length>2000)editFail("Review the exact completed current-film preview for this project.");
    if(!Number.isSafeInteger(now)||Date.parse(preview.completedAt!)>now||Date.parse(preview.linkExpiresAt!)<=now)editFail("The current-film preview is unavailable for review.");
    assertCurrentFilmGenerationCurrent(plan,project,now);
    const previous=project.animaticApprovals.filter(value=>value.animaticJobId===preview.id).at(-1);
    if(previous?.currentFilmReview&&contentHash(previous.currentFilmReview)===contentHash(expected)&&previous.decision===decision&&previous.note===note)return {approval:structuredClone(previous),replayed:true};
    if(previous&&Date.parse(previous.at)>=now)editFail("The current-film decision just changed. Refresh its review.");
    const cast=plan.target.state.casting.candidate!,direction=plan.library.origin!.request.baseline.direction;
    const approval:AnimaticApproval={animaticJobId:preview.id,scriptVersion:preview.scriptVersion,decision,note,at:new Date(now).toISOString(),castingVersion:cast.version,castingRevision:cast.revision,directionVersion:direction.version,directionRevision:direction.revision,currentFilmReview:expected};
    const state=this.snapshot(),saved=state.projects.find(value=>value.id===project.id)!;saved.animaticApprovals.push(approval);
    const detached=ProjectService.fromState(state).snapshot();if(this.statePath)writeJsonFile(this.statePath,detached);this.loadState(detached);
    return {approval:structuredClone(approval),replayed:false};
  }
  recordAnimaticDecision(
    projectId: string,
    animaticJobId: string,
    scriptVersion: number,
    decision: ReviewDecision,
    note = "",
    now = Date.now(),
    expectedCasting?: CastingSnapshot,
    expectedDirection?: DirectionSnapshot,
    expectedTakes?:ShotTakePlan,
  ): AnimaticApproval | null {
    this.reload();
    const project = this.projects.get(projectId);
    if (!project) return null;
    if(project.animaticApprovals.some(value=>value.animaticJobId===animaticJobId&&(value.livingScriptReview||value.currentFilmReview)))editFail("Use the screenplay-specific preview decision flow.");
    if (expectedCasting && !castingMatches(expectedCasting, currentCasting(projectId, project.castingHistory))) return null;
    if(expectedDirection&&(!directionMatches(expectedDirection,currentDirection(projectId,project.directionHistory))||project.versions.latest()?.version!==scriptVersion))return null;
    if(expectedTakes){
      if(Date.parse(project.deleteAfter)<=now||!expectedDirection||!expectedCasting)return null;
      shotTakeShots(expectedTakes,currentCasting(projectId,project.castingHistory),parseFountain(project.versions.latest()?.text??""),currentDirection(projectId,project.directionHistory),project.versions.latest()?.version??0,now);
      assertTakeCatalog(expectedTakes,project.referenceAssets);
    }
    const approval: AnimaticApproval = {
      animaticJobId,
      ...(expectedTakes?{takeRevision:expectedTakes.revision}:{}),
      scriptVersion,
      decision,
      note: note.slice(0, 2000),
      at: new Date(now).toISOString(),
      ...(expectedCasting ? {castingVersion: expectedCasting.version, castingRevision: expectedCasting.revision} : {}),
      ...(expectedDirection?{directionVersion:expectedDirection.version,directionRevision:expectedDirection.revision}:{}),
    };
    project.animaticApprovals = project.animaticApprovals.filter((entry) => entry.animaticJobId !== animaticJobId);
    project.animaticApprovals.push(approval);
    this.persist();
    return approval;
  }

  /** Read-only lookup that does not require the owner token; used to bound reviewer links to the project's retention window. */
  peekProject(projectId: string): Project | null {
    this.reload();
    if (this.takenDown.has(projectId)) return null;
    return this.projects.get(projectId) ?? null;
  }

  animaticApproval(projectId: string, animaticJobId: string): AnimaticApproval | null {
    this.reload();
    const project = this.projects.get(projectId);
    return project?.animaticApprovals.find((entry) => entry.animaticJobId === animaticJobId) ?? null;
  }

  selectDialogueVersion(token:string,job:Job,sourceJobId:string,expectedVersion:number,expectedOutputRevision:string,now=Date.now()):DialogueSelections|null{
    const project=this.authorize(token,now);if(!project)return null;
    project.dialogueSelections=selectDialogueOutput(project.dialogueSelections,job,project,sourceJobId,expectedVersion,expectedOutputRevision,now);this.persist();return structuredClone(project.dialogueSelections);
  }
  createBoundReviewLink(token:string,permission:ReviewPermission,job:Job,binding:OutputBinding,now=Date.now(),maxViews?:number):ReviewLink|null{
    const project=this.authorize(token,now);if(!project)return null;assertSelectedOutput(job,project,binding,now);return this.createReviewLink(token,permission,now,binding,maxViews);
  }
  createReviewLink(ownerToken: string, permission: ReviewPermission, now = Date.now(), binding?:OutputBinding, maxViews?:number): ReviewLink | null {
    const project = this.authorize(ownerToken, now);
    if (!project) return null;
    const capability = reviewPermission(permission);
    const token = mintReviewToken(project.id, capability, now);
    const link: ReviewLink = { token, projectId: project.id, permission: capability, views: 0, revoked: false, decision: null, decisionNote: null };
    if(binding)link.outputBinding=validateOutputBinding(binding);
    if(maxViews!==undefined){link.maxViews=reviewViewLimit(maxViews);link.viewers=[];}
    this.reviewLinks.set(token, link);
    this.persist();
    return link;
  }

  /** Opens and counts in one step, for an anonymous viewer: every call is a view. The HTTP route opens, serves, then records. */
  useReviewLink(token: string, now = Date.now()): { projectId: string; permission: ReviewPermission; viewsRemaining: number;outputBinding?:OutputBinding } | null {
    const opened = this.openReviewLink(token, null, now);
    if (!opened) return null;
    const viewsRemaining = this.recordReviewView(token, null, now);
    return viewsRemaining === null ? null : {...opened, viewsRemaining};
  }

  /**
   * HV-029-05. May this viewer be shown the cut? Counts nothing: the route counts a view
   * only once it has something to show and the permission gate has passed, so an early
   * open (no cut yet), a refused cut or a lost binding race costs the link nothing.
   * A viewer already counted may always come back, even when the limit is reached.
   */
  openReviewLink(token: string, viewer: ReviewViewer | null, now = Date.now()): { projectId: string; permission: ReviewPermission; viewsRemaining: number; outputBinding?: OutputBinding } | null {
    // The signature first: these routes carry no bearer token, so a caller who has not shown a
    // valid review token has not earned a read of the whole studio's state (HV-038-07).
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review") return null;
    this.reload();
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked) return null;
    const limit = link.maxViews ?? REVIEW_MAX_VIEWS;
    if (link.views >= limit && !reviewViewerKnown(link, viewer)) return null;
    return { projectId: link.projectId, permission: link.permission, viewsRemaining: Math.max(0, limit - link.views),
      ...(link.outputBinding ? {outputBinding: structuredClone(link.outputBinding)} : {}) };
  }

  /**
   * HV-029-05. Count a view that was served. A known viewer is not counted again (a
   * reload is not a second viewer); an anonymous one always is, as before. Returns the
   * views left, or null if the last view went to someone else in the meantime -- the
   * route then refuses rather than serving past the limit.
   */
  recordReviewView(token: string, viewer: ReviewViewer | null, now = Date.now()): number | null {
    this.reload();
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked) return null;
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review") return null;
    const limit = link.maxViews ?? REVIEW_MAX_VIEWS;
    if (reviewViewerKnown(link, viewer)) return Math.max(0, limit - link.views);
    if (link.views >= limit) return null;
    link.views += 1;
    if (viewer) link.viewers = [...(link.viewers ?? []), viewer.hash];
    this.persist();
    return limit - link.views;
  }

  /**
   * Fix an unbound review link to the cut a reviewer was actually shown.
   *
   * A link minted before the project had any finished cut carries no binding,
   * and the read path resolved `latestFinishedCut` afresh on every view. That
   * made two things true at once: the reviewer could be shown a different cut
   * each time, and — because the permission gate was reached only through the
   * binding — no cut they were shown was ever checked against current cast
   * permission, link expiry or project deletion. Binding on first successful
   * view closes both: the link names one cut from then on, and every later
   * read and the decision go through the same gate a bound link always did.
   *
   * Only ever sets a binding, never replaces one — and it returns the binding
   * the link *has*, which is not always the one offered. Two first views can
   * race: both pass the gate, possibly on different cuts if one finishes
   * between them, and only one binding is kept. The caller compares what came
   * back with what it resolved and refuses if they differ, rather than serving
   * one cut while the link names another.
   *
   * `validateOutputBinding` is a parser, not an authorization check: it says
   * the shape is a job id and a 64-hex revision, nothing about whose job it is.
   * That is safe only because the one caller derives the binding from the job
   * it has just put through `assertSelectedOutput`.
   */
  bindReviewLink(token: string, binding: OutputBinding, now = Date.now()): OutputBinding | null {
    // The signature first (HV-038-07).
    if (verifyToken(token, now)?.kind !== "review") return null;
    this.reload();
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked || link.views > (link.maxViews ?? REVIEW_MAX_VIEWS)) return null;
    if (link.outputBinding) return structuredClone(link.outputBinding);
    link.outputBinding = validateOutputBinding(binding);
    this.persist();
    return structuredClone(link.outputBinding);
  }

  peekReviewLink(token: string, now = Date.now(), viewer: ReviewViewer | null = null): ReviewLink | null {
    // The signature first (HV-038-07), as in `openReviewLink` above.
    if (verifyToken(token, now)?.kind !== "review") return null;
    this.reload();
    const link = this.reviewLinks.get(token);
    // Used to decide: a link whose views are all spent still takes a decision from the
    // viewer who watched on the last one (or, on a link without viewer ids, from anyone).
    const limit = link?.maxViews ?? REVIEW_MAX_VIEWS;
    if (!link || link.revoked || link.views > limit || (link.views === limit && link.viewers !== undefined && !reviewViewerKnown(link, viewer))) return null;
    return link;
  }

  revokeReviewLink(ownerToken: string, reviewToken: string, now = Date.now()): boolean {
    const project = this.authorize(ownerToken, now);
    const link = this.reviewLinks.get(reviewToken);
    if (!project || !link || link.projectId !== project.id) return false;
    link.revoked = true;
    this.persist();
    return true;
  }

  /**
   * A decision comes from someone who was shown the cut (HV-029-05). For a link that
   * counts viewers, that is a counted viewer, including the one who took the last view:
   * before, a link refused the decision once its views were used, so whoever watched on
   * the final view could not approve. A link without viewer ids keeps the old rule, but
   * inclusive of the last view. Deciding no longer spends a view.
   */
  submitReviewDecision(token: string, decision: ReviewDecision, note = "", now = Date.now(),job?:Job,viewer:ReviewViewer|null=null): boolean {
    // The signature first (HV-038-07). This route paid for the studio twice -- once here and once
    // in the `peekReviewLink` the route runs beside it -- before asking whether the caller was one.
    if (verifyToken(token, now)?.kind !== "review") return false;
    this.reload();
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked || !mayApprove(link.permission)) return false;
    if (link.viewers !== undefined ? !reviewViewerKnown(link, viewer) : link.views > (link.maxViews ?? REVIEW_MAX_VIEWS)) return false;
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review" || !mayApprove(payload.permission)) return false;
    // A decision has to name what was decided. An unbound link reaches here
    // only when nothing was ever successfully read through it, and recording
    // an approval of an unnamed cut is exactly what let the permission gate be
    // skipped: `assertSelectedOutput` was conditional on the binding, so no
    // binding meant no check.
    if(!link.outputBinding)return false;
    assertSelectedOutput(job,this.projects.get(link.projectId),link.outputBinding,now);
    link.decision = decision;
    link.decisionNote = note.slice(0, 2000);
    this.persist();
    return true;
  }

  latestScript(token: string, now = Date.now()): string | null {
    return this.authorize(token, now)?.versions.latest()?.text ?? null;
  }

  /**
   * Takes a project down and stops its generation.
   *
   * `revoker` is required. Before it, takedown removed the project from every
   * read path and left the queue untouched: a project could be taken down while
   * its queued jobs were still claimed and its running job still called a
   * provider, because nothing in `packages/queue` had ever heard of a takedown.
   * Requiring the argument means a caller cannot *omit* the queue half; it does
   * not mean the argument is necessarily a queue that holds this project's jobs,
   * and nothing in this signature can check that.
   *
   * Order and atomicity. The tombstone is written first, because that is what
   * stops admission, and revocation follows, because that is what stops work
   * already admitted. On this JSON path the two are separate writes to separate
   * files, so a revoker that throws leaves the project down and its jobs
   * running — which is why revocation also runs on the already-taken-down
   * branch below, so re-issuing the takedown retries it. `PostgresProjectService`
   * does both halves in one transaction and has no such window.
   *
   * There is no compensating project read in the worker for an ordinary render
   * job: `assertPendingContext` returns early for anything that is not a
   * current-film or living-screenplay job. Revocation reaches a running worker
   * through its lease, not through a permission read.
   */
  async takedown(projectId: string, reason: string, revoker: GenerationRevoker, now = Date.now()): Promise<boolean> {
    this.reload();
    if (this.takenDown.has(projectId)) {
      // Idempotent retry: the tombstone is already written, so report no change,
      // but re-run the revocation in case a previous attempt failed after it.
      await revoker.revokeProject(projectId, GENERATION_REVOKED_NOTICE, now);
      return false;
    }
    if (!this.projects.has(projectId)) return false;
    this.takenDown.add(projectId);
    this.projects.delete(projectId);
    this.takedownLog.push({ projectId, at: new Date(now).toISOString(), reason });
    this.persist();
    await revoker.revokeProject(projectId, GENERATION_REVOKED_NOTICE, now);
    return true;
  }

  isTakenDown(projectId: string): boolean {
    this.reload();
    return this.takenDown.has(projectId);
  }

  extendRetention(projectId: string, days: number, reason: string, now = Date.now()): boolean {
    this.reload();
    const project = this.projects.get(projectId);
    if (!project) return false;
    project.deleteAfter = new Date(new Date(project.deleteAfter).getTime() + days * 24 * 3600 * 1000).toISOString();
    project.operatorExtensions.push({ extendedAt: new Date(now).toISOString(), days, reason });
    this.persist();
    return true;
  }

  sweepExpired(now = Date.now()): string[] {
    this.reload();
    const removed: string[] = [];
    for (const [id, project] of this.projects) {
      if (new Date(project.deleteAfter).getTime() <= now) {
        this.projects.delete(id);
        removed.push(id);
      }
    }
    if (removed.length) this.persist();
    return removed;
  }
}
