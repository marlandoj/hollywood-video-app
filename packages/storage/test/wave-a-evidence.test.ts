import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StudioDatabase } from "../src/database";
import { objectStoreConfig } from "../src/s3-requests";
import { CI_STEPS, REASONS, SECTIONS, WORKER_PROGRAMS, backupProbe, ciProbe, classifyLifecycle, classifyMultipartListing, collectWaveAExit,
  countWorkers, databaseProbe, deriveExit, healthProbe, isKnownReason, migrationsProbe, objectStoreProbe, parseSweeperStatus, readDeployment,
  readJournal, readOnlyReads, readinessProbe, releaseProbe, resolveMigrations, supervisorProbe, sweeperProbe, validateDocument, withReadOnly,
  workerRows, workersProbe, type Probes, type Runner, type Section, type WaveAExitDocument } from "../../../scripts/storage-wave-a-evidence";

// Guard for HV-040-05: the Wave A exit evidence is observed or pending, never typed in, and never carries a secret or an id.
const repo = resolve(import.meta.dir, "../../.."), journalPath = join(repo, "infra/drizzle/meta/_journal.json"), evidencePath = join(repo, "docs/evidence/hv040-storage/wave-a-exit.json");
const SHA = "0caa202" + "f".repeat(33), OTHER_SHA = "1".repeat(40), NOW = Date.parse("2026-09-14T18:00:00.000Z");
const RUNNING = Object.fromEntries(WORKER_PROGRAMS.map(name => [name, "RUNNING"]));
const SUCCESS = Object.fromEntries(CI_STEPS.map(step => [step, "success"]));
const healthy = (): Probes => ({
  release: () => ({sha: SHA, backend: "postgres", expectedWorkers: 3}),
  database: () => ({version: "PostgreSQL 15.19 on x86_64-pc-linux-gnu", tables: 12, forcedRowSecurity: 12, counts: {projects: 4, jobs: 9, artifacts: 51}, queue: {queued: 0, running: 0}}),
  migrations: () => ({applied: 16, journalEntries: 16, head: "0015_accounting_capabilities", inSync: true}),
  workers: () => ({registered: 3, expected: 3, names: ["zo-staging-worker-1", "zo-staging-worker-2", "zo-staging-worker-3"], supervisor: {...RUNNING}, freshWithinSeconds: 45}),
  objectStore: () => ({endpointScheme: "https", bucket: "rough-cut-staging-v4", lifecycle: "absent", daysAfterInitiation: null, multipartListing: "supported",
    sweeper: {status: "recorded", sweptAt: "2026-09-14T17:59:00.000Z", incompleteUploads: {aborted: 0, retained: 0, failed: 0, supported: true}}}),
  readiness: () => ({ready: true, databaseRole: "hv_api", privateObjectsAuthenticated: true, elapsedMs: 31000}),
  health: () => ({serviceStatus: "healthy", queueDepth: 0, runningJobs: 0, monthSpendUsd: 0}),
  backup: () => ({state: "healthy", lastCompletedAt: "2026-09-14T17:58:00.000Z", objects: 120, localRepositoryOnly: true}),
  ci: () => ({runId: 18123456789, headSha: SHA, conclusion: "success", steps: {...SUCCESS}}),
});
const options = {runtimeRoot: "/home/workspace/.runtime/rough-cut-staging-6d439a3", bootId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", now: () => NOW, timeoutMs: 2000};
const EXIT_BOOLEAN: Partial<Record<Section, keyof ReturnType<typeof deriveExit>>> = {release: "postgresBackend", database: "postgresBackend", migrations: "migrationsInSync",
  workers: "fleetAtLeastThree", objectStore: "s3Backend", readiness: "readinessPassed", ci: "existingE2ePassing"};
const sqlstate = (error: unknown): string => { const value = error as {errno?: unknown; code?: unknown}; return [value.errno, value.code].find(c => typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) as string ?? "no error"; };
const runner = (answers: Record<string, {exitCode?: number; stdout?: string} | Error>, calls: string[][] = []): Runner => async (command, opts) => {
  calls.push([...command, ...(opts.env ? ["env:" + Object.keys(opts.env).sort().join(",")] : [])]);
  const answer = answers[command.slice(0, 3).join(" ")] ?? answers[command[0]!] ?? new Error("unexpected command " + command.join(" "));
  if (answer instanceof Error) throw answer;
  return {exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: ""};
};
const enoent = Object.assign(new Error("Executable not found"), {code: "ENOENT"});
const temporary: string[] = [];
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "hv-wave-a-")); temporary.push(dir); return dir; };
afterAll(() => { for (const dir of temporary) rmSync(dir, {recursive: true, force: true}); });

