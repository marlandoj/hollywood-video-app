import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { FAL_MODELS, resolveProvider, providerUsesPaidInference, type ProviderAdapter } from "../../generator/src/index";
import { CostLedger } from "../../operator/src/index";
import { monthlyBudgetCap, plainDollars } from "../../operator/src/dollar-setting";
import { filmSpendCap } from "../../operator/src/film-budget";
import {
  BENCHMARK_PROJECT_PREFIX, loadReferences, planMeasuredPass, plannedCostUsd, runMeasuredBenchmark,
  type BenchmarkLedger, type MeasuredRecord, type ReferenceImage,
} from "./measured";

/**
 * HV-037-02. The entry point for a paid pass of the benchmark corpus:
 *
 *   bun run benchmark:paid --provider fal:<model> --declared-usd <n> --increment HV-037-NN --references <dir> [--out <file>]
 *
 * It is the paid half of Release 3 step 9, built at $0. It **refuses** unless every one of these
 * holds, and it checks them in this order, before any provider is constructed:
 *
 * 1. **The provider is a paid video model, named in full.** `fal:<model>`, a key of `FAL_MODELS`.
 *    The mock is refused: its benchmark is `bun run benchmark`, and a measured score from a local
 *    stand-in is not evidence about a vendor.
 * 2. **A spend is declared** with `--declared-usd`, in plain dollars above zero.
 * 3. **The increment doc declares it too.** CLAUDE.md: "Paid providers stay `mock` unless the
 *    current increment doc declares `spend_usd` and names the provider." The doc
 *    `docs/loop/increments/<increment>.md` must carry `spend_usd:` at least the declared amount
 *    plus whatever earlier passes under the same increment already spent, and must name the
 *    provider spec. This increment's own doc declares `spend_usd: 0`, so the harness refuses to
 *    spend under it.
 * 4. **The runtime admits it.** The program's JSON cost ledger is configured (`HV_COST_LEDGER_PATH`)
 *    and no database ledger is (whose spend this harness could not see); the declared amount fits
 *    the per-film limit (`HV_FILM_SPEND_CAP_USD`, $40 by default) and the program's $500 envelope;
 *    the per-shot cap is a plain dollar amount.
 * 5. **The plan fits the declaration.** The provider's own capability prices every shot; an
 *    ineligible plan or a total above the declaration is refused.
 * 6. **The ledger holds it.** The declared amount is reserved against the monthly cap before the
 *    first shot, every shot asks the reservation first, every cost is recorded, and the
 *    reservation is released at the end.
 */

/** LOOP_PAID_ENVELOPE_USD and the ROADMAP: the program's paid cap. A bound here, never a default that rises. */
export const PROGRAM_ENVELOPE_USD = 500;
export const DEFAULT_SHOT_CAP_USD = 5;
const DATABASE_LEDGER_ENV = ["HV_WORKER_DATABASE_URL", "HV_API_DATABASE_URL"] as const;

export class PaidBenchmarkRefusal extends Error {
  override readonly name = "PaidBenchmarkRefusal";
}

export interface PaidBenchmarkArgs {
  provider?: string;
  declaredUsd?: string;
  increment?: string;
  references?: string;
  out?: string;
}

export function parsePaidArgs(argv: readonly string[]): PaidBenchmarkArgs {
  const names: Record<string, keyof PaidBenchmarkArgs> = { "--provider": "provider", "--declared-usd": "declaredUsd", "--increment": "increment", "--references": "references", "--out": "out" };
  const args: PaidBenchmarkArgs = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = names[argv[index]!];
    const value = argv[index + 1];
    if (!key || value === undefined || value.startsWith("--")) throw new PaidBenchmarkRefusal(`Usage: bun run benchmark:paid --provider fal:<model> --declared-usd <n> --increment HV-037-NN --references <dir> [--out <file>] (could not read "${argv[index]}")`);
    if (args[key] !== undefined) throw new PaidBenchmarkRefusal(`${argv[index]} was given twice.`);
    args[key] = value;
  }
  return args;
}

