import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { FAL_MODELS, resolveProvider, providerUsesPaidInference, type ProviderAdapter } from "../../generator/src/index";
import { CostLedger } from "../../operator/src/index";
import { StudioDatabase } from "../../storage/src/database";
import { PostgresCostLedger } from "../../storage/src/ledger";
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
 * 4. **The runtime admits it.** The pass records to the program's own ledger: PostgreSQL, through the
 *    worker role, wherever a database ledger is configured (HV-037-03; `HV_STORAGE=postgres` or a
 *    database URL, which is the staging setup), and otherwise the JSON cost ledger at
 *    `HV_COST_LEDGER_PATH`. The declared amount fits the per-film limit (`HV_FILM_SPEND_CAP_USD`, $40
 *    by default) and the program's $500 envelope; the per-shot cap is a plain dollar amount; and
 *    the increment's earlier passes, read from that same ledger, leave room for it.
 * 5. **The plan fits the declaration.** The provider's own capability prices every shot; an
 *    ineligible plan or a total above the declaration is refused.
 * 6. **The ledger holds it.** The declared amount is reserved against the monthly cap before the
 *    first shot, every shot asks the reservation first, every cost is recorded, and the
 *    reservation is released at the end.
 */

/** LOOP_PAID_ENVELOPE_USD and the ROADMAP: the program's paid cap. A bound here, never a default that rises. */
export const PROGRAM_ENVELOPE_USD = 500;
/** What the command prints when a pass finishes; the runbook keeps it beside the record as evidence of where the spend was recorded. */
export const PAID_SUMMARY_SCHEMA = "hv-benchmark-paid-summary/1";
export const DEFAULT_SHOT_CAP_USD = 5;
/**
 * HV-037-03: the role that may record a provider's cost. The studio's workers record fal spend
 * (`PostgresCostLedger.record`) as `hv_worker`; the API role can read the ledger but cannot write a
 * cost event (HV-040-03). So a pass on a PostgreSQL runtime connects as the worker does.
 */
export const LEDGER_DATABASE_ROLE = "hv_worker";

/** Where a pass's spend is held and recorded: the program's own ledger, whichever the runtime uses. */
export type LedgerTarget = { kind: "json"; path: string } | { kind: "postgres"; url: string };
export interface OpenedLedger {
  ledger: BenchmarkLedger & { monthSpend(): number | Promise<number> };
  close(): void | Promise<void>;
}

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
  /** What the increment doc declares in all, for every pass under it. */
  docUsd: number;
  increment: string;
  ledger: LedgerTarget;
  monthlyCapUsd: number;
  shotCapUsd: number;
}

export interface AuthorizeDeps {
  /** The increment doc's text, or null when it does not exist. */
  readIncrementDoc: (increment: string) => string | null;
}

/** The program's ledger as the runtime configures it, or a refusal that says why it cannot be used. */
export function ledgerTarget(env: Record<string, string | undefined>): LedgerTarget {
  const refuse = (why: string): never => { throw new PaidBenchmarkRefusal("Refused: " + why + " Nothing was rendered and nothing was spent."); };
  const worker = env.HV_WORKER_DATABASE_URL?.trim() ?? "", api = env.HV_API_DATABASE_URL?.trim() ?? "";
  if (worker || api || env.HV_STORAGE?.trim() === "postgres") {
    const configured = worker ? "HV_WORKER_DATABASE_URL" : api ? "HV_API_DATABASE_URL" : "HV_STORAGE=postgres";
    if (!worker) refuse(`${configured} says the program's ledger is in PostgreSQL, and only the worker role records a provider's cost there, as the studio's workers record fal spend. Load HV_WORKER_DATABASE_URL from the host's storage-worker.env.`);
    let role = "";
    try { const url = new URL(worker); if (url.protocol === "postgres:" || url.protocol === "postgresql:") role = decodeURIComponent(url.username); } catch { /* refused below */ }
    if (role !== LEDGER_DATABASE_ROLE) refuse(`HV_WORKER_DATABASE_URL must be a PostgreSQL URL for the ${LEDGER_DATABASE_ROLE} role, the one that records the studio's provider costs.`);
    return { kind: "postgres", url: worker };
  }
  const path = env.HV_COST_LEDGER_PATH?.trim() ?? "";
  if (!path) refuse("HV_COST_LEDGER_PATH is not set, and no database ledger is configured, so this pass's spend could not be held against the program's cap.");
  return { kind: "json", path };
}