test("(a) every probe healthy: nine recorded sections, derived exit satisfied, document round-trips through validation", async () => {
  const document = await collectWaveAExit(healthy(), options);
  expect(document.schema).toBe("hv-wave-a-exit/1");
  expect(document.recordedAt).toBe("2026-09-14T18:00:00.000Z");
  expect(document.host).toEqual({runtimeRoot: options.runtimeRoot, bootId: options.bootId});
  expect(document.newProviderSpendUsd).toBe(0);
  for (const section of SECTIONS) expect({section, status: document[section].status}).toEqual({section, status: "recorded"});
  expect(document.waveAExit).toEqual({postgresBackend: true, s3Backend: true, workersRegistered: 3, workersExpected: 3, fleetAtLeastThree: true, migrationsInSync: true,
    readinessPassed: true, existingE2ePassing: true, satisfied: true});
  expect(Object.keys(document)).toEqual(["schema", "recordedAt", "host", ...SECTIONS, "waveAExit", "newProviderSpendUsd"]);
  expect(validateDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
  expect(document.health).toEqual({status: "recorded", serviceStatus: "healthy", queueDepth: 0, runningJobs: 0, monthSpendUsd: 0});
});

test("(b) each probe failing in turn pends only its section with a fixed reason and clears only its exit boolean", async () => {
  const failures: {name: string; probe: () => unknown; reason: (section: Section) => string}[] = [
    {name: "throws", probe: () => { throw new Error("postgres://hv_admin:pw@127.0.0.1:55432/db AKIAIOSFODNN7EXAMPLE"); }, reason: section => `${section} probe failed`},
    {name: "rejects", probe: () => Promise.reject(new Error("boom")), reason: section => `${section} probe failed`},
    {name: "never resolves", probe: () => new Promise(() => {}), reason: section => `${section} probe timed out`},
    {name: "malformed document", probe: () => ({unexpected: true, sha: "postgres://x", registered: -1}), reason: section => `${section} data malformed`},
    {name: "null", probe: () => null, reason: section => `${section} data malformed`},
  ];
  for (const section of SECTIONS) for (const failure of failures) {
    const probes = healthy();
    let seen: AbortSignal | undefined;
    (probes as Record<Section, unknown>)[section] = (context: {signal: AbortSignal}) => { seen = context.signal; return failure.probe(); };
    const document = await collectWaveAExit(probes, {...options, timeoutMs: 25});
    const result = document[section] as Record<string, unknown>;
    expect({section, failure: failure.name, status: result.status, reason: result.reason}).toEqual({section, failure: failure.name, status: "pending", reason: failure.reason(section)});
    for (const [key, value] of Object.entries(result)) if (key !== "status" && key !== "reason") expect({section, key, value}).toEqual({section, key, value: null});
    for (const other of SECTIONS) if (other !== section) expect({other, status: document[other].status}).toEqual({other, status: "recorded"});
    const expected = deriveExit({...(await collectWaveAExit(healthy(), options)), [section]: document[section]} as WaveAExitDocument);
    expect(document.waveAExit).toEqual(expected);
    const boolean = EXIT_BOOLEAN[section];
    if (boolean) { expect({section, boolean, value: document.waveAExit[boolean]}).toEqual({section, boolean, value: false}); expect(document.waveAExit.satisfied).toBe(false); }
    else expect(document.waveAExit.satisfied).toBe(true); // health and backup are context, not part of the §9 exit conjunction
    if (failure.name === "never resolves") expect(seen?.aborted).toBe(true);
  }
});

test("(b) a ci run for another sha, a workers: 2 or non-hex manifest, and a disagreeing release marker each pend with their reason", async () => {
  const mismatch = await collectWaveAExit({...healthy(), ci: () => ({runId: 1, headSha: OTHER_SHA, conclusion: "success", steps: {...SUCCESS}})}, options);
  expect(mismatch.ci).toEqual({status: "pending", reason: "ci run not for the release sha", runId: null, headSha: null, conclusion: null, steps: null});
  expect(mismatch.waveAExit.existingE2ePassing).toBe(false); expect(mismatch.waveAExit.satisfied).toBe(false); expect(mismatch.release.status).toBe("recorded");
  const partial = await collectWaveAExit({...healthy(), ci: () => ({runId: 1, headSha: SHA, conclusion: "success", steps: {...SUCCESS, "private staging smoke": "failure"}})}, options);
  expect(partial.ci.status).toBe("recorded"); expect(partial.waveAExit.existingE2ePassing).toBe(false);
  const fixture = runtimeFixture({});
  expect(releaseProbe(fixture.runtime)).toEqual({sha: SHA, backend: "postgres", expectedWorkers: 3});
  for (const [name, manifest] of Object.entries({workersTwo: {workers: 2}, nonHexSha: {releaseSha: "g".repeat(40)}, jsonBackend: {backend: "json"}, otherSchema: {schema: "hv-storage-deployment/2"},
    badBucket: {bucket: "Rough_Cut"}, backupEscaped: {backupRepository: "/tmp"}})) {
    const broken = runtimeFixture(manifest);
    expect({name, reason: reasonOf(() => readDeployment(broken.runtime))}).toEqual({name, reason: "runtime manifest failed shape checks"});
  }
  const disagreeing = runtimeFixture({});
  writeFileSync(join(disagreeing.app, ".deployed-sha"), OTHER_SHA + "\n");
  expect(reasonOf(() => readDeployment(disagreeing.runtime))).toBe("release marker disagrees with manifest");
  const world = runtimeFixture({}); chmodSync(join(world.runtime, "storage-deployment.json"), 0o644);
  expect(reasonOf(() => readDeployment(world.runtime))).toBe("runtime manifest failed shape checks");
  expect(reasonOf(() => readDeployment(join(scratch(), "missing")))).toBe("runtime manifest unavailable");
  expect(reasonOf(() => releaseProbe(join(scratch(), "missing")))).toBe("runtime manifest unavailable");
});

test("(b) ciProbe: gh absent, gh failing, no run, in_progress, other sha, missing job or steps each map to a fixed reason; a completed run maps the three named steps", async () => {
  const view = (extra: Record<string, unknown> = {}, steps: {name: string; conclusion: string | null}[] = CI_STEPS.map(name => ({name, conclusion: "success"}))) =>
    JSON.stringify({headSha: SHA, status: "completed", conclusion: "success", jobs: [{name: "lint"}, {name: "quality", steps: [{name: "install dependencies", conclusion: "success"}, ...steps]}], ...extra});
  const list = JSON.stringify([{databaseId: 42, status: "completed", conclusion: "success", headSha: SHA, event: "pull_request"}, {databaseId: 43, status: "completed", conclusion: "success", headSha: SHA, event: "push"}]);
  const attempt = (answers: Parameters<typeof runner>[0], runId?: number) => { const calls: string[][] = []; return {calls, result: ciProbe({sha: SHA, runId, run: runner(answers, calls), cwd: repo})}; };
  await expect(attempt({gh: enoent}).result).rejects.toMatchObject({reason: "gh unavailable"});
  await expect(attempt({gh: {exitCode: 4, stdout: ""}}).result).rejects.toMatchObject({reason: "gh command failed"});
  await expect(attempt({"gh run list": {stdout: "[]"}}).result).rejects.toMatchObject({reason: "ci run not found"});
  await expect(attempt({"gh run list": {stdout: "not json"}}).result).rejects.toMatchObject({reason: "gh command failed"});
  const older = attempt({"gh run list": {exitCode: 1, stdout: ""}, "gh run view": {stdout: view()}});
  await expect(older.result).rejects.toMatchObject({reason: "gh command failed"}); // the fallback listing failed too
  expect(older.calls.map(call => call.slice(0, 7))).toEqual([["gh", "run", "list", "--workflow", "ci", "--branch", "main"], ["gh", "run", "list", "--workflow", "ci", "--branch", "main"]]);
  expect(older.calls[1]).not.toContain("--commit");
  const listed: string[][] = [];
  const legacy: Runner = async command => { listed.push(command); return command[2] === "view" ? {exitCode: 0, stdout: view(), stderr: ""} : command.includes("--commit") ? {exitCode: 1, stdout: "", stderr: "unknown flag"} : {exitCode: 0, stdout: list, stderr: ""}; };
  expect(await ciProbe({sha: SHA, run: legacy, cwd: repo})).toEqual({runId: 43, headSha: SHA, conclusion: "success", steps: {...SUCCESS}});
  expect(listed.map(call => call[2])).toEqual(["list", "list", "view"]);
  await expect(attempt({"gh run list": {stdout: list}, "gh run view": {stdout: view({status: "in_progress", conclusion: null})}}).result).rejects.toMatchObject({reason: "ci run in progress"});
  await expect(attempt({"gh run list": {stdout: list}, "gh run view": {stdout: view({headSha: OTHER_SHA})}}).result).rejects.toMatchObject({reason: "ci run not for the release sha"});
  await expect(attempt({"gh run list": {stdout: list}, "gh run view": {stdout: view({jobs: [{name: "lint"}]})}}).result).rejects.toMatchObject({reason: "ci quality job missing"});
  await expect(attempt({"gh run list": {stdout: list}, "gh run view": {stdout: view({}, [{name: "unit + integration", conclusion: "success"}])}}).result).rejects.toMatchObject({reason: "ci quality steps missing"});
  await expect(attempt({"gh run list": {stdout: list}, "gh run view": {stdout: view({}, [{name: "unit + integration", conclusion: null}])}}).result).rejects.toMatchObject({reason: "ci quality steps missing"});
  const good = attempt({"gh run list": {stdout: list}, "gh run view": {stdout: view()}});
  expect(await good.result).toEqual({runId: 43, headSha: SHA, conclusion: "success", steps: {...SUCCESS}});
  expect(good.calls.map(call => call.filter(part => !part.startsWith("env:")))).toEqual([
    ["gh", "run", "list", "--workflow", "ci", "--branch", "main", "--commit", SHA, "--limit", "10", "--json", "databaseId,status,conclusion,headSha,event"],
    ["gh", "run", "view", "43", "--json", "headSha,status,conclusion,jobs"]]);
  const pinned = attempt({"gh run view": {stdout: view({}, CI_STEPS.map(name => ({name, conclusion: name === "private staging smoke" ? "failure" : "success"})))}}, 7);
  expect(await pinned.result).toEqual({runId: 7, headSha: SHA, conclusion: "success", steps: {...SUCCESS, "private staging smoke": "failure"}});
  expect(pinned.calls).toHaveLength(1);
  for (const call of [...good.calls, ...pinned.calls]) { expect(call.at(-1)!.startsWith("env:")).toBe(true); expect(call.at(-1)!).not.toMatch(/HV_/); }
});

test("(b) readinessProbe runs storage-readiness.ts under the hv_api role file with a PATH-only environment and pends on failure, garbage or a missing script", async () => {
  const fixture = runtimeFixture({});
  const ready = JSON.stringify({ready: true, databaseRole: "hv_api", privateObjectsAuthenticated: true});
  const calls: string[][] = [];
  const result = await readinessProbe({runtime: fixture.runtime, app: fixture.app, run: runner({bash: {stdout: "warning line\n" + ready + "\n"}}, calls)});
  expect(result).toMatchObject({ready: true, databaseRole: "hv_api", privateObjectsAuthenticated: true}); expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(calls[0]!.slice(0, 2)).toEqual(["bash", "-c"]);
  expect(calls[0]![2]).toContain('. "$0"'); expect(calls[0]![2]).toContain("HV_STORAGE=postgres HV_ARTIFACT_STORAGE=s3");
  expect(calls[0]!.slice(3, 7)).toEqual([join(fixture.runtime, "storage-api.env"), fixture.app, join(fixture.runtime, "bin/bun"), join(fixture.app, "scripts/storage-readiness.ts")]);
  expect(calls[0]!.at(-1)).toBe("env:PATH");
  await expect(readinessProbe({runtime: fixture.runtime, app: fixture.app, run: runner({bash: {exitCode: 1, stdout: ""}})})).rejects.toMatchObject({reason: "readiness probe failed"});
  await expect(readinessProbe({runtime: fixture.runtime, app: fixture.app, run: runner({bash: {stdout: "not json"}})})).rejects.toMatchObject({reason: "readiness output unparsable"});
  await expect(readinessProbe({runtime: fixture.runtime, app: fixture.app, run: runner({bash: {stdout: JSON.stringify({ready: "yes"})}})})).rejects.toMatchObject({reason: "readiness output unparsable"});
  await expect(readinessProbe({runtime: fixture.runtime, app: fixture.app, run: runner({bash: enoent})})).rejects.toMatchObject({reason: "readiness probe failed"});
  const controller = new AbortController(); controller.abort();
  await expect(readinessProbe({runtime: fixture.runtime, app: fixture.app, run: runner({bash: {stdout: ready}}), signal: controller.signal})).rejects.toMatchObject({reason: "readiness probe timed out"});
  rmSync(join(fixture.app, "scripts/storage-readiness.ts"));
  await expect(readinessProbe({runtime: fixture.runtime, app: fixture.app, run: runner({bash: {stdout: ready}})})).rejects.toMatchObject({reason: "readiness script missing"});
});

test("(b) supervisorProbe, sweeperProbe, healthProbe and backupProbe pend with fixed reasons and record only bounded public fields", async () => {
  const status = "rough-cut-staging-api                RUNNING   pid 100, uptime 1:00:00\nrough-cut-staging-worker             RUNNING   pid 101, uptime 1:00:00\n"
    + "rough-cut-staging-worker-2           RUNNING   pid 102, uptime 1:00:00\nrough-cut-staging-worker-3           STOPPED   Sep 14 05:00 PM\nrough-cut-staging-sweeper            RUNNING   pid 104, uptime 1:00:00\n";
  expect(await supervisorProbe(runner({supervisorctl: {exitCode: 3, stdout: status}}))).toMatchObject({"rough-cut-staging-worker": "RUNNING", "rough-cut-staging-worker-3": "STOPPED"});
  await expect(supervisorProbe(runner({supervisorctl: enoent}))).rejects.toMatchObject({reason: "supervisor status unavailable"});
  await expect(supervisorProbe(runner({supervisorctl: {stdout: ""}}))).rejects.toMatchObject({reason: "supervisor status unavailable"});
  const line = JSON.stringify({sweptAt: "2026-09-14T17:59:00.000Z", removedProjects: [], localCacheDirectories: 0, storage: {}, orphanObjects: 0, incompleteUploads: {aborted: 1, retained: 2, failed: 0, supported: true}});
  expect(await sweeperProbe(runner({supervisorctl: {stdout: line + "\n"}}))).toEqual({status: "recorded", sweptAt: "2026-09-14T17:59:00.000Z", incompleteUploads: {aborted: 1, retained: 2, failed: 0, supported: true}});
  expect(await sweeperProbe(runner({supervisorctl: enoent}))).toEqual({status: "pending", reason: "sweeper log unavailable", sweptAt: null, incompleteUploads: null});
  expect(await sweeperProbe(runner({supervisorctl: {exitCode: 1, stdout: "rough-cut-staging-sweeper: ERROR (no log file)"}}))).toEqual({status: "pending", reason: "sweeper log unavailable", sweptAt: null, incompleteUploads: null});
  const fetchJson = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), {status});
  expect(await healthProbe(fetchJson(200, {status: "healthy", service: "hollywood-video-private-staging", queueDepth: 2, runningJobs: 1, monthSpendUsd: 0.25, extra: "postgres://x"})))
    .toEqual({serviceStatus: "healthy", queueDepth: 2, runningJobs: 1, monthSpendUsd: 0.25});
  await expect(healthProbe(fetchJson(503, {status: "down"}))).rejects.toMatchObject({reason: "edge unreachable"});
  await expect(healthProbe(async () => { throw new Error("ECONNREFUSED http://127.0.0.1:8081"); })).rejects.toMatchObject({reason: "edge unreachable"});
  await expect(healthProbe(fetchJson(200, {status: "healthy", queueDepth: "2"}))).rejects.toMatchObject({reason: "edge response malformed"});
  await expect(healthProbe(async () => new Response("<html>", {status: 200}))).rejects.toMatchObject({reason: "edge unreachable"});
  const dir = scratch();
  writeFileSync(join(dir, "service-status.json"), JSON.stringify({schema: "hv-backup-service/1", state: "healthy", lastSnapshotAt: "2026-09-14T17:58:00.000Z", lastCompletedAt: "2026-09-14T17:58:10.000Z",
    lastRecordedCostUsd: 0, objects: 120, failureStage: null, localRepositoryOnly: true, repository: "/home/workspace/private"}));
  expect(await backupProbe(join(dir, "service-status.json"))).toEqual({state: "healthy", lastCompletedAt: "2026-09-14T17:58:10.000Z", objects: 120, localRepositoryOnly: true});
  await expect(backupProbe(join(dir, "missing.json"))).rejects.toMatchObject({reason: "backup status unreadable"});
  writeFileSync(join(dir, "bad.json"), JSON.stringify({schema: "hv-backup-service/1", state: "healthy", localRepositoryOnly: false}));
  await expect(backupProbe(join(dir, "bad.json"))).rejects.toMatchObject({reason: "backup status unreadable"});
});

