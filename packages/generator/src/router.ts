import { gateOrThrow } from "../../safety/src/index";
import { compareQuality, qualityOf, routeQuality, validateRoutingQuality, type RouteQuality, type RoutingQuality } from "./quality-routing";
import { contentHash, matchCapability, validateCapability, videoRequirements, ROUTING_STRATEGIES, type CapabilityMatch, type CapabilitySnapshot, type RejectionReason, type RoutingStrategy, type ShotRequirements } from "./capabilities";
import { FailoverGenerator, sunkCostsOf, type CostRecord, type GenParams, type ProviderAdapter, type VideoClip } from "./index";
// The leaf module, deliberately not ../../observability/src/index: that one pulls the
// OpenTelemetry SDK and two OTLP exporters into every generator test's module graph.
import { PROVIDER_KINDS, type ProviderKind } from "../../observability/src/provider-kinds";

export interface HealthObservation {scope: "worker-process"; state: "unknown" | "closed" | "open" | "half-open"; probeInFlight: boolean; samples: number; latencyMs: number | null; observedAt: string | null}
interface HealthEntry {failures: number; openUntil: number; probe: boolean; samples: number; latencyMs: number | null; observedAt: number; outcome: "success" | "error" | null}
/** What the worker knows about one configured pool slot before it asks for that slot's circuit state. */
export interface HealthPoolRef {stage: string; provider: string; id: string | null; key: string}
export interface HealthSummaryRow {
  stage: "animatic" | "final" | "character-sheet"; provider: ProviderKind; id: string | null;
  state: HealthObservation["state"]; consecutiveFailures: number; samples: number; latencyMs: number | null;
  lastOutcome: "success" | "error" | null; observedAt: string | null;
}
const HEALTH_STAGES = ["animatic", "final", "character-sheet"];
const HEALTH_PROVIDERS: readonly string[] = PROVIDER_KINDS;
/** The array this module actually filters on, so a test can assert it is the one definition and not a copy. */
export function healthProviderKinds(): readonly string[] {return HEALTH_PROVIDERS;}
const HEALTH_ID = /^[A-Za-z0-9_.:/-]{1,80}$/;
export class ProviderHealth {
  private readonly entries = new Map<string, HealthEntry>();
  constructor(private readonly now: () => number = Date.now) {}
  /** A publishable view of this worker process's circuits; it reads the same entries and expiry as `observation()`. */
  summary(pools: HealthPoolRef[]): HealthSummaryRow[] {
    const current = this.now(), rows: HealthSummaryRow[] = [];
    for (const pool of pools.slice(0, 24)) {
      if (!HEALTH_STAGES.includes(pool.stage) || !HEALTH_PROVIDERS.includes(pool.provider)) continue;
      const value = this.entries.get(pool.key), live = value !== undefined && (value.probe || current - value.observedAt <= 600_000);
      rows.push({stage: pool.stage as HealthSummaryRow["stage"], provider: pool.provider as HealthSummaryRow["provider"],
        id: pool.id && HEALTH_ID.test(pool.id) && !pool.id.includes("://") ? pool.id : null,
        state: !live ? "unknown" : value.openUntil > current ? "open" : value.openUntil ? "half-open" : "closed",
        consecutiveFailures: live ? value.failures : 0, samples: live ? value.samples : 0,
        latencyMs: live && value.samples >= 3 ? value.latencyMs : null,
        lastOutcome: live ? value.outcome : null, observedAt: live ? new Date(value.observedAt).toISOString() : null});
    }
    return rows;
  }
  observation(key: string): HealthObservation {
    const value = this.entries.get(key), current = this.now();
    if (!value || (!value.probe && current - value.observedAt > 600_000)) return {scope: "worker-process", state: "unknown", probeInFlight: false, samples: 0, latencyMs: null, observedAt: null};
    return {scope: "worker-process", state: value.openUntil > current ? "open" : value.openUntil ? "half-open" : "closed", samples: value.samples,
      probeInFlight: value.probe, latencyMs: value.samples >= 3 ? value.latencyMs : null, observedAt: new Date(value.observedAt).toISOString()};
  }
  acquire(key: string): boolean {
    const state = this.entries.get(key);
    if (state?.probe) return false;
    if (!state || this.now() - state.observedAt > 600_000) return true;
    if (state.openUntil > this.now() || state.probe) return false;
    if (state.openUntil) state.probe = true;
    return true;
  }
  release(key: string) {const state = this.entries.get(key); if (state) state.probe = false;}
  record(key: string, succeeded: boolean, durationMs: number) {
    const now = this.now(), old = this.entries.get(key);
    const value: HealthEntry = old && now - old.observedAt <= 600_000 ? old : {failures: 0, openUntil: 0, probe: false, samples: 0, latencyMs: null, observedAt: now, outcome: null};
    value.probe = false; value.observedAt = now; value.outcome = succeeded ? "success" : "error";
    if (succeeded) {
      value.failures = 0; value.openUntil = 0; value.samples++;
      value.latencyMs = Math.round(value.latencyMs === null ? Math.max(0, durationMs) : value.latencyMs * .8 + Math.max(0, durationMs) * .2);
    } else {value.failures++; if (value.failures >= 3 || value.openUntil) value.openUntil = now + 30_000;}
    if (!this.entries.has(key) && this.entries.size >= 64) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, value);
  }
}
export interface RouteCandidate extends CapabilityMatch {id: string; provider: string; model: string; capabilityRevision: string; priceVersion: string; health: HealthObservation}
export interface RouteDecision {
  schema: "hv-route-decision/1"; id: string; at: string; shotId: string; seed: number; planRevision: string | null;
  strategy: RoutingStrategy; requirements: ShotRequirements; candidates: RouteCandidate[]; selectedId: string | null;
  /** Only on a `quality` decision: the results file's digest, each candidate's measured score (null when unmeasured) and why, and the selected one's. */
  quality?: RouteQuality;
}
/** Private worker evidence, separate from VideoClip and public media manifests. */
export interface RouteRanking {
  schema:"hv-route-ranking/1";at:string;shotId:string;seed:number;planRevision:string|null;
  strategy:RoutingStrategy;requirements:ShotRequirements;budget:number;
  candidates:{index:number;id:string;capabilityRevision:string;estimateUsd:number|null;health:HealthObservation}[];
  orderedIds:string[];revision:string;
}
export interface RenderRoute {
  schema: "hv-render-route/1"; planRevision: string | null; decisionIds: string[]; strategy: RoutingStrategy;
  requirements: ShotRequirements; selectedCapability: CapabilitySnapshot; adaptations: string[];
}
export class RoutingError extends Error {
  constructor(readonly reasons: RejectionReason[]) {super("No configured provider meets this shot's requirements: " + [...new Set(reasons)].join(", ") + "."); this.name = "RoutingError";}
}
export interface RouterOptions {
  candidates: {id: string; adapter: ProviderAdapter}[]; strategy?: RoutingStrategy; maxAttemptUsd: number; planRevision?: string;
  /** The admitted plan's quality block; required by, and only accepted with, the `quality` strategy. */
  quality?: RoutingQuality;
  timeoutMs?: number; health?: ProviderHealth; now?: () => number; availableUsd?: () => Promise<number>;
  onDecision: (decision: RouteDecision) => Promise<void>;
  /** Synchronous capture of the initial rank, before any later budget/health refresh. */
  onRanking?: (ranking:RouteRanking) => void;
}
const stopped = (error: unknown) => ["SafetyRefusal", "BudgetError", "LeaseError", "AbortError", "RoutingError", "ShotDurationError", "FramingError","FrameAnchorError","PerformanceError","PromptLengthError"].includes((error as Error)?.name);
function attachCosts(error: unknown, prior: CostRecord[]): Error {
  const value = error instanceof Error ? error : new Error("Provider generation failed.");
  return Object.assign(value, {sunkCosts: [...prior, ...sunkCostsOf(error)]});
}

