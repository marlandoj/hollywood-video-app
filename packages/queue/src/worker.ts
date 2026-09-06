import {sourcePlan} from "../../planner/src/scene-cuts";
import {processDialogueJob} from "./dialogue-worker";
import {generationStage,isTakeStage} from "../../planner/src/render-stage";
import {validateReusePlan,sourceRenderRecord,ShotReuseError} from "../../planner/src/shot-reuse";
import {copyReusableClip,sealShotClip,verifySealedClip} from "./shot-reuse";
import {shotTakeShots} from "../../planner/src/takes";
import {exportShotTakes} from "./take-exports";
import {frameAnchorRequest,assertFrameAnchorCatalog} from "../../planner/src/frame-anchors";
import { StudioTelemetry, SpanHandle, failureCode, providerKind, telemetryFromEnv } from "../../observability/src/index";
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
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import { assembleAsync } from "../../assembler/src/index";
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
  type ProviderAdapter,
  type VideoClip,
} from "../../generator/src/index";
import { configuredPool, instantiateProviderPlan } from "../../generator/src/catalog";
import { matchCapability, videoRequirements } from "../../generator/src/capabilities";
import { ProviderHealth, RoutedGenerator } from "../../generator/src/router";
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
  /** Stop taking work after the current job finishes. */
  signal?: AbortSignal;
  onJobStarted?: (job: Job) => Promise<void>;
}

export interface WorkerContext {
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
  onJobStarted?: (job: Job) => Promise<void>;
}

const quietTelemetry=new StudioTelemetry({service:"worker",enabled:false});
const ANIMATIC_SIZE = "640x360";
const ANIMATIC_DURATION_SEC = 1;

function clipManifestPath(outputDirectory: string): string {
  return `${outputDirectory}/clips/manifest.json`;
}

function loadCompletedClips(outputDirectory: string, upTo: number): VideoClip[] {
  if (upTo <= 0) return [];
  const clips = readJsonFile<VideoClip[]>(clipManifestPath(outputDirectory)) ?? [];
  return clips.slice(0, upTo);
}

