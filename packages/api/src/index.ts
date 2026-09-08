import {sourcePlan,staleSceneCuts,cutSource,cutProposal,proposeSceneCut,sceneCut,validateCutProposal,SceneCutConflict,type CutProposal,type CutBinding,type SceneCut} from "../../planner/src/scene-cuts";
import {shotTakeShots,validateShotTakes,assertTakeCatalog,type ShotTakePlan} from "../../planner/src/takes";
import {assertMotionStudyCurrent,createMotionStudy,emptyMotionStudies,validateMotionStudies,type MotionContext,type MotionStudies} from "../../planner/src/motion-studies";
import { REVIEW_MAX_VIEWS, mintProjectToken, mintReviewToken, verifyToken } from "./tokens";
import { parseFountain, VersionStore, type ScriptVersion } from "../../parser/src/index";
import { readJsonFile, writeJsonFile } from "./persist";
import { CastingConflict, characterRecord, castingMatches, castingSnapshot, currentCasting, charactersForScene, type CastingSnapshot } from "../../planner/src/casting";
import { MAX_REFERENCE_ASSETS, validateReference, type ReferenceAsset } from "../../planner/src/references";
import {assertFrameAnchorCatalog} from "../../planner/src/frame-anchors";
import { characterSheetShots, type CharacterSheetPlan } from "../../planner/src/sheets";
export interface ReferenceBatchOptions {expectedScriptVersion?:number;replaceExisting?:boolean;sheet?:CharacterSheetPlan}
import { ActorShareUnavailable, assertShareable, createActorShare, importedActor, MAX_ACTOR_SHARES, validateActorShare, type ActorShare } from "../../planner/src/actor-library";
import { verifyActorToken } from "./actor-token";
import { contentHash } from "../../generator/src/capabilities";
import {createScenePerformance,scenePerformanceSource} from "../../planner/src/performance-memory";
import {picturePerformance} from "../../planner/src/picture-performance";
import {audioRecord,audioNumber} from "../../planner/src/audio-performances";
import {currentDirection,directionEntry,directionMatches,directionSnapshot,DirectionConflict,validateDirection,type DirectionSnapshot} from "../../planner/src/direction";

import type {Job} from "../../queue/src/index";
import {emptySoundLibrary,validateSoundLibrary,updateSoundLibrary,type SoundLibrary,type SoundAsset} from "../../planner/src/sound-assets";
import {emptyGraphicLibrary,validateGraphicLibrary,updateGraphicLibrary,type GraphicLibrary,type GraphicChange} from "../../planner/src/graphic-library";
import {emptyEditLibrary,validateEditLibrary,createEditSequence,changeEditSequence,admitEditSource,type EditLibrary,type EditSequenceChange} from "../../planner/src/edit-library";
import {emptyEditAssemblyLibrary,createEditAssemblyProposal,reviseEditAssemblyProposal,acceptEditAssemblyProposal,type EditAssemblyLibrary,type EditAssemblyProposalInput,type EditAssemblyProposalRevision} from "../../planner/src/edit-assembly-proposals";
import {deriveEditAssemblyParent,validateProjectAssemblyLibrary,assertEditAssemblyCarriers,validateEditAssemblyExpected,type EditAssemblyCarrier,type EditAssemblyExpected,type EditAssemblyRevisionExpected} from "../../planner/src/edit-assembly-parent";
import {editFail,editId} from "../../planner/src/edit-timeline";
import {assertEditSourcePermission,assertEditOriginalPermission,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {validateEditBinding,type EditSourceBinding} from "../../planner/src/edit-jobs";
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
  graphicLibrary:GraphicLibrary;
}

export type ReviewDecision = "approved" | "changes_requested";

export interface AnimaticApproval {
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
  token: string;
  projectId: string;
  permission: "read" | "approve";
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
  graphicLibrary?:GraphicLibrary;
}