test("(c) worker counting: latest incarnation per name, fresh within 45 s, idle/busy/draining only", () => {
  const row = (name: string, state: string, ageSeconds: number, id = name + "-" + ageSeconds) => ({name, state, heartbeatAt: NOW - ageSeconds * 1000, id});
  expect(countWorkers([row("w1", "idle", 1), row("w2", "idle", 4), row("w3", "busy", 44)], NOW)).toEqual({registered: 3, names: ["w1", "w2", "w3"]});
  expect(countWorkers([row("w1", "idle", 1), row("w2", "idle", 46), row("w3", "draining", 45)], NOW)).toEqual({registered: 2, names: ["w1", "w3"]});
  expect(countWorkers([row("w1", "idle", 3600), row("w1", "busy", 900), row("w1", "idle", 400), row("w1", "stopped", 200), row("w1", "idle", 100), row("w1", "idle", 2)], NOW)).toEqual({registered: 1, names: ["w1"]});
  expect(countWorkers([row("w1", "stopped", 1), row("w2", "idle", 2)], NOW)).toEqual({registered: 1, names: ["w2"]});
  expect(countWorkers([row("w1", "idle", 30), row("w1", "stopped", 1)], NOW)).toEqual({registered: 0, names: []}); // the latest incarnation stopped
  expect(countWorkers([row("w1", "idle", -5)], NOW)).toEqual({registered: 0, names: []}); // a heartbeat from the future is not fresh
  expect(countWorkers([row("w1", "idle", 10, "a"), row("w1", "stopped", 10, "b")], NOW)).toEqual({registered: 0, names: []}); // equal heartbeat: id desc wins
  expect(countWorkers([], NOW)).toEqual({registered: 0, names: []});
  const data = workersProbe({rows: [row("zo-staging-worker-1", "idle", 1), row("zo-staging-worker-2", "idle", 2), row("zo-staging-worker-3", "idle", 3)], observedAt: NOW}, 3, {...RUNNING, "rough-cut-staging-api": "RUNNING"});
  expect(data).toEqual({registered: 3, expected: 3, names: ["zo-staging-worker-1", "zo-staging-worker-2", "zo-staging-worker-3"], supervisor: {...RUNNING}, freshWithinSeconds: 45});
  const partial = workersProbe({rows: [row("a", "idle", 1), row("b", "idle", 1), row("c", "idle", 1)], observedAt: NOW}, 3, {"rough-cut-staging-worker": "RUNNING"});
  expect(partial.supervisor).toEqual({"rough-cut-staging-worker": "RUNNING", "rough-cut-staging-worker-2": "MISSING", "rough-cut-staging-worker-3": "MISSING"});
  const exit = (workers: ReturnType<typeof workersProbe>) => deriveExit({...healthySections(), workers: {status: "recorded", ...workers}}).fleetAtLeastThree;
  expect(exit(data)).toBe(true); expect(exit(partial)).toBe(false);
  expect(exit({...data, supervisor: {...RUNNING, "rough-cut-staging-worker-3": "STARTING"}})).toBe(false);
  expect(exit({...data, registered: 2, names: data.names.slice(0, 2)})).toBe(false);
  expect(exit({...data, expected: 4})).toBe(false);
});