/**
 * Steps 1-4 of the refusal order: everything that can be decided without constructing a provider,
 * reading a reference or opening the ledger. Throws `PaidBenchmarkRefusal` with the reason. The
 * increment's earlier spend is read from the ledger next, by `assertDeclarationCovers`.
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
  const ledger = ledgerTarget(env);
  let monthlyCapUsd = 0, filmCapUsd = 0;
  try { monthlyCapUsd = Math.min(monthlyBudgetCap(env), PROGRAM_ENVELOPE_USD); filmCapUsd = filmSpendCap(env, monthlyCapUsd); }
  catch (error) { refuse(error instanceof Error ? error.message : String(error)); }
  if (declaredUsd! > filmCapUsd) refuse(`$${declaredUsd} is above the per-film limit of $${filmCapUsd.toFixed(2)}; a pass is held to it as one film is.`);
  const rawShotCap = env.HV_COST_CAP_PER_SHOT_USD;
  const shotCapUsd = rawShotCap === undefined || rawShotCap.trim() === "" ? DEFAULT_SHOT_CAP_USD : plainDollars(rawShotCap.trim());
  if (shotCapUsd === undefined || shotCapUsd <= 0) refuse("HV_COST_CAP_PER_SHOT_USD is not a plain dollar amount above zero.");
  return { spec, declaredUsd: declaredUsd!, docUsd: docUsd!, increment, ledger, monthlyCapUsd, shotCapUsd: shotCapUsd! };
}

/** The rest of step 4: what earlier passes under the increment spent, read from the program's ledger, leaves room for this one. */
export async function assertDeclarationCovers(auth: Authorization, ledger: BenchmarkLedger): Promise<number> {
  const prior = Number((await ledger.all()).filter(event => event.projectId === BENCHMARK_PROJECT_PREFIX + auth.increment)
    .reduce((sum, event) => sum + event.total_cost_usd, 0).toFixed(6));
  if (prior + auth.declaredUsd > auth.docUsd + 1e-9)
    throw new PaidBenchmarkRefusal(`Refused: ${auth.increment} declares $${auth.docUsd}; $${prior} is already spent under it, so $${auth.declaredUsd} more would pass its declaration. Nothing was rendered and nothing was spent.`);
  return prior;
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
  openLedger: (target: LedgerTarget) => OpenedLedger;
  loadReferences: (paths: Record<string, string>) => ReferenceImage[];
  outDir: string;
  now?: () => Date;
  runId?: string;
}

export const defaultPaidRunDeps = (root: string): PaidRunDeps => ({
  readIncrementDoc: increment => { const path = join(root, "docs/loop/increments", increment + ".md"); return existsSync(path) ? readFileSync(path, "utf8") : null; },
  resolveProvider,
  openLedger,
  loadReferences,
  outDir: "/tmp/hv-benchmark-measured",
});

/** The program's ledger: the studio's `PostgresCostLedger` over the worker role's connection, or the JSON `CostLedger`. */
export function openLedger(target: LedgerTarget): OpenedLedger {
  if (target.kind === "json") return { ledger: new CostLedger(target.path), close: () => {} };
  const database = new StudioDatabase(target.url, 2);
  return { ledger: new PostgresCostLedger(database), close: () => database.close() };
}

export interface PaidRunResult {
  record: MeasuredRecord;
  out: string;
  ledger: LedgerTarget["kind"];
  jobId: string;
  /** This pass's cost events, read back from the ledger after the pass. */
  recordedUsd: number;
  /** The month's spend in that ledger after the pass: what the $500 cap and the $450 alert read. */
  monthSpendUsd: number;
}

/** Steps 1-6, then the pass. Returns the record, where it was written, and the ledger that holds its spend. */
export async function runPaidBenchmark(argv: readonly string[], env: Record<string, string | undefined>, deps: PaidRunDeps): Promise<PaidRunResult> {
  const args = parsePaidArgs(argv);
  const auth = authorizePaidBenchmark(args, env, deps);
  if (args.out && existsSync(args.out)) throw new PaidBenchmarkRefusal(`Refused: ${args.out} already exists, and a paid pass's record is never written over. Nothing was rendered and nothing was spent.`);
  const opened = deps.openLedger(auth.ledger);
  try {
    await assertDeclarationCovers(auth, opened.ledger);
    return await runAuthorized(args, auth, env, deps, opened);
  } finally {
    await opened.close();
  }
}

async function runAuthorized(args: PaidBenchmarkArgs, auth: Authorization, env: Record<string, string | undefined>, deps: PaidRunDeps, opened: OpenedLedger): Promise<PaidRunResult> {
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
  const ledger = opened.ledger, slug = auth.spec.replace(/[^A-Za-z0-9.-]/g, "_");
  const jobId = `${BENCHMARK_PROJECT_PREFIX}${auth.increment}:${auth.spec}:${deps.runId ?? (deps.now ?? (() => new Date()))().toISOString()}`;
  const hold = { amountUsd: auth.declaredUsd, monthlyCapUsd: auth.monthlyCapUsd };
  await ledger.reserve(jobId, "final", hold.amountUsd, hold.monthlyCapUsd);
  let record: MeasuredRecord;
  try {
    // The clips go beside the record when --out names one, so a pass's evidence stays in one private directory.
    const clips = args.out ? join(dirname(resolve(args.out)), "clips", slug) : join(deps.outDir, slug);
    record = await runMeasuredBenchmark({ provider, providerSpec: auth.spec, references, outDir: clips,
      shotCapUsd: auth.shotCapUsd, increment: auth.increment, declaredUsd: auth.declaredUsd, ledger: { ledger, jobId, hold }, now: deps.now });
  } finally {
    await ledger.release(jobId);
  }
  const out = args.out ?? join(deps.outDir, `${auth.increment}-${slug}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: args.out ? "wx" : "w" });
  const recordedUsd = Number((await ledger.all()).filter(event => event.jobId === jobId).reduce((sum, event) => sum + event.total_cost_usd, 0).toFixed(6));
  return { record, out, ledger: auth.ledger.kind, jobId, recordedUsd, monthSpendUsd: Number(Number(await ledger.monthSpend()).toFixed(6)) };
}

if (import.meta.main) {
  try {
    const { record, out, ledger, jobId, recordedUsd, monthSpendUsd } = await runPaidBenchmark(process.argv.slice(2), process.env, defaultPaidRunDeps(resolve(import.meta.dir, "../../..")));
    console.log(JSON.stringify({ schema: PAID_SUMMARY_SCHEMA, out, ledger, jobId, providerSpec: record.providerSpec, provider: record.provider, model: record.model,
      increment: record.increment, declaredUsd: record.declaredUsd, aggregate: record.aggregate, recordedUsd, monthSpendUsd }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof PaidBenchmarkRefusal ? 2 : 1);
  }
}