/** The amount an increment doc declares, or null when it declares none. */
export function declaredSpendOf(doc: string): number | null {
  const match = /^spend_usd:\s*([^\s#]+)\s*$/m.exec(doc);
  if (!match) return null;
  const value = plainDollars(match[1]!);
  return value === undefined ? null : value;
}

/** Whether the doc names the spec as a whole token, so `fal:kling-o3-standard-reference` does not count for `fal:kling-o3-standard`. */
export function docNamesProvider(doc: string, spec: string): boolean {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s\`'"(\\[,])${escaped}(?=$|[\\s\`'"),\\];]|\\.(\\s|$))`, "m").test(doc);
}

export interface Authorization {
  spec: string;
  declaredUsd: number;
  increment: string;
  ledgerPath: string;
  monthlyCapUsd: number;
  shotCapUsd: number;
  priorIncrementSpendUsd: number;
}

export interface AuthorizeDeps {
  /** The increment doc's text, or null when it does not exist. */
  readIncrementDoc: (increment: string) => string | null;
  /** Cost events already in the ledger at this path. */
  ledgerEvents: (path: string) => { projectId: string; total_cost_usd: number }[];
}

/**
 * Steps 1-4 of the refusal order: everything that can be decided without constructing a provider
 * or reading a reference. Throws `PaidBenchmarkRefusal` with the reason.
 */
export function authorizePaidBenchmark(args: PaidBenchmarkArgs, env: Record<string, string | undefined>, deps: AuthorizeDeps): Authorization {
  const refuse = (why: string): never => { throw new PaidBenchmarkRefusal("Refused: " + why + " Nothing was rendered and nothing was spent."); };
  const spec = args.provider?.trim() ?? "";
  if (!spec) refuse("name the provider with --provider fal:<model>.");
  if (!providerUsesPaidInference(spec)) refuse(`"${spec}" is not a paid provider. The mock benchmark is \`bun run benchmark\`; this harness runs only a paid video model.`);
  if (!/^fal:[a-z0-9.-]+$/.test(spec)) refuse(`name the model in full, as fal:<model>, so the record says which model was measured ("${spec}").`);
  if (!Object.hasOwn(FAL_MODELS, spec.slice(4))) refuse(`"${spec}" is not a known fal video model; known: ${Object.keys(FAL_MODELS).map(key => "fal:" + key).join(", ")}.`);
  if (args.declaredUsd === undefined) refuse("a paid pass needs a declared spend: pass --declared-usd <dollars>.");
  const declaredUsd = plainDollars(args.declaredUsd!.trim());
  if (declaredUsd === undefined || declaredUsd <= 0) refuse(`--declared-usd takes plain dollars above zero, such as 20 or 12.50 (got "${args.declaredUsd}").`);
  const increment = args.increment?.trim() ?? "";
  if (!/^HV-\d{3}-\d{2}$/.test(increment)) refuse("name the increment that declares this spend with --increment HV-NNN-NN.");
  const doc = deps.readIncrementDoc(increment);
  if (doc === null) refuse(`docs/loop/increments/${increment}.md does not exist.`);
  const docUsd = declaredSpendOf(doc!);
  if (docUsd === null || docUsd <= 0) refuse(`${increment} declares no spend (spend_usd: ${docUsd ?? "absent"}). Paid providers stay mock unless the increment doc declares spend_usd.`);
  if (!docNamesProvider(doc!, spec)) refuse(`${increment} does not name ${spec}. Paid providers stay mock unless the increment doc names the provider.`);
  const ledgerPath = env.HV_COST_LEDGER_PATH?.trim() ?? "";
  if (!ledgerPath) refuse("HV_COST_LEDGER_PATH is not set, so this pass's spend could not be held against the program's cap.");
  const database = DATABASE_LEDGER_ENV.find(name => env[name]?.trim());
  if (database) refuse(`${database} is set: the program's ledger is in PostgreSQL, and this harness records only to the JSON ledger, where that spend would be invisible to the cap.`);
  let monthlyCapUsd = 0, filmCapUsd = 0;
  try { monthlyCapUsd = Math.min(monthlyBudgetCap(env), PROGRAM_ENVELOPE_USD); filmCapUsd = filmSpendCap(env, monthlyCapUsd); }
  catch (error) { refuse(error instanceof Error ? error.message : String(error)); }
  if (declaredUsd! > filmCapUsd) refuse(`$${declaredUsd} is above the per-film limit of $${filmCapUsd.toFixed(2)}; a pass is held to it as one film is.`);
  const rawShotCap = env.HV_COST_CAP_PER_SHOT_USD;
  const shotCapUsd = rawShotCap === undefined || rawShotCap.trim() === "" ? DEFAULT_SHOT_CAP_USD : plainDollars(rawShotCap.trim());
  if (shotCapUsd === undefined || shotCapUsd <= 0) refuse("HV_COST_CAP_PER_SHOT_USD is not a plain dollar amount above zero.");
  const priorIncrementSpendUsd = Number(deps.ledgerEvents(ledgerPath).filter(event => event.projectId === BENCHMARK_PROJECT_PREFIX + increment)
    .reduce((sum, event) => sum + event.total_cost_usd, 0).toFixed(6));
  if (priorIncrementSpendUsd + declaredUsd! > docUsd! + 1e-9)
    refuse(`${increment} declares $${docUsd}; $${priorIncrementSpendUsd} is already spent under it, so $${declaredUsd} more would pass its declaration.`);
  return { spec, declaredUsd: declaredUsd!, increment, ledgerPath, monthlyCapUsd, shotCapUsd: shotCapUsd!, priorIncrementSpendUsd };
}

/** `<dir>/<character>.png`, one per locked character. */
export function referencePaths(dir: string): Record<string, string> {
  if (!existsSync(dir)) throw new PaidBenchmarkRefusal(`Refused: the reference directory ${dir} does not exist. Nothing was rendered and nothing was spent.`);
  const files = readdirSync(dir).filter(file => extname(file).toLowerCase() === ".png");
  if (!files.length) throw new PaidBenchmarkRefusal(`Refused: ${dir} holds no <character>.png references. Nothing was rendered and nothing was spent.`);
  return Object.fromEntries(files.map(file => [basename(file, extname(file)).toUpperCase(), join(dir, file)]));
}

export interface PaidRunDeps extends AuthorizeDeps {
  resolveProvider: (spec: string, env: Record<string, string | undefined>) => ProviderAdapter;
  ledger: (path: string) => BenchmarkLedger;
  loadReferences: (paths: Record<string, string>) => ReferenceImage[];
  outDir: string;
  now?: () => Date;
  runId?: string;
}

export const defaultPaidRunDeps = (root: string): PaidRunDeps => ({
  readIncrementDoc: increment => { const path = join(root, "docs/loop/increments", increment + ".md"); return existsSync(path) ? readFileSync(path, "utf8") : null; },
  ledgerEvents: path => new CostLedger(path).all(),
  resolveProvider,
  ledger: path => new CostLedger(path),
  loadReferences,
  outDir: "/tmp/hv-benchmark-measured",
});

/** Steps 1-6, then the pass. Returns the record and where it was written. */
export async function runPaidBenchmark(argv: readonly string[], env: Record<string, string | undefined>, deps: PaidRunDeps): Promise<{ record: MeasuredRecord; out: string }> {
  const args = parsePaidArgs(argv);
  const auth = authorizePaidBenchmark(args, env, deps);
  if (!args.references) throw new PaidBenchmarkRefusal("Refused: a paid pass needs the corpus's locked references: --references <dir> with <character>.png. Nothing was rendered and nothing was spent.");
  const references = deps.loadReferences(referencePaths(args.references));
  const flat = references.filter(reference => reference.flat).map(reference => reference.character);
  if (flat.length) throw new PaidBenchmarkRefusal(`Refused: the reference for ${flat.join(", ")} is a flat picture and cannot be compared. Nothing was rendered and nothing was spent.`);
  const provider = deps.resolveProvider(auth.spec, env);
  const plan = planMeasuredPass(provider, references, auth.shotCapUsd);
  const eligible = plan.filter(entry => entry.match.eligible);
  if (!eligible.length) throw new PaidBenchmarkRefusal(`Refused: ${auth.spec} can render none of the corpus's shots (${[...new Set(plan.flatMap(entry => entry.match.reasons))].join(", ")}). Nothing was rendered and nothing was spent.`);
  const plannedUsd = plannedCostUsd(plan);
  if (plannedUsd > auth.declaredUsd + 1e-9) throw new PaidBenchmarkRefusal(`Refused: the pass is priced at $${plannedUsd.toFixed(2)}, above the $${auth.declaredUsd} declared. Nothing was rendered and nothing was spent.`);
  const ledger = deps.ledger(auth.ledgerPath);
  const jobId = `${BENCHMARK_PROJECT_PREFIX}${auth.increment}:${auth.spec}:${deps.runId ?? (deps.now ?? (() => new Date()))().toISOString()}`;
  await ledger.reserve(jobId, "final", auth.declaredUsd, auth.monthlyCapUsd);
  let record: MeasuredRecord;
  try {
    record = await runMeasuredBenchmark({ provider, providerSpec: auth.spec, references, outDir: join(deps.outDir, auth.spec.replace(/[^A-Za-z0-9.-]/g, "_")),
      shotCapUsd: auth.shotCapUsd, increment: auth.increment, declaredUsd: auth.declaredUsd, ledger: { ledger, jobId }, now: deps.now });
  } finally {
    await ledger.release(jobId);
  }
  const out = args.out ?? join(deps.outDir, `${auth.increment}-${auth.spec.replace(/[^A-Za-z0-9.-]/g, "_")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  return { record, out };
}

if (import.meta.main) {
  try {
    const { record, out } = await runPaidBenchmark(process.argv.slice(2), process.env, defaultPaidRunDeps(resolve(import.meta.dir, "../../..")));
    console.log(JSON.stringify({ out, provider: record.provider, model: record.model, aggregate: record.aggregate }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof PaidBenchmarkRefusal ? 2 : 1);
  }
}