test("(d) lifecycle and multipart-listing classification from status + body", () => {
  const declared = '<?xml version="1.0"?><LifecycleConfiguration><Rule><ID>abort-incomplete</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>';
  const error = (code: string) => `<?xml version="1.0"?><Error><Code>${code}</Code><Message>x</Message></Error>`;
  expect(classifyLifecycle(200, declared)).toEqual({lifecycle: "declared", daysAfterInitiation: 1});
  expect(classifyLifecycle(200, declared.replace("<DaysAfterInitiation>1", "<DaysAfterInitiation>7"))).toEqual({lifecycle: "declared", daysAfterInitiation: 7});
  expect(classifyLifecycle(404, error("NoSuchLifecycleConfiguration"))).toEqual({lifecycle: "absent", daysAfterInitiation: null});
  expect(classifyLifecycle(501, error("NotImplemented"))).toEqual({lifecycle: "unsupported", daysAfterInitiation: null});
  expect(classifyLifecycle(501, "")).toEqual({lifecycle: "unsupported", daysAfterInitiation: null});
  expect(classifyLifecycle(400, error("NotImplemented"))).toEqual({lifecycle: "unsupported", daysAfterInitiation: null});
  expect(classifyLifecycle(200, "<LifecycleConfiguration><Rule><Status>Enabled</Status><Expiration><Days>30</Days></Expiration></Rule></LifecycleConfiguration>")).toEqual({lifecycle: "pending", daysAfterInitiation: null});
  expect(classifyLifecycle(404, error("NoSuchBucket"))).toEqual({lifecycle: "pending", daysAfterInitiation: null});
  expect(classifyLifecycle(403, error("AccessDenied"))).toEqual({lifecycle: "pending", daysAfterInitiation: null});
  expect(classifyLifecycle(500, "")).toEqual({lifecycle: "pending", daysAfterInitiation: null});
  expect(classifyMultipartListing(200, '<ListMultipartUploadsResult xmlns="x"><Bucket>b</Bucket><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>')).toBe("supported");
  expect(classifyMultipartListing(501, error("NotImplemented"))).toBe("unsupported");
  expect(classifyMultipartListing(200, "<html>")).toBe("pending");
  expect(classifyMultipartListing(403, error("AccessDenied"))).toBe("pending");
});

