import {sourcePlan} from "../../planner/src/scene-cuts";
import {compileShotRenderRecipe,resolveShotRenderAttempt,type ShotDispatchParams} from "../../planner/src/shot-render-recipe";
import {createShotExecutionCapture,type ShotExecutionCaptureInput} from "../../planner/src/shot-execution-capture";
import {validateShotExecutionClips,validateJobExecutionCheckpoint,type ShotExecutionInventoryRow} from "../../planner/src/shot-execution-inventory";
import type {ShotExecutionEmission} from "../../planner/src/shot-execution-equivalence";
import {processDialogueJob} from "./dialogue-worker";
import {processSoundJob} from "./sound-worker";
import {processGraphicJob} from "./graphic-worker";
import {processEditJob} from "./edit-worker";
import {processEditAssemblyJob} from "./edit-assembly-worker";
import {processAudioJob} from "./audio-worker";
import {processLipSyncJob} from "./lipsync-worker";
import {configuredLipSyncPolicy,LipSyncError} from "../../planner/src/lipsync-policy";
import {SyncLipSyncProvider,LipSyncProviderError} from "../../generator/src/sync-lipsync";
import {PostgresLipSyncLedger} from "../../storage/src/lipsync-ledger";
import {configuredAudioPolicies} from "../../generator/src/audio-config";
import {AzureAudioProvider} from "../../generator/src/azure-audio";
import {CartesiaAudioProvider} from "../../generator/src/cartesia-audio";
import {PostgresAudioLedger} from "../../storage/src/audio-ledger";
import {generationStage,isTakeStage} from "../../planner/src/render-stage";
import {validateReusePlan,sourceRenderRecord,ShotReuseError} from "../../planner/src/shot-reuse";
import {validateLivingScriptJob,validateLivingScriptClips,assertLivingScriptPreviewApproval} from "../../planner/src/living-script-job-context";
import {assertLivingScriptGenerationCurrent} from "../../planner/src/living-script-jobs";
import {compileRetainedShotReuse} from "../../planner/src/retained-shot-reuse";
import {copyReusableClip,sealShotClip,verifySealedClip} from "./shot-reuse";
import {carryRoughCutDialogue} from "./final-dialogue";
import {sealCurrentFilmClip,verifyCurrentFilmClip,verifyCurrentFilmMedia} from "./current-film-media";
import {validateCurrentFilmJob,assertCurrentFilmHeldInputs,createCurrentFilmCheckpoint,validateCurrentFilmClips,createCurrentFilmOutput,assertCurrentFilmPreviewApproval,type CurrentFilmCheckpoint} from "../../planner/src/current-film-job-context";
import {assertCurrentFilmGenerationCurrent} from "../../planner/src/current-film-authority";
import {resolveCurrentFilmJob,type CurrentFilmJobV2} from "../../planner/src/current-film-jobs";
import {contentHash} from "../../generator/src/capabilities";
import {shotTakeShots} from "../../planner/src/takes";
import {exportShotTakes} from "./take-exports";
import {assertFrameAnchorCatalog} from "../../planner/src/frame-anchors";
import { StudioTelemetry, SpanHandle, failureCode, providerKind, telemetryFromEnv } from "../../observability/src/index";
import { StudioLogger, loggerFromEnv, quietLogger } from "../../observability/src/logs";
import { ProjectService, type Project } from "../../api/src/index";
import { assertCurrentCastPermission, castingMatches, castingSnapshot, currentCasting, directCast, validateCasting } from "../../planner/src/casting";
import {directionMatches,directionSnapshot,directShots,validateDirection} from "../../planner/src/direction";
import {PerformanceError} from "../../planner/src/performances";
import {ShotDurationError} from "../../generator/src/animatic";
import {FramingError} from "../../generator/src/framing";
import {FrameAnchorError} from "../../generator/src/frame-anchor-media";
import { assertSheetDispatch, characterSheetShots, SHEET_SIZE } from "../../planner/src/sheets";
import { composeCharacterSheet, fileSha256 } from "../../generator/src/sheet";
import { SpanKind } from "@opentelemetry/api";
import { objectClient, PostgresArtifactStore } from "../../storage/src/artifacts";
import { ReferenceBlobStore } from "../../storage/src/references";
import { StudioDatabase } from "../../storage/src/database";
import { PostgresJobStore } from "../../storage/src/jobs";
import { PostgresCostLedger } from "../../storage/src/ledger";
import { PostgresReviewQueue } from "../../storage/src/reviews";
import { PostgresWorkerRegistry } from "../../storage/src/workers";
import { mkdirSync, readdirSync } from "node:fs";
import {createHash} from "node:crypto";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { assembleAsync } from "../../assembler/src/index";
import {assertPicturePerformance} from "../../planner/src/picture-performance";
import {
  DEFAULT_FAL_MAX_WAIT_MS,
  DeterministicMockProvider,
  FailoverGenerator,
  repairLoop,
  checkContinuity,
  resolveProvider,
  resolveAnimaticProvider,
  RichAnimaticProvider,
  type CostRecord,
  type GenParams,
  type ProviderAdapter,
  type VideoClip,
} from "../../generator/src/index";
import { configuredPool, instantiateProviderPlan } from "../../generator/src/catalog";
import { matchCapability, videoRequirements } from "../../generator/src/capabilities";
import { ProviderHealth, RoutedGenerator,type RouteDecision,type RouteRanking } from "../../generator/src/router";
import { BudgetError, CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { attestRights, generateBible } from "../../planner/src/index";
import { parseFountain } from "../../parser/src/index";
import { SafetyRefusalError, checkShot } from "../../safety/src/index";
import { readJsonFile, writeJsonFile } from "./persist";
import { DEFAULT_LEASE_MS, DurableJobStore, LeaseError, TIERS, type Job } from "./index";

export interface WorkerOptions {
  queuePath?: string;
  artifactRoot?: string;
  pollMs?: number;
  ledgerPath?: string;
  reviewQueuePath?: string;
  workerId?: string;
  leaseMs?: number;
  telemetry?: StudioTelemetry;
  /** Structured log sink; defaults to `loggerFromEnv("worker", telemetry)`. */
  logger?: StudioLogger;
  /** Stop taking work after the current job finishes. */
  signal?: AbortSignal;
  onJobStarted?: (job: Job) => Promise<void>;
}

export interface WorkerContext {
  graphics?:{chromePath:string};
  lipSync?:{provider:Pick<SyncLipSyncProvider,"synthesize">;ledger:PostgresLipSyncLedger;policy:import("../../storage/src/lipsync-ledger").LipSyncPolicyLookup};
  audio?:{provider:Pick<import("../../generator/src/cartesia-audio").CartesiaAudioProvider,"synthesize">;ledger:import("../../storage/src/audio-ledger").PostgresAudioLedger;policy:import("../../storage/src/audio-ledger").AudioPolicyLookup};
  references?: Pick<ReferenceBlobStore,"read">;
  projects?: {peekProject(id: string): Project | null | Promise<Project | null>};
  artifacts?: PostgresArtifactStore;
  ledger: CostLedger | PostgresCostLedger;
  reviewQueue: OperatorReviewQueue | PostgresReviewQueue;
  primary?: ProviderAdapter;
  secondary?: ProviderAdapter;
  // Animatics are a pacing check the user reviews before paying for real
  // generation, so they render on this provider (the placeholder by default)
  // regardless of what primary/secondary are.
  animaticProvider?: ProviderAdapter;
  providerTimeoutMs?: number;
  providerHealth?: ProviderHealth;
  now?: () => number;
  workerId?: string;
  leaseMs?: number;
  telemetry?: StudioTelemetry;
  /** Structured log sink; callers that inject nothing are silent, like `telemetry`. */
  logger?: StudioLogger;
  /** Operator-assigned worker name (HV_WORKER_ID); the per-incarnation `workerId` is never logged. */
  workerName?: string;
  onJobStarted?: (job: Job) => Promise<void>;
}

const quietTelemetry=new StudioTelemetry({service:"worker",enabled:false});
const silentLogger=quietLogger("worker");
const ANIMATIC_SIZE = "640x360";

function clipManifestPath(outputDirectory: string): string {
  return `${outputDirectory}/clips/manifest.json`;
}

function loadCompletedClips(outputDirectory: string, upTo: number): VideoClip[] {
  if (upTo <= 0) return [];
  const clips = readJsonFile<VideoClip[]>(clipManifestPath(outputDirectory)) ?? [];
  return clips.slice(0, upTo);
}

/** Capture the actual provider boundary synchronously, before adapter code can mutate it.
 * Callbacks and private materialization paths never enter retained execution metadata. */
function executionEmission(prompt:string,seed:number,params:GenParams):ShotExecutionEmission {
  const callbacks=["signal","beforeAttempt","onAttemptCost","afterAttempt","onProviderRequest"];
  const {signal:_signal,beforeAttempt:_before,onAttemptCost:_cost,afterAttempt:_after,onProviderRequest:_request,referenceFrames,frameAnchors,...scalars}=params;
  const identity=(image:string)=>{
    if(!image.startsWith("data:image/png;base64,"))throw new Error("Execution capture requires the actual materialized PNG bytes.");
    const bytes=Buffer.from(image.slice("data:image/png;base64,".length),"base64");
    return {sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};
  };
  return structuredClone({prompt,seed,params:Object.fromEntries(Object.entries(scalars).filter(([,value])=>value!==undefined)) as ShotDispatchParams,
    undefinedKeys:Object.keys(params).filter(key=>!callbacks.includes(key)&&params[key as keyof GenParams]===undefined).sort(),
    referenceFrames:referenceFrames?.map(identity)??null,frameAnchors:frameAnchors?{mode:frameAnchors.mode,frames:frameAnchors.frames.map(frame=>({at:frame.at,...identity(frame.image)}))}:null});
}

export async function processNextJob(
  store: DurableJobStore | PostgresJobStore,
  artifactRoot: string,
  context: WorkerContext,
): Promise<Job | null> {
  const now = context.now ?? Date.now;
  const leaseMs = context.leaseMs ?? DEFAULT_LEASE_MS;
  const workerId = context.workerId ?? crypto.randomUUID();
  const job = await store.claimNext(now(), await context.ledger.fairShareWeights(now()), { workerId, leaseMs });
  if (!job) return null;
  const telemetry=context.telemetry ?? quietTelemetry;
  const logger=context.logger ?? silentLogger;
  const jobAttributes={"hv.project.id":job.projectId,"hv.job.id":job.id,"hv.stage":job.stage};
  const logFields={projectId:job.projectId,jobId:job.id,stage:job.stage,worker:context.workerName};
  return telemetry.run("job.process",jobAttributes,async jobSpan=>{
  logger.info("worker.job_started",logFields,jobSpan);
  const startedAt=performance.now();let failure: unknown;
  let attemptSpan: SpanHandle | undefined;

  const deadline = now() + job.timeoutMs;
  // A real provider can take minutes per shot (up to three attempts each) and
  // assembly of a long cut is not instant, so the lease is refreshed on a timer
  // while those steps run rather than only between shots.
  const jobAbort = new AbortController();
  const keepingLease = async <T>(step: () => Promise<T>): Promise<T> => {
    await store.heartbeat(job.id, workerId, now(), leaseMs);
    let pending: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (pending) return;
      pending = Promise.resolve().then(() => store.heartbeat(job.id, workerId, now(), leaseMs))
        .catch(error => { jobAbort.abort(error); })
        .finally(() => { pending = undefined; });
    }, Math.max(50, Math.floor(leaseMs / 3)));
    try {
      const result = await step();
      jobAbort.signal.throwIfAborted();
      return result;
    } finally {
      clearInterval(timer);
      await pending;
    }
  };
  const assertWithinDeadline = () => {
    if (now() > deadline) throw new Error(`job exceeded its ${Math.round(job.timeoutMs / 1000)}s timeout`);
  };
  let currentShotId = "";
  let attemptId = "", attemptCostIndex = 0, attemptEstimate = 0;
  let routeDecisionId: string | undefined;
  let shotCapUsd = job.costCapUsd;
  const chargeCost = async (cost: CostRecord): Promise<Job> => telemetry.run("accounting.record",
    {...jobAttributes,"hv.attempt.id":attemptId,"hv.cost_usd":cost.total_cost_usd},async()=>{
    const event = {...cost, eventId: attemptId + ":" + attemptCostIndex++, attemptId, routeDecisionId,
      at: new Date(now()).toISOString(), projectId: job.projectId, shotId: currentShotId, jobId: job.id, stage: job.stage};
    if (context.ledger instanceof PostgresCostLedger) {
      const updated = await context.ledger.recordForJob(event);
      if (!updated) throw new LeaseError(job.id, "not_running", null);
      return updated;
    }
    await context.ledger.record(event);
    const updated = await store.recordCost(job.id, workerId, cost, now());
    const shotSpent = context.ledger.all().filter(value => value.jobId === job.id && value.shotId === currentShotId).reduce((total, value) => total + value.total_cost_usd, 0);
    if (shotSpent > shotCapUsd + 1e-9 && updated.status === "running") return await store.cancel(job.id, workerId, "This shot exceeded its generation budget.", now());
    return updated;
  },attemptSpan?.carrier());

  let currentPlan:CurrentFilmJobV2|undefined;
  const assertPendingContext=async()=>{
    if(job.currentFilm){
      if(context.ledger instanceof PostgresCostLedger){await context.ledger.assertCurrentFilmContext(job,workerId,now());return;}
      const project=await context.projects?.peekProject(job.projectId);assertCurrentFilmGenerationCurrent(job.currentFilm,project,now());
      if(job.stage==="final")assertCurrentFilmPreviewApproval(job,job.animaticJobId?await store.get(job.animaticJobId):undefined,project?.animaticApprovals.filter(value=>value.animaticJobId===job.animaticJobId).at(-1),now());return;
    }
    if(!job.livingScript)return;
    if(context.ledger instanceof PostgresCostLedger){await context.ledger.assertLivingScriptContext(job,workerId,now());return;}
    const project=await context.projects?.peekProject(job.projectId),carrier=await store.get(job.livingScript.binding.owner.jobId);
    assertLivingScriptGenerationCurrent(job.livingScript,project,carrier,now());
    if(job.stage==="final")assertLivingScriptPreviewApproval(job,job.animaticJobId?await store.get(job.animaticJobId):undefined,project?.animaticApprovals.find(value=>value.animaticJobId===job.animaticJobId),now());
  };
  try {
    if(job.currentFilm)currentPlan=validateCurrentFilmJob(job);else validateLivingScriptJob(job);await assertPendingContext();
    if (context.onJobStarted) await keepingLease(() => context.onJobStarted!(job));
    const casting = currentPlan?currentPlan.target.state.casting.candidate!:job.casting ? validateCasting(job.casting, job.projectId) : castingSnapshot(job.projectId, 0, [], 0);
    const direction=job.direction?validateDirection(job.direction,job.projectId):directionSnapshot(job.projectId,0,[],0);
    await context.ledger.reserve(job.id, job.stage, job.budgetReservedUsd ?? job.costCapUsd, Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000));
    if (!job.rightsAttestedAt) throw new Error("rights attestation is required before generation");
    if(job.stage==="dialogue-replacement")return await keepingLease(()=>processDialogueJob(job,store,artifactRoot,context,workerId,leaseMs,jobAbort.signal,now,deadline));
    if(job.stage==="sound-mix")return await keepingLease(()=>processSoundJob(job,store,artifactRoot,context,workerId,leaseMs,jobAbort.signal,now,deadline));
    if(job.stage==="motion-graphic")return await keepingLease(()=>processGraphicJob(job,store,artifactRoot,context,workerId,leaseMs,jobAbort.signal,now,deadline));
    if(job.stage==="picture-edit")return await keepingLease(()=>processEditJob(job,store,artifactRoot,context,workerId,leaseMs,jobAbort.signal,now,deadline));
    if(job.stage==="assembly-edit")return await keepingLease(()=>processEditAssemblyJob(job,store,artifactRoot,context,workerId,leaseMs,jobAbort.signal,now,deadline));
    if(job.stage==="audio-take")return await keepingLease(()=>processAudioJob(job,store,artifactRoot,context,workerId,leaseMs,AbortSignal.any([jobAbort.signal,AbortSignal.timeout(Math.max(1,deadline-now()))])));
    if(job.stage==="lip-sync")return await keepingLease(()=>processLipSyncJob(job,store,artifactRoot,context,workerId,leaseMs,AbortSignal.any([jobAbort.signal,AbortSignal.timeout(Math.max(1,deadline-now()))])));
    const renderStage=generationStage(job.stage),takes=job.shotTakes;
    if(isTakeStage(job.stage)!==Boolean(takes)||(takes&&(!job.providerPlan||takes.maxShots!==TIERS[job.tier].maxShots||job.characterSheet)))throw new Error("The take group requires its own admitted generation plan.");
    let approvedAnimatic: Job | undefined;
    if (renderStage === "final"&&!job.livingScript&&!currentPlan) {
      if (!job.animaticApprovedAt) throw new Error("the animatic must be approved before final generation");
      const animatic = job.animaticJobId ? await store.get(job.animaticJobId) : undefined;
      approvedAnimatic = animatic;
      if(animatic?.livingScript||animatic?.currentFilm)throw new Error("A pending or canonical screenplay preview cannot approve an ordinary final film.");
      if (!animatic || animatic.projectId !== job.projectId || animatic.stage !== (takes?"take-preview":"animatic") || animatic.status !== "done") {
        throw new Error("final generation requires a finished animatic from the same project");
      }
      if(takes&&animatic.shotTakes?.revision!==takes.revision)throw new Error("Final takes require approval of the exact preview group.");
      if (animatic.scriptVersion !== job.scriptVersion) {
        throw new Error("the screenplay changed after the animatic rendered; approve a new animatic first");
      }
      if (!castingMatches(animatic.casting, casting)) throw new Error("The cast changed after the approved preview; render a new preview first.");
      if(!directionMatches(animatic.direction,direction))throw new Error("The shot directions changed after the approved preview; render a new preview first.");
    }

    const parsed = parseFountain(job.scriptText);
    if (parsed.rejected || parsed.scenes.length === 0) {
      throw new Error(parsed.rejectionReason ?? "screenplay contains no parseable scenes");
    }

    const sheet = job.stage === "character-sheet" ? job.characterSheet : undefined;
    if ((job.stage === "character-sheet") !== Boolean(job.characterSheet) || (sheet && !job.providerPlan)) throw new Error("The character sheet requires its admitted generation plan.");
    if(sheet&&job.direction)throw new Error("Character sheets cannot carry film shot directions.");
    const currentInputs=currentPlan?resolveCurrentFilmJob(currentPlan):undefined;
    const shots = currentInputs?currentInputs.shots:takes ? shotTakeShots(takes,casting,parsed,direction,job.scriptVersion,now()) : sheet ? characterSheetShots(sheet,casting,parsed,now()) : directShots(directCast(sourcePlan(parsed,direction,7000,TIERS[job.tier].maxShots), parsed, casting, now(),direction),direction);
    if(job.shotReuse)validateReusePlan(job.shotReuse,job,now());
    if (shots.length > TIERS[job.tier].maxShots) {
      throw new Error(`${job.tier} tier allows at most ${TIERS[job.tier].maxShots} shots`);
    }
    for (const shot of shots) {
      const safety = checkShot(shot);
      if (!safety.allowed) throw new SafetyRefusalError(safety);
    }

    attestRights(generateBible(job.projectId, parsed), job.rightsAttestedAt);

    const outputDirectory = resolve(artifactRoot, job.projectId, job.id);
    mkdirSync(outputDirectory, { recursive: true });

    const isAnimatic = renderStage !== "final";
    if (job.providerPlan && job.providerPlan.stage !== renderStage) throw new Error("Saved provider plan does not match the render stage.");
    const pinned = job.providerPlan ? instantiateProviderPlan(job.providerPlan) : undefined;
    const stageProvider = !pinned && isAnimatic ? (job.providerSpec ? resolveAnimaticProvider(job.providerSpec) : context.animaticProvider) : undefined;
    const primary = pinned?.[0]?.adapter ?? stageProvider ?? context.primary ?? new DeterministicMockProvider();
    const secondary = stageProvider ?? context.secondary ?? new DeterministicMockProvider();
    shotCapUsd = job.providerPlan?.maxShotUsd ?? (isAnimatic ? job.costCapUsd : Math.min(job.costCapUsd, Number(process.env.HV_COST_CAP_PER_SHOT_USD ?? 5)));
    const candidates = pinned?.map(value => ({id: value.entry.spec, adapter: value.adapter})) ?? [{id: "primary", adapter: primary}, {id: "secondary", adapter: secondary}];
    if(currentInputs&&(!pinned||currentInputs.slots.some(slot=>slot.recipe.providers.kind!=="pinned"||contentHash(slot.recipe.providers.richAnimatic)!==contentHash(candidates.map(value=>value.adapter instanceof RichAnimaticProvider)))))throw new Error("The actual provider classes differ from the admitted current-film recipes.");
    const captureFilm=Boolean(pinned&&!sheet&&!takes);
    let activeExecution:{ranking?:RouteRanking;routes:RouteDecision[];emissions:Map<number,ShotExecutionEmission>}|undefined;
    // Only fresh per-job pinned instances are intercepted. Preserve their prototype,
    // receiver, original return value and exceptions; injected/shared adapters stay intact.
    if(captureFilm)for(const [providerIndex,{adapter}]of candidates.entries()){
      const generate=adapter.generate;
      adapter.generate=function(this:ProviderAdapter,prompt,seed,params,path){
        activeExecution?.emissions.set(providerIndex,executionEmission(prompt,seed,params));
        return generate.call(this,prompt,seed,params,path);
      };
    }
    // Pre-registry jobs with injected third-party adapters retain their existing execution contract.
    // Every newly admitted job has a plan and must use the registry.
    const generator = candidates.every(value => value.adapter.capabilities) ? new RoutedGenerator({
      candidates, strategy: job.providerPlan?.strategy, planRevision: job.providerPlan?.revision, maxAttemptUsd: shotCapUsd,
      health: context.providerHealth, now, timeoutMs: context.providerTimeoutMs ?? 30_000,
      availableUsd: async () => await context.ledger.shotCapacity(job.id, currentShotId, shotCapUsd),
      ...(captureFilm?{onRanking:(ranking:RouteRanking)=>{if(activeExecution)activeExecution.ranking=ranking;}}:{}),
      onDecision: async decision => {
        await store.recordRouteDecision(job.id, workerId, decision, now());
        routeDecisionId = decision.selectedId ? decision.id : undefined;
        activeExecution?.routes.push(structuredClone(decision));
      },
    }) : new FailoverGenerator(primary, secondary, context.providerTimeoutMs ?? 30_000);

    const size = currentInputs?`${currentInputs.outputSize.width}x${currentInputs.outputSize.height}`:sheet ? SHEET_SIZE : isAnimatic ? ANIMATIC_SIZE : TIERS[job.tier].maxResolution;
    if (context.artifacts) await keepingLease(() => telemetry.run("media.restore",jobAttributes,()=>context.artifacts!.restoreCheckpoint(job, jobAbort.signal)));
    const resumeFrom = Math.min(job.checkpointShots, shots.length);
    const clips: VideoClip[] = loadCompletedClips(outputDirectory, resumeFrom);
    if((captureFilm||job.executionCheckpoints!==undefined)&&(resumeFrom!==job.checkpointShots||clips.length!==resumeFrom||job.checkpointFrame!==clips.reduce((total,clip)=>total+Math.round(clip.durationSec*30),0)))throw new Error("The execution checkpoint lost its exact clip prefix or frame count.");
    // Entire jobs with a genuinely historical unsealed prefix retain their old path.
    // Never manufacture a record or authenticated capture for that earlier execution.
    let executions:ShotExecutionInventoryRow[]|undefined;
    let currentCheckpoint:CurrentFilmCheckpoint|undefined;
    if(currentPlan){
      if(!captureFilm||resumeFrom!==job.checkpointShots||clips.length!==resumeFrom||job.checkpointFrame!==clips.reduce((sum,clip)=>sum+Math.round(clip.durationSec*30),0)||resumeFrom>0&&!job.currentFilmCheckpoint)throw new Error("The canonical film lost its complete private checkpoint.");
      currentCheckpoint=job.currentFilmCheckpoint?validateCurrentFilmClips(job,clips,job.currentFilmCheckpoint):createCurrentFilmCheckpoint(job,[]);
      // The freshly claimed checkpoint must have its authoritative routing journal
      // before any further provider dispatch; new rows are checked again when held.
      for(const row of currentCheckpoint.rows)for(const route of row.capture.routes){const stored=job.routeDecisions?.find(value=>value.id===route.id);if(!stored||contentHash(stored)!==contentHash(route))throw new Error("The current-film checkpoint lost its exact dispatch journal.");}
    }else if(job.executionCheckpoints!==undefined){
      if(!captureFilm||job.executionCheckpoints.length!==resumeFrom)throw new Error("The private execution checkpoint lost its complete admitted prefix.");
      // The freshly claimed prefix has an authoritative journal. Check it before
      // any additional inference; later incremental preflights use a stale job.
      executions=validateJobExecutionCheckpoint(job,validateShotExecutionClips(job,clips)!).inventory;
    }else if(captureFilm&&clips.every(clip=>clip.renderRecord)){
      executions=clips.map(clip=>({shotId:clip.renderRecord!.shotId,recordRevision:clip.renderRecord!.revision,capture:null,unavailableReason:clip.renderRecord!.reusedFrom?"reused-source":"legacy-checkpoint"}));
      validateShotExecutionClips(job,clips,executions);
    }
    validateLivingScriptClips(job,clips);
    if(job.livingScript&&(clips.length!==resumeFrom||job.checkpointFrame!==clips.reduce((total,clip)=>total+Math.round(clip.durationSec*30),0)))throw new Error("The pending screenplay checkpoint lost its exact clip prefix or frame count.");
    for(const [index,clip]of clips.entries()){assertPicturePerformance(clip.picturePerformance,shots[index]?.picturePerformance);if(currentInputs)await keepingLease(()=>verifyCurrentFilmClip(job,currentInputs.slots[index]!,clip,artifactRoot,jobAbort.signal));else if(clip.renderRecord||job.shotReuse)await keepingLease(()=>verifySealedClip(job,shots[index]!,clip,artifactRoot,jobAbort.signal));}
    // A legacy job interrupted after its final shot has no later shot checkpoint
    // at which to retain the explicit historical inventory before completion.
    if(executions&&job.executionCheckpoints===undefined&&resumeFrom===shots.length&&resumeFrom>0){
      if(context.artifacts)await keepingLease(()=>context.artifacts!.checkpoint(job,workerId,clips,job.checkpointFrame,leaseMs,jobAbort.signal,executions));
      else await store.checkpoint(job.id,workerId,resumeFrom,job.checkpointFrame,now(),leaseMs,validateShotExecutionClips(job,clips,executions));
    }
    const resumed = clips.length;
    const shotReviews: { shotId: string; score: number }[] = [];
    const degradedShots: string[] = [];
    let previous: VideoClip | null = clips.length ? clips[clips.length - 1]! : null;
    let frames = job.checkpointFrame;
    const validateReusePermission=async(shot:typeof shots[number])=>{
      if(context.ledger instanceof PostgresCostLedger)await context.ledger.assertReusePermission(job,workerId,shot,now());
      else {const current=await context.projects?.peekProject(job.projectId);if(!current||Date.parse(current.deleteAfter)<=now())throw new ShotReuseError("Current project permission is unavailable.");
        assertCurrentCastPermission(casting,currentCasting(job.projectId,current.castingHistory),shot.characterIds??[],shot.sceneIndex+1,now(),parsed.scenes[shot.sceneIndex]?.heading);assertFrameAnchorCatalog(shot.direction?.frameAnchors,job.projectId,current.referenceAssets);
      }
    };

    for (const [index, shot] of shots.entries()) {
      if (index < resumed) continue;
      currentShotId = shot.id;
      assertWithinDeadline();
      await store.heartbeat(job.id, workerId, now(), leaseMs);
      const reuse=job.shotReuse?.shots.find(record=>record.shotId===shot.id);
      if(reuse){
        const retained=job.livingScript?compileRetainedShotReuse(reuse,job.livingScript.binding):undefined;
        const validateReuseAccess=async()=>{
          if(retained)await assertPendingContext();else {const source=await store.get(reuse.jobId);if(!source)throw new ShotReuseError("The source job disappeared. Turn off reuse to render fresh shots.");sourceRenderRecord(source,reuse,now());}
          await validateReusePermission(shot);
        };
        await validateReuseAccess();const clip=await keepingLease(()=>copyReusableClip(reuse,job,artifactRoot,jobAbort.signal,context.artifacts,retained));await validateReuseAccess();
        const continuity=checkContinuity(shot.id,previous,clip);if(!continuity.passed){degradedShots.push(shot.id);shotReviews.push({shotId:shot.id,score:continuity.score});}
        clips.push(clip);previous=clip;frames+=Math.round(clip.durationSec*30);writeJsonFile(clipManifestPath(outputDirectory),clips);
        if(executions)executions.push({shotId:shot.id,recordRevision:clip.renderRecord!.revision,capture:null,unavailableReason:"reused-source"});
        validateLivingScriptClips(job,clips);
        if(context.artifacts)await keepingLease(()=>context.artifacts!.checkpoint(job,workerId,clips,frames,leaseMs,jobAbort.signal,executions));else await store.checkpoint(job.id,workerId,index+1,frames,now(),leaseMs,validateShotExecutionClips(job,clips,executions));
        continue;
      }
      const sceneHeading=currentInputs?.slots[index]?.heading??parsed.scenes[shot.sceneIndex]?.heading;
      const recipe=compileShotRenderRecipe({projectId:job.projectId,stage:renderStage,shot,...(sceneHeading!==undefined?{sceneHeading}:{}),outputSize:size,
        ...(job.providerPlan?{providerPlan:job.providerPlan,richAnimaticProviders:candidates.map(value=>value.adapter instanceof RichAnimaticProvider)}:
          {legacyProviders:candidates.map(({adapter})=>({adapter:adapter.name,model:adapter.model,richAnimatic:adapter instanceof RichAnimaticProvider,capability:adapter.capabilities??null}))})});
      if(currentInputs&&contentHash(recipe)!==contentHash(currentInputs.slots[index]!.recipe))throw new Error("The actual current-film dispatch differs from its admitted complete recipe.");
      const {durationSec,cameraMove}=recipe.dispatch.params;
      const referenceFrames = await keepingLease(async () => {
        if (!recipe.references.length) return undefined;
        if (!context.references) throw new Error("Character reference storage is unavailable.");
        return await Promise.all(recipe.references.map(async asset => "data:image/png;base64," + (await context.references!.read(asset)).toString("base64")));
      });
      const anchorRequest=recipe.anchors;
      const frameAnchors=anchorRequest?await keepingLease(async()=>{
        try{
          const current=context.ledger instanceof PostgresCostLedger?undefined:await context.projects?.peekProject(job.projectId);
          const catalog=context.ledger instanceof PostgresCostLedger?await context.ledger.frameAnchorCatalog(job.projectId,now()):current&&Date.parse(current.deleteAfter)>now()?current.referenceAssets:undefined;
          if(!catalog||!context.references)throw new FrameAnchorError("Current frame anchor storage is unavailable.");
          assertFrameAnchorCatalog(shot.direction?.frameAnchors,job.projectId,catalog);
          return {mode:anchorRequest.mode,frames:await Promise.all(anchorRequest.frames.map(async f=>({at:f.at,image:"data:image/png;base64,"+(await context.references!.read(f.asset)).toString("base64")})))};
        }catch(error){if(jobAbort.signal.aborted)throw jobAbort.signal.reason;throw new FrameAnchorError((error as Error).message);}
      }):undefined;
      let successfulExecution:ShotExecutionCaptureInput|undefined;
      const generated = await keepingLease(() => repairLoop(
        shot.id,
        sheet||takes ? null : previous,
        (attempt) => telemetry.run("provider.generate",jobAttributes,async()=>{
          const dispatch=resolveShotRenderAttempt(recipe,attempt),execution=executions||currentCheckpoint?{routes:[] as RouteDecision[],emissions:new Map<number,ShotExecutionEmission>(),ranking:undefined as RouteRanking|undefined}:undefined;
          activeExecution=execution;
          try{const clip=await generator.generate(
          dispatch.prompt,
          dispatch.seed,
          { ...dispatch.params,
            referenceFrames,frameAnchors,
            signal: jobAbort.signal,
            beforeAttempt: async (provider) => {
              if(!(context.ledger instanceof PostgresCostLedger))await assertPendingContext();
              if(frameAnchors && !(context.ledger instanceof PostgresCostLedger)){
                const current=await context.projects?.peekProject(job.projectId);
                if(!current||Date.parse(current.deleteAfter)<=now())throw new FrameAnchorError("Current frame anchor storage is unavailable.");
                try{assertFrameAnchorCatalog(shot.direction?.frameAnchors,job.projectId,current.referenceAssets);}catch(error){throw new FrameAnchorError((error as Error).message);}
              }
              if (!currentPlan&&!(context.ledger instanceof PostgresCostLedger) && shot.characterIds?.length) {
                const current = await context.projects?.peekProject(job.projectId);
                if (!current || Date.parse(current.deleteAfter) <= now()) throw new BudgetError("Current cast permissions are unavailable. Rendering is paused.");
                if(sheet)assertSheetDispatch(sheet,casting,currentCasting(job.projectId,current.castingHistory),shot.id,parsed,now());
                else assertCurrentCastPermission(casting, currentCasting(job.projectId, current.castingHistory), shot.characterIds, shot.sceneIndex + 1, now(), parsed.scenes[shot.sceneIndex]?.heading);
              }
              const estimate = provider.capabilities ? matchCapability(provider.capabilities, videoRequirements({performances:shot.performances,widthxheight: size, fps: 30, durationSec,
                referenceFrames,frameAnchors,framing:shot.direction?.framing,cameraPath:shot.direction?.cameraPath, ...(cameraMove?{cameraMove}:{}), routingRequirements: job.providerPlan?.requirements}), shotCapUsd).estimateUsd ?? Infinity : provider instanceof RichAnimaticProvider
                ? provider.estimateShotUsd({ seed: shot.seed, widthxheight: size })
                : provider.name === "fal" ? Number(process.env.HV_COST_CAP_PER_SHOT_USD ?? 5) : 0;
              attemptId = crypto.randomUUID(); attemptCostIndex = 0; attemptEstimate = estimate;
              attemptSpan=telemetry.start("provider.attempt",{...jobAttributes,"hv.attempt.id":attemptId,"hv.provider":providerKind(provider.name, provider.capabilities ? provider.capabilities.price.unit !== "free" : undefined)},undefined,SpanKind.CLIENT);
              await store.heartbeat(job.id, workerId, now(), leaseMs);
              if (context.ledger instanceof PostgresCostLedger) await context.ledger.beginAttempt({
                id: attemptId, projectId: job.projectId, jobId: job.id, shotId: shot.id, provider: provider.name,
                workerId, leaseVersion: job.leaseVersion!, estimateUsd: estimate, shotCapUsd, routeDecisionId, model: provider.model, capabilityRevision: provider.capabilities?.revision,
              }, now());
              else await context.ledger.assertCanSpend(job.id, estimate, {id: shot.id, capUsd: shotCapUsd});
              const dispatchedAttemptId = attemptId;
              const dispatchedSpan=attemptSpan;
              return {onProviderRequest: async receipt => {
                dispatchedSpan.attributes({"hv.provider.request_id":receipt.requestId});
                if (context.ledger instanceof PostgresCostLedger) {
                  try {await context.ledger.attachRequest(dispatchedAttemptId,workerId,job.leaseVersion!,receipt);}
                  catch {throw new BudgetError("Provider request tracking is temporarily unavailable; generation is paused.");}
                }
              }};
            },
            onAttemptCost: async cost => { await chargeCost(cost); },
            afterAttempt: async outcome => {
              try {
              if (context.ledger instanceof PostgresCostLedger) {
                const ambiguous = outcome.accountingError || (outcome.dispatched && outcome.error && attemptEstimate > 0
                  && outcome.costs.length === 0 && (outcome.error as Error).name !== "SafetyRefusal" && !(outcome.error instanceof ShotDurationError) && !(outcome.error instanceof FrameAnchorError) && !(outcome.error instanceof PerformanceError));
                await context.ledger.finishAttempt(attemptId, ambiguous ? "unknown" : outcome.error ? "failed" : "succeeded");
              }
              const priced = await store.get(job.id);
              if (priced?.status === "cancelled") throw new BudgetError(priced.cancelReason ?? "generation budget exceeded");
              } catch(error) {attemptSpan?.fail(failureCode(error));throw error;}
              finally {
                if(outcome.error || outcome.accountingError)attemptSpan?.fail("provider");
                attemptSpan?.end();attemptSpan=undefined;
              }
            },
          },
          `${outputDirectory}/clips/${shot.id}-a${attempt}.mp4`,
          );
          if(execution){
            const ids=clip.routing?.decisionIds,routes=ids?.map(id=>execution.routes.find(route=>route.id===id));
            if(!execution.ranking||!routes?.length||routes.some(route=>!route))throw new Error("The successful execution lost its actual routing observations.");
            const checkedRoutes=routes as RouteDecision[],providerIndex=candidates.findIndex(value=>value.id===checkedRoutes.at(-1)!.selectedId),emission=execution.emissions.get(providerIndex);
            if(!emission)throw new Error("The successful execution lost its actual provider emission.");
            successfulExecution={observation:{recipe,attempt,providerIndex,fallbackIndex:checkedRoutes.length-1,emission},ranking:execution.ranking,routes:checkedRoutes};
          }
          return clip;
          }finally{if(activeExecution===execution)activeExecution=undefined;}
        }),
        shotReviews,
      ));
      if(shot.picturePerformance)generated.clip.picturePerformance=structuredClone(shot.picturePerformance);
      if(currentInputs)generated.clip=await keepingLease(()=>sealCurrentFilmClip(job,currentInputs.slots[index]!,generated.clip,artifactRoot,jobAbort.signal));
      else if(!sheet&&!takes&&job.providerPlan){
        // HV-022-01: a silent final shot keeps the approved rough cut's verified dialogue.
        if(job.stage==="final"&&!job.livingScript)generated.clip=await keepingLease(()=>carryRoughCutDialogue(job,approvedAnimatic,shot,generated.clip,artifactRoot,jobAbort.signal,context.artifacts));
        generated.clip=await keepingLease(()=>sealShotClip(job,shot,generated.clip,artifactRoot,jobAbort.signal));
      }
      if(currentCheckpoint){
        if(!successfulExecution||!generated.clip.renderRecord)throw new Error("The current film requires each actual fresh execution capture.");
        const slot=currentInputs!.slots[index]!,record=generated.clip.renderRecord;
        currentCheckpoint=createCurrentFilmCheckpoint(job,[...currentCheckpoint.rows,{ordinal:index,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,record,capture:createShotExecutionCapture(record,successfulExecution)}]);
      }
      if(executions){
        if(!successfulExecution||!generated.clip.renderRecord)throw new Error("The new original execution requires its complete private capture.");
        const record=generated.clip.renderRecord;
        executions.push({shotId:shot.id,recordRevision:record.revision,capture:createShotExecutionCapture(record,successfulExecution),unavailableReason:null});
      }
      clips.push(generated.clip);
      previous = generated.clip;
      if (generated.outcome.status === "degraded") degradedShots.push(shot.id);


      frames += Math.round(generated.clip.durationSec * 30);
      validateLivingScriptClips(job,clips);await assertPendingContext();
      if(currentCheckpoint)validateCurrentFilmClips(job,clips,currentCheckpoint);
      writeJsonFile(clipManifestPath(outputDirectory), clips);
      if (context.artifacts) await keepingLease(() => telemetry.run("media.checkpoint",{...jobAttributes,"hv.checkpoint.shots":index+1},()=>context.artifacts!.checkpoint(job, workerId, clips, frames, leaseMs, jobAbort.signal,currentCheckpoint??executions)));
      else await telemetry.run("media.checkpoint",{...jobAttributes,"hv.checkpoint.shots":index+1},()=>store.checkpoint(job.id, workerId, index + 1, frames, now(), leaseMs,currentCheckpoint??validateShotExecutionClips(job,clips,executions)));
    }

    for (const flagged of shotReviews) {
      await context.reviewQueue.flag(flagged.shotId, job.projectId, flagged.score);
    }
    for(const [index,clip]of clips.entries())if(clip.renderRecord?.reusedFrom)await validateReusePermission(shots[index]!);

    assertWithinDeadline();
    await assertPendingContext();
    await store.heartbeat(job.id, workerId, now(), leaseMs);
    if(takes){
      const exported=await keepingLease(()=>telemetry.run("media.assemble",jobAttributes,()=>exportShotTakes(job,clips,shots,artifactRoot,outputDirectory,size,casting,async id=>await context.ledger.shotSpend(job.id,id),new Date(now()).toISOString(),jobAbort.signal)));
      await store.heartbeat(job.id,workerId,now(),leaseMs);
      if(context.artifacts)await keepingLease(()=>telemetry.run("media.publish",{...jobAttributes,"hv.media.files":exported.paths.length},()=>context.artifacts!.publishExport(job,workerId,exported.paths,jobAbort.signal)));
      return await store.complete(job.id,workerId,exported.output,now());
    }
    const exportResult = await keepingLease(() => telemetry.run("media.assemble",jobAttributes,()=>assembleAsync(
      clips,
      shots,
      outputDirectory,
      { assembledAt: new Date(now()).toISOString(), crossfadeSec: isAnimatic ? 0 : 0.5, fps: 30, size, projectId: job.projectId, signal: jobAbort.signal, casting,...(job.direction?{direction}: {}),...(currentCheckpoint?{currentFilm:{jobId:job.id,jobPlanRevision:currentCheckpoint.jobPlanRevision,materializationRevision:currentCheckpoint.materializationRevision,rows:currentCheckpoint.rows.map(({capture:_capture,...row})=>row)}}:{}) },
      degradedShots,
    )));
    const sheetPath = sheet ? resolve(outputDirectory,"character-sheet.png") : undefined;
    if(sheet && sheetPath) {
      const sha256=await keepingLease(()=>composeCharacterSheet(clips,sheet,sheetPath,jobAbort.signal));
      const manifest=readJsonFile<Record<string,unknown>>(exportResult.manifestPath)!;
      writeJsonFile(exportResult.manifestPath,{...manifest,characterSheet:{...sheet,sheetSha256:sha256,views:sheet.views.map((view,index)=>({...view,sha256:fileSha256(clips[index]!.posterPath!)}))}});
    }
    const relative = (path: string) => path.slice(resolve(artifactRoot).length + 1).replaceAll("\\", "/");
    await assertPendingContext();
    const completedOutput:NonNullable<Job["output"]>={
      mp4Path: relative(exportResult.mp4Path),
      hlsPlaylistPath: relative(exportResult.hlsPlaylistPath),
      captionsPath: relative(exportResult.vttPath),
      manifestPath: relative(exportResult.manifestPath),
      ...(currentCheckpoint?{currentFilm:createCurrentFilmOutput(job,currentCheckpoint,exportResult.currentFilmClock!)}:{}),
      ...(!currentCheckpoint&&clips.length&&clips.every(clip=>clip.renderRecord)?{shotRenders:clips.map(clip=>clip.renderRecord!)}:{}),
      ...(executions?{shotExecutions:executions}:{}),
      ...(clips.some(c=>c.picturePerformance)?{picturePerformances:clips.flatMap((c,i)=>c.picturePerformance?[{shotId:shots[i]!.id,intent:c.picturePerformance}]:[])}:{}),
      ...(sheetPath ? {sheetPath:relative(sheetPath)} : {}),
      ...(clips.some(clip=>clip.cameraPathControl)?{cameraPathRenders:clips.flatMap((clip,index)=>clip.cameraPathControl?[{shotId:shots[index]!.id,...clip.cameraPathControl}]:[])}:{}),
      ...(clips.some(clip=>clip.frameAnchorControl)?{frameAnchorRenders:clips.flatMap((clip,index)=>clip.frameAnchorControl?[{shotId:shots[index]!.id,mode:clip.frameAnchorControl.mode,positions:clip.frameAnchorControl.positions}]:[])}:{}),
      storyboard: clips.flatMap((clip, index) => clip.posterPath ? [{ shotId: shots[index]!.id,
        path: relative(clip.posterPath), ...(clip.sourcePosterPath?{sourcePath:relative(clip.sourcePosterPath)}:{}),caption: shots[index]!.sourcePrompt ?? shots[index]!.prompt, ...(sheet?{sha256:fileSha256(clip.posterPath)}:{}) }] : []),
    };
    if (context.artifacts) {
      const paths = [exportResult.mp4Path, exportResult.hlsPlaylistPath, exportResult.srtPath, exportResult.vttPath, exportResult.manifestPath,
        ...(sheetPath ? [sheetPath] : []),
        ...readdirSync(dirname(exportResult.hlsPlaylistPath)).filter(name => name.endsWith(".ts")).map(name => resolve(dirname(exportResult.hlsPlaylistPath), name))];
      await assertPendingContext();await keepingLease(() => telemetry.run("media.publish",{...jobAttributes,"hv.media.files":paths.length},()=>context.artifacts!.publishExport(job, workerId, paths, jobAbort.signal,...(currentCheckpoint?[completedOutput] as const:[]))));
    }
    if(currentCheckpoint&&!context.artifacts){
      const current=await store.get(job.id);if(!current)throw new Error("The current-film job disappeared before completion.");assertCurrentFilmHeldInputs(current,job);
      await keepingLease(()=>verifyCurrentFilmMedia({...current,output:completedOutput},artifactRoot,jobAbort.signal));
    }
    for(const [index,clip]of clips.entries())if(clip.renderRecord?.reusedFrom)await validateReusePermission(shots[index]!);
    await assertPendingContext();
    return await store.complete(job.id,workerId,completedOutput,now());
  } catch (error) {
    jobSpan.fail(failureCode(error));failure=error;
    // A LeaseError means this worker no longer holds the job (its lease lapsed
    // and another worker may have resumed it), so it must not fail, refuse, or
    // requeue it; report the job as the store currently records it.
    if (error instanceof LeaseError) {logger.warn("worker.lease_lost",{...logFields,leaseReason:error.reason},jobSpan);return await store.get(job.id) ?? null;}
    const reason = error instanceof Error ? error.message : String(error);
    try {
      if (error instanceof BudgetError) {
        const current = await store.get(job.id);
        return current?.status === "cancelled" ? current : await store.cancel(job.id, workerId, reason, now());
      }
      if(error instanceof PerformanceError||error instanceof ShotDurationError||error instanceof FramingError||error instanceof FrameAnchorError||error instanceof ShotReuseError)return await store.cancel(job.id,workerId,reason,now());
      if(error instanceof LipSyncError||error instanceof LipSyncProviderError&&["ambiguous","protocol","permission"].includes(error.kind))return await store.cancel(job.id,workerId,reason,now());
      if (error instanceof Error && error.name === "SafetyRefusal") return await store.refuse(job.id, workerId, reason, now());
      return await store.fail(job.id, workerId, reason, now());
    } catch (settled) {
      if (settled instanceof LeaseError) {logger.warn("worker.lease_lost",{...logFields,leaseReason:settled.reason},jobSpan);return await store.get(job.id) ?? null;}
      throw settled;
    }
  } finally {
    let latest: Job | null | undefined;
    try {
      latest = await store.get(job.id);
      if(latest)jobSpan.attributes({"hv.cost_usd":latest.costUsd,"hv.checkpoint.shots":latest.checkpointShots});
      if (latest && ["done", "failed", "cancelled"].includes(latest.status)) await context.ledger.release(job.id);
    } finally {
      const status=latest?.status;
      logger[status==="done"?"info":status==="failed"?"error":"warn"]("worker.job_finished",{...logFields,jobStatus:status,outcome:status==="done"?"success":"error",
        code:failure===undefined?undefined:failureCode(failure),costUsd:latest?.costUsd,shots:latest?.checkpointShots,durationMs:Math.round(performance.now()-startedAt)},jobSpan);
      if(attemptSpan){attemptSpan.fail("provider");attemptSpan.end();}
      if(!job.dialogueReplacement&&!job.audioTake&&!job.lipSync&&!job.graphicRender)context.artifacts?.removeCache(job);
    }
  }
  },job.traceparent ?? null,SpanKind.CONSUMER);
}

