/** Drives the synthetic operator console in a real headless browser over CDP and prints what it observed.
 *  Local verification only: it starts `operator-console.ts` itself, talks to loopback, and holds no credential. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shell = process.argv[2] ?? process.env.HV_HEADLESS_SHELL ?? "";
const modes = (process.argv[3] ?? "healthy,unavailable,disabled,empty").split(",").filter(Boolean);
if (!shell) throw new Error("Pass the path of a headless Chromium shell.");

interface Observation {rowCounts: Record<string, number>; stateLabels: Record<string, string>; text: Record<string, string>; consoleErrors: number; consoleMessages: string[]}

class Session {
  private next = 1;
  private readonly pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
  readonly events: {method: string; params: any}[] = [];
  private constructor(private readonly socket: WebSocket, private sessionId?: string) {}
  static async open(url: string): Promise<Session> {
    const socket = new WebSocket(url);
    const session = new Session(socket);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), {once: true});
      socket.addEventListener("error", () => reject(new Error("browser socket failed")), {once: true});
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) {session.events.push({method: message.method, params: message.params ?? {}}); return;}
      const waiter = session.pending.get(message.id);
      session.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message ?? "devtools error")); else waiter?.resolve(message.result ?? {});
    });
    return session;
  }
  attach(sessionId: string) {this.sessionId = sessionId;}
  send(method: string, params: Record<string, unknown> = {}, browserScope = false): Promise<any> {
    const id = this.next++;
    this.socket.send(JSON.stringify({id, method, params, ...(browserScope || !this.sessionId ? {} : {sessionId: this.sessionId})}));
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      setTimeout(() => {if (this.pending.delete(id)) reject(new Error(method + " timed out"));}, 20_000);
    });
  }
  async evaluate(expression: string): Promise<any> {
    const result = await this.send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) throw new Error("page evaluation failed");
    return result.result?.value;
  }
  close() {this.socket.close();}
}

const READ = `(() => {
  const rows = id => document.querySelectorAll("#" + id + " tr").length;
  const node = id => document.getElementById(id);
  const label = id => (node(id) && node(id).dataset.state) || "";
  return {
    rowCounts: {latency: rows("latency-rows"), failures: rows("failure-rows"), providers: rows("provider-rows"), costs: rows("cost-rows")},
    stateLabels: {metrics: label("reliability-metrics-message"), circuits: label("reliability-status-message"), costs: label("reliability-cost-message")},
    text: {metrics: node("reliability-metrics-message").textContent, circuits: node("reliability-status-message").textContent,
      costs: node("reliability-cost-message").textContent, queue: node("reliability-queue").textContent, summary: node("cost-summary").textContent},
    ready: !node("readings").hidden && Boolean(label("reliability-metrics-message")),
    sectionPresent: Boolean(document.querySelector('[aria-labelledby="reliability-title"]')),
    documentScrollWidth: document.documentElement.scrollWidth, documentClientWidth: document.documentElement.clientWidth,
  };
})()`;

async function observe(mode: string): Promise<Observation & {mode: string; sectionPresent: boolean; documentScrollWidth: number; documentClientWidth: number; narrowViewport: Record<string, unknown>}> {
  const server = Bun.spawn(["bun", "scripts/fixtures/operator-console.ts", mode], {stdout: "pipe", stderr: "ignore", env: process.env});
  const profile = mkdtempSync(join(tmpdir(), "hv-console-browser-"));
  let browser: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined, session: Session | undefined;
  try {
    let url = "";
    const reader = server.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 20_000;
    let buffer = "";
    while (!url && Date.now() < deadline) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      url = buffer.match(/http:\/\/\S*\/api\/operator\/console#\S+/)?.[0] ?? "";
    }
    void reader.cancel().catch(() => {});
    if (!url) throw new Error("the fixture console did not print a link");
    browser = Bun.spawn([shell, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], {stdout: "ignore", stderr: "pipe"});
    let endpoint = "", errors = "";
    const errorReader = browser.stderr.getReader();
    const browserDeadline = Date.now() + 20_000;
    while (!endpoint && Date.now() < browserDeadline) {
      const {done, value} = await errorReader.read();
      if (done) break;
      errors += decoder.decode(value, {stream: true});
      endpoint = errors.match(/ws:\/\/\S+/)?.[0] ?? "";
    }
    void errorReader.cancel().catch(() => {});
    if (!endpoint) throw new Error("the browser did not publish a DevTools endpoint");
    session = await Session.open(endpoint);
    const {targetId} = await session.send("Target.createTarget", {url: "about:blank"}, true);
    const {sessionId} = await session.send("Target.attachToTarget", {targetId, flatten: true}, true);
    session.attach(sessionId);
    await session.send("Runtime.enable"); await session.send("Log.enable"); await session.send("Page.enable");
    await session.send("Page.navigate", {url});
    let state: any;
    const pageDeadline = Date.now() + 25_000;
    do {
      await Bun.sleep(250);
      state = await session.evaluate(READ).catch(() => undefined);
    } while ((!state || !state.ready) && Date.now() < pageDeadline);
    if (!state) throw new Error("the console page never became readable");
    await session.send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    const narrow = await session.evaluate(`({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})`);
    await session.send("Emulation.clearDeviceMetricsOverride");
    const messages = session.events.flatMap(event => {
      if (event.method === "Runtime.consoleAPICalled" && ["error", "warning", "assert"].includes(event.params.type))
        return [event.params.type + ": " + event.params.args.map((argument: any) => String(argument.value ?? argument.description ?? "")).join(" ")];
      if (event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params.entry.level))
        return [event.params.entry.level + ": " + event.params.entry.text];
      return [];
    });
    return {mode, rowCounts: state.rowCounts, stateLabels: state.stateLabels, text: state.text, sectionPresent: state.sectionPresent,
      documentScrollWidth: state.documentScrollWidth, documentClientWidth: state.documentClientWidth,
      narrowViewport: {requested: {width: 390, height: 844}, ...narrow},
      consoleErrors: messages.length, consoleMessages: messages};
  } finally {
    session?.close();
    browser?.kill("SIGKILL"); server.kill("SIGTERM");
    await Promise.allSettled([browser?.exited, server.exited]);
    rmSync(profile, {recursive: true, force: true});
  }
}

const observations = [];
for (const mode of modes) observations.push(await observe(mode));
const version = (await new Response(Bun.spawn([shell, "--version"], {stdout: "pipe"}).stdout).text()).trim();
console.log(JSON.stringify({schema: "hv-operator-console-browser/1", browser: version, syntheticDataOnly: true, observations}, null, 2));
