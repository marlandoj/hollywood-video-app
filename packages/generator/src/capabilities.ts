import {cameraPathSettings,assertCameraPathContext,type ShotCameraPath} from "../../planner/src/camera-path";
import { createHash } from "node:crypto";
import {isCropped,type ShotFraming} from "../../planner/src/framing";

export type GenerationModality = "image" | "video";
/** `quality` (HV-019-14) ranks by the committed benchmark's measured scores; see quality-routing.ts. */
export const ROUTING_STRATEGIES = ["configured", "cost", "latency", "quality"] as const;
export type RoutingStrategy = typeof ROUTING_STRATEGIES[number];
export interface CapabilityDefinition {
  adapter: string;
  model: string;
  modality: GenerationModality;
  synthetic: boolean;
  lifecycle: "configured" | "retired";
  input: {text: true; referenceFrames: number; identityLocks: number; minimumReferenceFrames?: number;minimumFirstFrame?:true};
  output: {minWidth: number; minHeight: number; maxWidth: number; maxHeight: number; dimensionMultiple: number;
    fps: [number, number] | null; durationSec: [number, number] | null;
    nativeResolution: "requested" | "720p" | "unknown"; aspectRatios: string[] | null};
  audio: "silent" | "temporary-dialogue";
  cameraMoves: string[];
  postProcessing: string[];
  frameControls: {first:boolean;last:boolean;intermediate:boolean};
  frameControlMode?:"native"|"storyboard";
  extension: false;
  cancellation: "local" | "queued-only" | "none";
  determinism: "local-bitexact" | "seed-best-effort" | "none";
  price: {unit: "free" | "billed-second" | "megapixel-ceil" | "reference-megapixel-ceil" | "request"; usd: number; billedDurationsSec: number[]; minimumDimension?: number; basis: "configured"; invoiceReconciled: false};
  policy: {adapterPolicyVersion: "studio-generation-safety/1"; vendorPolicyVersion: null};
  region: "local" | "unspecified";
}
export interface CapabilitySnapshot extends CapabilityDefinition {schema: "hv-capability/1"; revision: string; priceVersion: string}
export interface ShotRequirements {
  linePerformances?:true;
  cameraPath?:ShotCameraPath;
  frameAnchors?:{first:true;last:boolean;intermediate:boolean;mode:"native"|"storyboard"|"prefer-native"};
  modality: GenerationModality; width: number; height: number; fps: number | null; durationSec: number | null;
  referenceFrames: number; identityLocks: number; cameraMove: string | null;
  audio: "any" | "temporary-dialogue" | "native-dialogue";
  deterministic: boolean; nativeResolution: boolean; allowSynthetic: boolean; region: "any" | "local";
}
export type RejectionReason = "modality" | "dimensions" | "fps" | "duration" | "references" | "identity" | "camera" | "audio" | "determinism" | "native-resolution" | "synthetic" | "region" | "price" | "circuit-open" | "capability-changed" | "provider-retired" | "frame-anchors";
export interface CapabilityMatch {eligible: boolean; reasons: RejectionReason[]; estimateUsd: number | null; billedDurationSec: number | null; adaptations: string[]}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value);
}
export function contentHash(value: unknown): string {return createHash("sha256").update(canonical(value)).digest("hex");}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
  return value;
}
export function capability(definition: CapabilityDefinition): CapabilitySnapshot {
  const copied = structuredClone(definition);
  const output = copied?.output, price = copied?.price;
  const range = (value: unknown, max: number) => Array.isArray(value) && value.length === 2 && value.every(n => typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max) && value[0] <= value[1];
  const strings = (value: unknown) => Array.isArray(value) && value.length <= 32 && value.every(text => typeof text === "string" && /^[A-Za-z0-9_.:/ -]{1,100}$/.test(text));
  if (!copied || !output || !price || !copied.input || !copied.policy || !copied.frameControls
    || !["image", "video"].includes(copied.modality) || typeof copied.synthetic !== "boolean" || !["configured", "retired"].includes(copied.lifecycle)
    || copied.input.text !== true || ![copied.input.referenceFrames, copied.input.identityLocks].every(n => Number.isInteger(n) && n >= 0 && n <= 32)
    || (copied.input.minimumReferenceFrames !== undefined && (!Number.isInteger(copied.input.minimumReferenceFrames) || copied.input.minimumReferenceFrames < 1 || copied.input.minimumReferenceFrames > copied.input.referenceFrames))
    || ![output.minWidth, output.minHeight, output.maxWidth, output.maxHeight].every(n => Number.isInteger(n) && n >= 16 && n <= 8192)
    || output.minWidth > output.maxWidth || output.minHeight > output.maxHeight || !Number.isInteger(output.dimensionMultiple) || output.dimensionMultiple < 1 || output.dimensionMultiple > 64
    || (copied.modality === "video" ? !range(output.fps, 120) || !range(output.durationSec, 600) : output.fps !== null || output.durationSec !== null)
    || !["requested", "720p", "unknown"].includes(output.nativeResolution)
    || (output.aspectRatios !== null && (!strings(output.aspectRatios) || output.aspectRatios.some(ratio => !/^[1-9][0-9]?:[1-9][0-9]?$/.test(ratio))))
    || !strings(copied.cameraMoves) || !strings(copied.postProcessing) || !["silent", "temporary-dialogue"].includes(copied.audio)
    || copied.extension !== false || [copied.frameControls.first, copied.frameControls.last, copied.frameControls.intermediate].some(value => typeof value!=="boolean")
    || (Object.values(copied.frameControls).some(Boolean) ? !["native","storyboard"].includes(copied.frameControlMode??"") : copied.frameControlMode!==undefined)
    || (copied.input.minimumFirstFrame!==undefined && (copied.input.minimumFirstFrame!==true||!copied.frameControls.first))
    || !["local", "queued-only", "none"].includes(copied.cancellation) || !["local-bitexact", "seed-best-effort", "none"].includes(copied.determinism)
    || !["local", "unspecified"].includes(copied.region) || copied.policy.adapterPolicyVersion !== "studio-generation-safety/1" || copied.policy.vendorPolicyVersion !== null
    || !["free", "billed-second", "megapixel-ceil", "reference-megapixel-ceil", "request"].includes(price.unit) || price.basis !== "configured" || price.invoiceReconciled !== false
    || (price.unit === "reference-megapixel-ceil" && (!Number.isInteger(price.minimumDimension) || price.minimumDimension! < 1 || price.minimumDimension! > 2048))
    || (price.unit !== "reference-megapixel-ceil" && price.minimumDimension !== undefined)
    || !Array.isArray(price.billedDurationsSec) || price.billedDurationsSec.length > 32
    || price.billedDurationsSec.some((n, i, values) => !Number.isFinite(n) || n <= 0 || n > 600 || (i > 0 && n <= values[i - 1]!))
    || (price.unit === "billed-second" ? !price.billedDurationsSec.length : price.billedDurationsSec.length !== 0)
    || (price.unit === "free" && price.usd !== 0)) throw new Error("Invalid provider capability configuration.");
  if (!/^[a-z0-9-]{1,64}$/.test(copied.adapter) || !/^[A-Za-z0-9._:/-]{1,200}$/.test(copied.model)
    || !Number.isFinite(copied.price.usd) || copied.price.usd < 0 || copied.price.usd > 1000
    || (copied.price.unit !== "free" && copied.price.usd <= 0)) throw new Error("Invalid provider capability configuration.");
  return freeze({...copied, schema: "hv-capability/1", revision: contentHash(copied), priceVersion: contentHash(copied.price)});
}
export function validateCapability(snapshot: CapabilitySnapshot): CapabilitySnapshot {
  if (!snapshot || snapshot.schema !== "hv-capability/1") throw new Error("Invalid provider capability snapshot.");
  const {schema: _schema, revision, priceVersion, ...definition} = snapshot;
  const validated = capability(definition);
  if (validated.revision !== revision || validated.priceVersion !== priceVersion) throw new Error("Provider capability integrity failed.");
  return validated;
}
export function baseCapability(adapter: string, model: string, modality: GenerationModality): CapabilityDefinition {
  return {adapter, model, modality, synthetic: false, lifecycle: "configured", input: {text: true, referenceFrames: 0, identityLocks: 0},
    output: {minWidth: 16, minHeight: 16, maxWidth: 4096, maxHeight: 4096, dimensionMultiple: 2,
      fps: modality === "video" ? [1, 60] : null, durationSec: modality === "video" ? [.1, 30] : null,
      nativeResolution: "unknown", aspectRatios: null},
    audio: "silent", cameraMoves: [], postProcessing: [], frameControls: {first: false, last: false, intermediate: false}, extension: false,
    cancellation: "queued-only", determinism: "none", price: {unit: "free", usd: 0, billedDurationsSec: [], basis: "configured", invoiceReconciled: false},
    policy: {adapterPolicyVersion: "studio-generation-safety/1", vendorPolicyVersion: null}, region: "unspecified"};
}
export function validateRequirements(value: ShotRequirements): ShotRequirements {
  if(value?.linePerformances!==undefined&&value.linePerformances!==true)throw new Error("Invalid line performance requirement.");
  if(value?.cameraPath!==undefined){cameraPathSettings(value.cameraPath);assertCameraPathContext({cameraPath:value.cameraPath,frameAnchors:value.frameAnchors,cameraMove:value.cameraMove,routingRequirements:{nativeResolution:value.nativeResolution},fps:value.fps??30,durationSec:value.durationSec??1});}
  if(value?.frameAnchors!==undefined){const frames=value.frameAnchors;if(!frames||Object.keys(frames).sort().join(",")!=="first,intermediate,last,mode"||frames.first!==true||![frames.last,frames.intermediate].every(v=>typeof v==="boolean")||!["native","storyboard","prefer-native"].includes(frames.mode))throw new Error("Invalid frame anchor requirements.");}
  if (!value || !["image", "video"].includes(value.modality)
    || ![value.width, value.height].every(number => Number.isInteger(number) && number >= 16 && number <= 8192)
    || ![value.referenceFrames, value.identityLocks].every(number => Number.isInteger(number) && number >= 0 && number <= 32)
    || !["any", "temporary-dialogue", "native-dialogue"].includes(value.audio) || !["any", "local"].includes(value.region)
    || ![value.deterministic, value.nativeResolution, value.allowSynthetic].every(value => typeof value === "boolean")
    || !(value.cameraMove === null || ["static", "push-in", "pull-out", "pan-left", "pan-right"].includes(value.cameraMove))
    || (value.modality === "video" && (!(typeof value.fps === "number" && Number.isInteger(value.fps) && value.fps >= 1 && value.fps <= 120)
      || !(typeof value.durationSec === "number" && Number.isFinite(value.durationSec) && value.durationSec >= .1 && value.durationSec <= 600)))
    || (value.modality === "image" && (value.fps !== null || value.durationSec !== null))) throw new Error("Invalid shot requirements.");
  return structuredClone(value);
}
export function videoRequirements(params: {performances?:readonly unknown[];cameraPath?:ShotCameraPath;widthxheight?: string; fps?: number; durationSec?: number; referenceFrames?: readonly string[]; identityLocks?: readonly string[]; cameraMove?: string;framing?:ShotFraming;frameAnchors?:{frames:readonly {at:number}[];mode:"native"|"storyboard"|"prefer-native"};
  routingRequirements?: Partial<Pick<ShotRequirements, "audio" | "deterministic" | "nativeResolution" | "allowSynthetic" | "region">>}): ShotRequirements {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(params.widthxheight ?? "1920x1080");
  if (!match) throw new Error("Invalid render dimensions.");
  assertCameraPathContext(params);
  if(isCropped(params.framing)&&params.routingRequirements?.nativeResolution)throw new Error("A digital crop is incompatible with a native-resolution requirement.");
  let frameAnchors:ShotRequirements["frameAnchors"];
  if(params.frameAnchors){const frames=params.frameAnchors.frames;if(!Array.isArray(frames)||frames.length<1||frames.length>5||frames[0]?.at!==0||frames.some((f,i)=>!Number.isInteger(f.at)||f.at<0||f.at>10000||(i>0&&f.at<=frames[i-1]!.at)))throw new Error("Invalid frame anchor times.");
    const count=Math.round((params.fps??30)*(params.durationSec??1)),positions=frames.map(f=>Math.round(f.at*(count-1)/10000));
    if(count<2||positions.some((at,i)=>i>0&&at<=positions[i-1]!))throw new Error("Frame anchors collide at this duration. Space them farther apart or increase the duration.");
    frameAnchors={first:true,last:frames.some(f=>f.at===10000),intermediate:frames.some(f=>f.at>0&&f.at<10000),mode:params.frameAnchors.mode};}
  return validateRequirements({...(params.performances?.length?{linePerformances:true as const}:{}),modality: "video", width: Number(match[1]), height: Number(match[2]), fps: params.fps ?? 30, durationSec: params.durationSec ?? 1,
    referenceFrames: params.referenceFrames?.length ?? 0, identityLocks: params.identityLocks?.length ?? 0, cameraMove: params.cameraMove ?? null,
    audio: "any", deterministic: false, nativeResolution: false, allowSynthetic: true, region: "any", ...params.routingRequirements,...(params.cameraPath?{cameraPath:cameraPathSettings(params.cameraPath)}:{}),...(frameAnchors?{frameAnchors}:{})});
}
export function matchCapability(snapshot: CapabilitySnapshot, input: ShotRequirements, maxAttemptUsd: number): CapabilityMatch {
  const request = validateRequirements(input), output = snapshot.output, reasons: RejectionReason[] = [], adaptations: string[] = [];
  if(request.linePerformances&&(snapshot.audio!=="temporary-dialogue"||!snapshot.postProcessing.includes("line-performances-v1")))reasons.push("audio");
  if (!Number.isFinite(maxAttemptUsd) || maxAttemptUsd < 0 || maxAttemptUsd > 1e6) throw new Error("Invalid routing budget.");
  if(request.cameraPath)adaptations.push("screen-space camera path; digital framing applied locally");
  if (snapshot.lifecycle === "retired") reasons.push("provider-retired");
  if (snapshot.modality !== request.modality) reasons.push("modality");
  if(snapshot.input.minimumFirstFrame&&!request.frameAnchors?.first)reasons.push("frame-anchors");
  if(request.frameAnchors){const anchors=request.frameAnchors;if((anchors.mode!=="prefer-native"&&anchors.mode!==snapshot.frameControlMode)||!snapshot.frameControlMode||!snapshot.frameControls.first||(anchors.last&&!snapshot.frameControls.last)||(anchors.intermediate&&!snapshot.frameControls.intermediate))reasons.push("frame-anchors");
    if(snapshot.frameControlMode==="storyboard")adaptations.push("provided-anchor-stills; no generated subject motion");}
  if (request.width < output.minWidth || request.width > output.maxWidth || request.height < output.minHeight || request.height > output.maxHeight
    || request.width % output.dimensionMultiple || request.height % output.dimensionMultiple) reasons.push("dimensions");
  if (request.fps !== null && (!output.fps || request.fps < output.fps[0] || request.fps > output.fps[1])) reasons.push("fps");
  if (request.durationSec !== null && (!output.durationSec || request.durationSec < output.durationSec[0] || request.durationSec > output.durationSec[1])) reasons.push("duration");
  if(request.frameAnchors&&snapshot.frameControlMode==="storyboard"&&request.referenceFrames>0)adaptations.push("provided images are unchanged; cast references are not reapplied");
  else if (request.referenceFrames > snapshot.input.referenceFrames || request.referenceFrames < (snapshot.input.minimumReferenceFrames ?? 0)) reasons.push("references");
  if (request.identityLocks > snapshot.input.identityLocks) reasons.push("identity");
  if (request.cameraMove && !snapshot.cameraMoves.includes(request.cameraMove)) reasons.push("camera");
  if (request.audio !== "any" && request.audio !== snapshot.audio) reasons.push("audio");
  if (request.deterministic && snapshot.determinism !== "local-bitexact") reasons.push("determinism");
  const native = output.nativeResolution === "requested" || (output.nativeResolution === "720p" && Math.max(request.width, request.height) <= 1280 && Math.min(request.width, request.height) <= 720);
  if (request.nativeResolution && !native) reasons.push("native-resolution");
  if (!native) adaptations.push("scale-and-pad; native resolution unverified for this request");
  if (!request.allowSynthetic && snapshot.synthetic) reasons.push("synthetic");
  if (request.region === "local" && snapshot.region !== "local") reasons.push("region");
  if (output.aspectRatios && !output.aspectRatios.some(ratio => {const [width, height] = ratio.split(":").map(Number); return width! * request.height === height! * request.width;})) adaptations.push("pad-to-requested-aspect");
  const billedDurationSec = snapshot.price.unit === "billed-second" ? snapshot.price.billedDurationsSec.find(duration => duration >= (request.durationSec ?? 0)) ?? null : null;
  if (snapshot.price.unit === "billed-second" && billedDurationSec === null) reasons.push("duration");
  if (billedDurationSec !== null && billedDurationSec !== request.durationSec) adaptations.push(request.frameAnchors?"retime-preserving-generated-endpoints":"trim-billed-duration");
  const estimateUsd = snapshot.price.unit === "free" ? 0 : snapshot.price.unit === "request" ? snapshot.price.usd
    : snapshot.price.unit === "megapixel-ceil" ? Math.ceil(request.width * request.height / 1_000_000) * snapshot.price.usd
    : snapshot.price.unit === "reference-megapixel-ceil" ? (request.referenceFrames + Math.ceil(Math.max(request.width,snapshot.price.minimumDimension!) * Math.max(request.height,snapshot.price.minimumDimension!) / 1_000_000)) * snapshot.price.usd
    : billedDurationSec === null ? null : billedDurationSec * snapshot.price.usd;
  if (estimateUsd === null || estimateUsd > maxAttemptUsd + 1e-9) reasons.push("price");
  return {eligible: reasons.length === 0, reasons: [...new Set(reasons)], estimateUsd: estimateUsd === null ? null : Number(estimateUsd.toFixed(6)), billedDurationSec, adaptations};
}