test("(d) objectStoreProbe sends exactly two signed bucket-level GETs and never anything else", async () => {
  const config = objectStoreConfig({HV_S3_ENDPOINT: "https://objects.internal:9000", HV_S3_BUCKET: "rough-cut-staging-v4", HV_S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", HV_S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"});
  const requests: {url: string; method: string; headers: Record<string,string>}[] = [];
  const fetchImpl = async (url: string, init: {method: "GET"; headers?: Record<string,string>}) => {
    requests.push({url, method: init.method, headers: init.headers ?? {}});
    return url.includes("lifecycle") ? new Response('<Error><Code>NoSuchLifecycleConfiguration</Code></Error>', {status: 404})
      : new Response('<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>', {status: 200});
  };
  const sweeper = async () => ({status: "pending" as const, reason: "sweeper log unavailable" as const, sweptAt: null, incompleteUploads: null});
  const data = await objectStoreProbe({config, expectedBucket: "rough-cut-staging-v4", fetchImpl, sweeper});
  expect(data).toEqual({endpointScheme: "https", bucket: "rough-cut-staging-v4", lifecycle: "absent", daysAfterInitiation: null, multipartListing: "supported", sweeper: await sweeper()});
  expect(requests.map(r => [r.method, r.url])).toEqual([["GET", "https://objects.internal:9000/rough-cut-staging-v4?lifecycle="], ["GET", "https://objects.internal:9000/rough-cut-staging-v4?max-uploads=1&uploads="]]);
  for (const request of requests) expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
  await expect(objectStoreProbe({config, expectedBucket: "rough-cut-staging-v3", fetchImpl, sweeper})).rejects.toMatchObject({reason: "object bucket does not match the deployment"});
  await expect(objectStoreProbe({config, fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, sweeper})).rejects.toMatchObject({reason: "object store unreachable"});
  const document = await collectWaveAExit({...healthy(), objectStore: () => objectStoreProbe({config, fetchImpl, sweeper})}, options);
  expect(document.objectStore.status).toBe("recorded"); expect(document.waveAExit.s3Backend).toBe(true);
  const unclassified = await collectWaveAExit({...healthy(), objectStore: () => ({...healthy().objectStore({signal: new AbortController().signal}) as object, lifecycle: "pending"} as never)}, options);
  expect(unclassified.objectStore.status).toBe("recorded"); expect(unclassified.waveAExit.s3Backend).toBe(false);
});