export interface PersistedState {
  version: 1;
  projects: PersistedProject[];
  reviewLinks: ReviewLink[];
  takenDown: string[];
  takedownLog: { projectId: string; at: string; reason: string }[];
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
    const state = readJsonFile<PersistedState>(this.statePath);
    if (!state) return;
    this.loadState(state);
  }

  private loadState(state: PersistedState): void {
    this.projects.clear();
    this.reviewLinks.clear();
    for (const project of state.projects ?? []) {
      for(const direction of project.directionHistory??[])for(const entry of direction.entries)assertFrameAnchorCatalog(entry.settings.frameAnchors,project.id,project.referenceAssets??[]);
      const editorial=validateEditLibrary(project.editLibrary??emptyEditLibrary(),project.id);
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
        assemblyLibrary:validateProjectAssemblyLibrary(project.assemblyLibrary??emptyEditAssemblyLibrary(),project.id,editorial),
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
    if(index>=0)for(const key of ["audioVoice","scenePerformances","libraryOrigin","costumePresets"] as const)if(characters[index]![key]!==undefined)Object.assign(character,{[key]:structuredClone(characters[index]![key])});
    if (index < 0) characters.push(character); else characters[index] = character;
    return this.saveCast(project, characters, now);
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
  private saveDirectionSnapshot(project:Project,entries:DirectionSnapshot["entries"],now:number,sceneCuts=currentDirection(project.id,project.directionHistory).sceneCuts):DirectionSnapshot {
    for(const entry of entries)assertFrameAnchorCatalog(entry.settings.frameAnchors,project.id,project.referenceAssets);
    const saved=directionSnapshot(project.id,currentDirection(project.id,project.directionHistory).version+1,entries,now,sceneCuts);
    project.directionHistory=[...project.directionHistory,saved].slice(-100);this.persist();return structuredClone(saved);
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
  createBoundReviewLink(token:string,permission:"read"|"approve",job:Job,binding:OutputBinding,now=Date.now()):ReviewLink|null{
    const project=this.authorize(token,now);if(!project)return null;assertSelectedOutput(job,project,binding,now);return this.createReviewLink(token,permission,now,binding);
  }
  createReviewLink(ownerToken: string, permission: "read" | "approve", now = Date.now(), binding?:OutputBinding): ReviewLink | null {
    const project = this.authorize(ownerToken, now);
    if (!project) return null;
    const token = mintReviewToken(project.id, permission, now);
    const link: ReviewLink = { token, projectId: project.id, permission, views: 0, revoked: false, decision: null, decisionNote: null };
    if(binding)link.outputBinding=validateOutputBinding(binding);
    this.reviewLinks.set(token, link);
    this.persist();
    return link;
  }

  useReviewLink(token: string, now = Date.now()): { projectId: string; permission: "read" | "approve"; viewsRemaining: number;outputBinding?:OutputBinding } | null {
    this.reload();
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked) return null;
    if (link.views >= REVIEW_MAX_VIEWS) return null;
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review") return null;
    link.views += 1;
    this.persist();
    return { projectId: link.projectId, permission: link.permission, viewsRemaining: REVIEW_MAX_VIEWS - link.views,...(link.outputBinding?{outputBinding:structuredClone(link.outputBinding)}:{}) };
  }

  peekReviewLink(token: string, now = Date.now()): ReviewLink | null {
    this.reload();
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked || link.views >= REVIEW_MAX_VIEWS) return null;
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review") return null;
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

  submitReviewDecision(token: string, decision: ReviewDecision, note = "", now = Date.now(),job?:Job): boolean {
    this.reload();
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked || link.permission !== "approve" || link.views >= REVIEW_MAX_VIEWS) return false;
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review" || payload.permission !== "approve") return false;
    if(link.outputBinding)assertSelectedOutput(job,this.projects.get(link.projectId),link.outputBinding,now);
    link.views += 1;
    link.decision = decision;
    link.decisionNote = note.slice(0, 2000);
    this.persist();
    return true;
  }

  latestScript(token: string, now = Date.now()): string | null {
    return this.authorize(token, now)?.versions.latest()?.text ?? null;
  }

  takedown(projectId: string, reason: string, now = Date.now()): boolean {
    this.reload();
    if (!this.projects.has(projectId) || this.takenDown.has(projectId)) return false;
    this.takenDown.add(projectId);
    this.projects.delete(projectId);
    this.takedownLog.push({ projectId, at: new Date(now).toISOString(), reason });
    this.persist();
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
