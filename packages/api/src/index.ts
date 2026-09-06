import {shotTakeShots,validateShotTakes,assertTakeCatalog,type ShotTakePlan} from "../../planner/src/takes";
import { REVIEW_MAX_VIEWS, mintProjectToken, mintReviewToken, verifyToken } from "./tokens";
import { parseFountain, VersionStore, type ScriptVersion } from "../../parser/src/index";
import { readJsonFile, writeJsonFile } from "./persist";
import { CastingConflict, characterRecord, castingMatches, castingSnapshot, currentCasting, type CastingSnapshot } from "../../planner/src/casting";
import { MAX_REFERENCE_ASSETS, validateReference, type ReferenceAsset } from "../../planner/src/references";
import {assertFrameAnchorCatalog} from "../../planner/src/frame-anchors";
import { characterSheetShots, type CharacterSheetPlan } from "../../planner/src/sheets";
export interface ReferenceBatchOptions {expectedScriptVersion?:number;replaceExisting?:boolean;sheet?:CharacterSheetPlan}
import { ActorShareUnavailable, assertShareable, createActorShare, importedActor, MAX_ACTOR_SHARES, validateActorShare, type ActorShare } from "../../planner/src/actor-library";
import { verifyActorToken } from "./actor-token";
import { contentHash } from "../../generator/src/capabilities";
import {planShots} from "../../planner/src/index";
import {currentDirection,directionEntry,directionMatches,directionSnapshot,DirectionConflict,validateDirection,type DirectionSnapshot} from "../../planner/src/direction";

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
        versions: VersionStore.hydrate(project.versions ?? []),
      });
    }
    for (const link of state.reviewLinks ?? []) this.reviewLinks.set(link.token, link);
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
    });
    this.persist();
    return { projectId: id, token: mintProjectToken(id, now), expiresAt: new Date(now + 72 * 3600 * 1000).toISOString() };
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
    if(index>=0)for(const key of ["libraryOrigin","costumePresets"] as const)if(characters[index]![key]!==undefined)Object.assign(character,{[key]:structuredClone(characters[index]![key])});
    if (index < 0) characters.push(character); else characters[index] = character;
    return this.saveCast(project, characters, now);
  }
  private directionProject(token:string,expectedVersion:number,now:number):Project|null {
    const project=this.authorize(token,now);if(!project||Date.parse(project.deleteAfter)<=now)return null;
    if(!Number.isSafeInteger(expectedVersion)||currentDirection(project.id,project.directionHistory).version!==expectedVersion)throw new DirectionConflict("The shot directions changed. Reload before saving.");
    return project;
  }
  private saveDirectionSnapshot(project:Project,entries:DirectionSnapshot["entries"],now:number):DirectionSnapshot {
    for(const entry of entries)assertFrameAnchorCatalog(entry.settings.frameAnchors,project.id,project.referenceAssets);
    const saved=directionSnapshot(project.id,currentDirection(project.id,project.directionHistory).version+1,entries,now);
    project.directionHistory=[...project.directionHistory,saved].slice(-100);this.persist();return structuredClone(saved);
  }
  saveShotDirection(token:string,shotId:string,input:unknown,expectedVersion:number,expectedScriptVersion:number,sourceHash:string,maxShots=24,now=Date.now()):DirectionSnapshot|null {
    const project=this.directionProject(token,expectedVersion,now);if(!project)return null;
    const script=project.versions.latest();if(!script||script.version!==expectedScriptVersion)throw new DirectionConflict("The screenplay changed. Reload and review this shot before saving its direction.");
    if(![24,60].includes(maxShots))throw new Error("Choose the 24-shot or 60-shot planning limit.");
    const shot=planShots(parseFountain(script.text),7000,maxShots).find(value=>value.id===shotId);if(!shot)throw new DirectionConflict("This shot is no longer in the current screenplay plan.");
    const entry=directionEntry(shot,input);if(sourceHash!==entry.sourceHash)throw new DirectionConflict("The source shot changed. Reload and review it before saving.");
    const current=currentDirection(project.id,project.directionHistory);return this.saveDirectionSnapshot(project,[...current.entries.filter(value=>value.source.id!==shotId),entry],now);
  }
  storeFrameAnchorAsset(token:string,reference:ReferenceAsset,expectedVersion:number,expectedScriptVersion:number,maxShots=24,now=Date.now()):ReferenceAsset|null {
    const project=this.directionProject(token,expectedVersion,now);if(!project)return null;
    const asset=validateReference(reference,project.id),source=asset.source;if(source?.kind!=="shot-anchor")throw new Error("Use a shot anchor upload.");
    const script=project.versions.latest();if(!script||script.version!==expectedScriptVersion)throw new DirectionConflict("The screenplay changed. Reload before adding an anchor image.");
    if(![24,60].includes(maxShots))throw new Error("Choose the 24-shot or 60-shot planning limit.");
    const shot=planShots(parseFountain(script.text),7000,maxShots).find(value=>value.id===source.shotId);
    if(!shot||directionEntry(shot,{}).sourceHash!==source.sourceHash)throw new DirectionConflict("The source shot changed. Reload before adding an anchor image.");
    if(project.referenceAssets.length>=MAX_REFERENCE_ASSETS)throw new Error("This project has reached its historical image limit.");
    if(project.referenceAssets.some(value=>value.id===asset.id))throw new Error("This image is already stored.");
    project.referenceAssets.push(asset);this.persist();return structuredClone(asset);
  }
  adoptShotTake(token:string,input:ShotTakePlan,takeId:string,expectedVersion:number,expectedScriptVersion:number,now=Date.now()):DirectionSnapshot|null {
    const project=this.directionProject(token,expectedVersion,now);if(!project)return null;
    const plan=validateShotTakes(input),script=project.versions.latest();
    if(plan.projectId!==project.id||!script||script.version!==expectedScriptVersion||script.version!==plan.scriptVersion)throw new DirectionConflict("The source screenplay changed. Generate new takes before adopting.");
    const base=plan.directionVersion===0?directionSnapshot(project.id,0,[],0):project.directionHistory.find(d=>d.version===plan.directionVersion&&d.revision===plan.directionRevision);
    if(!base)throw new DirectionConflict("The take group's base direction is no longer retained. Generate a new group.");
    shotTakeShots(plan,currentCasting(project.id,project.castingHistory),parseFountain(script.text),base,script.version,now);assertTakeCatalog(plan,project.referenceAssets);
    const take=plan.takes.find(t=>t.id===takeId);if(!take)throw new Error("Choose one of this group's completed takes.");
    const shot=planShots(parseFountain(script.text),7000,plan.maxShots).find(s=>s.id===plan.source.id)!;
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
    if(!saved)throw new Error("Choose an available direction version.");return this.saveDirectionSnapshot(project,saved.entries,now);
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

  createReviewLink(ownerToken: string, permission: "read" | "approve", now = Date.now()): ReviewLink | null {
    const project = this.authorize(ownerToken, now);
    if (!project) return null;
    const token = mintReviewToken(project.id, permission, now);
    const link: ReviewLink = { token, projectId: project.id, permission, views: 0, revoked: false, decision: null, decisionNote: null };
    this.reviewLinks.set(token, link);
    this.persist();
    return link;
  }

  useReviewLink(token: string, now = Date.now()): { projectId: string; permission: "read" | "approve"; viewsRemaining: number } | null {
    this.reload();
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked) return null;
    if (link.views >= REVIEW_MAX_VIEWS) return null;
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review") return null;
    link.views += 1;
    this.persist();
    return { projectId: link.projectId, permission: link.permission, viewsRemaining: REVIEW_MAX_VIEWS - link.views };
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

  submitReviewDecision(token: string, decision: ReviewDecision, note = "", now = Date.now()): boolean {
    this.reload();
    const link = this.reviewLinks.get(token);
    if (!link || link.revoked || link.permission !== "approve" || link.views >= REVIEW_MAX_VIEWS) return false;
    const payload = verifyToken(token, now);
    if (!payload || payload.kind !== "review" || payload.permission !== "approve") return false;
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