test("(e) migration head maps max(created_at) onto the real journal", () => {
  const journal = readJournal(journalPath);
  expect(journal.entries.length).toBe(16); expect(journal.entries.at(-1)).toEqual({when: 1789344000000, tag: "0015_accounting_capabilities"});
  expect(resolveMigrations(journal, 16, 1789344000000)).toEqual({applied: 16, journalEntries: 16, head: "0015_accounting_capabilities", inSync: true});
  expect(resolveMigrations(journal, 15, 1789344000000)).toEqual({applied: 15, journalEntries: 16, head: "0015_accounting_capabilities", inSync: false});
  expect(resolveMigrations(journal, 16, 1788850800000)).toEqual({applied: 16, journalEntries: 16, head: "0014_assembly_editorial", inSync: false});
  expect(reasonOf(() => resolveMigrations(journal, 16, 1))).toBe("migration head not in journal");
  expect(reasonOf(() => resolveMigrations(journal, 0, null))).toBe("no migration applied");
  expect(reasonOf(() => resolveMigrations({entries: []}, 1, 1))).toBe("migration journal unreadable");
  expect(reasonOf(() => readJournal(join(scratch(), "missing.json")))).toBe("migration journal unreadable");
});

test("(f) sweeper status parsing: last valid JSON line wins, a trailing partial line is ignored, absence pends", () => {
  const line = (sweptAt: string, incompleteUploads: unknown) => JSON.stringify({sweptAt, removedProjects: [], localCacheDirectories: 0, storage: {}, orphanObjects: 0, incompleteUploads});
  const first = line("2026-09-14T17:00:00.000Z", {aborted: 0, retained: 3, failed: 0, supported: true}), second = line("2026-09-14T17:01:00.000Z", {aborted: 2, retained: 1, failed: 0, supported: true});
  expect(parseSweeperStatus(first + "\n" + second + "\n")).toEqual({status: "recorded", sweptAt: "2026-09-14T17:01:00.000Z", incompleteUploads: {aborted: 2, retained: 1, failed: 0, supported: true}});
  expect(parseSweeperStatus(first + "\n" + second.slice(0, 40))).toEqual({status: "recorded", sweptAt: "2026-09-14T17:00:00.000Z", incompleteUploads: {aborted: 0, retained: 3, failed: 0, supported: true}});
  expect(parseSweeperStatus(first + "\n" + '{"event":"retention.failed","retryInSeconds":60}\n')).toEqual({status: "recorded", sweptAt: "2026-09-14T17:00:00.000Z", incompleteUploads: {aborted: 0, retained: 3, failed: 0, supported: true}});
  expect(parseSweeperStatus(line("2026-09-14T17:02:00.000Z", null) + "\n")).toEqual({status: "pending", reason: "sweeper has not reported incomplete uploads", sweptAt: null, incompleteUploads: null});
  expect(parseSweeperStatus(line("2026-09-14T17:02:00.000Z", {aborted: -1}) + "\n")).toEqual({status: "pending", reason: "sweeper status line missing", sweptAt: null, incompleteUploads: null});
  expect(parseSweeperStatus("")).toEqual({status: "pending", reason: "sweeper status line missing", sweptAt: null, incompleteUploads: null});
  expect(parseSweeperStatus("not json\n{\"event\":\"x\"}\n")).toEqual({status: "pending", reason: "sweeper status line missing", sweptAt: null, incompleteUploads: null});
  expect(parseSweeperStatus(second.slice(0, 50))).toEqual({status: "pending", reason: "sweeper status line missing", sweptAt: null, incompleteUploads: null});
});