export async function runWorker(options: WorkerOptions = {}): Promise<void> {
  const queuePath = options.queuePath ?? process.env.HV_QUEUE_PATH ?? "/data/queue/jobs.json";
  const artifactBase = options.artifactRoot ?? process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts";
  const pollMs = options.pollMs ?? Number(process.env.HV_WORKER_POLL_MS ?? 1000);
  const database = process.env.HV_STORAGE === "postgres" ? new StudioDatabase(process.env.HV_WORKER_DATABASE_URL ?? "") : undefined;
  const store = database ? new PostgresJobStore(database) : new DurableJobStore(queuePath);
  const workerName = options.workerId ?? process.env.HV_WORKER_ID ?? `${Bun.env.HOSTNAME ?? "worker"}-${process.pid}`;
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(workerName)) throw new Error("invalid worker name");
  const workerId = workerName+"-"+crypto.randomUUID();
  const telemetry=options.telemetry ?? telemetryFromEnv("worker");
  const logger=options.logger ?? loggerFromEnv("worker",telemetry);
  const registry = database ? new PostgresWorkerRegistry(database,workerId,workerName) : undefined;
  let activeJobId: string | null = null;
  const workerState = () => options.signal?.aborted ? "draining" : activeJobId ? "busy" : "idle";
  const sharedArtifacts = process.env.HV_ARTIFACT_STORAGE === "s3";
  if (sharedArtifacts && !database) throw new Error("shared artifacts require PostgreSQL metadata");
  const artifactRoot = sharedArtifacts ? resolve(artifactBase, ".workers", crypto.randomUUID()) : artifactBase;
  const leaseMs = options.leaseMs ?? Number(process.env.HV_JOB_LEASE_MS ?? DEFAULT_LEASE_MS);
  const finalPool = configuredPool("final"), animaticPool = configuredPool("animatic"), sheetPool = configuredPool("character-sheet");
  const primarySpec = finalPool[0]!.spec;
  const secondarySpec = (finalPool[1] ?? finalPool[0])!.spec;
  const animaticSpec = animaticPool[0]!.spec;
  const paid = [...finalPool, ...animaticPool, ...sheetPool].some(value => value.snapshot.price.unit !== "free");
  // The API process holds no router state, so each worker publishes its own circuits in the heartbeat it already sends.
  const providerHealth = new ProviderHealth();
  const healthPools = ([["final", finalPool], ["animatic", animaticPool], ["character-sheet", sheetPool]] as const)
    .flatMap(([stage, pool]) => pool.map(entry => ({stage, provider: providerKind(entry.snapshot.adapter, entry.snapshot.price.unit !== "free"), id: entry.spec, key: entry.snapshot.revision})));
  const heartbeat = async () => { await registry?.heartbeat(workerState(),activeJobId,providerHealth.summary(healthPools)); };
  const context: WorkerContext = {
    ...(database&&process.env.HV_SYNC_API_KEY&&process.env.HV_LIPSYNC_POLICY_FILE?{lipSync:{provider:new SyncLipSyncProvider({apiKey:process.env.HV_SYNC_API_KEY}),ledger:new PostgresLipSyncLedger(database),policy:configuredLipSyncPolicy}}:{}),
    ...(database&&(process.env.CARTESIA_API_KEY||process.env.HV_AZURE_SPEECH_KEY)&&process.env.HV_AUDIO_POLICY_FILE?{audio:{provider:{synthesize:(plan,journal,signal)=>{
      if(plan.profile.provider==="azure"){if(!process.env.HV_AZURE_SPEECH_KEY)throw new Error("The selected Azure voice service is unavailable.");return new AzureAudioProvider({apiKey:process.env.HV_AZURE_SPEECH_KEY}).synthesize(plan,journal,signal);}
      if(!process.env.CARTESIA_API_KEY)throw new Error("The selected Cartesia voice service is unavailable.");return new CartesiaAudioProvider({apiKey:process.env.CARTESIA_API_KEY}).synthesize(plan,journal,signal);}},ledger:new PostgresAudioLedger(database),policy:(voiceId:string)=>configuredAudioPolicies().find(p=>p.voiceId===voiceId)}}:{}),
    references: new ReferenceBlobStore(artifactRoot,sharedArtifacts ? objectClient() : undefined),
    projects: database ? undefined : new ProjectService(process.env.HV_PROJECT_STATE_PATH ?? "/data/state/projects.json"),
    telemetry,
    logger,
    workerName,
    providerHealth,
    onJobStarted: async job => {
      activeJobId=job.id;await heartbeat();
      await options.onJobStarted?.(job);
    },
    artifacts: sharedArtifacts ? new PostgresArtifactStore(database!, artifactRoot) : undefined,
    workerId,
    leaseMs,
    primary: resolveProvider(primarySpec),
    secondary: resolveProvider(secondarySpec),
    animaticProvider: resolveAnimaticProvider(animaticSpec),
    ledger: database ? new PostgresCostLedger(database) : new CostLedger(options.ledgerPath ?? process.env.HV_COST_LEDGER_PATH ?? "/data/state/cost-ledger.json"),
    reviewQueue: database ? new PostgresReviewQueue(database) : new OperatorReviewQueue(
      options.reviewQueuePath ?? process.env.HV_REVIEW_QUEUE_PATH ?? "/data/state/operator-review-queue.json",
    ),
    // The outer timeout must outlast the fal wait budget so the adapter, which
    // knows whether the abandoned request still bills, is the one that gives up.
    providerTimeoutMs: Number(process.env.HV_PROVIDER_TIMEOUT_MS ?? (paid ? DEFAULT_FAL_MAX_WAIT_MS + 60_000 : 30_000)),
  };

  let pendingHeartbeat: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await heartbeat();
    logger.info("worker.started",{worker:workerName,storage:sharedArtifacts?"s3":"local"});
    timer=setInterval(()=>{
      if (pendingHeartbeat) return;
      pendingHeartbeat=heartbeat().catch(()=>{
        logger.warn("worker.heartbeat_failed",{worker:workerName});
      }).finally(()=>{pendingHeartbeat=undefined;});
    },5000);
    // A crashed process resumes through the job lease and its persisted checkpoint.
    await store.recoverAbandoned(Date.now());
    while (!options.signal?.aborted) {
      await context.ledger.reconcile(new Set((await store.all()).filter(j => j.status === "queued" || j.status === "running").map(j => j.id)));
      if (options.signal?.aborted) break;
      const processed = await processNextJob(store, artifactRoot, context);
      activeJobId=null;await heartbeat();
      if (options.signal?.aborted) break;
      await Bun.sleep(processed ? 10 : Math.min(pollMs,1000));
    }
  } finally {
    clearInterval(timer);await pendingHeartbeat;
    await registry?.heartbeat("stopped").catch(()=>{});
    await database?.close();
    if(!options.telemetry)await telemetry.shutdown();
    logger.info("worker.stopped",{worker:workerName});
  }
}

if (import.meta.main) {
  const shutdown=new AbortController();
  const drain=()=>shutdown.abort();
  process.on("SIGTERM",drain);process.on("SIGINT",drain);
  try {await runWorker({signal:shutdown.signal});}
  finally {EventEmitter.prototype.removeListener.call(process,"SIGTERM",drain);EventEmitter.prototype.removeListener.call(process,"SIGINT",drain);}
}
