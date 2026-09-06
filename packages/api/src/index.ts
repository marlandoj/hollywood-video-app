import { REVIEW_MAX_VIEWS, mintProjectToken, mintReviewToken, verifyToken } from "./tokens";
import { parseFountain, VersionStore, type ScriptVersion } from "../../parser/src/index";
import { readJsonFile, writeJsonFile } from "./persist";
import { CastingConflict, characterRecord, castingMatches, castingSnapshot, currentCasting, type CastingSnapshot } from "../../planner/src/casting";
import { MAX_REFERENCE_ASSETS, validateReference, type ReferenceAsset } from "../../planner/src/references";

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
}

export type ReviewDecision = "approved" | "changes_requested";

export interface AnimaticApproval {
  animaticJobId: string;
  scriptVersion: number;
  decision: ReviewDecision;
  note: string;
  at: string;
  castingVersion?: number;
  castingRevision?: string;
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
      this.projects.set(project.id, {
        id: project.id,
        createdAt: project.createdAt,
        deleteAfter: project.deleteAfter,
        operatorExtensions: project.operatorExtensions ?? [],
        rightsAttestedAt: project.rightsAttestedAt ?? null,
        animaticApprovals: project.animaticApprovals ?? [],
        castingHistory: structuredClone(project.castingHistory ?? []),
        referenceAssets: (project.referenceAssets ?? []).map(asset => validateReference(asset,project.id)),
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
    if (index < 0) characters.push(character); else characters[index] = character;
    return this.saveCast(project, characters, now);
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
  addCharacterReference(token: string, id: string, reference: ReferenceAsset, expectedVersion: number, now = Date.now()): CastingSnapshot | null {
    const project = this.castProject(token,expectedVersion,now);if (!project) return null;
    const asset = validateReference(reference,project.id), characters = currentCasting(project.id,project.castingHistory).characters;
    const character = characters.find(character => character.id === id);
    if (!character) throw new Error("Save the character before adding a reference.");
    if ((character.references?.length ?? 0) >= 4) throw new Error("A character supports up to four reference images.");
    if (project.referenceAssets.length >= MAX_REFERENCE_ASSETS) throw new Error("This project has reached its 96-image reference limit.");
    if (project.referenceAssets.some(value => value.id === asset.id)) throw new Error("This reference is already stored.");
    character.references = [...character.references ?? [],asset];
    const next = castingSnapshot(project.id,currentCasting(project.id,project.castingHistory).version + 1,characters,now);
    project.referenceAssets.push(asset);project.castingHistory.push(next);project.castingHistory = project.castingHistory.slice(-100);
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
  ): AnimaticApproval | null {
    this.reload();
    const project = this.projects.get(projectId);
    if (!project) return null;
    if (expectedCasting && !castingMatches(expectedCasting, currentCasting(projectId, project.castingHistory))) return null;
    const approval: AnimaticApproval = {
      animaticJobId,
      scriptVersion,
      decision,
      note: note.slice(0, 2000),
      at: new Date(now).toISOString(),
      ...(expectedCasting ? {castingVersion: expectedCasting.version, castingRevision: expectedCasting.revision} : {}),
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