test("(g) the serialized result never carries a connection URL, key id, secret, token or job/project id, and every reason is whitelisted", async () => {
  const leak = "postgres://hv_admin:s3cr3t@127.0.0.1:55432/hollywood_video_staging AKIAIOSFODNN7EXAMPLE secret_access_key=wJalrX token=abc job 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
  const probes = healthy();
  const leaking: Probes = {
    release: () => { throw new Error(leak); },
    database: () => Promise.reject(Object.assign(new Error(leak), {code: "28P01", detail: leak})),
    migrations: () => ({applied: 16, journalEntries: 16, head: leak, inSync: true}),
    workers: () => ({registered: 1, expected: 3, names: [leak], supervisor: {...RUNNING}, freshWithinSeconds: 45}),
    objectStore: () => ({...probes.objectStore({signal: new AbortController().signal}) as object, bucket: leak} as never),
    readiness: () => { throw new Error("HV_API_DATABASE_URL=" + leak); },
    health: () => ({serviceStatus: leak, queueDepth: 0, runningJobs: 0, monthSpendUsd: 0}),
    backup: () => { throw Object.assign(new Error(leak), {reason: leak}); },
    ci: () => ({runId: 1, headSha: SHA, conclusion: leak, steps: {...SUCCESS}}),
  };
  const document = await collectWaveAExit(leaking, {...options, bootId: null});
  const text = JSON.stringify(document);
  for (const pattern of [/postgres(?:ql)?:\/\//i, /https?:\/\//i, /AKIA[0-9A-Z]{16}/, /secret/i, /token/i, /password/i, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /28P01/, /s3cr3t/])
    expect({pattern: String(pattern), leaked: pattern.test(text)}).toEqual({pattern: String(pattern), leaked: false});
  for (const section of SECTIONS) { expect(document[section].status).toBe("pending"); expect(isKnownReason((document[section] as {reason?: string}).reason)).toBe(true); }
  expect(document.waveAExit.satisfied).toBe(false);
  for (const reason of REASONS) expect(reason).toMatch(/^[a-z_0-9 ]+$/);
  const recorded = JSON.stringify(await collectWaveAExit(healthy(), options));
  expect(recorded).not.toMatch(/postgres(?:ql)?:\/\/|https?:\/\/|AKIA[0-9A-Z]{16}|secret|token|password/i);
  expect(recorded.replace(options.bootId, "")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("withReadOnly refuses a non-hv_admin or missing connection before connecting and reports an unreachable server with a fixed reason", async () => {
  await expect(withReadOnly(undefined, async () => 1)).rejects.toMatchObject({reason: "admin connection not configured"});
  await expect(withReadOnly("postgres://hv_api:pw@127.0.0.1:1/x", async () => 1)).rejects.toMatchObject({reason: "admin connection is not hv_admin"});
  await expect(withReadOnly("postgres://hv_worker:pw@127.0.0.1:1/x", async () => 1)).rejects.toMatchObject({reason: "admin connection is not hv_admin"});
  await expect(withReadOnly("not a url", async () => 1)).rejects.toMatchObject({reason: "admin connection is not hv_admin"});
  await expect(withReadOnly("postgres://hv_admin:pw@127.0.0.1:1/x", async () => 1)).rejects.toMatchObject({reason: "database unreachable"});
  const reads = await readOnlyReads("postgres://hv_admin:pw@127.0.0.1:1/x", {database: databaseProbe, migrations: tx => migrationsProbe(tx, journalPath)});
  await expect(reads.database()).rejects.toMatchObject({reason: "database unreachable"});
  await expect(reads.migrations()).rejects.toMatchObject({reason: "database unreachable"});
  const document = await collectWaveAExit({...healthy(), database: reads.database, migrations: reads.migrations}, options);
  expect(document.database).toMatchObject({status: "pending", reason: "database unreachable"}); expect(document.waveAExit.postgresBackend).toBe(false);
});

const committedName = "(h) the committed docs/evidence/hv040-storage/wave-a-exit.json validates and its waveAExit recomputes from its sections";
test.skipIf(!existsSync(evidencePath))(existsSync(evidencePath) ? committedName : committedName + " (wave-a-exit.json not recorded yet)", () => {
  const text = readFileSync(evidencePath, "utf8"), raw = JSON.parse(text);
  const document = validateDocument(raw);
  expect(JSON.stringify(document, null, 2) + "\n").toBe(text);
  expect(document.recordedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(new Date(document.recordedAt).toISOString()).toBe(document.recordedAt);
  expect(document.release.status === "recorded" ? document.release.sha : "").toMatch(/^[0-9a-f]{40}$/);
  expect(document.waveAExit.satisfied).toBe(deriveExit(document).satisfied);
  expect(document.waveAExit.satisfied).toBe(document.waveAExit.postgresBackend && document.waveAExit.s3Backend && document.waveAExit.fleetAtLeastThree
    && document.waveAExit.migrationsInSync && document.waveAExit.readinessPassed && document.waveAExit.existingE2ePassing);
  expect(document.newProviderSpendUsd).toBe(0);
  expect(text.replace(document.host.bootId ?? "", "")).not.toMatch(/postgres(?:ql)?:\/\/|https?:\/\/|AKIA[0-9A-Z]{16}|secret|token|password|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  for (const section of SECTIONS) if (document[section].status === "pending") expect(isKnownReason((document[section] as {reason?: string}).reason)).toBe(true);
});

// pgtest: the real database and migration probes against a per-run database; the transaction is provably read-only.
const pgEnabled = Boolean(process.env.HV_PG_ADMIN_URL);
const pgtest = pgEnabled ? test : test.skip;
const databaseName = "hv_wave_a_test_" + crypto.randomUUID().replaceAll("-", "");
let admin: StudioDatabase | undefined, scopedUrl = "";
beforeAll(async () => {
  if (!pgEnabled) return;
  if (!/^hv_wave_a_test_[a-f0-9]{32}$/.test(databaseName)) throw new Error("unexpected fixture database");
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!, 1);
  await admin.sql.unsafe('CREATE DATABASE "' + databaseName + '"');
  const url = new URL(process.env.HV_PG_ADMIN_URL!); url.pathname = "/" + databaseName; scopedUrl = url.href;
  const scoped = new StudioDatabase(scopedUrl, 1);
  try { await scoped.migrate(); } finally { await scoped.close(); }
});
afterAll(async () => {
  if (!admin) return;
  try { if (scopedUrl) await admin.sql.unsafe('DROP DATABASE "' + databaseName + '"'); } finally { await admin.close(); }
});

pgtest("databaseProbe and migrationsProbe observe a migrated per-run database inside a read-only transaction (an insert raises 25006)", async () => {
  const journal = readJournal(journalPath);
  const outcome = await withReadOnly(scopedUrl, async tx => {
    const database = await databaseProbe(tx), migrations = await migrationsProbe(tx, journalPath);
    let code = "no error";
    await tx`savepoint attempt`;
    try { await tx`insert into hv_workers (id, classes, body) values ('wave-a-fixture', '[]'::jsonb, '{"name":"wave-a-fixture","state":"idle"}'::jsonb)`; }
    catch (error) { code = sqlstate(error); await tx`rollback to savepoint attempt`; }
    const workers = await workerRows(tx);
    return {database, migrations, code, workers};
  });
  expect(outcome.code).toBe("25006");
  expect(outcome.database.tables).toBe(12); expect(outcome.database.forcedRowSecurity).toBe(outcome.database.tables);
  expect(outcome.database.version).toMatch(/^PostgreSQL 1[5-9]\./);
  expect(outcome.database.counts).toEqual({projects: 0, jobs: 0, artifacts: 0}); expect(outcome.database.queue).toEqual({queued: 0, running: 0});
  expect(outcome.migrations).toEqual({applied: journal.entries.length, journalEntries: journal.entries.length, head: journal.entries.at(-1)!.tag, inSync: true});
  expect(outcome.workers.rows).toEqual([]); expect(Math.abs(outcome.workers.observedAt - Date.now())).toBeLessThan(60_000);
  expect((await admin!.sql`select count(*) as count from pg_database where datname = ${databaseName}`)[0].count).toBe("1");
  const reads = await readOnlyReads(scopedUrl, {database: databaseProbe, broken: async tx => { await tx`select * from hv_missing_table`; return 1; }, migrations: tx => migrationsProbe(tx, journalPath)});
  expect(await reads.database()).toEqual(outcome.database);
  await expect(reads.broken()).rejects.toMatchObject({reason: "database query failed"});
  expect(await reads.migrations()).toEqual(outcome.migrations); // the failed read was rolled back to its savepoint; later reads still run
  const document = await collectWaveAExit({...healthy(), database: reads.database, migrations: reads.migrations}, options);
  expect(document.database).toEqual({status: "recorded", ...outcome.database}); expect(document.migrations).toEqual({status: "recorded", ...outcome.migrations});
  expect(document.waveAExit.satisfied).toBe(true);
});

// s3test: the real object store probe against the CI bucket prepared by prepare-object-bucket.py.
const s3Enabled = Boolean(process.env.HV_S3_ENDPOINT && process.env.HV_S3_BUCKET && process.env.HV_S3_ACCESS_KEY_ID && process.env.HV_S3_SECRET_ACCESS_KEY);
const s3test = s3Enabled ? test : test.skip;
s3test("objectStoreProbe classifies the prepared CI bucket's lifecycle as declared (1 day) or unsupported and lists multipart uploads", async () => {
  const sweeper = async () => ({status: "pending" as const, reason: "sweeper log unavailable" as const, sweptAt: null, incompleteUploads: null});
  const data = await objectStoreProbe({config: objectStoreConfig(process.env), expectedBucket: process.env.HV_S3_BUCKET, sweeper});
  console.log(JSON.stringify({event: "wave-a-evidence.s3test", lifecycle: data.lifecycle, daysAfterInitiation: data.daysAfterInitiation, multipartListing: data.multipartListing}));
  expect(["declared", "unsupported"]).toContain(data.lifecycle);
  if (data.lifecycle === "declared") expect(data.daysAfterInitiation).toBe(1); else expect(data.daysAfterInitiation).toBeNull();
  expect(data.multipartListing).toBe("supported");
  expect(data.bucket).toBe(process.env.HV_S3_BUCKET!);
  expect(deriveExit({...healthySections(), objectStore: {status: "recorded", ...data}}).s3Backend).toBe(data.endpointScheme === "https");
});

// ---- fixtures ----
function healthySections(): WaveAExitDocument {
  const probes = healthy(), signal = new AbortController().signal, sections = {} as Record<string, unknown>;
  for (const section of SECTIONS) sections[section] = {status: "recorded", ...(probes[section]({signal}) as object)};
  return sections as unknown as WaveAExitDocument;
}
function reasonOf(fn: () => unknown): string { try { fn(); return "no error"; } catch (error) { return (error as {reason?: string}).reason ?? "not a probe failure"; } }
/** A runtime root shaped like the staging host: manifest, platform, immutable release, role files and the pinned bun. */
function runtimeFixture(overrides: Record<string, unknown>): {runtime: string; app: string} {
  const root = scratch(), runtime = join(root, "runtime"), platform = join(root, "platform"), app = join(runtime, "releases", SHA);
  for (const dir of [join(platform, "backups/staging"), join(app, "scripts"), join(runtime, "bin")]) mkdirSync(dir, {recursive: true});
  const manifest = {schema: "hv-storage-deployment/1", backend: "postgres", workers: 3, database: "hollywood_video_staging_v4", bucket: "rough-cut-staging-v4", releaseSha: SHA,
    platformRoot: platform, backupRepository: join(platform, "backups/staging"), ...overrides};
  writeFileSync(join(runtime, "storage-deployment.json"), JSON.stringify(manifest), {mode: 0o600});
  writeFileSync(join(runtime, "active-release.txt"), app + "\n");
  writeFileSync(join(app, ".deployed-sha"), SHA + "\n");
  writeFileSync(join(app, "scripts/storage-readiness.ts"), "// fixture\n");
  for (const name of ["run-api.sh", "run-worker.sh", "run-sweeper.sh", "run-backup.sh", "bin/bun"]) writeFileSync(join(runtime, name), "#!/bin/sh\n", {mode: 0o700});
  writeFileSync(join(runtime, "storage-api.env"), "HV_API_DATABASE_URL=postgres://hv_api:fixture@127.0.0.1:55432/hollywood_video_staging_v4\n", {mode: 0o600});
  writeFileSync(join(runtime, "storage-ready.json"), JSON.stringify({schema: "hv-storage-ready/1", bootId: options.bootId, deploymentSha256: "0".repeat(64), readyAt: 0}), {mode: 0o600});
  return {runtime, app};
}
