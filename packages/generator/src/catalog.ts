import {AnchorStoryboardProvider,anchorStoryboardCapability} from "./anchor-storyboard";
import { contentHash, validateCapability, type CapabilitySnapshot, type RoutingStrategy, type ShotRequirements } from "./capabilities";
import { DEFAULT_FAL_MODEL, falVideoCapability } from "./fal";
import { DEFAULT_FAL_IMAGE_MODEL, falImageCapability } from "./fal-image";
import { mockImageCapability } from "./image";
import { richAnimaticCapability } from "./animatic";
import { mockVideoCapability, resolveAnimaticProvider, resolveProvider, type ProviderAdapter } from "./index";

type Environment = Record<string, string | undefined>;
type Stage = "animatic" | "final" | "character-sheet";
export type RenderRequirements = Pick<ShotRequirements, "audio" | "deterministic" | "nativeResolution" | "allowSynthetic" | "region">;
export interface ProviderPoolEntry {spec: string; snapshot: CapabilitySnapshot}
export interface ProviderPlan {
  schema: "hv-provider-plan/1"; revision: string; stage: Stage; strategy: RoutingStrategy;
  maxShotUsd: number; requirements: RenderRequirements; pool: ProviderPoolEntry[];
}
const DEFAULT_REQUIREMENTS: RenderRequirements = {audio: "any", deterministic: false, nativeResolution: false, allowSynthetic: true, region: "any"};
export function renderRequirements(input: unknown): RenderRequirements {
  if (input === undefined) return {...DEFAULT_REQUIREMENTS};
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_REQUIREMENTS, key))) throw new Error("Unsupported render requirements.");
  const result = {...DEFAULT_REQUIREMENTS, ...input};
  if (!["any", "temporary-dialogue", "native-dialogue"].includes(result.audio) || !["any", "local"].includes(result.region)
    || [result.deterministic, result.nativeResolution, result.allowSynthetic].some(value => typeof value !== "boolean")) throw new Error("Invalid render requirements.");
  return result;
}
function override(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0 || price > 1000) throw new Error("Invalid provider price configuration.");
  return price;
}
/** Provider-owned metadata only; safe to call on an API process that holds no inference key. */
export function describeProvider(spec: string, stage: Stage, env: Environment = process.env): ProviderPoolEntry {
  if (typeof spec !== "string" || spec.length > 200) throw new Error("Invalid provider configuration.");
  const value = spec.trim();
  if(value === "anchor-storyboard" && stage!=="character-sheet")return {spec:value,snapshot:anchorStoryboardCapability({narration:env.HV_NARRATION==="1",captions:env.HV_ANIMATIC_CAPTIONS==="1"})};
  if (stage === "final"&&value.startsWith("image:"))return {...describeProvider(value,"animatic",env),spec:value};
  if (stage === "final") {
    if (!value || value === "mock") return {spec: "mock", snapshot: mockVideoCapability()};
    if (value === "fal" || value.startsWith("fal:")) {
      const model = value === "fal" ? DEFAULT_FAL_MODEL : value.slice(4);
      return {spec: "fal:" + model, snapshot: falVideoCapability(model, override(env.HV_FAL_USD_PER_BILLED_SECOND))};
    }
  } else {
    if (value === "legacy-mock" && stage === "animatic") return {spec: value, snapshot: mockVideoCapability()};
    const options = {narration: stage === "animatic" && env.HV_NARRATION === "1", captions: stage === "animatic" && env.HV_ANIMATIC_CAPTIONS === "1"};
    if (!value || value === "mock" || value === "image:mock") return {spec: "mock", snapshot: richAnimaticCapability(mockImageCapability(), options)};
    if (value === "image:fal" || value.startsWith("image:fal:")) {
      const model = value === "image:fal" ? DEFAULT_FAL_IMAGE_MODEL : value.slice("image:fal:".length);
      return {spec: "image:fal:" + model, snapshot: richAnimaticCapability(falImageCapability(model, override(env.HV_FAL_IMAGE_USD_PER_IMAGE)), options)};
    }
  }
  throw new Error("Unknown provider configuration for this render stage.");
}
export function configuredPool(stage: Stage, env: Environment = process.env): ProviderPoolEntry[] {
  const configured = stage === "character-sheet" ? env.HV_CHARACTER_SHEET_PROVIDER_POOL : stage === "animatic" ? env.HV_ANIMATIC_PROVIDER_POOL : env.HV_PROVIDER_POOL;
  let specs: unknown = configured?.trim() ? JSON.parse(configured) : stage === "character-sheet" ? ["mock"] : stage === "animatic" ? [env.HV_ANIMATIC_PROVIDER ?? "mock"] : [env.HV_PROVIDER_PRIMARY ?? "mock", env.HV_PROVIDER_SECONDARY ?? "mock"];
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > 8 || specs.some(spec => typeof spec !== "string")) throw new Error("Provider pools require one to eight configured adapters.");
  const entries = (specs as string[]).map(spec => describeProvider(spec, stage, env));
  return entries.filter((entry, index) => entries.findIndex(candidate => candidate.spec === entry.spec) === index);
}
export function createProviderPlan(stage: Stage, maxShotUsd: number, requirements?: unknown, env: Environment = process.env): ProviderPlan {
  if (!Number.isFinite(maxShotUsd) || maxShotUsd <= 0 || maxShotUsd > 1e6) throw new Error("Invalid per-shot routing budget.");
  const strategy = env.HV_ROUTING_STRATEGY ?? "configured";
  if (!["configured", "cost", "latency"].includes(strategy)) throw new Error("Unknown routing strategy.");
  const data = {stage, strategy: strategy as RoutingStrategy, maxShotUsd, requirements: renderRequirements(requirements), pool: configuredPool(stage, env)};
  return {...data, schema: "hv-provider-plan/1", revision: contentHash(data)};
}
/** Add the free local presenter only to jobs that explicitly request anchor storyboards. */
export function withAnchorStoryboard(plan:ProviderPlan,needed:boolean,env:Environment=process.env):ProviderPlan {
  if(!needed||plan.stage==="character-sheet"||plan.pool.some(e=>e.spec==="anchor-storyboard"))return plan;
  const {schema:_schema,revision:_revision,...data}=plan;
  data.pool=[...data.pool,describeProvider("anchor-storyboard",plan.stage,env)];
  return {...data,schema:"hv-provider-plan/1",revision:contentHash(data)};
}
export function validateProviderPlan(input: unknown): ProviderPlan {
  if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 40_000) throw new Error("Invalid saved provider plan.");
  const value = input as ProviderPlan;
  if (Object.keys(value).sort().join(",") !== "maxShotUsd,pool,requirements,revision,schema,stage,strategy"
    || value.schema !== "hv-provider-plan/1" || !["animatic", "final", "character-sheet"].includes(value.stage) || !["configured", "cost", "latency"].includes(value.strategy)
    || !Number.isFinite(value.maxShotUsd) || value.maxShotUsd <= 0 || value.maxShotUsd > 1e6
    || !Array.isArray(value.pool) || !value.pool.length || (value.pool.length > 8 && !(value.pool.length===9 && value.pool.some(e=>e.spec==="anchor-storyboard"))) || !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error("Invalid saved provider plan.");
  renderRequirements(value.requirements);
  for (const entry of value.pool) {
    if (!entry || Object.keys(entry).sort().join(",") !== "snapshot,spec" || typeof entry.spec !== "string" || entry.spec.length > 200
      || entry.snapshot?.schema !== "hv-capability/1" || !/^[a-f0-9]{64}$/.test(entry.snapshot.revision)) throw new Error("Invalid saved provider capability.");
    validateCapability(entry.snapshot);
  }
  if (new Set(value.pool.map(entry => entry.spec)).size !== value.pool.length) throw new Error("Duplicate saved providers.");
  const {schema: _schema, revision, ...data} = value;
  if (contentHash(data) !== revision) throw new Error("The saved provider plan changed.");
  return structuredClone(value);
}
/** Preserve the admitted order and rates; removals or capability/price changes require a new admission. */
export function instantiateProviderPlan(input: ProviderPlan, env: Environment = process.env): {entry: ProviderPoolEntry; adapter: ProviderAdapter}[] {
  const plan = validateProviderPlan(input), allowed = configuredPool(plan.stage, env);
  if(plan.stage!=="character-sheet"&&!allowed.some(e=>e.spec==="anchor-storyboard"))allowed.push(describeProvider("anchor-storyboard",plan.stage,env));
  return plan.pool.map(entry => {
    const current = allowed.find(value => value.spec === entry.spec);
    if (!current || contentHash(current.snapshot) !== contentHash(entry.snapshot)) throw new Error("Provider configuration changed after this job was queued. Start a new render to use the current configuration.");
    const adapter = entry.spec==="anchor-storyboard" ? new AnchorStoryboardProvider({narration:env.HV_NARRATION==="1",captions:env.HV_ANIMATIC_CAPTIONS==="1"}) : plan.stage === "final" ? resolveProvider(entry.spec, env) : resolveAnimaticProvider(entry.spec, plan.stage === "character-sheet" ? {...env,HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"} : env);
    if (!adapter.capabilities || adapter.capabilities.revision !== entry.snapshot.revision) throw new Error("Provider execution does not match its saved capability.");
    return {entry, adapter};
  });
}