export async function processNextJob(
  store: DurableJobStore | PostgresJobStore,
  artifactRoot: string,
  context: WorkerContext,
): Promise<Job | null> {
  const now = context.now ?? Date.now;
  const leaseMs = context.leaseMs ?? DEFAULT_LEASE_MS;
  const workerId = context.workerId ?? crypto.randomUUID();
  const job = await store.claimNext(now(), await context.ledger.gpuSecondsByProject(), { workerId, leaseMs });
  if (!job) return null;
  const telemetry=context.telemetry ?? quietTelemetry;
  const jobAttributes={"hv.project.id":job.projectId,"hv.job.id":job.id,"hv.stage":job.stage};
  return telemetry.run("job.process",jobAttributes,async jobSpan=>{
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

  try {
    if (context.onJobStarted) await keepingLease(() => context.onJobStarted!(job));
    const casting = job.casting ? validateCasting(job.casting, job.projectId) : castingSnapshot(job.projectId, 0, [], 0);
    const direction=job.direction?validateDirection(job.direction,job.projectId):directionSnapshot(job.projectId,0,[],0);
    await context.ledger.reserve(job.id, job.stage, job.budgetReservedUsd ?? job.costCapUsd, Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000));
    if (!job.rightsAttestedAt) throw new Error("rights attestation is required before generation");
    if(job.stage==="dialogue-replacement")return await keepingLease(()=>processDialogueJob(job,store,artifactRoot,context,workerId,leaseMs,jobAbort.signal,now,deadline));
    const renderStage=generationStage(job.stage),takes=job.shotTakes;
    if(isTakeStage(job.stage)!==Boolean(takes)||(takes&&(!job.providerPlan||takes.maxShots!==TIERS[job.tier].maxShots||job.characterSheet)))throw new Error("The take group requires its own admitted generation plan.");
    if (renderStage === "final") {
      if (!job.animaticApprovedAt) throw new Error("the animatic must be approved before final generation");
      const animatic = job.animaticJobId ? await store.get(job.animaticJobId) : undefined;
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
    const shots = takes ? shotTakeShots(takes,casting,parsed,direction,job.scriptVersion,now()) : sheet ? characterSheetShots(sheet,casting,parsed,now()) : directShots(directCast(sourcePlan(parsed,direction,7000,TIERS[job.tier].maxShots), parsed, casting, now()),direction);
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
    // Pre-registry jobs with injected third-party adapters retain their existing execution contract.
    // Every newly admitted job has a plan and must use the registry.
    const generator = candidates.every(value => value.adapter.capabilities) ? new RoutedGenerator({
      candidates, strategy: job.providerPlan?.strategy, planRevision: job.providerPlan?.revision, maxAttemptUsd: shotCapUsd,
      health: context.providerHealth, now, timeoutMs: context.providerTimeoutMs ?? 30_000,
      availableUsd: async () => await context.ledger.shotCapacity(job.id, currentShotId, shotCapUsd),
      onDecision: async decision => {
        await store.recordRouteDecision(job.id, workerId, decision, now());
        routeDecisionId = decision.selectedId ? decision.id : undefined;
      },
    }) : new FailoverGenerator(primary, secondary, context.providerTimeoutMs ?? 30_000);

    const size = sheet ? SHEET_SIZE : isAnimatic ? ANIMATIC_SIZE : TIERS[job.tier].maxResolution;
    if (context.artifacts) await keepingLease(() => telemetry.run("media.restore",jobAttributes,()=>context.artifacts!.restoreCheckpoint(job, jobAbort.signal)));
    const resumeFrom = Math.min(job.checkpointShots, shots.length);
    const clips: VideoClip[] = loadCompletedClips(outputDirectory, resumeFrom);
    for(const [index,clip]of clips.entries())if(clip.renderRecord||job.shotReuse)await keepingLease(()=>verifySealedClip(job,shots[index]!,clip,artifactRoot,jobAbort.signal));
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
        const validateReuseAccess=async()=>{
          const source=await store.get(reuse.jobId);if(!source)throw new ShotReuseError("The source job disappeared. Turn off reuse to render fresh shots.");sourceRenderRecord(source,reuse,now());
          await validateReusePermission(shot);
        };
        await validateReuseAccess();const clip=await keepingLease(()=>copyReusableClip(reuse,job,artifactRoot,jobAbort.signal,context.artifacts));await validateReuseAccess();
        const continuity=checkContinuity(shot.id,previous,clip);if(!continuity.passed){degradedShots.push(shot.id);shotReviews.push({shotId:shot.id,score:continuity.score});}
        clips.push(clip);previous=clip;frames+=Math.round(clip.durationSec*30);writeJsonFile(clipManifestPath(outputDirectory),clips);
        if(context.artifacts)await keepingLease(()=>context.artifacts!.checkpoint(job,workerId,clips,frames,leaseMs,jobAbort.signal));else await store.checkpoint(job.id,workerId,index+1,frames,now(),leaseMs);
        continue;
      }
      const durationSec = isAnimatic && !shot.direction?.frameAnchors && shot.direction?.durationFrames==null && candidates.every(value => !(value.adapter instanceof RichAnimaticProvider)) ? ANIMATIC_DURATION_SEC : shot.durationSec;
      const cameraMove=sheet?"static" as const:renderStage==="animatic"?shot.direction?.previewMove??undefined:undefined;
      const referenceFrames = await keepingLease(async () => {
        if (!shot.referenceAssets?.length) return undefined;
        if (!context.references) throw new Error("Character reference storage is unavailable.");
        return await Promise.all(shot.referenceAssets.map(async asset => "data:image/png;base64," + (await context.references!.read(asset)).toString("base64")));
      });
      const anchorRequest=frameAnchorRequest(shot.direction?.frameAnchors,renderStage);
      const frameAnchors=anchorRequest?await keepingLease(async()=>{
        try{
          const current=context.ledger instanceof PostgresCostLedger?undefined:await context.projects?.peekProject(job.projectId);
          const catalog=context.ledger instanceof PostgresCostLedger?await context.ledger.frameAnchorCatalog(job.projectId,now()):current&&Date.parse(current.deleteAfter)>now()?current.referenceAssets:undefined;
          if(!catalog||!context.references)throw new FrameAnchorError("Current frame anchor storage is unavailable.");
          assertFrameAnchorCatalog(shot.direction?.frameAnchors,job.projectId,catalog);
          return {...anchorRequest,frames:await Promise.all(shot.direction!.frameAnchors!.frames.map(async f=>({at:f.at,image:"data:image/png;base64,"+(await context.references!.read(f.asset)).toString("base64")})))};
        }catch(error){if(jobAbort.signal.aborted)throw jobAbort.signal.reason;throw new FrameAnchorError((error as Error).message);}
      }):undefined;
      const generated = await keepingLease(() => repairLoop(
        shot.id,
        sheet||takes ? null : previous,
        (attempt) => telemetry.run("provider.generate",jobAttributes,()=>generator.generate(
          shot.prompt,
          shot.seed + (sheet ? 0 : attempt * 10000),
          { seed: shot.seed, durationSec, fps: 30, widthxheight: size, shotId: shot.id, dialogue: shot.dialogue,performances:shot.performances,
            sceneHeading: parsed.scenes[shot.sceneIndex]?.heading, action: shot.sourcePrompt ?? shot.prompt,
            referenceFrames,frameAnchors,
            ...(shot.direction?.framing?{framing:shot.direction.framing}:{}),
            ...(shot.direction?.cameraPath?{cameraPath:shot.direction.cameraPath}:{}),
            ...(cameraMove?{cameraMove}:{}),...(shot.direction?.durationFrames!=null?{exactDuration:true}:{}),
            signal: jobAbort.signal, routingRequirements: job.providerPlan?.requirements,
            beforeAttempt: async (provider) => {
              if(frameAnchors && !(context.ledger instanceof PostgresCostLedger)){
                const current=await context.projects?.peekProject(job.projectId);
                if(!current||Date.parse(current.deleteAfter)<=now())throw new FrameAnchorError("Current frame anchor storage is unavailable.");
                try{assertFrameAnchorCatalog(shot.direction?.frameAnchors,job.projectId,current.referenceAssets);}catch(error){throw new FrameAnchorError((error as Error).message);}
              }
              if (!(context.ledger instanceof PostgresCostLedger) && shot.characterIds?.length) {
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
              attemptSpan=telemetry.start("provider.attempt",{...jobAttributes,"hv.attempt.id":attemptId,"hv.provider":providerKind(provider.name)},undefined,SpanKind.CLIENT);
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
        )),
        shotReviews,
      ));
      if(!sheet&&!takes&&job.providerPlan)generated.clip=await keepingLease(()=>sealShotClip(job,shot,generated.clip,artifactRoot,jobAbort.signal));
      clips.push(generated.clip);
      previous = generated.clip;
      if (generated.outcome.status === "degraded") degradedShots.push(shot.id);


      frames += Math.round(generated.clip.durationSec * 30);
      writeJsonFile(clipManifestPath(outputDirectory), clips);
      if (context.artifacts) await keepingLease(() => telemetry.run("media.checkpoint",{...jobAttributes,"hv.checkpoint.shots":index+1},()=>context.artifacts!.checkpoint(job, workerId, clips, frames, leaseMs, jobAbort.signal)));
      else await telemetry.run("media.checkpoint",{...jobAttributes,"hv.checkpoint.shots":index+1},()=>store.checkpoint(job.id, workerId, index + 1, frames, now(), leaseMs));
    }

    for (const flagged of shotReviews) {
      await context.reviewQueue.flag(flagged.shotId, job.projectId, flagged.score);
    }
    for(const [index,clip]of clips.entries())if(clip.renderRecord?.reusedFrom)await validateReusePermission(shots[index]!);

    assertWithinDeadline();
    await store.heartbeat(job.id, workerId, now(), leaseMs);
    if(takes){
      const exported=await keepingLease(()=>telemetry.run("media.assemble",jobAttributes,()=>exportShotTakes(job,clips,shots,artifactRoot,outputDirectory,size,casting,async id=>await context.ledger.shotSpend(job.id,id),jobAbort.signal)));
      await store.heartbeat(job.id,workerId,now(),leaseMs);
      if(context.artifacts)await keepingLease(()=>telemetry.run("media.publish",{...jobAttributes,"hv.media.files":exported.paths.length},()=>context.artifacts!.publishExport(job,workerId,exported.paths,jobAbort.signal)));
      return await store.complete(job.id,workerId,exported.output,now());
    }
    const exportResult = await keepingLease(() => telemetry.run("media.assemble",jobAttributes,()=>assembleAsync(
      clips,
      shots,
      outputDirectory,
      { crossfadeSec: isAnimatic ? 0 : 0.5, fps: 30, size, projectId: job.projectId, signal: jobAbort.signal, casting,...(job.direction?{direction}: {}) },
      degradedShots,
    )));
    const sheetPath = sheet ? resolve(outputDirectory,"character-sheet.png") : undefined;
    if(sheet && sheetPath) {
      const sha256=await keepingLease(()=>composeCharacterSheet(clips,sheet,sheetPath,jobAbort.signal));
      const manifest=readJsonFile<Record<string,unknown>>(exportResult.manifestPath)!;
      writeJsonFile(exportResult.manifestPath,{...manifest,characterSheet:{...sheet,sheetSha256:sha256,views:sheet.views.map((view,index)=>({...view,sha256:fileSha256(clips[index]!.posterPath!)}))}});
    }
    if (context.artifacts) {
      const paths = [exportResult.mp4Path, exportResult.hlsPlaylistPath, exportResult.srtPath, exportResult.vttPath, exportResult.manifestPath,
        ...(sheetPath ? [sheetPath] : []),
        ...readdirSync(dirname(exportResult.hlsPlaylistPath)).filter(name => name.endsWith(".ts")).map(name => resolve(dirname(exportResult.hlsPlaylistPath), name))];
      await keepingLease(() => telemetry.run("media.publish",{...jobAttributes,"hv.media.files":paths.length},()=>context.artifacts!.publishExport(job, workerId, paths, jobAbort.signal)));
    }
    const relative = (path: string) => path.slice(resolve(artifactRoot).length + 1).replaceAll("\\", "/");
    for(const [index,clip]of clips.entries())if(clip.renderRecord?.reusedFrom)await validateReusePermission(shots[index]!);
    return await store.complete(job.id, workerId, {
      mp4Path: relative(exportResult.mp4Path),
      hlsPlaylistPath: relative(exportResult.hlsPlaylistPath),
      captionsPath: relative(exportResult.vttPath),
      manifestPath: relative(exportResult.manifestPath),
      ...(clips.length&&clips.every(clip=>clip.renderRecord)?{shotRenders:clips.map(clip=>clip.renderRecord!)}:{}),
      ...(sheetPath ? {sheetPath:relative(sheetPath)} : {}),
      ...(clips.some(clip=>clip.cameraPathControl)?{cameraPathRenders:clips.flatMap((clip,index)=>clip.cameraPathControl?[{shotId:shots[index]!.id,...clip.cameraPathControl}]:[])}:{}),
      ...(clips.some(clip=>clip.frameAnchorControl)?{frameAnchorRenders:clips.flatMap((clip,index)=>clip.frameAnchorControl?[{shotId:shots[index]!.id,mode:clip.frameAnchorControl.mode,positions:clip.frameAnchorControl.positions}]:[])}:{}),
      storyboard: clips.flatMap((clip, index) => clip.posterPath ? [{ shotId: shots[index]!.id,
        path: relative(clip.posterPath), ...(clip.sourcePosterPath?{sourcePath:relative(clip.sourcePosterPath)}:{}),caption: shots[index]!.sourcePrompt ?? shots[index]!.prompt, ...(sheet?{sha256:fileSha256(clip.posterPath)}:{}) }] : []),
    }, now());
  } catch (error) {
    jobSpan.fail(failureCode(error));
    // A LeaseError means this worker no longer holds the job (its lease lapsed
    // and another worker may have resumed it), so it must not fail, refuse, or
    // requeue it; report the job as the store currently records it.
    if (error instanceof LeaseError) return await store.get(job.id) ?? null;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      if (error instanceof BudgetError) {
        const current = await store.get(job.id);
        return current?.status === "cancelled" ? current : await store.cancel(job.id, workerId, reason, now());
      }
      if(error instanceof PerformanceError||error instanceof ShotDurationError||error instanceof FramingError||error instanceof FrameAnchorError||error instanceof ShotReuseError)return await store.cancel(job.id,workerId,reason,now());
      if (error instanceof Error && error.name === "SafetyRefusal") return await store.refuse(job.id, workerId, reason, now());
      return await store.fail(job.id, workerId, reason, now());
    } catch (failure) {
      if (failure instanceof LeaseError) return await store.get(job.id) ?? null;
      throw failure;
    }
  } finally {
    try {
      const latest = await store.get(job.id);
      if(latest)jobSpan.attributes({"hv.cost_usd":latest.costUsd,"hv.checkpoint.shots":latest.checkpointShots});
      if (latest && ["done", "failed", "cancelled"].includes(latest.status)) await context.ledger.release(job.id);
    } finally {
      if(attemptSpan){attemptSpan.fail("provider");attemptSpan.end();}
      if(!job.dialogueReplacement)context.artifacts?.removeCache(job);
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
  const registry = database ? new PostgresWorkerRegistry(database,workerId,workerName) : undefined;
  let activeJobId: string | null = null;
  const workerState = () => options.signal?.aborted ? "draining" : activeJobId ? "busy" : "idle";
  const heartbeat = async () => { await registry?.heartbeat(workerState(),activeJobId); };
  const sharedArtifacts = process.env.HV_ARTIFACT_STORAGE === "s3";
  if (sharedArtifacts && !database) throw new Error("shared artifacts require PostgreSQL metadata");
  const artifactRoot = sharedArtifacts ? resolve(artifactBase, ".workers", crypto.randomUUID()) : artifactBase;
  const leaseMs = options.leaseMs ?? Number(process.env.HV_JOB_LEASE_MS ?? DEFAULT_LEASE_MS);
  const finalPool = configuredPool("final"), animaticPool = configuredPool("animatic");
  const primarySpec = finalPool[0]!.spec;
  const secondarySpec = (finalPool[1] ?? finalPool[0])!.spec;
  const animaticSpec = animaticPool[0]!.spec;
  const paid = [...finalPool, ...animaticPool, ...configuredPool("character-sheet")].some(value => value.snapshot.price.unit !== "free");
  const context: WorkerContext = {
    references: new ReferenceBlobStore(artifactRoot,sharedArtifacts ? objectClient() : undefined),
    projects: database ? undefined : new ProjectService(process.env.HV_PROJECT_STATE_PATH ?? "/data/state/projects.json"),
    telemetry,
    providerHealth: new ProviderHealth(),
    onJobStarted: async job => {
      activeJobId=job.id;await heartbeat();
      console.log(JSON.stringify({event:"worker.job_started",workerId,jobId:job.id,projectId:job.projectId,stage:job.stage}));
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
    console.log(JSON.stringify({event:"worker.started",workerId,workerName,sharedStorage:sharedArtifacts}));
    timer=setInterval(()=>{
      if (pendingHeartbeat) return;
      pendingHeartbeat=heartbeat().catch(()=>{
        console.error(JSON.stringify({event:"worker.heartbeat_failed",workerId}));
      }).finally(()=>{pendingHeartbeat=undefined;});
    },5000);
    // A crashed process resumes through the job lease and its persisted checkpoint.
    await store.recoverAbandoned(Date.now());
    while (!options.signal?.aborted) {
      await context.ledger.reconcile(new Set((await store.all()).filter(j => j.status === "queued" || j.status === "running").map(j => j.id)));
      if (options.signal?.aborted) break;
      const processed = await processNextJob(store, artifactRoot, context);
      activeJobId=null;await heartbeat();
      if (processed) console.log(JSON.stringify({event:"worker.job_finished",workerId,jobId:processed.id,status:processed.status,costUsd:processed.costUsd}));
      if (options.signal?.aborted) break;
      await Bun.sleep(processed ? 10 : Math.min(pollMs,1000));
    }
  } finally {
    clearInterval(timer);await pendingHeartbeat;
    await registry?.heartbeat("stopped").catch(()=>{});
    await database?.close();
    if(!options.telemetry)await telemetry.shutdown();
    console.log(JSON.stringify({event:"worker.stopped",workerId}));
  }
}

if (import.meta.main) {
  const shutdown=new AbortController();
  const drain=()=>shutdown.abort();
  process.on("SIGTERM",drain);process.on("SIGINT",drain);
  try {await runWorker({signal:shutdown.signal});}
  finally {EventEmitter.prototype.removeListener.call(process,"SIGTERM",drain);EventEmitter.prototype.removeListener.call(process,"SIGINT",drain);}
}