/** Matches capabilities before dispatch, then uses the same accounted attempt path as legacy failover. */
export class RoutedGenerator {
  private readonly now: () => number;
  private readonly health: ProviderHealth;
  private readonly executor: FailoverGenerator;
  private readonly candidates: {id: string; adapter: ProviderAdapter; snapshot: CapabilitySnapshot; key: string}[];
  private readonly quality: RoutingQuality | undefined;
  constructor(private readonly options: RouterOptions) {
    if (!Number.isFinite(options.maxAttemptUsd) || options.maxAttemptUsd < 0 || options.maxAttemptUsd > 1e6
      || !(ROUTING_STRATEGIES as readonly string[]).includes(options.strategy ?? "configured")
      || (options.strategy === "quality") !== (options.quality !== undefined)) throw new Error("Invalid routing policy.");
    this.quality = options.quality === undefined ? undefined : validateRoutingQuality(options.quality);
    if (!options.candidates.length || (options.candidates.length > 8 && !(options.candidates.length===9&&options.candidates.some(value=>value.id==="anchor-storyboard"))) || new Set(options.candidates.map(value => value.id)).size !== options.candidates.length
      || options.candidates.some(value => !/^[A-Za-z0-9_.:/-]{1,200}$/.test(value.id))) throw new Error("Invalid provider registry.");
    this.now = options.now ?? Date.now; this.health = options.health ?? new ProviderHealth(this.now);
    this.candidates = options.candidates.map(value => {
      const snapshot = value.adapter.capabilities;
      if (!snapshot || snapshot.schema !== "hv-capability/1" || snapshot.adapter !== value.adapter.name || snapshot.model !== value.adapter.model) throw new Error("Registered providers must publish matching capabilities.");
      return {...value, snapshot: validateCapability(snapshot), key: snapshot.revision};
    });
    this.executor = new FailoverGenerator(this.candidates[0]!.adapter, this.candidates[0]!.adapter, options.timeoutMs ?? 30_000);
  }
  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip & {failedOver: boolean; sunkCosts: CostRecord[]}> {
    gateOrThrow(prompt); params.signal?.throwIfAborted();
    if (!Number.isSafeInteger(seed)) throw new Error("Render seed must be a safe integer.");
    const request = videoRequirements(params), strategy = this.options.strategy ?? "configured";
    let budget = this.options.maxAttemptUsd;
    const refreshBudget = async () => {budget = Math.min(this.options.maxAttemptUsd, this.options.availableUsd ? await this.options.availableUsd() : this.options.maxAttemptUsd);};
    await refreshBudget();
    const quality = this.quality;
    const ranked = this.candidates.map((candidate, index) => ({candidate, index, match: matchCapability(candidate.snapshot, request, budget), health: this.health.observation(candidate.key),
      score: quality ? qualityOf(quality, candidate.id, candidate.snapshot).score : null}));
    ranked.sort((a,b) => {
      if(request.frameAnchors?.mode==="prefer-native"){const priority=Number(a.candidate.snapshot.frameControlMode!=="native")-Number(b.candidate.snapshot.frameControlMode!=="native");if(priority)return priority;}
      if (strategy === "cost") return (a.match.estimateUsd ?? Infinity) - (b.match.estimateUsd ?? Infinity) || a.index - b.index;
      if (strategy === "latency") return (a.health.latencyMs ?? Infinity) - (b.health.latencyMs ?? Infinity) || a.index - b.index;
      if (strategy === "quality") return compareQuality(a, b);
      return a.index - b.index;
    });
    if(this.options.onRanking){
      const data={schema:"hv-route-ranking/1" as const,at:new Date(this.now()).toISOString(),shotId:params.shotId&&/^[A-Za-z0-9_.-]{1,80}$/.test(params.shotId)?params.shotId:"unspecified",seed,
        planRevision:this.options.planRevision??null,strategy,requirements:request,budget,
        candidates:ranked.map(({candidate,index,match,health})=>({index,id:candidate.id,capabilityRevision:candidate.snapshot.revision,estimateUsd:match.estimateUsd,health})).sort((a,b)=>a.index-b.index),orderedIds:ranked.map(({candidate})=>candidate.id)};
      this.options.onRanking(structuredClone({...data,revision:contentHash(data)}));
    }
    const costs: CostRecord[] = [], decisions: string[] = [];
    let lastError: unknown;
    const candidates = (acquiredId?: string): RouteCandidate[] => ranked.map(({candidate}) => {
      const match = matchCapability(candidate.snapshot, request, budget);
      const health = this.health.observation(candidate.key), blocked = health.state === "open" || (health.probeInFlight && acquiredId !== candidate.id);
      const changed = candidate.adapter.capabilities?.revision !== candidate.snapshot.revision || candidate.adapter.name !== candidate.snapshot.adapter || candidate.adapter.model !== candidate.snapshot.model;
      return {id: candidate.id, provider: candidate.adapter.name, model: candidate.adapter.model, capabilityRevision: candidate.snapshot.revision, priceVersion: candidate.snapshot.priceVersion,
        ...match, eligible: match.eligible && !blocked && !changed, reasons: [...match.reasons, ...(blocked ? ["circuit-open" as const] : []), ...(changed ? ["capability-changed" as const] : [])], health};
    });
    const persist = async (selectedId: string | null) => {
      const decision: RouteDecision = {schema: "hv-route-decision/1", id: crypto.randomUUID(), at: new Date(this.now()).toISOString(),
        shotId: params.shotId && /^[A-Za-z0-9_.-]{1,80}$/.test(params.shotId) ? params.shotId : "unspecified", seed,
        planRevision: this.options.planRevision ?? null, strategy, requirements: request, candidates: candidates(selectedId ?? undefined), selectedId,
        ...(quality ? {quality: routeQuality(quality, ranked.map(({candidate}) => candidate), selectedId)} : {})};
      await this.options.onDecision(decision); decisions.push(decision.id);
    };
    for (const {candidate} of ranked) {
      try {params.signal?.throwIfAborted(); await refreshBudget();} catch (error) {throw attachCosts(error, costs);}
      const match = candidates().find(value => value.id === candidate.id)!;
      if (!match.eligible || !this.health.acquire(candidate.key)) continue;
      try {await persist(candidate.id);} catch (error) {this.health.release(candidate.key); throw attachCosts(error, costs);}
      const start = this.now();
      try {
        let current: CapabilitySnapshot;
        try {current = validateCapability(candidate.adapter.capabilities!);} catch {throw new RoutingError(["capability-changed"]);}
        if (current.revision !== candidate.snapshot.revision) throw new RoutingError(["capability-changed"]);
        const clip = await this.executor.generateAttempt(candidate.adapter, prompt, seed, params, outPath);
        this.health.record(candidate.key, true, this.now() - start);
        return {...clip, failedOver: costs.length > 0 || decisions.length > 1, sunkCosts: [...costs, ...sunkCostsOf(clip)],
          routing: {schema: "hv-render-route/1", planRevision: this.options.planRevision ?? null, decisionIds: decisions, strategy, requirements: request,
            selectedCapability: candidate.snapshot, adaptations: [...match.adaptations,...(clip.framing?["digital-crop"]:[])]}};
      } catch (error) {
        this.health.release(candidate.key);
        if (params.signal?.aborted || stopped(error)) throw attachCosts(error, costs);
        this.health.record(candidate.key, false, this.now() - start); lastError = error; costs.push(...sunkCostsOf(error));
      }
    }
    if (lastError) {
      // Costs already include the final failed attempt; do not append that attempt twice.
      const error = lastError instanceof Error ? lastError : new Error("Provider generation failed.");
      throw Object.assign(error, {sunkCosts: costs});
    }
    await persist(null);
    throw new RoutingError(candidates().flatMap(candidate => candidate.reasons));
  }
}
